'use strict';
// Exercise the actual signed bundle without debugging flags or host runtimes.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const {Backend}=require('../src/backend.cjs');
const {profilePaths}=require('../src/profile.cjs');
const {aboutOptions}=require('../src/about.cjs');
const base=fs.mkdtempSync('/private/tmp/ad-pkg-');
const profile=profilePaths(base,{},true).root;
const data=path.join(profile,'data');fs.mkdirSync(data,{recursive:true,mode:0o700});
const bundle=path.resolve(process.argv[2] || path.join(__dirname,'../out/Agent Desk-darwin-arm64/Agent Desk.app'));
const executable=path.join(bundle,'Contents/MacOS/Agent Desk');
const env={...process.env,PATH:'/usr/bin:/bin:/usr/sbin:/sbin',AGENT_DESK_PROFILE_DIR:profile,AGENT_DESK_SOCKET_ROOT:path.join(base,'s')};
for(const key of ['ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','PYTHONPATH','PYTHONHOME','AGENT_DESK_DESKTOP_TEST','AGENT_DESK_TEST_DATA_DIR','AGENT_DESK_DATA_DIR','AGENT_DESK_PYTHON','AGENT_DESK_NODE'])delete env[key];
const backend=new Backend({dataDir:data,env,source:'unused',python:'unused',node:'unused'});
const log=fs.openSync(path.join(base,'shell.log'),'a',0o600);
let child,debugChild,debugBackend;
function metrics() {return JSON.parse(fs.readFileSync(path.join(profile,'logs/startup-times.json'),'utf8'));}
function report(label) {const value=metrics();console.log(label,JSON.stringify(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='launchedAt').map(([key,time])=>[key.replace('At','Ms'),time-value.launchedAt]))));return value;}
async function stopShell() {if(!child || child.exitCode!=null)return;child.kill('SIGTERM');await new Promise(resolve=>{const timer=setTimeout(()=>{child.kill('SIGKILL');resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});});}

