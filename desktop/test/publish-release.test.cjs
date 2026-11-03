'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {publishRelease} = require('../scripts/publish-release.cjs');
const {releaseRepository} = require('./fixtures/release.cjs');

function fixture(t, repository = 'fixture/agent-desk') {
  const {directory, root, push, git} = releaseRepository(t);
  const image = path.join(directory, 'Agent-Desk-arm64.dmg');
  const checksum = `${image}.sha256`;
  fs.writeFileSync(image, 'Fictional tested DMG');
  const digest = createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  fs.writeFileSync(checksum, `${digest}  ${path.basename(image)}\n`);
  const tag = '0.2.0';
  const env = {...push(tag),
    GITHUB_REPOSITORY: repository, GH_REPO: repository, GH_TOKEN: 'fixture-token'};
  const state = {release: null, reference: null, assets: {}, calls: [], fail: null};
  function gh(args) {
    state.calls.push(args);
    if (args[0] === 'api') {
      if (args[1] === '--paginate') {
        assert.equal(args.at(-1), `repos/${repository}/releases?per_page=100`);
        // Include an unrelated release and put the matching draft on another page.
        return JSON.stringify([[{tag_name: 'unrelated', draft: false}], state.release ? [state.release] : []]);
      }
      if (args[1] === `repos/${repository}/git/matching-refs/tags/${tag}`) {
        return JSON.stringify([{ref: `refs/tags/${tag}-other`, object: {type: 'commit', sha: 'unrelated'}},
          ...(state.reference ? [state.reference] : [])]);
      }
      if (args[1] === `repos/${repository}/git/tags/annotated-fixture`) {
        return JSON.stringify({object: {type: 'commit', sha: env.GITHUB_SHA}});
      }
      assert.deepEqual(args, ['api', '--method', 'POST', `repos/${repository}/git/refs`,
        '-f', `ref=refs/tags/${tag}`, '-f', `sha=${env.GITHUB_SHA}`]);
      if (state.fail === 'tag') throw Error('Tag creation failed');
      assert.equal(state.reference, null);
      state.reference = {ref: `refs/tags/${tag}`, object: {type: 'commit', sha: env.GITHUB_SHA}};
      return JSON.stringify(state.reference);
    }
    assert.equal(args[2], tag);
    assert.equal(args[args.indexOf('--repo') + 1], repository);
    const operation = args[1];
    if (operation === 'create') {
      assert.ok(args.includes('--draft'));
      assert.ok(args.includes('--verify-tag'));
      assert.ok(args.includes('--generate-notes'));
      assert.equal(args[args.indexOf('--title') + 1], tag);
      assert.match(args[args.indexOf('--notes') + 1], /SHA-256 checksum/);
      assert.ok(state.reference);
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
  return {directory, root, env, gh, state, image, checksum, tag, git, push};
}

test('creates a version tag on the tested commit, generates draft release notes, uploads and publishes', t => {
  for (const repository of ['upstream/agent-desk', 'fork/renamed-repository']) {
    const f = fixture(t, repository);
    assert.match(publishRelease(f), /Published 0.2.0/);
    assert.equal(f.state.release.draft, false);
    assert.equal(f.state.reference.object.sha, f.env.GITHUB_SHA);
    assert.deepEqual(f.state.calls.map(args => args[1]), ['--paginate',
      `repos/${repository}/git/matching-refs/tags/0.2.0`, '--method', 'create', 'upload', 'edit']);
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

test('pull requests, manual runs, feature branches and tag pushes cannot publish', t => {
  for (const [event, ref] of [['pull_request', 'refs/heads/main'],
    ['workflow_dispatch', 'refs/heads/main'], ['push', 'refs/heads/desktop-feature'],
    ['push', 'refs/tags/0.2.0']]) {
    const f = fixture(t);
    f.env.GITHUB_EVENT_NAME = event;
    f.env.GITHUB_REF = ref;
    assert.throws(() => publishRelease(f), /requires a project version bump pushed to main/);
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

test('unchanged, malformed or decreased release versions cannot reach GitHub', t => {
  for (const version of ['0.2.0', '0.1.9', '0.02.0', 'v0.3.0', 'desktop-0.3.0', '0.3.0-extra']) {
    const f = fixture(t);
    Object.assign(f.env, f.push(version));
    assert.throws(() => publishRelease(f), /version bump|must increase|MAJOR.MINOR.PATCH/);
    assert.deepEqual(f.state.calls, []);
  }
});

test('an existing lightweight or annotated tag on the tested commit is reused on retry', t => {
  for (const type of ['commit', 'tag']) {
    const f = fixture(t);
    f.state.reference = {ref: `refs/tags/${f.tag}`, object: {
      type, sha: type === 'commit' ? f.env.GITHUB_SHA : 'annotated-fixture'}};
    publishRelease(f);
    assert.equal(f.state.release.draft, false);
    assert.equal(f.state.calls.some(args => args.includes('POST')), false);
  }
});

test('tag conflicts and tag creation failures prevent release changes', t => {
  const conflict = fixture(t);
  conflict.state.reference = {ref: `refs/tags/${conflict.tag}`, object: {type: 'commit', sha: 'another-commit'}};
  assert.throws(() => publishRelease(conflict), /refusing to move/);
  assert.equal(conflict.state.release, null);
  assert.equal(conflict.state.calls.some(args => args[0] === 'release'), false);
  const failed = fixture(t);
  failed.state.fail = 'tag';
  assert.throws(() => publishRelease(failed), /Tag creation failed/);
  assert.equal(failed.state.release, null);
});
