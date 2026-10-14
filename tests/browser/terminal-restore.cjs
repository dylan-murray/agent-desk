// Supervisor loss (as in a reboot) restores the pane in place. Real PTY, fictional shell.
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
async function until(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(100);}throw Error('Timed out waiting for terminal restore');}
(async()=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-restore-')));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a');
 let server,browser,token;
 async function boot(){
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state,SHELL:'/bin/sh'},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}});
 }
 async function api(route,payload){const response=await fetch(base+route,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},...(payload?{body:JSON.stringify(payload)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
 try{
  await boot();
  const session=await api('api/terminals/launch',{cwd:state,argv:['/bin/sh'],name:'Restored shell'});
  await api('api/terminals/rename',{id:session.id,name:'Build shell'});
  await api('api/terminals/input',{id:session.id,data:Buffer.from("echo $$ > shell.pid; printf 'before-%s\\n' reboot\n").toString('base64')});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(id=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify([id])),session.id);
  await page.goto(base);
  const pane=page.locator(`[data-pane-id="${session.id}"]`),status=pane.locator('.pane-connection');
  await pane.waitFor();
  await until(async()=>/before-reboot/.test(await paneText(pane)));
  await page.waitForFunction(id=>{const v=paneViews.get(id);return v&&!v.restoring&&!v.exited;},session.id);
  await pane.evaluate(node=>node.dataset.restoreIdentity='same-pane');
  const shell=Number(fs.readFileSync(path.join(state,'shell.pid'),'utf8'));
  // Lose the supervisor with the backend; its terminal processes end with it.
  const owner=JSON.parse(fs.readFileSync(path.join(state,`.terminal-owner-${port}.json`),'utf8')).pid;
  process.kill(owner,'SIGKILL');
  const exited=once(server,'exit');server.kill('SIGKILL');await exited;
  await until(async()=>!alive(owner)&&!alive(shell));
  await until(async()=>/reconnecting/.test(await status.textContent()));
  await boot();
  await until(async()=>/Agent Desk restored this terminal after a restart: started a new shell in the same folder/.test(await paneText(pane)));
  await page.waitForFunction(id=>!paneViews.get(id).restoring&&!paneViews.get(id).exited,session.id);
  assert.equal(await pane.getAttribute('data-restore-identity'),'same-pane');
  // The old process's screen is reset, not mixed into the new one.
  assert.doesNotMatch(await paneText(pane),/before-reboot/);
  assert.equal(await status.textContent(),'');
  const restored=(await api('api/agents')).agents.find(a=>a.id===session.id);
  assert.equal(restored.exit_code,null);
  assert.equal(restored.display_name,'Build shell');
  assert.equal(restored.restored.detail,'started a new shell in the same folder');
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type("echo $$ > shell.pid; printf 'after-%s\\n' reboot");
  await page.keyboard.press('Enter');
  await until(async()=>/after-reboot/.test(await paneText(pane)));
  assert.notEqual(Number(fs.readFileSync(path.join(state,'shell.pid'),'utf8')),shell);
  const evidence=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
  await pane.screenshot({path:path.join(evidence,'terminal-restore.png')});
  await page.reload();
  await until(async()=>/after-reboot/.test(await paneText(pane)));
  assert.doesNotMatch(await paneText(pane),/before-reboot/);
  assert.deepEqual(errors,[]);
  await api('api/terminals/stop',{id:session.id});
  await until(async()=>/Session ended/.test(await status.textContent()));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(state,`terminal-sessions-${port}.json`),'utf8')).sessions,[]);
  console.log('PASS: supervisor and backend SIGKILL, same pane restored in place with a reset screen and explanation, renamed title kept, keyboard input reaches a new shell, reload, explicit Stop clears the restore record.');
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null&&server.signalCode===null){const exited=once(server,'exit');server.kill('SIGINT');await exited;}
  // Scope cleanup to this fixture's private supervisor, never any user session.
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8'});
  fs.closeSync(log);
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  else fs.rmSync(state,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
