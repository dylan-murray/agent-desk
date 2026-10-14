require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');
const assert=require('node:assert/strict');
const path=require('node:path');
const os=require('node:os');
const base=process.env.AGENT_DESK_TEST_URL;
const evidence=process.env.AGENT_DESK_FEEDBACK_EVIDENCE_DIR||os.tmpdir();
const capture=(page,name)=>page.screenshot({path:path.join(evidence,'2026-09-17-feedback-'+name+'.png'),animations:'disabled'});
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1920,height:958}}),errors=[],submissions=[],otherWrites=[];await withAccounts(page);
  page.on('pageerror',error=>errors.push(error.message));
  let feedback={notes:[],deleted:[]},busy=true,unsupported=false;
  const common={cwd:'/tmp/agent-desk-example',project:'agent-desk',events:[],exit_code:null,status:'idle'};
  const live=[
   {...common,id:'terminal-ui',terminal_id:'terminal-ui',name:'Codex · Personal · resumed',launch_profile:'codex-personal',harness:'zsh'},
   {...common,id:'terminal-docs',terminal_id:'terminal-docs',name:'Claude',display_name:'Docs review',launch_profile:'claude',harness:'claude'},
   {...common,id:'coordinator-ui',name:'UI planning',coordinator_workspace:true,harness:'claude'},
   {...common,id:'terminal-child',terminal_id:'terminal-child',name:'Worker',display_name:'Polish controls',parent_id:'coordinator-ui',launch_profile:'codex',harness:'codex'},
   {...common,id:'terminal-exited',terminal_id:'terminal-exited',name:'Finished agent',exit_code:0,harness:'codex'},
   {...common,id:'process-fixture',name:'Codex session',task:'External reviewer',harness:'codex'},
   {...common,id:'terminal-shell',terminal_id:'terminal-shell',name:'Project shell',harness:'zsh'}
  ];
  const configs=['Morning review','Project preview','Weekly summary','Review changed files'].map((name,i)=>({id:'config-'+i,name,kind:'command',cwd:common.cwd}));
  await page.route('**/api/**',async route=>{
   const request=route.request(),p=new URL(request.url()).pathname;
   if(p==='/api/coordinators/feedback-status')return route.fulfill({json:{submissions:[]}});
   if(p==='/api/feedback'){
    if(request.method()==='POST'){
     const sent=request.postDataJSON(),deleted=new Set([...feedback.deleted,...sent.deleted]);
     feedback={notes:[...new Map([...feedback.notes,...sent.notes].map(n=>[n.id,n])).values()].filter(n=>!deleted.has(n.id)),deleted:[...deleted]};
    }
    return route.fulfill({json:feedback});
   }
   if(p==='/api/coordinators/submit-feedback'){
    submissions.push(request.postDataJSON());await new Promise(resolve=>setTimeout(resolve,100));
    return route.fulfill(busy?{status:400,json:{error:'Agent prompt is busy. Nothing was sent.'}}:{json:{sent:true}});
   }
   if(request.method()==='POST'&&!['/api/terminals/resize'].includes(p)){otherWrites.push(p);return route.fulfill({status:400,json:{error:'Fixture prevents live actions'}});}
   if(p==='/api/event-bus')return route.fulfill(unsupported?{status:404,json:{error:'Not found'}}:{json:{sources:[
    {id:'source-slack',name:'Slack triage',kind:'webhook',enabled:true,last_seen:1789659000,last_error:null,settings:{}},
    {id:'source-files',name:'Project files',kind:'directory',enabled:false,last_seen:null,last_error:null,settings:{path:'/tmp/agent-desk-example'}}
   ],events:[],queued:0,capacity:256,policy:'Up to 256 waiting events are retained for 24 hours. Adapters retry deliveries while Agent Desk is asleep or offline.'}});
   const fixtures={'/api/agents':{agents:live},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/workflows':{configs,workflows:[],flows:[],executions:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/coordinators':{coordinators:[{id:'coordinator-closed',name:'Closed planning',state:'closed'}]},'/api/terminals/output':{data:'',cursor:0,exit_code:null}};
   return route.fulfill({json:fixtures[p]||{}});
  });
  await page.goto(base);await page.locator('#open-workflows').click();
  await page.evaluate(()=>{terminalActivity.set('terminal-ui',{title:'Event triggers',connected:true,lastOutput:Date.now()});render();});
  assert.match(await page.locator('[data-agent-id="terminal-ui"] .session-name').textContent(),/Event triggers/);
  assert.equal(await page.locator('#event-sources').isVisible(),false);
  assert.equal(await page.locator('#open-event-sources').isVisible(),true);
  const trash=page.locator('.config-delete').first();assert.equal(await trash.getAttribute('aria-label'),'Delete');
  assert.equal(await trash.locator('svg').count(),1);assert.ok((await trash.boundingBox()).width<=32);
  await trash.hover();await capture(page,'after-workflows');
  await page.locator('#open-event-sources').click();await page.locator('[data-source-id="source-slack"]').waitFor();
  await capture(page,'after-sources');
  await page.setViewportSize({width:390,height:844});await capture(page,'after-sources-narrow');
  assert.ok(await page.locator('#event-sources-dialog').evaluate(d=>d.getBoundingClientRect().right<=innerWidth));
  await page.locator('#annotation-launcher').click();
  await page.waitForFunction(()=>document.getElementById('annotation-layer').parentElement.id==='event-sources-dialog');
  await page.keyboard.press('Escape');assert.equal(await page.locator('#event-sources-dialog').evaluate(d=>d.open),true);
  await page.locator('.event-manager-close').click();
  await page.setViewportSize({width:1440,height:1000});
  await page.locator('#new-workflow').click();await page.locator('#schedule-trigger').selectOption('event');
  await page.locator('#schedule-event-source option').first().waitFor({state:'attached'});
  await page.locator('#schedule-event-field').fill('event.type');await page.locator('#schedule-event-value').fill('message');
  await page.locator('#manage-event-sources').click();await page.locator('.event-manager-close').click();
  assert.equal(await page.locator('#schedule-event-field').inputValue(),'event.type');
  assert.equal(await page.locator('#schedule-event-value').inputValue(),'message');
  await page.locator('#schedule-dialog').evaluate(d=>d.close());
  await page.locator('#annotation-launcher').click();
  await page.locator('#run-configs h3').first().click();await page.locator('#annotation-note').fill('Make this action easier to find');
  await page.evaluate(()=>{window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='agent-desk-feedback')throw Error('Fixture storage failure');return window.originalSetItem.call(this,key,value);};});
  await page.locator('#annotation-note-save').click();assert.equal(await page.locator('#annotation-note-panel').isVisible(),true);
  assert.equal(await page.locator('#annotation-note').inputValue(),'Make this action easier to find');
  await page.evaluate(()=>{Storage.prototype.setItem=window.originalSetItem;});
  await page.locator('#annotation-note-save').evaluate(button=>{button.click();button.click();});
  await page.locator('#annotation-note-panel').waitFor({state:'hidden'});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agent-desk-feedback')).length===1);
  assert.equal(await page.locator('#annotation-launcher').getAttribute('aria-pressed'),'true');
  await capture(page,'after-saved');
  await page.locator('#annotation-send').click();await page.locator('.annotation-agent').first().waitFor();
  assert.equal(await page.locator('.annotation-agent').count(),6);
  assert.match(await page.locator('#annotation-recipient-list').textContent(),/Event triggers/);
  assert.doesNotMatch(await page.locator('#annotation-recipient-list').textContent(),/Closed planning|Finished agent|Codex · Personal · resumed/);
  assert.equal(await page.locator('.annotation-agent[data-agent-id="process-fixture"] input').isEnabled(),false);
  await page.locator('.annotation-agent[data-agent-id="terminal-child"] input').check();
  assert.equal(await page.locator('#annotation-recipient').inputValue(),'coordinator-ui');
  assert.match(await page.locator('#annotation-recipient-detail').textContent(),/UI planning/);
  await page.locator('.annotation-agent[data-agent-id="terminal-docs"] input').check();
  live[1].display_name='Documentation pass';await page.locator('#annotation-agent-refresh').click();
  await page.getByText('Documentation pass',{exact:true}).last().waitFor();
  assert.equal(await page.locator('#annotation-recipient').inputValue(),'terminal-docs');
  await page.locator('#annotation-agent-search').fill('event trig');assert.equal(await page.locator('.annotation-agent').count(),1);
  await page.locator('.annotation-agent input').check();assert.equal(await page.locator('#annotation-recipient').inputValue(),'terminal-ui');
  await page.locator('#annotation-agent-search').fill('');await capture(page,'after-recipient');
  await page.setViewportSize({width:390,height:844});await capture(page,'after-recipient-narrow');
  assert.ok(await page.locator('#annotation-send-dialog').evaluate(d=>d.getBoundingClientRect().right<=innerWidth));
  await page.locator('#annotation-send-form [type=submit]').click();
  await page.waitForFunction(()=>document.getElementById('annotation-send-status').textContent.includes('busy'));
  assert.equal(await page.locator('#annotation-send-dialog').evaluate(d=>d.open),true);
  busy=false;
  await page.locator('#annotation-send-form').evaluate(form=>{form.dispatchEvent(new Event('submit',{cancelable:true}));form.dispatchEvent(new Event('submit',{cancelable:true}));});
  await page.locator('#annotation-send-dialog').waitFor({state:'hidden'});
  assert.equal(submissions.length,2);assert.equal(submissions[0].request_id,submissions[1].request_id);
  assert.equal(submissions[1].target_id,'terminal-ui');assert.equal(submissions[1].notes.length,1);
  assert.equal(await page.locator('#annotation-launcher').getAttribute('aria-pressed'),'false');
  await page.locator('#annotation-launcher').click();await page.locator('#annotation-send').click();
  await page.locator('.annotation-agent').first().waitFor();
  assert.equal(await page.locator('#annotation-send-notes input:checked').count(),0);
  assert.equal(await page.locator('#annotation-send-form [type=submit]').isEnabled(),false);
  await page.locator('.annotation-send-cancel').click();await page.keyboard.press('Escape');
  await page.locator('.feedback-pin').click();await page.locator('#annotation-note-delete').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('agent-desk-feedback-deleted')).length===1);
  assert.equal(feedback.notes.length,0);assert.equal(feedback.deleted.length,1);
  unsupported=true;await page.reload();await page.locator('#open-workflows').click();
  assert.equal(await page.locator('#event-bus-status').isVisible(),false);
  await page.locator('#open-event-sources').click();
  await page.waitForFunction(()=>document.getElementById('event-bus-status').textContent.includes('Restart Agent Desk'));
  assert.equal(await page.locator('#new-event-source').isEnabled(),false);
  assert.equal(await page.locator('.feedback-pin').count(),0);
  assert.deepEqual(otherWrites,[]);assert.deepEqual(errors,[]);
  console.log('PASS: one-save annotation close, storage failure preserves draft, named/searchable live recipients, title parity, refresh/selection, worker routing, visible unsupported sessions, busy retry with one request ID, successful-send close, receipts, deletion tombstone, source manager placement/draft retention/modal access, trash control, desktop/narrow layouts; mocked APIs only.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1)});
