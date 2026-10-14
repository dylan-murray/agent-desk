const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],writes=[];page.on('pageerror',e=>errors.push(e.message));
 const tasks=[{id:'task-event',controller:'controller',worker:'worker',task:'Verify event dispatch',result:'Tests passed without terminal input.',outcome:'completed',acknowledged:0,delivery:'sent',connection:'channel-connected',updated:100}];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(route.request().method()==='POST'){
   const body=route.request().postDataJSON();if(path!=='/api/feedback')writes.push({path,body});
   if(path==='/api/coordinator-events/retry'){tasks[0].delivery='queued';return route.fulfill({json:{queued:true}});}
   if(path==='/api/coordinator-events/ack'){tasks[0].acknowledged=1;return route.fulfill({json:tasks[0]});}
   if(path==='/api/terminals/launch')return route.fulfill({status:400,json:{error:'Fixture: launch captured'}});
   if(path==='/api/feedback')return route.fulfill({json:{notes:[],deleted:[]}});
   return route.fulfill({status:400,json:{error:'Unexpected mutation'}});
  }
  const data={'/api/agents':{agents:[{id:'controller',name:'Controller · Claude',source:'adapter',status:'idle',project:'Agent Desk',events:[],task:'Coordinate',updated:100,harness:'claude',exit_code:null}]},'/api/coordinator-events':{event_delivery:true,native_grok_terminal:true,supported_harnesses:['codex','claude','grok'],tasks},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/projects':{projects:[],roots:[],limited:false}};
  return route.fulfill({json:data[path]||{}});
 });
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-inbox').click();await page.locator('[data-inbox-item="task-event"]').click();
 assert.match(await page.locator('#inbox-detail').innerText(),/Notification sent · awaiting acknowledgement/);
 assert.match(await page.locator('#inbox-detail').innerText(),/Tests passed without terminal input/);
 page.once('dialog',d=>d.dismiss());await page.getByRole('button',{name:'Retry notification',exact:true}).click();assert.equal(writes.length,0);
 page.once('dialog',d=>d.accept());await page.getByRole('button',{name:'Retry notification',exact:true}).click();await page.waitForFunction(()=>document.getElementById('inbox-detail').innerText.includes('Notification queued'));
 await page.getByRole('button',{name:'Mark handled',exact:true}).click();await page.locator('[data-inbox-filter="history"]').click();await page.locator('[data-inbox-item="task-event"]').click();assert.match(await page.locator('#inbox-detail').innerText(),/Acknowledged/);
 await page.evaluate(()=>switchPage('agents'));await page.evaluate(()=>openTerminalLauncher(undefined,null,false,true));await page.locator('#controller-goal').fill('Coordinate this task');await page.locator('#terminal-harness').selectOption('grok');
 await page.locator('#launch-terminal-form button[type="submit"]').click();await page.waitForFunction(()=>document.getElementById('terminal-launch-error').textContent.includes('Fixture'));
 assert.match(await page.locator('#coordinator-transport-help').innerText(),/native terminal/);
 const launch=writes.find(w=>w.path==='/api/terminals/launch').body;assert.equal(launch.coordinator_harness,'grok');
 const prompt=launch.argv.at(-1);assert.match(prompt,/END YOUR TURN/);assert.doesNotMatch(prompt,/wait --controller/);assert.match(prompt,/queued reply notifications/);
 await page.locator('#launch-terminal-dialog').evaluate(el=>el.close());await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(writes.map(w=>w.path),['/api/coordinator-events/retry','/api/coordinator-events/ack','/api/terminals/launch']);assert.deepEqual(errors,[]);
 tasks[0].acknowledged=0;tasks[0].connection='delivery-paused';await page.evaluate(()=>refreshCoordinatorEvents());await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter="open"]').click();await page.locator('[data-inbox-item="task-event"]').click();assert.match(await page.locator('#inbox-detail').innerText(),/paused after interrupt/);
 tasks[0].connection='policy-blocked';await page.evaluate(()=>refreshCoordinatorEvents());await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter="open"]').click();await page.locator('[data-inbox-item="task-event"]').click();assert.match(await page.locator('#inbox-detail').innerText(),/blocked by organization policy/);assert.equal(await page.getByRole('button',{name:'Retry notification',exact:true}).count(),0);
 console.log('PASS: event inbox delivery/ack distinction, explicit retry, no automatic input, launch capability and prompt, mobile; mocked APIs only');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
