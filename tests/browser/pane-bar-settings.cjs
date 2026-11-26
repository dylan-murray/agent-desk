// The pane bar shows what you choose, from Settings → Terminal panes → Bottom bar or by right-clicking a pane's bar.
// Both edit one saved choice per browser; every part off hides the bar and gives the terminal its room.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const path=require('node:path');const os=require('node:os');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const A=(id,name,o={})=>({id,name,terminal_id:id,parent_id:null,harness:'codex',status:'idle',source:'terminal',exit_code:null,
  cwd:'/tmp/'+id,project:'fixture',task:'Interactive terminal',events:[],question:null,updated:Date.now()/1000,...o});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const agents=[A('pane-a','Busy agent',{status:'working',memory_kb:1782579,cpu_percent:42,cwd:'/tmp/code/app'}),A('pane-b','Quiet agent',{memory_kb:17400,cpu_percent:0})];
  await context.route('**/api/**',route=>{const url=new URL(route.request().url()).pathname;
   const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]},'/api/files/branch':{branch:'main'}};
   return route.fulfill({json:data[url]||{}});});
  await context.addInitScript(ids=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids)),['pane-a','pane-b']);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  const pane=page.locator('[data-pane-id="pane-a"]'),bar=pane.locator('.pane-status');
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="pane-a"] .usage-cpu')&&!document.querySelector('[data-pane-id="pane-a"] .pane-branch').hidden);
  const shown=()=>pane.evaluate(node=>Object.fromEntries([['folder','.pane-path'],['branch','.pane-branch'],['time','.usage-time'],['cpu','.usage-cpu'],['memory','.usage-group']]
   .map(([key,selector])=>{const part=node.querySelector(selector);return [key,!!part&&getComputedStyle(part).display!=='none'];})));
  const initial=await shown();
  check('every part shows until you choose otherwise',()=>assert.deepEqual(initial,{folder:true,branch:true,time:true,cpu:true,memory:true}));

  // Settings: one switch per part, on by default, and switching one off hides it on every pane at once.
  await page.click('#open-settings');
  const switches=page.locator('#settings-pane-bar [role=switch]');
  const states=await switches.evaluateAll(nodes=>nodes.map(node=>[node.dataset.part,node.getAttribute('aria-checked')]));
  check('Settings lists the five parts, all on',()=>assert.deepEqual(states,[['folder','true'],['branch','true'],['time','true'],['cpu','true'],['memory','true']]));
  await page.locator('#settings-pane-bar').evaluate(node=>node.closest('.settings-group').scrollIntoView());
  await page.screenshot({path:path.join(EVIDENCE,'pane-bar-01-settings.png')});
  await switches.nth(3).click();await switches.nth(1).click();
  await page.click('#open-sessions');
  const afterSettings=await shown();
  check('switching CPU and Branch off in Settings hides them in the pane',()=>assert.deepEqual(afterSettings,{folder:true,branch:false,time:true,cpu:false,memory:true}));
  const otherPane=await page.locator('[data-pane-id="pane-b"] .usage-cpu').evaluate(node=>getComputedStyle(node).display);
  check('the choice applies to every pane',()=>assert.equal(otherPane,'none'));

  // The pane: right-click its bar for the same choices; the menu stays open so several can change.
  const box=await bar.boundingBox();
  await page.mouse.click(box.x+40,box.y+box.height/2,{button:'right'});
  const menu=page.locator('#pane-bar-menu');await menu.waitFor();
  const items=await menu.locator('[data-part]').evaluateAll(nodes=>nodes.map(node=>[node.textContent,node.getAttribute('aria-checked')]));
  check('right-clicking the bar lists the parts with what is on checked',()=>assert.deepEqual(items,[['Folder','true'],['Branch','false'],['Working or idle time','true'],['CPU','false'],['Memory','true']]));
  await page.screenshot({path:path.join(EVIDENCE,'pane-bar-02-menu.png'),clip:{x:Math.max(0,box.x-20),y:box.y-260,width:520,height:300}});
  await menu.locator('[data-part=cpu]').click();await menu.locator('[data-part=time]').click();
  const stillOpen=await menu.isVisible();
  check('the menu stays open while parts change',()=>assert.equal(stillOpen,true));
  const afterMenu=await shown();
  check('the menu shows CPU again and hides the time',()=>assert.deepEqual(afterMenu,{folder:true,branch:false,time:false,cpu:true,memory:true}));
  await page.keyboard.press('Escape');
  const closed=!(await menu.isVisible());
  check('Escape closes the menu',()=>assert.ok(closed));
  await page.click('#open-settings');
  const synced=await switches.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('aria-checked')));
  check('Settings shows what the menu changed',()=>assert.deepEqual(synced,['true','false','false','true','true']));
  await page.click('#open-sessions');

  // Saved per browser: a reload keeps it, and another tab follows a change.
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="pane-a"] .usage-cpu'));
  const reloaded=await shown();
  check('a reload keeps the choice',()=>assert.deepEqual(reloaded,{folder:true,branch:false,time:false,cpu:true,memory:true}));
  const other=await context.newPage();await other.goto(APP,{waitUntil:'domcontentloaded'});
  await other.waitForSelector('#settings-pane-bar [data-part=memory]',{state:'attached'});
  await other.evaluate(()=>document.querySelector('#settings-pane-bar [data-part=memory]').click());
  await page.waitForFunction(()=>getComputedStyle(document.querySelector('[data-pane-id="pane-a"] .usage-group')).display==='none');
  check('another tab of Agent Desk follows a change',()=>{});
  await other.close();

  // Everything off: the bar goes, and the terminal takes its height. The menu's link opens Settings.
  const before=await pane.locator('.pane-body').evaluate(node=>node.getBoundingClientRect().height);
  await page.mouse.click(box.x+40,box.y+box.height/2,{button:'right'});
  for(const key of ['folder','cpu'])await menu.locator(`[data-part=${key}]`).click();
  const gone=await bar.evaluate(node=>getComputedStyle(node).display);
  const after=await pane.locator('.pane-body').evaluate(node=>node.getBoundingClientRect().height);
  check('with every part off the bar is hidden and the terminal grows into its space',()=>{assert.equal(gone,'none');assert.ok(after>before,`${after} > ${before}`);});
  await page.keyboard.press('Escape');
  await page.screenshot({path:path.join(EVIDENCE,'pane-bar-03-all-off.png')});
  await page.click('#open-settings');await switches.nth(0).click();await page.click('#open-sessions');
  const back=await bar.evaluate(node=>getComputedStyle(node).display);
  check('turning one part back on in Settings brings the bar back',()=>assert.notEqual(back,'none'));
  const fbox=await bar.boundingBox();
  await page.mouse.click(fbox.x+40,fbox.y+fbox.height/2,{button:'right'});
  await menu.locator('[data-settings]').click();
  const onSettings=await page.locator('#settings-page').isVisible();
  check('“Terminal pane settings…” opens Settings',()=>assert.ok(onSettings));

  // Narrow: Settings rows and the bar still fit.
  await page.setViewportSize({width:390,height:844});
  await page.locator('#settings-pane-bar').evaluate(node=>node.closest('.settings-group').scrollIntoView());
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth);
  await page.screenshot({path:path.join(EVIDENCE,'pane-bar-04-narrow-settings.png')});
  check('Settings fits at 390px',()=>assert.ok(overflow<=0,`overflow ${overflow}px`));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push(error.message);console.log('  FAIL  '+error.stack);}
 finally{await browser.close();}
 if(failures.length){console.log(`FAIL: ${failures.length} pane bar check(s)`);process.exit(1);}
 console.log('PASS: pane bar settings: five parts in Settings and in the bar\'s right-click menu, shared and saved per browser, every part off hides the bar, 1440 and 390px');
})();
