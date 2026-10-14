// Panes stream over one WebSocket instead of polling. Real backend, real PTYs, fictional output.
// The socket is cut mid-output; the pane must reconnect without losing or repeating a byte.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');
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
async function until(fn,timeout=20000,what='condition'){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('Timed out waiting for '+what);}
(async()=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-stream-')));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a');
 let server,browser,token;
 async function api(route,payload){const response=await fetch(base+route,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},...(payload?{body:JSON.stringify(payload)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 try{
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state,SHELL:'/bin/sh'},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}},20000,'backend');
  fs.writeFileSync(path.join(state,'count.py'),"import sys,time\nsys.stdin.readline()\nfor i in range(400):\n    print(f'line-{i:03}', flush=True); time.sleep(.01)\nprint('counted', flush=True)\nimport os; os.execv('/bin/sh',['/bin/sh'])\n");
  const counter=await api('api/terminals/launch',{cwd:state,argv:[python,path.join(state,'count.py')],name:'Counter'});
  // No pane is opened for this one: its approval menu must still reach the attention banner.
  const asker=await api('api/terminals/launch',{cwd:state,argv:['/bin/sh','-c',"read go; printf 'Do you want to proceed?\\n\\342\\235\\257 1. Yes\\n  2. No\\n'; sleep 600"],name:'Asker'});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',request=>requests.push(new URL(request.url()).pathname));
  let socketRoute=null,frames=0;
  await page.routeWebSocket(/\/api\/terminals\/stream$/,ws=>{
   socketRoute=ws;const upstream=ws.connectToServer();
   ws.onMessage(message=>upstream.send(message));
   upstream.onMessage(message=>{frames++;ws.send(message);});
  });
  await page.addInitScript(id=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify([id])),counter.id);
  await page.goto(base);
  const pane=page.locator(`[data-pane-id="${counter.id}"]`),status=pane.locator('.pane-connection');
  await page.waitForFunction(id=>{const v=paneViews.get(id);return v&&v.subscription&&!v.restoring;},counter.id,{timeout:20000});
  const lines=()=>page.evaluate(id=>{const b=paneViews.get(id).term.buffer.active,out=[];for(let i=0;i<b.length;i++){const t=b.getLine(i).translateToString(true).trim();if(t)out.push(t);}return out;},counter.id);
  // Typing travels over the socket too.
  await pane.locator('.xterm-helper-textarea').focus();
  await page.keyboard.press('Enter');
  await until(async()=>(await lines()).includes('line-100'),20000,'output before the cut');
  const cutAt=frames;
  await socketRoute.close({code:4000,reason:'test cut'});
  await until(async()=>(await lines()).includes('counted'),30000,'output after reconnecting');
  const seen=(await lines()).filter(line=>/^line-\d{3}$/.test(line));
  assert.deepEqual(seen,Array.from({length:400},(_,i)=>'line-'+String(i).padStart(3,'0')),'every line exactly once, in order');
  assert.ok(frames>cutAt,'frames flowed again after the cut');
  assert.equal(await status.textContent(),'');
  await until(async()=>(await lines()).at(-1).endsWith('$'),10000,'the shell prompt');
  await page.keyboard.type("printf 'after-%s\\n' cut");await page.keyboard.press('Enter');
  await until(async()=>(await lines()).includes('after-cut'),10000,'input after reconnecting');
  // The asker's screen is followed in the background; nudge it to print its menu.
  await api('api/terminals/input',{id:asker.id,data:Buffer.from('\n').toString('base64')});
  const banner=page.locator('#session-attention');
  await until(async()=>/Asker/.test(await banner.innerText().catch(()=>'')),15000,'the approval banner');
  assert.equal(requests.filter(p=>p==='/api/terminals/output').length,0,'no output polling');
  assert.equal(requests.filter(p=>p==='/api/terminals/input').length,0,'no keystroke POSTs');
  await pause(600);const shot=path.join(os.tmpdir(),'terminal-stream.png');await page.screenshot({path:shot});
  assert.deepEqual(errors,[]);
  console.log('PASS: panes and background terminals stream over one socket; a cut mid-output reconnects with every byte once; input and approval alerts work without polling. Screenshot: '+shot);
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGINT');await exited;}
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8',timeout:15000});
  fs.closeSync(log);
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  else fs.rmSync(state,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
