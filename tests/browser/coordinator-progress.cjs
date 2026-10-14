const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 const coordinators=[];let activity={phase:'planning',label:'Planning next actions',elapsed_seconds:82},offline=false;
 await page.route('**/api/**',route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/coordinators/create'){const b=route.request().postDataJSON();const c={...b,id:'coordinator-progress',state:'working',paused:0};coordinators.push(c);return route.fulfill({json:c});}
  if(path==='/api/coordinators'&&offline)return route.fulfill({status:503,json:{error:'Offline fixture'}});
  const data={'/api/coordinators':{coordinators,messages:[{id:1,kind:'assistant',text:'I have the report. I’m checking the canonical project paths before assigning the next steps.'}],actions:[],activity},'/api/coordinators/models':{models:[]},'/api/coordinators/quota':{state:'unavailable',windows:[]},'/api/agents':{agents:coordinators.map(c=>({...c,coordinator_workspace:true,controller:true,source:'coordinator',project:'agent-desk',harness:'claude',status:c.state,task:'Coordinate work',events:[]}))},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/feedback':{notes:[],deleted:[]},'/api/skills':{skills:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/projects':{projects:[],roots:[]}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310');await page.locator('#new-controller').click();
 await page.locator('[data-coord-id="coord-name"]').fill('Project research');await page.locator('[data-coord-id="coord-cwd"]').fill('/tmp');await page.locator('[data-coord-id="coord-create-form"] button[type=submit]').click();
 const status=page.locator('[data-coord-id="coord-status"]');await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]')?.textContent.includes('1:22 elapsed'));
 await page.screenshot({path:evidence('coordinator-progress-planning.png')});
 activity={...activity,elapsed_seconds:85};await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]').textContent.includes('1:25 elapsed'));
 activity={phase:'waiting',label:'Waiting for worker results',count:3};coordinators[0].state='idle';await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]').textContent.includes('3 pending reports'));assert.equal(await status.getAttribute('data-phase'),'waiting');
 await page.screenshot({path:evidence('coordinator-progress-waiting.png')});
 await page.setViewportSize({width:390,height:844});assert.ok(await status.isVisible());await page.screenshot({path:evidence('coordinator-progress-mobile.png')});
 for(const [phase,label] of [['queued','Next turn queued'],['paused','Paused'],['needs_input','Needs your answer'],['idle','Ready for your task']]){
  activity={phase,label};await page.waitForFunction(p=>document.querySelector('[data-coord-id="coord-status"]').dataset.phase===p,phase);assert.equal(await status.textContent(),label);
 }
 offline=true;await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]').textContent.includes('Connection lost'));assert.equal(await status.getAttribute('data-phase'),'disconnected');
 offline=false;activity={phase:'planning',label:'Planning next actions',elapsed_seconds:97};await page.waitForFunction(()=>document.querySelector('[data-coord-id="coord-status"]').textContent.includes('1:37 elapsed'));assert.deepEqual(errors,[]);
 console.log('PASS: planning timer, waiting count, queued/paused/attention/idle, disconnect and recovery, mobile; mocked API');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
