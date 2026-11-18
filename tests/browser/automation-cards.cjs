const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],writes=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 const now=Math.floor(Date.now()/1000);
 const store={roles:[
   {id:'r1',name:'Slack triage',kind:'watcher',scope:'#demo-alerts, #demo-builds, #demo-releases, #demo-questions — exclude #demo-chatter, #demo-offtopic and any DM threads, ignore anything already linked to an issue, and skip messages older than seven days',instructions:'x',cwd:'/tmp',choice:'claude',mode:'/bin/zsh'},
   {id:'r2',name:'DEMO-123 sample-data reconciliation',kind:'researcher',scope:'example-api repository',instructions:'x',cwd:'/tmp',choice:'codex',mode:'/bin/zsh'},
   {id:'r3',name:'Docs drift fixer',kind:'fixer',scope:'docs/ and README.md',instructions:'x',cwd:'/tmp',choice:'claude-personal',mode:'/bin/zsh',
    uses:{configs:[{id:'c3',name:'Docs drift fixer'}],schedules:[{id:'w1',name:'Nightly docs',trigger:'cron',cron:'0 9 * * 1-5',timezone:'UTC',enabled:true,others:0},{id:'w2',name:'Release prep',trigger:'manual',enabled:true,others:2}]}},
   {id:'r4',name:'Flaky test watcher',kind:'watcher',scope:'CI on main',instructions:'x',cwd:'/tmp',choice:'claude',mode:'/bin/zsh'}],
  runs:[{id:'run1',role_id:'r1',terminal_id:'t1',state:'review',detail:'Found 3 threads that need a reply.',created:now-7200},
        {id:'run2',role_id:'r2',terminal_id:null,state:'blocked',detail:'Needs repository access.',created:now-600},
        {id:'run4',role_id:'r4',terminal_id:'t4',state:'running',created:now-120}],
  inbox:[]};
 let refuse=false;const bodies=[];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/special-agents/delete'){const body=route.request().postDataJSON();writes.push(body.id);bodies.push(body);
   if(refuse)return route.fulfill({status:400,json:{error:'Run & Schedule still uses this automation as a task (Nightly build). Remove that launch configuration first.'}});
   store.roles=store.roles.filter(role=>role.id!==body.id);return route.fulfill({json:{deleted:body.id}});}
  if(route.request().method()==='POST'&&!['/api/feedback','/api/editor/pending'].includes(path))writes.push(path);
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':store,'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-special-agents').click();
 await page.waitForFunction(()=>document.querySelectorAll('.automation-card').length===4);
 const first=page.locator('.automation-card').first();
 // One status, one scope, one primary action: the card reads top to bottom.
 assert.equal(await first.locator('h3').innerText(),'Slack triage');
 assert.equal(await first.locator('.automation-kind').innerText(),'Watcher');
 assert.equal(await first.locator('.automation-dot').getAttribute('data-tone'),'review');
 assert.equal(await first.locator('.automation-state').innerText(),'Ready for review');
 assert.equal(await first.locator('.automation-when').first().innerText(),'2h ago');
 assert.equal(await first.locator('.automation-detail').innerText(),'Found 3 threads that need a reply.');
 // One main button and the schedule on a shelf, Edit and Delete as icons; the last session is reached from the status.
 assert.equal(await first.locator('.automation-run').innerText(),'Run now');
 assert.match(await first.locator('.automation-run').getAttribute('class'),/\bautomation-start\b/);
 assert.equal(await first.locator('.automation-schedule').innerText(),'Schedule…');
 assert.match(await first.locator('.automation-schedule').getAttribute('class'),/unscheduled/);
 assert.deepEqual(await first.locator('.automation-icon').evaluateAll(b=>b.map(x=>x.getAttribute('aria-label'))),['Edit Slack triage','Delete Slack triage']);
 assert.equal(await first.locator('.automation-open-last').innerText(),'Open last session');
 assert.equal(await first.locator('.automation-actions .text-button:not(.automation-schedule):not(.automation-icon)').count(),0,'no text links left in the footer');
 const scheduled=page.locator('.automation-card').nth(2),running=page.locator('.automation-card').nth(3);
 assert.equal(await scheduled.locator('.automation-schedule').innerText(),'Weekdays 09:00 +1');
 assert.deepEqual(await first.locator('.automation-run').evaluate(b=>[getComputedStyle(b).backgroundColor,getComputedStyle(b.querySelector('svg')).stroke]),['rgb(35, 35, 38)','rgb(127, 176, 239)'],'Run now is a plain button with a blue play mark');
 assert.equal(await scheduled.locator('.automation-schedule').getAttribute('title'),'Nightly docs · Monday–Friday at 09:00\nRelease prep · Run by hand');
 assert.equal(await running.locator('.automation-run').innerText(),'Open session');
 assert.match(await running.locator('.automation-run').getAttribute('class'),/automation-live/);
 assert.equal(await running.locator('.automation-open-last').count(),0,'a running card offers its session as the main button instead');
 const shelf=await first.locator('.automation-actions').evaluate(n=>({line:getComputedStyle(n).borderTopStyle,card:n.closest('.automation-card').getBoundingClientRect().bottom-n.getBoundingClientRect().bottom}));
 assert.equal(shelf.line,'solid');assert.ok(shelf.card<=1.5,'the shelf runs to the bottom of the card: '+shelf.card);
 assert.equal(await page.locator('.automation-card').nth(1).locator('.automation-dot').getAttribute('data-tone'),'problem');
 await page.locator('.automation-card').nth(1).hover();await page.waitForTimeout(200);
 assert.equal(await page.locator('.automation-card').nth(2).locator('.automation-state').innerText(),'Never run');
 // A long scope is clamped rather than stretching its card past the others.
 const heights=await page.$$eval('.automation-card',cards=>cards.filter(card=>card.getBoundingClientRect().top===cards[0].getBoundingClientRect().top).map(card=>Math.round(card.getBoundingClientRect().height)));
 assert.equal(heights.length,3);assert.equal(new Set(heights).size,1,'automation cards in a row are uneven: '+heights.join(','));
 const clamped=await first.locator('.automation-scope').evaluate(n=>n.scrollHeight>n.clientHeight+1);
 assert.equal(clamped,true,'the long scope is not clamped');
 await page.screenshot({path:evidence('agentdesk-automation-cards.png')});
 // Delete asks first, in the app's own dialog, and cancelling writes nothing.
 await first.locator('.automation-delete').click();
 await page.waitForSelector('.automation-delete-dialog[open]');
 assert.equal(await page.locator('.automation-delete-name').innerText(),'Slack triage');
 assert.match(await page.locator('.automation-delete-dialog').innerText(),/stay in your Inbox/);
 assert.equal(await page.locator('.automation-delete-uses').isVisible(),false,'nothing in Run & Schedule to list');
 assert.equal(await page.locator('.automation-delete-confirm').innerText(),'Delete automation');
 await page.screenshot({path:evidence('agentdesk-automation-delete.png')});
 await page.locator('.automation-delete-cancel').click();
 await page.waitForFunction(()=>!document.querySelector('.automation-delete-dialog[open]'));
 assert.deepEqual(writes,[]);
 assert.equal(await page.locator('.automation-card').count(),4);
 // A backend refusal stays visible in the dialog instead of closing over it.
 refuse=true;
 await first.locator('.automation-delete').click();await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(()=>document.querySelector('.automation-delete-dialog [role=alert]').textContent.includes('Run & Schedule'));
 assert.equal(await page.locator('.automation-delete-dialog').isVisible(),true);
 assert.equal(await page.locator('.automation-card').count(),4);
 // Confirming removes just that automation.
 refuse=false;
 await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(()=>document.querySelectorAll('.automation-card').length===3);
 assert.deepEqual(writes,['r1','r1']);
 assert.deepEqual(bodies.map(b=>b.remove_schedules),[false,false]);
 assert.deepEqual(await page.locator('.automation-card h3').allInnerTexts(),['DEMO-123 sample-data reconciliation','Docs drift fixer','Flaky test watcher']);
 assert.equal(await page.locator('.automation-delete-dialog').isVisible(),false);
 // An automation on schedules names them, says which go and which keep their other tasks, and removes them with it.
 await page.locator('.automation-card').nth(1).locator('.automation-delete').click();
 await page.waitForSelector('.automation-delete-dialog[open]');
 assert.deepEqual(await page.locator('.automation-delete-uses li').allInnerTexts(),['Nightly docs\nMonday–Friday at 09:00 · deleted','Release prep\nRun by hand · keeps its other 2 tasks']);
 assert.equal(await page.locator('.automation-delete-confirm').innerText(),'Delete and remove 1 schedule');
 assert.match(await page.locator('.automation-delete-note').innerText(),/removes these too/);
 await page.screenshot({path:evidence('agentdesk-automation-delete-schedules.png')});
 await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(()=>document.querySelectorAll('.automation-card').length===2);
 assert.deepEqual(bodies.at(-1),{id:'r3',remove_schedules:true});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('.automation-card').first().locator('.automation-run').isVisible(),true);
 await page.screenshot({path:evidence('agentdesk-automation-cards-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: automation card hierarchy, status tone, clamped scope, equal heights, one main button and schedule on a shelf with Edit and Delete icons, open last session in the status, running card opens its session, delete asks in-app, refusal stays visible, delete removes one, delete names and removes its schedules; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
