const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[],opened=[];page.on('pageerror',e=>errors.push(e.message));
 const now=Math.floor(Date.now()/1000);
 const configs=[{id:'c-task',name:'Fetch sample data',kind:'command',cwd:'/tmp'},{id:'c-agent',name:'Write debrief',kind:'automation',role_id:'r1'},{id:'c-app',name:'Debrief preview',kind:'app',cwd:'/tmp'}];
 const workflows=[{id:'w1',name:'Morning summary',trigger:'cron',cron:'0 17 * * 1-5',timezone:'America/New_York',enabled:true,next_due:now+3600,nodes:[{id:'fetch',config_id:'c-task',depends_on:[]},{id:'write',config_id:'c-agent',depends_on:['fetch']}]},
   {id:'w2',name:'Docs preview',trigger:'manual',cron:'',timezone:'UTC',enabled:false,next_due:0,nodes:[{id:'serve',config_id:'c-app',depends_on:[]}]}];
 const flows=[{id:'f1',workflow_id:'w1',state:'failed',created:now-7200,finished:now-7200+312},{id:'f2',workflow_id:'w2',state:'running',created:now-900,finished:null}];
 const executions=[
   {id:'e1',flow_id:'f1',config_id:'c-task',node_id:'fetch',state:'succeeded',review_state:'done',created:now-7200,finished:now-7200+48,detail:'Pulled 412 records.'},
   {id:'e2',flow_id:'f1',config_id:'c-agent',node_id:'write',state:'failed',review_state:'done',created:now-7200+48,finished:now-7200+312,detail:'The debrief agent stopped: the sample data file was empty for 3 records.',terminal_id:'term-1'},
   {id:'e3',flow_id:'f2',config_id:'c-app',node_id:'serve',state:'ready',review_state:'done',created:now-900,port:49321,detail:'Serving on its port.'}];
 await page.route('**/api/**',route=>{const url=new URL(route.request().url()),path=url.pathname;
  if(path==='/api/workflows/logs'){opened.push(url.searchParams.get('id'));return route.fulfill({json:{text:'fixture output for '+url.searchParams.get('id')}});}
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs,workflows,flows,executions},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-workflows').click();
 await page.waitForSelector('.run-row');
 const row=page.locator('.run-row').filter({hasText:'Morning summary'});
 const toggle=row.locator('.run-open');
 assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 assert.equal(await page.locator('.run-detail').count(),0);
 // Clicking the workflow name opens its details.
 await toggle.click();
 await page.waitForSelector('#run-detail-f1');
 assert.equal(await toggle.getAttribute('aria-expanded'),'true');
 const facts=await page.locator('#run-detail-f1 .run-fact').allInnerTexts();
 assert.equal(facts.length,4);
 assert.match(facts[2],/Duration\s+5m 12s/i);
 assert.match(facts[3],/Trigger\s+0 17 \* \* 1-5 · America\/New_York/i);
 const tasks=page.locator('#run-detail-f1 .run-detail-task');
 assert.equal(await tasks.count(),2);
 assert.match(await tasks.nth(0).innerText(),/Fetch sample data/);
 assert.match(await tasks.nth(0).innerText(),/fetch · Task/);
 assert.match(await tasks.nth(0).innerText(),/48s/);
 assert.match(await tasks.nth(1).innerText(),/sample data file was empty/);
 assert.equal(await tasks.nth(1).locator('.run-state').getAttribute('data-status'),'failed');
 assert.deepEqual(await tasks.nth(1).locator('.run-detail-actions .text-button').allInnerTexts(),['Output','Agent session']);
 await page.locator('#run-detail-f1').scrollIntoViewIfNeeded();
 await page.screenshot({path:evidence('agentdesk-run-details.png')});
 // Output opens the task's log, and the detail survives the four-second poll.
 await tasks.nth(0).locator('.text-button',{hasText:'Output'}).click();
 await page.waitForSelector('#run-log-dialog[open]');
 assert.deepEqual(opened,['e1']);
 await page.locator('#run-log-dialog .close-dialog').click();
 await page.waitForTimeout(4500);
 assert.equal(await page.locator('#run-detail-f1').count(),1,'the open details collapsed on the poll');
 // Clicking a task link inside the row keeps doing its own thing instead of toggling.
 await row.locator('.run-task').first().click();
 await page.waitForSelector('#run-log-dialog[open]');
 await page.locator('#run-log-dialog .close-dialog').click();
 assert.equal(await page.locator('#run-detail-f1').count(),1,'a task link toggled the row');
 // Clicking the row background closes it again; the keyboard opens it too.
 await row.locator('.run-when').click();
 await page.waitForFunction(()=>!document.getElementById('run-detail-f1'));
 await toggle.focus();await page.keyboard.press('Enter');
 await page.waitForSelector('#run-detail-f1');
 assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('run-open')),true,'focus left the toggle after re-render');
 // A running app shows it is still going and offers its live link.
 await page.locator('.run-row').filter({hasText:'Docs preview'}).locator('.run-open').click();
 await page.waitForSelector('#run-detail-f2');
 assert.match(await page.locator('#run-detail-f2 .run-fact').nth(1).innerText(),/Still running/);
 assert.equal(await page.locator('#run-detail-f2 a',{hasText:'Open app'}).getAttribute('href'),'http://127.0.0.1:49321');
 await page.setViewportSize({width:390,height:844});
 await page.locator('#run-detail-f1').scrollIntoViewIfNeeded();
 assert.equal(await page.locator('#run-detail-f1 .run-detail-task').first().isVisible(),true);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,'the details scroll the page sideways at 390px');
 assert.deepEqual(errors,[]);
 console.log('PASS: run rows open into details (timing, trigger, per-task state/duration/detail), output and session links, poll-stable, task links unaffected, keyboard and focus, running app link, 390px; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
