const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],writes=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 const coordinator={id:'coordinator-test',name:'Signup rework',cwd:'/tmp/project',profile:'claude-personal',model:'',state:'idle',paused:0};
 const attachable=[{worker_id:'one',name:'API validation',profile:'codex-personal',cwd:'/Users/sam/code/storefront'},{worker_id:'two',name:'Docs refresh',profile:'claude-personal',cwd:'/Users/sam/code/docs-site'},{worker_id:'three',name:'Flaky checkout test investigation',profile:'grok',cwd:'/Users/sam/code/storefront/packages/checkout'}];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();
   if(path==='/api/coordinators/attach-worker'){writes.push(body);attachable.splice(attachable.findIndex(w=>w.worker_id===body.worker_id),1);return route.fulfill({json:{worker_id:body.worker_id}});}
   return route.fulfill({status:400,json:{error:'Fixture prevents mutations'}});
  }
  const data={'/api/coordinators':{coordinators:[coordinator],messages:[],actions:[],attachable_workers:attachable,saved_workers:[],worker_reviews:[]},'/api/agents':{agents:[{...coordinator,coordinator_workspace:true,controller:true,source:'coordinator',project:'project',harness:'claude',status:'idle',task:'Coordinate work',events:[]}]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp/project'},'/api/feedback':{notes:[],deleted:[]},'/api/coordinator-events':{tasks:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('.session-entry',{hasText:'Signup rework'}).first().click();
 const trigger=page.locator('#terminal .coord-attach-trigger'),menu=page.locator('#terminal .coord-attach-list'),items=menu.getByRole('menuitem');
 await trigger.waitFor();assert.equal(await page.locator('#terminal [data-coord-id="coord-workers"] select').count(),0);
 assert.equal(await trigger.textContent(),'Add existing agent');assert.equal(await menu.isVisible(),false);
 await trigger.click();assert.equal(await trigger.getAttribute('aria-expanded'),'true');assert.equal(await items.count(),3);
 assert.deepEqual(await items.nth(0).locator('strong,small').allTextContents(),['API validation','Codex · Personal · ~/code/storefront']);
 // The worker bar is redrawn every 1.2 seconds; the open menu and its focus must survive that.
 assert.equal(await items.nth(0).evaluate(n=>n===document.activeElement),true);await page.keyboard.press('ArrowDown');
 await page.waitForTimeout(2600);assert.equal(await menu.isVisible(),true);assert.equal(await items.nth(1).evaluate(n=>n===document.activeElement),true);
 const fits=await menu.evaluate(n=>{const b=n.getBoundingClientRect();return b.top>=0&&b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight;});assert.equal(fits,true);
 await page.screenshot({path:evidence('agent-desk-coordinator-attach-menu.png')});
 await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false);assert.equal(await trigger.evaluate(n=>n===document.activeElement),true);assert.equal(await page.locator('#terminal .coord-embedded').count(),1);
 await trigger.click();await page.locator('#terminal [data-coord-id="coord-input"]').click();assert.equal(await menu.isVisible(),false);
 // The composer's underline is its focus cue; the app-wide field ring must not box the bare textarea.
 assert.deepEqual(await page.locator('#terminal [data-coord-id="coord-input"]').evaluate(n=>{const s=getComputedStyle(n);return [s.boxShadow,s.outlineStyle,s.borderTopStyle];}),['none','none','none']);
 await trigger.click();await items.nth(1).click();await page.locator('#toast',{hasText:'Agent attached'}).waitFor();
 assert.deepEqual(writes,[{id:'coordinator-test',worker_id:'two'}]);assert.equal(await menu.isVisible(),false);assert.equal(await menu.locator('[role=menuitem]').count(),2);
 await page.setViewportSize({width:390,height:844});await trigger.click();
 assert.equal(await menu.evaluate(n=>{const b=n.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth;}),true);
 await page.screenshot({path:evidence('agent-desk-coordinator-attach-menu-390.png')});await page.keyboard.press('Escape');
 attachable.length=0;await trigger.waitFor({state:'hidden'});assert.equal(await page.locator('#terminal [data-coord-id="coord-workers"]').isVisible(),false);
 assert.deepEqual(errors,[]);console.log('coordinator attach menu passed');
}finally{await browser.close();}})();
