'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = path.join(root, 'out/Agent Desk-darwin-arm64/Agent Desk.app');
if (!fs.existsSync(source)) throw Error('Package the arm64 app before creating the DMG');
const staging = fs.mkdtempSync(path.join(root, '.build/dmg-'));
fs.cpSync(source, path.join(staging, 'Agent Desk.app'), {recursive: true, dereference: false, verbatimSymlinks: true});
fs.symlinkSync('/Applications', path.join(staging, 'Applications'));
const output = path.join(root, 'out/make/Agent-Desk-arm64.dmg');
fs.mkdirSync(path.dirname(output), {recursive: true});
execFileSync('/usr/bin/hdiutil', ['create', '-volname', 'Agent Desk', '-srcfolder', staging, '-format', 'UDZO', '-ov', output], {stdio: 'inherit'});
if (process.env.AGENT_DESK_APPLE_SIGNING === '1') {
  if (!process.env.APPLE_SIGNING_IDENTITY) throw Error('Missing signing identity');
  execFileSync('/usr/bin/codesign', ['--sign', process.env.APPLE_SIGNING_IDENTITY, '--timestamp', output], {stdio: 'inherit'});
  execFileSync('/usr/bin/xcrun', ['notarytool', 'submit', output, '--keychain-profile', process.env.APPLE_NOTARY_PROFILE || 'agent-desk-notary', '--wait'], {stdio: 'inherit'});
  execFileSync('/usr/bin/xcrun', ['stapler', 'staple', output], {stdio: 'inherit'});
  execFileSync('/usr/bin/hdiutil', ['verify', output], {stdio: 'inherit'});
}
console.log(output);
