// Panes reorder by dragging their header row
// and by keyboard, the order must persist the way pane state already persists, and none of
// the pane behaviour around it (focus, the pane cap, close, rename) may change. The cap is
// now 16 panes (pane-layouts.cjs covers layouts and resizing).
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=Array.from({length:17},(_,i)=>'pane-fixture-'+String.fromCharCode(97+i));
const OPEN=IDS.slice(0,3);
const agent=id=>({id,terminal_id:id,name:'Pane fixture '+id.slice(-1),cwd:'/tmp/'+id,harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
const order=page=>page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(node=>node.dataset.paneId));
const saved=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('agent-desk-panes-live')||'[]'));
async function dragHeader(page,fromIndex,toIndex,side){
  const from=await page.locator('#terminal > .terminal-pane').nth(fromIndex).locator('.terminal-bar').boundingBox();
  const to=await page.locator('#terminal > .terminal-pane').nth(toIndex).boundingBox();
  const x=side==='right'?to.x+to.width*0.85:to.x+to.width*0.15,y=to.y+to.height/2;
  await page.mouse.move(from.x+from.width*0.45,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(from.x+from.width*0.45+30,from.y+from.height/2,{steps:6});
  await page.mouse.move(x,y,{steps:18});
  await page.mouse.move(x,y,{steps:4});
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1920,height:958},deviceScaleFactor:1});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify({agents:IDS.map(agent),demo:false})}));
  // Live pins sit over the pane headers this check clicks and drags.
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  // Seed once only; a reload must read back whatever the drag stored, not the seed.
  // The sizes reproduce one tall pane beside two short ones, so the swap preview is
  // exercised between panes of different shapes.
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live')){sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));
    sessionStorage.setItem('agent-desk-pane-rects-live',JSON.stringify({[ids[0]]:{x:0,y:0,w:6,h:12},[ids[1]]:{x:6,y:0,w:6,h:6},[ids[2]]:{x:6,y:6,w:6,h:6}}));}},OPEN);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});
  await page.waitForTimeout(400);

  const start=await order(page);
  const handles=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(node=>({
    native:node.querySelector('.terminal-bar').draggable||node.querySelector('.pane-body').draggable||node.draggable,
    cursor:getComputedStyle(node.querySelector('.terminal-bar')).cursor,
    bodyCursor:getComputedStyle(node.querySelector('.pane-body')).cursor,
    grip:!!node.querySelector('.pane-grip')})));
  check('the pane grid starts in the stored order',()=>assert.deepEqual(start,OPEN));
  // The reorder is pointer-driven, not HTML5 drag-and-drop: nothing in the pane opts into
  // the browser's native drag, and the header is the only surface offering a grab cursor.
  check('the header row is the grab handle, the body and the pane are not',()=>{
    for(const pane of handles){
      assert.equal(pane.native,false,'a pane element still opts into native HTML5 dragging');
      assert.equal(pane.cursor,'grab','the header row does not offer a grab cursor');
      assert.notEqual(pane.bodyCursor,'grab','the terminal body offers a grab cursor');
      assert.ok(pane.grip,'the header row has no keyboard move control');
    }});
  // A press-and-move on the terminal body must never reorder anything.
  const bodyBox=await page.locator('#terminal > .terminal-pane').first().locator('.pane-body').boundingBox();
  const thirdBox=await page.locator('#terminal > .terminal-pane').nth(2).boundingBox();
  await page.mouse.move(bodyBox.x+bodyBox.width/2,bodyBox.y+bodyBox.height/2);
  await page.mouse.down();
  await page.mouse.move(thirdBox.x+thirdBox.width*0.85,thirdBox.y+thirdBox.height/2,{steps:12});
  await page.mouse.up();
  await page.waitForTimeout(200);
  const afterBodyDrag=await order(page);
  check('dragging the terminal body reorders nothing',()=>assert.deepEqual(afterBodyDrag,OPEN));

  const restingBoxes=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();
    return {id:n.dataset.paneId,x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width),h:Math.round(r.height)};}));
  await dragHeader(page,0,2,'right');
  await page.waitForTimeout(320);
  const during=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();
    return {id:node.dataset.paneId,
      dragging:node.classList.contains('pane-dragging'),
      swapping:node.classList.contains('pane-swap-target'),
      opacity:getComputedStyle(node).opacity,
      pointer:getComputedStyle(node).pointerEvents,
      shadow:getComputedStyle(node).boxShadow,
      transition:getComputedStyle(node).transitionDuration,
      transform:node.style.transform,
      matrix:(m=>({sx:+m.a.toFixed(4),sy:+m.d.toFixed(4)}))(new DOMMatrix(getComputedStyle(node).transform)),
      clip:node.style.clipPath,
      x:Math.round(r.x),y:Math.round(r.y),w:Math.round(r.width)};}));
  const heldBoxes=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();
    return n.classList.contains('pane-dragging')||n.classList.contains('pane-swap-target')?'moved':Math.round(r.x)+'x'+Math.round(r.width);}));
  // The complaint behind this: a pane scaled to fill a differently shaped slot stretches
  // the terminal inside it. The preview must never distort a pane, in either direction.
  check('the preview never stretches a pane',()=>{
    for(const pane of during){
      assert.equal(pane.matrix.sx,pane.matrix.sy,'pane '+pane.id+' is scaled unevenly: '+JSON.stringify(pane.matrix));
    }
    const target=during.find(pane=>pane.swapping);
    assert.equal(target.matrix.sx,1,'the hovered pane was resized instead of kept at its own scale');
    assert.equal(target.w,restingBoxes.find(pane=>pane.id===target.id).w,'the hovered pane changed width');
  });
  // Moving to another pane must hand the preview over cleanly, and holding still over one
  // pane must not oscillate: the preview moves the hovered pane out from under the cursor,
  // so the target is hit tested against slot geometry captured before anything moved.
  const secondBox=await page.locator('#terminal > .terminal-pane').nth(1).boundingBox();
  await page.mouse.move(secondBox.x+secondBox.width/2,secondBox.y+secondBox.height/2,{steps:10});
  await page.waitForTimeout(280);
  const handedOver=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>({id:n.dataset.paneId,swap:n.classList.contains('pane-swap-target'),moved:!!n.style.transform})));
  const dwell=[];
  for(let step=0;step<4;step++){
    await page.mouse.move(secondBox.x+secondBox.width/2+step,secondBox.y+secondBox.height/2,{steps:2});
    await page.waitForTimeout(70);
    dwell.push((await page.$$eval('#terminal .pane-swap-target',n=>n.map(x=>x.dataset.paneId))).join(','));
  }
  const ownSlot=restingBoxes.find(pane=>pane.id===OPEN[0]);
  await page.mouse.move(ownSlot.x+ownSlot.w/2,ownSlot.y+ownSlot.h/2,{steps:10});
  await page.waitForTimeout(280);
  const overOwnSlot=await page.$$eval('#terminal .pane-swap-target',n=>n.length);
  await page.mouse.move(thirdBox.x+thirdBox.width*0.85,thirdBox.y+thirdBox.height/2,{steps:10});
  await page.waitForTimeout(280);
  await page.mouse.up();
  await page.waitForTimeout(60);
  const settling=await page.$$eval('#terminal .pane-settled',n=>n.length);
  await page.waitForTimeout(600);
  const afterDrag=await order(page);
  const leftovers=await page.$$eval('#terminal .pane-dragging,#terminal .pane-swap-target,#terminal .pane-settled,#terminal .pane-returning',n=>n.length);
  const resting=await page.$$eval('#terminal > .terminal-pane',n=>n.map(x=>x.style.transform));
  const restedBoxes=await page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();
    return {id:n.dataset.paneId,x:Math.round(r.x),y:Math.round(r.y)};}));
  check('dragging the header row marks the source and exactly one swap target',()=>{
    const dragged=during.filter(pane=>pane.dragging);
    assert.equal(dragged.length,1,'the dragged pane is not marked');
    assert.equal(dragged[0].opacity,'0.92','the held pane is not the lifted opacity');
    assert.equal(during.filter(pane=>pane.swapping).length,1,'expected exactly one swap target');
  });
  // The pane itself lifts and tracks the pointer.
  check('the held pane lifts, follows the pointer and stops catching hit tests',()=>{
    const dragged=during.find(pane=>pane.dragging);
    assert.match(dragged.transform,/^translate3d\(-?\d/,'the held pane is not translated to the pointer');
    assert.match(dragged.transform,/scale\(0?\.97\) rotate\(0?\.4deg\)/,'the held pane is not lifted off the grid');
    assert.equal(dragged.pointer,'none','the held pane still swallows the hit test under the cursor');
    assert.notEqual(dragged.shadow,'none','the held pane casts no shadow');
    assert.equal(dragged.transition,'0s','the held pane eases instead of tracking the pointer exactly');
  });
  // The pane under the cursor moves into the held pane's slot.
  check('the hovered pane moves into the held pane\'s original slot',()=>{
    const target=during.find(pane=>pane.swapping);
    const home=restingBoxes.find(pane=>pane.id===OPEN[0]);
    assert.equal(target.id,OPEN[2],'the third pane is not the one being hovered');
    assert.match(target.transform,/^translate3d\(-?\d/,'the hovered pane is not translated at all');
    assert.equal(target.x,home.x,'the hovered pane did not land on the held pane\'s x');
    assert.equal(target.y,home.y,'the hovered pane did not land on the held pane\'s y');
    assert.notEqual(target.transition,'0s','the swap preview is not animated');
  });
  check('the preview follows the cursor between panes without oscillating',()=>{
    assert.deepEqual(handedOver.filter(pane=>pane.swap).map(pane=>pane.id),[OPEN[1]],'the preview did not hand over to the newly hovered pane');
    assert.deepEqual(handedOver.filter(pane=>pane.moved).map(pane=>pane.id).sort(),[OPEN[0],OPEN[1]].sort(),'the pane left behind kept its preview transform');
    assert.deepEqual(dwell,[OPEN[1],OPEN[1],OPEN[1],OPEN[1]],'the swap target flickered while the pointer held still');
    assert.equal(overOwnSlot,0,'hovering the held pane\'s own slot still marks a swap');
  });
  check('the grid itself never reflows while a pane is held',()=>{
    const dragged=during.findIndex(pane=>pane.dragging);
    assert.equal(dragged,0,'the fixture dragged a pane other than the first');
    const untouched=during.map((pane,i)=>i).filter(i=>!during[i].dragging&&!during[i].swapping);
    assert.deepEqual(untouched.map(i=>heldBoxes[i]),untouched.map(i=>restingBoxes[i].x+'x'+restingBoxes[i].w),'a pane that is neither held nor swapping changed geometry');
    assert.deepEqual(untouched.map(i=>during[i].transform),untouched.map(()=>''),'a pane that is neither held nor swapping was transformed');
  });
  check('the drop swaps the two panes, settles both and clears every indicator',()=>{
    assert.deepEqual(afterDrag,[OPEN[2],OPEN[1],OPEN[0]],'the drop did not swap the held and hovered panes');
    assert.equal(settling,2,'both panes should settle where they land');
    assert.equal(leftovers,0,'a drag indicator survived the drop');
    assert.deepEqual(resting,['','',''],'a pane kept its drag transform after the drop');
    // The preview showed the result: each pane is resting where the preview put it.
    const home=restingBoxes.find(pane=>pane.id===OPEN[0]);
    const landed=restedBoxes.find(pane=>pane.id===OPEN[2]);
    assert.deepEqual({x:landed.x,y:landed.y},{x:home.x,y:home.y},'the hovered pane did not stay where the preview put it');
  });

  // The other direction of the same complaint: a pane bigger than the slot it is previewed
  // into. It must keep its own scale and be masked to the slot's footprint, not squashed.
  // The seeded sizes make the first slot twice the height of the other two.
  const shapes=await page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();
    return {id:n.dataset.paneId,h:Math.round(r.height),w:Math.round(r.width)};}));
  const tall=shapes.reduce((a,b)=>a.h>=b.h?a:b),short=shapes.find(pane=>pane.h<tall.h);
  const heldIndex=shapes.findIndex(pane=>pane.id===short.id),hoverIndex=shapes.findIndex(pane=>pane.id===tall.id);
  const heldBar=await page.locator('#terminal > .terminal-pane').nth(heldIndex).locator('.terminal-bar').boundingBox();
  const hoverBox=await page.locator('#terminal > .terminal-pane').nth(hoverIndex).boundingBox();
  await page.mouse.move(heldBar.x+heldBar.width*0.5,heldBar.y+heldBar.height/2);
  await page.mouse.down();
  await page.mouse.move(heldBar.x+heldBar.width*0.5+40,heldBar.y+30,{steps:6});
  await page.mouse.move(hoverBox.x+hoverBox.width/2,hoverBox.y+hoverBox.height/2,{steps:14});
  await page.waitForTimeout(320);
  const cropped=await page.$eval('.pane-swap-target',node=>{const m=new DOMMatrix(getComputedStyle(node).transform),r=node.getBoundingClientRect();
    return {id:node.dataset.paneId,sx:+m.a.toFixed(4),sy:+m.d.toFixed(4),clip:getComputedStyle(node).clipPath,w:Math.round(r.width),h:Math.round(r.height)};});
  await page.keyboard.press('Escape');await page.mouse.up();await page.waitForTimeout(400);
  const afterEscape=await order(page);
  const clearedClips=await page.$$eval('#terminal > .terminal-pane',n=>n.map(x=>x.style.clipPath).join('|'));
  check('a pane larger than the slot is masked to it, never squashed into it',()=>{
    assert.equal(cropped.id,tall.id,'the tall pane is not the one being previewed');
    assert.equal(cropped.sx,1,'the tall pane was scaled down instead of masked');
    assert.equal(cropped.sy,1,'the tall pane was scaled down instead of masked');
    assert.equal(cropped.h,tall.h,'the tall pane changed height instead of being masked');
    assert.match(cropped.clip,/^inset\(/,'the tall pane is not masked to the slot');
    const bottom=Number(cropped.clip.match(/inset\(0px [\d.]+px ([\d.]+)px/)?.[1]);
    assert.ok(Math.abs(bottom-(tall.h-short.h))<=2,`the mask crops ${bottom}px, expected about ${tall.h-short.h}px`);
    assert.match(cropped.clip,/round/,'the mask has square corners where the pane is rounded');
  });
  check('escaping that drag restores the order and clears every mask',()=>{
    assert.deepEqual(afterEscape,afterDrag,'Escape changed the pane order');
    assert.equal(clearedClips,'||','a pane kept its preview mask');
  });

  const storedAfterDrag=await saved(page);
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane',{timeout:15000});
  await page.waitForTimeout(400);
  const afterReload=await order(page);
  check('the new order persists the way pane state already persists',()=>{
    assert.deepEqual(storedAfterDrag,afterDrag,'sessionStorage did not record the new order');
    assert.deepEqual(afterReload,afterDrag,'the order did not survive a reload');
  });

  await page.locator('#terminal > .terminal-pane').nth(2).locator('.pane-grip').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(300);
  const afterLeft=await order(page);
  const keptFocus=await page.evaluate(()=>document.activeElement.className+'|'+document.activeElement.closest('.terminal-pane').dataset.paneId);
  await page.keyboard.press('Alt+ArrowRight');
  await page.waitForTimeout(300);
  const afterRight=await order(page);
  await page.locator('#terminal > .terminal-pane').nth(0).locator('.pane-grip').focus();
  await page.keyboard.press('Alt+ArrowLeft');
  await page.waitForTimeout(300);
  const afterBoundary=await order(page);
  // Bare arrows are the path that works on every Mac keyboard; Alt+arrow stays an alias.
  await page.locator('#terminal > .terminal-pane').nth(2).locator('.pane-grip').focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const afterBareLeft=await order(page);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(300);
  const afterBareRight=await order(page);
  check('the keyboard moves a pane either way and stops at the ends',()=>{
    assert.deepEqual(afterLeft,[afterReload[0],afterReload[2],afterReload[1]],'Alt+ArrowLeft did not move the pane earlier');
    assert.equal(keptFocus,'pane-grip|'+afterReload[2],'the move control lost focus after the move');
    assert.deepEqual(afterRight,afterReload,'Alt+ArrowRight did not move the pane back');
    assert.deepEqual(afterBoundary,afterReload,'the first pane moved past the start of the grid');
  });
  check('a bare arrow on the move control works without Alt',()=>{
    assert.deepEqual(afterBareLeft,[afterReload[0],afterReload[2],afterReload[1]],'ArrowLeft alone did not move the pane');
    assert.deepEqual(afterBareRight,afterReload,'ArrowRight alone did not move the pane back');
  });

  await dragHeader(page,0,1,'right');
  await page.mouse.up();
  await page.waitForTimeout(400);
  const renameOpened=await page.$$eval('.pane-name-input',n=>n.length);
  const afterGesture=await order(page);
  check('a drag gesture neither renames nor closes a pane',()=>{
    assert.equal(renameOpened,0,'a drag opened the rename editor');
    assert.equal(afterGesture.length,3,'a drag closed a pane');
  });

  await page.locator('#terminal > .terminal-pane').nth(0).locator('.pane-title').click();
  await page.waitForTimeout(300);
  const renamingDraggable=await page.$eval('#terminal > .terminal-pane:nth-child(1) > .terminal-bar',n=>n.dataset.paneDrag!=='off');
  const editorOpen=await page.$$eval('.pane-name-input',n=>n.length);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const restoredDraggable=await page.$eval('#terminal > .terminal-pane:nth-child(1) > .terminal-bar',n=>n.dataset.paneDrag!=='off');
  check('renaming still works and releases the grab handle while its field is open',()=>{
    assert.equal(editorOpen,1,'clicking the title no longer renames');
    assert.equal(renamingDraggable,false,'the header stayed draggable over the rename field');
    assert.equal(restoredDraggable,true,'the grab handle did not come back after renaming');
  });

  await page.locator('#terminal > .terminal-pane').nth(1).locator('.pane-directory').click();
  await page.waitForTimeout(300);
  const focused=await page.$$eval('#terminal .terminal-pane.focused',n=>n.map(x=>x.dataset.paneId));
  const openRows=await page.$$eval('.session-row.pane-open',n=>n.map(x=>x.dataset.agentId));
  await page.evaluate(id=>selectPane(id,true),IDS[3]);
  await page.waitForTimeout(400);
  const atCap=await order(page);
  await page.evaluate(ids=>{for(const id of ids)selectPane(id,true);},IDS.slice(4,16));
  await page.waitForTimeout(400);
  const fullCap=await order(page);
  await page.evaluate(id=>selectPane(id,true),IDS[16]);
  await page.waitForTimeout(400);
  const overCap=await order(page);
  const capToast=await page.textContent('#toast').catch(()=>null);
  const beforeClose=await order(page);
  await page.locator('#terminal > .terminal-pane').nth(1).locator('.pane-close').click();
  await page.waitForTimeout(400);
  const afterClose=await order(page);
  check('focus, the open-pane row highlight, the 16-pane cap and closing are unchanged',()=>{
    assert.equal(focused.length,1,'more or fewer than one pane is focused');
    assert.equal(openRows.length,3,'the open-pane row highlight changed');
    assert.equal(atCap.length,4,'a fourth pane could not be opened');
    assert.equal(fullCap.length,16,'sixteen panes could not be opened');
    assert.deepEqual(overCap,fullCap,'a seventeenth pane was opened past the cap');
    assert.equal(capToast,'16 panes are open. Close a pane to add another.');
    assert.deepEqual([...afterClose].sort(),beforeClose.filter((_,i)=>i!==1).sort(),'closing removed the wrong pane');
  });

  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log('FAIL: '+failures.join('; '));process.exit(1);}
 console.log('PASS: header-row drag handle, drop feedback, persisted order, keyboard moves, rename/close/focus, 16-pane cap');
})();
