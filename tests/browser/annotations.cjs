// The desk annotates itself with annotate-anything. A note left on the page reaches a real
// terminal through the desk's own delivery, and the agent's progress shows on the note.
// Real backend, real PTY; the agent is tests/fixtures/fake_agent_prompt.py.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync,execSync}=require('node:child_process');
const {once}=require('node:events');
const evidence=require('./evidence.cjs');
const root=path.resolve(__dirname,'../..');
const python=process.env.AGENT_DESK_TEST_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=15000,what='condition'){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(50);}throw Error('Timed out waiting for '+what);}
(async()=>{
 const state=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-browser-annotations-')));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(state,'server.log'),'a'),received=path.join(state,'received.jsonl');
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let server,browser,token;
 async function api(route,payload){const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Agent-Desk-Terminal':token},body:JSON.stringify(payload)});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
 const saved=async()=>(await (await fetch(base+'api/feedback')).json());
 const tasks=()=>fs.existsSync(received)?fs.readFileSync(received,'utf8').trim().split('\n').map(line=>JSON.parse(line).task):[];
 try{
  server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:root,env:{...process.env,AGENT_DESK_DATA_DIR:state,SHELL:'/bin/sh'},stdio:['ignore',log,log]});
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(state,'server.log'),'utf8'));try{const response=await fetch(base+'config.js');if(!response.ok)return false;token=fs.readFileSync(path.join(state,`.terminal-token-${port}`),'utf8').trim();return true;}catch{return false;}},20000,'the server');
  const agent=await api('api/terminals/launch',{cwd:state,argv:[python,path.join(root,'tests/fixtures/fake_agent_prompt.py'),received],launch_profile:'claude',name:'Fixture agent'});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  // Only the desk's own terminals: discovered processes on this machine stay out of the page.
  await page.route('**/api/agents',async route=>{try{const response=await route.fetch(),body=await response.json();body.agents=body.agents.filter(a=>a.source==='terminal');await route.fulfill({response,json:body});}catch{}});
  await page.goto(base);
  const host=page.locator('annotate-anything'),bar=host.locator('.toolbar'),panel=host.locator('.panel');
  await host.locator('.launcher').waitFor();
  check('the desk loads annotate-anything with one launcher and no page errors on start',()=>assert.deepEqual(errors,[]));

  // Leave an element note on the Sessions page.
  await page.locator(`.session-row[data-agent-id="${agent.id}"]`).waitFor();
  await host.locator('.launcher').click();await bar.locator('[data-mode="element"]').click();
  const row=await page.locator(`.session-row[data-agent-id="${agent.id}"]`).boundingBox();
  await page.mouse.click(row.x+row.width/2,row.y+row.height/2);
  await panel.locator('textarea').fill('Show which agent this row belongs to at a glance');
  await page.keyboard.press('ControlOrMeta+Enter');await panel.waitFor({state:'hidden'});
  let note;await until(async()=>(note=(await saved()).notes[0]),8000,'the note to save');
  const inRow=await page.evaluate(([selector,id])=>document.querySelector(selector)?.closest('.session-row')?.dataset.agentId===id,[note.selector,agent.id]);
  check('the note saves to the desk, on the page it was left on, pointing into that agent\'s row',()=>{
   assert.equal(note.n,1);assert.equal(note.kind,'element');assert.equal(note.route,'/agents');assert.equal(note.status,'open');
   assert.ok(inRow,note.selector);
  });
  await page.screenshot({path:evidence('annotations-note-1440.png')});

  // Send offers the desk's coding agents and delivers through the desk.
  await bar.locator('[data-act="send"]').click();
  const choice=bar.locator(`li[data-target="${agent.id}"]`);await choice.waitFor();
  const label=await choice.locator('.ltext').textContent();
  check('the picker names the agent as Sessions does',()=>assert.equal(label,'Fixture agent'));
  await page.screenshot({path:evidence('annotations-send-to-1440.png')});
  await choice.click();
  await until(()=>tasks().length===1,10000,'the fake agent to get the notes');
  const task=tasks()[0];
  check('the agent gets the note by number, with where it was left',()=>assert.match(task,/- #1 element on \/agents \(.*\): Show which agent this row belongs to at a glance/));
  await until(async()=>(note=(await saved()).notes[0]).pickedUpAt,5000,'the note to be picked up');
  check('the note is marked sent and picked up once it reaches the agent',()=>{assert.equal(note.status,'sent');assert.ok(note.sentAt);});

  // The agent reports back with the command it was given.
  const command=task.split('so it shows on the note, with `')[1].split('`')[0];
  execSync(command+' 1 working',{cwd:state});
  let working=0;await until(async()=>(working=await host.locator('.mark.working').count()),8000,'the mark to show working').catch(()=>{});
  check('the agent\'s working update shows on the mark',()=>assert.equal(working,1));
  execSync(command+" 1 resolved --reply 'Added the agent name to the row.'",{cwd:state});
  await until(async()=>await host.locator('.mark.resolved').count(),8000,'the mark to show done');
  await pause(500);await host.locator('.mark.resolved').click();await panel.waitFor();await pause(300);
  const reply=await panel.isVisible()?await panel.innerText():'';
  await page.screenshot({path:evidence('annotations-reply-1440.png')});
  const replier=await panel.locator('.reply b').textContent().catch(()=>'');
  check('the agent\'s reply shows on the open note, under the agent it went to',()=>{assert.match(reply,/Added the agent name to the row\./);assert.equal(replier,'Fixture agent');});
  // Esc steps back one level at a time: the note, then the mode, then the bar.
  for(let i=0;i<3&&await bar.isVisible();i++)await page.keyboard.press('Escape');
  const closed=!(await bar.isVisible());
  check('Escape steps the tool back until the bar closes',()=>assert.ok(closed));

  // Notes belong to the page they were left on.
  await page.locator('#open-inbox').click();await pause(400);
  const onInbox=await host.locator('.mark').evaluateAll(marks=>marks.filter(m=>m.getBoundingClientRect().width>0).length);
  await page.locator('#open-sessions').click();await pause(400);
  const onSessions=await host.locator('.mark').evaluateAll(marks=>marks.filter(m=>m.getBoundingClientRect().width>0).length);
  check('a note left on Sessions hides on the Inbox and returns with Sessions',()=>{assert.equal(onInbox,0);assert.equal(onSessions,1);});

  // Inside a desk dialog the tool moves into the dialog, which stays open.
  await page.evaluate(()=>document.querySelector('#web-page-dialog').showModal());
  await until(()=>page.evaluate(()=>document.querySelector('annotate-anything').parentElement.id==='web-page-dialog'),5000,'the tool to move into the dialog');
  if(!(await bar.isVisible()))await host.locator('.launcher').click();
  await bar.locator('[data-mode="pin"]').click();
  const field=await page.locator('#web-page-dialog').boundingBox();
  await page.mouse.click(field.x+40,field.y+40);
  await panel.locator('textarea').fill('Say which pages can open here');await page.keyboard.press('ControlOrMeta+Enter');await panel.waitFor({state:'hidden'});
  const open=await page.evaluate(()=>document.querySelector('#web-page-dialog').open);
  await until(async()=>(await saved()).notes.length===2,5000,'the dialog note to save');
  const inDialog=(await saved()).notes.find(n=>n.n===2);
  check('...and it is saved as a dialog note while the dialog stays open',()=>{assert.equal(open,true);assert.equal(inDialog.inDialog,true);});
  await page.screenshot({path:evidence('annotations-dialog-1440.png')});
  await host.locator('.launcher').click();
  await page.evaluate(()=>document.querySelector('#web-page-dialog').close());

  // A reload keeps the notes, and Clear done records the deletion so it never comes back.
  await page.reload();await host.locator('.launcher').waitFor();await pause(600);
  const kept=await host.locator('.mark').evaluateAll(marks=>marks.filter(m=>m.getBoundingClientRect().width>0).length);
  check('a reload keeps the note on Sessions',()=>assert.equal(kept,1));
  await host.locator('.launcher').click();await bar.locator('[data-act="clear-done"]').click();
  await until(async()=>(await saved()).deleted.includes(note.id),5000,'the cleared note to be recorded');
  await page.reload();await host.locator('.launcher').waitFor();await pause(600);
  const after=await saved();
  check('Clear done removes the finished note for good and keeps the open one',()=>{assert.deepEqual(after.notes.map(n=>n.n),[2]);assert.ok(after.deleted.includes(note.id));});

  // Phone width: the launcher and bar stay on screen.
  await page.setViewportSize({width:390,height:844});await pause(300);
  if(!(await bar.isVisible()))await host.locator('.launcher').click();
  await bar.waitFor();await pause(300);
  const fits=await page.evaluate(()=>{const root=document.querySelector('annotate-anything').shadowRoot;return ['.launcher','.toolbar'].every(s=>{const r=root.querySelector(s).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.width>0;})&&document.documentElement.scrollWidth<=innerWidth;});
  const barShown=await bar.isVisible();
  await page.screenshot({path:evidence('annotations-bar-390.png')});
  check('at 390px the launcher and bar fit and nothing scrolls sideways',()=>{assert.ok(barShown);assert.ok(fits);});

  // With no agent open, the bar doesn't offer annotate-anything's attach prompt, and Send keeps the notes.
  const empty=await browser.newPage({viewport:{width:1440,height:900}});
  await empty.route('**/api/agents',async route=>{try{const response=await route.fetch(),body=await response.json();body.agents=[];await route.fulfill({response,json:body});}catch{}});
  await empty.goto(base);const emptyHost=empty.locator('annotate-anything');await emptyHost.locator('.launcher').click();
  const emptyBar=emptyHost.locator('.toolbar');await until(async()=>/waiting · press Send/.test(await emptyBar.innerText()),5000,'the bar to load').catch(()=>{});
  const idle=await emptyBar.innerText(),copies=await emptyBar.locator('.copy').count();
  await emptyBar.locator('[data-mode="pin"]').click();await empty.mouse.click(700,300);
  await emptyHost.locator('.panel textarea').fill('Nobody is here to take this');await empty.keyboard.press('ControlOrMeta+Enter');
  await emptyBar.locator('[data-act="send"]').click();await until(async()=>/No agent is running to send to/.test(await emptyBar.innerText()),5000,'Send to say no agent is running').catch(()=>{});
  const afterSend=await emptyBar.innerText();await empty.screenshot({path:evidence('annotations-no-agent-1440.png')});
  let parked;await until(async()=>(parked=(await saved()).notes.find(n=>n.comment==='Nobody is here to take this')),5000,'the note to save').catch(()=>{});
  check('with no agent open, the bar has no attach prompt and Send says no agent is running, keeping the note',()=>{
   assert.doesNotMatch(idle,/No agent attached/i);assert.equal(copies,0);
   assert.match(afterSend,/No agent is running to send to/);assert.equal(parked?.status,'open');
  });
  await empty.close();

  // Outside development the tool never loads.
  const production=await browser.newPage();
  await production.route('**/config.js',async route=>{const response=await route.fetch();return route.fulfill({response,body:(await response.text()).replace('"development": true','"development": false')});});
  await production.goto(base);await pause(800);
  const tools=await production.locator('annotate-anything').count();
  check('a production desk has no annotation tool',()=>assert.equal(tools,0));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{
  if(browser)await browser.close();
  if(server&&server.exitCode===null){const exited=once(server,'exit');server.kill('SIGINT');await exited;}
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",state,String(port)],{cwd:root,encoding:'utf8',env:{...process.env,AGENT_DESK_DATA_DIR:state}});
  fs.closeSync(log);
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  else fs.rmSync(state,{recursive:true,force:true});
 }
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: annotate-anything on the desk: notes save per page, Send delivers to a desk agent, its progress and reply show on the note, dialogs, reload, Clear done, 390px, production');
})().catch(error=>{console.error(error);process.exit(1);});
