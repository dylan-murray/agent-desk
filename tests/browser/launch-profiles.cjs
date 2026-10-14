const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage(),launches=[],errors=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>localStorage.setItem('agent-desk-launch-settings',JSON.stringify({codex:{command:'codex-personal',mode:'/bin/zsh'},claude:{command:'claude-personal',mode:'/bin/zsh'}})));
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/terminals/launch'){launches.push(route.request().postDataJSON());return route.fulfill({status:400,json:{error:'Fixture launch captured'}});}
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/coordinator-events':{tasks:[],event_delivery:true,supported_harnesses:['codex','claude','grok']},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/projects':{projects:[],roots:[],limited:false}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#new-terminal').click();await page.locator('[data-new-pane="terminal"]').click();
 for(const profile of ['codex','codex-personal','claude','claude-personal']){
  await page.locator('#terminal-harness').selectOption(profile);assert.equal(await page.locator('#terminal-executable').inputValue(),profile);
  await page.locator('#launch-terminal-form button[type="submit"]').click();await page.waitForFunction(()=>document.getElementById('terminal-launch-error').textContent==='Fixture launch captured');
  const launch=launches.at(-1);assert.equal(launch.launch_profile,profile);assert.equal(launch.argv[2],profile+' "$@"');
 }
 await page.reload();await page.locator('#new-controller').click();await page.locator('#terminal-harness').selectOption('claude');await page.locator('#controller-goal').fill('Coordinate work');await page.locator('#launch-terminal-form button[type="submit"]').click();await page.waitForFunction(()=>document.getElementById('terminal-launch-error').textContent==='Fixture launch captured');
 assert.equal(launches.at(-1).launch_profile,'claude');assert.equal(launches.at(-1).coordinator_harness,'claude');assert.equal(launches.at(-1).argv[2],'claude "$@"');assert.deepEqual(errors,[]);
 console.log('PASS: Work/Personal launch profiles, stale personal-command overrides ignored, reload and coordinator routing; mocked APIs only');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
