'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {Backend,atomicJSON}=require('../src/backend.cjs');

test('an unresponsive live backend is never replaced on reopen',async t=>{
  const root=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'ad-owner-'));
  const backend=new Backend({dataDir:path.join(root,'data'),source:'unused',python:'must-not-spawn',node:process.execPath,env:{AGENT_DESK_SOCKET_ROOT:path.join(root,'s')}});
  const sockets=new Set();
  const server=http.createServer(()=>{}); // accept the request without answering
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(backend.socket,resolve));fs.chmodSync(backend.socket,0o600);
  atomicJSON(backend.recordPath,{protocol:1,workspace:backend.workspace,pid:process.pid,socket:backend.socket,user_token:'fixture-token-with-at-least-32-characters'});
  t.after(async()=>{for(const socket of sockets)socket.destroy();await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});});
  await assert.rejects(()=>backend.start(),/alive but unreachable/);
  assert.equal(backend.child,undefined,'must not spawn a competing backend');
});

test('an incompatible connection record is preserved for recovery',async t=>{
  const root=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'ad-record-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const backend=new Backend({dataDir:path.join(root,'data'),source:'unused',python:'must-not-spawn',node:process.execPath,env:{AGENT_DESK_SOCKET_ROOT:path.join(root,'s')}});
  atomicJSON(backend.recordPath,{protocol:999,workspace:backend.workspace,pid:process.pid});
  await assert.rejects(()=>backend.start(),/Incompatible desktop connection/);
  backend.record={pid:process.pid};
  await assert.rejects(()=>backend.start(),error=>error.retryable===false&&/Incompatible desktop connection/.test(error.message));
  assert.equal(backend.child,undefined);
  assert.equal(JSON.parse(fs.readFileSync(backend.recordPath,'utf8')).protocol,999);
});

test('a live child without a ready connection record is not duplicated by automatic retries',async t=>{
  const root=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'ad-starting-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const backend=new Backend({dataDir:path.join(root,'data'),source:'unused',python:'must-not-spawn',node:process.execPath,env:{AGENT_DESK_SOCKET_ROOT:path.join(root,'s')}});
  backend.child={pid:process.pid,exitCode:null,signalCode:null};
  for(let i=0;i<2;i++)await assert.rejects(()=>backend.start(),error=>error.retryable===true&&/still starting/.test(error.message));
  assert.equal(backend.child.pid,process.pid);
});

test('authentication and identity failures cannot become automatic reconnects or replacement processes',async t=>{
  const root=fs.mkdtempSync(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),'ad-auth-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const backend=new Backend({dataDir:path.join(root,'data'),source:'unused',python:'must-not-spawn',node:process.execPath,env:{AGENT_DESK_SOCKET_ROOT:path.join(root,'s')}});
  backend.loadRecord=()=>{backend.record={pid:process.pid};};
  for(const response of [{status:401}, {status:200,body:Buffer.from('{"protocol":999}').toString('base64')}, {status:200,body:Buffer.from('invalid json').toString('base64')}]) {
    backend.request=async()=>response;
    await assert.rejects(()=>backend.start(),error=>error.retryable===false);
    assert.equal(backend.child,undefined);
  }
});

test('source edits cannot restart a backend under retained work',async t=>{
  const root=fs.mkdtempSync('/private/tmp/ad-source-restart-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.resolve(__dirname,'../..');
  const backend=new Backend({dataDir:path.join(root,'data'),source,sourceIdentity:'old-code',python:'must-not-spawn',node:process.execPath,env:{AGENT_DESK_SOCKET_ROOT:path.join(root,'s')}});
  await assert.rejects(()=>backend.start(),error=>error.retryable===false&&/Source code changed/.test(error.message));
  assert.equal(backend.child,undefined);
});
