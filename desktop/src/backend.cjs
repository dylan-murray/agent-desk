'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const {spawn, execFile, execFileSync} = require('node:child_process');
const {ORIGIN, MAX_BODY} = require('./security.cjs');
const {openBootstrapLog} = require('./logs.cjs');
const PROTOCOL = 1;
function privateDirectory(folder) {
  fs.mkdirSync(folder, {recursive: true, mode: 0o700});
  const info = fs.lstatSync(folder);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Workspace directory must be private: ' + folder);
  return folder;
}
function privateJSON(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Error('Unsafe connection record');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally {fs.closeSync(fd);}
}
function atomicJSON(file, value) {
  const temp = file + '.' + crypto.randomUUID() + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value), {mode: 0o600, flag: 'wx'});
  fs.renameSync(temp, file);
}
function cleanEnvironment(original) {
  const env = {...original};
  for (const key of Object.keys(env)) if (/^(?:PYTHON|DYLD_|LD_PRELOAD|NODE_OPTIONS$|NODE_PATH$|ELECTRON_RUN_AS_NODE$|AGENT_DESK_)/.test(key)) delete env[key];
  return env;
}
class Backend {
  constructor({dataDir, logDir, source, python, node, sourceIdentity, env = process.env}) {
    this.dataDir = fs.realpathSync(privateDirectory(path.resolve(dataDir)));
    this.source = source;this.python = python;this.node = node;this.originalEnv = env;
    this.sourceIdentity = sourceIdentity;
    this.logDir = path.resolve(logDir || path.join(this.dataDir, '..', 'logs'));
    const identityFile = path.join(this.dataDir, 'desktop-profile.json');
    if (!fs.existsSync(identityFile)) atomicJSON(identityFile, {workspace: crypto.randomBytes(16).toString('hex')});
    this.workspace = privateJSON(identityFile).workspace;
    if (!/^[a-f0-9]{32}$/.test(this.workspace)) throw Error('Invalid desktop workspace identity');
    const root = env.AGENT_DESK_SOCKET_ROOT || path.join(os.homedir(), '.agent-desk');
    privateDirectory(root);privateDirectory(path.join(root, 'run'));
    const identity = crypto.createHash('sha256').update(this.dataDir + ':' + this.workspace).digest('hex').slice(0, 20);
    this.folder = privateDirectory(path.join(root, 'run', identity));
    this.socket = path.join(this.folder, 'backend.sock');
    if (Buffer.byteLength(this.socket) >= 100) throw Error('Home path is too long for a desktop socket');
    this.recordPath = path.join(this.folder, 'connection.json');
    this.generation = 0;
  }
  loadRecord() {
    let record;
    try {record = privateJSON(this.recordPath);}
    catch (error) {if (error.code !== 'ENOENT') error.retryable = false;throw error;}
    if (!record || record.protocol !== PROTOCOL || record.workspace !== this.workspace || record.socket !== this.socket ||
        !Number.isSafeInteger(record.pid) || record.pid <= 1 || typeof record.user_token !== 'string' || record.user_token.length < 32) throw Object.assign(Error('Incompatible desktop connection record; do not replace its owner'), {retryable: false});
    const info = fs.lstatSync(this.socket);
    if (!info.isSocket() || info.uid !== process.getuid() || (info.mode & 0o077)) throw Object.assign(Error('Unsafe backend socket'), {retryable: false});
    this.record = record;
  }
  async request(spec) {
    if (!this.record) this.loadRecord();
    const record = this.record;
    return new Promise((resolve, reject) => {
      const headers = {...spec.headers, Host: 'app', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-origin', 'X-Agent-Desk-Terminal': record.user_token};
      if (spec.body != null) headers['Content-Length'] = Buffer.byteLength(spec.body);
      const req = http.request({socketPath: this.socket, path: spec.path, method: spec.method || 'GET', headers, timeout: spec.timeout || 45000}, res => {
        const chunks = [];let bytes = 0;
        res.on('data', chunk => {bytes += chunk.length;if (bytes > 16 * MAX_BODY) {req.destroy(Error('Backend response too large'));return;}chunks.push(chunk);});
        res.on('end', () => resolve({status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64')}));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(Object.assign(Error('Backend request timed out'), {code: 'ETIMEDOUT'})));
      req.on('error', reject);
      req.end(spec.body == null ? undefined : spec.body);
    });
  }
  async status() {
    const result = await this.request({path: '/api/desktop/status', timeout: 5000});
    if (result.status !== 200) throw Object.assign(Error('Backend status unavailable'), {retryable: result.status >= 500});
    let value;
    try {value = JSON.parse(Buffer.from(result.body, 'base64'));}
    catch (error) {throw Object.assign(error, {retryable: false});}
    if (!value || value.protocol !== PROTOCOL || value.workspace !== this.workspace || value.pid !== this.record.pid) throw Object.assign(Error('Backend identity changed'), {retryable: false});
    return value;
  }
  async start(cancelled = () => false) {
    if (this.sourceIdentity && require('./runtime.cjs').sourceIdentity(this.source) !== this.sourceIdentity) {
      throw Object.assign(Error('Source code changed. Finish Stop Work and Quit, then restart Agent Desk Dev.'), {retryable: false});
    }
    try {this.loadRecord();return await this.status();} catch (error) {
      if (error.retryable === false) throw error;
      if (this.record) {
        try {process.kill(this.record.pid, 0);throw Object.assign(Error('A previous backend is alive but unreachable. Retry connection or shutdown; no duplicate was started.'), {retryable: true});}
        catch (probe) {if (probe.code !== 'ESRCH') throw probe;}
      } else if (fs.existsSync(this.recordPath)) {
        // An invalid or incompatible record is not proof of a dead owner.
        throw error;
      }
    }
    // A slow first launch may not have written its connection record yet.
    if (this.child?.pid && this.child.exitCode === null && this.child.signalCode === null) {
      try {process.kill(this.child.pid, 0);throw Object.assign(Error('Backend is still starting; no duplicate was started.'), {retryable: true});}
      catch (error) {if (error.code !== 'ESRCH') throw error;}
    }
    const env = cleanEnvironment(this.originalEnv);
    let shellPath = '';
    try {shellPath = (await require('node:util').promisify(execFile)('/bin/zsh', ['-lic', 'command printf "\\036%s\\037" "$PATH"'], {env, timeout: 5000, maxBuffer: 1024 * 1024, encoding: 'utf8'})).stdout.match(/\x1e([^\x1f]*)\x1f/)?.[1] || '';} catch { /* bounded fallback */ }
    if (cancelled()) throw Error('Startup cancelled');
    env.PATH = [path.dirname(this.node), path.dirname(this.python), shellPath || env.PATH || '/usr/bin:/bin', '/opt/homebrew/bin', path.join(os.homedir(), '.local/bin')].join(path.delimiter);
    env.PYTHONDONTWRITEBYTECODE = '1';
    env.AGENT_DESK_DATA_DIR = this.dataDir;env.AGENT_DESK_WORKSPACE_ID = this.workspace;
    env.AGENT_DESK_LOG_DIR = privateDirectory(this.logDir);
    if (this.originalEnv.AGENT_DESK_SOCKET_ROOT) env.AGENT_DESK_SOCKET_ROOT = this.originalEnv.AGENT_DESK_SOCKET_ROOT;
    if (this.originalEnv.AGENT_DESK_TOOL_ROOTS) env.AGENT_DESK_TOOL_ROOTS = this.originalEnv.AGENT_DESK_TOOL_ROOTS;
    // Never include environment variables or connection credentials in logs.
    const log = openBootstrapLog(this.logDir);
    let spawnError;
    try {
      this.child = spawn(this.python, ['-s', '-m', 'agent_desk.desktop_backend', '--workspace-id', this.workspace, '--production'], {cwd: this.source, env, detached: true, stdio: ['ignore', log, log]});
      this.child.on('error', error => {spawnError = error;});this.child.unref();
    } finally {fs.closeSync(log);}
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (spawnError) throw Object.assign(spawnError, {retryable: false});
      if (this.child.exitCode != null || this.child.signalCode != null) throw Error('Backend exited during startup. Open local diagnostics.');
      try {this.record = null;this.loadRecord();return await this.status();} catch {await new Promise(resolve => setTimeout(resolve, 150));}
    }
    throw Object.assign(Error('Backend did not become ready. A surviving owner was not replaced. Open local diagnostics.'), {retryable: true});
  }
  async shutdown() {
    const result = await this.request({path: '/api/desktop/shutdown', method: 'POST', body: '{}', headers: {'Content-Type': 'application/json'}, timeout: 60000});
    const response = JSON.parse(Buffer.from(result.body, 'base64'));
    if (!response.stopped) throw Error('Shutdown incomplete: ' + (response.failed || []).map(item => item.id + ': ' + item.error).join('; '));
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      try {process.kill(this.record.pid, 0);} catch (error) {if (error.code === 'ESRCH') return;throw error;}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const record = this.record;
    const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], {encoding: 'utf8'}).trim();
    const birth = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], {encoding: 'utf8'}).trim();
    if (!record.process_start || birth !== record.process_start || !command.includes('-m agent_desk.desktop_backend --workspace-id ' + this.workspace)) throw Error('Backend ownership could not be verified; shutdown remains paused.');
    process.kill(record.pid, 'SIGKILL');
    const forcedDeadline = Date.now() + 3000;
    while (Date.now() < forcedDeadline) {
      try {process.kill(record.pid, 0);} catch (error) {if (error.code === 'ESRCH') return;throw error;}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw Error('Backend has not exited; shutdown remains paused.');
  }
  async resume() {
    const response=await this.request({path:'/api/desktop/resume',method:'POST',body:'{}'});
    if(response.status!==200)throw Error(JSON.parse(Buffer.from(response.body,'base64')).error || 'Scheduling remains paused');
    return response;
  }
}
module.exports = {Backend, privateDirectory, privateJSON, atomicJSON, cleanEnvironment, PROTOCOL};
