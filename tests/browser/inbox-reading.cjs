const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 let waiting=true;
 const store={roles:[{id:'watcher',name:'Slack triage',kind:'watcher',scope:'#team',choice:'claude'}],runs:[{id:'blocked-run',state:'blocked',terminal_id:null}],inbox:[{id:'finding',role_id:'watcher',event_key:'thread:123',title:'Review retry fix',detail:'# Morning report\n\n## Findings\n\n- **Build:** tests passed.\n- Check `config.py`.\n\n## Next steps\n\nReview https://example.com/review\n\n```python\nprint(1)\n```\n\n<script>alert(1)</script>',state:'review',created:100,url:'https://example.com/review',findings:[{id:'child',title:'Detailed evidence',detail:'## Source details\n\nFull original findings stay available.',url:'https://example.com/source'}]},{id:'blocked',role_id:'watcher',event_key:'run:blocked-run',title:'Slack access needed',detail:'The channel connector needs access.',state:'review',created:101,url:''}]};
 store.inbox[0].detail=`MORNING DEBRIEF — 2026-09-09

Sources checked: the example repository, its issue list and the last few test runs. Read-only pass; nothing was posted or changed.

==================================================================
1. EXAMPLE PROJECT — CURRENT PRIORITIES
==================================================================

The sample project is focused on making scheduled jobs easier to operate. The next milestone is a small release that improves visibility and reduces repeated manual checks.

Why this matters:
  - A user needs a clear explanation when a scheduled job stops before completion. Include the failed step and a direct route to its logs.
  - Reviewers want one place to inspect pending changes and share feedback before publication.
  Notes: https://example.com/fixture/planning-note

Plan this week:
  a. Finish the status model and preserve worker conversation links.
  b. Add report grouping and validate review controls.
  c. Check narrow layouts with realistic report content.

==================================================================
2. REVIEWS — WHAT NEEDS A DECISION
==================================================================

Two focused patches are ready for review. Neither has been published. Review the current diff and confirm the target branch before continuing.

- Worker sessions: native conversation IDs remain attached to the original project.
- Run reports: related evidence is grouped under one report.

==================================================================
3. NEXT STEPS
==================================================================

Open the review workspace, check the validation notes, and choose the next task. Background monitoring remains paused until that decision is made.
`;
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
 await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter="review"]').click();if(process.env.CAPTURE_BEFORE){await page.screenshot({path:evidence('inbox-reading-before.png')});return;}
 assert.ok(await page.locator('#inbox-detail .inbox-body :is(h2,h3)').count()>=4);
 assert.equal(await page.locator('#inbox-detail').textContent().then(t=>t.includes('========')),false);
 assert.match(await page.locator('.document-section').first().textContent(),/01Example project — current priorities/);
 assert.match(await page.locator('.document-section').first().getAttribute('title'),/EXAMPLE PROJECT/);
 const type=await page.locator('.inbox-body').first().evaluate(n=>{const s=getComputedStyle(n);return [s.fontSize,s.lineHeight,s.fontWeight]});assert.deepEqual(type,['16px','24px','400']);
 const preserved=await page.evaluate(()=>{const n=document.createElement('article');renderDeskDocument(n,'## 1. SAMPLE SERVICES (SDK Tooling) — CLI AND API WORK');return {label:n.textContent,original:n.querySelector('h2').title};});
 assert.equal(preserved.label,'01Sample services (SDK Tooling) — CLI and API work');
 assert.equal(preserved.original,'1. SAMPLE SERVICES (SDK Tooling) — CLI AND API WORK');
 const emphasis=await page.evaluate(()=>{
  const n=document.createElement('article');renderDeskDocument(n,'Status: Ready to review.\n\n- Owner: **Example team**\n- Evidence: https://example.com/check\n- **Existing:** keep this.\n- Read `config.py`: keep code.\n- This sentence ends. Next: do not emphasize.\n- This is a long sentence with many words: leave it alone.\n\n```text\nStatus: code stays literal\n```');
  return {labels:[...n.querySelectorAll('.document-lead-in')].map(x=>x.textContent),nested:n.querySelectorAll('strong strong').length,link:n.querySelector('a').href,code:n.querySelector('pre').textContent};
 });
 assert.deepEqual(emphasis.labels,['Status:','Owner:','Evidence:']);assert.equal(emphasis.nested,0);assert.equal(emphasis.link,'https://example.com/check');assert.match(emphasis.code,/Status: code stays literal/);
 assert.equal(await page.locator('.document-lead-in').filter({hasText:'Worker sessions:'}).count(),1);
 const source=page.locator('.inbox-sources');assert.equal(await source.getAttribute('open'),null);
 await source.locator('summary').click();assert.ok(await source.locator('p').isVisible());await source.locator('summary').click();
 const original=page.locator('.inbox-body a[title]').first();assert.equal(await original.getAttribute('title'),await original.getAttribute('href'));
 assert.ok((await original.textContent()).length<100);
 await page.screenshot({path:evidence('inbox-reading-after.png')});
 await page.setViewportSize({width:390,height:844});await page.locator('#inbox-detail').scrollIntoViewIfNeeded();await page.screenshot({path:evidence('inbox-reading-mobile.png')});await page.setViewportSize({width:1440,height:1000});
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
