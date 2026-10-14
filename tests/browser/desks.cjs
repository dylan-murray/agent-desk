// Desks: named groups of sessions (say, one for work and one for personal projects), with one
// switcher to change the current view to any desk and to create a new one. Runs against a real isolated backend with real shell terminals: launches go
// through the launcher dialog, desks are made, renamed, switched and deleted from the switcher,
// a session is moved with a real right-click, and placement is read back from /api/agents.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const os=require('node:os');const path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const tag=Math.random().toString(36).slice(2,6);
const RESEARCH='Research '+tag,EXPERIMENTS='Experiments '+tag;
const rows=page=>page.$$eval('#agent-grid .session-row',nodes=>nodes.map(n=>n.querySelector('.session-name').textContent));
const panes=page=>page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>n.dataset.paneId));
const deskName=page=>page.textContent('#desk-button .desk-name');
const server=page=>page.evaluate(async()=>{const r=await fetch('/api/agents');return r.json();});
async function launchShellFromDialog(page){
  await page.click('#new-terminal');await page.click('[data-new-pane="terminal"]');
  await page.selectOption('#terminal-harness','shell');
  await page.evaluate(()=>{const project=document.getElementById('terminal-project');if([...project.options].some(o=>o.value==='manual'))project.value='manual';document.getElementById('terminal-cwd').value=os_tmp;});
  const before=new Set(await panes(page));
  await page.click('#launch-terminal-form button[type=submit]');
  await page.waitForFunction(count=>document.querySelectorAll('#terminal .terminal-pane').length>count,before.size,{timeout:15000});
  return (await panes(page)).find(id=>!before.has(id));
}
async function pickDesk(page,name){
  await page.click('#desk-button');
  await page.click(`#desk-menu [data-desk-id]:has(.desk-option-name:text-is("${name}"))`);
  await page.waitForTimeout(300);
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  await context.addInitScript(dir=>{window.os_tmp=dir;},os.tmpdir().replace(/\/$/,''));
  page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForSelector('#desk-button .desk-name');await page.waitForTimeout(800);
  const first=await page.evaluate(()=>({id:desks[0].id,name:desks[0].name}));
  // A fresh tab opens the first session it finds; close it so only this run's panes count.
  for(const close of await page.$$('#terminal .pane-close'))await close.click();
  const opened=await deskName(page);
  check('a fresh tab opens on the first desk',()=>assert.equal(opened,first.name));

  // Two sessions on the first desk: one from the launcher dialog, one more for moving later.
  const alpha=await launchShellFromDialog(page);launched.push(alpha);
  const bravo=await page.evaluate(async()=>(await terminalRequest('/api/terminals/launch',{cwd:os_tmp,argv:['/bin/sh'],name:'Bravo shell',desk:activeDesk().id})).id);launched.push(bravo);
  await page.evaluate(()=>refresh());await page.waitForTimeout(300);
  await page.click(`.session-row[data-agent-id="${bravo}"]`,{modifiers:['Shift']});
  const firstPanes=await panes(page);
  check('sessions started on the first desk are open there',()=>assert.deepEqual(new Set(firstPanes),new Set([alpha,bravo])));
  await page.screenshot({path:path.join(OUT,'desks-01-first.png')});

  // A new desk, made from the same switcher.
  await page.click('#desk-button');
  const menu=await page.$$eval('#desk-menu [role=menuitemradio]',nodes=>nodes.map(n=>({name:n.querySelector('.desk-option-name').textContent,checked:n.getAttribute('aria-checked')})));
  check('the switcher lists desks with the current one checked',()=>assert.deepEqual(menu.find(d=>d.name===first.name),{name:first.name,checked:'true'}));
  await page.click('[data-desk-new]');
  const focused=await page.evaluate(()=>document.activeElement?.matches('[data-desk-new-input]'));
  check('New desk turns into a focused name field',()=>assert.equal(focused,true));
  await page.keyboard.type(RESEARCH);await page.keyboard.press('Enter');
  await page.waitForFunction(name=>document.querySelector('#desk-button .desk-name')?.textContent===name,RESEARCH);
  const research=await page.evaluate(()=>activeDesk().id);
  const fresh=[await rows(page),await panes(page)];
  check('creating a desk switches to it, with an empty sidebar and no panes',()=>assert.deepEqual(fresh,[[],[]]));
  await page.screenshot({path:path.join(OUT,'desks-02-new-desk.png')});

  const researcher=await launchShellFromDialog(page);launched.push(researcher);
  await page.click('#pane-layout-button');await page.click('[data-layout=columns]');
  let data=await server(page);
  check('a terminal launched on a desk is placed on it by the server',()=>assert.equal(data.agents.find(a=>a.id===researcher).desk,research));
  check('...and the first desk\'s sessions stay on the first desk',()=>assert.deepEqual([alpha,bravo].map(id=>data.agents.find(a=>a.id===id).desk),[first.id,first.id]));
  const own=await page.$$eval('#agent-grid .session-row',n=>n.map(x=>x.dataset.agentId));
  check('the new desk lists only its own session',()=>assert.deepEqual(own,[researcher]));

  // Switching back restores that desk's panes and layout; switching again restores this one's.
  await pickDesk(page,first.name);
  const backPanes=await panes(page),backLayout=await page.textContent('#pane-layout-label');
  check('switching back reopens the first desk\'s panes',()=>assert.deepEqual(new Set(backPanes),new Set([alpha,bravo])));
  check('each desk keeps its own layout',()=>assert.notEqual(backLayout.trim(),'Columns'));
  await pickDesk(page,RESEARCH);
  const again=[await panes(page),(await page.textContent('#pane-layout-label')).trim()];
  check('switching again reopens the other desk\'s pane and layout',()=>assert.deepEqual(again,[[researcher],'Columns']));
  // The PTY still answers after its pane was put away and brought back.
  await page.click(`.terminal-pane[data-pane-id="${researcher}"] .xterm`);
  await page.keyboard.type('echo desk-$((40+2))');await page.keyboard.press('Enter');
  await page.waitForFunction(id=>{const buffer=paneViews.get(id)?.term?.buffer.active;if(!buffer)return false;for(let i=0;i<buffer.length;i++)if(buffer.getLine(i)?.translateToString(true).includes('desk-42'))return true;return false;},researcher,{timeout:10000});
  check('a terminal brought back by a desk switch still takes input',()=>{});

  // The choice belongs to this tab: a reload keeps it, a new tab opens the last desk used,
  // and switching in one tab does not move the other.
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(1200);
  const reloaded=await deskName(page);
  check('a reload stays on the same desk',()=>assert.equal(reloaded,RESEARCH));
  const other=await context.newPage();other.on('pageerror',error=>errors.push(error.message));
  await other.goto(APP,{waitUntil:'domcontentloaded'});await other.waitForTimeout(1200);
  const newTab=await deskName(other);
  check('a new tab opens the last desk used',()=>assert.equal(newTab,RESEARCH));
  await pickDesk(other,first.name);
  await page.evaluate(()=>refresh());await page.waitForTimeout(300);
  const stayed=await deskName(page);
  check('switching in one tab leaves the other where it was',()=>assert.equal(stayed,RESEARCH));
  await other.close();

  // Moving a session to another desk with a right-click.
  await pickDesk(page,first.name);
  // Scroll first: the list closes an open menu when it scrolls, as a click on a far row would make it.
  // The list re-renders on every refresh, so find and scroll the row in one step rather than through a held locator.
  await page.evaluate(id=>document.querySelector(`.session-row[data-agent-id="${id}"]`)?.scrollIntoView({block:'nearest'}),bravo);await page.waitForTimeout(150);
  await page.click(`.session-row[data-agent-id="${bravo}"]`,{button:'right'});
  const items=await page.$$eval('#session-group-menu [role=menuitem]',n=>n.map(x=>x.textContent));
  check('a session\'s menu offers the other desks and a new one, never its own',()=>{
    assert.ok(items.includes('Move to '+RESEARCH));assert.equal(items.at(-1),'Move to a new desk…');assert.equal(items.includes('Move to '+first.name),false);});
  await page.click(`#session-group-menu [role=menuitem]:text-is("Move to ${RESEARCH}")`);
  await page.waitForFunction(id=>!document.querySelector(`.session-row[data-agent-id="${id}"]`),bravo);
  data=await server(page);
  const left=await panes(page);
  check('the moved session leaves this desk\'s sidebar and panes',()=>assert.deepEqual(left,[alpha]));
  check('the server has it on the other desk',()=>assert.equal(data.agents.find(a=>a.id===bravo).desk,research));

  // Someone on another desk needs you: the switcher and the banner say so, and the banner
  // takes you there.
  await pickDesk(page,RESEARCH);
  await page.route('**/api/agents',async route=>{const response=await route.fetch(),json=await response.json();
    json.agents.push({id:'desk-asker',name:'Asker',display_name:'Asker',harness:'claude',status:'needs_input',question:'Approve the order?',source:'adapter',project:'fixture',cwd:'/tmp',events:[],desk:first.id,updated:Date.now()/1000});
    route.fulfill({response,json});});
  await page.evaluate(()=>refresh());await page.waitForTimeout(400);
  const badge=await page.$eval('#desk-elsewhere',n=>({hidden:n.hidden,count:n.textContent.trim(),label:n.getAttribute('aria-label')}));
  check('the switcher counts sessions on other desks that need you',()=>assert.deepEqual(badge,{hidden:false,count:'1',label:'1 session on other desks needs you'}));
  const banner=await page.textContent('#session-attention');
  check('the alert names the desk the session is on',()=>assert.match(banner,new RegExp('Asker · '+first.name+' →')));
  await page.screenshot({path:path.join(OUT,'desks-03-elsewhere.png')});
  await page.click('#session-attention button:has-text("Asker")');await page.waitForTimeout(300);
  const followed=await deskName(page);
  check('opening it from the alert switches to its desk',()=>assert.equal(followed,first.name));
  await page.unroute('**/api/agents');await page.evaluate(()=>refresh());await page.waitForTimeout(300);

  // Rename and delete from the menu.
  await page.click('#desk-button');
  await page.hover(`#desk-menu .desk-option:has(.desk-option-name:text-is("${RESEARCH}"))`);
  await page.screenshot({path:path.join(OUT,'desks-04-menu.png')});
  await page.click(`#desk-menu [aria-label="Rename ${RESEARCH}"]`);
  await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type(EXPERIMENTS);await page.keyboard.press('Enter');
  await page.waitForSelector(`#desk-menu .desk-option-name:text-is("${EXPERIMENTS}")`);
  check('a desk renames in place',()=>{});
  await page.click(`#desk-menu [aria-label="Delete ${EXPERIMENTS}"]`);
  const dialog=await page.$eval('#delete-desk-dialog',n=>({open:n.open,title:n.querySelector('h2').textContent,detail:n.querySelector('.desk-delete-detail').textContent,target:n.querySelector('#delete-desk-target').selectedOptions[0].textContent}));
  check('deleting asks first and says where its sessions go',()=>assert.deepEqual(dialog,{open:true,title:`Delete the “${EXPERIMENTS}” desk?`,detail:'Its 2 sessions keep running and move to the desk you choose.',target:first.name}));
  await page.screenshot({path:path.join(OUT,'desks-05-delete.png')});
  await page.click('#confirm-delete-desk');await page.waitForTimeout(600);
  data=await server(page);
  check('the deleted desk is gone and its sessions are on the chosen desk, still running',()=>{
    assert.equal(data.desks.some(d=>d.name===EXPERIMENTS),false);
    assert.deepEqual([researcher,bravo].map(id=>{const a=data.agents.find(x=>x.id===id);return [a.desk,a.exit_code];}),[[first.id,null],[first.id,null]]);
  });
  const after=await page.$$eval('#agent-grid .session-row',n=>n.map(x=>x.dataset.agentId));
  check('...and show in this desk\'s sidebar',()=>{for(const id of [alpha,bravo,researcher])assert.ok(after.includes(id),id);});

  // Narrow layout: the logo keeps its centred row; the switcher spans the row under it.
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  await page.click('#desk-button');await page.waitForTimeout(150);
  const narrow=await page.evaluate(()=>{const brand=document.querySelector('.sidebar .brand').getBoundingClientRect(),button=document.getElementById('desk-button').getBoundingClientRect(),menu=document.getElementById('desk-menu').getBoundingClientRect(),search=document.querySelector('.sidebar .search').getBoundingClientRect();
    return {belowLogo:button.top>=brand.bottom-1,aboveSessions:button.bottom<=search.top,fullWidth:document.getElementById('desk-switcher').getBoundingClientRect().width>=innerWidth-40,menuOnScreen:menu.left>=0&&menu.right<=innerWidth};});
  check('on a phone the switcher is a full-width row between the logo and the sessions, and its menu stays on screen',()=>assert.deepEqual(narrow,{belowLogo:true,aboveSessions:true,fullWidth:true,menuOnScreen:true}));
  await page.screenshot({path:path.join(OUT,'desks-06-narrow.png')});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push('run');console.log('  FAIL  run :: '+(error.stack||error.message));}
 finally{
  if(page){
    for(const id of launched)await page.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
    // A run that failed part way must not leave its desks behind for the next run.
    await page.evaluate(async tag=>{const {desks:list}=await (await fetch('/api/agents')).json();
      for(const desk of list.filter(d=>d.name.endsWith(' '+tag)))await terminalRequest('/api/desks/delete',{id:desk.id,move_to:list[0].id}).catch(()=>{});},tag).catch(()=>{});
  }
  await browser.close();
 }
 if(failures.length){console.log(`${failures.length} desk check(s) failed`);process.exit(1);}
 console.log('All desk checks passed · screenshots in '+OUT);
})();
