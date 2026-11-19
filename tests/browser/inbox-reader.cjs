// The Inbox with mocked APIs: what needs you, each report's own title, folding, links, the outline, and where replies go.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const evidence=require('./evidence.cjs');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],sent=[];page.on('pageerror',e=>errors.push(e.message));
 const now=Math.floor(Date.now()/1000);
 const log=Array.from({length:18},(_,i)=>`line ${i+1}: worker retried the write`).join('\n');
 const report=['# Release notes since v0.9.0','','Summary: one feature and a handful of fixes.','','## Features','- Side panel on every terminal.','- Review switches between pull requests.','','### Plugins','- One plugin.json per folder.','',
  '## Fixes','- One','- Two','- Three','- Four','- Five','- Six','- Seven','- Eight','','## Logs','```',log,'```','',
  '## Sources','- https://github.com/fixture/project/compare/v0.9.0...main','- [the changelog draft](https://example.com/changelog)','',
  '## Open questions','- Should the plugin move be called out as a migration?','','I could not reach older logs: https://github.com/fixture/project/actions/runs/7/job/11 so they are missing.'].join('\n');
 const store={roles:[{id:'r1',name:'Release notes researcher',kind:'researcher'},{id:'r2',name:'Flaky test fixer',kind:'fixer'}],
  runs:[{id:'run1',role_id:'r1',terminal_id:null,state:'review',created:now-600},{id:'run2',role_id:'r2',terminal_id:'t-open',state:'blocked',created:now-300}],
  inbox:[{id:'notes',role_id:'r1',event_key:'run:run1',title:'Release notes researcher · review',detail:report,state:'review',created:now-600,url:''},
   {id:'fixer',role_id:'r2',event_key:'run:run2',title:'Flaky test fixer · blocked',detail:'Flaky test fixer — run 08:00\n\n## Needs from you\n- OK to raise the wait to 20s?',state:'review',created:now-300,url:''}]};
 const waiting={id:'t-wait',name:'Demo agent',source:'adapter',status:'needs_input',question:'Run the migration on staging now?\n\n- **Yes**: run it now.\n- **No**: wait for tonight.',project:'Agent Desk',events:[],updated:now-120,harness:'claude',exit_code:null};
 const open={id:'t-open',name:'Flaky test fixer',source:'adapter',status:'idle',project:'Agent Desk',events:[],updated:now-300,harness:'claude',exit_code:null};
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(route.request().method()==='POST'&&['/api/coordinators/submit-feedback','/api/special-agents/follow-up'].includes(path)){sent.push({path,body:route.request().postDataJSON()});return route.fulfill({json:path.endsWith('follow-up')?{session:{id:'t-new'},run_id:'run3'}:{sent:true,target_id:route.request().postDataJSON().target_id}});}
  const data={'/api/agents':{agents:[waiting,open]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':store,'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/coordinator-events':{tasks:[]},'/api/pull-requests':{events:[]},'/api/inbox/cleared':{keys:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/');await page.locator('#open-inbox').click();
 await page.waitForFunction(()=>document.querySelectorAll('.inbox-row').length===3);
 // A session stopped on a question and a blocked run both need you; a finished report is ready for review.
 assert.deepEqual(await page.locator('.inbox-row').evaluateAll(rows=>rows.map(r=>[r.querySelector('strong').textContent,r.querySelector('.special-meta').textContent,r.querySelector('.inbox-category').textContent])),
  [['Run the migration on staging now?','Demo agent','Needs you'],['Flaky test fixer — run 08:00','Flaky test fixer','Needs you'],['Release notes since v0.9.0','Release notes researcher','Ready for review']]);
 assert.equal(await page.locator('[data-inbox-filter]').evaluateAll(b=>b.map(x=>x.dataset.inboxFilter).join(',')),'open,attention,review,history,all');

 // A waiting session: its offered answers become buttons, and an answer goes into its prompt as written.
 assert.equal(await page.locator('#inbox-detail > h2').textContent(),'Run the migration on staging now?');
 assert.equal(await page.locator('[data-inbox-action="reply"]').textContent(),'Answer');
 assert.deepEqual(await page.locator('.inbox-reply-quick button').allTextContents(),['Yes','No']);
 await page.screenshot({path:evidence('inbox-reader-01-waiting.png')});
 await page.locator('.inbox-reply-quick button',{hasText:'Yes'}).click();
 await page.waitForFunction(()=>document.querySelector('.inbox-reply-status')?.textContent.includes('Typed into its prompt'));
 assert.deepEqual(sent.map(s=>[s.path,s.body.target_id,s.body.prompt]),[['/api/coordinators/submit-feedback','t-wait','Yes']]);

 // A report whose session is still open: the reply is typed in, with the report it answers named.
 await page.locator('[data-inbox-item="fixer"]').click();
 assert.equal(await page.locator('#inbox-detail > h2').textContent(),'Flaky test fixer — run 08:00');
 assert.match(await page.locator('#inbox-detail > .special-meta').textContent(),/Blocked/);assert.match(await page.locator('.inbox-kicker').textContent(),/Flaky test fixer/);
 assert.match(await page.locator('.inbox-reply-route').textContent(),/Typed into its session, or queued/);
 await page.locator('.inbox-body li').first().hover();await page.locator('.inbox-quote-reply').click();
 await page.locator('#inbox-reply-text').press('End');await page.keyboard.type('Yes, for this test only.');
 // A refresh redraws the Inbox; the draft and the caret survive it.
 await page.locator('.inbox-reply').evaluate(n=>n.dataset.before='yes');
 store.inbox[0].created-=60;await page.evaluate(()=>window.refreshAutomations());
 await page.waitForFunction(()=>!document.querySelector('.inbox-reply')?.dataset.before,null,{timeout:5000});
 assert.equal(await page.evaluate(()=>document.activeElement?.id),'inbox-reply-text','the box keeps focus through the redraw');
 assert.equal(await page.locator('#inbox-reply-text').inputValue(),'> OK to raise the wait to 20s?\n\nYes, for this test only.');
 await page.locator('#inbox-reply-text').press('Meta+Enter');
 await page.waitForFunction(n=>document.querySelectorAll('.inbox-reply-status').length===n,1);
 assert.deepEqual([sent[1].body.target_id,sent[1].body.prompt],['t-open','Reply from your Inbox about “Flaky test fixer — run 08:00”:\n\n> OK to raise the wait to 20s?\n\nYes, for this test only.']);

 // A finished run's long report: its own title, folded log and list, links, outline, and a follow-up pass.
 await page.locator('[data-inbox-item="notes"]').click();
 const head=page.locator('#inbox-detail > h2');assert.equal(await head.textContent(),'Release notes since v0.9.0');
 assert.equal(await page.locator('#inbox-detail .inbox-body h1').count(),0,'the title is not repeated in the body');
 assert.equal(await page.locator('.inbox-show-all').allTextContents().then(t=>t.join('|')),'Show 3 more|Show all 18 lines');
 assert.equal(await page.locator('.inbox-body li:visible',{hasText:'Seven'}).count(),0);
 await page.locator('.inbox-show-all',{hasText:'Show 3 more'}).click();assert.equal(await page.locator('.inbox-body li:visible',{hasText:'Seven'}).count(),1);
 assert.deepEqual(await page.locator('.inbox-body a.inbox-address').evaluateAll(a=>a.map(x=>x.textContent)),['github.com/fixture/project/compare/v0.9.0...main']);
 assert.equal(await page.locator('.inbox-body a',{hasText:'the changelog draft'}).count(),1,'a named link keeps its name');
 assert.deepEqual(await page.locator('.inbox-body a.inbox-footnote').evaluateAll(a=>a.map(x=>[x.textContent,x.title])),[['1','https://github.com/fixture/project/actions/runs/7/job/11']]);
 assert.deepEqual(await page.locator('.inbox-links li').allTextContents(),['github.com/fixture/project/actions/runs/7/job/11']);
 assert.deepEqual(await page.locator('.inbox-outline a').evaluateAll(a=>a.map(x=>[x.textContent,x.className.includes('sub')])),[['Features',false],['Plugins',true],['Fixes',false],['Logs',false],['Sources',false],['Open questions',false]]);
 await page.locator('#inbox-detail').evaluate(d=>{d.style.scrollBehavior='auto';d.scrollTo(0,0);});
 await page.waitForFunction(()=>document.querySelector('.inbox-outline a.on')?.textContent==='Features');
 await page.locator('#inbox-detail').evaluate(d=>{d.style.scrollBehavior='auto';d.scrollTo(0,d.scrollHeight);});
 await page.waitForFunction(()=>document.querySelector('.inbox-outline a.on')?.textContent==='Open questions');
 await page.screenshot({path:evidence('inbox-reader-02-report-scrolled.png')});
 assert.match(await page.locator('.inbox-reply-route').textContent(),/session has ended/);
 await page.locator('#inbox-reply-text').fill('Call out the plugin move as a migration.');await page.locator('.inbox-reply-send').click();
 await page.waitForFunction(()=>document.querySelector('.inbox-reply-status')?.textContent.includes('Follow-up pass started'));
 assert.deepEqual(sent[2],{path:'/api/special-agents/follow-up',body:{id:'notes',reply:'Call out the plugin move as a migration.',desk:sent[2].body.desk}});
 assert.ok(sent[2].body.desk);

 await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),390);
 assert.equal(await page.locator('.inbox-outline').isVisible(),false,'no outline at phone width');
 await page.locator('#inbox-detail > h2').scrollIntoViewIfNeeded();await page.screenshot({path:evidence('inbox-reader-03-narrow.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: inbox reader: waiting sessions and blocked runs need you, reports show their own title, quick answers, replies to open sessions and follow-up passes, drafts survive redraws, folded logs and lists, addresses and footnotes, nested outline that follows the scroll, 390px; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
