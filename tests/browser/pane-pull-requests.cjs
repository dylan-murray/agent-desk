// A terminal's branch pull request shows as a chip in its pane header, and failing checks or a
// new review reach the Inbox. Starts its own backend with a fake gh on PATH: GitHub is never called.
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
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-prs-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
const fake = path.join(state, 'fake-gh'), bin = path.join(state, 'bin'), projects = path.join(state, 'projects');
const PR_URL = 'https://github.com/example-org/example-repo/pull/42', CORP_URL = 'https://ghe.example-corp.test/platform/corp-repo/pull/7', JOB_URL = 'https://github.com/example-org/example-repo/actions/runs/7/job/11';
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))),
  AGENT_DESK_DATA_DIR: path.join(state, 'data'), AGENT_DESK_FAKE_GH: fake, AGENT_DESK_PR_POLL_SECONDS: '1',
  // Only the stub and the system tools, so a real gh on this machine is never found.
  PATH: [bin, path.dirname(fs.realpathSync(process.execPath)), '/usr/bin', '/bin'].join(path.delimiter)};
let server, browser, port, log;
const pause = () => new Promise(resolve => setTimeout(resolve, 50));
async function until(check, message) {for (let i = 0; i < 300; i++) {if (await check()) return;await pause();}throw Error(message);}
const run = (name, status, conclusion = '') => ({__typename: 'CheckRun', name, status, conclusion, detailsUrl: JOB_URL});
const answer = (name, fields, code = 0, stderr = '') => fs.writeFileSync(path.join(fake, name), JSON.stringify({code, stderr,
  stdout: fields && {number: 42, title: 'Add fixture retry', url: PR_URL, state: 'OPEN', isDraft: false, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [], latestReviews: [], ...fields}}));
