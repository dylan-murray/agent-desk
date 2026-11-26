// Real backend and PTY: the Files plugin shows where it is, browses other folders in your home folder, adds a file to
// the pane's agent, and asks before moving the agent or a shell to another folder.
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
const root = path.resolve(__dirname, '../..'), state = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-files-')));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
// A home folder of its own, holding a Git project and a plain folder beside it, and a stand-in for Claude on PATH.
const home = path.join(state, 'home'), project = path.join(home, 'code', 'app'), notes = path.join(home, 'code', 'notes'), bin = path.join(state, 'bin');
fs.mkdirSync(bin, {recursive: true});
fs.writeFileSync(path.join(bin, 'claude'), "#!/bin/sh\nprintf 'fake claude ready\\r\\n'\nwhile IFS= read -r line; do printf 'heard %s\\r\\n' \"$line\"; done\n", {mode: 0o755});
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state, HOME: home, PATH: bin + path.delimiter + process.env.PATH};
let server, browser, port, log;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 200) {for (let i = 0; i < tries; i++) {if (await check()) return;await pause(100);}throw Error(message);}
const note = message => {if (process.env.VERBOSE) console.log('  ok ' + message);};
(async () => {
  const write = (name, text) => {fs.mkdirSync(path.dirname(name), {recursive: true});fs.writeFileSync(name, text);};
  write(path.join(project, 'README.md'), '# App\n');write(path.join(project, 'src', 'a.py'), 'A = 1\n');write(path.join(project, 'src', 'b.py'), 'B = 1\n');write(path.join(notes, 'plan.md'), 'the plan\n');
  const git = (...args) => execFileSync('git', args, {cwd: project, env: {...fixtureEnv, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'}});
  git('init', '-q', '-b', 'main');git('add', '.');git('commit', '-q', '-m', 'Fixture');write(path.join(project, 'src', 'a.py'), 'A = 2\n');

  const reservation = net.createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));assert.notEqual(port, 4310);
  const base = `http://127.0.0.1:${port}/`;
  log = fs.openSync(path.join(state, 'server.log'), 'a');
  server = spawn(python, ['-m', 'agent_desk', '--port', String(port)], {cwd: root, env: fixtureEnv, stdio: ['ignore', log, log]});
  await until(async () => {if (server.exitCode !== null) throw Error(fs.readFileSync(path.join(state, 'server.log'), 'utf8'));try {return (await fetch(base + 'config.js')).ok;} catch {return false;}}, 'Browser fixture server did not start', 300);

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {origin: base.slice(0, -1)});
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const launch = (cwd, argv, name) => page.evaluate(async ([cwd, argv, name]) => {const t = await terminalRequest('/api/terminals/launch', {cwd, argv, name});await refresh();selectPane(t.id);return t.id;}, [cwd, argv, name]);
  const screen = id => page.evaluate(id => {const buffer = paneViews.get(id).term.buffer.active;let text = '';for (let i = 0; i < buffer.length; i++) text += buffer.getLine(i).translateToString(true) + '\n';return text;}, id);
  const flat = text => text.replace(/\s+/g, '');
  async function openFiles(id) {
    await page.waitForFunction(id => paneViews.get(id)?.term && !paneViews.get(id).restoring, id);
    const pane = page.locator(`[data-pane-id="${id}"]`);
    await pane.hover();await pane.locator('.pane-edit').click();await pane.locator('.pane-dock-tab[data-entry="plugin:files"]').click();
    const frame = await (await pane.locator('.pane-dock-frame[data-plugin="files"]').elementHandle()).contentFrame();
    return {pane, frame};
  }
  const crumbs = frame => frame.locator('#crumbs .crumb').allTextContents();
  const menu = async (frame, selector, action) => {await frame.locator(selector).click({button: 'right'});await frame.locator(`#menu [data-act="${action}"]`).click();};

  const id = await launch(project, ['claude'], 'Claude');
  const {pane, frame} = await openFiles(id);
  await until(() => screen(id).then(text => text.includes('fake claude ready')), 'the stand-in agent did not start');
  await frame.waitForSelector('.row[data-folder="src"]', {timeout: 10000});
  await until(async () => (await crumbs(frame)).join('/') === '~/code/app', 'the path bar should show where Files is, from your home folder');
  await until(async () => (await frame.locator('#crumbs .crumb.current .here').count()) === 1, 'the path bar should mark the folder Claude works in');
  await until(async () => (await pane.locator('.pane-branch').textContent()) === 'main', 'the pane should name its branch beside its folder');
  assert.equal(await frame.locator('#branch').count(), 0, 'Files leaves the branch to the pane');
  assert.equal(await frame.locator('#filter').getAttribute('placeholder'), 'Filter 3 files');
  assert.equal(await frame.locator('#away').isVisible(), false);
  await page.screenshot({path: evidence('files-browse-01-where.png')});
  note('the path bar reads ~/code/app with Claude\'s dot and how many files there are, and the pane names its branch');

  await frame.locator('#up').click();
  await until(async () => (await crumbs(frame)).join('/') === '~/code', 'Up should show the folder above');
  await frame.waitForSelector('.row[data-folder="notes"]');
  assert.equal(await frame.locator('.row[data-folder="app"] .here').count(), 1, 'the folder Claude works in keeps its dot in the tree');
  await until(async () => (await frame.locator('#away').textContent()).startsWith('Claude is in app'), 'browsing elsewhere should say where Claude is');
  await page.screenshot({path: evidence('files-browse-02-up.png')});
  await menu(frame, '.row[data-folder="notes"]', 'browse');
  await until(async () => (await crumbs(frame)).join('/') === '~/code/notes', 'Open this folder should show it');
  await frame.locator('.row[data-path="plan.md"]').click();
  await until(() => page.evaluate(id => window.paneEditor.current(id), id).then(file => file === path.join(notes, 'plan.md')), 'a file outside the pane\'s folder should open in the editor by its full path');
  await until(() => pane.locator('.pane-dock-editor .ace_content').textContent().then(text => text.includes('the plan')), 'the editor did not show the file');
  await pane.locator('.pane-dock-tab[data-entry="plugin:files"]').click();
  await until(async () => (await frame.locator('.row[data-path="plan.md"]').getAttribute('aria-current')) === 'true', 'Files should mark the file the editor shows');
  note('Up and Open this folder browse other folders in the home folder, and their files open in the editor');

  const refused = await frame.evaluate(() => AgentDesk.call('files.list', {folder: '/etc'}).then(() => 'listed', error => error.message));
  assert.match(refused, /home folder/);
  await frame.locator('#away button[data-go]').click();
  await until(async () => (await crumbs(frame)).join('/') === '~/code/app', 'Back should return to Claude\'s folder');
  assert.equal(await frame.locator('#away').isVisible(), false);
  note('a folder outside your home folder is refused, and Back returns to the agent\'s folder');

  await frame.locator('.row[data-folder="src"]').click({button: 'right'});
  assert.deepEqual(await frame.locator('#menu button').allTextContents(), ['Open this folder', 'Add to Claude', 'Move Claude here…', 'Copy path']);
  await page.keyboard.press('Escape');
  await menu(frame, '.row[data-path="src/a.py"]', 'mention');
  await until(() => screen(id).then(text => text.includes('@src/a.py')), 'Add to Claude should type an @mention into its input');
  assert.equal((await screen(id)).includes('heard @src/a.py'), false, 'the mention is not sent for you');
  await page.keyboard.press('Enter');
  await until(() => screen(id).then(text => text.includes('heard @src/a.py')), 'the agent did not get the mention once sent');
  await menu(frame, '.row[data-path="src/a.py"]', 'copy');
  await until(() => page.evaluate(() => navigator.clipboard.readText()).then(text => text === path.join(project, 'src', 'a.py')), 'Copy path should copy the full path');
  note('Add to Claude types @src/a.py without sending it, and Copy path copies the full path');

  await frame.locator('#up').click();await frame.waitForSelector('.row[data-folder="notes"]');
  await menu(frame, '.row[data-folder="notes"]', 'move');
  const dialog = page.locator('#move-agent-dialog');
  await until(() => dialog.isVisible(), 'Move here should ask how');
  assert.equal(await dialog.locator('h2').textContent(), 'Move Claude to notes?');
  assert.equal(await dialog.locator('.move-agent-path').textContent(), '~/code/notes');
  assert.deepEqual(await dialog.locator('[data-choice]').evaluateAll(nodes => nodes.map(node => node.dataset.choice)), ['tell', 'new']);
  await page.screenshot({path: evidence('files-browse-03-ask.png')});
  await dialog.locator('[data-choice="new"]').click();
  await until(() => page.locator('#launch-terminal-dialog').isVisible(), 'Start a new Claude should open the launcher');
  assert.equal(await page.locator('#terminal-cwd').inputValue(), notes);
  assert.equal(await page.locator('#terminal-harness').inputValue(), 'claude');
  await page.locator('#launch-terminal-dialog .close-dialog').first().click();
  await menu(frame, '.row[data-folder="notes"]', 'move');
  await dialog.locator('[data-choice="tell"]').click();
  await until(() => screen(id).then(text => flat(text).includes(flat(`From here on, work in ${notes}.`))), 'Tell Claude should put the message in its input');
  assert.equal(flat(await screen(id)).includes(flat(`heard From here on`)), false, 'the message waits for you to send it');
  await until(async () => (await crumbs(frame)).join('/') === '~/code/notes' && (await frame.locator('#crumbs .crumb.current .here').count()) === 1, 'Files should follow Claude to its new folder');
  await page.screenshot({path: evidence('files-browse-04-told.png')});
  note('Move here asks; Start a new Claude fills the launcher, and Tell Claude types the message and moves the dot');

  const shell = await launch(project, ['/bin/sh'], 'Fixture shell');
  const second = await openFiles(shell);
  await second.frame.waitForSelector('.row[data-folder="src"]', {timeout: 10000});
  await second.frame.locator('#up').click();await second.frame.waitForSelector('.row[data-folder="notes"]');
  await second.frame.locator('.row[data-folder="notes"]').click({button: 'right'});
  assert.deepEqual(await second.frame.locator('#menu button').allTextContents(), ['Open this folder', 'Paste path in terminal', 'Move terminal here…', 'Copy path']);
  await second.frame.locator('#menu [data-act="move"]').click();
  await until(async () => await dialog.isVisible() && (await dialog.locator('h2').textContent()) === 'Move this terminal to notes?', 'Move here should ask for the shell too');
  assert.deepEqual(await dialog.locator('[data-choice]').evaluateAll(nodes => nodes.map(node => node.dataset.choice)), ['cd', 'new']);
  await dialog.locator('[data-choice="cd"]').click();
  await until(() => page.evaluate(id => document.activeElement?.closest('[data-pane-id]')?.dataset.paneId === id, shell), 'the shell should have the keyboard after cd');
  await page.keyboard.type('pwd');await page.keyboard.press('Enter');
  await until(() => screen(shell).then(text => flat(text).includes(flat(`pwd${notes}`))), 'the shell should have changed folder');
  note('a plain shell gets cd from Move here');

  await page.setViewportSize({width: 390, height: 844});await pause(600);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({path: evidence('files-browse-05-narrow.png')});
  for (const terminal of [id, shell]) await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), terminal);
  assert.deepEqual(errors, []);
  console.log('PASS: files browse: path bar with the agent\'s folder, the branch beside the pane\'s folder, Up/Open this folder/Back across the home folder, files outside the pane open in the editor, Add to Claude, Copy path, Move here asks (tell, new, cd), 1440 and 390px');
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
