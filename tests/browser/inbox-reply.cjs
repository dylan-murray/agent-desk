// Real backend: replying to a finished automation's report starts a follow-up pass that carries the reply.
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
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-inbox-reply-'));
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
  const project = fs.mkdtempSync(path.join(state, 'project-')), prompts = path.join(project, 'prompts.jsonl');
  const read = () => fs.existsSync(prompts) ? fs.readFileSync(prompts, 'utf8').trim().split('\n').map(line => JSON.parse(line).prompt) : [];

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const call = (route, body) => page.evaluate(([route, body]) => terminalRequest(route, body), [route, body]);
  await call('/api/special-agents/save', {id: '', name: 'Slack triage', kind: 'watcher', scope: '#team only', instructions: 'Fixture.', cwd: project, choice: 'custom', command: path.join(root, 'tests/fixtures/record_prompt_agent.py'), mode: 'direct'});
  const roleId = (await call('/api/special-agents')).roles.find(r => r.name === 'Slack triage').id;
  const first = await page.evaluate(id => terminalRequest('/api/special-agents/launch', {id, desk: activeDesk().id}), roleId);
  await until(() => read().length === 1, 'the first pass did not start');
  await call('/api/special-agents/report', {run_id: first.run_id, state: 'review', detail: '# Triage digest\n\nRead-only pass. Nothing was posted.\n\n## Findings\n- Two requests in #team need an owner.\n\n## Open questions\n- Should #ops count as in scope?\n- Is Friday too late for the handoff?'});
  // A reported run's terminal closes on its own; after that, a reply can only start another pass.
  await until(async () => !(await call('/api/agents')).agents.some(a => a.id === first.session.id && a.exit_code === null), 'the reported run kept its terminal', 300);
  note('a pass ran, reported, and its terminal closed');

  await page.locator('#open-inbox').click();
  const row = page.locator('.inbox-row', {hasText: 'Triage digest'});await row.click();
  assert.equal(await page.locator('.inbox-head h2').textContent(), 'Triage digest');
  assert.match(await page.locator('.inbox-reply-route').textContent(), /session has ended\. Sending starts a follow-up pass/);
  assert.equal(await page.locator('.inbox-reply-send').textContent(), 'Start follow-up pass');
  const question = page.locator('.inbox-body li', {hasText: 'Should #ops count as in scope?'});
  await question.hover();await question.locator('.inbox-quote-reply').click();
  await until(async () => (await page.locator('#inbox-reply-text').inputValue()) === '> Should #ops count as in scope?\n\n', 'Reply did not quote the question');
  await page.locator('#inbox-reply-text').press('End');await page.keyboard.type('Yes, include #ops from now on.');
  await page.screenshot({path: evidence('inbox-reply-01-composing.png')});
  await page.locator('#inbox-reply-text').press('Meta+Enter');
  await until(() => read().length === 2, 'the follow-up pass did not start', 200);
  const prompt = read()[1];
  assert.match(prompt, /follows up on your own earlier report, "Slack triage · review"/);
  assert.match(prompt, /The user's reply:\n> Should #ops count as in scope\?\n\nYes, include #ops from now on\./);
  assert.match(prompt, /Your earlier report:\n# Triage digest/);
  await page.locator('.inbox-reply-status').waitFor();
  assert.match(await page.locator('.inbox-reply-status').textContent(), /Follow-up pass started/);
  assert.equal(await page.locator('#inbox-reply-text').inputValue(), '', 'a sent reply clears the box');
  await page.screenshot({path: evidence('inbox-reply-02-sent.png')});
  note('quoting a question and sending starts a follow-up pass whose prompt carries the reply and the earlier report');

  const refused = await page.evaluate(async () => (await fetch('/api/special-agents/follow-up', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({id: 'x', reply: 'y'})})).status);
  assert.equal(refused, 403, 'a follow-up needs the desk\'s own token');
  await page.setViewportSize({width: 390, height: 844});await pause(300);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.locator('.inbox-reply').scrollIntoViewIfNeeded();await page.screenshot({path: evidence('inbox-reply-03-narrow.png')});
  assert.deepEqual(errors, []);
  console.log('PASS: inbox reply: a finished run\'s report names itself, quotes a question into the reply, and sending starts a follow-up pass with the reply and the report; refused without the desk token; 1440 and 390px');
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
