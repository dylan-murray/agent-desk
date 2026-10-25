// Prove the real Chromium/custom-protocol boundary before sharing native fetch.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {_electron}=require('../../node_modules/playwright');
const base=fs.mkdtempSync('/private/tmp/ad-http-');
let electron;
(async()=>{
  electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(__dirname,'fixtures/transport.cjs')],env:{...process.env,AGENT_DESK_TRANSPORT_FIXTURE:base}});
  const page=await electron.firstWindow();
  await page.waitForFunction(()=>window.AGENT_DESK_CONFIG?.accounts[0].id==='fixture');
  const result=await page.evaluate(async()=>{
    const results=[];
    for(const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']){
      const r=await fetch('/api/echo?q=a%20b&n=2',{method,headers:{'X-Application':'fixture','X-Agent-Desk-Terminal':'forged','Authorization':'Bearer application-header'},...(!['GET','HEAD'].includes(method)?{body:'body-'+method}:{})});
      results.push({method,status:r.status,header:r.headers.get('x-fixture'),value:method==='HEAD'?null:await r.json()});
    }
    const bodies=[['application/json',JSON.stringify({note:'✓'})],['application/x-www-form-urlencoded',new URLSearchParams({q:'a b',note:'✓'})],['application/octet-stream',new Uint8Array([0,255,128,1])]];
    for(const [type,body] of bodies){const r=await fetch('/api/echo',{method:'POST',headers:{'Content-Type':type},body});results.push({type,value:await r.json()});}
    const form=new FormData();form.append('note','fixture');form.append('file',new Blob([new Uint8Array([0,255])]),'fixture.bin');
    results.push({form:await(await fetch('/api/echo',{method:'POST',body:form})).json()});
    for(const status of [204,400,401,404,409,422,500,503]){const r=await fetch('/api/echo?status='+status);results.push({status:r.status,ok:r.ok,body:await r.text()});}
    return results;
  });
  for(const row of result){
    if(row.method){assert.equal(row.status,200);assert.equal(row.header,'response');if(row.value){assert.equal(row.value.method,row.method);assert.equal(row.value.url,'/api/echo?q=a%20b&n=2');assert.equal(row.value.headers['x-application'],'fixture');assert.equal(row.value.headers['x-agent-desk-terminal'],'main-process-secret');assert.equal(row.value.headers.authorization,'Bearer application-header');assert.equal(row.value.headers['x-agent-desk-app-bridge'],undefined);assert.equal(Buffer.from(row.value.body,'base64').toString(),row.method==='GET'?'':'body-'+row.method);}}
    if(row.type){assert.equal(row.value.headers['content-type'],row.type);assert.deepEqual(Buffer.from(row.value.body,'base64'),row.type==='application/octet-stream'?Buffer.from([0,255,128,1]):Buffer.from(row.type==='application/json'?JSON.stringify({note:'✓'}):new URLSearchParams({q:'a b',note:'✓'}).toString()));}
    if(row.form){assert.match(row.form.headers['content-type'],/^multipart\/form-data; boundary=/);assert.ok(Buffer.from(row.form.body,'base64').includes(Buffer.from([0,255])));}
    if('ok' in row)assert.equal(row.ok,row.status===204);
  }
  assert.equal(await page.evaluate(async()=>{const r=await fetch('/api/redirect?to='+encodeURIComponent('/api/echo?q=redirect'));return(await r.json()).url;}),'/api/echo?q=redirect');
  assert.equal(await page.evaluate(async()=> (await fetch('/api/redirect?to=https://example.com/')).status),403);
  await page.evaluate(async()=>{
    const controller=new AbortController();const pending=fetch('/api/slow?id=abort',{signal:controller.signal});setTimeout(()=>controller.abort(),100);try{await pending;throw Error('No abort');}catch(e){if(e.name!=='AbortError')throw e;}
    const start=Date.now(),response=await fetch('/api/stream?id=reader'),reader=response.body.getReader();
    const first=await reader.read();if(new TextDecoder().decode(first.value)!=='first\n'||Date.now()-start>1000)throw Error('Buffered stream');await reader.cancel();
    const stream=await fetch('/api/stream?id=complete');if(await stream.text()!=='first\nlast\n')throw Error('Incomplete stream');
  });
  await page.waitForFunction(async()=>{const ids=await(await fetch('/api/cancelled')).json();return ids.includes('abort')&&ids.includes('reader');});
  const frame=page.frames().find(frame=>frame.url().startsWith('agent-tool:'));
  assert.equal(await frame.evaluate(()=>typeof window.agentDeskDesktop),'undefined');
  const before=await electron.evaluate(()=>global.transportRequests.length);
  for(const target of ['/api/echo','/config.js','/api/desktop/status']){
    const allowed=await frame.evaluate(async target=>{try{await fetch('agent-desk://app'+target,{headers:{'X-Agent-Desk-App-Bridge':'forged'}});return true;}catch{return false;}},target);
    assert.equal(allowed,false);
  }
  await frame.evaluate(async()=>{
    try {await fetch('agent-desk://app/api/echo',{method:'POST',mode:'no-cors',body:'must-not-mutate',headers:{Origin:'agent-desk://app','X-Agent-Desk-App-Bridge':'forged'}});} catch {}
    try {return window.top.agentDeskDesktop;} catch {return null;}
  });
  assert.equal(await electron.evaluate(()=>global.transportRequests.length),before,'Tool requests must be stopped before reaching the application, including opaque no-cors mutations');
  // A registered URL alone gives an unrelated window no authority.
  const rogue=await electron.evaluate(async({BrowserWindow})=>{const win=new BrowserWindow({show:false});await win.loadURL('agent-desk://app/');return win.id;});
  assert.equal(await electron.evaluate(async({BrowserWindow},id)=>BrowserWindow.fromId(id).webContents.executeJavaScript("fetch('/api/echo').then(()=>true,()=>false)"),rogue),false);
  assert.equal(await electron.evaluate(()=>global.transportRequests.length),before,'An unregistered window must never reach the application socket');
  console.log('PASS: native fetch methods, JSON/form/binary bodies, headers, statuses, config, redirects, streaming, cancellation and frame/window isolation.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(electron)await electron.close();console.log('Fixture:',base);});
