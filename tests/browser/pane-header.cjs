// Pane headers: per-terminal CPU and memory, full screen for a pane and for the app, a dismissable
// needs-you alert, no Rename button or noisy output state, and an explicit Stop control.
// Stopping a terminal ends the session and closes its pane.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const A=(id,name,o={})=>({id,name,terminal_id:id,parent_id:null,harness:'codex',status:'idle',source:'terminal',exit_code:null,
  cwd:'/tmp/'+id,project:'fixture',task:'Interactive terminal',events:[],question:null,updated:Date.now()/1000,...o});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let agents=[A('pane-a','Busy agent',{status:'working',memory_kb:1782579,cpu_percent:92.4}),
              A('pane-b','Quiet agent',{memory_kb:17400,cpu_percent:0}),
              A('pane-c','Waiting agent',{status:'needs_input',question:'Drop the old index?',memory_kb:20480,cpu_percent:null}),
              // The alert is about any session that needs an answer, including one an adapter reports.
              A('watch-1','Migration writer',{terminal_id:null,source:'adapter',status:'needs_input',question:'Drop the old index?'})];
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(ids=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids)),['pane-a','pane-b','pane-c']);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane');
  await page.waitForFunction(()=>document.querySelector('.pane-usage')?.textContent);

  // Memory always, CPU only once a second sample exists, and the numbers are readable at a glance.
  const usage=await page.$$eval('.terminal-pane',nodes=>Object.fromEntries(nodes.map(node=>[node.dataset.paneId,
   [node.querySelector('.usage-value')?.textContent??null,node.querySelector('.usage-mem')?.textContent,node.querySelector('.usage-cpu')?.dataset.load??null]])));
  check('each pane header shows its own memory, and CPU tinted by load when it is known',()=>{
   assert.deepEqual(usage['pane-a'],['92%','1.7 GB','warn']);
   assert.deepEqual(usage['pane-b'],['0%','17 MB','idle']);
   assert.deepEqual(usage['pane-c'],[null,'20 MB',null],'a pane without a CPU sample yet shows memory alone');
  });
  // An empty state adds no second gap before the controls, so the spacing stays even.
  const gaps=await page.locator('[data-pane-id="pane-b"]').evaluate(node=>{node.dispatchEvent(new MouseEvent('mouseover',{bubbles:true}));
   const parts=[...node.querySelectorAll('.pane-actions>*')].filter(n=>getComputedStyle(n).display!=='none'&&!n.classList.contains('hidden')).map(n=>n.getBoundingClientRect());
   return parts.slice(1).map((r,i)=>Math.round(r.left-parts[i].right));});
  check('the header controls sit at even spacing',()=>assert.deepEqual(gaps,gaps.map(()=>6),String(gaps)));
  // The folder sits on the left of a status line under the terminal, cpu and mem on its right.
  const placed=await page.locator('[data-pane-id="pane-b"]').evaluate(node=>{const status=node.querySelector('.pane-status'),body=node.querySelector('.pane-main').getBoundingClientRect(),s=status.getBoundingClientRect(),path=node.querySelector('.pane-path').getBoundingClientRect(),usage=node.querySelector('.pane-usage').getBoundingClientRect();
   return {underTerminal:s.top>=body.bottom-1,pathLeft:Math.round(path.left-s.left),usageRight:Math.round(s.right-usage.right),headerHasUsage:!!node.querySelector('.terminal-bar .pane-usage'),path:node.querySelector('.pane-path').textContent};});
  check('the status line sits under the terminal with the folder on the left and usage on the right',()=>{
   assert.equal(placed.underTerminal,true);assert.equal(placed.pathLeft,0);assert.equal(placed.usageRight,0);assert.equal(placed.headerHasUsage,false);assert.equal(placed.path,'/tmp/pane-b');
  });
  const long=await page.locator('[data-pane-id="pane-a"]').evaluate(node=>{const title=node.querySelector('.pane-title');title.textContent='fixture / '+'a very long session name '.repeat(12);
   const t=title.getBoundingClientRect(),u=node.querySelector('.pane-usage').getBoundingClientRect(),a=node.querySelector('.pane-actions').getBoundingClientRect(),bar=node.querySelector('.terminal-bar').getBoundingClientRect();
   return {overlap:u.right>a.left+1||t.right>u.left+1,inside:a.right<=bar.right+1,truncated:title.scrollWidth>title.clientWidth};});
  check('a long title truncates instead of pushing the controls out',()=>assert.deepEqual({inside:long.inside,truncated:long.truncated},{inside:true,truncated:true}));
  const mono=await page.locator('[data-pane-id="pane-a"] .pane-usage').evaluate(n=>getComputedStyle(n).fontVariantNumeric);
  check('usage is tabular so the digits do not jump while it updates',()=>assert.match(mono,/tabular-nums/));

  // The header carries no Rename button and no "Output active"; the title is still the rename control.
  const header=await page.$$eval('.terminal-pane',nodes=>nodes.map(node=>({
   id:node.dataset.paneId,rename:node.querySelectorAll('.pane-rename').length,state:node.querySelector('.pane-state').textContent,
   icons:[...node.querySelectorAll('.pane-icon')].map(button=>button.getAttribute('aria-label')),
   stop:node.querySelector('.pane-stop').textContent,
   titleRole:node.querySelector('.pane-title').getAttribute('role')})));
  check('the header drops Rename and only says something when the state is worth reading',()=>{
   for(const pane of header){
    assert.equal(pane.rename,0,'a Rename button is still in the header');
    assert.deepEqual(pane.icons,['Protect this session','Full screen','Close pane']);
    assert.equal(pane.stop,'Stop','Stop is a labelled button, not a bare square');
    assert.equal(pane.titleRole,'button','the title is no longer the rename control');
   }
   assert.equal(header.find(p=>p.id==='pane-a').state,'','a working terminal says nothing');
   assert.equal(header.find(p=>p.id==='pane-b').state,'');
   assert.equal(header.find(p=>p.id==='pane-c').state,'Needs you');
  });
  const quiet=await page.locator('[data-pane-id="pane-b"] .pane-expand').evaluate(n=>getComputedStyle(n).opacity);
  await page.locator('[data-pane-id="pane-b"]').hover();
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-pane-id="pane-b"] .pane-expand')).opacity==='1');
  check('Stop and Full screen stay out of the way until the pane is hovered or focused',()=>assert.equal(quiet,'0'));

  // Stopping a terminal closes its pane too; nothing is left behind showing an exited session.
  const stops=[];
  await page.route('**/api/terminals/stop',route=>{stops.push(JSON.parse(route.request().postData()).id);return route.fulfill({json:{ok:true}});});
  await page.locator('[data-pane-id="pane-b"] .pane-stop').click();
  const confirm=await page.locator('#confirm-stop-terminal').textContent();
  await page.locator('#confirm-stop-terminal').click();
  await page.waitForFunction(()=>!document.querySelector('[data-pane-id="pane-b"]'));
  agents=agents.map(agent=>agent.id==='pane-b'?{...agent,exit_code:143,status:'error'}:agent);
  await page.waitForTimeout(2500);
  const closed=await page.evaluate(()=>({pane:!!document.querySelector('[data-pane-id="pane-b"]'),
   panes:[...document.querySelectorAll('.terminal-pane')].map(node=>node.dataset.paneId),dialog:document.getElementById('stop-terminal-dialog').open}));
  check('Stop ends the session and closes its pane for good',()=>{
   assert.equal(confirm,'Stop and close');assert.deepEqual(stops,['pane-b']);
   assert.equal(closed.pane,false,'the stopped pane came back once the session reported its exit');
   assert.equal(closed.dialog,false);assert.deepEqual(closed.panes,['pane-a','pane-c']);
  });

  // Full screen: one pane fills the window, the others stay mounted, Escape returns.
  await page.locator('[data-pane-id="pane-a"] .pane-expand').click();
  await page.waitForSelector('.pane-fullscreen');
  const full=await page.evaluate(()=>{const pane=document.querySelector('.pane-fullscreen'),box=pane.getBoundingClientRect();
   return {id:pane.dataset.paneId,width:box.width,height:box.height,
    others:[...document.querySelectorAll('.terminal-pane:not(.pane-fullscreen)')].map(node=>getComputedStyle(node).visibility),
    mounted:document.querySelectorAll('.terminal-pane').length,
    pressed:pane.querySelector('.pane-expand').getAttribute('aria-pressed')};});
  check('the expanded pane fills the window while the others stay mounted',()=>{
   assert.equal(full.id,'pane-a');assert.equal(full.width,1500);assert.equal(full.height,900);
   assert.deepEqual(full.others,['hidden']);assert.equal(full.mounted,2);assert.equal(full.pressed,'true');
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.pane-fullscreen'));
  check('Escape leaves full screen',()=>true);
  await page.locator('[data-pane-id="pane-a"] .pane-expand').click();
  await page.waitForSelector('.pane-fullscreen');
  await page.locator('[data-pane-id="pane-a"] .pane-expand').click();
  await page.waitForFunction(()=>!document.querySelector('.pane-fullscreen'));
  check('the same control toggles back',()=>true);

  // The whole app can go full screen too, through the browser's own full-screen mode.
  const appButton=page.locator('#app-fullscreen');
  check('the header offers a full-screen control next to the other utilities',async()=>assert.equal(await appButton.isVisible(),true));
  await appButton.click();
  await page.waitForFunction(()=>!!document.fullscreenElement);
  const app=await page.evaluate(()=>({pressed:document.getElementById('app-fullscreen').getAttribute('aria-pressed'),
   body:document.body.classList.contains('app-fullscreen'),label:document.getElementById('app-fullscreen').getAttribute('aria-label'),
   dividers:[...document.querySelectorAll('#header-nav .header-nav-sep')].map(node=>node.nextElementSibling?.id),
   pseudo:[...document.querySelectorAll('.top-actions .sound-toggle')].map(node=>getComputedStyle(node,'::before').content)}));
  check('the app full-screen control reports its state and keeps one divider before the utilities',()=>{
   assert.equal(app.pressed,'true');assert.equal(app.body,true);assert.equal(app.label,'Leave full screen');
   assert.deepEqual(app.dividers,['app-fullscreen']);assert.deepEqual(app.pseudo,['none','none','none']);
  });
  await appButton.click();
  await page.waitForFunction(()=>!document.fullscreenElement);
  const left=await appButton.getAttribute('aria-pressed');
  check('the same control leaves full screen',()=>assert.equal(left,'false'));

  // The needs-you alert can be dismissed, and comes back when that session asks something else.
  await page.waitForSelector('#session-attention .attention-dismiss');
  const before=await page.title();
  // Each waiting session has its own dismiss; a terminal-backed one drops out once its screen reports.
  while(!await page.locator('#session-attention').isHidden())await page.locator('.attention-dismiss').first().click();
  const after=await page.title();
  check('dismissing the alert hides it and clears the tab title',()=>{
   assert.match(before,/Needs you/);assert.equal(after,'Agent Desk');
  });
  await page.waitForTimeout(2500);
  const stayed=await page.locator('#session-attention').isHidden();
  check('it stays dismissed while the same question is open',()=>assert.equal(stayed,true));
  agents=agents.map(agent=>agent.id==='watch-1'?{...agent,question:'Also drop the trigger?'}:agent);
  await page.waitForFunction(()=>!document.getElementById('session-attention').hidden,null,{timeout:10000});
  const raised=await page.locator('#session-attention').innerText();
  check('a new question from the same session raises it again',()=>assert.match(raised,/Migration writer/));
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: per-pane CPU and memory, quiet header, Stop closes the pane, pane and app full screen, dismissable needs-you alert');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
