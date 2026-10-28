// A pane as wide as the screen cannot be narrowed (nothing could fill the space it would
// leave), so dragging another pane over the outer quarter of its left or right side places the
// two side by side.
// The middle of a pane still swaps, a pane too narrow to share offers no side drop, and
// stacked panes on a narrow screen keep plain swapping.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const IDS=['snap-fixture-a','snap-fixture-b','snap-fixture-c','snap-fixture-d','snap-fixture-e'];
const agent=id=>({id,terminal_id:id,name:'Snap fixture '+id.slice(-1),cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
const rects=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('agent-desk-pane-rects-live')||'null'));
const order=page=>page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(node=>node.dataset.paneId));
const box=(page,id)=>page.locator(`#terminal > .terminal-pane[data-pane-id="${id}"]`).boundingBox();
async function hold(page,fromId,x,y){
  const from=await page.locator(`#terminal > .terminal-pane[data-pane-id="${fromId}"] .terminal-bar`).boundingBox();
  await page.mouse.move(from.x+from.width*0.45,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(from.x+from.width*0.45+30,from.y+from.height/2,{steps:6});
  await page.mouse.move(x,y,{steps:18});
  await page.mouse.move(x,y,{steps:4});
  await page.waitForTimeout(260);
}
async function open(browser,viewport,ids,seed,setup){
  const context=await browser.newContext({viewport,deviceScaleFactor:1});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({agents:IDS.map(agent),demo:false})}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  if(setup)await setup(page);
  await page.addInitScript(([ids,seed])=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));
    if(seed)sessionStorage.setItem('agent-desk-pane-rects-live',JSON.stringify(seed));}},[ids,seed]);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});
  await page.waitForTimeout(400);
  return {page,context,errors};
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const [a,b,c,d,e]=IDS;
  // Two full-width panes, one above the other, as in the annotated desk.
  const stacked={[a]:{x:0,y:0,w:12,h:6},[b]:{x:0,y:6,w:12,h:6}};
  let {page,context,errors}=await open(browser,{width:1920,height:958},[a,b],stacked);
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-before-1920.png')});

  const top=await box(page,a);
  // Passing over an edge on the way somewhere else shows no side drop; staying a moment does.
  const bar=await page.locator(`[data-pane-id="${b}"] .terminal-bar`).boundingBox();
  await page.mouse.move(bar.x+bar.width*0.45,bar.y+bar.height/2);await page.mouse.down();
  await page.mouse.move(bar.x+bar.width*0.45+30,bar.y+bar.height/2,{steps:6});
  await page.mouse.move(top.x+top.width-40,top.y+top.height/2,{steps:8});await page.waitForTimeout(40);
  const passing=await page.evaluate(()=>!!document.getElementById('pane-snap-preview'));
  await page.mouse.move(top.x+top.width/2,top.y+top.height/2,{steps:6});await page.waitForTimeout(260);
  const leftEdge=await page.evaluate(()=>!!document.getElementById('pane-snap-preview'));
  check('passing over an edge does not show the side drop',()=>{assert.equal(passing,false,'shown while passing');assert.equal(leftEdge,false,'still shown after leaving the edge');});
  await page.mouse.move(top.x+top.width-40,top.y+top.height/2,{steps:4});await page.waitForTimeout(260);
  const right=await page.evaluate(id=>({preview:document.getElementById('pane-snap-preview')?.getBoundingClientRect().toJSON(),node:document.querySelector(`[data-pane-id="${id}"]`)}),a).then(async value=>({...value,clip:await page.locator(`[data-pane-id="${a}"]`).evaluate(node=>({clip:node.style.clipPath,transform:node.style.transform}))}));
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-right-1920.png')});
  check('near the right side of the wide pane, a marker shows the right half',()=>{
    assert.ok(right.preview,'no drop marker');assert.equal(right.clip.transform,'','the wide pane moved instead of drawing in');
    assert.match(right.clip.clip,/^inset\(0px \d+(\.\d+)?px 0px 0px/,'the wide pane is not masked to its left part');
    assert.ok(Math.abs(right.preview.left-(top.x+top.width/2))<12,'marker does not start at the middle: '+right.preview.left);
    assert.ok(Math.abs(right.preview.right-(top.x+top.width))<2,'marker does not reach the right side');});
  await page.mouse.up();await page.waitForTimeout(450);
  const placed=await rects(page),afterRight={a:await box(page,a),b:await box(page,b)};
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-after-right-1920.png')});
  check('dropping there puts the panes side by side, filling the screen',()=>{
    assert.deepEqual(placed,{[a]:{x:0,y:0,w:6,h:12},[b]:{x:6,y:0,w:6,h:12}});
    assert.ok(afterRight.b.x>afterRight.a.x+afterRight.a.width-2,'the dropped pane is not to the right');
    assert.ok(Math.abs(afterRight.a.y-afterRight.b.y)<2,'the panes are not on one row');});
  const markers=await page.locator('#pane-snap-preview').count(),placedOrder=await order(page);
  check('the marker is gone after the drop',()=>assert.equal(markers,0));
  check('the pane order follows the new places',()=>assert.deepEqual(placedOrder,[a,b]));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('#terminal .terminal-pane');await page.waitForTimeout(400);
  const reloaded=await rects(page);
  check('the places survive a reload',()=>assert.deepEqual(reloaded,placed));

  // The middle of a pane still swaps.
  const half=await box(page,b);
  await hold(page,a,half.x+half.width/2,half.y+half.height/2);
  const middle=await page.evaluate(()=>({preview:!!document.getElementById('pane-snap-preview'),swap:!!document.querySelector('.pane-swap-target')}));
  await page.mouse.up();await page.waitForTimeout(450);
  const swapped=await rects(page);
  check('the middle of a pane still swaps the two',()=>{
    assert.equal(middle.preview,false,'a side marker showed in the middle');assert.ok(middle.swap,'no swap preview in the middle');
    assert.deepEqual(swapped,{[b]:{x:0,y:0,w:6,h:12},[a]:{x:6,y:0,w:6,h:12}});});

  // Side by side, neither pane is full width, so their sides only swap.
  const halfSide=await box(page,a);
  await hold(page,b,halfSide.x+20,halfSide.y+halfSide.height/2);
  const halves=await page.evaluate(()=>({preview:!!document.getElementById('pane-snap-preview'),swap:!!document.querySelector('.pane-swap-target')}));
  await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(300);
  check('the side of a pane that is not full width only swaps',()=>{assert.equal(halves.preview,false);assert.ok(halves.swap);});
  check('no page errors at 1920',()=>assert.deepEqual(errors,[]));
  await context.close();

  // The left side of a full-width pane places the held pane on its left half.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b],stacked));
  const left=await box(page,a);
  await hold(page,b,left.x+20,left.y+left.height/2);
  const leftPreview=await page.evaluate(()=>document.getElementById('pane-snap-preview')?.getBoundingClientRect().toJSON());
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-left-1920.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  const leftPlaced=await rects(page);
  check('the left side places the pane on the left half, and the panes still fill the screen',()=>{
    assert.ok(leftPreview&&Math.abs(leftPreview.left-left.x)<2,'no marker at the left');
    assert.ok(Math.abs(leftPreview.width-(left.width-10)/2)<12,'the marker is not half the screen: '+leftPreview.width);
    assert.deepEqual(leftPlaced,{[b]:{x:0,y:0,w:6,h:12},[a]:{x:6,y:0,w:6,h:12}});});
  check('no page errors on the left side',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Four columns: none is full width, so the side of the last one swaps.
  const columns={[a]:{x:0,y:0,w:3,h:12},[b]:{x:3,y:0,w:3,h:12},[c]:{x:6,y:0,w:3,h:12},[d]:{x:9,y:0,w:3,h:12}};
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b,c,d],columns));
  const last=await box(page,d);
  await hold(page,a,last.x+last.width-15,last.y+last.height/2);
  const columnMarker=await page.evaluate(()=>!!document.getElementById('pane-snap-preview'));
  await page.mouse.up();await page.waitForTimeout(450);
  const moved=await rects(page);
  check('the side of a narrow column swaps instead of splitting it',()=>{assert.equal(columnMarker,false);
    assert.deepEqual(moved,{[d]:{x:0,y:0,w:3,h:12},[b]:{x:3,y:0,w:3,h:12},[c]:{x:6,y:0,w:3,h:12},[a]:{x:9,y:0,w:3,h:12}});});
  check('no page errors with four columns',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Four columns above a full-width pane: with that pane gone the columns only grow taller,
  // each still three wide, so dropping it at a column's side is an ordinary swap.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b,c,d,e],
    {[a]:{x:0,y:0,w:3,h:6},[b]:{x:3,y:0,w:3,h:6},[c]:{x:6,y:0,w:3,h:6},[d]:{x:9,y:0,w:3,h:6},[e]:{x:0,y:6,w:12,h:6}}));
  const narrow=await box(page,d);
  await hold(page,e,narrow.x+narrow.width-15,narrow.y+narrow.height/2);
  const narrowState=await page.evaluate(()=>({preview:!!document.getElementById('pane-snap-preview'),swap:!!document.querySelector('.pane-swap-target')}));
  await page.mouse.up();await page.waitForTimeout(450);
  const narrowRects=await rects(page);
  check('a pane too narrow to share offers no side drop',()=>{
    assert.equal(narrowState.preview,false);assert.ok(narrowState.swap,'the swap preview is missing');
    assert.deepEqual(narrowRects[e],{x:9,y:0,w:3,h:6});});
  check('no page errors with five panes',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Scrolled down to a full-width pane between two others: the marker is a cell of the pane
  // grid, so it stays inside the workspace instead of covering the toolbar above it.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b,c],{[a]:{x:0,y:0,w:12,h:6},[b]:{x:0,y:6,w:12,h:9},[c]:{x:0,y:15,w:12,h:6}}));
  await page.evaluate(()=>{const w=document.getElementById('terminal');w.scrollTop=w.scrollHeight;});await page.waitForTimeout(300);
  const middleBox=await box(page,b);
  await hold(page,c,middleBox.x+middleBox.width-60,Math.max(middleBox.y+40,140));
  const scrolled=await page.evaluate(()=>{const marker=document.getElementById('pane-snap-preview'),workspace=document.getElementById('terminal');
    return {inGrid:marker?.parentElement===workspace,marker:marker?.getBoundingClientRect().toJSON(),workspace:workspace.getBoundingClientRect().toJSON(),
      covering:document.elementsFromPoint(1500,90).some(node=>node===marker)};});
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-scrolled-1920.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  const scrolledRects=await rects(page);
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-after-scrolled-1920.png')});
  check('scrolled, the marker sits in the pane grid and never covers the toolbar',()=>{
    assert.ok(scrolled.inGrid,'the marker is not in the pane grid');assert.equal(scrolled.covering,false,'the marker covers the toolbar');});
  check('scrolled, the bottom pane lands to the right of the full-width one',()=>
    assert.deepEqual(scrolledRects,{[a]:{x:0,y:0,w:12,h:6},[b]:{x:0,y:6,w:6,h:9},[c]:{x:6,y:6,w:6,h:9}}));
  check('no page errors when scrolled',()=>assert.deepEqual(errors,[]));
  await context.close();

  // A tool docked in the right half of the wide pane is an iframe; it must not swallow the
  // pointer, or the right side of that pane could never take the drop.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b],stacked,async page=>{
    await page.route('http://127.0.0.1:49402/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>tool</title><h1>Fixture tool</h1>'}));
    await page.route('**/api/skill-uis',route=>route.fulfill({json:{uis:[{id:'snap-tool',title:'Fixture tool',skill:'fixture',url:'http://127.0.0.1:49402/snap-tool',endpoint:'/apps/snap-tool',status:'running',managed:false,context:'/tmp/snap-tool.html',agent_id:a}]}}));}));
  await page.locator(`[data-pane-id="${a}"] .pane-tool-toggle`).click();
  await page.waitForFunction(id=>{const dock=document.querySelector(`[data-pane-id="${id}"] .pane-dock`);return dock&&!dock.hidden&&dock.querySelector('iframe');},a);
  const docked=await box(page,a),frame=await page.locator(`[data-pane-id="${a}"] .pane-dock iframe`).boundingBox();
  const overFrame={x:docked.x+docked.width-60,y:Math.max(docked.y+docked.height/2,frame.y+40)};
  await hold(page,b,overFrame.x,overFrame.y);
  const dockState=await page.evaluate(()=>({marker:!!document.getElementById('pane-snap-preview'),side:paneDrag?.target?.side||null}));
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-docked-1920.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  const dockedRects=await rects(page);
  check('over a docked tool on the right, the side drop still works',()=>{
    assert.ok(overFrame.x>frame.x&&overFrame.y>frame.y,'the pointer was not over the docked tool');
    assert.equal(dockState.side,'right','the drag never saw the pointer over the docked tool');
    assert.deepEqual(dockedRects,{[a]:{x:0,y:0,w:6,h:12},[b]:{x:6,y:0,w:6,h:12}});});
  check('no page errors with a docked tool',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Two full-width rows from the plain Rows layout, the bottom one held by its title at the
  // left of its header and slid right until the pane covers the right half: the pointer is
  // only near the middle, but the pane is past it, so it lands on the right.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b],null,async page=>{
    await page.addInitScript(()=>{try{localStorage.setItem('agent-desk-pane-layout','rows');}catch{}});}));
  const rowsTop=await box(page,a),title=await page.locator(`[data-pane-id="${b}"] .pane-title`).boundingBox();
  const grab={x:title.x+10,y:title.y+title.height/2},target={x:rowsTop.x+rowsTop.width/2+160,y:rowsTop.y+rowsTop.height*0.6};
  await page.mouse.move(grab.x,grab.y);await page.mouse.down();
  await page.mouse.move(grab.x+20,grab.y-10,{steps:4});await page.mouse.move(target.x,target.y,{steps:16});await page.waitForTimeout(260);
  const slid=await page.evaluate(()=>({side:paneDrag?.target?.side||null,layout:paneLayoutId}));
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-by-title-1920.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  const slidRects=await rects(page);
  check('held by its title and slid right, a full-width pane lands on the right',()=>{
    assert.equal(slid.layout,'rows');assert.ok(target.x<rowsTop.x+rowsTop.width*0.75,'the pointer reached the side zone, so this proves nothing');
    assert.equal(slid.side,'right');assert.deepEqual(slidRects,{[a]:{x:0,y:0,w:6,h:12},[b]:{x:6,y:0,w:6,h:12}});});
  check('no page errors in the Rows layout',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Two panes side by side on the bottom row: the bottom edge of one takes the other below it
  // as a full-width row of its own.
  ({page,context,errors}=await open(browser,{width:1920,height:958},[a,b,c],{[a]:{x:0,y:0,w:12,h:6},[b]:{x:0,y:6,w:6,h:6},[c]:{x:6,y:6,w:6,h:6}}));
  const pair=await box(page,b);
  await hold(page,c,pair.x+pair.width/2,pair.y+pair.height-30);
  const below=await page.evaluate(id=>({side:paneDrag?.target?.side||null,clip:document.querySelector(`[data-pane-id="${id}"]`).style.clipPath,
    marker:document.getElementById('pane-snap-preview')?.getBoundingClientRect().toJSON()}),b);
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-below-1920.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  const belowRects=await rects(page);
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-after-below-1920.png')});
  check('the bottom edge of a pane in a shared row takes the held pane below as a full-width row',()=>{
    assert.equal(below.side,'bottom');
    assert.ok(below.marker&&below.marker.width>pair.width*1.8,'the marker is not full width');
    assert.deepEqual(belowRects,{[a]:{x:0,y:0,w:12,h:6},[b]:{x:0,y:6,w:12,h:3},[c]:{x:0,y:9,w:12,h:3}});});
  check('the hovered pane is masked to the part it keeps, not covered',()=>assert.match(below.clip,/^inset\(/));
  check('no page errors dropping below',()=>assert.deepEqual(errors,[]));
  await context.close();

  // Stacked panes on a phone: no side drop.
  ({page,context,errors}=await open(browser,{width:390,height:844},[a,b],stacked));
  const phone=await box(page,a);
  await hold(page,b,phone.x+phone.width-10,phone.y+phone.height/2);
  const phoneState=await page.evaluate(()=>!!document.getElementById('pane-snap-preview'));
  await page.screenshot({path:path.join(EVIDENCE,'pane-snap-holding-390.png')});
  await page.mouse.up();await page.waitForTimeout(450);
  check('stacked panes on a phone offer no side drop',()=>assert.equal(phoneState,false));
  check('no page errors at 390',()=>assert.deepEqual(errors,[]));
  await context.close();
 }finally{await browser.close();}
 if(failures.length){console.log(failures.length+' failed');process.exit(1);}
 console.log('pane-snap: all checks passed');
})().catch(error=>{console.error(error);process.exit(1);});
