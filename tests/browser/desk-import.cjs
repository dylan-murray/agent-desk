// Importing a desk saved in the other Agent Desk app, then reopening it here. This check starts its
// own backend with two scratch data folders: the browser desk's, and one standing in for the desktop
// app (AGENT_DESK_PEER_DATA_DIR), where it writes a fixture saved desk. No agent runs: a scratch
// ZDOTDIR defines `claude` and `codex` as shell functions that print their arguments, so the login
// shell an account command starts in never reaches a real CLI. Never touches the caller's server.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const net=require('node:net');
const {spawn,spawnSync}=require('node:child_process');
const {once}=require('node:events');
const repo=path.resolve(__dirname,'../..');
const python=process.env.AGENT_DESK_TEST_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){if(await fn())return;await pause(150);}throw Error('Timed out');}
const tag=Math.random().toString(36).slice(2,6),RESEARCH='Research '+tag,TAKEN='Taken '+tag;
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'desk-import-')));
const browserData=path.join(root,'browser'),desktopData=path.join(root,'desktop'),zdot=path.join(root,'zdot'),alpha=path.join(root,'alpha'),beta=path.join(root,'beta');
for(const folder of [browserData,desktopData,zdot,alpha,beta])fs.mkdirSync(folder,{mode:0o700});
fs.writeFileSync(path.join(zdot,'.zshrc'),"claude(){ printf 'fake-claude args: %s\\n' \"$*\"; exec /bin/sh; }\ncodex(){ printf 'fake-codex args: %s\\n' \"$*\"; exec /bin/sh; }\nPS1='fixture$ '\n");
const reviewer=crypto.randomUUID(),work=crypto.randomUUID();
const dangerous=['--dangerously-skip-permissions','--mcp-config',path.join(root,'elsewhere','mcp.json')];
const terminal=(id,cwd,fields)=>({id,name:'Claude',display_name:null,cwd,launch_profile:'claude',parent_id:null,created:1,origin:0,native_session:null,agent_exited:false,argv:['/bin/zsh','-lic','claude "$@"','agent-desk',...dangerous],...fields});
const research={terminals:[terminal('terminal-a',alpha,{display_name:'Reviewer',native_session:reviewer}),
  terminal('terminal-b',beta,{launch_profile:'claude-work',native_session:work,name:'Claude work'}),
  terminal('terminal-c',beta,{launch_profile:null,name:'Build',argv:['/usr/bin/make','deploy']})],
  coordinators:['coordinator-fixture'],at:Date.now()/1000-3600,
  layout:{layout:'columns',panes:[{id:'terminal-a'},{id:'terminal-b'},{id:'terminal-c'},{id:'web-1'}],pages:[{id:'web-1',url:'http://127.0.0.1:9/fixture-docs',name:'Fixture docs'}]}};
const peerFile=path.join(desktopData,`desks-${'cd'.repeat(16)}.json`);
fs.writeFileSync(peerFile,JSON.stringify({desks:[{id:'main',name:'Main'},{id:'desk-0a1b2c3d',name:RESEARCH},{id:'desk-4e5f6a7b',name:TAKEN}],placed:{},
  saved:{'desk-0a1b2c3d':research,'desk-4e5f6a7b':{terminals:[terminal('terminal-d',alpha,{launch_profile:'claude-work',name:'Claude work'})],coordinators:[],at:Date.now()/1000-60}}},null,2));
