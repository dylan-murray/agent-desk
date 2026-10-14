// Pane layouts and resizing: five layouts drawn in a picker, 2 × 2 by default, each one a
// pattern that repeats as panes are added (rows past one screen scroll), and pane edges
// that resize in grid steps while the pane sharing that edge gives or takes the space.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=Array.from({length:6},(_,i)=>'layout-fixture-'+String.fromCharCode(97+i));
const agent=id=>({id,terminal_id:id,name:'Layout fixture '+id.slice(-1),cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
const boxes=page=>page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();
  return {id:node.dataset.paneId,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}));
const workspaceBox=page=>page.$eval('#terminal',node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:node.clientWidth,h:node.clientHeight,scroll:node.scrollTop,scrollMax:node.scrollHeight-node.clientHeight};});
const overlaps=(a,b)=>a.x<b.x+b.w-1&&b.x<a.x+a.w-1&&a.y<b.y+b.h-1&&b.y<a.y+a.h-1;
const near=(a,b,slack=2)=>Math.abs(a-b)<=slack;
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1600,height:900},deviceScaleFactor:1});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:IDS.map(agent),demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));try{localStorage.removeItem('agent-desk-pane-layout');}catch{}}},IDS.slice(0,4));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});
  await page.waitForTimeout(500);

  const quad=await boxes(page),ws=await workspaceBox(page);
  const button=await page.$eval('#pane-layout-button',node=>({label:node.querySelector('#pane-layout-label').textContent,resized:!node.querySelector('#pane-layout-custom').hidden,glyph:node.querySelectorAll('.layout-glyph rect').length}));
  check('the default layout is four quadrants filling the workspace',()=>{
    assert.equal(button.label,'2 × 2');assert.equal(button.resized,false);assert.equal(button.glyph,4,'the toolbar drawing is not four cells');
    assert.equal(quad.length,4);
    const [a,b,c,d]=quad;
    assert.ok(near(a.w,b.w)&&near(a.w,c.w)&&near(a.w,d.w)&&near(a.h,c.h),'the quadrants are not equal: '+JSON.stringify(quad));
    assert.ok(near(a.y,b.y)&&near(c.y,d.y)&&c.y>a.y&&b.x>a.x,'the panes are not two by two');
    assert.ok(near(d.y+d.h,ws.y+ws.h),'the quadrants do not fill the workspace height');
    assert.ok(near(b.x+b.w,ws.x+ws.w),'the quadrants do not fill the workspace width');
  });

  await page.click('#pane-layout-button');
  await page.waitForTimeout(150);
  await page.keyboard.press('ArrowRight');
  // The workspace re-renders every two seconds; an open menu must keep its focus.
  await page.waitForTimeout(2300);
  const keptFocus=await page.evaluate(()=>document.activeElement?.dataset.layout);
  await page.keyboard.press('ArrowLeft');
  const menu=await page.$$eval('#pane-layout-menu [data-layout]',nodes=>nodes.map(node=>({id:node.dataset.layout,label:node.textContent.trim(),checked:node.getAttribute('aria-checked'),cells:node.querySelectorAll('rect').length,focused:node===document.activeElement})));
  await page.keyboard.press('Escape');
  const closedByEscape=await page.$eval('#pane-layout-menu',node=>node.hidden);
  check('the picker draws five layouts and marks the current one',()=>{
    assert.deepEqual(menu.map(item=>item.label),['2 × 2','Rows','Columns','3 × 2','Main + side']);
    assert.deepEqual(menu.map(item=>item.cells),[4,2,3,6,4],'a drawing does not show one screen of its layout');
    assert.deepEqual(menu.map(item=>item.checked),['true','false','false','false','false']);
    assert.ok(menu[0].focused,'opening the picker did not focus the current layout');
    assert.ok(closedByEscape,'Escape did not close the picker');
    assert.equal(keptFocus,'rows','arrow keys did not move through the layouts, or a refresh took focus away');
  });

  // Two stacked rows: a third pane is added below, off the first screen.
  await page.click('#pane-layout-button');await page.click('[data-layout=rows]');
  await page.evaluate(id=>selectPane(id,true),IDS[4]);
  await page.waitForTimeout(500);
  const added=await page.$eval(`[data-pane-id="${IDS[4]}"].terminal-pane`,node=>{const r=node.getBoundingClientRect(),w=document.querySelector('#terminal').getBoundingClientRect();return r.top>=w.top-1&&r.bottom<=w.bottom+1;});
  await page.$eval('#terminal',node=>node.scrollTop=0);await page.waitForTimeout(150);
  const rows=await boxes(page),rowsWs=await workspaceBox(page);
  const pill=await page.$eval('#panes-below',node=>({hidden:node.hidden,text:node.textContent.trim()}));
  check('rows repeat below the first screen and the workspace scrolls to them',()=>{
    assert.ok(added,'a pane added below the screen was not scrolled fully into view');
    assert.equal(rows.length,5);
    for(let i=1;i<rows.length;i++){assert.ok(near(rows[i].x,rows[0].x)&&near(rows[i].w,rows[0].w),'a row is not full width');assert.ok(rows[i].y>rows[i-1].y,'rows are not stacked in order');}
    assert.ok(near(rows[0].h*2+10,rowsWs.h),'two rows do not fill one screen: '+rows[0].h+' vs '+rowsWs.h);
    assert.ok(rowsWs.scrollMax>rowsWs.h,'the workspace does not scroll to the extra rows');
    assert.deepEqual(pill,{hidden:false,text:'3 panes below'});
  });
  await page.click('#panes-below');
  await page.waitForTimeout(700);
  const scrolled=await workspaceBox(page),afterPill=await boxes(page);
  await page.$eval('#terminal',node=>node.scrollTop=node.querySelector('.terminal-pane').offsetHeight/2);await page.waitForTimeout(150);
  const cutOff=await page.$eval('#panes-below',node=>node.textContent.trim());
  check('panes cut off at the bottom are not counted as out of sight',()=>assert.equal(cutOff,'2 panes below'));
  check('the panes-below cue brings the next pane to the top',()=>{
    assert.ok(scrolled.scroll>0,'clicking the cue did not scroll');
    assert.ok(near(afterPill[2].y,scrolled.y),'the first hidden pane is not at the top: '+afterPill[2].y+' vs '+scrolled.y);
  });
  await page.$eval('#terminal',node=>node.scrollTop=0);

  // Back to 2 × 2 with four panes, then widen the first pane by dragging its right edge.
  await page.evaluate(id=>closePane(id),IDS[4]);
  await page.click('#pane-layout-button');await page.click('[data-layout=grid]');
  await page.waitForTimeout(400);
  const before=await boxes(page);
  const edge=await page.locator(`.pane-edges[data-edges-for="${IDS[0]}"] [data-edge=e]`).boundingBox();
  const colStep=(before[1].x-before[0].x)/6;
  await page.mouse.move(edge.x+edge.width/2,edge.y+edge.height/2);
  await page.mouse.down();
  await page.mouse.move(edge.x+edge.width/2+colStep*3,edge.y+edge.height/2,{steps:16});
  await page.waitForTimeout(350);
  const during=await boxes(page);
  const lit=await page.$eval(`.pane-edges[data-edges-for="${IDS[0]}"]`,node=>({active:node.dataset.active,e:getComputedStyle(node.querySelector('[data-edge=e]'),'::after').opacity,s:getComputedStyle(node.querySelector('[data-edge=s]'),'::after').opacity}));
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after=await boxes(page);
  const byId=Object.fromEntries(after.map(box=>[box.id,box]));
  const badge=await page.$eval('#pane-layout-custom',node=>!node.hidden);
  check('dragging an edge resizes the pane in grid steps and lights only that edge',()=>{
    assert.equal(lit.active,'e');assert.equal(lit.e,'1');assert.equal(lit.s,'0');
    const a=byId[IDS[0]];
    assert.ok(near(a.w,Math.round(before[0].w*1.5+5),3),'the pane is not three columns wider: '+a.w+' from '+before[0].w);
    assert.ok(near(a.h,before[0].h),'a right-edge drag changed the height');
    assert.ok(badge,'the toolbar does not say the layout was resized');
  });
  check('the pane sharing the dragged edge gives up the width, so the row still fills the screen',()=>{
    for(let i=0;i<after.length;i++)for(let j=i+1;j<after.length;j++)assert.ok(!overlaps(after[i],after[j]),`${after[i].id} overlaps ${after[j].id}`);
    const a=byId[IDS[0]],b=byId[IDS[1]];
    assert.ok(near(b.y,a.y)&&near(b.x,a.x+a.w+10),'the neighbour was not kept beside the pane: '+JSON.stringify(b));
    assert.ok(near(b.x+b.w,ws.x+ws.w),'the row no longer fills the workspace width');
    assert.ok(near(b.w,Math.round(before[1].w/2-5),3),'the neighbour did not give up three columns: '+b.w);
    for(const id of IDS.slice(2,4)){const was=before.find(box=>box.id===id);assert.deepEqual([byId[id].x,byId[id].y,byId[id].w,byId[id].h],[was.x,was.y,was.w,was.h],id+' in the other row changed');}
    const mid=Object.fromEntries(during.map(box=>[box.id,box]));
    assert.ok(near(mid[IDS[1]].w,b.w)&&near(mid[IDS[1]].x,b.x),'the neighbour did not follow the edge during the drag');
  });

  const corner=page.locator(`.pane-edges[data-edges-for="${IDS[0]}"] [data-edge=se]`);
  await corner.focus();
  await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(400);
  const keyed=await page.evaluate(id=>({rect:paneRects[id],focus:document.activeElement.dataset.edge}),IDS[0]);
  check('arrow keys on the corner resize by one cell and keep focus',()=>{
    assert.deepEqual(keyed.rect,{x:0,y:0,w:8,h:7});
    assert.equal(keyed.focus,'se');
  });

  const stored=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('agent-desk-pane-rects-live')));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});
  await page.waitForTimeout(500);
  const reloaded=await page.evaluate(()=>({rects:paneRects,layout:paneLayoutId}));
  check('sizes and the chosen layout survive a reload',()=>{
    assert.deepEqual(reloaded.rects,stored);
    assert.equal(reloaded.layout,'grid');
  });

  await page.click('#pane-layout-button');await page.click('[data-layout=grid]');
  await page.waitForTimeout(400);
  const reset=await boxes(page),resetBadge=await page.$eval('#pane-layout-custom',node=>!node.hidden);
  check('choosing the layout again resets every pane to it',()=>{
    assert.equal(resetBadge,false);
    assert.deepEqual(reset.map(box=>[box.x,box.y,box.w,box.h]),quad.map(box=>[box.x,box.y,box.w,box.h]));
  });

  await page.locator('#terminal > .terminal-pane').first().locator('.pane-expand').click();
  await page.waitForTimeout(200);
  const fullscreenEdges=await page.$$eval('.pane-edges',nodes=>nodes.filter(node=>getComputedStyle(node).display!=='none'&&!node.hidden).length);
  await page.keyboard.press('Escape');
  check('a full-screen pane hides every resize handle',()=>assert.equal(fullscreenEdges,0));

  await page.setViewportSize({width:700,height:900});
  await page.waitForTimeout(400);
  const narrow=await boxes(page),narrowHandles=await page.$$eval('.pane-edges',nodes=>nodes.filter(node=>getComputedStyle(node).display!=='none').length);
  check('narrow screens stack the panes and offer no resize handles',()=>{
    for(let i=1;i<narrow.length;i++){assert.ok(near(narrow[i].x,narrow[0].x)&&near(narrow[i].w,narrow[0].w),'panes are not stacked');assert.ok(narrow[i].y>narrow[i-1].y);}
    assert.equal(narrowHandles,0);
  });

  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log('FAIL: '+failures.join('; '));process.exit(1);}
 console.log('PASS: default quadrants, layout picker, repeating rows, panes-below cue, edge and keyboard resizing with reflow, persistence, reset, full screen, narrow');
})();
