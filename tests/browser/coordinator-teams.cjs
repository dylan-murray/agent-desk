const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const seed=(id,name,parent_id=null)=>({id,name,parent_id,harness:'claude',status:'idle',source:'terminal',terminal_id:id,exit_code:0,cwd:'/tmp/demo',project:'demo',task:'Interactive terminal',events:[],updated:100});
 const agents=[seed('root','Controller · One'),seed('other-root','Controller · Two'),seed('unrelated','Unrelated'),seed('child','Worker','root'),seed('grandchild','Nested worker','child'),seed('other-child','Other worker','other-root')];
 await page.addInitScript(()=>localStorage.setItem('agent-desk-order-live',JSON.stringify(['root','other-root','unrelated','other-child','grandchild','child'])));
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/terminals/output'){const id=new URL(route.request().url()).searchParams.get('id');return route.fulfill({json:{data:'',cursor:0,truncated:false,exit_code:agents.find(a=>a.id===id)?.exit_code}});}
  if(path==='/api/terminals/rename'){const body=route.request().postDataJSON();writes.push(body);const agent=agents.find(a=>a.id===body.id);agent.display_name=body.name;return route.fulfill({json:agent});}
  const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/coordinator-events':{tasks:[],event_delivery:true},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/terminals/output':{data:'',cursor:0,truncated:false,exit_code:0},'/api/terminals/resize':{ok:true},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('[data-agent-id="root"]').click();
 const rows=()=>page.locator('.session-row').evaluateAll(nodes=>nodes.map(n=>n.dataset.agentId));
 assert.deepEqual(await rows(),['root','other-root','grandchild','child','unrelated','other-child']);
 assert.equal(await page.locator('.coordinator-team').count(),3);
 const saved=await page.evaluate(()=>localStorage.getItem('agent-desk-order-live'));
 await page.locator('[data-add-pane="other-child"]').click();
 await page.locator('[data-agent-id="root"]').click();
 assert.equal(await page.locator('.session-row.selected').count(),1);
 assert.equal(await page.locator('[data-agent-id="other-child"]').getAttribute('aria-pressed'),'false');
 assert.equal(await page.locator('[data-agent-id="other-child"]').evaluate(n=>n.closest('.session-entry').classList.contains('coordinator-team')),false);
 await page.locator('#agent-map-toggle').click();
 assert.equal(await page.locator('#agent-map .dag-node').count(),6);
 await page.locator('#agent-map-toggle').click();

 await page.locator('[data-agent-id="child"]').click();assert.equal(await page.locator('.coordinator-team').count(),3);
 // Renaming is the pane title itself; the header carries no Rename button.
 assert.equal(await page.locator('[data-pane-id="child"] .pane-rename').count(),0);
 await page.locator('[data-pane-id="child"] .pane-title').click();await page.locator('[data-pane-id="child"] .pane-name-input').fill('Renamed review');await page.keyboard.press('Enter');
 await page.waitForFunction(()=>document.querySelector('[data-agent-id="child"] .session-name').textContent==='Renamed review');
 await page.reload();await page.locator('[data-agent-id="child"] .session-name').waitFor();assert.equal(await page.locator('[data-agent-id="child"] .session-name').innerText(),'Renamed review');
 await page.locator('[data-agent-id="unrelated"]').click();assert.equal(await page.locator('.coordinator-team').count(),0);assert.deepEqual(await rows(),['root','other-root','unrelated','other-child','grandchild','child']);
 await page.locator('#agent-map-toggle').click();assert.equal(await page.locator('#agent-map .dag-node').count(),6);
 await page.locator('#agent-map [data-node-id="root"]').click();assert.equal(await page.locator('#agent-map .dag-node').count(),3);assert.equal(await page.locator('#agent-map [data-node-id="child"] strong').innerText(),'Renamed review');
 await page.locator('#agent-map-all').click();assert.equal(await page.locator('#agent-map .dag-node').count(),6);
 await page.locator('#agent-map [data-node-id="other-root"]').click();assert.equal(await page.locator('#agent-map .dag-node').count(),2);
 await page.locator('#agent-map-open-coordinator').click();await page.locator('#terminal').waitFor({state:'visible'});
 assert.equal(await page.evaluate(()=>localStorage.getItem('agent-desk-order-live')),saved);
 assert.deepEqual(writes,[{id:'child',name:'Renamed review'}]);assert.deepEqual(errors,[]);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 agents[0].exit_code=null;
 agents.push({...seed('internal','Explore','root'),source:'harness',terminal_id:undefined,exit_code:undefined,harness_internal:true,task:'Found two issues in the review.',launch_label:'Claude internal · read-only'});
 await page.evaluate(()=>refresh());await page.locator('[data-agent-id="internal"]').click();
 assert.equal(await page.locator('[data-agent-id="internal"] .session-name').innerText(),'Explore');assert.match(await page.locator('[data-agent-id="internal"] .session-folder').innerText(),/Controller · One/);const nestedRows=await rows();assert.equal(nestedRows.indexOf('internal'),nestedRows.indexOf('root')+1);
 const internal=page.locator('[data-pane-id="internal"]');assert.match(await internal.innerText(),/READ-ONLY/);assert.match(await internal.innerText(),/Found two issues/);
 assert.equal(await internal.locator('.pane-stop').isVisible(),false);assert.equal(await internal.locator('.pane-title').evaluate(n=>n.hasAttribute('role')),false);
 await internal.locator('.internal-agent-parent').click();assert.equal(await page.locator('[data-pane-id="root"]').count(),1);
 agents.find(a=>a.id==='internal').status='completed';await page.evaluate(()=>refresh());assert.equal(await page.locator('[data-agent-id="internal"]').count(),0);await page.locator('#status-menu summary').click();await page.locator('#show-finished-subagents').click();assert.equal(await page.locator('#show-finished-subagents').getAttribute('aria-checked'),'true');assert.equal(await page.locator('#filter-badge').textContent(),'1');assert.equal(await page.locator('[data-agent-id="internal"]').count(),1);await page.keyboard.press('Escape');
 assert.deepEqual(errors,[]);
 console.log('PASS: coordinator descendant priority/highlighting, unrelated reset, saved-order preservation, rename/reload/map names, map drilldown/show-all/open; mocked APIs only');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
