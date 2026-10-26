'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
async function signApp(appPath, appleSigning) {
  const identity = appleSigning ? process.env.APPLE_SIGNING_IDENTITY : '-';
  if (!identity) throw Error('Apple signing requires APPLE_SIGNING_IDENTITY');
  const runtime = path.join(appPath, 'Contents/Resources/runtime');
  const manifestPath = path.join(runtime, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [relative,target] of Object.entries(manifest.links || {})) {
    const file=path.join(runtime,relative);
    const destination=path.resolve(path.dirname(file),target);
    if (path.isAbsolute(target) || !destination.startsWith(runtime+path.sep) || !fs.lstatSync(file).isSymbolicLink()) throw Error('Unsafe packaged runtime symlink');
    fs.unlinkSync(file);fs.symlinkSync(target,file);
  }
  const entitlement = path.resolve(__dirname, '../resources/runtime-entitlements.plist');
  for (const relative of Object.keys(manifest.files)) {
    const file = path.join(runtime, relative);
    const fd = fs.openSync(file, 'r');const header = Buffer.alloc(4);
    try {fs.readSync(fd, header, 0, 4, 0);} finally {fs.closeSync(fd);}
    if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(header.toString('hex'))) {
      const args = ['--force', '--sign', identity];
      if(appleSigning)args.push('--options','runtime');
      if (relative.includes('/bin/')) args.push('--entitlements', entitlement);
      if (appleSigning) args.push('--timestamp');
      execFileSync('/usr/bin/codesign', [...args, file], {stdio: 'pipe', timeout: 30000});
    }
    manifest.files[relative] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const {sign} = await import('@electron/osx-sign');
  await sign({app: appPath, platform: 'darwin', identity, identityValidation: appleSigning,
    preAutoEntitlements: false, ignore: file => file.startsWith(runtime + path.sep),
    optionsForFile: () => ({hardenedRuntime: appleSigning})});
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', appPath], {stdio: 'pipe', timeout: 30000});
  // App signing must not alter pre-signed runtimes after their hashes are sealed.
  const {verifyRuntime} = require('../src/runtime.cjs');verifyRuntime(runtime, manifest);
  if (appleSigning) {
    const zip = appPath + '.notarize.zip';
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', appPath, zip], {stdio: 'inherit'});
    execFileSync('/usr/bin/xcrun', ['notarytool', 'submit', zip, '--keychain-profile', process.env.APPLE_NOTARY_PROFILE || 'agent-desk-notary', '--wait'], {stdio: 'inherit'});
    execFileSync('/usr/bin/xcrun', ['stapler', 'staple', appPath], {stdio: 'inherit'});
  }
}
module.exports = {signApp};
if (require.main === module) signApp(path.resolve(process.argv[2]), process.env.AGENT_DESK_APPLE_SIGNING === '1').catch(error => {console.error(error.message);process.exitCode=1;});
