const evidence=require('./evidence.cjs');
const {chromium}=require('playwright'),assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});try{
const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));let saved;
await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;if(p==='/api/workflows/save'){saved=r.request().postDataJSON();return r.fulfill({json:{ok:true}})}return r.fulfill({json:p==='/api/workflows'?{configs:[{id:'cfg',name:'Morning report',kind:'command',cwd:'/tmp'}],workflows:[],flows:[],executions:[]}:p==='/api/agents'?{agents:[]}:p==='/api/terminal-auth'?{token:'fixture',cwd:'/tmp'}:p==='/api/special-agents'?{roles:[],runs:[],inbox:[]}:p==='/api/feedback'?{notes:[],deleted:[]}:{} });});
await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4322');await page.locator('#open-workflows').click();await page.locator('#new-workflow').click();await page.locator('#schedule-trigger').selectOption('cron');
if(process.env.CAPTURE_BEFORE){await page.screenshot({path:evidence('schedule-controls-before.png')});return;}
for(const cron of ['17 * * * *','30 10 * * *','0 9 * * 1-5','45 16 * * 5','10 8 31 * *','*/15 8-18 * * 1,3,5']){await page.evaluate(cron=>scheduleControls.load(cron),cron);assert.equal(await page.locator('#schedule-cron').inputValue(),cron);}
await page.locator('#schedule-frequency').selectOption('weekly');await page.locator('#schedule-weekday').selectOption('2');await page.locator('#schedule-hour').selectOption('14');await page.locator('#schedule-minute').selectOption('35');assert.equal(await page.locator('#schedule-cron').inputValue(),'35 14 * * 2');
await page.locator('#schedule-timezone').fill('UTC');assert.match(await page.locator('#schedule-summary').textContent(),/Tuesday at 14:35.*UTC/);
await page.locator('#schedule-trigger').selectOption('once');assert.ok(await page.locator('#schedule-once-fields').isVisible());assert.ok(!(await page.locator('#schedule-cron-fields').isVisible()));await page.locator('#schedule-trigger').selectOption('cron');
await page.screenshot({path:evidence('schedule-controls-after.png')});await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence('schedule-controls-mobile.png')});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
await page.locator('#schedule-name').fill('Weekly report');await page.locator('#schedule-form button[type=submit]').click();await page.locator('#schedule-dialog').waitFor({state:'hidden'});assert.equal(saved.cron,'35 14 * * 2');
assert.deepEqual(errors,[]);console.log('PASS: recurring schedule controls, exact saved cron, desktop and mobile');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