function repository(name, remote) {
  const repo = path.join(projects, name);fs.mkdirSync(repo, {recursive: true});
  for (const argv of [['init', '-q', '-b', 'feature/fixture-retry'], ['remote', 'add', 'origin', remote]]) assert.equal(spawnSync('git', ['-C', repo, ...argv]).status, 0);
  return repo;
}
const results = [];
const check = (name, fn) => {fn();results.push(name);console.log('  PASS  ' + name);};
(async () => {
  fs.mkdirSync(fake);fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), `#!/bin/sh\nexec "${python}" "${path.join(root, 'tests/fixtures/fake_gh.py')}" "$@"\n`, {mode: 0o755});
  const repos = {pr: repository('example-repo', 'git@github.com:example-org/example-repo.git'), none: repository('no-pr-repo', 'https://github.com/example-org/no-pr-repo.git'),
    plain: repository('plain-repo', 'https://git.example.test/team/plain-repo.git'), corp: repository('corp-repo', 'ssh://git@ghe.example-corp.test/platform/corp-repo.git')};
  answer('pr-example-repo.json', {statusCheckRollup: [run('lint', 'COMPLETED', 'SUCCESS'), run('unit tests', 'IN_PROGRESS')]});
  answer('pr-no-pr-repo.json', null, 1, 'no pull requests found for branch "feature/fixture-retry"');
  answer('pr-plain-repo.json', null, 1, 'none of the git remotes configured for this repository point to a known GitHub host. To tell gh about a new GitHub host, please use `gh auth login`');
  // A GitHub Enterprise server gh is signed into answers like github.com.
  answer('pr-corp-repo.json', {number: 7, title: 'Fixture enterprise change', url: CORP_URL, statusCheckRollup: [run('build', 'COMPLETED', 'SUCCESS')]});
  const reservation = net.createServer();reservation.listen(0, '127.0.0.1');await once(reservation, 'listening');
  port = reservation.address().port;await new Promise(resolve => reservation.close(resolve));assert.notEqual(port, 4310);
  const base = `http://127.0.0.1:${port}/`;
  log = fs.openSync(path.join(state, 'server.log'), 'a');
  server = spawn(python, ['-m', 'agent_desk', '--port', String(port)], {cwd: root, env: fixtureEnv, stdio: ['ignore', log, log]});
  await until(async () => {if (server.exitCode !== null) throw Error(fs.readFileSync(path.join(state, 'server.log'), 'utf8'));try {return (await fetch(base + 'config.js')).ok;} catch {return false;}}, 'Browser fixture server did not start');
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 900}});
  // The chip opens GitHub in a new tab; answer it locally.
  await context.route('https://github.com/**', route => route.fulfill({contentType: 'text/html', body: '<title>fixture pull request</title>'}));
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const capture = path.join(state, 'input');
  const ids = await page.evaluate(async ({repos, argv}) => {
    const ids = {};
    for (const [key, cwd] of Object.entries(repos)) ids[key] = (await terminalRequest('/api/terminals/launch', {cwd, argv: key === 'pr' ? argv : ['/bin/sh'], name: key + ' fixture'})).id;
    await refresh();for (const id of Object.values(ids)) selectPane(id, true);selectPane(ids.pr, true);return ids;
  }, {repos, argv: [python, path.join(root, 'tests/fixtures/desktop/input.py'), capture]});
  const pane = page.locator(`[data-pane-id="${ids.pr}"]`), chip = pane.locator('.pane-pr');
  await chip.waitFor();
  await until(async () => (await chip.getAttribute('data-checks')) === 'pending', 'Pending checks were not shown');
  const header = () => page.evaluate(id => {const n = document.querySelector(`[data-pane-id="${id}"]`), c = n.querySelector('.pane-pr'), bar = n.querySelector('.terminal-bar').getBoundingClientRect(), box = c?.getBoundingClientRect();
    // Every word the tab carries, shown or not: in a narrow pane some give way to the title.
    const t = n.querySelector('.pane-title');
    return {text: c && [...c.querySelectorAll('.pane-pr-link b, .pane-pr-word')].map(word => word.textContent).join(' '), shown: c?.querySelector('.pane-pr-link').innerText.replace(/\s+/g, ' ').trim(),
      fit: c?.dataset.fit, titleCut: t.scrollWidth > t.clientWidth + 1, href: c?.querySelector('a').href, target: c?.querySelector('a').target,
      label: c?.querySelector('a').getAttribute('aria-label'), log: c ? !c.querySelector('.pane-pr-log').hidden : null,
      inside: !!box && box.left >= bar.left && box.right <= bar.right && box.top >= bar.top && box.bottom <= bar.bottom, overflow: document.documentElement.scrollWidth > innerWidth};}, ids.pr);
  let seen = await header();
  check('an open pull request with running checks says Open, Pending and Awaiting review', () => {
    assert.equal(seen.text, '#42 Open Pending Awaiting review');assert.equal(seen.href, PR_URL);assert.equal(seen.target, '_blank');
    assert.match(seen.label, /Pull request #42, Open, checks pending, awaiting review/);assert.equal(seen.log, false);
  });
  const corp = page.locator(`[data-pane-id="${ids.corp}"] .pane-pr-link`);
  await until(async () => (await corp.count()) && (await corp.innerText()).replace(/\s+/g, ' ').trim() === '#7 Open Passing Awaiting review', 'The GitHub Enterprise pull request was not shown');
  const corpHref = await corp.getAttribute('href');
  check('a GitHub Enterprise remote shows its pull request too', () => assert.equal(corpHref, CORP_URL));
  await pause();await pause();
  const strays = await page.locator(`[data-pane-id="${ids.none}"] .pane-pr, [data-pane-id="${ids.plain}"] .pane-pr`).count();
  check('a folder with no pull request or no GitHub remote shows nothing', () => assert.equal(strays, 0));
  const calls = fs.readFileSync(path.join(fake, 'calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  check('a remote gh does not know is asked once, not every poll', () => {
    assert.ok(calls.filter(call => call[0].endsWith('example-repo')).length > 1);
    assert.equal(calls.filter(call => call[0].endsWith('plain-repo')).length, 1);
  });
  await page.screenshot({path: evidence('pr-chip-pending-1440.png')});
  const [tab] = await Promise.all([context.waitForEvent('page'), chip.locator('a').click()]);
  check('clicking the chip opens the pull request', () => assert.equal(tab.url(), PR_URL));
  await tab.close();

  answer('pr-example-repo.json', {statusCheckRollup: [run('lint', 'COMPLETED', 'SUCCESS'), run('unit tests', 'COMPLETED', 'FAILURE')]});
  await until(async () => (await chip.getAttribute('data-checks')) === 'failing', 'Failing checks were not shown');
  seen = await header();
  check('checks going from pending to failing show Failing and offer the log', () => {assert.equal(seen.text, '#42 Open Failing Awaiting review');assert.equal(seen.log, true);});
  await page.screenshot({path: evidence('pr-chip-failing-1440.png')});
  await page.locator('#open-inbox').click();
  const row = page.locator('.inbox-row', {hasText: 'Checks failing · #42 Add fixture retry'});
  await row.waitFor();
  const failing = {count: await row.count(), category: await row.locator('.inbox-category').innerText()};
  check('the failure is one Needs you item in the Inbox', () => assert.deepEqual(failing, {count: 1, category: 'Needs you'}));
  await row.click();
  const detail = page.locator('#inbox-detail');
  const body = await detail.innerText(), github = await detail.locator('a', {hasText: 'Open on GitHub'}).getAttribute('href');
  check('the Inbox item names the failed check and links to GitHub', () => {assert.match(body, /1 of 2 checks failed on feature\/fixture-retry[\s\S]*unit tests/);assert.equal(github, PR_URL);});
  await page.screenshot({path: evidence('pr-inbox-failing-1440.png')});
  await detail.locator('button', {hasText: 'Open session'}).click();
  await until(() => page.evaluate(id => document.querySelector('#agents-page:not(.hidden)') && selectedId === id, ids.pr), 'Open session did not select the pane');
  check('Open session goes to the terminal on that branch', () => {});

  const lines = Array.from({length: 80}, (_, i) => `unit tests\tRun tests\t2026-10-28T10:00:00.0000000Z fixture failure line ${i}`).join('\n');
  fs.writeFileSync(path.join(fake, 'log.json'), JSON.stringify({code: 0, stdout: lines}));
  await page.waitForFunction(id => paneViews.get(id)?.term?.modes.bracketedPasteMode, ids.pr);
  await chip.locator('.pane-pr-log').click();
  await until(() => fs.existsSync(capture) && fs.readFileSync(capture, 'utf8').includes('\x1b[201~'), 'The failed log was not pasted');
  const pasted = fs.readFileSync(capture, 'utf8');
  check('the opt-in log action pastes the failed log tail without pressing Enter', () => {
    assert.match(pasted, /^\x1b\[200~The CI check "unit tests" is failing on pull request #42/);
    assert.ok(pasted.includes('fixture failure line 79') && !pasted.includes('fixture failure line 19') && !pasted.includes('2026-10-28T'));
    assert.ok(pasted.endsWith('\x1b[201~'), 'nothing is submitted for the user');
  });

  answer('pr-example-repo.json', {isDraft: true, reviewDecision: 'APPROVED', statusCheckRollup: [run('lint', 'COMPLETED', 'SUCCESS'), run('unit tests', 'COMPLETED', 'SUCCESS')],
    latestReviews: [{id: 'R_fixture', author: {login: 'fixture-reviewer'}, state: 'APPROVED'}]});
  await until(async () => (await header()).text === '#42 Draft Passing Approved', 'Draft, passing and approved were not shown');
  check('a draft with passing checks and an approval says so', () => {});
  await page.locator('#open-inbox').click();
  const review = page.locator('.inbox-row', {hasText: 'fixture-reviewer approved #42'});
  await review.waitFor();
  const category = await review.locator('.inbox-category').innerText();
  check('a new review is a Ready for review item', () => assert.equal(category, 'Ready for review'));
  await review.click();
  await detail.locator('button', {hasText: 'Mark reviewed'}).click();
  await until(async () => (await page.locator('.inbox-row', {hasText: 'fixture-reviewer approved #42'}).count()) === 0, 'Mark reviewed did not move the item out of Open');
  const saved = JSON.parse(fs.readFileSync(path.join(state, 'data', `pull-requests-${port}.json`), 'utf8'));
  check('Mark reviewed is saved on the server', () => assert.deepEqual(saved.map(e => [e.kind, e.state]), [['checks', 'review'], ['review', 'done']]));

  await page.evaluate(id => selectPane(id), ids.pr);
  answer('pr-example-repo.json', {statusCheckRollup: [run('unit tests', 'COMPLETED', 'FAILURE')], reviewDecision: 'CHANGES_REQUESTED'});
  await until(async () => (await header()).text === '#42 Open Failing Changes requested', 'Changes requested was not shown');
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({width, height});await pause();
    seen = await header();
    check(`the chip sits inside the pane header at ${width}px`, () => {assert.ok(seen.inside);assert.equal(seen.overflow, false);});
    if (width === 1440) check('in a half-width pane the tab drops words rather than cut the title', () => {assert.equal(seen.titleCut, false);assert.notEqual(seen.fit, '0');assert.equal(seen.shown, '#42 Open Failing');});
    await page.screenshot({path: evidence(`pr-chip-changes-${width}.png`)});
  }
  await page.setViewportSize({width: 1440, height: 900});
  await page.evaluate(id => toggleFullscreen(id), ids.pr);
  await until(async () => (await header()).fit === '0', 'A full-screen pane did not get every word back');
  seen = await header();
  check('a full-screen pane shows every word', () => assert.equal(seen.shown, '#42 Open Failing Changes requested'));
  await page.evaluate(id => toggleFullscreen(id), ids.pr);
  answer('pr-example-repo.json', {state: 'MERGED', statusCheckRollup: [run('unit tests', 'COMPLETED', 'FAILURE')]});
  await until(async () => (await header()).text === '#42 Merged', 'Merged was not shown');
  const merged = await chip.getAttribute('data-state');
  check('a merged pull request drops its checks', () => assert.equal(merged, 'merged'));
  answer('pr-example-repo.json', null, 4, 'To get started with GitHub CLI, please run:  gh auth login');
  await until(async () => (await pane.locator('.pane-pr').count()) === 0, 'A signed-out gh left the chip up');
  const headerState = await pane.locator('.pane-state').textContent();
  check('a signed-out gh clears the chip without an error in the header', () => assert.equal(headerState, ''));
  check('no page errors', () => assert.deepEqual(errors, []));
  console.log(`PASS: ${results.length} pull request checks`);
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (browser) await browser.close();
  if (server?.exitCode === null) {const stopped = once(server, 'exit');server.kill('SIGINT');await stopped;}
  if (port) {
    const cleanup = spawnSync(python, ['-c', "from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()", path.join(state, 'data'), String(port)], {cwd: root, env: fixtureEnv, encoding: 'utf8', timeout: 15000});
    if (cleanup.status !== 0) console.error('Fixture cleanup:', cleanup.stderr);
  }
  if (log !== undefined) fs.closeSync(log);
  console.log('Browser fixture:', state);
});
