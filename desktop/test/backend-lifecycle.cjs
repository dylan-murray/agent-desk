'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {Backend}=require('../src/backend.cjs');
const base=fs.mkdtempSync('/private/tmp/ad-backend-exit-');
const backend=new Backend({dataDir:path.join(base,'data'),source:path.resolve(__dirname,'../..'),
  python:execFileSync('/usr/bin/which',['python3'],{encoding:'utf8'}).trim(),node:process.execPath,
  env:{...process.env,AGENT_DESK_SOCKET_ROOT:path.join(base,'s')}});
(async()=>{
  await backend.start();
  const request=backend.request.bind(backend),pid=backend.record.pid;
  backend.request=async spec=>{
    const response=await request(spec);
    if(spec.path==='/api/desktop/shutdown'&&response.status===200)process.kill(pid,'SIGSTOP');
    return response;
  };
  await backend.shutdown();
  assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');
  backend.request=request;
  await backend.start();assert.notEqual(backend.record.pid,pid);
  assert.equal((await backend.status()).paused,false);
  await backend.shutdown();
  console.log('PASS: shutdown force-stops a verified resistant backend after managed cleanup; a fresh start preserves clean shutdown state.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(backend.record)try{process.kill(backend.record.pid,'SIGCONT');}catch{}
  try{await backend.shutdown();}catch{}
});
