// Panes always fill the workspace: after a resize, switching the agent a pane shows keeps that
// pane's place and size, and closing or adding panes leaves no dead space. Fixture agents.
const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=['fill-api','fill-docs','fill-tests','fill-review','fill-deploy'];
const agent=(id,i)=>({id,terminal_id:id,name:['API worker','Docs worker','Test runner','Reviewer','Deploy check'][i],cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1920,height:958}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:IDS.map(agent),demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));try{localStorage.removeItem('agent-desk-pane-layout');}catch{}}},IDS.slice(0,2));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});await page.waitForTimeout(500);
  // Every pixel of the workspace's first screen is under a pane or a gap between panes.
  const coverage=()=>page.evaluate(()=>{
    const ws=document.querySelector('#terminal'),box=ws.getBoundingClientRect(),gap=parseFloat(getComputedStyle(ws).columnGap)||0;
    const panes=[...ws.querySelectorAll(':scope > .terminal-pane')].map(node=>node.getBoundingClientRect());
    let empty=0;
    for(let y=box.top+4;y<box.top+ws.clientHeight-4;y+=12)for(let x=box.left+4;x<box.left+ws.clientWidth-4;x+=12)
      if(!panes.some(r=>x>=r.left-gap&&x<=r.right+gap&&y>=r.top-gap&&y<=r.bottom+gap))empty++;
    const cells=paneRects?Object.values(paneRects):[];
    return {empty,gapCells:paneRects?12*Math.max(12,...cells.map(r=>r.y+r.h))-cells.reduce((sum,r)=>sum+r.w*r.h,0):0,rects:paneRects&&JSON.parse(JSON.stringify(paneRects)),open:openPaneIds.slice(),
      pill:!document.querySelector('#panes-below').hidden};});
  const step=await page.$eval('#terminal',node=>(node.clientWidth+10)/12);
  const drag=async(id,edge,cells)=>{
    const e=await page.locator(`.pane-edges[data-edges-for="${id}"] [data-edge=${edge}]`).boundingBox(),row=await page.$eval('#terminal',node=>(node.clientHeight+10)/12);
    await page.mouse.move(e.x+e.width/2,e.y+e.height/2);await page.mouse.down();
    await page.mouse.move(e.x+e.width/2+(edge==='e'?step*cells:0),e.y+e.height/2+(edge==='s'?row*cells:0),{steps:12});
    await page.waitForTimeout(200);await page.mouse.up();await page.waitForTimeout(400);};
  const switchTo=async(from,to)=>{await page.evaluate(id=>{selectedId=id;},from);await page.locator(`.session-row[data-agent-id="${to}"]`).first().click();await page.waitForTimeout(500);};

  await drag(IDS[0],'e',2);
  const resized=await coverage();
  await switchTo(IDS[1],IDS[2]);
  const switched=await coverage();
  await page.screenshot({path:evidence('agent-desk-pane-fill-switch.png')});
  check('switching the agent in a resized pane keeps its place and size',()=>{
    assert.deepEqual(resized.rects,{[IDS[0]]:{x:0,y:0,w:8,h:12},[IDS[1]]:{x:8,y:0,w:4,h:12}});
    assert.deepEqual(switched.open,[IDS[0],IDS[2]]);
    assert.deepEqual(switched.rects,{[IDS[0]]:{x:0,y:0,w:8,h:12},[IDS[2]]:{x:8,y:0,w:4,h:12}},'the new agent did not take over the pane');
    assert.equal(switched.empty,0,'part of the workspace is empty');assert.equal(switched.pill,false,'a pane went below the screen');
  });
  await switchTo(IDS[2],IDS[1]);
  const back=await coverage();
  check('switching back keeps the same pane size too',()=>{assert.deepEqual(back.rects[IDS[1]],{x:8,y:0,w:4,h:12});assert.equal(back.empty,0);});

  await page.evaluate(ids=>{for(const id of ids)selectPane(id,true);},[IDS[2],IDS[3]]);
  await page.click('#pane-layout-button');await page.click('[data-layout=grid]');await page.waitForTimeout(400);
  await drag(IDS[0],'s',2);await switchTo(IDS[2],IDS[4]);
  const grid=await coverage();
  check('in a resized 2 × 2, a switched pane keeps its cell',()=>{
    assert.deepEqual(grid.rects[IDS[4]],{x:0,y:8,w:6,h:4});assert.equal(grid.gapCells,0);assert.equal(grid.empty,0);
  });
  await page.evaluate(id=>closePane(id),IDS[1]);await page.waitForTimeout(2600);
  const closed=await coverage();
  await page.screenshot({path:evidence('agent-desk-pane-fill-close.png')});
  check('closing a pane lets the others fill its space',()=>{assert.equal(closed.open.length,3);assert.equal(closed.gapCells,0);assert.equal(closed.empty,0);});
  check('the panes-below cue is not left over from the panes moving',()=>assert.equal(closed.pill,false,JSON.stringify(closed.rects)));
  await page.evaluate(id=>selectPane(id,true),IDS[1]);await page.waitForTimeout(400);await page.$eval('#terminal',node=>node.scrollTop=0);
  const added=await coverage();
  check('adding a pane keeps the screen filled and its row full width',()=>{assert.equal(added.gapCells,0);assert.equal(added.empty,0);assert.equal(added.rects[IDS[1]].w,12);});

  await page.setViewportSize({width:1440,height:900});await page.waitForTimeout(400);
  const window=await coverage();
  check('a window resize keeps the screen filled',()=>assert.equal(window.empty,0));
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
  const narrow=await page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return [Math.round(r.x),Math.round(r.width)];}));
  await page.screenshot({path:evidence('agent-desk-pane-fill-390.png')});
  check('narrow screens stack every pane at full width',()=>{for(const [x,w] of narrow){assert.equal(x,narrow[0][0]);assert.equal(w,narrow[0][1]);}});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log('FAIL: '+failures.join('; '));process.exit(1);}
 console.log('PASS: switch keeps the pane, switch back, resized grid switch, close, add, window resize, narrow');
})();
