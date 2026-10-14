const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],writes=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 const now=Math.floor(Date.now()/1000);
 const store={roles:[
   {id:'r1',name:'Slack triage',kind:'watcher',scope:'#demo-alerts, #demo-builds, #demo-releases, #demo-questions — exclude #demo-chatter, #demo-offtopic and any DM threads, ignore anything already linked to an issue, and skip messages older than seven days',instructions:'x',cwd:'/tmp',choice:'claude',mode:'/bin/zsh'},
   {id:'r2',name:'DEMO-123 sample-data reconciliation',kind:'researcher',scope:'example-api repository',instructions:'x',cwd:'/tmp',choice:'codex',mode:'/bin/zsh'},
   {id:'r3',name:'Docs drift fixer',kind:'fixer',scope:'docs/ and README.md',instructions:'x',cwd:'/tmp',choice:'claude-personal',mode:'/bin/zsh'}],
  runs:[{id:'run1',role_id:'r1',terminal_id:'t1',state:'review',detail:'Found 3 threads that need a reply.',created:now-7200},
        {id:'run2',role_id:'r2',terminal_id:null,state:'blocked',detail:'Needs repository access.',created:now-600}],
  inbox:[]};
 let refuse=false;
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/special-agents/delete'){const body=route.request().postDataJSON();writes.push(body.id);
   if(refuse)return route.fulfill({status:400,json:{error:'Run & Schedule still uses this automation as a task (Nightly build). Remove that launch configuration first.'}});
   store.roles=store.roles.filter(role=>role.id!==body.id);return route.fulfill({json:{deleted:body.id}});}
  if(route.request().method()==='POST'&&path!=='/api/feedback')writes.push(path);
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':store,'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-special-agents').click();
 await page.waitForFunction(()=>document.querySelectorAll('.automation-card').length===3);
 const first=page.locator('.automation-card').first();
 // One status, one scope, one primary action: the card reads top to bottom.
 assert.equal(await first.locator('h3').innerText(),'Slack triage');
 assert.equal(await first.locator('.automation-kind').innerText(),'Watcher');
 assert.equal(await first.locator('.automation-dot').getAttribute('data-tone'),'review');
 assert.equal(await first.locator('.automation-state').innerText(),'Ready for review');
 assert.equal(await first.locator('.automation-when').innerText(),'2h ago');
 assert.equal(await first.locator('.automation-detail').innerText(),'Found 3 threads that need a reply.');
 assert.deepEqual(await first.locator('.automation-links .text-button').allInnerTexts(),['Edit','Schedule','Open session','Delete']);
 assert.equal(await first.locator('.automation-run').innerText(),'Run now');
 assert.equal(await page.locator('.automation-card').nth(1).locator('.automation-dot').getAttribute('data-tone'),'problem');
 assert.equal(await page.locator('.automation-card').nth(2).locator('.automation-state').innerText(),'Never run');
 // A long scope is clamped rather than stretching its card past the others.
 const heights=await page.$$eval('.automation-card',cards=>cards.map(card=>Math.round(card.getBoundingClientRect().height)));
 assert.equal(new Set(heights).size,1,'automation cards are uneven: '+heights.join(','));
 const clamped=await first.locator('.automation-scope').evaluate(n=>n.scrollHeight>n.clientHeight+1);
 assert.equal(clamped,true,'the long scope is not clamped');
 await page.screenshot({path:evidence('agentdesk-automation-cards.png')});
 // Delete asks first, in the app's own dialog, and cancelling writes nothing.
 await first.locator('.automation-delete').click();
 await page.waitForSelector('.automation-delete-dialog[open]');
 assert.equal(await page.locator('.automation-delete-name').innerText(),'Slack triage');
 assert.match(await page.locator('.automation-delete-dialog').innerText(),/stay in your Inbox/);
 await page.screenshot({path:evidence('agentdesk-automation-delete.png')});
 await page.locator('.automation-delete-cancel').click();
 await page.waitForFunction(()=>!document.querySelector('.automation-delete-dialog[open]'));
 assert.deepEqual(writes,[]);
 assert.equal(await page.locator('.automation-card').count(),3);
 // A backend refusal stays visible in the dialog instead of closing over it.
 refuse=true;
 await first.locator('.automation-delete').click();await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(()=>document.querySelector('.automation-delete-dialog [role=alert]').textContent.includes('Run & Schedule'));
 assert.equal(await page.locator('.automation-delete-dialog').isVisible(),true);
 assert.equal(await page.locator('.automation-card').count(),3);
 // Confirming removes just that automation.
 refuse=false;
 await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(()=>document.querySelectorAll('.automation-card').length===2);
 assert.deepEqual(writes,['r1','r1']);
 assert.deepEqual(await page.locator('.automation-card h3').allInnerTexts(),['DEMO-123 sample-data reconciliation','Docs drift fixer']);
 assert.equal(await page.locator('.automation-delete-dialog').isVisible(),false);
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('.automation-card').first().locator('.automation-run').isVisible(),true);
 await page.screenshot({path:evidence('agentdesk-automation-cards-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: automation card hierarchy, status tone, clamped scope, equal heights, delete asks in-app, refusal stays visible, delete removes one; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
