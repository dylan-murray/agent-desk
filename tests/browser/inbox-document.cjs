const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 let waiting=true;
 const store={roles:[{id:'watcher',name:'Slack triage',kind:'watcher',scope:'#team',choice:'claude'}],runs:[{id:'blocked-run',state:'blocked',terminal_id:null}],inbox:[{id:'finding',role_id:'watcher',event_key:'thread:123',title:'Review retry fix',detail:'# Morning report\n\n## Findings\n\n- **Build:** tests passed.\n- Check `config.py`.\n\n## Next steps\n\nReview https://example.com/review\n\n```python\nprint(1)\n```\n\n<script>alert(1)</script>',state:'review',created:100,url:'https://example.com/review',findings:[{id:'child',title:'Detailed evidence',detail:'## Source details\n\nFull original findings stay available.',url:'https://example.com/source'}]},{id:'blocked',role_id:'watcher',event_key:'run:blocked-run',title:'Slack access needed',detail:'The channel connector needs access.',state:'review',created:101,url:''}]};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/special-agents/review'){const body=route.request().postDataJSON();writes.push(body);store.inbox.find(i=>i.id===body.id).state=body.state;return route.fulfill({json:{ok:true}});}
  const agent={id:'approval',name:'Agent waiting',source:'adapter',status:'needs_input',question:'Choose a repository',project:'Agent Desk',events:[],task:'Prepare a fix',updated:102,harness:'claude'};
  const data={'/api/agents':{agents:waiting?[agent]:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':store,'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-inbox').click();await page.waitForFunction(()=>document.getElementById('review-count').textContent==='3');
 assert.equal(await page.locator('.inbox-row').count(),3);
 await page.locator('[data-inbox-filter="attention"]').click();assert.equal(await page.locator('.inbox-row').count(),2);
 await page.locator('[data-inbox-item="session:approval"]').click();assert.equal(await page.locator('[data-inbox-action="done"]').count(),0);
 await page.locator('[data-inbox-action="session"]').click();await page.locator('#agents-page').waitFor({state:'visible'});
 await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter="review"]').click();if(process.env.CAPTURE_BEFORE){await page.screenshot({path:evidence('inbox-document-before.png')});return;}
 assert.equal(await page.locator('#inbox-detail .inbox-body h1.document-title').count(),1);
 assert.equal(await page.locator('#inbox-detail .inbox-body h2').count(),3);
 assert.equal(await page.locator('#inbox-detail .inbox-body li').count(),2);
 assert.equal(await page.locator('#inbox-detail .inbox-body script').count(),0);
 await page.screenshot({path:evidence('inbox-document-after.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence('inbox-document-mobile.png')});await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-inbox-action="done"]').click();await page.waitForFunction(()=>document.getElementById('review-count').textContent==='2');
 await page.locator('[data-inbox-filter="history"]').click();assert.equal(await page.locator('.inbox-row').count(),1);
 await page.locator('[data-inbox-action="review"]').click();await page.waitForFunction(()=>document.getElementById('review-count').textContent==='3');
 await page.locator('[data-inbox-filter="all"]').click();await page.locator('#inbox-search').fill('connector');assert.equal(await page.locator('.inbox-row').count(),1);await page.locator('#inbox-search').fill('');
 waiting=false;await page.evaluate(()=>refresh());await page.waitForFunction(()=>document.getElementById('review-count').textContent==='2');
 await page.reload();await page.locator('#open-inbox').click();await page.waitForFunction(()=>document.querySelectorAll('.inbox-row').length===2);
 await page.locator('#open-special-agents').click();assert.equal(await page.locator('#breadcrumb').innerText(),'Automations');assert.match(await page.locator('.automation-trigger-note').innerText(),/Manual trigger/);
 await page.locator('#open-inbox').click();await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);assert.deepEqual(writes.map(w=>w.state),['done','review']);
 await page.evaluate(()=>window.updateWorkflowInbox({configs:[{id:'failed-config',kind:'automation'}],executions:[{id:'failed-launch',config_id:'failed-config',state:'failed',review_state:'review',detail:'Launch failed before an agent report',created:105}]}));await page.locator('#inbox-search').fill('Launch failed');assert.equal(await page.locator('.inbox-row').count(),1);
 console.log('PASS: workflow launch failure, dedicated inbox, live requests, blocked reports, filters, source detail, review/reopen, search, cleared requests, reload, mobile; mocked API only');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
