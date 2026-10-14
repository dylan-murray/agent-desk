// Clear history is offered on every filter, not only History.
// Clearing hides History items from the Inbox; nothing is deleted, and History can show them again.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const shots=process.env.AGENT_DESK_SHOTS;
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  const now=Date.now()/1000;
  const report=(id,state,title)=>({id,role_id:'r1',event_key:'manual:'+id,title,detail:'Report body for '+title,state,created:now-Number(id.slice(1))*60,findings:[]});
  const inbox=[report('i1','review','Open finding'),report('i2','dismissed','Old triage'),report('i3','done','Reviewed migration'),report('i4','dismissed','Older triage')];
  let cleared=[];
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   if(path==='/api/inbox/clear-history'){const keys=route.request().postDataJSON().keys;writes.push(...keys);cleared=[...new Set([...cleared,...keys])];return route.fulfill({json:{keys:cleared}});}
   if(['/api/special-agents/review','/api/workflows/review','/api/coordinator-events/ack'].includes(path)){writes.push(path);}
   const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/inbox/cleared':{keys:cleared},
    '/api/special-agents':{roles:[{id:'r1',name:'Slack triage'}],runs:[],inbox},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.locator('#open-inbox').click();
  await page.locator('[data-inbox-filter="history"]').waitFor();
  await page.waitForFunction(()=>/History 3/.test(document.querySelector('[data-inbox-filter="history"]').textContent));
  const offeredOn={};
  for(const key of ['open','attention','review','all','history']){await page.locator(`[data-inbox-filter="${key}"]`).click();offeredOn[key]=await page.locator('#inbox-clear-history').isVisible();}
  const offered=await page.evaluate(()=>({clear:!document.getElementById('inbox-clear-history').hidden,show:document.getElementById('inbox-show-cleared').hidden}));
  check('every filter offers Clear history',()=>{assert.deepEqual(offeredOn,{open:true,attention:true,review:true,all:true,history:true});assert.deepEqual(offered,{clear:true,show:true});});
  await page.locator('[data-inbox-filter="open"]').click();
  await page.locator('#inbox-clear-history').click();
  const dialog=page.locator('dialog[aria-labelledby=inbox-clear-title]');await dialog.waitFor();
  const scope=await dialog.locator('.inbox-clear-scope').textContent(),kept=await dialog.locator('.inbox-clear-scope + p').textContent();
  if(shots)await page.screenshot({path:shots+'/inbox-clear-dialog.png'});
  check('the confirmation names the scope and says nothing is deleted',()=>{assert.equal(scope,'3 items leave the Inbox.');assert.match(kept,/Nothing is deleted/);});
  await dialog.getByRole('button',{name:'Clear history'}).click();await dialog.waitFor({state:'hidden'});
  await page.waitForFunction(()=>/History 0/.test(document.querySelector('[data-inbox-filter="history"]').textContent));
  const after=await page.evaluate(()=>({all:document.querySelector('[data-inbox-filter="all"]').textContent,open:document.querySelector('[data-inbox-filter="open"]').textContent,show:document.getElementById('inbox-show-cleared').textContent,clear:document.getElementById('inbox-clear-history').hidden}));
  check('clearing hides the three History items and touches nothing else',()=>{
   assert.deepEqual(writes,['report:i2','report:i3','report:i4']);
   assert.match(after.all,/All 1/);assert.match(after.open,/Open 1/);assert.equal(after.show,'Show 3 cleared');assert.equal(after.clear,true);
  });
  await page.locator('[data-inbox-filter="history"]').click();
  if(shots)await page.locator('.inbox-controls').screenshot({path:shots+'/inbox-history-cleared.png'});
  await page.locator('#inbox-show-cleared').click();
  const shown=await page.evaluate(()=>({count:document.querySelectorAll('#inbox-list [data-inbox-item]').length,toggle:document.getElementById('inbox-show-cleared').textContent}));
  await page.locator('#inbox-show-cleared').click();
  const hiddenAgain=await page.evaluate(()=>document.querySelectorAll('#inbox-list [data-inbox-item]').length);
  check('History can show the cleared items again',()=>{assert.deepEqual(shown,{count:3,toggle:'Hide cleared'});assert.equal(hiddenAgain,0);});
  await page.reload({waitUntil:'domcontentloaded'});await page.locator('#open-inbox').click();
  await page.waitForFunction(()=>/History 0/.test(document.querySelector('[data-inbox-filter="history"]')?.textContent||''));
  check('a reload keeps them cleared',()=>{});
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: Clear history hides History items without deleting anything, can show them again, and survives a reload');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
