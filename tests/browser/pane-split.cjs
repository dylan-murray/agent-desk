// Dragging the edge between two terminals resizes both panes, so they still fill the
// workspace, and refits both terminals: each PTY learns its new size once the drag ends,
// and again when the window is resized. Real backend, real PTYs, fixture programs.
require('./check-isolated-url.cjs');
const evidence=require('./evidence.cjs');
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
async function until(fn,timeout=20000,what='condition'){const end=Date.now()+timeout;let last;while(Date.now()<end){if((last=await fn()))return last;await pause(50);}throw Error('Timed out waiting for '+what);}
(async()=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-split-')));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a');
 let server,browser,token;
 async function api(route,payload){const response=await fetch(base+route,{method:payload?'POST':'GET',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},...(payload?{body:JSON.stringify(payload)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 try{
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state,SHELL:'/bin/sh'},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}},20000,'backend');
  // Each fixture records the size its PTY reports, at start and on every SIGWINCH.
  fs.writeFileSync(path.join(state,'size.py'),"import shutil,signal,sys,time\ndef record(*_):\n    c,r=shutil.get_terminal_size()\n    open(sys.argv[1],'w').write(f'{c} {r}')\n    print(f'{c} cols x {r} rows',flush=True)\nsignal.signal(signal.SIGWINCH,record);record()\nwhile True:time.sleep(1)\n");
  const ids=[];
  for(const name of ['left','right'])ids.push((await api('api/terminals/launch',{cwd:state,argv:[python,path.join(state,'size.py'),path.join(state,name+'.size')],name:'Split '+name})).id);
  const ptySize=name=>{try{const [cols,rows]=fs.readFileSync(path.join(state,name+'.size'),'utf8').split(' ').map(Number);return {cols,rows};}catch{return null;}};
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  const page=await browser.newPage({viewport:{width:1920,height:958}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));try{localStorage.removeItem('agent-desk-pane-layout');}catch{}}},ids);
  await page.goto(base,{waitUntil:'domcontentloaded'});
  await until(()=>page.$$eval('#terminal .xterm',nodes=>nodes.length===2),20000,'two terminals');
  const view=()=>page.evaluate(ids=>{const workspace=document.querySelector('#terminal').getBoundingClientRect();return {workspace:{x:workspace.x,w:document.querySelector('#terminal').clientWidth,scroll:document.querySelector('#terminal').scrollHeight-document.querySelector('#terminal').clientHeight},
   panes:ids.map(id=>{const node=document.querySelector(`.terminal-pane[data-pane-id="${id}"]`),r=node.getBoundingClientRect(),screen=node.querySelector('.xterm-screen').getBoundingClientRect(),host=node.querySelector('.xterm').parentElement;
    const term=paneViews.get(id).term;return {x:r.x,y:r.y,w:r.width,h:r.height,screen:screen.width,host:host.clientWidth,cols:term.cols,rows:term.rows,rect:paneRects?.[id]||null};})};},ids);
  // A fit has reached a PTY when it reports the size its terminal draws. The fixtures start
  // at the launch size, so wait for the panes' first fit before measuring anything.
  const agree=(now,sizes)=>sizes.every((size,i)=>size&&size.cols===now.panes[i].cols&&size.rows===now.panes[i].rows);
  const fitted=await until(async()=>{const now=await view(),sizes=[ptySize('left'),ptySize('right')];return agree(now,sizes)&&{now,sizes};},15000,'initial fit');
  const start=fitted.now,initial=fitted.sizes,cell=start.panes[0].screen/start.panes[0].cols,slack=Math.max(...start.panes.map(pane=>pane.host-pane.screen));
  // A refit has settled when each PTY reports a new width that matches its terminal, and the
  // terminal fills its pane as it did before the drag, to within one cell.
  const settled=async(previous,what)=>until(async()=>{const now=await view(),sizes=[ptySize('left'),ptySize('right')];
   if(!agree(now,sizes)||sizes.some((size,i)=>size.cols===previous[i].cols))return false;
   return now.panes.every(pane=>pane.host-pane.screen<slack+cell+1)&&{now,sizes};},15000,what);
  const step=(start.panes[1].x-start.panes[0].x)/6;
  const drag=async cols=>{
   const edge=await page.locator(`.pane-edges[data-edges-for="${ids[0]}"] [data-edge=e]`).boundingBox();
   await page.mouse.move(edge.x+edge.width/2,edge.y+edge.height/2);await page.mouse.down();
   await page.mouse.move(edge.x+edge.width/2+step*cols,edge.y+edge.height/2,{steps:12});await pause(250);
   const during=await view();await page.mouse.up();return during;};
  const fills=(snapshot,label)=>{
   const [left,right]=snapshot.panes;
   assert.ok(Math.abs(left.y-right.y)<2,label+': the panes are no longer side by side');
   assert.ok(Math.abs(right.x+right.w-(snapshot.workspace.x+snapshot.workspace.w))<2,label+': the panes do not fill the workspace width');
   assert.ok(snapshot.workspace.scroll<=10,label+': a pane was pushed below the screen');
  };
  const during=await drag(2);
  const wider=await settled(initial,'refit after widening');
  fills(wider.now,'widening');
  assert.deepEqual(wider.now.panes.map(pane=>pane.rect),[{x:0,y:0,w:8,h:12},{x:8,y:0,w:4,h:12}]);
  assert.ok(Math.abs(during.panes[1].w-wider.now.panes[1].w)<2,'the neighbour did not follow the edge during the drag');
  assert.ok(wider.sizes[0].cols>initial[0].cols&&wider.sizes[1].cols<initial[1].cols,'the PTYs were not told their new widths: '+JSON.stringify(wider.sizes));
  await page.screenshot({path:evidence('agent-desk-pane-split-wider.png')});
  await drag(-4);
  const narrower=await settled(wider.sizes,'refit after narrowing');
  fills(narrower.now,'narrowing');
  assert.deepEqual(narrower.now.panes.map(pane=>pane.rect),[{x:0,y:0,w:4,h:12},{x:4,y:0,w:8,h:12}]);
  assert.ok(narrower.sizes[0].cols<initial[0].cols&&narrower.sizes[1].cols>initial[1].cols,'the PTYs were not told their new widths: '+JSON.stringify(narrower.sizes));
  await page.screenshot({path:evidence('agent-desk-pane-split-narrower.png')});
  await page.setViewportSize({width:1440,height:900});
  const window=await settled(narrower.sizes,'refit after a window resize');
  fills(window.now,'window resize');
  assert.ok(window.sizes[0].rows<narrower.sizes[0].rows,'the PTYs were not told the shorter window height');
  await page.screenshot({path:evidence('agent-desk-pane-split-1440.png')});
  assert.deepEqual(errors,[]);
  console.log('pane split passed',JSON.stringify({initial,wider:wider.sizes,narrower:narrower.sizes,window:window.sizes}));
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGINT');await exited;}
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8',timeout:15000});
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
 }
})().catch(error=>{console.error(error);process.exit(1);});
