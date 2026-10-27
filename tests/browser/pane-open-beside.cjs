// A new pane opens beside the selected pane rather than at the end of the workspace, both in a
// tiled layout and in a resized one. Fixture agents.
const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=['beside-api','beside-docs','beside-tests','beside-review','beside-deploy','beside-lint'];
const agent=(id,i)=>({id,terminal_id:id,name:['API worker','Docs worker','Test runner','Reviewer','Deploy check','Lint fixer'][i],cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
const [API,DOCS,TESTS,REVIEW,DEPLOY,LINT]=IDS;
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1600,height:900}});const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:IDS.map(agent),demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));try{localStorage.removeItem('agent-desk-pane-layout');}catch{}}},IDS.slice(0,4));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});await page.waitForTimeout(500);
  const boxes=()=>page.$$eval('#terminal > .terminal-pane',nodes=>Object.fromEntries(nodes.map(node=>{const r=node.getBoundingClientRect();
    return [node.dataset.paneId,{x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)}];})));
  const state=()=>page.evaluate(()=>({open:openPaneIds.slice(),selected:selectedId,rects:paneRects&&JSON.parse(JSON.stringify(paneRects))}));
  // Selecting is a click on the pane's header; adding is a Cmd+click on a session row.
  const select=async id=>{await page.locator(`.terminal-pane[data-pane-id="${id}"] .terminal-bar`).click({position:{x:200,y:8}});await page.waitForTimeout(150);};
  const add=async id=>{await page.locator(`.session-row[data-agent-id="${id}"]`).first().click({modifiers:['Meta']});await page.waitForTimeout(600);};

  await select(API);
  const before=await boxes();
  await add(DEPLOY);
  const tiled=await boxes(),tiledState=await state();
  await page.screenshot({path:evidence('agent-desk-pane-open-beside-tiled.png')});
  check('in a tiled layout the new pane opens right of the selected one, not at the bottom',()=>{
    assert.deepEqual(tiledState.open,[API,DEPLOY,DOCS,TESTS,REVIEW]);
    assert.equal(tiledState.selected,DEPLOY);
    assert.equal(tiled[DEPLOY].y,before[API].y,'the new pane is not on the selected pane\'s row');
    assert.equal(tiled[DEPLOY].x,before[DOCS].x,'the new pane is not beside the selected pane');
    assert.deepEqual(tiled[API],before[API],'the selected pane moved');
  });

  // Resize by one cell and back with the keyboard: the same sizes, now explicit.
  await page.locator(`.pane-edges[data-edges-for="${API}"] [data-edge=se]`).focus();
  await page.keyboard.press('ArrowRight');await page.waitForTimeout(250);
  await page.locator(`.pane-edges[data-edges-for="${API}"] [data-edge=se]`).focus();
  await page.keyboard.press('ArrowLeft');await page.waitForTimeout(400);
  const resized=await state();
  await select(TESTS);
  const at=resized.rects[TESTS];
  await add(LINT);
  const placed=await state();
  await page.screenshot({path:evidence('agent-desk-pane-open-beside-resized.png')});
  check('in a resized layout the new pane opens beside the selected one and the rest make room',()=>{
    assert.ok(resized.rects,'the layout was not resized');
    assert.ok(placed.rects,'adding a pane reset the resized layout');
    const lint=placed.rects[LINT];
    const right=lint.x===at.x+at.w&&lint.y===at.y,below=lint.y===at.y+at.h&&lint.x<at.x+at.w&&at.x<lint.x+lint.w;
    assert.ok(right||below,`the new pane ${JSON.stringify(lint)} is not beside ${JSON.stringify(at)}`);
    assert.deepEqual(placed.rects[TESTS],at,'the selected pane moved');
    const cells=Object.values(placed.rects);
    assert.equal(12*Math.max(12,...cells.map(r=>r.y+r.h))-cells.reduce((sum,r)=>sum+r.w*r.h,0),0,'the panes leave dead space');
  });
  const visible=await page.$eval(`.terminal-pane[data-pane-id="${LINT}"]`,node=>{const r=node.getBoundingClientRect(),w=document.querySelector('#terminal').getBoundingClientRect();return r.top>=w.top-1&&r.bottom<=w.bottom+1;});
  check('the new pane is on screen',()=>assert.ok(visible));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log(failures.length+' failed');process.exit(1);}
 console.log('pane-open-beside: all checks passed');
})();
