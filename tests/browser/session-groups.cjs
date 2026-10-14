// Sidebar folders: dropping one session onto the middle of another groups them into a folder
// (Group 1, Group 2, ...), and a right-click renames a group. Every grouping
// change here is made with a real native drag, a real right-click or real keys, and read back
// from the rendered sidebar and from storage after a reload.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const os=require('node:os');const path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
// runtime_status pins each fixture's status: these terminals do not exist on the test server, so
// live output monitoring would otherwise report them as unknown a couple of seconds after load.
const agent=(id,name,harness,status)=>({id,terminal_id:id,name,display_name:name,cwd:'/tmp/'+id,harness,status,source:'terminal',runtime_status:true,
  task:'Interactive terminal',project:'fixture',events:[],question:status==='needs_input'?'Approve the plan?':null,exit_code:null,updated:Date.now()/1000});
const AGENTS=[agent('grp-a','Alpha','claude','working'),agent('grp-b','Bravo','codex','idle'),agent('grp-c','Charlie','codex','unknown'),
  // A terminal's status comes from its PTY unless a runtime reports it, as one does for this question.
  {...agent('grp-d','Delta','claude','needs_input'),runtime_status:true},agent('grp-e','Echo','codex','working'),
  {...agent('grp-coord','Coordinator','codex','idle'),controller:true}];
const rowSel=id=>`.session-row[data-agent-id="${id}"]`;
// The sidebar as data: each top-level item is a session id or a folder with its members.
const layout=page=>page.$$eval('#agent-grid > .session-entry, #agent-grid > .nav-group',nodes=>nodes.map(node=>node.classList.contains('nav-group')?
  {group:node.querySelector('.nav-group-name').textContent,collapsed:node.classList.contains('collapsed'),
    members:[...node.querySelectorAll('.session-row')].map(row=>row.dataset.agentId)}:node.querySelector('.session-row').dataset.agentId));
