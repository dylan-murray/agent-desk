// Real backend restarts, real PTY, fictional shell. Never touches the caller's server.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');
const {paneText}=require('./terminal-text.cjs');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const root=path.resolve(__dirname,'../..');
const python=process.env.AGENT_DESK_TEST_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timed out waiting for backend restart');}
(async()=>{
 const state=fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-restart-'));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a');
 let server,browser,token;
 async function boot(){
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}});
 }
 async function halt(signal){const exited=once(server,'exit');server.kill(signal);await exited;}
 async function api(route,payload){const response=await fetch(base+route,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},...(payload?{body:JSON.stringify(payload)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 try{
  await boot();
  const session=await api('api/terminals/launch',{cwd:state,argv:['/bin/sh'],name:'Restart survivor'});
  await api('api/terminals/input',{id:session.id,data:Buffer.from("printf 'before-%s\\n' restart\n").toString('base64')});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(id=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify([id])),session.id);
  await page.goto(base);
  const pane=page.locator(`[data-pane-id="${session.id}"]`),status=pane.locator('.pane-connection');
  await pane.waitFor();
  await until(async()=>/before-restart/.test(await paneText(pane)));
  await page.waitForFunction(id=>{const v=paneViews.get(id);return v&&!v.restoring&&!v.exited;},session.id);
  await pane.evaluate(node=>node.dataset.restartIdentity='same-pane');
  const beforeCursor=await page.evaluate(id=>paneViews.get(id).cursor,session.id);
  for(const [index,signal] of ['SIGINT','SIGKILL'].entries()){
   // This writes while the web server is absent; the supervisor keeps reading.
   await api('api/terminals/input',{id:session.id,data:Buffer.from(`sleep 1; printf 'offline-%s\\n' ${index}\n`).toString('base64')});
   await halt(signal);
   await until(async()=>/reconnecting/.test(await status.textContent()));
   assert.equal(await pane.getAttribute('data-restart-identity'),'same-pane');
   await boot();
   await until(async()=>/offline-/.test(await paneText(pane))&&(await status.textContent())==='');
   await until(async()=>(await paneText(pane)).includes('offline-'+index));
   assert.equal(await pane.getAttribute('data-restart-identity'),'same-pane');
   await page.waitForFunction(id=>!paneViews.get(id).restoring&&!paneViews.get(id).exited,session.id);
   await pane.locator('.xterm-helper-textarea').focus();
   await page.keyboard.type(`printf 'interactive-%s\\n' ${index}`);
   await page.keyboard.press('Enter');
   await until(async()=>(await paneText(pane)).includes('interactive-'+index));
   assert.equal((await api('api/agents')).agents.find(a=>a.id===session.id).exit_code,null);
  }
  assert.ok(await page.evaluate(({id,cursor})=>paneViews.get(id).cursor>cursor,{id:session.id,cursor:beforeCursor}));
  await page.setViewportSize({width:390,height:844});
  assert.ok(await pane.isVisible());
  await page.reload();
  await until(async()=>/interactive-1/.test(await paneText(pane)));
  assert.equal(await pane.locator('.pane-connection').textContent(),'');
  assert.deepEqual(errors,[]);
  await api('api/terminals/stop',{id:session.id});
  await until(async()=>/Session ended/.test(await status.textContent()));
  console.log('PASS: real backend SIGINT/SIGKILL, pane DOM retained, offline output replayed, refreshed auth, keyboard input resumes, same terminal identity, narrow viewport/reload, explicit Stop still ends session.');
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null&&server.signalCode===null)await halt('SIGINT');
  // Scope cleanup to this fixture's private supervisor, never any user session.
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8',timeout:15000});
  fs.closeSync(log);
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  else fs.rmSync(state,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
