// Browser regression: no desktop bridge, unchanged native xterm text input.
require('./check-isolated-url.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const {once} = require('node:events');
const {spawn, spawnSync} = require('node:child_process');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-files-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state};
let server, browser, port, log;
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
async function until(check, message) {for (let i = 0; i < 300; i++) {if (await check()) return;await pause();}throw Error(message);}
(async () => {
  const reservation = net.createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));assert.notEqual(port, 4310);
  const base = `http://127.0.0.1:${port}/`;
  log = fs.openSync(path.join(state, 'server.log'), 'a');
  server = spawn(python, ['-m', 'agent_desk', '--port', String(port)], {cwd: root, env: fixtureEnv, stdio: ['ignore', log, log]});
  await until(async () => {if (server.exitCode !== null) throw Error(fs.readFileSync(path.join(state, 'server.log'), 'utf8'));try {return (await fetch(base + 'config.js')).ok;} catch {return false;}}, 'Browser fixture server did not start');
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1280, height: 800}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const capture = path.join(state, 'input');
  const terminal = await page.evaluate(async ({cwd, argv}) => {const terminal = await terminalRequest('/api/terminals/launch', {cwd, argv, name: 'Browser prompt fixture'});await refresh();selectPane(terminal.id);return terminal;},
    {cwd: state, argv: [python, path.join(root, 'tests/fixtures/desktop/input.py'), capture]});
  await page.waitForFunction(id => {const v = paneViews.get(id);return v?.term?.modes.bracketedPasteMode && !v.restoring;}, terminal.id);
  assert.equal(await page.evaluate(() => typeof agentDeskDesktop), 'undefined');
  assert.equal(await page.evaluate(id => paneViews.get(id).files, terminal.id), null);
  let expected = '';
  for (const width of [1280, 480]) {
    await page.setViewportSize({width, height: 800});
    const text = width === 1280 ? 'ordinary text draft' : 'long text\n'.repeat(6000);
    await page.evaluate(({id, text}) => {
      const dt = new DataTransfer();dt.setData('text/plain', text);
      dt.items.add(new File([new Uint8Array([1])], 'ignored.png', {type: 'image/png'}));
      paneViews.get(id).term.textarea.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true}));
    }, {id: terminal.id, text});
    expected += '\x1b[200~' + text.replace(/\n/g, '\r') + '\x1b[201~';
    await until(() => fs.existsSync(capture) && fs.readFileSync(capture, 'utf8') === expected, 'Browser paste changed');
    assert.equal(fs.existsSync(path.join(state, 'pasted-images')), false);
    const intercepted = await page.evaluate(id => {
      const dt = new DataTransfer();dt.items.add(new File(['fixture'], 'fixture.txt'));
      const event = new DragEvent('dragover', {dataTransfer: dt, bubbles: true, cancelable: true});
      paneViews.get(id).term.textarea.dispatchEvent(event);return event.defaultPrevented;
    }, terminal.id);
    assert.equal(intercepted, false);assert.equal(await page.locator('.terminal-file-target').count(), 0);
  }
  await page.evaluate(id => paneViews.get(id).term.focus(), terminal.id);
  await page.keyboard.press('Control+v');await page.keyboard.press('Shift+Enter');expected += '\x16\x1b\r';
  await until(() => fs.readFileSync(capture, 'utf8') === expected, 'Browser Ctrl+V or Shift+Enter changed');
  await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), terminal.id);
  assert.deepEqual(errors, []);
  console.log('PASS: browser text/long paste, mixed image+text, Ctrl+V, Shift+Enter, no upload handlers or file-drag styling at 1280/480px');
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
