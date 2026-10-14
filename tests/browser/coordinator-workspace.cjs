const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await withAccounts(page);const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const coordinators=[],messages=[],savedWorkers=[],contextNotes=[],contextWatches=[];let readerConfig=null;let managed=[],workerReviews=[];
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();writes.push({path,body});
   if(path==='/api/coordinators/models')return route.fulfill({json:{models:['test-model','another-model'],source:'Fixture model choices'}});
   if(path==='/api/coordinators/configure'){const c=coordinators.find(c=>c.id===body.id);c.model=body.model;return route.fulfill({json:c});}
   if(path==='/api/coordinators/close'){const c=coordinators.find(c=>c.id===body.id);c.closed=1;c.paused=1;return route.fulfill({json:{closed:true}});}
   if(path==='/api/coordinators/reopen'){const c=coordinators.find(c=>c.id===body.id);c.closed=0;return route.fulfill({json:c});}
   if(path==='/api/coordinators/review-worker')return route.fulfill({json:{session_id:'native-session-123',task:'Review terminal rendering',result:'# Outcome\n\nFinal report: tests passed.\n\nChanges\n- Cleaner terminal text\n- Preserved colors\n\n```python\nprint("done")\n```'}});
   if(path==='/api/coordinators/quota')return route.fulfill({json:{profile:'claude-personal',label:'Claude · Personal',state:'ready',fetched_at:Date.now()/1000,windows:[{label:'5 hours',remaining_percent:93,resets_at:Date.now()/1000+3600},{label:'Weekly',remaining_percent:85,resets_at:Date.now()/1000+86400}]}});
   if(path==='/api/coordinators/context')return route.fulfill({json:{notes:contextNotes,artifacts:[{id:'fixture-artifact',title:'Test report',bytes:24000}],reader:readerConfig,cache_hits:3,cached_input_bytes:12000,watches:contextWatches}});
   if(path==='/api/coordinators/save-memory'){contextNotes.push({name:body.name,text:body.text,source:'user'});return route.fulfill({json:{saved:true}});}
   if(path==='/api/coordinators/delete-memory'){contextNotes.splice(contextNotes.findIndex(n=>n.name===body.name),1);return route.fulfill({json:{deleted:true}});}
   if(path==='/api/coordinators/retrieve')return route.fulfill({json:body.reference?{reference:body.reference,title:'Saved report',text:'Literal <script>window.contextInjected=true</script> and https://example.test/report',next_offset:null}:{matches:[{reference:'message:1',kind:'user',excerpt:'Do not merge',offset:0}],next_offset:null}});
   if(path==='/api/coordinators/configure-reader'){readerConfig=body.enabled?{profile:body.profile,model:body.model}:null;return route.fulfill({json:{enabled:body.enabled}});}
   if(path==='/api/coordinators/watch-pr'){contextWatches.push({id:'watch-test',url:body.url,state:'watching',detail:'Waiting for check'});return route.fulfill({json:{id:'watch-test'}});}
   if(path==='/api/coordinators/stop-watch'){contextWatches[0].state='stopped';return route.fulfill({json:{stopped:true}});}
   if(path==='/api/coordinators/rename'){const c=coordinators.find(c=>c.id===body.id);c.name=body.name;return route.fulfill({json:c});}
   if(path==='/api/coordinators/create'){const c={id:coordinators.length?'created-'+coordinators.length:'coordinator-test',name:body.name,cwd:body.cwd,profile:body.profile,model:body.model,state:'idle',paused:0};coordinators.push(c);return route.fulfill({json:c});}
   if(path==='/api/coordinators/message'){
    messages.push({id:messages.length+1,kind:'user',text:body.text});messages.push({id:messages.length+1,kind:'assistant',text:'I’ll have a worker review the terminal rendering, then bring its findings back here.'});messages.push({id:messages.length+1,kind:'tool',text:'Launched Terminal review · Claude Personal'});
    managed=[{id:'worker-test',parent_id:'coordinator-test',source:'terminal',terminal_id:'worker-test',name:'Terminal review',project:'agent-desk',cwd:'/tmp/project',harness:'claude',status:'working',events:[],exit_code:null,task:'Review terminal rendering'}];return route.fulfill({json:{saved:true}});
   }
   if(path==='/api/coordinators/retire-worker'){
    assert.equal(body.confirmed,true);managed=[];workerReviews=[];savedWorkers.push({worker:'worker-test',name:'Terminal review',cwd:'/tmp/project',profile:'claude-personal',state:'saved',can_resume:true,report_task_id:'report-worker-test'});return route.fulfill({json:{saved:true}});
   }
   if(path==='/api/coordinators/resume-worker'){
    savedWorkers[0].state='active';savedWorkers[0].can_resume=false;return route.fulfill({json:{worker_id:'coordinator-test'}});
   }
   if(path==='/api/coordinators/pause'){coordinators[0].paused=1;return route.fulfill({json:{paused:true}});}
   return route.fulfill({status:400,json:{error:'Fixture prevents mutations'}});
  }
  const data={'/api/coordinators':{coordinators,messages,context_features:true,quota_features:true,review_features:true,actions:[],saved_workers:savedWorkers,worker_reviews:workerReviews,usage:{turns:2,reported_turns:1,totals:{input_tokens:1200,output_tokens:100,cached_input_tokens:900},last:{context_bytes:4096,estimated_input_tokens:2000,context_trimmed:true},context_limit_bytes:96000}},'/api/agents':{agents:[...managed,...coordinators.filter(c=>!c.closed).map(c=>({...c,coordinator_workspace:true,controller:true,source:'coordinator',project:'agent-desk',harness:'claude',status:'idle',task:'Coordinate work',events:[]}))]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp/project'},'/api/feedback':{notes:[],deleted:[]},'/api/coordinator-events':{tasks:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/projects':{projects:[],roots:[],limited:false}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#new-controller').click();
 await page.locator('[data-coord-id="coord-create-dialog"]').waitFor({state:'visible'});await page.locator('[data-coord-id="coord-name"]').fill('Agent Desk development');await page.locator('[data-coord-id="coord-cwd"]').fill('/tmp/project');assert.deepEqual(await page.locator('[data-coord-id="coord-profile"] option').evaluateAll(options=>options.map(o=>o.value)),['codex','codex-personal','claude','claude-personal','grok','opencode','pi']);
 await page.getByRole('combobox',{name:'Reasoning provider & account'}).click();await page.getByRole('option',{name:'Claude · Personal',exact:true}).click();
 const modelChoice=page.getByRole('combobox',{name:'Coordinator model',exact:true});
 await modelChoice.click();await page.getByRole('option',{name:'test-model',exact:true}).waitFor();
 await modelChoice.press('ArrowDown');await modelChoice.press('ArrowDown');await modelChoice.press('Enter');assert.equal(await modelChoice.inputValue(),'test-model');
 await modelChoice.fill('custom/model');await page.getByRole('option',{name:'Use “custom/model”',exact:true}).click();assert.equal(await modelChoice.inputValue(),'custom/model');
 await modelChoice.click();await modelChoice.press('Escape');assert.equal(await page.locator('dialog[open]').count(),1);assert.equal(await modelChoice.getAttribute('aria-expanded'),'false');
 await modelChoice.click();await page.getByRole('option',{name:'CLI default',exact:true}).click();assert.equal(await modelChoice.inputValue(),'');
 await page.locator('dialog[open]').screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-coordinator-form-after.png')});
 await page.getByRole('combobox',{name:'Reasoning provider & account'}).click();
 await page.locator('dialog[open]').screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-coordinator-provider-after.png')});
 await page.getByRole('combobox',{name:'Reasoning provider & account'}).press('Escape');
 await page.setViewportSize({width:390,height:844});await modelChoice.click();
 assert.equal(await page.getByRole('listbox',{name:'Coordinator models'}).evaluate(n=>n.getBoundingClientRect().right<=390),true);
 await page.locator('dialog[open]').screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-coordinator-model-mobile.png')});
 await modelChoice.press('Tab');assert.equal(await modelChoice.getAttribute('aria-expanded'),'false');await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-coord-id="coord-create-form"] button[type=submit]').click();
 await page.locator('[data-coord-id="coord-input"]').fill('Review our terminal rendering and report the findings.');await page.locator('[data-coord-id="coord-input"]').press('Enter');
 assert.equal(await page.locator('#terminal .coord-embedded').count(),1);
 await page.locator('#terminal .pane-title').click();
 await page.locator('.pane-name-input').fill('UI development');
 await page.evaluate(()=>refresh());
 assert.equal(await page.locator('.pane-name-input').inputValue(),'UI development');
 await page.locator('.pane-name-input').press('Enter');
 await page.waitForFunction(()=>document.querySelector('#terminal .pane-title')?.textContent.includes('UI development'));
 await page.locator('#terminal .pane-title').click();await page.locator('.pane-name-input').fill('Discard this');await page.locator('.pane-name-input').press('Escape');
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/rename').length,1);

 await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-usage-label"]')?.textContent.includes('1,300 reported tokens'));
 await page.locator('[data-coord-id="coord-usage-label"]').click();
 assert.match(await page.locator('[data-coord-id="coord-usage-detail"]').textContent(),/worker terminals excluded/);
 assert.match(await page.locator('[data-coord-id="coord-usage-detail"]').textContent(),/Older history was trimmed/);
 await page.locator('[data-coord-id="coord-usage-label"]').click();
 await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-quota-detail"]')?.textContent.includes('93% left'));
 await page.locator('[data-coord-id="coord-quota-label"]').click();
 assert.match(await page.locator('[data-coord-id="coord-quota-detail"]').textContent(),/5 hours · 93% left.*Weekly · 85% left/s);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-quota-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.locator('[data-coord-id="coord-quota"]').evaluate(n=>n.getBoundingClientRect().right<=390),true);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-quota-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-coord-id="coord-quota-label"]').click();
 await page.waitForFunction(()=>document.querySelectorAll('.coord-message.assistant').length===1);
 await page.locator('[data-coord-id="coord-context-open"]').click();
 const contextPanel=page.locator('.context-panel[open]');
 await contextPanel.locator('.context-note-editor > summary').click();
 await contextPanel.locator('.context-memory-form [name=name]').fill('Publishing');
 await contextPanel.locator('.context-memory-form [name=text]').fill('Do not merge without my review.');
 await contextPanel.locator('.context-memory-form button').click();
 await page.waitForFunction(()=>document.querySelector('.context-panel[open] .context-notes')?.textContent.includes('Pinned by you'));
 await contextPanel.getByRole('tab',{name:'History',exact:true}).click();
 await contextPanel.locator('.context-search input').fill('merge');await contextPanel.locator('.context-search button').click();
 await contextPanel.locator('.context-matches button').click();
 assert.equal(await contextPanel.locator('.context-source script').count(),0);assert.equal(await page.evaluate(()=>window.contextInjected),undefined);
 assert.equal(await contextPanel.locator('.context-source a').getAttribute('href'),'https://example.test/report');
 await contextPanel.getByRole('tab',{name:'Reader',exact:true}).click();
 await contextPanel.locator('.context-reader [name=profile]').selectOption('claude-personal');
 await contextPanel.locator('.context-reader [name=model]').fill('fixture-small');
 await contextPanel.locator('.context-reader button[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('.context-panel[open] .context-cache')?.textContent.includes('Enabled'));
 await contextPanel.locator('.context-reader-disable').click();
 await page.waitForFunction(()=>document.querySelector('.context-panel[open] .context-cache')?.textContent.includes('disabled'));
 await contextPanel.getByRole('tab',{name:'PR monitors',exact:true}).click();
 await contextPanel.locator('.context-watch input').fill('https://github.com/example/repo/pull/123');
 await contextPanel.locator('.context-watch button').click();await contextPanel.locator('.context-watches button').click();
 await page.waitForFunction(()=>document.querySelector('.context-panel[open] .context-watches')?.textContent.includes('stopped'));
 await contextPanel.getByRole('tab',{name:'Memory',exact:true}).click();
 await contextPanel.evaluate(node=>{node.scrollTop=0;});
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-context-panel.png')});
 await contextPanel.locator('.context-close').click();
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/message').length,1);assert.match(writes.find(w=>w.path==='/api/coordinators/message').body.request_id,/./);
 await page.locator('[data-coord-id="coord-input"]').fill('Keep this draft\nwith two lines');await page.reload();await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-input"]')?.value.includes('Keep this draft'));
 assert.equal(await page.locator('[data-coord-id="coord-input"]').inputValue(),'Keep this draft\nwith two lines');assert.equal(await page.locator('.coord-message.user').count(),1);
 messages.push({id:messages.length+1,kind:'worker',text:'Terminal review · completed\n\nThe renderer keeps its dimensions on refresh. <script>window.bad=true</script>'});
 await page.waitForFunction(()=>document.querySelectorAll('.coord-message.worker').length===1);
 assert.equal(await page.locator('.coord-reply-task').textContent(),'Task: Terminal review');
 assert.equal(await page.evaluate(()=>window.bad),undefined);assert.equal(await page.locator('[data-coord-id="coord-input"]').inputValue(),'Keep this draft\nwith two lines');
 const python='def greet(name):\n    # Keep indentation\n    return "Hello " + name\n';
 messages.push({id:messages.length+1,kind:'assistant',text:'Use `greet(name)` or ``a `literal` tick``.\n\n```python\n'+python+'```\nUnknown language:\n```madeup\n<script>window.bad=true</script>\n```\nAn unmatched `tick stays visible.'});
 await page.waitForFunction(()=>document.querySelectorAll('.coord-code-block').length===2);
 assert.equal(await page.locator('.coord-inline-code').first().textContent(),'greet(name)');
 assert.equal(await page.locator('.coord-inline-code').nth(1).textContent(),'a `literal` tick');
 assert.equal(await page.locator('.coord-code-language').first().textContent(),'python');
 assert.equal(await page.locator('.coord-code-block code').first().textContent(),python);
 assert.ok(await page.locator('.coord-code-block .hljs-keyword').count()>0);
 assert.ok(await page.locator('.coord-code-block .hljs-string').count()>0);
 assert.equal(await page.locator('.coord-code-block').nth(1).locator('script').count(),0);
 assert.equal(await page.locator('.coord-code-block code').nth(1).textContent(),'<script>window.bad=true</script>\n');
 assert.equal(await page.evaluate(()=>window.bad),undefined);
 assert.equal(await page.locator('[data-coord-id="coord-input"]').inputValue(),'Keep this draft\nwith two lines');
 messages.push({id:messages.length+1,kind:'assistant',text:'#458 → PR #459 (https://github.com/example/repo/pull/459).\n#457 → PR #460 (https://github.com/example/repo/pull/460).\nLiteral: `https://example.test/code`'});
 await page.waitForFunction(()=>document.querySelectorAll('.coord-message a').length===2);
 const links=page.locator('.coord-message a');
 assert.equal(await links.nth(0).getAttribute('href'),'https://github.com/example/repo/pull/459');
 assert.equal(await links.nth(1).getAttribute('href'),'https://github.com/example/repo/pull/460');
 assert.equal(await links.first().getAttribute('target'),'_blank');
 assert.equal(await links.first().getAttribute('rel'),'noopener noreferrer');
 assert.equal(await page.locator('.coord-inline-code a,.coord-code-block a').count(),0);
 await page.locator('[data-coord-id="coord-input"]').fill('/');assert.ok(await page.locator('[data-coord-id="coord-commands"] button').count()>1);
 await page.locator('[data-coord-id="coord-input"]').fill('');await page.locator('[data-coord-id="coord-input"]').press('Escape');await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]').textContent.includes('Paused'));
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-coordinator-desktop.png')});
 await page.setViewportSize({width:390,height:844});
 await page.locator('[data-coord-id="coord-context-open"]').click();
 await page.locator('.context-panel[open]').evaluate(node=>{node.scrollTop=0;});
 assert.ok(await page.locator('.context-panel[open]').evaluate(node=>node.scrollWidth<=node.clientWidth+1));
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-context-mobile.png')});
 await page.locator('.context-panel[open] .context-close').click();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-coordinator-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});
 await page.locator('[data-coord-id="coord-input"]').fill('First coordinator draft');
 coordinators.push({...coordinators[0],id:'coordinator-second',name:'Second coordinator'});
 await page.evaluate(()=>refresh());
 await page.locator('[data-add-pane="coordinator-second"]').click();
 assert.equal(await page.locator('#terminal .coord-embedded').count(),2);
 const first=page.locator('[data-pane-id="coordinator-test"]');
 const second=page.locator('[data-pane-id="coordinator-second"]');
 await second.locator('[data-coord-id="coord-input"]').fill('Second coordinator draft');
 assert.equal(await first.locator('[data-coord-id="coord-input"]').inputValue(),'First coordinator draft');
 // Selecting a pane should also let the user type, without touching the other draft.
 await first.locator('.pane-directory').click();
 await page.keyboard.type(' + pane click');
 assert.equal(await first.locator('[data-coord-id="coord-input"]').inputValue(),'First coordinator draft + pane click');
 assert.equal(await second.locator('[data-coord-id="coord-input"]').inputValue(),'Second coordinator draft');
 await first.locator('[data-coord-id="coord-input"]').fill('First coordinator draft');
 // Dragging across transcript text must preserve selection for copying.
 const line=first.locator('.coord-message.user .coord-text').first();
 await line.scrollIntoViewIfNeeded();
 const bounds=await line.boundingBox();
 await page.mouse.move(bounds.x+2,bounds.y+8);await page.mouse.down();
 await page.mouse.move(bounds.x+120,bounds.y+8,{steps:12});await page.mouse.up();
 assert.ok((await page.evaluate(()=>window.getSelection().toString())).length>0);
 assert.equal(await first.locator('[data-coord-id="coord-input"]').evaluate(n=>document.activeElement===n),false);
 await page.evaluate(()=>window.getSelection().removeAllRanges());
 await first.locator('.coord-code-block pre').first().click();
 assert.equal(await first.locator('[data-coord-id="coord-input"]').evaluate(n=>document.activeElement===n),false);
 assert.equal(await page.evaluate(()=>{const ids=[...document.querySelectorAll('[id]')].map(n=>n.id);return ids.length===new Set(ids).size;}),true);
 await first.locator('.pane-close').click();
 await page.locator('[data-add-pane="coordinator-test"]').click();
 assert.equal(await first.locator('[data-coord-id="coord-input"]').inputValue(),'First coordinator draft');
 assert.equal(await second.locator('[data-coord-id="coord-input"]').inputValue(),'Second coordinator draft');
 await page.reload();
 await page.waitForFunction(()=>document.querySelectorAll('#terminal .coord-embedded').length===2);
 assert.equal(await first.locator('[data-coord-id="coord-input"]').inputValue(),'First coordinator draft');
 assert.equal(await second.locator('[data-coord-id="coord-input"]').inputValue(),'Second coordinator draft');
 // Prior conversations open without creating a new coordinator or model message.
 const beforeMessages=writes.filter(w=>w.path==='/api/coordinators/message').length;
 const beforeCreates=writes.filter(w=>w.path==='/api/coordinators/create').length;
 await page.locator('#new-controller').click();
 await page.locator('.coord-history-dialog[open]').waitFor({state:'visible'});
 assert.equal(await page.locator('.coord-history-session').count(),2);
 await page.locator('.coord-history-session').first().click();
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/message').length,beforeMessages);
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/create').length,beforeCreates);
 assert.equal(await first.locator('[data-coord-id="coord-input"]').inputValue(),'First coordinator draft');
 // Exercise the same global event consumer used while coordinator panes are closed.
 await page.evaluate(() => {
  window.completionTones=0;
  window.AudioContext=class {
   state='running';currentTime=0;destination={};
   createOscillator(){return {frequency:{exponentialRampToValueAtTime(){}},connect(){},disconnect(){},start(){window.completionTones++;},stop(){}};}
   createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}
  };
 });
 await page.locator('#completion-sound').click();
 assert.equal(await page.locator('#completion-sound').getAttribute('aria-pressed'),'true');
 assert.equal(await page.evaluate(()=>window.completionTones),2); // preview
 await page.evaluate(() => {
  const pending={id:'completion-one',worker:'worker-test',created:1,task:'Verify renderer',result:null,outcome:null};
  updateWorkerCompletions([pending]);
  if(withWorkerCompletion({id:'worker-test',status:'quiet'}).status!=='quiet')throw Error('Interim task shown complete');
  const finished={...pending,result:'Verified',outcome:'completed'};
  updateWorkerCompletions([finished]);updateWorkerCompletions([finished]);
  if(withWorkerCompletion({id:'worker-test',status:'quiet'}).status!=='ready_for_review')throw Error('Missing review state');
  if(withWorkerCompletion({id:'worker-test',status:'needs_input'}).status!=='needs_input')throw Error('Approval hidden');
  updateWorkerCompletions([finished,{...pending,id:'completion-two',created:2}]);
  if(withWorkerCompletion({id:'worker-test',status:'quiet'}).status!=='quiet')throw Error('Follow-up retained completion badge');
 });
 assert.equal(await page.evaluate(()=>window.completionTones),4); // one two-tone completion
 await page.locator('#completion-sound').click();
 assert.equal(await page.locator('#completion-sound').getAttribute('aria-pressed'),'false');
 workerReviews=[{worker_id:'worker-test',task_id:'task-finished',session_id:null,result:'Final report: tests passed.'}];
 await first.locator('.coord-retire').waitFor({state:'visible'});
 assert.match(await first.locator('.ready-for-review').textContent(),/Terminal review✓ Ready for review/);
 assert.equal(await first.locator('.coord-retire').textContent(),'Review & close');
 await first.locator('.coord-retire').click();
 await page.locator('.coord-retire-dialog[open] .coord-retire-result .report-section summary').first().waitFor();
 assert.equal(await page.locator('.coord-retire-dialog[open] .coord-retire-result .report-sections li').count(),2);
 assert.equal(await page.locator('.coord-retire-dialog[open] input[name=session]').count(),0);
 assert.match(await page.locator('.coord-retire-dialog[open] .coord-session-discovery').textContent(),/saved automatically/);
 assert.equal(await page.locator('.coord-retire-dialog[open] .report-section summary').first().textContent(),'Outcome');
 await page.locator('.coord-retire-dialog[open] .report-view-switch button').filter({hasText:'Full report'}).click();
 assert.equal(await page.locator('.coord-retire-dialog[open] .report-original').isVisible(),true);
 await page.locator('.coord-retire-dialog[open] .report-view-switch button').filter({hasText:/^Review$/}).click();
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-review-dialog.png')});
 const reviewViewport=page.viewportSize();
 await page.setViewportSize({width:390,height:844});
 const reviewBounds=await page.locator('.coord-retire-dialog[open]').boundingBox();
 assert.ok(reviewBounds.x>=0&&reviewBounds.x+reviewBounds.width<=390);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-review-mobile.png')});
 await page.setViewportSize(reviewViewport);
 await page.locator('.coord-retire-dialog[open] .coord-retire-cancel').click();
 assert.equal(writes.filter(w=>w.path.endsWith('/retire-worker')).length,0);
 await first.locator('.coord-retire').click();await page.locator('.coord-retire-dialog[open] .coord-retire-form button[type=submit]').click();
 await first.locator('[data-coord-id="coord-saved"]').waitFor({state:'visible'});
 await page.screenshot({path:evidence('agentdesk-saved-compact.png')});
 await first.locator('[data-coord-id="coord-saved"] .coord-saved-open').click();
 await page.getByRole('dialog',{name:'Saved worker sessions'}).getByRole('link',{name:'Open report ↗'}).waitFor();
 assert.match(await page.getByRole('link',{name:'Open report ↗'}).getAttribute('href'),/kind=worker&item=report-worker-test/);
 await page.getByRole('dialog',{name:'Saved worker sessions'}).screenshot({path:evidence('saved-worker-report.png')});
 await page.screenshot({path:evidence('agentdesk-saved-dialog.png')});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence('agentdesk-saved-dialog-mobile.png')});
 assert.ok((await page.getByRole('dialog',{name:'Saved worker sessions'}).boundingBox()).width<=390);
 await page.setViewportSize(reviewViewport);
 await page.getByRole('dialog',{name:'Saved worker sessions'}).locator('[data-coord-id="coord-saved-list"] button').click();
 assert.equal(writes.filter(w=>w.path.endsWith('/retire-worker')).length,1);
 assert.equal(writes.filter(w=>w.path.endsWith('/resume-worker')).length,1);
 await page.locator('#new-controller').click();await page.locator('.coord-history-new').click();
 const create=page.locator('dialog[open]');
 await create.getByRole('combobox',{name:'Reasoning provider & account'}).click();await create.getByRole('option',{name:'Grok',exact:true}).click();
 await create.locator('[data-coord-id="coord-model"]').fill('test-model');
 await create.locator('button[type=submit]').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-coord-id="coord-context"]')].some(n=>n.textContent.includes('Grok / test-model')));
 const configured=writes.filter(w=>w.path==='/api/coordinators/create').at(-1).body;
 assert.equal(configured.profile,'grok');assert.equal(configured.model,'test-model');
 const active=page.locator('.terminal-pane').filter({has:page.locator('[data-coord-id="coord-context"]', {hasText:'Grok'})});
 await active.locator('[data-coord-id="coord-model-edit"]').click();
 const settings=page.locator('dialog[open]');await settings.locator('[data-coord-id="coord-model"]').fill('another-model');await settings.locator('[type="submit"]').click();
 await page.waitForFunction(()=>[...document.querySelectorAll('[data-coord-id="coord-model-edit"]')].some(n=>n.textContent.includes('another-model')));
 const configuredId=coordinators.at(-1).id;
 await active.locator('[data-coord-id="coord-close"]').click();await page.locator('.coord-close-confirm').click();
 await page.waitForFunction(id=>!document.querySelector('[data-agent-id="'+id+'"]'),configuredId);
 await page.locator('#new-controller').click();await page.locator('.coord-history-session').filter({hasText:'Grok'}).click();
 await page.waitForFunction(id=>!!document.querySelector('[data-agent-id="'+id+'"]'),configuredId);
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/configure').length,1);
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/close').length,1);
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/reopen').length,1);
 assert.deepEqual(errors,[]);console.log('PASS: coding-agent coordinator UI, create/send, multiline drafts across refresh, durable replies, safe rendering, slash commands, pause, mobile');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1)});
