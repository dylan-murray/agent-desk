// Real backend and PTY: the bundled Files plugin in a pane's dock, and a third-party plugin that tries to reach past its sandbox.
require('./check-isolated-url.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {spawn, spawnSync, execFileSync} = require('node:child_process');
const {chromium} = require('playwright');
const evidence = require('./evidence.cjs');
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-plugins-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
// A plugin from outside the desk: it asks for no permissions and probes what its page can reach.
const extra = path.join(state, 'plugins'), probe = path.join(extra, 'probe');
fs.mkdirSync(probe, {recursive: true});
const manifest = {runtime: 'static', title: 'Probe', entrypoint: 'index.html', dock: {tab: 'Probe', order: 90}, permissions: [], buttons: [{id: 'ping', label: 'Ping'}]};
fs.writeFileSync(path.join(probe, 'agent-desk-ui.json'), JSON.stringify(manifest));
fs.writeFileSync(path.join(probe, 'index.html'), '<!doctype html><body><script src="../sdk/agent-desk.js"></script><script src="probe.js"></script></body>');
fs.writeFileSync(path.join(probe, 'probe.js'), `const out={},show=()=>{document.body.dataset.result=JSON.stringify(out);};
(async()=>{
  try{out.parent=typeof parent.document.title;}catch{out.parent='blocked';}
  try{out.storage=String(localStorage.length);}catch{out.storage='blocked';}
  try{out.cookie=document.cookie;}catch{out.cookie='blocked';}
  try{await fetch('/api/plugins');out.fetch='allowed';}catch{out.fetch='blocked';}
  try{out.info=await AgentDesk.call('pane.info');}catch(e){out.info=e.message;}
  try{await AgentDesk.call('files.list');out.files='allowed';}catch(e){out.files=e.message;}
  try{await AgentDesk.call('terminal.input',{data:'rm -rf ~'});out.input='allowed';}catch(e){out.input=e.message;}
  try{await AgentDesk.call('tab.set',{note:'\\u001b[2J'});out.tab='allowed';}catch(e){out.tab=e.message;}
  show();
})();
AgentDesk.on('button',({id})=>{out.button=id;show();});`);
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state,
  AGENT_DESK_TOOL_ROOTS: [path.join(root, 'agent_desk', 'tools'), extra].join(path.delimiter)};