async function until(fn,timeout=45000){const deadline=Date.now()+timeout;while(Date.now()<deadline){if(await fn())return;await new Promise(r=>setTimeout(r,150));}throw Error('Packaged app readiness timed out');}
async function api(route,payload){const response=await backend.request({path:route,method:payload?'POST':'GET',body:payload?JSON.stringify(payload):undefined,headers:{'Content-Type':'application/json'}});const value=JSON.parse(Buffer.from(response.body,'base64'));assert.equal(response.status,200,JSON.stringify(value));return value;}
(async()=>{
  const resources=path.join(bundle,'Contents/Resources');
  const info=JSON.parse(fs.readFileSync(path.join(resources,'build-info.json'),'utf8'));
  const display=aboutOptions(info);
  assert.equal(display.applicationVersion,info.version);
  assert.ok(display.copyright.includes(info.commit));
  const packagedJSON=JSON.parse(require('@electron/asar').extractFile(path.join(resources,'app.asar'),'package.json'));
  assert.equal(packagedJSON.version,info.version);
  assert.equal(spawnSync('/usr/libexec/PlistBuddy',['-c','Print :CFBundleShortVersionString',path.join(bundle,'Contents/Info.plist')],{encoding:'utf8'}).stdout.trim(),packagedJSON.version);
  assert.equal(display.copyright.startsWith('Development build'), info.releaseTag === null);
  const bundledVersion=spawnSync(path.join(resources,'runtime/python/bin/python3'),['-I','-B','-c',
    'import sys; sys.path.insert(0, sys.argv[1]); import agent_desk; print(agent_desk.__version__)',path.join(resources,'runtime/app')],{env,encoding:'utf8'});
  assert.equal(bundledVersion.status,0,bundledVersion.stderr);
  assert.equal(bundledVersion.stdout.trim(),info.version);
  console.log('Packaged About metadata:',display);
  child=spawn(executable,[],{env,stdio:['ignore',log,log]});
  await until(async()=>{if(child.exitCode!=null||child.signalCode)throw Error('App exited with '+(child.signalCode||child.exitCode));try{backend.loadRecord();await backend.status();return true;}catch{return false;}});
  assert.equal(backend.record.runtime,path.join(profile,'runtime/app'));
  for(const folder of ['data','browser','runtime','logs']) assert.ok(fs.statSync(path.join(profile,folder)).isDirectory());
  assert.ok(fs.existsSync(path.join(data,'desktop-profile.json')));
  assert.equal(fs.existsSync(path.join(profile,'desktop-profile.json')),false,'Backend state stays inside data/');
  assert.ok(fs.existsSync(path.join(profile,'logs/desktop-bootstrap.log')));
  assert.equal(fs.existsSync(path.join(data,'desktop-backend.log')),false,'Desktop diagnostics stay outside data/');
  assert.ok(fs.existsSync(path.join(backend.record.runtime,'agent_desk/desktop_backend.py')));
  await until(()=>{try{return !!metrics().workspaceReadyAt;}catch{return false;}});
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(profile,'logs/build-info.json'),'utf8')),info);
  const first=report('First installation');
  const original=backend.record.pid;
  // Exercise both default profile names under a disposable appData namespace.
  const debugProfile=profilePaths(base,{},false).root;
  const debugEnv={...process.env,AGENT_DESK_PROFILE_DIR:debugProfile,AGENT_DESK_SOCKET_ROOT:path.join(base,'s'),AGENT_DESK_DESKTOP_TEST:'1'};
  debugBackend=new Backend({dataDir:path.join(debugProfile,'data'),source:'unused',python:'unused',node:'unused',env:debugEnv});
  debugChild=spawn(require('../node_modules/electron'),[path.resolve(__dirname,'..')],{env:debugEnv,stdio:['ignore',log,log]});
  await until(async()=>{try{debugBackend.loadRecord();await debugBackend.status();return true;}catch{return false;}});
  assert.notEqual(debugBackend.workspace,backend.workspace);assert.notEqual(debugBackend.socket,backend.socket);
  assert.notEqual(debugBackend.record.pid,original);
  await debugBackend.shutdown();debugChild.kill('SIGKILL');
  assert.equal((await backend.status()).pid,original,'Packaged app keeps running when debug app quits');
  const second=spawn(executable,[],{env,stdio:['ignore',log,log]});
  await until(()=>second.exitCode!=null,15000);assert.equal(second.exitCode,0);assert.equal((await backend.status()).pid,original);assert.equal(metrics().launchedAt,first.launchedAt);
  await backend.shutdown();
  await stopShell();
  child=spawn(executable,[],{env,stdio:['ignore',log,log]});
  await until(()=>{try{const value=metrics();return value.launchedAt>first.launchedAt && !!value.workspaceReadyAt;}catch{return false;}});
  report('Retained-runtime cold launch');
  backend.record=null;backend.loadRecord();
  assert.equal((await backend.status()).paused,false,'Clean shutdown reopens with launches enabled');
  assert.equal(fs.existsSync(path.join(data,'desktop-shutdown.json')),false);
  const terminal=await api('/api/terminals/launch',{cwd:base,argv:['/bin/sh'],name:'Packaged fixture'});
  await api('/api/terminals/input',{id:terminal.id,data:Buffer.from('echo packaged-terminal-ok\n').toString('base64')});
  await until(async()=>Buffer.from((await api('/api/terminals/output?id='+terminal.id+'&cursor=0')).data,'base64').toString().includes('packaged-terminal-ok'));
  const pairs=spawnSync('/bin/ps',['-axo','pid=,ppid='],{encoding:'utf8'}).stdout.trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number));
  const owned=new Set([child.pid]);let changed=true;while(changed){changed=false;for(const [pid,parent] of pairs)if(owned.has(parent)&&!owned.has(pid)){owned.add(pid);changed=true;}}
  const listeners=spawnSync('/usr/sbin/lsof',['-nP','-a','-p',[...owned].join(','),'-iTCP','-sTCP:LISTEN'],{encoding:'utf8'});
  assert.equal(listeners.status,1,listeners.stdout||listeners.stderr);assert.equal(listeners.stdout.trim(),'');
  await backend.shutdown();
  console.log('PASS: signed packaged app, bundled Python/Node, independent debug profile, second launch reuse, fixture terminal, no TCP listeners, confirmed shutdown.');
})().catch(error=>{console.error(error);console.error('Fixture diagnostics:',base);process.exitCode=1;}).finally(async()=>{
  try{await backend.shutdown();}catch{}
  if(debugBackend)try{await debugBackend.shutdown();}catch{}
  if(debugChild?.exitCode==null)debugChild?.kill('SIGKILL');
  await stopShell();
  fs.closeSync(log);
});