const stored=page=>page.evaluate(()=>JSON.parse(localStorage.getItem('agent-desk-groups-live')||'[]'));
const folder=(name,members,collapsed=false)=>({group:name,collapsed,members});
// Drags with the mouse so Chromium runs its native drag-and-drop, released at a fraction of the target's height.
async function drag(page,fromSel,toSel,fraction){
  const from=await page.locator(fromSel).boundingBox(),to=await page.locator(toSel).boundingBox();
  await page.mouse.move(from.x+from.width*0.4,from.y+from.height/2);
  await page.mouse.down();
  await page.mouse.move(from.x+from.width*0.4,from.y+from.height/2+8,{steps:3});
  await page.mouse.move(to.x+to.width*0.4,to.y+to.height*fraction,{steps:12});
  await page.mouse.move(to.x+to.width*0.4,to.y+to.height*fraction,{steps:2});
  await page.mouse.up();
  await page.waitForTimeout(150);
}
async function menu(page,targetSel,item){
  await page.locator(targetSel).click({button:'right'});
  await page.click(`#session-group-menu [role=menuitem]:text-is("${item}")`);
  await page.waitForTimeout(150);
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:AGENTS,demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  // Seed once; the reload below must read back what the interactions stored.
  await page.addInitScript(()=>{if(!sessionStorage.getItem('groups-seeded')){sessionStorage.setItem('groups-seeded','1');
    localStorage.setItem('agent-desk-order-live',JSON.stringify(['grp-a','grp-b','grp-c','grp-d','grp-e']));localStorage.removeItem('agent-desk-groups-live');}});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector(rowSel('grp-e'),{timeout:15000});await page.waitForTimeout(400);
  const start=await layout(page);
  check('the sidebar starts ungrouped in the stored order',()=>assert.deepEqual(start,['grp-coord','grp-a','grp-b','grp-c','grp-d','grp-e']));

  await drag(page,rowSel('grp-c'),rowSel('grp-a'),0.1);
  const reordered=await layout(page);
  check('dropping on the top edge of a session reorders without grouping',()=>assert.deepEqual(reordered,['grp-coord','grp-c','grp-a','grp-b','grp-d','grp-e']));

  await drag(page,rowSel('grp-b'),rowSel('grp-a'),0.5);
  const first=await layout(page),toast=await page.textContent('#toast');
  check('dropping onto the middle of a session makes "Group 1" holding both, where the target was',()=>assert.deepEqual(first,['grp-coord','grp-c',folder('Group 1',['grp-a','grp-b']),'grp-d','grp-e']));
  check('the toast names the new group and how to rename it',()=>assert.match(toast,/Group 1.*right-click/));

  await drag(page,rowSel('grp-e'),rowSel('grp-d'),0.5);
  const second=await layout(page);
  check('the next group is "Group 2"',()=>assert.deepEqual(second,['grp-coord','grp-c',folder('Group 1',['grp-a','grp-b']),folder('Group 2',['grp-d','grp-e'])]));

  await drag(page,rowSel('grp-c'),'[data-group-toggle] >> nth=0',0.7);
  const intoHeader=await layout(page);
  check('dropping onto a folder header adds the session to that folder',()=>assert.deepEqual(intoHeader,['grp-coord',folder('Group 1',['grp-a','grp-b','grp-c']),folder('Group 2',['grp-d','grp-e'])]));

  await drag(page,rowSel('grp-coord'),rowSel('grp-a'),0.5);
  const mixed=await layout(page);
  check('a coordinator does not join a group of agents',()=>assert.deepEqual(mixed,intoHeader));

  const group2=page.locator('.nav-group',{has:page.locator('.nav-group-name',{hasText:'Group 2'})});
  await page.click(rowSel('grp-d'));await page.waitForTimeout(150);
  await group2.locator('[data-group-toggle]').click();await page.waitForTimeout(250);
  const collapsed=await group2.evaluate(node=>({collapsed:node.classList.contains('collapsed'),
    holdsSelected:node.querySelector('[data-group-toggle]').classList.contains('holds-selected')&&getComputedStyle(node.querySelector('[data-group-toggle]')).boxShadow!=='none',
    expanded:node.querySelector('[data-group-toggle]').getAttribute('aria-expanded'),
    membersVisible:node.querySelector('.nav-group-members').checkVisibility(),
    peek:[...node.querySelectorAll('.nav-group-peek-avatar')].map(el=>el.textContent),
    attention:!!node.querySelector('.nav-group-attention')?.checkVisibility(),
    attentionLabel:node.querySelector('.nav-group-attention')?.getAttribute('aria-label')}));
  check('clicking a folder header collapses it and hides its members',()=>{assert.equal(collapsed.collapsed,true);assert.equal(collapsed.expanded,'false');assert.equal(collapsed.membersVisible,false);});
  check('a collapsed folder holding the focused session is marked',()=>assert.equal(collapsed.holdsSelected,true));
  check('a collapsed folder previews its members',()=>assert.deepEqual(collapsed.peek,['CC','CX']));
  check('a collapsed folder still shows that a member needs you',()=>{assert.equal(collapsed.attention,true);assert.equal(collapsed.attentionLabel,'1 needs you');});
  await page.mouse.move(700,400);
  await page.screenshot({path:path.join(OUT,'session-groups-desktop.png'),clip:{x:0,y:0,width:300,height:640}});

  await page.fill('#search','Delta');await page.waitForTimeout(150);
  const searching=await group2.evaluate(node=>({collapsed:node.classList.contains('collapsed'),rowVisible:node.querySelector('.session-row[data-agent-id="grp-d"]').checkVisibility()}));
  await page.fill('#search','');await page.waitForTimeout(150);
  const restored=await group2.evaluate(node=>node.classList.contains('collapsed'));
  check('a search shows matches inside a collapsed folder',()=>{assert.equal(searching.collapsed,false);assert.equal(searching.rowVisible,true);});
  check('clearing the search restores the collapsed folder',()=>assert.equal(restored,true));

  await page.locator('[data-group-toggle]').first().click({button:'right'});
  const menuItems=await page.$$eval('#session-group-menu:not([hidden]) [role=menuitem]',items=>items.map(item=>item.textContent));
  const menuFocus=await page.evaluate(()=>document.activeElement?.textContent);
  check('right-clicking a folder offers Rename, Collapse, moving it to a desk, and Ungroup',()=>assert.deepEqual(menuItems,['Rename','Collapse','Move to a new desk…','Ungroup']));
  check('the menu opens with its first item focused',()=>assert.equal(menuFocus,'Rename'));
  await page.screenshot({path:path.join(OUT,'session-groups-menu.png'),clip:{x:0,y:380,width:300,height:260}});
  await page.click('#session-group-menu [role=menuitem]:text-is("Rename")');
  const input=page.locator('.nav-group-rename');
  const selected=await input.evaluate(el=>document.activeElement===el&&el.selectionStart===0&&el.selectionEnd===el.value.length);
  check('Rename turns the folder name into a focused, selected text field',()=>assert.equal(selected,true));
  await page.waitForTimeout(4300);
  const stillEditing=await input.evaluate(el=>document.activeElement===el).catch(()=>false);
  check('a background refresh does not interrupt renaming',()=>assert.equal(stillEditing,true));
  await page.keyboard.type('Backend work');
  await page.screenshot({path:path.join(OUT,'session-groups-rename.png'),clip:{x:0,y:380,width:300,height:200}});
  await page.keyboard.press('Enter');await page.waitForTimeout(150);
  const renamed=await page.locator('.nav-group-name').first().textContent(),focusAfter=await page.evaluate(()=>document.activeElement?.dataset.groupToggle||null);
  check('Enter saves the new name',()=>assert.equal(renamed,'Backend work'));
  check('focus returns to the folder header after renaming',()=>assert.ok(focusAfter));
  await page.locator('[data-group-toggle]').first().click({button:'right'});
  await page.click('#session-group-menu [role=menuitem]:text-is("Rename")');
  await page.keyboard.type('Discarded');await page.keyboard.press('Escape');await page.waitForTimeout(150);
  const kept=await page.locator('.nav-group-name').first().textContent();
  check('Escape cancels a rename',()=>assert.equal(kept,'Backend work'));

  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector(rowSel('grp-e'),{state:'attached'});await page.waitForTimeout(400);
  const afterReload=await layout(page);
  check('folders, their names, order and collapsed state survive a reload',()=>assert.deepEqual(afterReload,['grp-coord',folder('Backend work',['grp-a','grp-b','grp-c']),folder('Group 2',['grp-d','grp-e'],true)]));

  await page.focus(rowSel('grp-c'));await page.keyboard.press('Alt+ArrowDown');await page.waitForTimeout(150);
  const steppedOut=await layout(page);
  check('Alt+↓ on a folder\'s last member moves it out, just below the folder',()=>assert.deepEqual(steppedOut,['grp-coord',folder('Backend work',['grp-a','grp-b']),'grp-c',folder('Group 2',['grp-d','grp-e'],true)]));
  await page.keyboard.press('Alt+ArrowDown');await page.waitForTimeout(150);
  const jumped=await layout(page);
  check('Alt+↓ on an ungrouped session moves it over a whole folder, not into it',()=>assert.deepEqual(jumped,['grp-coord',folder('Backend work',['grp-a','grp-b']),folder('Group 2',['grp-d','grp-e'],true),'grp-c']));

  await drag(page,'[data-group-toggle] >> nth=1','[data-group-toggle] >> nth=0',0.15);
  const movedGroup=await layout(page);
  check('dragging a folder header above another folder moves the whole folder',()=>assert.deepEqual(movedGroup,['grp-coord',folder('Group 2',['grp-d','grp-e'],true),folder('Backend work',['grp-a','grp-b']),'grp-c']));

  await drag(page,rowSel('grp-b'),rowSel('grp-c'),0.9);
  const dissolved=await layout(page),groupsLeft=(await stored(page)).map(g=>g.name);
  check('dragging a member out leaves the folder, and a one-session folder dissolves',()=>assert.deepEqual(dissolved,['grp-coord',folder('Group 2',['grp-d','grp-e'],true),'grp-a','grp-c','grp-b']));
  check('the dissolved folder is removed from storage',()=>assert.deepEqual(groupsLeft,['Group 2']));

  await group2.locator('[data-group-toggle]').click();await page.waitForTimeout(150);
  await page.locator(rowSel('grp-a')).click({button:'right'});
  const ungroupedMenu=await page.$$eval('#session-group-menu:not([hidden]) [role=menuitem]',items=>items.map(item=>item.textContent));
  check('an ungrouped session\'s menu only offers moving it to a desk',()=>assert.deepEqual(ungroupedMenu,['Move to a new desk…']));
  await page.keyboard.press('Escape');
  await menu(page,rowSel('grp-e'),'Remove from group');
  const removed=await layout(page);
  check('"Remove from group" takes the session out below the folder, which then dissolves',()=>assert.deepEqual(removed,['grp-coord','grp-d','grp-e','grp-a','grp-c','grp-b']));

  await drag(page,rowSel('grp-a'),rowSel('grp-c'),0.5);
  const reused=await page.locator('.nav-group-name').first().textContent();
  check('a new folder reuses the lowest free number',()=>assert.equal(reused,'Group 1'));
  await menu(page,'[data-group-toggle] >> nth=0','Ungroup');
  const ungrouped=await layout(page);
  check('Ungroup removes the folder and leaves its sessions in place',()=>assert.deepEqual(ungrouped,['grp-coord','grp-d','grp-e','grp-c','grp-a','grp-b']));

  await drag(page,rowSel('grp-e'),rowSel('grp-d'),0.5);
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  const narrow=await page.evaluate(()=>{const frame=document.querySelector('.nav-group').getBoundingClientRect(),toggle=document.querySelector('[data-group-toggle]').getBoundingClientRect(),member=document.querySelector('.nav-group .session-entry').getBoundingClientRect();
    const row=document.querySelector('.nav-group .session-row').getBoundingClientRect();
    return {pageOverflow:document.documentElement.scrollWidth-innerWidth,toggleWidth:Math.round(toggle.width),membersBeside:member.left>=toggle.right-1&&Math.abs(member.top-frame.top)<4,
      frameSlack:Math.round(frame.bottom-row.bottom)};});
  check('at 390px folders sit in the session row without sideways page scroll',()=>{assert.equal(narrow.pageOverflow,0);assert.equal(narrow.toggleWidth,30);assert.ok(narrow.membersBeside,'members do not sit beside the folder tab');});
  check('at 390px the folder frame hugs its rows instead of filling the strip',()=>assert.ok(narrow.frameSlack>=0&&narrow.frameSlack<=3,'frame extends '+narrow.frameSlack+'px below its rows'));
  await page.screenshot({path:path.join(OUT,'session-groups-narrow.png'),clip:{x:0,y:0,width:390,height:300}});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push(error.message);console.log('  FAIL  '+error.stack);}
 finally{await browser.close();}
 if(failures.length){console.log(`\n${failures.length} failed`);process.exit(1);}
 console.log('\nsession-groups: all checks passed');
})();
