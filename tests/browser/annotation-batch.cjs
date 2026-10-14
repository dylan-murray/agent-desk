// Focused fictional fixtures for a batch of annotation-driven UI changes.
const {chromium}=require('playwright'),assert=require('node:assert/strict'),path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL; if(!APP||new URL(APP).port==='4310')throw Error('Use an isolated fixture URL');
(async()=>{const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1920,height:958}}),errors=[],calls=[];
 page.on('pageerror',e=>errors.push(e.stack));let skills=[],saved=[],pending=[],created=false;
 const every={codex:true,claude:true};
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname,b=route.request().method()==='POST'?route.request().postDataJSON():{};calls.push([p,b]);
  let result={};
  if(p==='/api/projects')result={projects:[],roots:['/tmp']};
  if(p==='/api/special-agents')result={roles:[],runs:[],inbox:[]};
  if(p==='/api/workflows')result={configs:[],workflows:[],flows:[],executions:[]};
  if(p==='/api/coordinator-events')result={tasks:[]};
  if(p==='/api/skills')result={skills,harnesses:[{id:'codex',label:'Codex'},{id:'claude',label:'Claude'}]};
  if(p==='/api/skills/preview')result={content:'---\nname: '+b.name+'\ndescription: Review API changes\n---\n\n'+b.steps};
  if(p==='/api/skills/create'){created=true;skills=[{name:b.name,path:'/home/fixture/.agents/skills/'+b.name+'/SKILL.md',description:b.purpose,content:b.steps,availability:every}];result={created:skills[0].path,conflicts:[]};}
  if(p==='/api/terminal-auth')result={token:'fixture',cwd:'/tmp'};
  if(p==='/api/agents')result={agents:[{id:'terminal-fixture',terminal_id:'terminal-fixture',harness:'codex',launch_profile:'codex',name:'API review',display_name:'API review',cwd:'/tmp',project:'Example',exit_code:null,status:'idle',source:'managed',events:[],task:'API review'}]};
  if(p==='/api/feedback')result={notes:[{id:'pin-fixture',note:'Space the buttons apart',page:'Skills',mode:'live',selector:'#skills-sync',point:{viewportX:440,viewportY:205},viewport:{width:1920,height:958},createdAt:'2026-09-25T14:24:00Z',updatedAt:'2026-09-25T14:24:00Z'}],deleted:[]};
  if(p==='/api/remote/prerequisites')result={tools:{ssh:true}};
  if(p==='/api/remote/connections')result={connections:saved};
  if(p==='/api/remote/connections/save'){saved=[{...b,id:'saved-fixture'}];result={connections:saved};}
  if(p==='/api/remote/test')result={ticket:'tested',expires_in:300,message:'SSH test passed'};
  if(p==='/api/conversations/list')result={conversations:[{id:'source-fixture',name:'Native session',title:'Fix the API',profile:'claude',cwd:'/tmp',updated:1790340000}]};
  if(p==='/api/conversations/import')result={id:'a'.repeat(64),cwd:'/tmp',source:{profile:'claude'},message_count:12,warnings:[]};
  if(p==='/api/conversations/prepare')result={prompt:'Continue portable conversation fixture. Read /private/fixture.json',cwd:'/tmp'};
  if(p==='/api/terminals/launch')result={id:'terminal-new',cwd:'/tmp',name:b.name,terminal_id:'terminal-new',harness:'grok',exit_code:null};
  if(p==='/api/coordinators/submit-feedback'){pending=[{request:b.request_id,target:b.target_id,state:'queued',detail:'Waiting for an empty prompt'}];result={queued:true};}
  if(p==='/api/coordinators/feedback-status')result={submissions:pending};
  if(p==='/api/coordinators/cancel-feedback'){pending[0].state='cancelled';result={cancelled:true};}
  if(p==='/api/skills/discover')result={skills:[],root:'/tmp'};
  return route.fulfill({json:result});
 });
 await page.goto(APP,{waitUntil:'domcontentloaded'});await page.locator('#open-skills').click();
 const gap=await page.evaluate(()=>{const a=document.querySelector('#skills-build').getBoundingClientRect(),b=document.querySelector('#skills-find-local').getBoundingClientRect();return b.left-a.right;});assert.ok(gap>=12);
 await page.locator('#skills-build').click();
 for(const [field,value] of Object.entries({name:'review-api',purpose:'Review API changes',trigger:'reviewing an API pull request',steps:'Check compatibility and document breaking changes.',examples:'Review a removed response field.'}))await page.locator('#skill-build-'+field).fill(value);
 await page.locator('#skill-builder-form button[type=submit]').click();await page.locator('#skill-build-install').waitFor({state:'visible'});
 assert.match(await page.locator('#skill-build-preview').textContent(),/Check compatibility/);
 const evidence=process.env.AGENT_DESK_FEEDBACK_EVIDENCE_DIR;
 const shot=async name=>{if(evidence)await page.screenshot({path:path.join(evidence,'2026-09-25-'+name+'.png')});};
 await shot('skill-builder-desktop');
 await page.setViewportSize({width:390,height:844});await shot('skill-builder-narrow');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.locator('#annotation-launcher').click();await page.waitForFunction(()=>document.querySelector('#annotation-layer').parentElement.id==='skill-builder');await page.keyboard.press('Escape');
 await page.locator('#skill-build-install').click();await page.locator('#skill-builder').waitFor({state:'hidden'});assert.equal(created,true);
 await page.setViewportSize({width:1920,height:958});await page.locator('#skills-back').click();await page.locator('#new-terminal').click();await page.locator('[data-new-pane="terminal"]').click();await page.locator('#open-ssh').click();
 await page.waitForFunction(()=>document.querySelector('#ssh-status').textContent.includes('SSH ready'));
 assert.equal(await page.locator('#ssh-host').isVisible(),true);
 await page.locator('#ssh-host').fill('dev-alias');await page.locator('#ssh-user').fill('developer');await page.locator('#ssh-port').fill('2202');await page.locator('#ssh-label').fill('Development host');await page.locator('#ssh-save').click();
 await page.waitForFunction(()=>document.querySelector('#ssh-status').textContent.startsWith('Saved.'));
 await page.locator('#ssh-test').click();await page.waitForFunction(()=>!document.querySelector('#ssh-connect').disabled);
 assert.deepEqual(calls.find(([p])=>p==='/api/remote/test')[1],{transport:'ssh',host:'dev-alias',user:'developer',port:2202,identity_file:''});
 await page.locator('#ssh-host').fill('other-host');assert.equal(await page.locator('#ssh-connect').isDisabled(),true);
 await page.locator('#ssh-saved').selectOption('saved-fixture');assert.equal(await page.locator('#ssh-host').inputValue(),'dev-alias');
 await shot('ssh-desktop');await page.setViewportSize({width:390,height:844});await page.locator('#ssh-dialog').evaluate(d=>d.scrollTop=0);await shot('ssh-narrow');
 assert.ok(await page.locator('#ssh-dialog').evaluate(d=>d.getBoundingClientRect().right<=innerWidth));
 await page.locator('#annotation-launcher').click();await page.waitForFunction(()=>document.querySelector('#annotation-layer').parentElement.id==='ssh-dialog');await page.keyboard.press('Escape');
 await page.locator('#ssh-close').click();await page.setViewportSize({width:1920,height:958});await page.locator('#new-terminal').click();await page.locator('[data-new-pane="terminal"]').click();
 await page.locator('#terminal-harness').selectOption('grok');await page.locator('#terminal-session-mode').selectOption('portable');
 await page.locator('#portable-source option[value=source-fixture]').waitFor({state:'attached'});await page.locator('#portable-source').selectOption('source-fixture');
 await page.waitForFunction(()=>document.querySelector('#portable-details').textContent.includes('12 messages'));
 await shot('portable-conversation');
 await page.locator('#launch-terminal-form button[type=submit]').click();await page.locator('#launch-terminal-dialog').waitFor({state:'hidden'});
 const launched=calls.find(([p])=>p==='/api/terminals/launch')[1];assert.equal(launched.argv[0],'grok');assert.match(launched.argv.at(-1),/Read \/private\/fixture.json/);
 await page.locator('#annotation-launcher').click();await page.locator('#annotation-send').click();await page.locator('.annotation-agent input').first().check();await page.locator('#annotation-send-form button[type=submit]').click();await page.locator('#annotation-send-dialog').waitFor({state:'hidden'});
 await page.locator('#annotation-launcher').click();await page.locator('#annotation-send').click();await page.getByText('Waiting for agent',{exact:false}).first().waitFor();
 assert.match(await page.locator('#annotation-send-notes').innerText(),/Waiting for agent/);assert.doesNotMatch(await page.locator('#annotation-send-notes').innerText(),/Delivered previously/);
 await shot('feedback-queued');await page.getByRole('button',{name:'Cancel delivery'}).click();await page.waitForFunction(()=>!document.querySelector('.annotation-delivery'));
 assert.deepEqual(errors,[]);console.log('PASS: skill builder preview/install, SSH templates and invalidation, desktop/narrow modal annotations, cross-harness launch, visible queue and cancellation (mocked APIs)');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
