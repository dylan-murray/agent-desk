'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {publishRelease} = require('../scripts/publish-release.cjs');

function fixture(t, repository = 'fixture/agent-desk') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-release-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = directory;
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = \"agent-desk\"\nversion = \"0.1.0\"\n');
  const image = path.join(directory, 'Agent-Desk-arm64.dmg');
  const checksum = `${image}.sha256`;
  fs.writeFileSync(image, 'Fictional tested DMG');
  const digest = createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  fs.writeFileSync(checksum, `${digest}  ${path.basename(image)}\n`);
  const tag = 'desktop-0.1.0';
  const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REF: `refs/tags/${tag}`,
    GITHUB_REPOSITORY: repository, GH_REPO: repository, GH_TOKEN: 'fixture-token'};
  const state = {release: null, assets: {}, calls: [], fail: null};
  function gh(args) {
    state.calls.push(args);
    if (args[0] === 'api') {
      assert.equal(args.at(-1), `repos/${repository}/releases?per_page=100`);
      // Include an unrelated release and put the matching draft on another page.
      return JSON.stringify([[{tag_name: 'unrelated', draft: false}], state.release ? [state.release] : []]);
    }
    assert.equal(args[2], tag);
    assert.equal(args[args.indexOf('--repo') + 1], repository);
    const operation = args[1];
    if (operation === 'create') {
      assert.ok(args.includes('--draft'));
      assert.ok(args.includes('--verify-tag'));
      assert.equal(state.release, null);
      state.release = {tag_name: tag, draft: true};
    } else if (operation === 'upload') {
      assert.equal(state.release.draft, true);
      assert.ok(args.includes('--clobber'));
      state.assets[image] = fs.readFileSync(args[3], 'utf8');
      // Simulate a process/network failure after only the DMG was attached.
      if (state.fail === operation) throw Error('Interrupted upload');
      state.assets[checksum] = fs.readFileSync(args[4], 'utf8');
    } else if (operation === 'edit') {
      if (state.fail === operation) throw Error('Interrupted publication');
      assert.ok(args.includes('--draft=false'));
      assert.ok(args.includes('--verify-tag'));
      assert.equal(Object.keys(state.assets).length, 2);
      state.release.draft = false;
    } else {
      assert.fail(`Unexpected gh operation: ${operation}`);
    }
    return '';
  }
  return {directory, root, env, gh, state, image, checksum, tag};
}

test('creates a draft, uploads the tested pair, then publishes in the current repository or fork', t => {
  for (const repository of ['upstream/agent-desk', 'fork/renamed-repository']) {
    const f = fixture(t, repository);
    assert.match(publishRelease(f), /Published desktop-0.1.0/);
    assert.equal(f.state.release.draft, false);
    assert.deepEqual(f.state.calls.map(args => args[1]), ['--paginate', 'create', 'upload', 'edit']);
  }
});

test('an interrupted upload leaves a draft; retry replaces both assets before publishing', t => {
  const f = fixture(t);
  f.state.fail = 'upload';
  assert.throws(() => publishRelease(f), /Interrupted upload/);
  assert.equal(f.state.release.draft, true);
  assert.equal(Object.keys(f.state.assets).length, 1);
  f.state.assets[f.image] = 'previous partial build';
  f.state.fail = null;
  publishRelease(f);
  assert.equal(f.state.release.draft, false);
  assert.equal(f.state.assets[f.image], fs.readFileSync(f.image, 'utf8'));
  assert.equal(f.state.assets[f.checksum], fs.readFileSync(f.checksum, 'utf8'));
  assert.equal(f.state.calls.filter(args => args[1] === 'create').length, 1);
});

test('an interrupted publish can be retried; published release assets are then left unchanged', t => {
  const f = fixture(t);
  f.state.fail = 'edit';
  assert.throws(() => publishRelease(f), /Interrupted publication/);
  assert.equal(f.state.release.draft, true);
  f.state.fail = null;
  publishRelease(f);
  const assets = {...f.state.assets};
  f.state.calls.length = 0;
  assert.match(publishRelease(f), /already published/);
  assert.equal(f.state.calls.length, 1);
  assert.deepEqual(f.state.assets, assets);
});

test('mismatched DMG bytes or checksum stop publication before any GitHub calls', t => {
  for (const target of ['image', 'checksum']) {
    const f = fixture(t);
    fs.appendFileSync(f[target], 'tampered');
    assert.throws(() => publishRelease(f), /checksum mismatch/);
    assert.deepEqual(f.state.calls, []);
  }
});

test('pull requests, manual runs, branch pushes and other tags cannot publish', t => {
  for (const [event, ref] of [['pull_request', 'refs/tags/desktop-0.1.0'],
    ['workflow_dispatch', 'refs/tags/desktop-0.1.0'], ['push', 'refs/heads/desktop-feature'],
    ['push', 'refs/tags/v1.0.0']]) {
    const f = fixture(t);
    f.env.GITHUB_EVENT_NAME = event;
    f.env.GITHUB_REF = ref;
    assert.throws(() => publishRelease(f), /requires a desktop-\* tag push/);
    assert.deepEqual(f.state.calls, []);
  }
});

test('missing token, wrong repository and API failures cannot mutate releases', t => {
  for (const [field, value] of [['GH_TOKEN', ''], ['GH_REPO', ''], ['GH_REPO', 'other/repository']]) {
    const f = fixture(t);
    f.env[field] = value;
    assert.throws(() => publishRelease(f), /requires the current repository and GITHUB_TOKEN/);
    assert.deepEqual(f.state.calls, []);
  }
  const f = fixture(t);
  assert.throws(() => publishRelease({...f, gh: () => {throw Error('API unavailable');}}), /API unavailable/);
  assert.equal(f.state.release, null);
});

test('malformed or mismatched release versions cannot reach GitHub', t => {
  for (const tag of ['desktop-v0.1.0', 'desktop-2026-10-24', 'desktop-0.01.0', 'desktop-0.1.0-extra', 'desktop-0.2.0']) {
    const f = fixture(t);
    f.env.GITHUB_REF = `refs/tags/${tag}`;
    assert.throws(() => publishRelease(f), /Desktop release tag must/);
    assert.deepEqual(f.state.calls, []);
  }
});
