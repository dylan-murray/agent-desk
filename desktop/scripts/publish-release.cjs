'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {releaseTag} = require('./version.cjs');

const imageName = 'Agent-Desk-arm64.dmg';

function publishRelease({directory, root = path.resolve(__dirname, '../..'), env = process.env, gh = args => execFileSync('gh', args, {encoding: 'utf8', env})}) {
  const tag = releaseTag(root, env);
  if (!tag) {
    throw Error('Publishing requires a project version bump pushed to main');
  }
  const repository = env.GH_REPO;
  if (!repository || repository !== env.GITHUB_REPOSITORY || !env.GH_TOKEN) {
    throw Error('Publishing requires the current repository and GITHUB_TOKEN');
  }
  const image = path.resolve(directory, imageName);
  const checksum = `${image}.sha256`;
  const digest = createHash('sha256').update(fs.readFileSync(image)).digest('hex');
  if (fs.readFileSync(checksum, 'utf8') !== `${digest}  ${imageName}\n`) {
    throw Error('DMG checksum mismatch; refusing to publish');
  }

  // The release-by-tag REST endpoint only promises published releases. Listing
  // with the write token also finds interrupted drafts, including older pages.
  const releases = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]))
    .flat().filter(release => release.tag_name === tag);
  if (releases.some(release => release.draft === false)) {
    return `Release ${tag} is already published; assets left unchanged.`;
  }
  const reference = `refs/tags/${tag}`;
  const refs = JSON.parse(gh(['api', `repos/${repository}/git/matching-refs/tags/${tag}`]));
  const existing = refs.find(ref => ref.ref === reference);
  if (existing) {
    let object = existing.object;
    while (object.type === 'tag') {
      object = JSON.parse(gh(['api', `repos/${repository}/git/tags/${object.sha}`])).object;
    }
    if (object.type !== 'commit' || object.sha !== env.GITHUB_SHA) {
      throw Error('Release tag must point to the tested commit; refusing to move it');
    }
  } else {
    gh(['api', '--method', 'POST', `repos/${repository}/git/refs`, '-f', `ref=${reference}`, '-f', `sha=${env.GITHUB_SHA}`]);
  }
  if (releases.length === 0) {
    gh(['release', 'create', tag, '--repo', repository, '--verify-tag', '--draft', '--title', tag, '--generate-notes',
      '--notes', 'Agent Desk for Apple Silicon, macOS 14+. Ad-hoc signed; not Developer ID signed or notarized. Verify the download with the attached SHA-256 checksum.']);
  }
  // Replace both files on retry so a partial draft cannot publish a previous
  // build's image with this build's checksum. Published assets are skipped.
  gh(['release', 'upload', tag, image, checksum, '--repo', repository, '--clobber']);
  gh(['release', 'edit', tag, '--repo', repository, '--verify-tag', '--draft=false']);
  return `Published ${tag} with the tested DMG and SHA-256 checksum.`;
}

if (require.main === module) {
  try {
    console.log(publishRelease({directory: process.argv[2] || 'release-assets'}));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {publishRelease};
