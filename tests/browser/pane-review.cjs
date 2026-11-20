// Real backend, real PTY, the bundled code review; the agent is tests/fixtures/fake_agent_prompt.py.
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
const root = path.resolve(__dirname, '../..'), state = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-browser-review-'));
const python = process.env.AGENT_DESK_TEST_PYTHON || 'python3';
// A stand-in gh: the branch has no pull request until pr.json exists, and the pull request has one review comment.
const fakeBin = path.join(state, 'bin');fs.mkdirSync(fakeBin);
fs.writeFileSync(path.join(fakeBin, 'gh'), '#!/bin/sh\ndir=$(dirname "$0")\ncase "$1 $2" in\n  "pr view") [ -f "$dir/pr.json" ] && exec cat "$dir/pr.json"; echo "no pull requests found" >&2; exit 1;;\n  "api --paginate") case "$4" in */pulls/7/comments) exec cat "$dir/comments.json";; *) echo "[[]]";; esac;;\n  *) exit 1;;\nesac\n', {mode: 0o755});
fs.writeFileSync(path.join(fakeBin, 'comments.json'), JSON.stringify([[{id: 501, path: 'app.py', line: 2, side: 'RIGHT', body: 'f-strings read better, thanks', user: {login: 'fixture-reviewer'}, html_url: 'https://github.com/fixture/project/pull/7#discussion_r501', created_at: '2026-10-28T10:00:00Z'}]]));
// Review notes and submissions stay in the fixture, not in the reviewer's own cache.
const fixtureEnv = {...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_'))), AGENT_DESK_DATA_DIR: state,
  REVIEW_APP_HOME: path.join(state, 'review-notes'), GROUND_CONTROL_DATA_DIR: path.join(state, 'review-submissions'), REVIEW_APP_PR_POLL_SECONDS: '1', REVIEW_APP_USER: 'Fixture reviewer', PATH: fakeBin + path.delimiter + process.env.PATH};
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
  const project = fs.mkdtempSync(path.join(state, 'project-')), received = path.join(state, 'received.jsonl');
  const git = (...args) => execFileSync('git', args, {cwd: project, env: {...fixtureEnv, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'}});
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(project, 'app.py'), 'def greet(name):\n    return "hello " + name\n');
  git('add', '.');git('commit', '-q', '-m', 'Fixture');
  fs.writeFileSync(path.join(project, 'app.py'), 'def greet(name):\n    return f"hello {name}"\n\n\ndef part(name):\n    return f"bye {name}"\n');
  browser = await chromium.launch({executablePath: process.env.CHROME_PATH, headless: true});
  const page = await browser.newPage({viewport: {width: 1440, height: 900}}), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);await page.waitForLoadState('load');
  const id = await page.evaluate(async ({cwd, argv}) => {const t = await terminalRequest('/api/terminals/launch', {cwd, argv, launch_profile: 'claude', name: 'Fixture agent'});await refresh();selectPane(t.id);return t.id;},
    {cwd: project, argv: [python, path.join(root, 'tests/fixtures/fake_agent_prompt.py'), received]});
  await page.waitForFunction(id => paneViews.get(id)?.term && !paneViews.get(id).restoring, id);
  const pane = page.locator(`[data-pane-id="${id}"]`);

  await pane.hover();await pane.locator('.pane-edit').click();
  await until(() => pane.locator('.pane-dock .pane-editor').isVisible(), 'the pane button did not open the editor in the dock');
  assert.deepEqual(await pane.locator('.pane-dock-tab').allTextContents(), ['Files', 'Editor', 'Review']);
  assert.equal(await pane.locator('.pane-dock-tab[aria-selected=true]').textContent(), 'Editor');
  await page.screenshot({path: evidence('pane-review-01-editor.png')});
  note('the pane button opens one dock with Editor and Review, on Editor');

  await pane.locator('.pane-dock-tab[data-entry="@review"]').click();
  await until(async () => (await pane.locator('.pane-dock-frame:not([hidden])').count()) === 1, 'Review did not open the code review', 300);
  const frame = await (await pane.locator('.pane-dock-frame:not([hidden])').elementHandle()).contentFrame();
  await frame.waitForSelector('text=app.py', {timeout: 15000});
  await frame.waitForFunction(() => /^Send to /.test(document.querySelector('#send')?.textContent.trim() || ''), null, {timeout: 10000});
  const agentName = (await frame.locator('#send').textContent()).trim().replace(/^Send to /, '');
  assert.equal(agentName, 'Claude', 'the send button names the coding agent, not the session');
  const header = await pane.locator('.pane-tool-toggle').count();
  assert.equal(header, 0, 'the pane\'s own review adds no tool chip to the header');
  note('Review opens the bundled code review on the pane\'s diff, addressed to this pane');

  // Each changed file is a row that opens in place; Alt-click opens or closes every file; Viewed closes it and dims it.
  const fileRow = frame.locator('section.file[data-path="app.py"]');
  const isOpen = async () => !(await fileRow.getAttribute('class')).includes('collapsed');
  assert.equal(await isOpen(), true, 'with no notes yet, the first file starts open');
  await fileRow.locator('header').click();assert.equal(await isOpen(), false);
  await fileRow.locator('header').click();assert.equal(await isOpen(), true);
  await fileRow.locator('header').click({modifiers: ['Alt']});assert.equal(await frame.locator('section.file:not(.collapsed)').count(), 0, 'Alt-click closes every file');
  await fileRow.locator('header').click({modifiers: ['Alt']});assert.equal(await frame.locator('section.file.collapsed').count(), 0, 'Alt-click again opens every file');
  await fileRow.locator('[data-viewed]').click();
  assert.equal(await isOpen(), false, 'Viewed closes the file');assert.match(await fileRow.getAttribute('class'), /\bseen\b/);
  await fileRow.locator('[data-viewed]').click();await fileRow.locator('header').click();
  assert.equal(await isOpen(), true);
  note('files open in place, Alt-click opens or closes them all, and Viewed closes and dims a file');

  // A pane's own review asks for a second opinion from inside the review, from the agents this desk has.
  assert.equal(await pane.locator('.pane-dock-review').isVisible(), false, 'the title bar has no second opinion for a pane\'s own review');
  await frame.locator('#codex').click();
  await frame.waitForSelector('#opinion-menu:not([hidden])', {timeout: 5000});
  const offered = await frame.locator('#opinion-menu button[data-reviewers]:not(.all) .who-name').allTextContents();
  assert.deepEqual([...offered].sort(), ['Claude', 'Codex', 'Grok', 'OpenCode', 'Pi']);
  assert.equal(await frame.evaluate(() => document.activeElement?.closest('#opinion-menu') !== null), true, 'opening the menu focuses its first agent');
  await page.screenshot({path: evidence('pane-review-07-second-opinion.png')});
  await frame.locator('body').press('Escape');
  assert.equal(await frame.locator('#opinion-menu').isHidden(), true);
  note('Second opinion lists every coding agent the desk has, from inside the review');

  await frame.evaluate(() => fetch('annotate', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({kind: 'line', file: 'app.py', side: 'new', start: 5, end: 6, quote: 'def part(name):', comment: 'call this farewell instead'})}));
  await frame.evaluate(() => location.reload());await frame.waitForSelector('.ct:has-text("call this farewell instead")', {timeout: 10000});
  await pause(600);
  await page.screenshot({path: evidence('pane-review-02-comment.png')});
  await frame.locator('#send').click();
  await until(() => fs.existsSync(received) && /Code review feedback/.test(fs.readFileSync(received, 'utf8')), 'the pane never got the review', 150);
  const task = JSON.parse(fs.readFileSync(received, 'utf8').trim().split('\n').pop()).task;
  const snapshot = JSON.parse(fs.readFileSync(task.match(/snapshot at (\S+\.json)/)[1], 'utf8'));
  assert.equal(snapshot.annotations.length, 1);assert.equal(snapshot.annotations[0].comment, 'call this farewell instead');
  assert.equal(snapshot.destination.session_id, id);
  await until(async () => /Queued for Claude/.test(await frame.locator('body').textContent()), 'the review did not say it was queued', 100);
  await page.screenshot({path: evidence('pane-review-03-sent.png')});
  note('Submit types the review into this pane\'s agent with the exact comment, and the review says it was queued');

  // The agent answers with the command the prompt gave it.
  const answer = task.match(/when you finish it: (.+?) --author YOUR_NAME/)[1];
  const run = extra => spawnSync('/bin/sh', ['-c', `${answer} --author Fixture --reply 1 'renamed it to farewell' --resolve 1 ${extra}`], {env: fixtureEnv, encoding: 'utf8'});
  const bare = run('');
  assert.notEqual(bare.status, 0, 'resolving without proof should be refused');assert.match(bare.stderr, /--proof/);
  const shot = evidence('pane-review-02-comment.png');
  const proved = run(`--proof 'pytest -q: 3 passed' --proof-file '${shot}'`);
  assert.equal(proved.status, 0, proved.stderr);
  await frame.locator('#tab-notes').click();
  await frame.waitForSelector('#notes .proof img', {timeout: 10000});
  assert.match(await frame.locator('#notes .proof').textContent(), /Checked by Fixture[\s\S]*pytest -q: 3 passed/);
  assert.ok(await frame.locator('#notes .proof img').evaluate(img => img.complete && img.naturalWidth > 0), 'the proof screenshot did not load');
  assert.equal((await frame.locator('#notes .note').textContent()).match(/renamed it to farewell/g).length, 1, 'the refused command posted a reply');
  await frame.locator('#notes .proof').scrollIntoViewIfNeeded();
  await page.screenshot({path: evidence('pane-review-05-proof.png')});
  note('the agent replies and resolves with the command in its prompt; resolving needs proof, and the proof shows on the note');

  git('checkout', '-q', '-b', 'feature');git('add', '.');git('commit', '-q', '-m', 'Feature');
  git('update-ref', 'refs/remotes/origin/main', 'main');
  await frame.locator('#tab-changes').click();
  fs.writeFileSync(path.join(fakeBin, 'pr.json'), JSON.stringify({url: 'https://github.com/fixture/project/pull/7', state: 'OPEN', baseRefName: 'main'}));
  await frame.waitForSelector('.ct:has-text("f-strings read better, thanks")', {timeout: 30000});
  // The PR row links the PR and says a comment came in that you haven't looked at yet.
  assert.equal(await frame.locator('#prstate a').getAttribute('href'), 'https://github.com/fixture/project/pull/7');
  await frame.waitForSelector('#prstate #newgh', {timeout: 10000});
  assert.equal((await frame.locator('#prstate #newgh').textContent()).trim(), '1 new');
  assert.match(await frame.locator('#prstate').textContent(), /1 GitHub comment/);
  assert.equal(await frame.locator('.thread-box', {hasText: 'f-strings read better'}).count(), 1, 'the GitHub comment should sit on its line in the diff');
  const ghComment = frame.locator('.thread-box', {hasText: 'f-strings read better'}).locator('.cm').first();
  assert.deepEqual(await ghComment.evaluate(c => ({name: c.querySelector('.an').textContent, avatar: c.querySelector('.av').textContent, link: c.querySelector('.gh').href, nameSize: getComputedStyle(c.querySelector('.an')).fontSize, bodySize: getComputedStyle(c.querySelector('.ct')).fontSize, bodyIsDim: getComputedStyle(c.querySelector('.ct')).color === getComputedStyle(c.querySelector('.at')).color})),
    {name: 'fixture-reviewer', avatar: 'F', link: 'https://github.com/fixture/project/pull/7#discussion_r501', nameSize: '13px', bodySize: '13px', bodyIsDim: false}, 'a comment shows who wrote it above a full-size body');
  const ghThread = frame.locator('.thread-box', {hasText: 'f-strings read better'});
  await ghThread.locator('.th').click();
  assert.equal(await ghThread.locator('.cm').first().isVisible(), false, 'clicking the thread header did not collapse it');
  assert.match(await ghThread.locator('.th .sum').textContent(), /fixture-reviewer f-strings read better/);
  assert.equal(await frame.locator('#togglethreads').getAttribute('title'), 'Expand every comment');
  await frame.locator('#togglethreads').click();
  assert.equal(await ghThread.locator('.cm').first().isVisible(), true, 'Expand every comment did not open the thread');
  note('a comment thread collapses to one line from its header, and the toolbar expands every comment');
  assert.match(await frame.locator('#meta').textContent(), /^feature · vs /);
  await frame.locator('.thread-box', {hasText: 'f-strings read better'}).scrollIntoViewIfNeeded();
  await page.screenshot({path: evidence('pane-review-06-github.png')});
  note('once the branch has a pull request, the review covers the whole branch and its GitHub comment lands on its line');
  await frame.locator('#prstate #newgh').click();
  assert.equal(await frame.locator('#tab-notes').getAttribute('aria-selected'), 'true', '"1 new" opens Notes');
  assert.equal(await frame.locator('#filters [data-filter="gh"]').getAttribute('aria-pressed'), 'true', 'filtered to GitHub');
  assert.deepEqual(await frame.locator('#notes .note').evaluateAll(cards => cards.map(card => card.textContent.includes('f-strings read better'))), [true]);
  await until(async () => (await frame.locator('#prstate #newgh').count()) === 0, 'looking at the comment should clear "new"');
  await page.screenshot({path: evidence('pane-review-08-github-notes.png')});
  await frame.locator('#tab-changes').click();
  note('"1 new" opens Notes filtered to GitHub, and looking clears it');

  await pane.locator('.pane-dock-tab[data-entry="@editor"]').click();
  assert.equal(await pane.locator('.pane-dock .pane-editor').isVisible(), true);
  assert.equal(await pane.locator('.pane-dock-frame').count(), 1, 'the review stays loaded behind the editor');
  await pane.locator('.pane-dock-tab[data-entry="@review"]').click();
  await pane.locator('.pane-dock-expand').click();
  assert.equal(await pane.locator('.pane-body').isVisible(), false);
  await pane.locator('.pane-dock-expand').click();
  assert.equal(await pane.locator('.pane-body').isVisible(), true);
  note('switching tabs keeps the review loaded; expand fills the pane and collapses back');

  await page.reload();await page.waitForLoadState('load');
  await until(async () => (await pane.locator('.pane-dock-frame:not([hidden])').count()) === 1, 'the review did not come back after a reload', 200);
  assert.equal(await pane.locator('.pane-dock-tab[aria-selected=true]').textContent(), 'Review');
  note('a reload brings the dock back on Review');

  await page.setViewportSize({width: 390, height: 844});await pause(500);
  const narrow = await page.evaluate(id => ({width: document.documentElement.scrollWidth, bottom: document.querySelector(`[data-pane-id="${id}"] .pane-main`).classList.contains('dock-bottom'), tabs: document.querySelector(`[data-pane-id="${id}"] .pane-dock-tabs`).getBoundingClientRect().width}), id);
  await page.screenshot({path: evidence('pane-review-04-narrow.png')});
  assert.equal(narrow.width, 390);assert.equal(narrow.bottom, true);assert.ok(narrow.tabs >= 52, 'the rail is squeezed out');
  note('at 390px the dock moves under the terminal with its rail showing');

  await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), id);
  assert.deepEqual(errors, []);
  console.log('PASS: pane review: one dock with Editor and Review, bundled code review on the pane\'s diff, submit reaches the pane\'s agent, proof before addressed, GitHub comments, kept loaded, expand, reload, 1440 and 390px');
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
