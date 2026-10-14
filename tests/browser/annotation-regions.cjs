// Annotations open as a panel beside what was marked, and an area mode draws a rectangle over a
// whole section of the UI. Saving closes the panel.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1300,height:850}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let stored={notes:[],deleted:[]};
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   if(path==='/api/feedback'){
    if(route.request().method()==='POST')stored=route.request().postDataJSON();
    return route.fulfill({json:stored});}
   const data={'/api/agents':{agents:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.locator('#annotation-launcher').click();
  const panel=page.locator('#annotation-note-panel');
  const draw=async(x1,y1,x2,y2)=>{await page.mouse.move(x1,y1);await page.mouse.down();
   await page.mouse.move(x2,y2,{steps:8});await page.mouse.up();await page.waitForTimeout(150);};

  // Drawing an area over a whole section.
  await page.locator('#mode-region').click();
  const hint=await page.locator('#annotation-hint').textContent();
  check('the area mode explains itself',()=>assert.match(hint,/[Dd]rag a rectangle/));
  await page.mouse.move(420,260);await page.mouse.down();await page.mouse.move(820,470,{steps:8});
  const drafting=await page.evaluate(()=>{const node=document.getElementById('annotation-region-draft');
   const rect=node.getBoundingClientRect();return {shown:!node.classList.contains('hidden'),w:Math.round(rect.width),h:Math.round(rect.height)};});
  await page.mouse.up();await page.waitForTimeout(200);
  check('the rectangle is drawn while dragging',()=>assert.deepEqual(drafting,{shown:true,w:400,h:210}));

  // The note arrives as a panel, not a modal, and it names the area.
  const target=await page.locator('#annotation-target').textContent();
  const visible=await panel.isVisible();
  const isDialog=await page.evaluate(()=>document.getElementById('annotation-note-panel').tagName);
  check('the note is a panel, and it says what was marked',()=>{
   assert.equal(visible,true);assert.equal(isDialog,'DIV');
   assert.match(target,/^Area · \(620, 365\) · 400 × 210/);
  });
  const placement=await page.evaluate(()=>{const rect=document.getElementById('annotation-note-panel').getBoundingClientRect();
   return {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)};});
  check('the panel sits beside the area and stays on screen',()=>{
   assert.ok(Math.abs(placement.x-420)<=12,'panel x '+placement.x);
   assert.ok(placement.y>=470,'the panel covers the area it describes: '+JSON.stringify(placement));
   assert.ok(placement.x+placement.w<=1300&&placement.y+placement.h<=850,'the panel hangs off screen');
  });

  await page.locator('#annotation-note').fill('this whole section needs more contrast');
  await page.locator('#annotation-note-save').click();
  await panel.waitFor({state:'hidden'});
  const afterSave=await page.evaluate(()=>({open:!document.getElementById('annotation-note-panel').classList.contains('hidden'),
   note:document.getElementById('annotation-note').value,state:document.getElementById('annotation-note-state').textContent,
   focused:document.activeElement.id}));
  check('saving closes and clears the panel after one submission',()=>{
   assert.equal(afterSave.open,false);assert.equal(afterSave.note,'');
  });
  const saved=stored.notes.at(-1);
  check('the area is saved with its own kind and a relative rectangle',()=>{
   assert.equal(saved.kind,'region');
   assert.equal(saved.note,'this whole section needs more contrast');
   assert.ok(saved.region&&saved.region.width>0&&saved.region.height>0,'no relative rectangle: '+JSON.stringify(saved.region));
   assert.equal(Math.round(saved.point.viewportX),620);
   assert.ok(saved.selector,'the area has no anchor element');
  });
  const marked=await page.evaluate(()=>{const node=document.querySelector('.feedback-region');const rect=node.getBoundingClientRect();
   return {index:node.querySelector('.feedback-region-index').textContent,x:Math.round(rect.x),y:Math.round(rect.y),
    w:Math.round(rect.width),h:Math.round(rect.height),clickable:getComputedStyle(node).pointerEvents};});
  check('the saved area is drawn back over the same part of the page',()=>{
   assert.equal(marked.index,'1');
   assert.ok(Math.abs(marked.x-420)<=2&&Math.abs(marked.y-260)<=2,JSON.stringify(marked));
   assert.ok(Math.abs(marked.w-400)<=2&&Math.abs(marked.h-210)<=2,JSON.stringify(marked));
   assert.equal(marked.clickable,'none','a marked area must not swallow clicks inside it');
  });

  // A second area, without reopening anything.
  await draw(900,560,1120,680);
  await page.locator('#annotation-note').fill('second area');
  await page.locator('#annotation-note-save').click();
  await page.waitForFunction(()=>document.querySelectorAll('.feedback-region').length===2);
  check('another area can be marked without reopening the note',()=>assert.equal(stored.notes.length,2));

  // Pins still work, and their panel also closes on save.
  await page.locator('#mode-pin').click();
  await page.mouse.click(700,300);
  await page.waitForFunction(()=>document.getElementById('annotation-target').textContent.startsWith('Pin'));
  await page.locator('#annotation-note').fill('a pin still works');
  await page.locator('#annotation-note-save').click();
  await page.waitForFunction(()=>document.querySelectorAll('.feedback-pin').length===1);
  const kinds=stored.notes.map(note=>note.kind);
  check('pins retain their own saved kind',()=>assert.deepEqual(kinds,['region','region','pin']));
  const stillOpen=await panel.isVisible();
  check('the panel closes after saving a pin',()=>assert.equal(stillOpen,false));

  // Reopening an existing note offers to delete it.
  await panel.waitFor({state:'hidden'});
  await page.locator('.feedback-region-index').first().click();
  await page.waitForFunction(()=>!document.getElementById('annotation-note-panel').classList.contains('hidden'));
  const editing=await page.evaluate(()=>({note:document.getElementById('annotation-note').value,
   canDelete:!document.getElementById('annotation-note-delete').hidden}));
  check('clicking a saved area reopens its note with a delete option',()=>{
   assert.equal(editing.note,'this whole section needs more contrast');assert.equal(editing.canDelete,true);
  });
  await page.locator('#annotation-note-delete').click();
  await page.waitForFunction(()=>document.querySelectorAll('.feedback-region').length===1);
  check('deleting removes that area and leaves the rest',()=>assert.deepEqual(stored.notes.map(n=>n.kind),['region','pin']));

  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: areas drawn over sections, saved and redrawn, with a note panel that closes after each save');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
