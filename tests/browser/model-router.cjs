// Model router settings and both routing toggles, with mocked endpoints (no router or agent CLI needed).
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');const path=require('node:path'),os=require('node:os');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await withAccounts(page);const errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 let settings={configured:false,endpoint:'',has_api_key:false,preference:'auto',preferences:['auto','auto-fast','auto-cheap'],models:[{model:'gpt-6-luna',account:'',harness:'codex'},{model:'claude-opus-5-5',account:'',harness:'claude'}]};
 const coordinators=[];const harness=m=>/^(claude|opus)/.test(m)?'claude':/^(gpt|o\d|codex)/.test(m)?'codex':null;
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),p=url.pathname;
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();writes.push({path:p,body});
   if(p==='/api/model-router/settings')return route.fulfill({json:settings});
   if(p==='/api/model-router/save'){
    const bad=body.models.find(m=>!harness(m.model));if(bad)return route.fulfill({status:400,json:{error:'No harness runs '+bad.model}});
    settings={...settings,configured:true,endpoint:body.endpoint,has_api_key:settings.has_api_key||!!body.api_key,preference:body.preference,models:body.models.map(m=>({...m,harness:harness(m.model)}))};
    return route.fulfill({json:settings});
   }
   if(p==='/api/model-router/decide')return route.fulfill({json:{model:'gpt-6-luna',harness:'codex',account:'codex',decision_id:'dec_fixture',bucket:'routine-coding',reason:'our top pick for routine-coding (auto)',fallback:false,policy_version:3,ranked:['gpt-6-luna','claude-opus-5-5']}});
   if(p==='/api/coordinators/models')return route.fulfill({json:{models:[],source:'Fixture'}});
   if(p==='/api/coordinators/create'){const c={id:'coordinator-routed',name:body.name,cwd:body.cwd,profile:body.profile,model:body.model,router:body.router?1:0,state:'idle',paused:0};coordinators.push(c);return route.fulfill({json:c});}
   if(p==='/api/coordinators/configure'){Object.assign(coordinators[0],{model:body.model,router:body.router?1:0});return route.fulfill({json:coordinators[0]});}
   if(p==='/api/coordinators/quota')return route.fulfill({json:{state:'unsupported',windows:[]}});
   if(p==='/api/remote/nodes')return route.fulfill({json:{nodes:[]}});
   if(p==='/api/terminals/launch')return route.fulfill({status:400,json:{error:'Fixture stops here'}});
   return route.fulfill({status:400,json:{error:'Fixture prevents mutations'}});
  }
  const data={'/api/coordinators':{coordinators,messages:[],actions:[],context_features:true,quota_features:true,review_features:true,router_features:true,saved_workers:[],worker_reviews:[],usage:{turns:0,reported_turns:0,totals:{}},activity:{phase:'idle',label:'Ready for your task'}},
   '/api/agents':{agents:coordinators.map(c=>({...c,coordinator_workspace:true,controller:true,source:'coordinator',project:'project',harness:'claude',status:'idle',task:'Coordinate work',events:[]}))},
   '/api/terminal-auth':{token:'fixture',cwd:'/tmp/project'},'/api/feedback':{notes:[],deleted:[]},'/api/coordinator-events':{tasks:[],event_delivery:true,native_grok_terminal:true},
   '/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/projects':{projects:[],roots:[],limited:false}};
  return route.fulfill({json:data[p]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/');
 await page.locator('#new-controller').click();
 const create=page.locator('dialog[open][data-coord-id="coord-create-dialog"]');await create.waitFor();
 const toggle=create.getByRole('checkbox',{name:'Pick worker models with the model router'});
 await create.locator('[data-coord-id="coord-router-status"]',{hasText:'Not set up yet'}).waitFor();
 assert.equal(await toggle.isDisabled(),true);
 await create.getByRole('button',{name:'Set up router'}).click();
 const dialog=page.locator('#model-router-dialog');await dialog.waitFor({state:'visible'});
 await dialog.getByLabel('Router URL').fill('http://127.0.0.1:8000');await dialog.getByLabel('API key').fill('router-fixture-key');
 await dialog.getByLabel(/Models the router can choose/).fill('gpt-6-luna\nclaude-opus-5-5\ngemini-3.1-pro');
 assert.deepEqual(await dialog.locator('.router-harnesses li').evaluateAll(n=>n.map(x=>x.dataset.harness)),['codex','claude','none']);
 await dialog.getByRole('button',{name:'Save and test'}).click();
 await dialog.locator('#model-router-error',{hasText:'No harness runs gemini-3.1-pro'}).waitFor();
 await dialog.getByLabel(/Models the router can choose/).fill('gpt-6-luna\nclaude-opus-5-5');
 await dialog.getByLabel('Account for gpt-6-luna').selectOption('codex');
 await dialog.getByRole('radio',{name:'Fast'}).check({force:true});
 await dialog.getByRole('button',{name:'Save and test'}).click();
 await dialog.locator('.router-result strong',{hasText:'gpt-6-luna → Codex'}).waitFor();
 const saved=writes.filter(w=>w.path==='/api/model-router/save').at(-1).body;
 assert.deepEqual(saved,{endpoint:'http://127.0.0.1:8000',preference:'auto-fast',models:[{model:'gpt-6-luna',account:'codex'},{model:'claude-opus-5-5',account:''}],api_key:'router-fixture-key'});
 assert.equal(await dialog.getByLabel('API key').inputValue(),'');
 await page.setViewportSize({width:390,height:844});
 assert.equal(await dialog.evaluate(n=>n.scrollWidth<=n.clientWidth),true);
 await dialog.screenshot({path:path.join(os.tmpdir(),'agent-desk-model-router-mobile.png')});
 await page.setViewportSize({width:1440,height:1000});
 await dialog.getByRole('button',{name:'Save',exact:true}).click();await dialog.waitFor({state:'hidden'});
 await create.locator('[data-coord-id="coord-router-status"][data-state="ready"]').waitFor();
 assert.equal(await create.locator('[data-coord-id="coord-router-status"]').textContent(),'127.0.0.1:8000 · gpt-6-luna → Codex, claude-opus-5-5 → Claude Code');
 await toggle.check();
 assert.match(await create.locator('[data-coord-id="coord-worker-model-help"]').textContent(),/router picks each new worker/);
 await create.screenshot({path:path.join(os.tmpdir(),'agent-desk-model-router-create.png')});
 await create.locator('button[type=submit]').click();await create.waitFor({state:'hidden'});
 assert.equal(writes.find(w=>w.path==='/api/coordinators/create').body.router,true);
 // The footer names routing; the model dialog edits it.
 const modelButton=page.locator('[data-coord-id="coord-model-edit"]',{hasText:'workers routed'}).first();await modelButton.waitFor();
 await modelButton.click();
 const edit=page.locator('dialog[open][data-coord-id="coord-create-dialog"]');await edit.waitFor();
 const editToggle=edit.getByRole('checkbox',{name:'Pick worker models with the model router'});
 await edit.locator('[data-coord-id="coord-router-status"][data-state="ready"]').waitFor();
 assert.equal(await editToggle.isChecked(),true);await editToggle.uncheck();
 await edit.locator('button[type=submit]').click();
 await edit.waitFor({state:'hidden'});
 assert.equal(writes.filter(w=>w.path==='/api/coordinators/configure').at(-1).body.router,false);
 // Terminal controller: a routed objective tells the controller to launch with --route-task.
 await page.locator('#new-terminal').click();await page.getByRole('menuitem',{name:/Terminal/}).first().click();
 await page.locator('#launch-terminal-dialog').waitFor({state:'visible'});
 await page.locator('#terminal-controller').check();
 await page.locator('#controller-router-status[data-state="ready"]').waitFor();
 await page.locator('#controller-router').check();
 await page.locator('#launch-terminal-form button[type=submit]').click();
 await page.locator('#terminal-launch-error',{hasText:'Fixture stops here'}).waitFor();
 const prompt=writes.find(w=>w.path==='/api/terminals/launch').body.argv.join(' ');
 assert.match(prompt,/Model routing is on for this session/);assert.match(prompt,/--route-file/);
 assert.deepEqual(errors,[]);console.log('Model router browser check passed');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
