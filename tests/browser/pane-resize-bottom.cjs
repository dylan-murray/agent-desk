// A pane on the bottom row can still be made taller: its handles sit at the bottom of the window,
// so holding the drag there grows it and scrolls the workspace along. Panes above it can also be
// dragged smaller when it spans several of them. Fixture agents.
const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=['bottom-api','bottom-docs','bottom-tests'];
const agent=(id,i)=>({id,terminal_id:id,name:['API worker','Docs worker','Test runner'][i],cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1920,height:958}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:IDS.map(agent),demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live'))sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));},IDS.slice(0,2));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});await page.waitForTimeout(500);
  const stack=()=>page.evaluate(([top,bottom])=>{paneRects={[top]:{x:0,y:0,w:12,h:9},[bottom]:{x:0,y:9,w:12,h:3}};applyPaneLayout({});savePaneRects();document.querySelector('#terminal').scrollTop=0;},IDS);
  const state=()=>page.evaluate(id=>({h:paneRects[id].h,top:paneRects[id].y,scroll:document.querySelector('#terminal').scrollTop,
    bottom:document.querySelector(`.terminal-pane[data-pane-id="${id}"]`).getBoundingClientRect().bottom,workspace:document.querySelector('#terminal').getBoundingClientRect().bottom}),IDS[1]);
  for(const edge of ['se','s']){
    await stack();await page.waitForTimeout(300);
    const handle=await page.locator(`.pane-edges[data-edges-for="${IDS[1]}"] [data-edge=${edge}]`).boundingBox(),x=handle.x+handle.width/2,y=handle.y+handle.height/2;
    if(edge==='se')await page.screenshot({path:evidence('2026-10-13-pane-resize-bottom-before.png')});
    // Pressing the handle and not moving must not start anything.
    await page.mouse.move(x,y);await page.mouse.down();await page.waitForTimeout(500);
    const pressed=await state();
    // 957 is the last pixel row of the window: the pointer has nowhere further to go.
    await page.mouse.move(x,957,{steps:4});await page.waitForTimeout(1200);
    const held=await state();
    if(edge==='se')await page.screenshot({path:evidence('2026-10-13-pane-resize-bottom-held.png')});
    // Moving back up past the start stops the growth.
    await page.mouse.move(x,y-6,{steps:3});await page.waitForTimeout(150);const stopped=await state();await page.waitForTimeout(500);const later=await state();
    await page.mouse.up();await page.waitForTimeout(400);
    const done=await state();
    check(edge+' handle: a press without movement leaves the pane alone',()=>assert.equal(pressed.h,3));
    check(edge+' handle: holding at the bottom of the window grows the pane',()=>assert.ok(held.h>=5,'height '+held.h));
    check(edge+' handle: the pane keeps its top edge and the workspace scrolls with it',()=>{assert.equal(held.top,9);assert.ok(held.scroll>0);assert.ok(held.bottom<=held.workspace+12,'bottom edge '+held.bottom+' past '+held.workspace);});
    check(edge+' handle: growth stops when the pointer leaves the bottom',()=>assert.equal(later.h,stopped.h));
    check(edge+' handle: the new height is kept',()=>assert.equal(done.h,later.h));
  }
  // The top edge of a pane spanning two panes above it is one edge: dragging either upper pane's
  // bottom edge moves both, and the wide pane takes or gives the space.
  await page.locator(`[data-add-pane="${IDS[2]}"]`).first().click();await page.waitForTimeout(500);
  const rows=await page.$eval('#terminal',node=>(node.clientHeight+10)/12),cols=await page.$eval('#terminal',node=>(node.clientWidth+10)/12);
  const place=rects=>page.evaluate(([ids,rects])=>{paneRects=Object.fromEntries(ids.map((id,i)=>[id,rects[i]]));applyPaneLayout({});savePaneRects();document.querySelector('#terminal').scrollTop=0;},[IDS,rects]);
  const rects=()=>page.evaluate(ids=>ids.map(id=>[paneRects[id].x,paneRects[id].y,paneRects[id].w,paneRects[id].h].join(',')),IDS);
  const pull=async(id,edge,dx,dy)=>{
    const handle=await page.locator(`.pane-edges[data-edges-for="${id}"] [data-edge=${edge}]`).boundingBox(),x=handle.x+handle.width/2,y=handle.y+handle.height/2;
    await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+dx*cols,y+dy*rows,{steps:10});await page.waitForTimeout(200);await page.mouse.up();await page.waitForTimeout(400);return rects();};
  const wide=[{x:0,y:0,w:6,h:9},{x:6,y:0,w:6,h:9},{x:0,y:9,w:12,h:3}];
  for(const upper of [0,1]){
    await place(wide);await page.waitForTimeout(300);
    const up=await pull(IDS[upper],'s',0,-3);
    if(!upper)await page.screenshot({path:evidence('2026-10-13-pane-resize-shared-edge.png')});
    check('upper pane '+(upper+1)+': its bottom edge drags up, taking the pane beside it along',()=>assert.deepEqual(up,['0,0,6,6','6,0,6,6','0,6,12,6']));
    const down=await pull(IDS[upper],'s',0,2);
    check('upper pane '+(upper+1)+': and back down',()=>assert.deepEqual(down,['0,0,6,8','6,0,6,8','0,8,12,4']));
    const floor=await pull(IDS[upper],'s',0,-9);
    check('upper pane '+(upper+1)+': both stop at the smallest size',()=>assert.deepEqual(floor,['0,0,6,3','6,0,6,3','0,3,12,9']));
  }
  // The same sideways: two panes stacked on the left of one tall pane.
  await place([{x:0,y:0,w:9,h:6},{x:0,y:6,w:9,h:6},{x:9,y:0,w:3,h:12}]);await page.waitForTimeout(300);
  const left=await pull(IDS[1],'e',-3,0);
  check('stacked panes beside a tall one: either right edge drags both',()=>assert.deepEqual(left,['0,0,6,6','0,6,6,6','6,0,6,12']));
  // An edge shared by just two panes still moves only those two.
  await place([{x:0,y:0,w:6,h:6},{x:6,y:0,w:6,h:12},{x:0,y:6,w:6,h:6}]);await page.waitForTimeout(300);
  const pair=await pull(IDS[0],'s',0,-2);
  check('an edge between two panes leaves the third alone',()=>assert.deepEqual(pair,['0,0,6,4','6,0,6,12','0,4,6,8']));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log('\n'+failures.length+' failed');process.exit(1);}
})().catch(error=>{console.error(error);process.exit(1);});
