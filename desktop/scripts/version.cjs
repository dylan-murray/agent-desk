'use strict';
const fs = require('node:fs');
const path = require('node:path');

const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const repositoryRoot = path.resolve(__dirname, '../..');

function projectVersion(root = repositoryRoot) {
  // Read the controlled [project] version assignment without a Node TOML dependency.
  const text = fs.readFileSync(path.join(root, 'pyproject.toml'), 'utf8');
  const project = text.split(/^\[project\]\s*(?:#.*)?$/m)[1]?.split(/^\[/m)[0];
  const version = project?.match(/^version\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/m)?.[1];
  if (!versionPattern.test(version || '')) throw Error('Project version must be MAJOR.MINOR.PATCH in pyproject.toml');
  return version;
}

function releaseTag(root = repositoryRoot, env = process.env) {
  if (env.GITHUB_EVENT_NAME !== 'push' || !env.GITHUB_REF?.startsWith('refs/tags/desktop-')) return null;
  const tag = env.GITHUB_REF.slice('refs/tags/'.length);
  const version = tag.slice('desktop-'.length);
  if (!versionPattern.test(version)) throw Error('Desktop release tag must be desktop-MAJOR.MINOR.PATCH (without v)');
  if (version !== projectVersion(root)) throw Error('Desktop release tag must match the version in pyproject.toml');
  return tag;
}

module.exports = {projectVersion, releaseTag, versionPattern};
