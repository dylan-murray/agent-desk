// A tool docks inside its agent's terminal pane rather than living on a separate page.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const A=(id,name,o={})=>({id,name,terminal_id:id,parent_id:null,harness:'claude',status:'idle',source:'terminal',exit_code:null,
  cwd:'/tmp/'+id,project:'fixture',task:'Interactive terminal',events:[],question:null,updated:Date.now()/1000,...o});
const T=(id,title,o={})=>({id,title,skill:'diagram-doc-creator',url:'http://127.0.0.1:49401/'+id,endpoint:'/apps/'+id,status:'running',managed:false,context:'/tmp/'+id+'.html',...o});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const agents=[A('pane-a','Builder'),A('pane-b','Reviewer'),A('pane-c','Closed agent')];
  let uis=[T('tool-a','Sample-data reconciliation',{agent_id:'pane-a'}),T('tool-loose','Example project · Architecture')];
  await page.route('http://127.0.0.1:49401/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>tool</title><h1>Fixture tool</h1>'}));
  const calls=[];
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   if(['/api/tools/stop','/api/tools/forget'].includes(path)){const id=JSON.parse(route.request().postData()).id;calls.push([path,id]);
    uis=path==='/api/tools/stop'?uis.map(ui=>ui.id===id?{...ui,status:'stopped'}:ui):uis.filter(ui=>ui.id!==id);return route.fulfill({json:{ok:true}});}
   const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis},'/api/tool-launchers':{launchers:[]},'/api/web-pages/check':{reachable:true,embeddable:true},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(ids=>{if(!sessionStorage.getItem('agent-desk-panes-live'))sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids));},['pane-a','pane-b']);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('[data-pane-id="pane-a"] .pane-tool-toggle');
  const pane=page.locator('[data-pane-id="pane-a"]');
  const state=()=>page.evaluate(()=>{const n=document.querySelector('[data-pane-id="pane-a"]'),main=n.querySelector('.pane-main'),dock=n.querySelector('.pane-dock');
   return {chip:n.querySelector('.pane-tool-toggle')?.textContent,pressed:n.querySelector('.pane-tool-toggle')?.getAttribute('aria-pressed'),
    shown:!!dock&&!dock.hidden,bottom:main.classList.contains('dock-bottom'),size:main.style.getPropertyValue('--dock-size'),
    frame:dock?.querySelector('iframe').getAttribute('src'),valuenow:n.querySelector('.pane-divider')?.getAttribute('aria-valuenow'),
    otherChip:!!document.querySelector('[data-pane-id="pane-b"] .pane-tool-toggle')};});

  const first=await state();
  check('a pane whose agent opened a tool shows it in the header, closed until asked',()=>{
   assert.equal(first.chip,'Sample-data reconciliation');assert.equal(first.pressed,'false');assert.equal(first.shown,false);
   assert.equal(first.otherChip,false,'a pane with no tools of its own has no tool chip');
  });

  await pane.locator('.pane-tool-toggle').click();
  const open=await state();
  check('the chip docks the tool beside the terminal, half and half',()=>{
   assert.equal(open.pressed,'true');assert.equal(open.shown,true);assert.equal(open.bottom,false);
   assert.equal(open.size,'50.0%');assert.equal(open.frame,'http://127.0.0.1:49401/tool-a');
  });
  const split=await page.evaluate(()=>{const n=document.querySelector('[data-pane-id="pane-a"]'),body=n.querySelector('.pane-body').getBoundingClientRect(),dock=n.querySelector('.pane-dock').getBoundingClientRect();return {bodyRight:body.right,dockLeft:dock.left,bodyWidth:body.width,dockWidth:dock.width};});
  check('terminal and tool sit side by side without overlapping',()=>{
   assert.ok(split.bodyRight<=split.dockLeft+1,'the tool overlaps the terminal');assert.ok(Math.abs(split.bodyWidth-split.dockWidth)<8);
  });

  await pane.locator('.pane-divider').focus();await page.keyboard.press('ArrowLeft');await page.keyboard.press('ArrowLeft');
  const wider=await state();
  check('the divider resizes from the keyboard and reports its value',()=>{assert.equal(wider.size,'60.0%');assert.equal(wider.valuenow,'60');});

  await pane.locator('.pane-dock-side').click();
  const below=await state();
  check('the tool can dock below instead',()=>{assert.equal(below.bottom,true);assert.equal(below.shown,true);});

  await pane.locator('.pane-dock-hide').click();
  const hidden=await state();
  const frameNode=await pane.locator('.pane-dock-frame').evaluate(n=>{n.dataset.marker='kept';return true;});
  await pane.locator('.pane-tool-toggle').click();
  const kept=await pane.locator('.pane-dock-frame').getAttribute('data-marker');
  check('hiding keeps the tool loaded, so reopening does not reset it',()=>{
   assert.equal(hidden.shown,false);assert.equal(hidden.pressed,'false');assert.ok(frameNode);assert.equal(kept,'kept');
  });

  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForSelector('[data-pane-id="pane-a"] .pane-dock:not([hidden])');
  const reloaded=await state();
  check('a reload keeps the tool docked where it was',()=>{assert.equal(reloaded.bottom,true);assert.equal(reloaded.size,'60.0%');assert.equal(reloaded.pressed,'true');});

  // A new tool from an agent with an open pane docks there on its own, and the chip offers both.
  uis=[...uis,T('tool-b','Readme review',{agent_id:'pane-b'})];
  await page.waitForSelector('[data-pane-id="pane-b"] .pane-dock:not([hidden])',{timeout:10000});
  const page2=await page.evaluate(()=>document.querySelector('#breadcrumb').textContent);
  check('a tool that appears while its agent\'s pane is open docks there, without leaving the desk',()=>assert.equal(page2,'Agents'));

  uis=[...uis,T('tool-a2','Query workspace',{agent_id:'pane-a'})];
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="pane-a"] .pane-dock-pick:not([hidden])'),null,{timeout:10000});
  await page.locator('[data-pane-id="pane-a"] .pane-dock-pick').selectOption('tool-a');
  const two=await state();
  check('an agent with two tools picks between them in the dock',()=>{assert.match(two.chip,/\+1$/);assert.equal(two.frame,'http://127.0.0.1:49401/tool-a');});

  // A link to a tool (coordinator output, a report, /apps/<id>) goes to the owner's pane, opening it if closed.
  uis=[...uis,T('tool-c','Closed agent tool',{agent_id:'pane-c'})];
  await page.waitForTimeout(5500);
  await page.evaluate(()=>switchPage('skills'));
  await page.evaluate(()=>openDeskTool('/apps/tool-c'));
  await page.waitForSelector('[data-pane-id="pane-c"] .pane-dock:not([hidden])');
  const fromLink=await page.evaluate(()=>({page:document.querySelector('#breadcrumb').textContent,frame:document.querySelector('[data-pane-id="pane-c"] .pane-dock-frame').getAttribute('src')}));
  check('a link to a tool docks it in its agent\'s pane, opening that pane',()=>{assert.equal(fromLink.page,'Agents');assert.equal(fromLink.frame,'http://127.0.0.1:49401/tool-c');});

  // With no agent on the desk to hold it, a tool opens as a web pane; one an agent opens joins the desk quietly.
  await page.evaluate(()=>openDeskTool('/apps/tool-loose'));
  await page.waitForFunction(()=>[...webPages.values()].some(p=>p.url==='http://127.0.0.1:49401/tool-loose'));
  const before=await page.evaluate(()=>({selected:selectedId,page:document.querySelector('#breadcrumb').textContent}));
  uis=[...uis,T('tool-new-loose','Opened by an outside agent')];
  await page.waitForFunction(()=>[...webPages.values()].some(p=>p.url==='http://127.0.0.1:49401/tool-new-loose'),null,{timeout:10000});
  const after=await page.evaluate(()=>({selected:selectedId,page:document.querySelector('#breadcrumb').textContent,tools:document.querySelector('#open-tools')}));
  check('a tool with no agent on the desk opens as a web pane, without taking focus when an agent opened it',()=>{
   assert.equal(after.selected,before.selected);assert.equal(after.page,'Agents');assert.equal(after.tools,null,'the Tools page is gone');
  });

  // A stopped tool leaves its pane.
  await page.evaluate(()=>switchPage('agents'));
  uis=uis.map(ui=>ui.id==='tool-b'?{...ui,status:'stopped'}:ui);
  await page.waitForFunction(()=>!document.querySelector('[data-pane-id="pane-b"] .pane-tool-toggle'),null,{timeout:10000});
  const gone=await page.evaluate(()=>document.querySelector('[data-pane-id="pane-b"] .pane-dock')?.hidden??true);
  check('a stopped tool leaves the pane',()=>assert.equal(gone,true));

  // The × on the header chip closes the tool: it stops a tool the desk launched and removes one started
  // elsewhere.
  uis=uis.map(ui=>ui.id==='tool-c'?{...ui,managed:true}:ui);
  await page.evaluate(()=>refreshSkillUIs());
  const exitLabel=await page.locator('[data-pane-id="pane-c"] .pane-tool-exit').getAttribute('aria-label');
  await page.locator('[data-pane-id="pane-c"] .pane-tool-exit').click();
  await page.waitForFunction(()=>!document.querySelector('[data-pane-id="pane-c"] .pane-tool-toggle'));
  await page.locator('[data-pane-id="pane-a"] .pane-dock-pick').selectOption('tool-a2');
  const looseLabel=await page.locator('[data-pane-id="pane-a"] .pane-tool-exit').getAttribute('aria-label');
  await page.locator('[data-pane-id="pane-a"] .pane-tool-exit').click();
  await page.waitForFunction(()=>!/\+1/.test(document.querySelector('[data-pane-id="pane-a"] .pane-tool-toggle')?.textContent||''));
  const afterExit=await state(),paneC=await page.evaluate(()=>({chip:!!document.querySelector('[data-pane-id="pane-c"] .pane-tool-toggle'),frame:document.querySelector('[data-pane-id="pane-c"] .pane-dock-frame')?.getAttribute('src')}));
  check('exit stops a tool the desk launched and removes one started elsewhere',()=>{
   assert.equal(exitLabel,'Stop Closed agent tool');assert.equal(looseLabel,'Close Query workspace');
   assert.deepEqual(calls,[['/api/tools/stop','tool-c'],['/api/tools/forget','tool-a2']]);
   assert.equal(paneC.chip,false);assert.equal(paneC.frame,'about:blank','a stopped tool is unloaded, not just hidden');
   assert.equal(afterExit.chip,'Sample-data reconciliation','the agent\'s other tool stays');assert.equal(afterExit.frame,'http://127.0.0.1:49401/tool-a');
  });

  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
  const narrow=await page.evaluate(()=>({width:document.documentElement.scrollWidth,bottom:document.querySelector('[data-pane-id="pane-a"] .pane-main').classList.contains('dock-bottom')}));
  await page.evaluate(()=>render());
  const narrowBottom=await page.evaluate(()=>document.querySelector('[data-pane-id="pane-a"] .pane-main').classList.contains('dock-bottom'));
  check('on a phone the tool docks below and nothing scrolls sideways',()=>{assert.equal(narrow.width,390);assert.equal(narrowBottom,true);});

  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: tools dock inside their agent\'s pane: header chip, side and bottom split, keyboard resize, kept state, reload, auto-dock, picker, tool links, web-pane fallback, stopped tools, exit, phone');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