const peerBytes=()=>crypto.createHash('sha256').update(fs.readFileSync(peerFile)).digest('hex'),peerHash=peerBytes(),peerStat=fs.statSync(peerFile);
const bufferHas=(page,id,text)=>page.waitForFunction(([id,text])=>{const buffer=paneViews.get(id)?.term?.buffer.active;if(!buffer)return false;let all='';for(let i=0;i<buffer.length;i++){const line=buffer.getLine(i);all+=(line?.isWrapped?'':'\n')+(line?.translateToString(true)||'');}return all.includes(text);},[id,text],{timeout:15000});
const bufferText=(page,id)=>page.evaluate(id=>{const buffer=paneViews.get(id)?.term?.buffer.active;let all='';for(let i=0;buffer&&i<buffer.length;i++){const line=buffer.getLine(i);all+=(line?.isWrapped?'':'\n')+(line?.translateToString(true)||'');}return all;},id);
const rows=page=>page.$$eval('#shutdown-desk-dialog .desk-shutdown-list li',nodes=>nodes.map(n=>({name:n.querySelector('strong').textContent,note:n.querySelector('small').textContent,tag:n.querySelector('.desk-shutdown-outcome')?.textContent||null,detail:n.querySelector('.desk-shutdown-outcome')?.title||null,select:n.querySelector('select')?.value??null})));
(async()=>{
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');
 const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));assert.notEqual(port,4310);
 const base=`http://127.0.0.1:${port}/`,log=fs.openSync(path.join(root,'server.log'),'a');
 const server=spawn(python,['-m','agent_desk','--port',String(port)],{cwd:repo,env:{...process.env,AGENT_DESK_DATA_DIR:browserData,AGENT_DESK_PEER_DATA_DIR:desktopData,ZDOTDIR:zdot},stdio:['ignore',log,log]});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let browser;
 try{
  await until(async()=>{if(server.exitCode!==null)throw Error(fs.readFileSync(path.join(root,'server.log'),'utf8'));try{return (await fetch(base+'config.js')).ok;}catch{return false;}});
  browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
  const context=await browser.newContext({viewport:{width:1920,height:958},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base,{waitUntil:'domcontentloaded'});await page.waitForSelector('#desk-button .desk-name');await page.waitForTimeout(600);
  const agentsBefore=(await page.evaluate(async()=>(await fetch('/api/agents')).json())).agents.length;
  await page.evaluate(async name=>{await terminalRequest('/api/desks/create',{name});},TAKEN);await page.evaluate(()=>refresh());

  // The menu lists the desktop app's saved desks under a quiet heading.
  await page.click('#desk-button');
  await page.waitForSelector('.desk-peer-heading');
  const menu=await page.evaluate(()=>({heading:document.querySelector('.desk-peer-heading').textContent,
    rows:[...document.querySelectorAll('[data-desk-import]')].map(b=>({name:b.querySelector('.desk-option-name').textContent,tag:b.querySelector('.desk-option-saved').textContent,title:b.title}))}));
  check('the desk menu lists the other app\'s saved desks under “Saved in the desktop app”',()=>{
    assert.equal(menu.heading,'Saved in the desktop app');
    assert.deepEqual(menu.rows.map(r=>[r.name,r.tag]),[[RESEARCH,'Import'],[TAKEN,'Import']]);
    assert.match(menu.rows[0].title,/3 sessions.*nothing starts until you reopen it/);
  });
  await page.screenshot({path:path.join(OUT,'desk-import-01-menu.png')});

  // Choosing one copies it in as a saved desk; nothing starts and the other app's file is untouched.
  await page.click(`[data-desk-import$="/desk-0a1b2c3d"]`);
  await page.waitForSelector('#desk-menu [data-desk-reopen]');
  const imported=await page.evaluate(name=>{const desk=desks.find(d=>d.name===name);return {desk,toast:document.getElementById('toast').textContent,
    row:document.querySelector(`[data-desk-reopen="${desk.id}"] .desk-option-saved`)?.textContent,
    peer:[...document.querySelectorAll('[data-desk-import]')].map(b=>[b.querySelector('.desk-option-saved').textContent,b.getAttribute('aria-disabled')])};},RESEARCH);
  const agentsAfter=(await page.evaluate(async()=>(await fetch('/api/agents')).json())).agents.length;
  check('importing adds it here as a saved desk',()=>{assert.equal(imported.desk.imported,'desktop app');assert.ok(imported.desk.saved_at);assert.equal(imported.row,'Saved');});
  check('...says so, and marks the source row Imported',()=>{assert.match(imported.toast,new RegExp(`Imported “${RESEARCH}” from the desktop app`));assert.deepEqual(imported.peer[0],['Imported','true']);});
  check('...starts nothing',()=>assert.equal(agentsAfter,agentsBefore));
  check('...and leaves the desktop app\'s file exactly as it was',()=>{assert.equal(peerBytes(),peerHash);assert.equal(fs.statSync(peerFile).mtimeMs,peerStat.mtimeMs);});
  await page.screenshot({path:path.join(OUT,'desk-import-02-imported.png')});

  // A name taken here is offered for renaming in place.
  await page.click(`[data-desk-import$="/desk-4e5f6a7b"]`);
  await page.waitForSelector('[data-desk-import-input]');
  const rename=await page.evaluate(()=>({value:document.querySelector('[data-desk-import-input]').value,error:document.querySelector('.desk-menu-error').textContent,focused:document.activeElement?.matches('[data-desk-import-input]')}));
  check('a taken name opens a rename field with the reason',()=>{assert.equal(rename.value,TAKEN);assert.match(rename.error,new RegExp(`already a desk called “${TAKEN}”`));assert.ok(rename.focused);});
  await page.screenshot({path:path.join(OUT,'desk-import-03-rename.png')});
  await page.fill('[data-desk-import-input]',TAKEN+' (desktop)');await page.keyboard.press('Enter');
  await page.waitForFunction(name=>desks.some(d=>d.name===name&&d.saved_at),TAKEN+' (desktop)');
  check('...and imports it under the new name',()=>{});

  // Reopening goes through the dialog, which says what each session comes back as here.
  const id=imported.desk.id;
  await page.click(`[data-desk-reopen="${id}"]`);await page.waitForSelector('#shutdown-desk-dialog[open]');
  const dialog=await page.evaluate(()=>({title:document.querySelector('#shutdown-desk-dialog h2').textContent,lede:document.querySelector('.desk-shutdown-lede').textContent,
    confirm:document.getElementById('confirm-shutdown-desk').textContent,disabled:document.getElementById('confirm-shutdown-desk').disabled}));
  const listed=await rows(page);
  check('reopening an imported desk opens the dialog first',()=>{assert.equal(dialog.title,`Reopen “${RESEARCH}” here`);assert.match(dialog.lede,/Imported from the desktop app.*Nothing has started yet/);});
  check('...with what each session comes back as',()=>{
    assert.deepEqual(listed.map(r=>[r.name,r.tag]),[['Reviewer','Resumes'],['Claude work',null],['Build','Starts fresh']]);
    assert.equal(listed[0].detail,`On reopen: resumes Claude conversation ${reviewer}`);
    assert.equal(listed[2].detail,'On reopen: starts a new shell in the same folder');
  });
  check('...an account missing here asks for one and holds the reopen',()=>{assert.match(listed[1].note,/No “claude-work” account here/);assert.equal(listed[1].select,'');assert.equal(dialog.disabled,true);});
  const agentsAtDialog=(await page.evaluate(async()=>(await fetch('/api/agents')).json())).agents.length;
  check('...and nothing has started yet',()=>assert.equal(agentsAtDialog,agentsBefore));
  await page.screenshot({path:path.join(OUT,'desk-import-04-dialog.png')});
  await page.selectOption('[data-reopen-account="terminal-b"]','claude');
  const ready=await page.evaluate(()=>({disabled:document.getElementById('confirm-shutdown-desk').disabled,text:document.getElementById('confirm-shutdown-desk').textContent}));
  check('picking an account lets it reopen',()=>assert.deepEqual(ready,{disabled:false,text:'Reopen'}));
  await page.screenshot({path:path.join(OUT,'desk-import-05-picked.png')});
  await page.click('#confirm-shutdown-desk');
  await page.waitForFunction(()=>!document.getElementById('shutdown-desk-dialog').open,null,{timeout:20000});
  await page.waitForFunction(()=>document.querySelectorAll('#terminal .terminal-pane').length===4,null,{timeout:20000});
  const reopened=await page.evaluate(()=>({desk:activeDesk().name,layout:paneLayoutId,panes:[...openPaneIds],toast:document.getElementById('toast').textContent,
    titles:Object.fromEntries(openPaneIds.map(id=>[id,document.querySelector(`[data-pane-id="${CSS.escape(id)}"] .pane-title, [data-pane-id="${CSS.escape(id)}"] .terminal-title`)?.textContent||''])),
    agents:agents.filter(a=>openPaneIds.includes(a.id)).map(a=>({id:a.id,name:a.name}))}));
  const byName=Object.fromEntries(reopened.agents.map(a=>[a.name,a.id]));
  check('it reopens on its desk with its panes, layout and web page',()=>{assert.equal(reopened.desk,RESEARCH);assert.equal(reopened.layout,'columns');assert.equal(reopened.panes.length,4);assert.ok(reopened.panes.includes('web-1'));});
  check('...and says how many resumed',()=>assert.match(reopened.toast,/Reopened .* · 2 resumed, 1 started fresh/));
  await bufferHas(page,byName.Reviewer,`fake-claude args: --resume ${reviewer}`);
  await bufferHas(page,byName['Claude work'],`fake-claude args: --resume ${work}`);
  const texts=await Promise.all(Object.values(byName).map(id=>bufferText(page,id)));
  check('Claude resumes each conversation through this app\'s account, with none of the other app\'s flags',()=>{
    for(const text of texts)for(const flag of ['dangerously','mcp-config','elsewhere'])assert.ok(!text.includes(flag),flag);
  });
  await page.click(`[data-pane-id="${byName.Build}"] .xterm-screen`);await page.keyboard.type("printf 'shell-%s\\n' ready");await page.keyboard.press('Enter');
  await bufferHas(page,byName.Build,'shell-ready');
  check('a shell comes back as a working shell',()=>{});
  check('...and the build command never ran',()=>assert.ok(!texts[2].includes('deploy')));
  const launched=(await page.evaluate(async()=>(await fetch('/api/agents')).json())).agents.filter(a=>Object.values(byName).includes(a.id));
  check('...each in the folder it came from',()=>assert.deepEqual(Object.fromEntries(launched.map(a=>[a.name,a.cwd])),{Reviewer:alpha,'Claude work':beta,Build:beta}));
  check('the desktop app\'s file is still unchanged after reopening',()=>assert.equal(peerBytes(),peerHash));
  await page.waitForTimeout(400);await page.screenshot({path:path.join(OUT,'desk-import-06-reopened.png')});
  check('no page errors',()=>assert.deepEqual(errors,[]));

  // Narrow: the menu and the dialog at a phone's width.
  const phone=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const small=await phone.newPage();await small.goto(base,{waitUntil:'domcontentloaded'});await small.waitForSelector('#desk-button .desk-name');await small.waitForTimeout(600);
  await small.click('#desk-button');await small.waitForSelector('.desk-peer-heading');
  const fits=await small.evaluate(()=>{const menu=document.getElementById('desk-menu').getBoundingClientRect();return menu.right<=innerWidth&&menu.left>=0&&document.documentElement.scrollWidth<=innerWidth;});
  check('at 390px the menu fits the screen',()=>assert.ok(fits));
  await small.screenshot({path:path.join(OUT,'desk-import-07-menu-narrow.png')});
  const second=await small.evaluate(name=>desks.find(d=>d.name===name).id,TAKEN+' (desktop)');
  await small.click(`[data-desk-reopen="${second}"]`);await small.waitForSelector('#shutdown-desk-dialog[open]');
  await small.selectOption('[data-reopen-account="terminal-d"]','-');
  const left=await small.evaluate(()=>{const confirm=document.getElementById('confirm-shutdown-desk'),dialog=document.getElementById('shutdown-desk-dialog').getBoundingClientRect(),select=document.querySelector('[data-reopen-account]').getBoundingClientRect();
    return {text:confirm.textContent,disabled:confirm.disabled,fits:dialog.right<=innerWidth&&select.right<=dialog.right};});
  check('at 390px the dialog fits, and a session can be left out instead',()=>assert.deepEqual(left,{text:'Reopen it empty',disabled:false,fits:true}));
  await small.screenshot({path:path.join(OUT,'desk-import-08-dialog-narrow.png')});
  await small.click('#shutdown-desk-dialog .close-dialog');
  await phone.close();
 }catch(error){failures.push('run');console.log('  FAIL  run :: '+(error.stack||error.message));}
 finally{
  await browser?.close();
  // Scope cleanup to this fixture's private supervisor, never any user session.
  const cleanup=spawnSync(python,['-c',"from agent_desk.terminal_supervisor import SupervisorClient; import sys; c=SupervisorClient(sys.argv[1],int(sys.argv[2]),start=False); [c.get(s['id']).stop() for s in c.list()]; c.shutdown()",browserData,String(port)],{cwd:repo,encoding:'utf8',timeout:15000});
  if(cleanup.status!==0)console.error('Fixture supervisor cleanup:',cleanup.stderr);
  server.kill('SIGTERM');
 }
 console.log(failures.length?`${failures.length} failed`:'desk-import: all checks passed');
 process.exit(failures.length?1:0);
})();
