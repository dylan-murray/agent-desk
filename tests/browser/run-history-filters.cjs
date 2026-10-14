const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1600,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const configs=[{id:'cfg-app',name:'Docs preview',kind:'app',cwd:'/tmp'},{id:'cfg-task',name:'Nightly build',kind:'command',cwd:'/tmp'},{id:'cfg-agent',name:'Slack triage',kind:'automation'}];
 const workflows=[{id:'wf-build',name:'Nightly build',trigger:'cron',cron:'0 9 * * 1-5',timezone:'UTC',enabled:true,next_due:200,nodes:[{id:'task-1',config_id:'cfg-task',depends_on:[]}]},
   {id:'wf-triage',name:'Slack triage',trigger:'manual',cron:'',timezone:'UTC',enabled:false,next_due:0,nodes:[{id:'task-1',config_id:'cfg-agent',depends_on:[]}]},
   {id:'wf-preview',name:'Docs preview',trigger:'manual',cron:'',timezone:'UTC',enabled:false,next_due:0,nodes:[{id:'task-1',config_id:'cfg-app',depends_on:[]}]}];
 const flows=[{id:'flow-1',workflow_id:'wf-build',state:'succeeded',created:1757600000},
   {id:'flow-2',workflow_id:'wf-triage',state:'failed',created:1757500000},
   {id:'flow-3',workflow_id:'wf-preview',state:'running',created:1757400000}];
 const executions=[{id:'run-1',flow_id:'flow-1',config_id:'cfg-task',node_id:'task-1',state:'succeeded',review_state:'done',created:1757600000,finished:1757600060},
   {id:'run-2',flow_id:'flow-2',config_id:'cfg-agent',node_id:'task-1',state:'failed',review_state:'done',created:1757500000,finished:1757500060},
   {id:'run-3',flow_id:'flow-3',config_id:'cfg-app',node_id:'task-1',state:'running',review_state:'done',created:1757400000}];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs,workflows,flows,executions},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-workflows').click();
 await page.waitForFunction(()=>document.querySelectorAll('.run-row').length===3);
 assert.equal(await page.locator('#history-count').innerText(),'3 runs');
 // One aligned row per run: name, type, its tasks, when it started, its status.
 const first=page.locator('.run-row').first();
 assert.equal(await first.locator('.run-name strong').innerText(),'Nightly build');
 assert.equal(await first.locator('.run-dot').getAttribute('data-status'),'succeeded');
 assert.deepEqual(await first.locator('.run-type').allInnerTexts(),['Task']);
 assert.deepEqual(await first.locator('.run-task').allInnerTexts(),['task-1']);
 assert.equal(await first.locator('.run-task').getAttribute('data-status'),'succeeded');
 assert.equal(await first.locator('.run-state').innerText(),'Succeeded');
 assert.equal(await first.locator('.run-state').getAttribute('data-status'),'succeeded');
 assert.match(await first.locator('.run-when').innerText(),/ago|—/);
 assert.deepEqual((await page.locator('.run-head span').allInnerTexts()).map(t=>t.toLowerCase()),['workflow','type','tasks','started','status']);
 // Every row resolves the same column tracks, and the four left-aligned cells start on
 // the same pixel in every row. The status cell is right-aligned, so its x may differ.
 const columns=await page.$$eval('.run-row',rows=>rows.map(row=>({
   tracks:getComputedStyle(row).gridTemplateColumns,
   cells:[...row.children].slice(0,4).map(cell=>Math.round(cell.getBoundingClientRect().x)).join(',')})));
 assert.equal(new Set(columns.map(row=>row.tracks)).size,1,'run rows resolve different column tracks');
 assert.equal(new Set(columns.map(row=>row.cells)).size,1,'run rows do not start their columns on the same pixel');
 assert.equal(columns[0].tracks.split(' ').length,5,'the run table is not five columns');
 await page.locator('.history-heading').scrollIntoViewIfNeeded();await page.screenshot({path:evidence('agentdesk-run-history-after.png')});
 // Filter by the type of task each run carried.
 await page.locator('#history-kind').selectOption('automation');
 await page.waitForFunction(()=>document.querySelectorAll('.run-row').length===1);
 assert.match(await page.locator('.run-row').innerText(),/Slack triage/);
 assert.equal(await page.locator('#history-count').innerText(),'1 of 3 runs');
 await page.locator('#history-kind').selectOption('app');
 await page.waitForFunction(()=>document.body.innerText.includes('Docs preview'));
 assert.equal(await page.locator('.run-row').count(),1);
 // Filter by workflow and by status, including a combination that matches nothing.
 await page.locator('#history-kind').selectOption('all');await page.locator('#history-workflow').selectOption('wf-build');
 await page.waitForFunction(()=>document.querySelectorAll('.run-row').length===1);
 await page.locator('#history-state').selectOption('failed');
 await page.waitForFunction(()=>document.getElementById('workflow-history').textContent.includes('No runs match these filters.'));
 assert.equal(await page.locator('#history-count').innerText(),'0 of 3 runs');
 await page.locator('#history-workflow').selectOption('all');
 await page.waitForFunction(()=>document.querySelectorAll('.run-row').length===1);
 assert.match(await page.locator('.run-row').innerText(),/Slack triage/);
 await page.locator('#history-state').selectOption('running');
 await page.waitForSelector('.run-cancel');
 // Filters survive the four-second poll.
 await page.waitForTimeout(4500);
 assert.equal(await page.locator('#history-state').inputValue(),'running');
 assert.equal(await page.locator('.run-row').count(),1);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#history-kind').isVisible(),true);
 await page.locator('.history-heading').scrollIntoViewIfNeeded();await page.screenshot({path:evidence('agentdesk-run-history-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: aligned run-history table, shared column grid, type/workflow/status filters, empty state, counts, poll-stable selections, mobile; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
