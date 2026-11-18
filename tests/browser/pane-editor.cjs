require('./check-isolated-url.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const evidence = require('./evidence.cjs');
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-editor-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state};
let server, browser, port, log;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, tries = 200) {for (let i = 0; i < tries; i++) {if (await check()) return;await pause(50);}throw Error(message);}
const note = message => {if (process.env.VERBOSE) console.log('  ok ' + message);};
(async () => {
  const reservation = net.createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));assert.notEqual(port, 4310);
  const base = `http://127.0.0.1:${port}/`;
  log = fs.openSync(path.join(state, 'server.log'), 'a');
  server = spawn(python, ['-m', 'agent_desk', '--port', String(port)], {cwd: root, env: fixtureEnv, stdio: ['ignore', log, log]});
  await until(async () => {if (server.exitCode !== null) throw Error(fs.readFileSync(path.join(state, 'server.log'), 'utf8'));try {return (await fetch(base + 'config.js')).ok;} catch {return false;}}, 'Browser fixture server did not start', 300);
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const project = fs.mkdtempSync(path.join(state, 'project-'));
  fs.mkdirSync(path.join(project, 'src'));fs.mkdirSync(path.join(project, 'docs'));
  fs.writeFileSync(path.join(project, 'README.md'), '# Fixture project\n\nA made-up project for editor checks.\n');
  fs.writeFileSync(path.join(project, 'src', 'app.py'), 'def greet(name):\n    return f"hello {name}"\n\n\nif __name__ == "__main__":\n    print(greet("desk"))\n');
  fs.writeFileSync(path.join(project, 'docs', 'plan.md'), '# Plan\n\n1. Draft\n2. Review\n');
  const id = await page.evaluate(async cwd => {const t = await terminalRequest('/api/terminals/launch', {cwd, argv: ['/bin/bash', '--noprofile', '--norc'], name: 'Fixture shell'});await refresh();selectPane(t.id);return t.id;}, project);
  await page.waitForFunction(id => paneViews.get(id)?.term && !paneViews.get(id).restoring, id);
  const ace = () => page.evaluate(() => {const e = document.querySelector('.pane-editor-ace').env.editor;return {value: e.getValue(), mode: e.session.getMode().$id, gutter: document.querySelectorAll('.pane-editor .ace_gutter-cell').length, focused: e.isFocused()};});
  const screen = () => page.evaluate(id => {const b = paneViews.get(id).term.buffer.active;let s = '';for (let i = 0; i < b.length; i++) {const line = b.getLine(i);s += (line.isWrapped ? '' : '\n') + line.translateToString(true);}return s;}, id);
  const send = text => page.evaluate(({id, text}) => terminalRequest('/api/terminals/input', {id, data: btoa(text)}), {id, text});

  await page.screenshot({path: evidence('pane-editor-01-before.png')});
  await page.locator('.terminal-pane').hover();
  await page.locator('.pane-edit').click();
  await until(() => page.locator('.pane-editor').isVisible(), 'editor did not open');
  const [termBox, editorBox] = await Promise.all([page.locator('.pane-body').boundingBox(), page.locator('.pane-editor').boundingBox()]);
  assert.ok(editorBox.x > termBox.x + termBox.width - 10, 'editor is not to the right of the terminal');
  assert.ok((await ace()).focused);
  note(`Pencil opens the editor docked right of the terminal (terminal ${Math.round(termBox.width)}px, editor ${Math.round(editorBox.width)}px), focused`);

  await page.keyboard.type('a wall of text pasted from somewhere\nsecond line');
  await page.keyboard.press('Meta+s');
  await until(() => page.locator('.pane-editor-banner input').isVisible(), 'save-as did not ask for a path');
  await page.locator('.pane-editor-banner input').fill('docs/new-notes.md');
  await page.keyboard.press('Enter');
  await until(() => fs.existsSync(path.join(project, 'docs/new-notes.md')), 'save as did not write');
  assert.equal(fs.readFileSync(path.join(project, 'docs/new-notes.md'), 'utf8'), 'a wall of text pasted from somewhere\nsecond line');
  assert.equal(await page.locator('.pane-editor-tab [aria-selected=true]').textContent(), 'new-notes.md');
  note('Untitled text saves as a file in the pane\'s folder (⌘S → path)');

  await page.keyboard.press('Meta+p');
  await until(() => page.locator('.pane-editor-finder').isVisible(), 'quick open missing');
  await page.keyboard.type('app');
  await until(async () => (await page.locator('.pane-editor-finder [aria-selected=true]').getAttribute('data-path')) === 'src/app.py', 'finder did not rank src/app.py first');
  await page.keyboard.press('Enter');
  await until(async () => (await ace()).value.startsWith('def greet'), 'app.py did not open');
  let shown = await ace();
  assert.equal(shown.mode, 'ace/mode/python');assert.ok(shown.gutter >= 6, 'no line numbers');
  await page.screenshot({path: evidence('pane-editor-02-python-file.png')});
  note(`⌘P quick-open finds src/app.py; opens with python highlighting and ${shown.gutter} numbered lines`);

  await page.evaluate(() => {const e = document.querySelector('.pane-editor-ace').env.editor;e.navigateFileEnd();e.focus();});
  await page.keyboard.type('# edited in the desk');
  assert.equal(await page.locator('.pane-editor-state').textContent(), 'Unsaved');
  await page.keyboard.press('Meta+s');
  await until(() => fs.readFileSync(path.join(project, 'src/app.py'), 'utf8').endsWith('# edited in the desk'), 'save did not write');
  await until(async () => (await page.locator('.pane-editor-state').textContent()) === 'Saved', 'state not Saved');
  note('Typing marks the file Unsaved; ⌘S writes it and shows Saved');

  fs.writeFileSync(path.join(project, 'src/app.py'), 'print("an agent rewrote this")\n');
  await until(async () => (await ace()).value === 'print("an agent rewrote this")\n', 'clean buffer not reloaded from disk', 120);
  note('A clean file reloads by itself when the agent changes it on disk');

  await page.evaluate(() => document.querySelector('.pane-editor-ace').env.editor.focus());
  await page.keyboard.type('# mine ');
  fs.writeFileSync(path.join(project, 'src/app.py'), 'print("agent again")\n');
  await until(() => page.locator('.pane-editor-banner').isVisible(), 'no conflict banner', 120);
  assert.match(await page.locator('.pane-editor-banner').textContent(), /changed on disk/);
  await page.screenshot({path: evidence('pane-editor-03-changed-on-disk.png')});
  await page.locator('.pane-editor-action.primary').click();
  await until(() => fs.readFileSync(path.join(project, 'src/app.py'), 'utf8').includes('# mine'), 'keep mine did not save');
  await until(async () => (await page.locator('.pane-editor-state').textContent()) === 'Saved', 'status stuck after Keep mine: ' + await page.locator('.pane-editor-state').textContent());
  note('Unsaved edits are never replaced: a changed-on-disk banner offers Use the file\'s version / Keep mine');

  await page.locator('.pane-dock-expand').click();
  assert.equal(await page.locator('.pane-body').isVisible(), false);
  const wide = await page.locator('.pane-editor').boundingBox();
  await page.screenshot({path: evidence('pane-editor-04-expanded.png')});
  await page.locator('.pane-dock-expand').click();
  assert.equal(await page.locator('.pane-body').isVisible(), true);
  note(`Expand fills the pane with the editor (${Math.round(wide.width)}px) and collapses back`);

  const before = (await page.locator('.pane-editor').boundingBox()).width;
  await page.locator('.pane-divider').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowLeft');
  const after = (await page.locator('.pane-editor').boundingBox()).width;
  assert.ok(after > before + 100, `divider did not widen the editor ${before} → ${after}`);
  note(`The divider widens the editor (${Math.round(before)} → ${Math.round(after)}px)`);

  await page.evaluate(id => paneViews.get(id).term.focus(), id);
  await page.keyboard.press('Meta+e');
  assert.ok((await ace()).focused);
  await page.keyboard.press('Meta+e');
  assert.equal(await page.evaluate(id => paneViews.get(id).term.textarea === document.activeElement, id), true);
  note('⌘E moves focus between the terminal and its editor');

  await send(`printf 'draft prompt' > p.md; "$EDITOR" p.md; echo "EXIT:$?"; echo "GOT:$(cat p.md)"\r`);
  await until(async () => (await page.locator('.pane-editor-tab[data-kind=edit]').count()) === 1, 'ctrl+g stand-in did not open a tab', 300);
  assert.equal((await ace()).value, 'draft prompt');
  assert.match(await page.locator('.pane-editor-banner').textContent(), /is waiting for this p\.md/);
  await page.keyboard.type(' plus more written in the desk editor');
  await page.screenshot({path: evidence('pane-editor-05-ctrl-g-tab.png')});
  await page.keyboard.press('Meta+s');
  await until(async () => /GOT:draft prompt plus more written in the desk editor/.test(await screen()), 'saved text did not return', 200);
  assert.match(await screen(), /EXIT:0/);
  assert.equal(await page.locator('.pane-editor-tab[data-kind=edit]').count(), 0);
  note('$EDITOR in the pane opens as a tab in its editor; ⌘S hands the text back and closes the tab');

  await page.reload();await page.waitForLoadState('load');
  await until(() => page.locator('.pane-editor').isVisible(), 'editor not restored after reload', 200);
  const tabs = await page.locator('.pane-editor-tab [role=tab]').allTextContents();
  assert.deepEqual(tabs, ['new-notes.md', 'app.py']);
  note('After a reload the editor is still open with the same files: ' + tabs.join(', '));

  await page.setViewportSize({width: 480, height: 860});await pause(400);
  const narrow = await page.locator('.pane-editor').boundingBox();
  assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 480);
  await page.screenshot({path: evidence('pane-editor-06-narrow.png')});
  note('At 480px the editor stacks under the terminal inside the viewport');

  await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), id);
  assert.deepEqual(errors, []);
  console.log('PASS: pane editor docks right, save as, quick open, highlighting and line numbers, save, disk reload and conflict, expand, divider, ⌘E focus, $EDITOR tab round trip, reload restore, 1440 and 480px');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close();
  if (server?.exitCode === null) {const stopped = once(server, 'exit');server.kill('SIGINT');await stopped;}
  if (port) {
    const cleanup = spawnSync(python, ['-c', "from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()", state, String(port)], {cwd: root, env: fixtureEnv, encoding: 'utf8', timeout: 15000});
    if (cleanup.status !== 0) console.error('Fixture cleanup:', cleanup.stderr);
  }
  if (log !== undefined) fs.closeSync(log);
  console.log('Browser fixture:', state);
});
