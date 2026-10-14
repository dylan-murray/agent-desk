const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:1000}}),errors=[],launches=[];page.on('pageerror',e=>errors.push(e.message));
 const projects=[{name:'agent-desk',path:'/Users/fixture/personal/agent-desk'},{name:'example-api',path:'/Users/fixture/work/example-api'},
   {name:'example-reports',path:'/Users/fixture/work/example-reports'},{name:'dashboard',path:'/Users/fixture/personal/dashboard'}];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/terminals/launch'){launches.push(route.request().postDataJSON());return route.fulfill({status:400,json:{error:'Fixture launch captured'}});}
  const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]},'/api/projects':{projects,roots:['/Users/fixture'],limited:false}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#new-terminal').click();await page.locator('[data-new-pane="terminal"]').click();
 await page.waitForFunction(()=>document.getElementById('terminal-project').options.length>4);
 assert.equal(await page.locator('#terminal-project-list').isVisible(),false);
 // Opening the field lists every project plus the two directory choices.
 await page.locator('#terminal-project-search').click();
 await page.waitForSelector('.project-combobox-option');
 assert.equal(await page.locator('.project-combobox-option').count(),6);
 assert.equal(await page.locator('#terminal-project-search').getAttribute('aria-expanded'),'true');
 await page.screenshot({path:evidence('agentdesk-project-search-open.png')});
 // A keyword narrows the list across names and paths.
 await page.locator('#terminal-project-search').fill('example');
 await page.waitForFunction(()=>document.querySelectorAll('.project-combobox-option').length===2);
 await page.locator('#terminal-project-search').fill('work report');
 await page.waitForFunction(()=>document.querySelectorAll('.project-combobox-option').length===1);
 assert.match(await page.locator('.project-combobox-option').innerText(),/example-reports/);
 await page.screenshot({path:evidence('agentdesk-project-search-filtered.png')});
 // Keyboard: arrow to the match, Enter selects it and fills the working directory.
 await page.keyboard.press('ArrowDown');await page.keyboard.press('Enter');
 assert.equal(await page.locator('#terminal-cwd').inputValue(),'/Users/fixture/work/example-reports');
 assert.equal(await page.locator('#terminal-project').inputValue(),'/Users/fixture/work/example-reports');
 assert.equal(await page.locator('#terminal-project-search').inputValue(),'example-reports');
 assert.equal(await page.locator('#terminal-project-list').isVisible(),false);
 // A search with no match says so and selects nothing.
 await page.locator('#terminal-project-search').fill('nothing-here');
 await page.waitForSelector('.project-combobox-empty');
 assert.equal(await page.locator('#terminal-project').inputValue(),'/Users/fixture/work/example-reports');
 // Escape restores the selected project's label and keeps the launch dialog open.
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#launch-terminal-dialog').isVisible(),true);
 assert.equal(await page.locator('#terminal-project-search').inputValue(),'example-reports');
 // The chevron reopens the full list, and clicking a row selects it.
 await page.locator('#terminal-project-toggle').click();
 await page.waitForFunction(()=>document.querySelectorAll('.project-combobox-option').length===6);
 await page.locator('.project-combobox-option',{hasText:'agent-desk'}).first().click();
 assert.equal(await page.locator('#terminal-cwd').inputValue(),'/Users/fixture/personal/agent-desk');
 // ＋ New directory still switches the dialog into folder-creation mode.
 await page.locator('#terminal-project-toggle').click();
 await page.locator('.project-combobox-option',{hasText:'New directory'}).click();
 assert.equal(await page.locator('#terminal-new-directory').isVisible(),true);
 assert.equal(await page.locator('#terminal-cwd-label').innerText(),'Parent directory');
 // Typing a path by hand returns the picker to the manual choice and launches that directory.
 await page.locator('#terminal-project-toggle').click();
 await page.locator('.project-combobox-option',{hasText:'Use a directory path'}).click();
 await page.locator('#terminal-cwd').fill('/Users/fixture/scratch');
 assert.equal(await page.locator('#terminal-project').inputValue(),'manual');
 assert.equal(await page.locator('#terminal-project-search').inputValue(),'');
 await page.locator('#launch-terminal-form button[type="submit"]').click();
 await page.waitForFunction(()=>document.getElementById('terminal-launch-error').textContent==='Fixture launch captured');
 assert.equal(launches.at(-1).cwd,'/Users/fixture/scratch');
 await page.setViewportSize({width:390,height:844});
 await page.locator('#terminal-project-search').click();
 await page.waitForSelector('.project-combobox-option');
 assert.equal(await page.locator('#terminal-project-list').isVisible(),true);
 await page.screenshot({path:evidence('agentdesk-project-search-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: project keyword search over names and paths, keyboard and mouse selection, empty match, Escape, New directory and manual path, launch payload, mobile; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
