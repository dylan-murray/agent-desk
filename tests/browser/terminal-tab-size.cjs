// Two tabs showing one terminal at different sizes must not leave it sized for the tab out of view.
// The terminal used to keep the size of whichever tab resized last, so the tab being looked at drew
// an agent laid out for another width. Real backend, real PTY, fictional output.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const evidence=require('./evidence.cjs');
const root=path.resolve(__dirname,'../..');
const python=process.env.AGENT_DESK_TEST_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=20000,what='condition'){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('Timed out waiting for '+what);}
// Headless tabs always report visible, so this stands in for the browser switching tabs.
const show=(page,visible,announce=true)=>page.evaluate(([visible,announce])=>{
 Object.defineProperty(document,'hidden',{configurable:true,get:()=>!visible});
 Object.defineProperty(document,'visibilityState',{configurable:true,get:()=>visible?'visible':'hidden'});
 if(announce)document.dispatchEvent(new Event('visibilitychange'));},[visible,announce]);
(async()=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-tab-size-')));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a');
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let server,browser,token;
 async function api(route,payload){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},body:JSON.stringify(payload)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 try{
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state,SHELL:'/bin/sh'},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}},20000,'backend');
  // Prints the size the program sees at start and on every SIGWINCH.
  const sizer=await api('api/terminals/launch',{cwd:state,argv:['/bin/sh','-c',"trap 'echo size $(stty size)' WINCH; echo size $(stty size); while :; do sleep 1; done"],name:'Sizer'});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  const context=await browser.newContext(),errors=[];
  const wide=await context.newPage(),narrow=await context.newPage();
  await wide.setViewportSize({width:1440,height:900});await narrow.setViewportSize({width:700,height:700});
  for(const page of [wide,narrow]){
   page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(id=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify([id])),sizer.id);
   await page.goto(base);
   await page.waitForFunction(id=>{const v=paneViews.get(id);return v&&v.subscription&&!v.restoring;},sizer.id,{timeout:20000});
   await pause(400);
  }
  const read=page=>page.evaluate(id=>{const term=paneViews.get(id).term,b=term.buffer.active,sizes=[];
   for(let i=0;i<b.length;i++){const t=b.getLine(i).translateToString(true).trim();if(/^size \d+ \d+$/.test(t))sizes.push(t);}
   const [rows,cols]=sizes.at(-1).split(' ').slice(1);return {pane:`${term.cols}x${term.rows}`,program:`${cols}x${rows}`,changes:sizes.length};},sizer.id);
  // A tab in the background has its timers slowed to about once a second, so wait for the expected size.
  const settle=async expected=>{let seen;await until(async()=>(seen=await read(wide)).program===expected,5000,'size '+expected).catch(()=>{});await pause(expected?300:2500);return read(wide);};
  const sizes={wide:(await read(wide)).pane,narrow:(await read(narrow)).pane};
  check('the two tabs show the terminal at different sizes',()=>assert.notEqual(sizes.wide,sizes.narrow));

  await show(wide,false);
  let seen=await settle(sizes.narrow);
  check('...so the program starts at the narrow tab\'s size',()=>assert.equal(seen.program,sizes.narrow));
  await wide.screenshot({path:evidence('terminal-tab-size-mismatch-1440.png')});

  await show(narrow,false);await show(wide,true);seen=await settle(sizes.wide);
  check('switching to the wide tab gives the program its size',()=>assert.equal(seen.program,sizes.wide));
  await wide.screenshot({path:evidence('terminal-tab-size-claimed-1440.png')});

  await narrow.setViewportSize({width:600,height:500});seen=await settle();
  check('a tab out of view that is resized leaves the terminal alone',()=>assert.equal(seen.program,sizes.wide));

  const narrowNow=(await read(narrow)).pane;
  await show(wide,false);await show(narrow,true);seen=await settle(narrowNow);
  check('switching back to the other tab gives it its new size',()=>assert.equal(seen.program,narrowNow));

  await show(narrow,false);await show(wide,true);const back=await settle(sizes.wide);
  await wide.evaluate(()=>dispatchEvent(new Event('focus')));const again=await settle();
  check('focusing a tab whose size the terminal already has does not resize it again',()=>assert.equal(again.changes,back.changes));

  // Side by side (two windows, or a browser tab next to the desktop app) both are visible; focus decides.
  await show(narrow,true,false);await narrow.evaluate(()=>dispatchEvent(new Event('focus')));seen=await settle(narrowNow);
  check('with both in view, the focused one sizes the terminal',()=>assert.equal(seen.program,narrowNow));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGINT');await exited;}
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8',timeout:15000});
  fs.closeSync(log);
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  else fs.rmSync(state,{recursive:true,force:true});
 }
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: the tab in view sizes the terminal');
})().catch(error=>{console.error(error);process.exit(1);});
