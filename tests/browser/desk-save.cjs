// Saving a desk and reopening it: Save & close from the desk switcher stops everything on a desk and
// keeps it in the menu; choosing it brings its panes back, in the same layout and sizes, with each
// agent resuming its conversation. Runs against a real isolated backend with real terminals. No agent
// runs: a stand-in `codex` prints its arguments and holds a fixture rollout file open, which is how
// restart recovery recognizes a Codex conversation, so reopening must start it with `resume <id>`.
// A shell, a command that is not re-run, a coordinator (its quota is mocked) and a web page come too.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const tag=Math.random().toString(36).slice(2,6);
const DESK='Saved '+tag;
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-save-')));
const alpha=path.join(root,'alpha'),beta=path.join(root,'beta'),gamma=path.join(root,'gamma');for(const f of [alpha,beta,gamma])fs.mkdirSync(f);
const conversation=crypto.randomUUID(),rollout=path.join(root,'codex-home','sessions','2026','10','29',`rollout-2026-10-29T00-00-00-${conversation}.jsonl`);
fs.mkdirSync(path.dirname(rollout),{recursive:true});fs.writeFileSync(rollout,'{"payload":{}}\n');
const fakeCodex=path.join(root,'bin','codex');fs.mkdirSync(path.dirname(fakeCodex));
fs.writeFileSync(fakeCodex,`#!/bin/sh\nprintf 'fake-codex args: %s\\n' "$*"\nexec 3<'${rollout}'\nexec /bin/sh\n`,{mode:0o755});
const panes=page=>page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>n.dataset.paneId));
const deskName=page=>page.textContent('#desk-button .desk-name');
const agentsNow=page=>page.evaluate(async()=>(await fetch('/api/agents')).json());
// Lines the terminal wrapped are joined back, so a long line is found whatever the pane's width.
const bufferHas=(page,id,text)=>page.waitForFunction(([id,text])=>{const buffer=paneViews.get(id)?.term?.buffer.active;if(!buffer)return false;let all='';for(let i=0;i<buffer.length;i++){const line=buffer.getLine(i);all+=(line?.isWrapped?'':'\n')+(line?.translateToString(true)||'');}return all.includes(text);},[id,text],{timeout:15000});
const outcomes=page=>page.$$eval('#shutdown-desk-dialog .desk-shutdown-list li',nodes=>Object.fromEntries(nodes.map(n=>[n.dataset.shutdownId,[n.querySelector('.desk-shutdown-outcome').textContent,n.querySelector('.desk-shutdown-outcome').title]])));
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[],coordinators=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  // A coordinator pane asks for its account's quota; answer with a fixture so no real account is read.
  await page.route('**/api/coordinators/quota',route=>route.fulfill({json:{state:'unsupported',label:'Fixture',windows:[],message:'Fixture account: quota not read'}}));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForSelector('#desk-button .desk-name');await page.waitForTimeout(800);
  const home=await page.evaluate(()=>activeDesk().name);

  await page.click('#desk-button');await page.click('[data-desk-new]');await page.keyboard.type(DESK);await page.keyboard.press('Enter');
  await page.waitForFunction(name=>document.querySelector('#desk-button .desk-name')?.textContent===name,DESK);
  const ids=await page.evaluate(async([alpha,beta,gamma,codex])=>{
    const launch=async body=>{const s=await terminalRequest('/api/terminals/launch',{desk:activeDesk().id,...body});return s.id;};
    const shell=await launch({cwd:alpha,name:'Shell'}),agent=await launch({cwd:beta,argv:[codex],name:'Codex'}),cat=await launch({cwd:gamma,argv:['/bin/cat'],name:'Cat'});
    await terminalRequest('/api/terminals/rename',{id:agent,name:'Codex fixture'});
    const coordinator=(await terminalRequest('/api/coordinators/create',{desk:activeDesk().id,name:'Planner',cwd:alpha,profile:'claude',model:'fixture-model'})).id;
    await refresh();for(const id of [shell,agent,cat,coordinator])selectPane(id,true);
    openWebPage('http://127.0.0.1:9/fixture-docs','Fixture docs',{quiet:true});
    return {shell,agent,cat,coordinator};
  },[alpha,beta,gamma,fakeCodex]);
  launched.push(ids.shell,ids.agent,ids.cat);coordinators.push(ids.coordinator);
  await page.waitForFunction(()=>document.querySelectorAll('#terminal .terminal-pane').length===5);
  await page.click('#pane-layout-button');await page.click('[data-layout="grid-3"]');
  await page.focus(`.pane-edges[data-edges-for="${ids.shell}"] .pane-resize[data-edge=se]`);await page.keyboard.press('ArrowRight');await page.waitForTimeout(300);
  const before=await page.evaluate(()=>({ids:[...openPaneIds],rects:JSON.parse(JSON.stringify(resolvePaneRects(openPaneIds))),page:openPaneIds.find(id=>webPages.has(id))}));
  await bufferHas(page,ids.agent,'fake-codex args: --no-daemon');
  check('the stand-in codex started as a standalone Codex session',()=>{});
  // Restart recovery samples conversations every few seconds; wait until it has this one.
  for(let tries=0;!(await page.evaluate(async id=>(await terminalRequest('/api/desks/save-preview',{ids:[id]})).sessions[0]?.resumes,ids.agent));tries++){
    if(tries>20)throw Error('the stand-in Codex conversation was never captured');await page.waitForTimeout(1000);}
  await page.screenshot({path:path.join(OUT,'desk-save-01-desk.png')});

  // Save & close, from the switcher.
  await page.click('#desk-button');
  const item=await page.$eval('[data-desk-save]',n=>({text:n.textContent,disabled:n.disabled}));
  check('the desk menu offers Save & close under New desk',()=>assert.deepEqual(item,{text:'Save & close desk',disabled:false}));
  await page.screenshot({path:path.join(OUT,'desk-save-02-menu.png')});
  await page.click('[data-desk-save]');await page.waitForSelector('#shutdown-desk-dialog[open]');
  const dialog=await page.evaluate(()=>({title:document.querySelector('#shutdown-desk-dialog h2').textContent,confirm:document.getElementById('confirm-shutdown-desk').textContent,primary:document.getElementById('confirm-shutdown-desk').classList.contains('primary')}));
  const rows=await outcomes(page),field=await page.inputValue('#save-desk-name');
  check('the save dialog names the desk and has one primary action',()=>assert.deepEqual(dialog,{title:'Save and close this desk',confirm:'Save & close',primary:true}));
  check('...offers to rename it, starting from its name',()=>assert.equal(field,DESK));
  check('...and says what each session comes back as',()=>{
    assert.deepEqual(rows[ids.agent],['Saves · resumes',`On reopen: resumes Codex conversation ${conversation}`]);
    assert.deepEqual(rows[ids.shell],['Saves · starts fresh','On reopen: starts a new shell in the same folder']);
    assert.deepEqual(rows[ids.cat],['Saves · starts fresh','On reopen: starts a shell instead of re-running cat']);
    assert.equal(rows[ids.coordinator][0],'Saves · reopens');
  });
  await page.screenshot({path:path.join(OUT,'desk-save-03-dialog.png')});
  await page.click('#confirm-shutdown-desk');
  await page.waitForFunction(()=>!document.getElementById('shutdown-desk-dialog').open,null,{timeout:20000});
  let data=await agentsNow(page);
  const saved=data.desks.find(d=>d.name===DESK),after=await deskName(page);
  check('saving moves this tab to an open desk',()=>assert.equal(after,home));
  check('...and the server keeps the desk, marked saved',()=>assert.equal(typeof saved?.saved_at,'number'));
  check('...with its terminals stopped and its coordinator closed',()=>{
    for(const id of [ids.shell,ids.agent,ids.cat]){const a=data.agents.find(x=>x.id===id);assert.ok(!a||a.exit_code!==null,id);}
    assert.equal(data.agents.some(a=>a.id===ids.coordinator),false);
  });
  await page.click('#desk-button');
  const menu=await page.evaluate(name=>{const row=[...document.querySelectorAll('#desk-menu .desk-option.saved')].find(r=>r.textContent.includes(name));return {tag:row?.querySelector('.desk-option-saved')?.textContent,save:document.querySelector('[data-desk-save]').disabled,saveTitle:document.querySelector('[data-desk-save]').title};},DESK);
  check('the menu lists it as Saved',()=>assert.equal(menu.tag,'Saved'));
  check('...and will not save the last open desk',()=>assert.deepEqual([menu.save,menu.saveTitle],[true,'Open another desk first: the last open desk cannot be saved and closed']));
  await page.screenshot({path:path.join(OUT,'desk-save-04-saved-menu.png')});

  // Reopen it.
  await page.click(`#desk-menu [data-desk-reopen="${saved.id}"]`);
  await page.waitForFunction(name=>document.querySelector('#desk-button .desk-name')?.textContent===name&&document.querySelectorAll('#terminal .terminal-pane').length===5&&document.getElementById('toast').textContent.startsWith('Reopened'),DESK,{timeout:20000});
  const reopened=await page.evaluate(()=>({ids:[...openPaneIds],rects:JSON.parse(JSON.stringify(paneRects||{})),layout:paneLayoutId,toast:document.getElementById('toast').textContent,pageUrl:webPages.get(openPaneIds.at(-1))?.url}));
  for(const id of reopened.ids)if(id.startsWith('terminal-'))launched.push(id);
  check('reopening switches to the desk with all five panes back',()=>assert.equal(reopened.ids.length,5));
  check('...in the same layout and sizes',()=>{assert.equal(reopened.layout,'grid-3');assert.deepEqual(reopened.ids.map(id=>reopened.rects[id]),before.ids.map(id=>before.rects[id]));});
  check('...and says how many resumed',()=>assert.equal(reopened.toast,`Reopened “${DESK}” · 2 resumed, 2 started fresh`));
  const [newShell,newAgent,newCat,coordinator,webPage]=reopened.ids;
  data=await agentsNow(page);
  const byId=Object.fromEntries(data.agents.map(a=>[a.id,a]));
  check('the terminals are new sessions in their folders, on the desk',()=>{
    assert.deepEqual([newShell,newAgent,newCat].map(id=>[id!==ids.shell&&id!==ids.agent&&id!==ids.cat,byId[id].cwd,byId[id].desk,byId[id].exit_code]),[[true,alpha,saved.id,null],[true,beta,saved.id,null],[true,gamma,saved.id,null]]);
  });
  check('...the coordinator is the same conversation, reopened',()=>assert.deepEqual([coordinator,byId[coordinator]?.desk],[ids.coordinator,saved.id]));
  check('...and the web page comes back',()=>assert.deepEqual([webPage,reopened.pageUrl],[before.page,'http://127.0.0.1:9/fixture-docs']));
  await bufferHas(page,newAgent,`fake-codex args: --no-daemon resume ${conversation}`);
  check('Codex resumes its exact conversation',()=>{});
  check('...under the name it was given',()=>assert.equal(byId[newAgent].display_name||byId[newAgent].name,'Codex fixture'));
  await page.click(`.terminal-pane[data-pane-id="${newCat}"] .xterm`);
  await page.keyboard.type('echo reopened-$((40+2))');await page.keyboard.press('Enter');
  await bufferHas(page,newCat,'reopened-42');
  check('a command that is not re-run comes back as a working shell',()=>{});
  await page.screenshot({path:path.join(OUT,'desk-save-05-reopened.png')});

  // A folder that is gone: that session is reported and everything else still reopens.
  await page.click('#desk-button');await page.click('[data-desk-save]');await page.waitForSelector('#shutdown-desk-dialog[open]');
  await page.click('#confirm-shutdown-desk');await page.waitForFunction(()=>!document.getElementById('shutdown-desk-dialog').open,null,{timeout:20000});
  fs.renameSync(gamma,gamma+'-moved');
  await page.click('#desk-button');await page.click(`#desk-menu [data-desk-reopen="${saved.id}"]`);
  await page.waitForSelector('#shutdown-desk-dialog[open]',{timeout:20000});
  const report=await page.evaluate(()=>({title:document.querySelector('#shutdown-desk-dialog h2').textContent,rows:[...document.querySelectorAll('#shutdown-desk-dialog .desk-shutdown-list li')].map(li=>[li.querySelector('strong').textContent,li.querySelector('small').textContent,li.querySelector('.desk-shutdown-outcome').textContent]),confirm:document.getElementById('confirm-shutdown-desk').hidden,panes:[...openPaneIds]}));
  for(const id of report.panes)if(id.startsWith('terminal-'))launched.push(id);
  check('a session whose folder is gone is named with the reason',()=>{
    assert.equal(report.title,`“${DESK}” reopened with 3 of 4 sessions`);
    assert.deepEqual(report.rows,[['Cat','Choose an existing absolute working directory','Not reopened']]);
    assert.equal(report.confirm,true);
  });
  check('...and the rest are open',()=>assert.equal(report.panes.length,4));
  await page.screenshot({path:path.join(OUT,'desk-save-06-reopen-failure.png')});
  await page.click('#shutdown-desk-dialog .close-dialog');

  // Leaving a session out while saving: it stops with the rest but does not come back.
  data=await agentsNow(page);
  const shellNow=data.agents.find(a=>a.cwd===alpha&&a.desk===saved.id&&a.exit_code===null&&a.id.startsWith('terminal-')).id;
  await page.click('#desk-button');await page.click('[data-desk-save]');await page.waitForSelector('#shutdown-desk-dialog[open]');
  const confirmText=()=>page.textContent('#confirm-shutdown-desk');
  const dropButton=`#shutdown-desk-dialog [data-shutdown-drop="${shellNow}"]`;
  const offered=await page.$$eval('#shutdown-desk-dialog [data-shutdown-drop]',nodes=>nodes.map(n=>[n.title,!!n.querySelector('svg'),n.getAttribute('aria-label').startsWith('Don\'t save ')]));
  check('every session that would be saved has an × to leave it out',()=>assert.deepEqual(offered,Array(3).fill(['Don\'t save',true,true])));
  await page.click(dropButton);
  const left=await page.evaluate(id=>{const li=document.querySelector(`#shutdown-desk-dialog [data-shutdown-id="${id}"]`);return {tag:li.querySelector('.desk-shutdown-outcome').textContent,button:li.querySelector('[data-shutdown-drop]').title,focused:document.activeElement===li.querySelector('[data-shutdown-drop]')};},shellNow);
  check('leaving one out says it stops and is not reopened',()=>assert.deepEqual(left,{tag:'Stops · not reopened',button:'Save it after all',focused:true}));
  const counted=await confirmText();
  check('...and the button counts what is saved',()=>assert.equal(counted,'Save 2 of 3 & close'));
  await page.click(dropButton);
  const back=[await confirmText(),await page.getAttribute(dropButton,'title')];
  check('...and it can be put back',()=>assert.deepEqual(back,['Save & close','Don\'t save']));
  await page.click(dropButton);
  // Renamed while saving; Enter in the name saves.
  const RENAMED='Later '+tag;
  await page.fill('#save-desk-name',RENAMED);
  await page.screenshot({path:path.join(OUT,'desk-save-07-leave-out.png')});
  await page.press('#save-desk-name','Enter');await page.waitForFunction(()=>!document.getElementById('shutdown-desk-dialog').open,null,{timeout:20000});
  const savedToast=await page.textContent('#toast'),savedAs=(await agentsNow(page)).desks.find(d=>d.id===saved.id).name;
  await page.click('#desk-button');await page.click(`#desk-menu [data-desk-reopen="${saved.id}"]`);
  await page.waitForFunction(()=>document.getElementById('toast').textContent.startsWith('Reopened'),null,{timeout:20000});
  const without=await page.evaluate(()=>[...openPaneIds]),reopenedAs=await deskName(page);
  for(const id of without)if(id.startsWith('terminal-'))launched.push(id);
  data=await agentsNow(page);
  check('the desk was saved and reopened under its new name',()=>assert.deepEqual([savedToast,savedAs,reopenedAs],[`Saved “${RENAMED}” · reopen it from the desk menu`,RENAMED,RENAMED]));
  check('the session left out does not come back, and the rest do',()=>{
    assert.equal(without.length,3);
    assert.equal(data.agents.some(a=>a.cwd===alpha&&a.desk===saved.id&&a.exit_code===null&&a.id.startsWith('terminal-')),false);
  });

  // A coordinator's worker: the coordinator keeps it, so it sits under it with no × of its own.
  const worker=await page.evaluate(async([parent,cwd])=>(await terminalRequest('/api/terminals/launch',{desk:activeDesk().id,cwd,argv:['/bin/cat'],name:'Worker 1',parent_id:parent})).id,[ids.coordinator,beta]);
  launched.push(worker);await page.evaluate(()=>refresh());
  await page.click('#desk-button');await page.click('[data-desk-save]');await page.waitForSelector('#shutdown-desk-dialog[open]');
  const workerRow=await page.evaluate(([worker,lead])=>{const items=[...document.querySelectorAll('#shutdown-desk-dialog .desk-shutdown-list li')],li=items.find(n=>n.dataset.shutdownId===worker);
    return {after:items[items.indexOf(li)-1]?.dataset.shutdownId===lead,child:li.classList.contains('child'),tag:li.querySelector('.desk-shutdown-outcome').textContent,why:li.querySelector('.desk-shutdown-outcome').title,x:!!li.querySelector('[data-shutdown-drop]')};},[worker,ids.coordinator]);
  check('a coordinator\'s worker sits under it, saved with it, with no × of its own',()=>assert.deepEqual(workerRow,{after:true,child:true,tag:'Saves · with coordinator',why:'Planner keeps this conversation and can resume it once the desk reopens. Leave out Planner to leave this out too.',x:false}));
  await page.hover(`#shutdown-desk-dialog [data-shutdown-drop="${ids.coordinator}"]`);
  const red=await page.$eval(`#shutdown-desk-dialog [data-shutdown-drop="${ids.coordinator}"]`,n=>getComputedStyle(n).color);
  check('the × turns red on hover',()=>assert.equal(red,'rgb(238, 152, 152)'));
  await page.click(`#shutdown-desk-dialog [data-shutdown-drop="${ids.coordinator}"]`);
  const workerLeft=await page.$eval(`#shutdown-desk-dialog [data-shutdown-id="${worker}"] .desk-shutdown-outcome`,n=>n.textContent);
  check('...and leaving the coordinator out leaves its worker out',()=>assert.equal(workerLeft,'Stops · not reopened'));
  await page.click('#shutdown-desk-dialog .close-dialog');

  // Narrow screens.
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  await page.click('#desk-button');await page.click('[data-desk-save]');await page.waitForSelector('#shutdown-desk-dialog[open]');
  const narrow=await page.evaluate(()=>{const d=document.getElementById('shutdown-desk-dialog').getBoundingClientRect();return {fits:d.left>=0&&d.right<=innerWidth,wide:document.documentElement.scrollWidth<=innerWidth};});
  check('on a phone the save dialog fits the screen',()=>assert.deepEqual(narrow,{fits:true,wide:true}));
  await page.screenshot({path:path.join(OUT,'desk-save-08-narrow.png')});
  await page.click('#shutdown-desk-dialog .close-dialog');
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push('run');console.log('  FAIL  run :: '+(error.stack||error.message));await page?.screenshot({path:path.join(OUT,'desk-save-failure.png')}).catch(()=>{});}
 finally{
  if(page){
    for(const id of launched)await page.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
    for(const id of coordinators)await page.evaluate(id=>terminalRequest('/api/coordinators/close',{id}).catch(()=>{}),id).catch(()=>{});
    await page.evaluate(async tag=>{const {desks:list}=await (await fetch('/api/agents')).json();const keep=list.find(d=>!d.name.endsWith(' '+tag));
      for(const desk of list.filter(d=>d.name.endsWith(' '+tag)))await terminalRequest('/api/desks/delete',{id:desk.id,move_to:keep.id}).catch(()=>{});},tag).catch(()=>{});
  }
  await browser.close();
  fs.rmSync(root,{recursive:true,force:true});
 }
 if(failures.length){console.log(`${failures.length} desk save check(s) failed`);process.exit(1);}
 console.log('All desk save checks passed · screenshots in '+OUT);
})();
