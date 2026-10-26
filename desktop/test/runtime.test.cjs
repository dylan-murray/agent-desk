'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {createProfile} = require('../src/profile.cjs');
const {stageRuntime, requireStopped, runtime, managedProcesses} = require('../src/runtime.cjs');
const {atomicJSON} = require('../src/backend.cjs');

test('stable runtime replacement preserves data and legacy hashed runtimes and refuses a live owner', t => {
  const root = fs.mkdtempSync('/private/tmp/ad-runtime-update-');
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const profile = createProfile(root, {AGENT_DESK_PROFILE_DIR:path.join(root,'profile')}, true);
  const bundled = path.join(root,'bundle');fs.mkdirSync(bundled);
  const saved = path.join(profile.data,'saved.txt');fs.writeFileSync(saved,'preserve');
  const legacy = path.join(profile.root,'runtimes/old-hash');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'old'),'preserve');
  const manifest = text => ({files:{code:crypto.createHash('sha256').update(text).digest('hex')}});
  fs.writeFileSync(path.join(bundled,'code'),'first');
  assert.equal(stageRuntime(bundled,profile,manifest('first')),profile.runtime);
  const owner = path.join(profile.data,'.terminal-owner-fixture.json');atomicJSON(owner,{pid:process.pid});
  assert.throws(()=>requireStopped(profile),/Stop Work and Quit/);
  // An unchanged build remains usable for crash recovery with a live supervisor.
  assert.equal(stageRuntime(bundled,profile,manifest('first')),profile.runtime);
  fs.writeFileSync(path.join(bundled,'code'),'second');
  assert.throws(()=>stageRuntime(bundled,profile,manifest('second')),/Stop Work and Quit/);
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'first');
  fs.unlinkSync(owner);
  stageRuntime(bundled,profile,manifest('second'));
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'second');
  assert.equal(fs.readFileSync(saved,'utf8'),'preserve');
  assert.equal(fs.readFileSync(path.join(legacy,'old'),'utf8'),'preserve');
  fs.writeFileSync(path.join(bundled,'code'),'corrupt');
  assert.throws(()=>stageRuntime(bundled,profile,manifest('third')),/integrity/);
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'second');
});

test('source runs reconnect to retained work after code edits, as browser mode does', async t => {
  const root = fs.mkdtempSync('/private/tmp/ad-source-update-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // A temporary appData namespace exercises the actual default development path.
  const profile = createProfile(root, {});
  const app = {isPackaged:false,getPath:()=>root};
  const original = process.env.AGENT_DESK_PROFILE_DIR;delete process.env.AGENT_DESK_PROFILE_DIR;
  t.after(()=>{if(original===undefined)delete process.env.AGENT_DESK_PROFILE_DIR;else process.env.AGENT_DESK_PROFILE_DIR=original;});
  const owner = path.join(profile.data,'.terminal-owner-fixture.json');atomicJSON(owner,{pid:process.pid});
  atomicJSON(path.join(profile.data,'desktop-runtime.json'),{identity:'previous-source'});
  const resolved = await runtime(app);
  assert.equal(resolved.development,true);
  assert.equal(resolved.source,path.resolve(__dirname,'../..'));
  assert.ok(fs.existsSync(owner),'surviving owners are kept for the restarted backend');
});

test('managed process discovery separates a live backend from surviving owners', async t => {
  const root = fs.mkdtempSync('/private/tmp/ad-managed-');
  const children = [];
  t.after(()=>{for(const child of children)child.kill('SIGKILL');fs.rmSync(root,{recursive:true,force:true});});
  const profile = createProfile(root, {AGENT_DESK_PROFILE_DIR:path.join(root,'profile')}, true);
  const workspace = 'a'.repeat(32);atomicJSON(path.join(profile.data,'desktop-profile.json'),{workspace});
  assert.deepEqual(managedProcesses(profile),[]);
  assert.doesNotThrow(()=>requireStopped(profile));
  // Stopped and dead records are not running work.
  atomicJSON(path.join(profile.data,'.terminal-owner-stopped.json'),{pid:process.pid,stopped:true});
  assert.deepEqual(managedProcesses(profile),[]);
  const {spawn} = require('node:child_process');
  const started = args => {const child = spawn(process.execPath,['-e','setTimeout(()=>{},60000)','--',...args],{stdio:'ignore'});children.push(child);return child;};
  // A supervisor started with the resolved data path is found from the profile path.
  const supervisor = started(['-m','agent_desk.terminal_supervisor','--data-dir',fs.realpathSync(profile.data)]);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(managedProcesses(profile),[{pid:supervisor.pid,backend:false}]);
  assert.throws(()=>requireStopped(profile),/Stop Work and Quit/);
  const backend = started(['-m agent_desk.desktop_backend --workspace-id '+workspace]);
  await new Promise(resolve=>setTimeout(resolve,200));
  assert.deepEqual(managedProcesses(profile).sort((a,b)=>a.pid-b.pid),[{pid:supervisor.pid,backend:false},{pid:backend.pid,backend:true}].sort((a,b)=>a.pid-b.pid));
});
