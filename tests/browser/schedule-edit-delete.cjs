const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),writes=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 let failDelete=true;
 page.on('dialog',()=>{throw Error('Native browser dialog is not allowed');});
 const data={configs:[{id:'config',name:'Morning debrief',kind:'automation',role_id:'role',timeout:3600}],workflows:[{id:'schedule',name:'Morning debrief',trigger:'cron',cron:'0 9 * * *',timezone:'UTC',enabled:true,nodes:[{id:'task-1',config_id:'config',depends_on:[]}]}],flows:[],executions:[]};
 await page.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;
 if(path==='/api/workflows/save'){const payload=route.request().postDataJSON();writes.push(payload);await new Promise(r=>setTimeout(r,150));const i=data.workflows.findIndex(w=>w.id===payload.id);if(i<0)data.workflows.push(payload);else data.workflows[i]=payload;return route.fulfill({json:payload});}
 if(path==='/api/workflows/delete'){if(failDelete)return route.fulfill({status:404,json:{error:'Not found'}});const p=route.request().postDataJSON();data.workflows=data.workflows.filter(w=>w.id!==p.id);return route.fulfill({json:{deleted:true}});}
 const routes={'/api/workflows':data,'/api/agents':{agents:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/coordinators':{coordinators:[]}};return route.fulfill({json:routes[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310');await page.locator('#open-workflows').click();
 await page.locator('#run-configs').getByRole('button',{name:'Schedule',exact:true}).click();await page.locator('#schedule-dialog').waitFor({state:'visible'});
 assert.equal(await page.locator('#schedule-dialog h2').textContent(),'Edit schedule');await page.locator('#schedule-hour').selectOption('10');
 await page.locator('#schedule-form').evaluate(f=>{f.dispatchEvent(new Event('submit',{cancelable:true}));f.dispatchEvent(new Event('submit',{cancelable:true}));});await page.locator('#schedule-dialog').waitFor({state:'hidden'});
 assert.equal(writes.length,1);assert.equal(writes[0].id,'schedule');assert.equal(writes[0].update,true);assert.equal(data.workflows.length,1);assert.equal(writes[0].cron,'0 10 * * *');
 await page.evaluate(()=>window.scheduleAutomation({id:'role',name:'Morning debrief'}));await page.locator('#schedule-dialog').waitFor({state:'visible'});assert.equal(await page.locator('#schedule-hour').inputValue(),'10');await page.locator('#schedule-dialog').evaluate(d=>d.close());
 await page.screenshot({path:evidence('schedule-edit-delete.png')});
 const dialog=page.getByRole('dialog',{name:'Delete schedule?'});
 await page.locator('#schedule-rows').getByRole('button',{name:'Delete',exact:true}).click();await dialog.getByRole('button',{name:'Keep schedule'}).click();assert.equal(data.workflows.length,1);
 await page.locator('#schedule-rows').getByRole('button',{name:'Delete',exact:true}).click();await dialog.getByRole('button',{name:'Delete schedule',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.schedule-delete-dialog[open] [role="alert"]').textContent.includes('restart'));assert.equal(data.workflows.length,1);
 await dialog.screenshot({path:evidence('schedule-delete-dialog.png')});
 await page.setViewportSize({width:390,height:844});await dialog.screenshot({path:evidence('schedule-delete-dialog-mobile.png')});assert.ok(await dialog.evaluate(d=>d.getBoundingClientRect().right<=innerWidth));
 failDelete=false;await dialog.getByRole('button',{name:'Delete schedule',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.waitForFunction(()=>document.getElementById('schedule-rows').textContent.includes('No workflows yet'));
 assert.equal(data.workflows.length,0);assert.equal(data.configs.length,1);assert.deepEqual(errors,[]);
 console.log('PASS: schedule shortcuts edit existing ID, duplicate submit blocked, automation shortcut reopens saved schedule, delete cancel/confirm');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
