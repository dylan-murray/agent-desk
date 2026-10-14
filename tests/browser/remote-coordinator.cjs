const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const path=require('node:path'),os=require('node:os');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const node={id:'fixture-node',name:'dev-server',home:'/home/developer',profiles:['claude','codex'],connected:true,node:true};
 let attached=false,coordinator=null;
 await page.route('**/api/**',async route=>{
  const endpoint=new URL(route.request().url()).pathname,body=route.request().method()==='POST'?route.request().postDataJSON():null;
  if(body)writes.push({endpoint,body});
  if(endpoint==='/api/remote/nodes')return route.fulfill({json:{nodes:attached?[node]:[]}});
  if(endpoint==='/api/remote/prerequisites')return route.fulfill({json:{tools:{ssh:true}}});
  if(endpoint==='/api/remote/test-environment')return route.fulfill({json:{ticket:'runtime-tested',expires_in:300,message:'Remote prerequisites passed. Found claude, codex.'}});
  if(endpoint==='/api/remote/attach'){assert.equal(body.ticket,'runtime-tested');assert.equal(body.transport,'ssh');assert.equal(body.host,'dev-server');attached=true;return route.fulfill({json:node});}
  if(endpoint==='/api/coordinators/models')return route.fulfill({json:{models:body.remote_node?['remote-model']:['local-model'],source:body.remote_node?'Remote model catalog':'Local catalog'}});
  if(endpoint==='/api/coordinators/create'){assert.equal(body.remote_node,node.id);assert.equal(body.cwd,'/home/developer/project');assert.equal(body.profile,'codex');coordinator={...body,id:'remote:fixture-node:coordinator-test',remote_name:node.name,remote_connected:true,state:'idle',paused:0,coordinator_workspace:true,controller:true,source:'coordinator',harness:'codex',project:'project',status:'idle',events:[]};return route.fulfill({json:coordinator});}
  if(endpoint==='/api/coordinators/configure'){coordinator.model=body.model;return route.fulfill({json:coordinator});}
  if(endpoint==='/api/coordinators/message')return route.fulfill({json:{ok:true}});
  const data={'/api/terminal-auth':{token:'fixture',cwd:'/local/project'},'/api/coordinators':{coordinators:coordinator?[coordinator]:[],messages:[],actions:[]},'/api/agents':{agents:coordinator?[coordinator]:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/coordinator-events':{tasks:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/projects':{projects:[]}};
  return route.fulfill({json:data[endpoint]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310');await page.locator('#new-controller').click();await page.locator('[data-coord-id="coord-connect-remote"]').click();
 await page.locator('#ssh-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#ssh-mode').inputValue(),'environment');assert.ok(await page.locator('#ssh-connect').isDisabled());
 await page.waitForFunction(()=>document.querySelector('#ssh-status').textContent.includes('SSH ready'));
 await page.locator('#ssh-host').fill('dev-server');
 await page.locator('#ssh-test').click();await page.waitForFunction(()=>!document.getElementById('ssh-connect').disabled);await page.locator('#ssh-connect').click();
 const form=page.locator('dialog[open][data-coord-id="coord-create-dialog"]');await form.waitFor();assert.equal(await form.locator('[data-coord-id="coord-cwd"]').inputValue(),node.home);
 assert.deepEqual(await form.locator('[data-coord-id="coord-profile"] option').evaluateAll(rows=>rows.map(r=>r.value)),['claude','codex']);
 await form.getByRole('combobox',{name:'Reasoning provider & account'}).click();await form.getByRole('option',{name:'Codex · Remote environment',exact:true}).click();
 await form.locator('[data-coord-id="coord-cwd"]').fill('/home/developer/project');await form.locator('[data-coord-id="coord-model"]').click();await form.getByRole('option',{name:'remote-model',exact:true}).click();
 assert.match(await form.locator('[data-coord-id="coord-provider-help"]').textContent(),/credentials configured on the remote machine/);
 await form.screenshot({path:path.join(os.tmpdir(),'agent-desk-remote-coordinator-form.png')});
 // Annotation launcher remains available inside the remote coordinator modal.
 await page.locator('#annotation-launcher').click();assert.equal(await page.locator('#annotation-toolbar').isVisible(),true);await page.keyboard.press('Escape');
 await page.setViewportSize({width:390,height:844});assert.ok((await form.boundingBox()).width<=390);await form.screenshot({path:path.join(os.tmpdir(),'agent-desk-remote-coordinator-mobile.png')});await page.setViewportSize({width:1440,height:1000});
 await form.locator('[type=submit]').click();await page.locator('#terminal .coord-embedded').waitFor();assert.match(await page.locator('[data-coord-id="coord-context"]').textContent(),/Remote · dev-server/);
 await page.locator('[data-coord-id="coord-model-edit"]').click();await form.waitFor();assert.equal(await form.locator('[data-coord-id="coord-environment"]').inputValue(),node.id);assert.ok(await form.locator('[data-coord-id="coord-environment"]').isDisabled());
 await form.locator('[data-coord-id="coord-model"]').fill('remote-custom-model');await form.locator('[type=submit]').click();
 assert.equal(writes.filter(w=>w.endpoint==='/api/coordinators/configure').at(-1).body.id,coordinator.id);
 assert.equal(writes.filter(w=>w.endpoint==='/api/remote/connect').length,0);assert.deepEqual(errors,[]);
 console.log('PASS: tested SSH coordinator setup, remote model catalog/auth labels, remote paths, modal annotations, mobile, model editing; mocked SSH');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
