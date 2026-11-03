'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {releaseTag} = require('../scripts/version.cjs');
const {releaseRepository} = require('./fixtures/release.cjs');

test('patch, minor and major increases use the bare project version as the release tag', t => {
  const {root, push} = releaseRepository(t);
  for (const version of ['0.1.1', '0.2.0', '0.10.0', '1.0.0']) {
    assert.equal(releaseTag(root, push(version)), version);
  }
});

test('unchanged versions and other project metadata edits do not request a release', t => {
  const {root, push, git, env} = releaseRepository(t);
  fs.writeFileSync(path.join(root, 'source.txt'), 'next change');
  assert.equal(releaseTag(root, push('0.1.0')), null);
  const file = path.join(root, 'pyproject.toml');
  const before = env.GITHUB_SHA;
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('9.9.9', '10.0.0'));
  git('add', '.');
  git('commit', '-qm', 'Metadata only');
  env.GITHUB_SHA = git('rev-parse', 'HEAD');
  fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({before, after: env.GITHUB_SHA}));
  assert.equal(releaseTag(root, env), null);
});

test('pull requests, manual runs, tag pushes and other branches never request a release', t => {
  const {root, push} = releaseRepository(t);
  const env = push('0.2.0');
  for (const change of [{GITHUB_EVENT_NAME: 'pull_request'}, {GITHUB_EVENT_NAME: 'workflow_dispatch'},
    {GITHUB_REF: 'refs/heads/feature'}, {GITHUB_REF: 'refs/tags/0.2.0'}, {GITHUB_REF: 'refs/tags/desktop-0.2.0'}]) {
    assert.equal(releaseTag(root, {...env, ...change, GITHUB_EVENT_PATH: 'unused'}), null);
  }
});

test('a push with multiple commits compares against the version before the whole push', t => {
  const {root, push, env} = releaseRepository(t);
  push('0.2.0');
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  push('0.2.0');
  event.after = env.GITHUB_SHA;
  fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(event));
  assert.equal(releaseTag(root, env), '0.2.0');
});

test('version decreases and malformed versions fail instead of publishing', t => {
  for (const version of ['0.0.9', '0.01.1', 'v0.2.0', 'desktop-0.2.0', '0.2.0-beta']) {
    const {root, push} = releaseRepository(t);
    const env = push(version);
    assert.throws(() => releaseTag(root, env), /must increase|MAJOR.MINOR.PATCH/);
  }
});

test('missing or mismatched push commits fail; new branches have no release baseline', t => {
  const {root, push, env} = releaseRepository(t);
  push('0.2.0');
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  for (const change of [{before: ''}, {before: '--invalid'}, {after: 'f'.repeat(40)}]) {
    fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({...event, ...change}));
    assert.throws(() => releaseTag(root, env), /original push commit range/);
  }
  fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({...event, before: '0'.repeat(40)}));
  assert.equal(releaseTag(root, env), null);
});

test('version detector writes the release job output for bumps and skips unchanged versions', t => {
  const {root, directory, push} = releaseRepository(t);
  const script = path.join(root, 'desktop/scripts/version.cjs');
  fs.mkdirSync(path.dirname(script), {recursive: true});
  fs.copyFileSync(path.resolve(__dirname, '../scripts/version.cjs'), script);
  const output = path.join(directory, 'output');
  for (const [version, expected] of [['0.2.0', '0.2.0'], ['0.2.0', '']]) {
    fs.writeFileSync(output, '');
    execFileSync(process.execPath, [script], {env: {...process.env, ...push(version), GITHUB_OUTPUT: output}});
    assert.equal(fs.readFileSync(output, 'utf8'), `tag=${expected}\n`);
  }
});
