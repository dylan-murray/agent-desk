'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repositoryRoot = path.resolve(__dirname, '../..');

function parseProjectVersion(text) {
  // Read the controlled [project] version assignment without a Node TOML dependency.
  const project = text.split(/^\[project\]\s*(?:#.*)?$/m)[1]?.split(/^\[/m)[0];
  const version = project?.match(/^version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  if (!versionPattern.test(version || '')) throw Error('Project version must be MAJOR.MINOR.PATCH in pyproject.toml');
  return version;
}

function projectVersion(root = repositoryRoot) {
  return parseProjectVersion(fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8'));
}

function releaseTag(root = repositoryRoot, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') return null;
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  if (!/^[a-f0-9]{40}$/.test(event.before || '') || !/^[a-f0-9]{40}$/.test(event.after || '') || event.after !== env.GITHUB_SHA) {
    throw Error('Desktop releases require the original push commit range');
  }
  // A newly created branch has no previous project version to compare.
  if (/^0+$/.test(event.before)) return null;
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
  if (git(['rev-parse', 'HEAD']) !== event.after) throw Error('Desktop release must build the pushed commit');
  const version = projectVersion(root);
  const previous = parseProjectVersion(git(['show', `${event.before}:pyproject.toml`]));
  if (version === previous) return null;
  const currentParts = version.split('.').map(BigInt);
  const previousParts = previous.split('.').map(BigInt);
  const changed = currentParts.findIndex((part, index) => part !== previousParts[index]);
  if (currentParts[changed] < previousParts[changed]) throw Error('Project version must increase for a desktop release');
  return version;
}

if (require.main === module) {
  try {
    const tag = releaseTag();
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag || ''}\n`);
    console.log(tag ? `Desktop release: ${tag}` : 'No desktop version bump; validation only.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {projectVersion, releaseTag, versionPattern};