let server, browser, port, log;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 200) {for (let i = 0; i < tries; i++) {if (await check()) return;await pause(100);}throw Error(message);}
const note = message => {if (process.env.VERBOSE) console.log('  ok ' + message);};
(async () => {
  const reservation = net.createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));assert.notEqual(port, 4310);
  const base = `http://127.0.0.1:${port}/`;
  log = fs.openSync(path.join(state, 'server.log'), 'a');
  server = spawn(python, ['-m', 'agent_desk', '--port', String(port)], {cwd: root, env: fixtureEnv, stdio: ['ignore', log, log]});
  await until(async () => {if (server.exitCode !== null) throw Error(fs.readFileSync(path.join(state, 'server.log'), 'utf8'));try {return (await fetch(base + 'config.js')).ok;} catch {return false;}}, 'Browser fixture server did not start', 300);
  const project = fs.mkdtempSync(path.join(state, 'project-'));
  const git = (...args) => execFileSync('git', args, {cwd: project, env: {...fixtureEnv, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'}});
  const write = (name, text) => {fs.mkdirSync(path.dirname(path.join(project, name)), {recursive: true});fs.writeFileSync(path.join(project, name), text);};
  write('README.md', '# Fixture\n');write('src/app.py', 'def run():\n    return 1\n');write('src/util.py', 'X = 1\n');write('docs/old.md', 'old\n');write('docs/guide.md', 'guide\n');
  git('init', '-q', '-b', 'main');git('add', '.');git('commit', '-q', '-m', 'Fixture');
  write('src/app.py', 'def run():\n    return 2\n');write('src/new.py', 'NEW = True\n');fs.rmSync(path.join(project, 'docs/old.md'));

  const plugins = async () => (await (await fetch(base + 'api/plugins')).json()).plugins;
  assert.equal((await plugins()).find(p => p.id === 'probe').status, 'needs approval');
  const probeEntry = (await plugins()).find(p => p.id === 'probe').entry;
  assert.equal((await fetch(base + probeEntry.slice(1))).status, 404, 'an unapproved plugin is not served');
  const filesEntry = (await plugins()).find(p => p.id === 'files').entry;
  assert.equal((await fetch(base + filesEntry.slice(1))).status, 200);
  assert.equal((await fetch(base + 'plugins/wrong-key/files/index.html')).status, 404, 'plugin files need the desk\'s secret path');

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const id = await page.evaluate(async cwd => {const t = await terminalRequest('/api/terminals/launch', {cwd, argv: ['/bin/sh'], name: 'Fixture shell'});await refresh();selectPane(t.id);return t.id;}, project);
  await page.waitForFunction(id => paneViews.get(id)?.term && !paneViews.get(id).restoring, id);
  const pane = page.locator(`[data-pane-id="${id}"]`);
  await pane.hover();await pane.locator('.pane-edit').click();
  await until(async () => (await pane.locator('.pane-dock-tab').allTextContents()).join() === 'Files,Editor,Review', 'the dock should list Files, Editor and Review only');
  note('the bundled Files plugin is a dock tab; an unapproved plugin is not');

  await pane.locator('.pane-dock-tab[data-entry="plugin:files"]').click();
  const frame = await (await pane.locator('.pane-dock-frame[data-plugin="files"]').elementHandle()).contentFrame();
  await frame.waitForSelector('.row[data-path="src/app.py"]', {timeout: 10000});
  const mark = async file => (await frame.locator(`.row[data-path="${file}"] .mark`).count()) ? frame.locator(`.row[data-path="${file}"] .mark`).textContent() : '';
  assert.equal(await mark('src/app.py'), 'M');assert.equal(await mark('src/new.py'), 'U');assert.equal(await mark('docs/old.md'), 'D');assert.equal(await mark('src/util.py'), '');
  assert.equal(await frame.locator('.row[data-folder="src"]').getAttribute('aria-expanded'), 'true', 'folders with changes open on first look');
  assert.equal(await frame.locator('.row[data-path="README.md"]').count(), 1);
  const lines = file => frame.locator(`.row[data-path="${file}"] .lines`).textContent();
  assert.equal(await lines('src/app.py'), '+1 −1');assert.equal(await lines('src/new.py'), '+1');assert.equal(await lines('docs/old.md'), '−1');
  const changed = frame.locator('#changed');
  assert.equal(await changed.isVisible(), true);assert.equal(await changed.getAttribute('aria-pressed'), 'false');
  // The plugin names its folder and how much changed in the panel's title bar, and puts a dot on its rail item.
  await until(async () => (await pane.locator('.pane-dock-flag').textContent()) === '3 changed', 'Files should say how much changed in the title bar');
  assert.equal(await pane.locator('.pane-dock-title b').textContent(), 'Files');
  assert.equal(await pane.locator('.pane-dock-subtitle').textContent(), path.basename(project));
  assert.equal(await pane.locator('.pane-dock-tab[data-entry="plugin:files"] .pane-dock-badge').isVisible(), true);
  assert.equal(await pane.locator('.pane-dock-tab[data-entry="@editor"] .pane-dock-badge').isVisible(), false);
  await page.screenshot({path: evidence('pane-plugins-01-files.png')});
  note('Files marks changed (M), new (U) and deleted (D) files with their line counts, and says "3 changed" in the title bar with a dot on its rail item');

  await frame.locator('#filter').fill('util');
  await until(async () => (await frame.locator('.row.file').evaluateAll(rows => rows.map(row => row.dataset.path))).join() === 'src/util.py', 'the filter should narrow the tree to matching files');
  await frame.locator('#filter').press('Escape');
  await until(async () => (await frame.locator('.row[data-path="README.md"]').count()) === 1, 'Escape should clear the filter');
  note('the filter narrows the tree as you type, and Escape clears it');

  const sandbox = await frame.evaluate(async () => {
    const out = {};
    try {out.parent = typeof parent.document;} catch {out.parent = 'blocked';}
    try {out.storage = String(localStorage.length);} catch {out.storage = 'blocked';}
    try {await fetch('/api/agents');out.fetch = 'allowed';} catch {out.fetch = 'blocked';}
    return out;
  });
  assert.deepEqual(sandbox, {parent: 'blocked', storage: 'blocked', fetch: 'blocked'});
  note('the plugin page cannot read the desk, keep storage or fetch anything');

  await frame.locator('.row[data-path="src/app.py"]').click();
  await until(async () => (await pane.locator('.pane-dock-tab[aria-selected=true]').textContent()) === 'Editor', 'opening a file should switch to the editor');
  await until(() => page.evaluate(id => window.paneEditor.current(id), id).then(path => path === 'src/app.py'), 'the editor did not open src/app.py');
  await until(() => pane.locator('.pane-dock-editor .ace_content').textContent().then(text => text.includes('return 2')), 'the editor did not show the file');
  assert.equal(await pane.locator('.pane-dock-title b').textContent(), 'Editor');
  assert.equal(await pane.locator('.pane-dock-flag').textContent(), '', 'the title bar note belongs to Files');
  await page.screenshot({path: evidence('pane-plugins-02-opened.png')});
  await pane.locator('.pane-dock-tab[data-entry="plugin:files"]').click();
  await until(async () => (await frame.locator('.row[data-path="src/app.py"]').getAttribute('aria-current')) === 'true', 'Files should mark the file the editor shows');
  note('clicking a file opens it in the editor, and Files follows what the editor shows');

  await changed.click();
  await until(async () => (await frame.locator('.row[data-path="README.md"]').count()) === 0, 'Changed should hide unchanged files');
  assert.equal(await changed.getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await frame.locator('.row.file').evaluateAll(rows => rows.map(row => row.dataset.path)), ['docs/old.md', 'src/app.py', 'src/new.py']);
  await page.screenshot({path: evidence('pane-plugins-03-changed.png')});
  note('Changed narrows the tree to what changed');

  const approve = digest => page.evaluate(digest => terminalRequest('/api/plugins/approve', {id: 'probe', digest}).then(() => 'ok', error => error.message), digest);
  assert.match(await approve('0'.repeat(64)), /changed since you looked/);
  assert.equal(await approve((await plugins()).find(p => p.id === 'probe').digest), 'ok');
  await page.evaluate(() => refreshPlugins());
  await until(async () => (await pane.locator('.pane-dock-tab').allTextContents()).includes('Probe'), 'an approved plugin should get its tab');
  await pane.locator('.pane-dock-tab[data-entry="plugin:probe"]').click();
  const probeFrame = await (await pane.locator('.pane-dock-frame[data-plugin="probe"]').elementHandle()).contentFrame();
  await probeFrame.waitForSelector('body[data-result]', {state: 'attached', timeout: 10000});
  const result = JSON.parse(await probeFrame.locator('body').getAttribute('data-result'));
  assert.deepEqual([result.parent, result.storage, result.cookie, result.fetch], ['blocked', 'blocked', 'blocked', 'blocked']);
  assert.equal(result.info.title, 'Fixture shell');
  assert.match(result.files, /no permission for files\.list/);
  assert.match(result.input, /Unknown call: terminal\.input/);
  assert.match(result.tab, /plain text/, 'tab text with control characters is refused');
  await pane.locator('.pane-dock-actions button[data-button="ping"]').click();
  await until(async () => JSON.parse(await probeFrame.locator('body').getAttribute('data-result')).button === 'ping', 'the plugin did not hear its button');
  note('an approved plugin gets only what its manifest allows: no files without permission, no unknown calls, its own button');

  fs.writeFileSync(path.join(probe, 'agent-desk-ui.json'), JSON.stringify({...manifest, permissions: ['files.read']}));
  await page.evaluate(() => refreshPlugins());
  await until(async () => (await pane.locator('.pane-dock-frame[data-plugin="probe"]').count()) === 0, 'a plugin that asks for more should be switched off and its page unloaded');
  // Like a tool that stops, a plugin switched off while shown closes the dock.
  assert.equal(await pane.locator('.pane-dock').isVisible(), false);
  await pane.hover();await pane.locator('.pane-edit').click();
  assert.deepEqual(await pane.locator('.pane-dock-tab').allTextContents(), ['Files', 'Editor', 'Review']);
  assert.equal((await fetch(base + probeEntry.slice(1))).status, 404);
  note('a plugin whose manifest asks for more is switched off until approved again');

  await pane.locator('.pane-dock-tab[data-entry="plugin:files"]').click();
  await page.setViewportSize({width: 390, height: 844});await pause(600);
  const narrow = await page.evaluate(() => document.documentElement.scrollWidth);
  await page.screenshot({path: evidence('pane-plugins-04-narrow.png')});
  assert.equal(narrow, 390);assert.equal(await changed.isVisible(), true);
  note('at 390px the Files tab and its button still fit');

  await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), id);
  assert.deepEqual(errors, []);
  console.log('PASS: pane plugins: bundled Files tab with Git marks and a Changed button, opens files in the editor and follows it; plugin pages sandboxed; third-party plugins need approval of their exact manifest and get only their permissions; 1440 and 390px');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close();
  if (server?.exitCode === null) {const stopped = once(server, 'exit');server.kill('SIGINT');await stopped;}
  if (port) {
    const cleanup = spawnSync(python, ['-c', "from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()", state, String(port)], {cwd: root, env: fixtureEnv, encoding: 'utf8'});
    if (cleanup.status !== 0) console.error('Fixture cleanup:', cleanup.stderr);
  }
  if (log !== undefined) fs.closeSync(log);
  console.log('Browser fixture:', state);
});
