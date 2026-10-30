'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {projectVersion, releaseTag} = require('./version.cjs');

function buildInfo(root, now = new Date(), env = {}) {
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024}).trim();
  const tag = releaseTag(root, env);
  const dirty = git(['status', '--porcelain=v1', '--untracked-files=normal']).length > 0;
  if (tag) {
    if (dirty) throw Error('Desktop release builds require a clean checkout');
    // The publishing job creates new tags after all build checks pass.
    if (git(['tag', '--list', tag]) && git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]) !== git(['rev-parse', 'HEAD'])) {
      throw Error('Desktop release tag must point to the checked-out commit');
    }
  }
  return {version: projectVersion(root), commit: git(['rev-parse', '--short', 'HEAD']),
    dirty, releaseTag: tag, packagedAt: now.toISOString()};
}

function writeBuildInfo(root, file, now, env = process.env) {
  const info = buildInfo(root, now, env);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(info, null, 2) + '\n');
  return info;
}

if (require.main === module) {
  try {console.log(JSON.stringify(buildInfo(path.resolve(__dirname, '../..'), new Date(), process.env)));}
  catch (error) {console.error(error.message);process.exitCode = 1;}
}

module.exports = {buildInfo, writeBuildInfo};
