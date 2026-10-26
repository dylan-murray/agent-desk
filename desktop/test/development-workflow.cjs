'use strict';
// Source-run Electron development workflow: annotations, backend restart with
// surviving terminals, tool pop-out isolation, and quitting after a failed start.
// Disposable profiles, fictional terminals and a stand-in CLI only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {Backend} = require('../src/backend.cjs');
const {managedProcesses} = require('../src/runtime.cjs');
const {profilePaths} = require('../src/profile.cjs');
const root = path.resolve(__dirname, '../..');
const base = fs.mkdtempSync('/private/tmp/ad-dev-flow-');
const evidence = process.env.AGENT_DESK_EVIDENCE_DIR || os.tmpdir();fs.mkdirSync(evidence, {recursive: true});
const python = process.env.AGENT_DESK_PYTHON || execFileSync('/usr/bin/which', ['python3'], {encoding: 'utf8'}).trim();
// The stand-in interpreter fails while BROKEN exists, like a backend edit with a syntax error.
const broken = path.join(base, 'BROKEN'), wrapper = path.join(base, 'python3');
fs.writeFileSync(wrapper, `#!/bin/sh\n[ -e '${broken}' ] && exit 1\nexec '${python}' "$@"\n`, {mode: 0o700});
// A fictional coding CLI: it never prints a prompt and records anything delivered to it.
const bin = path.join(base, 'bin');fs.mkdirSync(bin);
const delivered = path.join(base, 'delivered.txt');
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nexec /bin/cat > '${delivered}'\n`, {mode: 0o700});
const skill = path.join(base, 'skills/fixture');fs.mkdirSync(skill, {recursive: true});
fs.copyFileSync(path.join(root, 'tests/fixtures/desktop/tool.py'), path.join(skill, 'tool.py'));
fs.writeFileSync(path.join(skill, 'agent-desk-ui.json'), JSON.stringify({runtime: 'python-http', entrypoint: 'tool.py', title: 'Fixture review', target: 'none', transports: ['unix-http-v1']}));
const launched = [];
function launch(name, interpreter = wrapper) {
  const env = {...process.env, AGENT_DESK_DESKTOP_TEST: '1', AGENT_DESK_PYTHON: interpreter, AGENT_DESK_PROFILE_DIR: path.join(base, name),
    AGENT_DESK_SOCKET_ROOT: path.join(base, 's'), AGENT_DESK_TOOL_ROOTS: path.join(base, 'skills')};
  return _electron.launch({executablePath: require('../node_modules/electron'), args: [path.join(root, 'desktop')], env, timeout: 30000}).then(app => {launched.push(app);return {app, env, profile: profilePaths('', env)};});
}
const menu = (app, label) => app.evaluate(({Menu}, label) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === label).click(), label);
const exited = (app, ms) => new Promise(resolve => {
  if (app.process().exitCode !== null || app.process().signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), ms);app.process().once('exit', () => {clearTimeout(timer);resolve(true);});
});
const connected = page => page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('Connected'), null, {timeout: 30000});
const until = async (check, message, ms = 15000) => {for (const end = Date.now() + ms; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 100))) if (await check()) return;throw Error(message);};
const alive = pid => {try {process.kill(pid, 0);return true;} catch {return false;}};
// Leave pin mode so ordinary clicks reach the page again.
const annotateOff = async page => {if (await page.locator('#annotation-launcher').getAttribute('aria-pressed') === 'true') await page.locator('#annotation-launcher').click();};
async function stubDialogs(app, answer) {
  await app.evaluate(({dialog}, answer) => {global.fixtureDialogs = [];global.fixtureErrors = [];
    dialog.showMessageBox = async (_window, options) => {global.fixtureDialogs.push(options);return {response: answer};};
    dialog.showErrorBox = (title, detail) => global.fixtureErrors.push(title + ': ' + detail);}, answer);
}

async function annotations() {
  const {app, profile} = await launch('annotations');
  const page = await app.firstWindow();await connected(page);
  assert.equal(await page.evaluate(() => AGENT_DESK_CONFIG.development), true, 'source runs enable development tools');
  for (const width of [1280, 480]) {
    await app.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 850), width);
    await page.waitForFunction(width => innerWidth === width, width);
    assert.equal(await page.locator('#annotation-launcher').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: path.join(evidence, `agent-desk-dev-annotations-${width}.png`)});
  }
  await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1280, 850));
  await page.waitForFunction(() => innerWidth === 1280);
  const checkout = path.join(root, 'data/feedback.json');
  const checkoutBefore = fs.existsSync(checkout) ? fs.statSync(checkout).mtimeMs : null;
  const file = path.join(profile.data, 'feedback.json');
  const stored = () => {try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {return {notes: []};}};
  // Pin through the existing annotation UI.
  await page.locator('#annotation-launcher').click();
  await page.locator('#mode-pin').click();
  await page.locator('#breadcrumb').click();
  await page.locator('#annotation-note-panel').waitFor({state: 'visible'});
  await page.locator('#annotation-note').fill('Fixture note: tighten the header spacing');
  await page.locator('#annotation-note-save').click();
  await until(() => stored().notes.some(note => note.note === 'Fixture note: tighten the header spacing'), 'annotation did not reach the desktop profile');
  await page.screenshot({path: path.join(evidence, 'agent-desk-dev-annotation-pin.png')});
  await annotateOff(page);
  // Reload (View > Reload) restores from the profile, then edit in the Feedback page.
  await page.reload();await connected(page);
  await page.evaluate(() => switchPage('feedback'));
  await page.locator('#feedback-list').getByText('Fixture note: tighten the header spacing').waitFor();
  await page.locator('[data-edit="0"]').click();
  await page.locator('#annotation-note').fill('Fixture note: edited after reload');
  await page.locator('#annotation-note-save').click();
  await until(() => stored().notes.length === 1 && stored().notes[0].note === 'Fixture note: edited after reload', 'edit was not saved');
  // A second note is deleted; its deletion persists.
  await page.evaluate(() => switchPage('agents'));
  await page.locator('#annotation-launcher').click();await page.locator('#mode-pin').click();
  await page.locator('#new-terminal').click({force: true});
  await page.locator('#annotation-note').fill('Fixture note: delete me');
  await page.locator('#annotation-note-save').click();
  await until(() => stored().notes.length === 2, 'second note was not saved');
  await annotateOff(page);
  const second = stored().notes.find(note => note.note === 'Fixture note: delete me').id;
  await page.evaluate(() => switchPage('feedback'));
  await page.locator('[data-edit="1"]').click();
  await page.locator('#annotation-note-delete').click();
  await until(() => stored().notes.length === 1 && stored().deleted?.includes(second), 'deletion was not saved');
  // Send the remaining note to a fictional coding terminal.
  await page.keyboard.press('Escape');await page.evaluate(() => switchPage('agents'));
  const agent = await page.evaluate(cwd => terminalRequest('/api/terminals/launch', {cwd, argv: [cwd + '/bin/claude'], name: 'Fictional coding agent'}), base);
  await page.evaluate(async id => {await refresh();selectPane(id);}, agent.id);
  await page.locator('#annotation-launcher').click();await page.locator('#annotation-send').click();
  await page.locator('#annotation-send-dialog').waitFor({state: 'visible'});
  await page.locator('.annotation-agent input').first().check();
  await page.locator('#annotation-send-notes input').first().check();
  await page.screenshot({path: path.join(evidence, 'agent-desk-dev-annotation-send.png')});
  await page.locator('#annotation-send-dialog [type=submit]').click();
  const submissions = path.join(profile.data, 'feedback-submissions');
  await until(() => fs.existsSync(submissions) && fs.readdirSync(submissions).some(name => fs.readFileSync(path.join(submissions, name), 'utf8').includes('edited after reload')), 'submission was not saved beside the profile');
  if (checkoutBefore === null) assert.equal(fs.existsSync(checkout), false, 'checkout data is untouched');
  else assert.equal(fs.statSync(checkout).mtimeMs, checkoutBefore, 'checkout data is untouched');
  await page.keyboard.press('Escape');
  await stubDialogs(app, 1);await menu(app, 'Quit Agent Desk');
  assert.ok(await exited(app, 30000), 'Stop Work and Quit exits');
  console.log('PASS: source Electron annotations save to', file, 'and survive reload, edit, delete and send.');
}

async function restartAndPopout() {
  const {app, env, profile} = await launch('workflow');
  let page = await app.firstWindow();await connected(page);
  const manager = new Backend({dataDir: profile.data, source: root, python: 'unused', node: 'unused', env});manager.loadRecord();
  const first = manager.record.pid;
  const terminal = await page.evaluate(() => terminalRequest('/api/terminals/launch', {cwd: '/private/tmp', argv: ['/bin/sh'], name: 'Fictional shell'}));
  await page.evaluate(async id => {await refresh();selectPane(id);}, terminal.id);
  const identity = await page.evaluate(() => window.fixtureIdentity = crypto.randomUUID());
  // Restart Backend loads Python edits without losing the terminal or the document.
  await menu(app, 'Restart Backend');
  await until(async () => {try {manager.record = null;manager.loadRecord();return manager.record.pid !== first && (await manager.status()).sessions.some(row => row.id === terminal.id);} catch {return false;}}, 'backend did not restart under the surviving terminal', 30000);
  await connected(page);
  assert.equal(await page.evaluate(() => window.fixtureIdentity), identity);
  assert.equal(alive(first), false);
  // A crash after an edit that breaks the backend: Retry and Quit must not orphan the terminal.
  fs.writeFileSync(broken, '');
  process.kill(manager.record.pid, 'SIGKILL');
  await page.waitForFunction(async () => (await agentDeskDesktop.snapshot()).connection === 'failed', null, {timeout: 30000});
  await stubDialogs(app, 1);
  await menu(app, 'Quit Agent Desk');
  await until(async () => (await app.evaluate(() => global.fixtureDialogs.length)) === 0 && (await page.evaluate(async () => (await agentDeskDesktop.snapshot()).error)) === 'Could not confirm shutdown. Use the Agent Desk menu to recover.', 'quit with a broken backend did not refuse');
  assert.equal(await exited(app, 1000), false, 'Quit never leaves managed work without a backend to stop it');
  assert.ok(managedProcesses(profile).length > 0, 'surviving supervisor is untouched');
  await page.screenshot({path: path.join(evidence, 'agent-desk-dev-broken-backend.png')});
  // Fixing the source and pressing Retry reconnects to the same terminal.
  fs.unlinkSync(broken);
  await page.evaluate(() => agentDeskDesktop.recover('retry'));
  await connected(page);
  assert.equal(await page.evaluate(() => window.fixtureIdentity), identity);
  assert.ok((await page.evaluate(() => terminalRequest('/api/agents'))).agents.some(row => row.id === terminal.id && row.exit_code === null));
  console.log('PASS: Restart Backend and post-edit crash recovery keep the terminal, document and refuse an orphaning Quit.');

  // Tool pop-out: its own window, its own origin, no desk authority.
  const tool = await page.evaluate(id => terminalRequest('/api/tools/launch', {skill: 'fixture', agent_id: id}), terminal.id);
  await page.evaluate(async tool => {await refreshSkillUIs();openToolOnDesk(tool);}, tool);
  await page.frameLocator('iframe[src^="agent-tool:"]').locator('#send').waitFor({timeout: 15000});
  const library = page.locator('.pane-dock-library');
  assert.equal(await library.getAttribute('title'), 'Open in a new window');
  const [popout] = await Promise.all([app.waitForEvent('window'), library.click()]);
  await popout.locator('#send').waitFor();
  const origin = new URL(await library.getAttribute('href')).origin;
  assert.equal(new URL(popout.url()).origin, origin);
  assert.equal(await popout.title(), 'Fixture review');
  assert.equal(await popout.evaluate(() => typeof window.agentDeskDesktop), 'undefined');
  assert.equal(await popout.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await popout.evaluate(async () => {try {await fetch('agent-desk://app/api/agents');return 'reached';} catch {return 'refused';}}), 'refused');
  await popout.click('#send');await popout.waitForSelector('#result:text("Saved")');
  const windows = () => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length);
  const count = await windows();
  await popout.evaluate(() => window.open(location.origin + '/', '_blank'));
  await popout.evaluate(() => {location.href = 'agent-desk://app/';});
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(await windows(), count, 'tools cannot open windows');
  assert.equal(new URL(popout.url()).origin, origin, 'tools cannot navigate to the desk');
  // Clicking again focuses the same window; reload and close behave normally.
  await library.click();await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(await windows(), count);
  await popout.reload();await popout.locator('#send').waitFor();
  for (const width of [1100, 480]) {
    await app.evaluate(({BrowserWindow}, {width, url}) => BrowserWindow.getAllWindows().find(win => win.webContents.getURL() === url).setSize(width, 700), {width, url: popout.url()});
    await popout.screenshot({path: path.join(evidence, `agent-desk-dev-tool-popout-${width}.png`)});
  }
  await popout.close();
  assert.equal(await windows(), count - 1);
  // A desk-registered window is required: a forged tool address is refused.
  const refused = await page.evaluate(() => agentDeskDesktop.openTool('agent-tool://t' + '0'.repeat(32) + '/').then(() => 'opened', error => error.message));
  assert.match(refused, /no longer running/);
  await page.screenshot({path: path.join(evidence, 'agent-desk-dev-tool-docked.png')});
  console.log('PASS: tool pop-out opens its own origin without desk bridge, IPC, windows or navigation; reload/close/refocus work.');
  await stubDialogs(app, 1);await menu(app, 'Quit Agent Desk');
  assert.ok(await exited(app, 30000), 'Stop Work and Quit exits');
  assert.deepEqual(managedProcesses(profile), [], 'Stop Work and Quit stopped the reattached supervisor and tool');
}

async function failedStartupQuit() {
  for (const [name, interpreter] of [['exited', wrapper], ['missing', path.join(base, 'missing/python3')]]) {
    if (name === 'exited') fs.writeFileSync(broken, '');
    const {app, profile} = await launch('failed-' + name, interpreter);
    const page = await app.firstWindow();
    await page.waitForFunction(async () => (await agentDeskDesktop.snapshot()).connection === 'failed', null, {timeout: 30000});
    await stubDialogs(app, 2);
    await menu(app, 'Quit Agent Desk');
    assert.ok(await exited(app, 10000), `Quit exits after a ${name} backend start`);
    assert.equal(await app.evaluate(() => 0).catch(() => 'closed'), 'closed');
    assert.deepEqual(managedProcesses(profile), []);
    fs.rmSync(broken, {force: true});
  }
  console.log('PASS: Quit exits when the backend never started and no managed work remains.');
}

(async () => {
  await failedStartupQuit();
  await annotations();
  await restartAndPopout();
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  for (const app of launched) try {await app.evaluate(({app}) => app.exit(0));} catch { /* already closed */ }
  console.log('Fixture:', base);
});
