// Real backend, real PTY, the bundled code review; a stand-in gh answers for two pull requests and never reaches GitHub.
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
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-review-prs-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
const fakeBin = path.join(state, 'bin');fs.mkdirSync(fakeBin);
const PR7 = 'https://github.com/fixture/project/pull/7', PR8 = 'https://github.com/fixture/project/pull/8';
// gh pr view in the folder answers for the checked-out branch's pull request, gh pr view URL for the one the terminal printed.
fs.writeFileSync(path.join(fakeBin, 'gh'), `#!${python}
import json, os, sys
args, here = sys.argv[1:], os.path.dirname(os.path.abspath(__file__))
prs = json.load(open(os.path.join(here, 'prs.json')))
if args[:2] == ['pr', 'view']:
    print(json.dumps(prs[args[2]] if len(args) > 2 and args[2].startswith('https://') else prs['branch']))
elif args[:2] == ['api', 'graphql']:
    number = next(a.split('=')[1] for a in args if a.startswith('number='))
    print(json.dumps({'data': {'repository': {'pullRequest': {'reviewThreads': {'nodes': [{'isResolved': False}] * (2 if number == '8' else 0)}}}}}))
elif args[:1] == ['api']:
    print(json.dumps([prs.get('api:' + args[-1], [])]))
else:
    sys.exit('fake gh: ' + ' '.join(args))
`);
fs.chmodSync(path.join(fakeBin, 'gh'), 0o755);
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state,
  REVIEW_APP_HOME: path.join(state, 'review-notes'), GROUND_CONTROL_DATA_DIR: path.join(state, 'review-submissions'), REVIEW_APP_PR_POLL_SECONDS: '1',
  AGENT_DESK_PR_POLL_SECONDS: '1', REVIEW_APP_USER: 'Fixture reviewer', PATH: fakeBin + path.delimiter + process.env.PATH};
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

  // main, then two branches with a pull request each: feature is checked out, other is not.
  const project = fs.mkdtempSync(path.join(state, 'project-'));
  const git = (...args) => execFileSync('git', args, {cwd: project, env: {...fixtureEnv, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'}, encoding: 'utf8'}).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'app.py'), 'def greet(name):\n    return "hello " + name\n');
  git('add', '.');git('commit', '-q', '-m', 'Fixture');const main = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'other');
  fs.writeFileSync(path.join(project, 'farewell.py'), 'def part(name):\n    return "bye " + name\n');
  git('add', '.');git('commit', '-q', '-m', 'Farewell');const other = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature', 'main');
  fs.writeFileSync(path.join(project, 'app.py'), 'def greet(name):\n    return f"hello {name}"\n');
  git('commit', '-qam', 'f-strings');
  git('update-ref', 'refs/remotes/origin/main', main);git('remote', 'add', 'origin', 'https://github.com/fixture/project.git');
  const shared = {isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [], latestReviews: [], state: 'OPEN', baseRefName: 'main'};
  fs.writeFileSync(path.join(fakeBin, 'prs.json'), JSON.stringify({
    branch: {...shared, number: 7, title: 'Use f-strings', url: PR7, headRefName: 'feature'},
    [PR8]: {...shared, number: 8, title: 'Say goodbye', url: PR8, headRefName: 'other', headRefOid: other, baseRefOid: main},
    'api:repos/fixture/project/pulls/8/comments': [{id: 801, path: 'farewell.py', line: 2, side: 'RIGHT', body: 'Use an f-string here too', user: {login: 'fixture-reviewer'},
      html_url: PR8 + '#discussion_r801', created_at: '2026-11-18T10:00:00Z'}]}));

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  // The terminal prints the other pull request's link, the way gh pr create does.
  const id = await page.evaluate(async ({cwd, argv}) => {const t = await terminalRequest('/api/terminals/launch', {cwd, argv, launch_profile: 'claude', name: 'Fixture agent'});await refresh();selectPane(t.id);return t.id;},
    {cwd: project, argv: ['/bin/sh', '-c', `echo "Opened ${PR8}"; exec cat`]});
  await page.waitForFunction(id => paneViews.get(id)?.term && !paneViews.get(id).restoring, id);
  const pane = page.locator(`[data-pane-id="${id}"]`);
  await page.waitForFunction(id => {const pr = everyAgent().find(a => a.id === id)?.pull_request;return pr?.number === 7 && pr.others?.some(o => o.number === 8);}, id, {timeout: 20000});
  note('the desk sees both pull requests: the branch\'s and the printed one');

  await pane.hover();await pane.locator('.pane-edit').click();
  await pane.locator('.pane-dock-tab[data-entry="@review"]').click();
  await until(async () => (await pane.locator('.pane-dock-frame:not([hidden])').count()) === 1, 'Review did not open the code review', 300);
  const frame = await (await pane.locator('.pane-dock-frame:not([hidden])').elementHandle()).contentFrame();
  await frame.waitForFunction(() => document.querySelector('#prstate a')?.href.endsWith('/pull/7'), null, {timeout: 30000});
  await frame.waitForSelector('#prpick', {timeout: 10000});
  await frame.waitForFunction(() => /^feature · vs /.test(document.querySelector('#meta').textContent), null, {timeout: 15000});
  assert.equal(await pane.locator('.pane-branch').textContent(), 'feature', 'the pane names its branch beside its folder');
  await frame.locator('#prpick').click();
  await frame.waitForSelector('#pr-menu:not([hidden])');
  const rows = await frame.locator('#pr-menu button').evaluateAll(buttons => buttons.map(b => [b.querySelector('.num').textContent, b.querySelector('.t').textContent, b.querySelector('.st').textContent, b.getAttribute('aria-checked')]));
  assert.deepEqual(rows, [['#7', 'Use f-strings', 'checked out', 'true'], ['#8', 'Say goodbye', '2 comments', 'false']]);
  assert.equal(await frame.evaluate(() => document.activeElement?.dataset.url), 'https://github.com/fixture/project/pull/7', 'the menu opens on the PR shown');
  await page.screenshot({path: evidence('pane-review-prs-01-menu.png')});
  note('the PR row offers the terminal\'s pull requests, with which one is checked out and how many comments the other has');

  await frame.locator('#pr-menu button[data-url$="/pull/8"]').click();
  await frame.waitForSelector('section.file[data-path="farewell.py"]', {timeout: 30000});
  assert.equal(await frame.locator('section.file').count(), 1, 'only the other PR\'s changes show');
  assert.equal(await frame.locator('#meta').textContent(), 'other · not checked out here');
  assert.equal(await frame.locator('#meta').evaluate(el => el.classList.contains('away')), true);
  assert.equal(await frame.locator('#prstate a').getAttribute('href'), PR8);
  await frame.waitForFunction(() => document.querySelector('section.file[data-path="farewell.py"]')?.textContent.includes('Use an f-string here too'), null, {timeout: 15000});
  assert.equal(await frame.locator('#codex').isDisabled(), false, 'a second opinion reviews the PR shown, from a temporary checkout of its head');
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'feature', 'nothing was checked out');
  assert.equal(fs.existsSync(path.join(project, 'farewell.py')), false);
  await pause(400);
  await page.screenshot({path: evidence('pane-review-prs-02-other.png')});
  note('choosing #8 shows its diff and its GitHub comment from Git, says it is not checked out, and leaves the folder alone');

  await frame.locator('#prpick').click();
  await frame.locator('#pr-menu button[data-url$="/pull/7"]').click();
  await frame.waitForSelector('section.file[data-path="app.py"]', {timeout: 30000});
  assert.match(await frame.locator('#meta').textContent(), /^feature · vs /);
  assert.equal(await frame.locator('text=Use an f-string here too').count(), 0, '#8\'s notes stay with #8');
  assert.equal(await frame.locator('#codex').isDisabled(), false);
  note('switching back shows the checked-out work again, without #8\'s notes');

  await page.setViewportSize({width: 390, height: 844});await pause(500);
  await pane.locator('.pane-dock-expand').click();await pause(300);
  await frame.locator('#prpick').click();await frame.waitForSelector('#pr-menu:not([hidden])');
  const fits = await frame.evaluate(() => {const r = document.querySelector('#pr-menu').getBoundingClientRect();return r.left >= 0 && r.right <= innerWidth;});
  assert.equal(fits, true, 'the menu stays inside a phone-width review');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  await page.screenshot({path: evidence('pane-review-prs-03-narrow.png')});
  note('at 390px the menu fits inside the review');

  await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), id);
  assert.deepEqual(errors, []);
  console.log('PASS: pane review pull requests: the terminal\'s pull requests in the PR row, another one reviewed from Git with its own comments, not checked out, back to the branch, 1440 and 390px');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close();
  if (server?.exitCode === null) {const stopped = once(server, 'exit');server.kill('SIGINT');await stopped;}
  if (port) {
    const cleanup = spawnSync(python, ['-c', "from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()", state, String(port)], {cwd: root, env: fixtureEnv, encoding: 'utf8'});
    if (cleanup.status !== 0) console.error('Fixture cleanup:', cleanup.stderr);
    spawnSync('pkill', ['-f', path.join(state, 'project-')]);
  }
  if (log !== undefined) fs.closeSync(log);
  console.log('Browser fixture:', state);
});
