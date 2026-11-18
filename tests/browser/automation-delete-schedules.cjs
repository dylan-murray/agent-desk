// Real backend: an automation on two schedules shows them on its card, and deleting it removes what only it ran.
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
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-automation-delete-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state};
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

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const call = (route, body) => page.evaluate(([route, body]) => terminalRequest(route, body), [route, body]);
  const role = await call('/api/special-agents/save', {id: '', name: 'Flaky test fixer', kind: 'fixer', scope: 'Failing CI runs on main.', instructions: 'Fixture.', cwd: project, choice: 'custom', command: '/bin/cat', mode: 'direct'});
  const roleId = role.id || role.role?.id || (await call('/api/special-agents')).roles.find(r => r.name === 'Flaky test fixer').id;
  const task = await call('/api/workflows/save-config', {name: 'Flaky test fixer', kind: 'automation', role_id: roleId, timeout: 3600});
  await call('/api/workflows/save', {name: 'Nightly fix', nodes: [{id: 'fix', config_id: task.id, depends_on: []}], trigger: 'cron', cron: '0 9 * * 1-5', timezone: 'UTC', enabled: true});

  await page.evaluate(() => {switchPage('special-agents');return window.refreshAutomations();});
  const card = page.locator('.automation-card', {has: page.locator('h3', {hasText: 'Flaky test fixer'})});
  await until(async () => (await card.locator('.automation-schedule').innerText()) === 'Weekdays 09:00', 'the card did not show its schedule');
  assert.equal(await card.locator('.automation-schedule').getAttribute('title'), 'Nightly fix · Monday–Friday at 09:00');
  assert.equal(await card.locator('.automation-schedule').evaluate(chip => chip.scrollWidth <= chip.clientWidth), true, 'the schedule fits its chip');
  assert.match(await card.locator('.automation-run').getAttribute('class'), /\bautomation-start\b/);
  // The chip opens that schedule in Run & Schedule.
  await card.locator('.automation-schedule').click();
  await page.waitForSelector('#schedule-dialog[open]');
  assert.equal(await page.locator('#schedule-name').inputValue(), 'Nightly fix');
  await page.locator('#schedule-dialog').evaluate(dialog => dialog.close());
  note('the card shows its schedule in words, and the chip opens it');

  // A second schedule runs it and another task that waited on it.
  const report = await call('/api/workflows/save-config', {name: 'Report', kind: 'command', cwd: project, argv: ['/bin/echo', 'report'], timeout: 60});
  await call('/api/workflows/save', {name: 'Fix then report', nodes: [{id: 'fix', config_id: task.id, depends_on: []}, {id: 'report', config_id: report.id, depends_on: ['fix']}], trigger: 'manual', timezone: 'UTC', enabled: false});
  await page.evaluate(() => {switchPage('special-agents');return window.refreshAutomations();});
  await until(async () => (await card.locator('.automation-schedule').innerText()) === 'Weekdays 09:00 +1', 'the card did not count its second schedule');

  // Deleting through the API without having been shown the schedules still refuses.
  const refused = await page.evaluate(id => terminalRequest('/api/special-agents/delete', {id}).then(() => 'deleted', error => error.message), roleId);
  assert.match(refused, /Run & Schedule still uses this automation \(Flaky test fixer\)/);
  note('a delete that was not shown the schedules is refused');

  await page.screenshot({path: evidence('automation-delete-schedules-01-card.png')});
  await card.locator('.automation-delete').click();
  await page.waitForSelector('.automation-delete-dialog[open]');
  assert.deepEqual(await page.locator('.automation-delete-uses li').allInnerTexts(), ['Nightly fix\nMonday–Friday at 09:00 · deleted', 'Fix then report\nRun by hand · off · keeps its other 1 task']);
  assert.equal(await page.locator('.automation-delete-confirm').innerText(), 'Delete and remove 1 schedule');
  await page.screenshot({path: evidence('automation-delete-schedules-02-dialog.png')});
  await page.locator('.automation-delete-confirm').click();
  await until(async () => (await card.count()) === 0, 'the automation was not deleted');
  const workflows = await call('/api/workflows');
  assert.deepEqual(workflows.configs.map(c => c.name), ['Report']);
  assert.deepEqual(workflows.workflows.map(w => [w.name, w.nodes]), [['Fix then report', [{id: 'report', config_id: report.id, depends_on: []}]]]);
  note('deleting removes its launch configuration and the schedule that ran only it, and keeps the other schedule\'s task');

  await page.setViewportSize({width: 390, height: 844});
  const again = await call('/api/special-agents/save', {id: '', name: 'Release notes researcher', kind: 'researcher', scope: 'Merged pull requests since the last tag.', instructions: 'Fixture.', cwd: project, choice: 'custom', command: '/bin/cat', mode: 'direct'});
  assert.ok(again);
  await page.evaluate(() => window.refreshAutomations());
  await page.locator('.automation-card').first().waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  const row = await page.locator('.automation-card').first().locator('.automation-actions').evaluate(footer => [...footer.children].map(child => {const box = child.getBoundingClientRect();return Math.round(box.top + box.height / 2);}));
  assert.equal(new Set(row).size, 1, 'the shelf stays one row at 390px');
  await page.screenshot({path: evidence('automation-delete-schedules-03-narrow.png')});
  note('at 390px the shelf stays on one row');

  assert.deepEqual(errors, []);
  console.log('PASS: automation schedules on the card and in delete: the chip names and opens its schedule, an unconfirmed delete is refused, the dialog lists what goes, delete removes the schedule that ran only it and trims the other, 1440 and 390px');
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
