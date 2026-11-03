'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

function releaseRepository(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-release-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const root = path.join(directory, 'source');
  fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  git('init', '-qb', 'main');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  fs.copyFileSync(path.resolve(__dirname, '../../../.gitignore'), path.join(root, '.gitignore'));
  const project = version => `[build-system]\nrequires = []\n[project]\nname = "agent-desk"\nversion = "${version}"\n[tool.fixture]\nversion = "9.9.9"\n`;
  fs.writeFileSync(path.join(root, 'pyproject.toml'), project('0.1.0'));
  fs.writeFileSync(path.join(root, 'source.txt'), 'original');
  git('add', '.');
  git('commit', '-qm', 'Fixture source');
  const env = {GITHUB_EVENT_NAME: 'push', GITHUB_REF: 'refs/heads/main',
    GITHUB_EVENT_PATH: path.join(directory, 'event.json')};
  function push(version) {
    const before = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(root, 'pyproject.toml'), project(version));
    git('add', '.');
    git('commit', '--allow-empty', '-qm', 'Fixture push');
    env.GITHUB_SHA = git('rev-parse', 'HEAD');
    fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify({before, after: env.GITHUB_SHA}));
    return env;
  }
  return {directory, root, git, env, push};
}

module.exports = {releaseRepository};
