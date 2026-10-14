const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[],submissions=[];let feedback={notes:[],deleted:[]};
 page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/feedback'){
   if(route.request().method()==='POST')feedback=route.request().postDataJSON();
   return route.fulfill({json:feedback});
  }
  if(path==='/api/coordinators/submit-feedback'){submissions.push(route.request().postDataJSON());return route.fulfill({json:{sent:true}});}
  if(path==='/api/coordinators/feedback-status')return route.fulfill({json:{submissions:submissions.map(s=>({request:s.request_id,target:s.target_id,state:'sent'}))}});
  if(route.request().method()==='POST'){writes.push(path);return route.fulfill({status:400,json:{error:'Fixture prevents mutations'}});}
  const data={'/api/agents':{agents:[{id:'coordinator-fixture',name:'UI fixes',coordinator_workspace:true,status:'idle',cwd:'/tmp/project',project:'Fixture',events:[]}]},'/api/coordinators':{coordinators:[{id:'coordinator-fixture',name:'UI fixes',cwd:'/tmp/project'}],messages:[],actions:[]},'/api/coordinator-events':{tasks:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');
 await page.waitForFunction(()=>document.getElementById('feedback-sync').textContent.startsWith('Saved to workspace'));
 assert.equal(await page.locator('#dev-menu').count(),0);
 await page.locator('#annotation-launcher').click();
 assert.equal(await page.locator('#annotation-toolbar').isVisible(),true);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#annotation-toolbar').isVisible(),false);
 await page.evaluate(()=>document.getElementById('delete-desk-dialog').showModal());
 await page.locator('#annotation-launcher').click();
 assert.equal(await page.locator('#annotation-layer').evaluate(n=>n.parentElement.id),'delete-desk-dialog');
 await page.locator('#mode-element').click();
 await page.locator('#delete-desk-dialog h2').hover();
 assert.equal(await page.locator('#highlight').isVisible(),true);
 await page.locator('#confirm-delete-desk').click();
 await page.locator('#annotation-note').fill('Make this action clearer');
 await page.locator('#annotation-note-save').click();
 await page.waitForFunction(()=>document.querySelectorAll('.feedback-pin').length===1);
 assert.equal(feedback.notes.length,1);assert.equal(feedback.notes[0].selector,'#confirm-delete-desk');
 assert.equal(feedback.notes[0].note,'Make this action clearer');assert.ok(feedback.notes[0].point.viewportX>0);
 assert.equal(await page.locator('#delete-desk-dialog').evaluate(n=>n.open),true);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-annotation-modal.png')});
 // Nested modals get their own accessible launcher; older pins stay behind them.
 await page.evaluate(()=>document.getElementById('stop-terminal-dialog').showModal());
 await page.waitForFunction(()=>document.getElementById('annotation-layer').parentElement.id==='stop-terminal-dialog');
 assert.equal(await page.locator('.feedback-pin').count(),0);
 await page.locator('#stop-terminal-dialog h2').click();
 await page.locator('#annotation-note').fill('Temporary draft');
 await page.keyboard.press('Escape');
 // Escape closes the note panel and leaves the app's own modal open.
 assert.equal(await page.locator('#annotation-note-panel').isHidden(),true);
 assert.equal(await page.locator('#stop-terminal-dialog').evaluate(n=>n.open),true);
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#annotation-launcher').getAttribute('aria-pressed'),'false');
 assert.equal(await page.locator('#stop-terminal-dialog').evaluate(n=>n.open),true);
 await page.keyboard.press('Escape');
 await page.waitForFunction(()=>document.getElementById('annotation-layer').parentElement.id==='delete-desk-dialog');
 await page.locator('.feedback-pin').click();
 assert.equal(await page.locator('#annotation-note').inputValue(),'Make this action clearer');
 await page.keyboard.press('Escape');
 await page.locator('#delete-desk-dialog .close-dialog').click();
 await page.waitForFunction(()=>document.getElementById('annotation-layer').parentElement===document.body);
 await page.setViewportSize({width:390,height:844});
 await page.evaluate(()=>document.getElementById('delete-desk-dialog').showModal());
 await page.locator('#annotation-launcher').click();
 const bounds=await page.locator('#annotation-launcher').boundingBox();assert.ok(bounds.x>=0&&bounds.x<30&&bounds.y+bounds.height<=844);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-annotation-mobile.png')});
 await page.locator('#annotation-send').click();
 await page.locator('#annotation-recipient-list input[type=radio]').waitFor({state:'attached'});
 assert.equal(await page.locator('#annotation-send-notes input:checked').count(),1);
 await page.locator('#annotation-send-form button[type=submit]').click();
 await page.locator('#annotation-send-dialog').waitFor({state:'hidden'});
 assert.match(await page.locator('#toast').textContent(),/Sent 1 annotation/);
 assert.equal(submissions.length,1);assert.equal(submissions[0].target_id,'coordinator-fixture');
 assert.equal(submissions[0].notes[0].selector,'#confirm-delete-desk');
 assert.equal(feedback.notes.length,1);
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-send-feedback.png')});
 await page.locator('#annotation-launcher').click();await page.locator('#annotation-send').click();
 await page.locator('#annotation-send-dialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#annotation-send-notes input:checked').count(),0);
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log('PASS: permanent launcher, modal and nested-modal annotations, safe action interception, scoped pins, editor and Escape behavior, mobile; mocked feedback only');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
