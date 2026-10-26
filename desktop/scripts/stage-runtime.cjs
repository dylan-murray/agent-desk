'use strict';
// Runtime downloads happen at build time only. Artifacts and their SHA256 values
// are pinned in runtime-lock.json; the app never downloads executable code.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const https = require('node:https');
const root = path.resolve(__dirname, '../..'), desktop = path.join(root, 'desktop');
const build = path.join(desktop, '.build');
function hash(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function download(url, file, redirects = 0) {
  if (redirects > 5 || !url.startsWith('https://')) throw Error('Invalid artifact redirect');
  return new Promise((resolve, reject) => https.get(url, response => {
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {response.resume();download(new URL(response.headers.location, url).href, file, redirects + 1).then(resolve, reject);return;}
    if (response.statusCode !== 200) {response.resume();reject(Error('Artifact HTTP ' + response.statusCode));return;}
    const output = fs.createWriteStream(file, {flags: 'wx'});response.pipe(output);
    response.on('error', reject);output.on('error', reject);output.on('finish', () => output.close(resolve));
  }).on('error', reject));
}
async function main() {
  const lock = JSON.parse(fs.readFileSync(path.join(desktop, 'runtime-lock.json'), 'utf8'));
  fs.mkdirSync(build, {recursive: true});
  const staging = fs.mkdtempSync(path.join(build, 'runtime-stage-'));
  for (const name of ['python', 'node']) {
    const artifact = lock[name];
    if (!/^[a-f0-9]{64}$/.test(artifact.sha256)) throw Error('Runtime checksum must be pinned');
    const archive = path.join(build, name + '-' + artifact.sha256 + '.tar.gz');
    if (!fs.existsSync(archive)) {
      const pending = archive + '.part-' + process.pid;
      await download(artifact.url, pending);
      if (hash(pending) !== artifact.sha256) throw Error('Downloaded runtime checksum mismatch');
      fs.renameSync(pending, archive);
    }
    if (hash(archive) !== artifact.sha256) throw Error('Cached runtime checksum mismatch');
    // Reject unsafe archive paths before extracting trusted, checksum-pinned artifacts.
    const entries = execFileSync('/usr/bin/tar', ['-tzf', archive], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}).trim().split('\n');
    if (entries.some(entry => path.isAbsolute(entry) || entry.split('/').includes('..'))) throw Error('Unsafe runtime archive');
    const target = path.join(staging, name);fs.mkdirSync(target);
    execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', target, '--strip-components', '1']);
  }
  const source = path.join(staging, 'app');fs.mkdirSync(source);
  for (const folder of ['agent_desk', 'scripts']) {
    fs.cpSync(path.join(root, folder), path.join(source, folder), {recursive: true, filter: file => {
      const rel = path.relative(path.join(root, folder), file);
      if (rel.split(path.sep).some(part => part.startsWith('.') || part === '__pycache__')) return false;
      if (fs.statSync(file).isDirectory()) return true;
      if (folder === 'scripts') return file.endsWith('.py') && !['restart_backend.py', 'checkpoint_live_workers.py'].includes(path.basename(file)) || file.endsWith('.cjs') && ['worker_prompt.cjs','worker_screen.cjs','native_terminal_screen.cjs'].includes(path.basename(file));
      return /\.(?:py|js|css|html|svg|woff2?|txt)$/.test(file) || /LICENSE/.test(file) || rel.startsWith('bin' + path.sep);
    }});
  }
  // Source imports in the bundled backend use the same project version as wheels.
  fs.copyFileSync(path.join(root, 'pyproject.toml'), path.join(source, 'pyproject.toml'));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(staging, 'LICENSE'));
  const manifest = {version: 1, platform: 'darwin', arch: 'arm64', artifacts: lock, files: {}, links: {}};
  function walk(folder) {
    for (const entry of fs.readdirSync(folder, {withFileTypes: true})) {
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink()) manifest.links[path.relative(staging, file).split(path.sep).join('/')] = fs.readlinkSync(file);
      else manifest.files[path.relative(staging, file).split(path.sep).join('/')] = hash(file);
    }
  }
  walk(staging);fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const destination = path.join(build, 'runtime');
  // Build artifacts only; never touch an installed runtime or user state.
  if (fs.existsSync(destination)) fs.renameSync(destination, destination + '.previous-' + Date.now());
  fs.renameSync(staging, destination);
  console.log('Staged verified arm64 Python, Node, and application assets.');
}
main().catch(error => {console.error(error.message);process.exitCode = 1;});
