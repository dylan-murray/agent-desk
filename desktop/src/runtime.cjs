'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFileSync} = require('node:child_process');
const {privateDirectory, privateJSON, atomicJSON} = require('./backend.cjs');
const {profilePaths, workspaceChoice} = require('./profile.cjs');
function digest(file) {return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function verifyRuntime(folder, manifest) {
  const root = fs.realpathSync(folder);
  for (const [relative, hash] of Object.entries(manifest.files)) {
    if (path.isAbsolute(relative) || relative.split('/').includes('..') || !/^[a-f0-9]{64}$/.test(hash)) throw Error('Invalid runtime manifest');
    const file = path.join(root, relative), actual = fs.realpathSync(file);
    if (!actual.startsWith(root + path.sep) || digest(file) !== hash) throw Error('Runtime integrity check failed: ' + relative);
  }
  // Reject injected Python modules as well as modifications to known files.
  function walk(current) {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const file = path.join(current, entry.name), relative = path.relative(root, file).split(path.sep).join('/');
      if (entry.isDirectory()) walk(file);
      else if (entry.isSymbolicLink()) {
        if (!Object.hasOwn(manifest.links || {}, relative) || fs.readlinkSync(file) !== manifest.links[relative] || !fs.realpathSync(file).startsWith(root + path.sep)) throw Error('Runtime symlink escapes package');
      } else if (relative !== 'manifest.json' && !Object.hasOwn(manifest.files, relative)) throw Error('Unexpected runtime file: ' + relative);
    }
  }
  walk(root);
}
// Live managed processes for this profile: its backend, terminal supervisor,
// tool servers and workflow workers. Zombies and stopped records do not count.
function managedProcesses(profile) {
  const pids = new Set();
  function record(file) {
    try {const item = privateJSON(file);if (!item.stopped && Number.isSafeInteger(item.pid)) pids.add(item.pid);}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  for (const name of fs.readdirSync(profile.data)) {
    if (name.startsWith('.terminal-owner-') && name.endsWith('.json')) record(path.join(profile.data, name));
  }
  const tools = path.join(profile.data, 'tool-runtime');
  if (fs.existsSync(tools)) for (const name of fs.readdirSync(tools)) if (name.endsWith('.json')) record(path.join(tools, name));
  let workspace;
  try {workspace = privateJSON(path.join(profile.data, 'desktop-profile.json')).workspace;} catch (error) {if (error.code !== 'ENOENT') throw error;}
  // The backend passes the resolved data path to its children (/tmp is /private/tmp).
  const folders = [...new Set([profile.data, fs.realpathSync(profile.data)])];
  const processes = execFileSync('/bin/ps', ['-axo', 'pid=,stat=,command='], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  const found = [];
  for (const line of processes.trim().split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    if (!match || match[2].startsWith('Z')) continue;
    const pid = Number(match[1]), command = match[3];
    const backend = !!workspace && command.includes('agent_desk.desktop_backend --workspace-id ' + workspace);
    if (backend || pids.has(pid) || folders.some(folder => command.includes(folder)) && /agent_desk\.terminal_supervisor|workflow_worker\.py|serve_skill_ui\.py/.test(command)) found.push({pid, backend});
  }
  return found;
}
function requireStopped(profile) {
  // A backend that owns a browser workspace runs from this runtime too.
  const {data} = workspaceChoice(profile);
  const [running] = [...managedProcesses(profile), ...data !== profile.data && fs.existsSync(data) ? managedProcesses({...profile, data}) : []];
  if (running) throw Object.assign(Error('Finish Stop Work and Quit in the previous app before updating or restarting changed code. Managed processes are still running (PID ' + running.pid + ').'), {retryable: false});
}
function stageRuntime(bundled, profile, manifest, progress = () => {}) {
  const target = profile.runtime;
  if (fs.existsSync(target)) {
    try {verifyRuntime(target, manifest);return target;} catch { /* replace only after full shutdown */ }
  }
  requireStopped(profile);
  progress('setup');
  const temporary = fs.mkdtempSync(path.join(profile.root, '.runtime-stage-'));
  let previous;
  try {
    fs.cpSync(bundled, temporary, {recursive: true, dereference: false, verbatimSymlinks: true});
    verifyRuntime(temporary, manifest);
    requireStopped(profile);
    if (fs.existsSync(target)) {previous = path.join(profile.root, '.runtime-previous-' + crypto.randomUUID());fs.renameSync(target, previous);}
    try {fs.renameSync(temporary, target);} catch (error) {if (previous) fs.renameSync(previous, target);throw error;}
  } finally {fs.rmSync(temporary, {recursive: true, force: true});}
  if (previous) fs.rmSync(previous, {recursive: true, force: true});
  return target;
}
async function runtime(app, progress = () => {}) {
  const profile = profilePaths(app.getPath('appData'), process.env, app.isPackaged);
  privateDirectory(profile.root);privateDirectory(profile.data);
  const stamp = path.join(profile.data, 'desktop-runtime.json');
  let previous;
  try {previous = privateJSON(stamp);} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (!app.isPackaged) {
    // Source runs follow the browser contract: static files load fresh on reload,
    // a restarted backend attaches to the surviving supervisor, and supervisor
    // code changes need Stop Work and Quit. Packaged runtimes keep the guards below.
    const source = path.resolve(__dirname, '../..');
    const node = process.env.AGENT_DESK_NODE || execFileSync('/usr/bin/which', ['node'], {encoding: 'utf8'}).trim();
    const python = process.env.AGENT_DESK_PYTHON || execFileSync('/usr/bin/which', ['python3'], {encoding: 'utf8'}).trim();
    return {source, python, node, development: true};
  }
  const bundled = path.join(app.resourcesPath || process.resourcesPath, 'runtime');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundled, 'manifest.json'), 'utf8'));
  // The source manifest is a sealed resource of the signed .app. Verify the app
  // before trusting it, then compare every retained runtime to that manifest.
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app.getAppPath().split('/Contents/')[0]], {stdio: 'pipe', timeout: 30000});
  // Shell-only changes also require full shutdown, even when their backend
  // payload and release version are identical to the previous package.
  const identity = crypto.createHash('sha256').update(JSON.stringify(manifest)).update(require('original-fs').readFileSync(app.getAppPath())).digest('hex');
  if (previous?.identity !== identity) requireStopped(profile);
  const target = stageRuntime(bundled, profile, manifest, progress);
  atomicJSON(stamp, {identity});
  return {source: path.join(target, 'app'), python: path.join(target, 'python/bin/python3'), node: path.join(target, 'node/bin/node')};
}
module.exports = {runtime, verifyRuntime, stageRuntime, requireStopped, managedProcesses};

// Hashing, copying and signature verification never block Electron's UI thread.
function prepareRuntime(app, progress) {
  const {Worker} = require('node:worker_threads');
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'runtime-worker.cjs'), {workerData: {
      packaged: app.isPackaged, appPath: app.getAppPath(), appData: app.getPath('appData'), resourcesPath: process.resourcesPath,
    }});
    const timeout = setTimeout(() => {void worker.terminate();reject(Error('Runtime preparation timed out'));}, 120000);
    worker.on('message', message => {if (message.stage) progress(message.stage);else {clearTimeout(timeout);message.error ? reject(Error(message.error)) : resolve(message.result);}});
    worker.on('error', error => {clearTimeout(timeout);reject(error);});
    worker.on('exit', code => {clearTimeout(timeout);if (code) reject(Error('Runtime preparation stopped'));});
  });
}
module.exports.prepareRuntime = prepareRuntime;
