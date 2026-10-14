const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const store={roles:[{id:'watcher',name:'Slack triage',kind:'watcher',scope:'#team',choice:'claude'}],runs:[],inbox:[
   {id:'finding-a',role_id:'watcher',event_key:'thread:1',title:'Retry fix reviewed',detail:'Tests passed.',state:'review',created:100,url:''},
   {id:'finding-b',role_id:'watcher',event_key:'thread:2',title:'Docs drift',detail:'Two pages are stale.',state:'review',created:101,url:''}]};
 const workflows={configs:[{id:'cfg',name:'Nightly build',kind:'command',cwd:'/tmp'}],workflows:[],flows:[],
   executions:[{id:'run-1',config_id:'cfg',state:'succeeded',review_state:'review',finished:102,created:102,detail:'Build finished.'}]};
 const tasks=[{id:'task-1',controller:'coordinator',task:'Summarize the fixture',result:'All clear.',outcome:'succeeded',acknowledged:false,updated:103,connection:'connected',delivery:'sent',coordinator_harness:'claude'}];
 const agent={id:'waiting',name:'Agent waiting',source:'adapter',status:'needs_input',question:'Choose a repository',project:'Agent Desk',events:[],task:'Prepare a fix',updated:104,harness:'claude'};
 const coordinator={id:'coordinator',name:'Coordinator fixture',source:'adapter',status:'idle',controller:true,exit_code:null,project:'Agent Desk',events:[],task:'Coordinate',updated:104,harness:'claude'};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname,method=route.request().method();
  if(path==='/api/special-agents/review'){const body=route.request().postDataJSON();writes.push(path);store.inbox.find(item=>item.id===body.id).state=body.state;return route.fulfill({json:{ok:true}});}
  if(path==='/api/workflows/review'){const body=route.request().postDataJSON();writes.push(path);workflows.executions.find(run=>run.id===body.id).review_state=body.state;return route.fulfill({json:{ok:true}});}
  if(path==='/api/coordinator-events/ack'){writes.push(path);tasks[0].acknowledged=true;return route.fulfill({json:{ok:true}});}
  if(method==='POST'&&path!=='/api/feedback')writes.push(path);
  const data={'/api/agents':{agents:[agent,coordinator]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':store,'/api/workflows':workflows,'/api/coordinator-events':{tasks,event_delivery:true,supported_harnesses:['claude']},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-inbox').click();
 await page.waitForFunction(()=>document.querySelectorAll('.inbox-row').length===5);
 // Four of the five open items can be dismissed; the session waiting on an answer cannot.
 await page.waitForFunction(()=>document.getElementById('inbox-dismiss-all').textContent==='Dismiss all 4');
 assert.equal(await page.locator('#inbox-dismiss-all').isVisible(),true);
 await page.screenshot({path:evidence('agentdesk-inbox-bulk-before.png')});
 await page.locator('#inbox-dismiss-all').click();
 assert.match(await page.locator('.inbox-dismiss-dialog .inbox-dismiss-scope').innerText(),/4 items in the Open view/);
 await page.screenshot({path:evidence('agentdesk-inbox-bulk-dialog.png')});
 await page.locator('.inbox-dismiss-cancel').click();
 await page.waitForFunction(()=>!document.querySelector('.inbox-dismiss-dialog[open]'));
 assert.deepEqual(writes,[]);
 // Search narrows the scope: only the matching item is offered.
 await page.locator('#inbox-search').fill('docs drift');
 await page.waitForFunction(()=>document.getElementById('inbox-dismiss-all').textContent==='Dismiss all 1');
 await page.locator('#inbox-search').fill('');
 await page.waitForFunction(()=>document.getElementById('inbox-dismiss-all').textContent==='Dismiss all 4');
 await page.locator('#inbox-dismiss-all').click();await page.locator('.inbox-dismiss-confirm').click();
 await page.waitForFunction(()=>!document.querySelector('.inbox-dismiss-dialog[open]'));
 assert.deepEqual(writes.sort(),['/api/coordinator-events/ack','/api/special-agents/review','/api/special-agents/review','/api/workflows/review']);
 await page.waitForFunction(()=>document.querySelectorAll('.inbox-row').length===1);
 assert.match(await page.locator('.inbox-row').innerText(),/Agent waiting/);
 assert.equal(await page.locator('#inbox-dismiss-all').isVisible(),false);
 await page.locator('[data-inbox-filter=history]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.inbox-row').length===4);
 assert.equal(await page.locator('#inbox-dismiss-all').isVisible(),false);
 await page.screenshot({path:evidence('agentdesk-inbox-bulk-after.png')});
 // Reopening one item brings the control back for that single item.
 await page.locator('.inbox-row',{hasText:'Docs drift'}).click();await page.locator('[data-inbox-action=review]').click();
 await page.locator('[data-inbox-filter=open]').click();
 await page.waitForFunction(()=>document.getElementById('inbox-dismiss-all').textContent==='Dismiss all 1');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('#inbox-dismiss-all').isVisible(),true);
 assert.deepEqual(errors,[]);
 console.log('PASS: bulk dismiss counts only dismissable items, follows filter and search, confirms before writing, routes automation/workflow/coordinator items, hides when empty; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
