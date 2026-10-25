// Real backend status and native quit menu, with deterministic dialog answers.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {_electron}=require('../../node_modules/playwright');
const {Backend}=require('../src/backend.cjs');
const {paneText}=require('../../tests/browser/terminal-text.cjs');
const root=path.resolve(__dirname,'../..'),base=fs.mkdtempSync('/private/tmp/ad-quit-status-');
const env={...process.env,AGENT_DESK_DESKTOP_TEST:'1',AGENT_DESK_PROFILE_DIR:path.join(base,'profile'),AGENT_DESK_SOCKET_ROOT:path.join(base,'s')};
let electron,manager;
async function menuQuit(){await electron.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Agent Desk').click());}
(async()=>{
  electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(root,'desktop')],env});
  const page=await electron.firstWindow();await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  manager=new Backend({dataDir:path.join(base,'profile/data'),source:root,python:'unused',node:'unused',env});manager.loadRecord();
  const c=await page.evaluate(cwd=>terminalRequest('/api/coordinators/create',{cwd,name:'Fictional coordinator',profile:'claude'}),base);
  const database=path.join(base,'profile/data',`coordinators-${manager.workspace}.sqlite3`);
  function sql(statement,args=[]){execFileSync('python3',['-c','import sqlite3,sys,json\nwith sqlite3.connect(sys.argv[1]) as db: db.execute(sys.argv[2],json.loads(sys.argv[3]))',database,statement,JSON.stringify(args)]);}
  // A running turn never dispatches a CLI. The independent runtime regression
  // covers pending turns, planner execution state, delivery queues and idleness.
  sql('INSERT INTO turns VALUES(?,?,?,?,?)',['fixture-turn',c.id,'running',0,Date.now()/1000]);
  let state=await manager.status();assert.equal(state.active,true);assert.equal(state.sessions.length,0);assert.equal(state.coordinators.planning,1);
  await electron.evaluate(({dialog})=>{global.fixtureDialogs=[];global.fixtureAnswer=2;dialog.showMessageBox=async(_win,options)=>{global.fixtureDialogs.push(options);return {response:global.fixtureAnswer};};});
  await menuQuit();
  await (async()=>{for(let i=0;i<100;i++){if(await electron.evaluate(()=>global.fixtureDialogs.length))return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('No coordinator quit confirmation');})();
  const planning=await electron.evaluate(()=>global.fixtureDialogs[0]);assert.match(planning.detail,/1 coordinators planning/);assert.deepEqual(planning.buttons,['Keep Running','Stop Work and Quit','Cancel']);
  sql("UPDATE turns SET state='done'");
  sql('INSERT INTO coordinator_watches VALUES(?,?,?,?,?,?,?,?,?,?,?)',['watch-fixture',c.id,'https://github.com/fixture/repo/pull/1','watching','',4e9,Date.now()/1000,4e9,0,'fixture','Fictional monitor']);
  state=await manager.status();assert.equal(state.active,true);assert.equal(state.coordinators.planning,0);assert.equal(state.coordinators.monitors,1);
  await electron.evaluate(()=>{global.fixtureAnswer=0;});await menuQuit();
  for(let i=0;i<100&&await electron.evaluate(()=>global.fixtureDialogs.length)<2;i++)await new Promise(resolve=>setTimeout(resolve,20));
  const monitoring=await electron.evaluate(()=>global.fixtureDialogs[1]);assert.match(monitoring.detail,/1 active PR monitors/);
  assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show());
  // Stop Work and Quit drains the same runtime even when only a monitor exists.
  await electron.evaluate(()=>{global.fixtureAnswer=1;});
  const exit=new Promise(resolve=>electron.process().once('exit',resolve));await menuQuit();await exit;
  assert.equal(fs.existsSync(manager.recordPath),false);
  // Idle saved coordinator alone: no native confirmation, normal shutdown.
  electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(root,'desktop')],env});
  const reopened=await electron.firstWindow();await reopened.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  sql("UPDATE coordinator_watches SET state='stopped'");
  manager.record=null;manager.loadRecord();assert.equal((await manager.status()).active,false);
  await electron.evaluate(({dialog})=>{dialog.showMessageBox=async()=>{throw Error('Idle saved coordinator prompted for quit');};});
  const idleExit=new Promise(resolve=>electron.process().once('exit',resolve));await menuQuit();await idleExit;
  // A real native quit must retain terminal identity and pane selection.
  async function open(){
    electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(root,'desktop')],env});
    const window=await electron.firstWindow();
    await window.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
    manager.record=null;manager.loadRecord();return window;
  }
  let window=await open();
  const shell=await window.evaluate(cwd=>terminalRequest('/api/terminals/launch',{cwd,argv:['/bin/sh'],name:'Fictional saved shell'}),base);
  const closed=await window.evaluate(cwd=>terminalRequest('/api/terminals/launch',{cwd,argv:['/bin/sh'],name:'Fictional closed shell'}),base);
  await window.evaluate(async({kept,closed})=>{
    await terminalRequest('/api/terminals/stop',{id:closed});
    await terminalRequest('/api/terminals/rename',{id:kept,name:'Saved build shell'});
    await refresh();selectPane(kept);
  },{kept:shell.id,closed:closed.id});
  const evidence=process.env.AGENT_DESK_EVIDENCE_DIR||require('node:os').tmpdir();fs.mkdirSync(evidence,{recursive:true});
  await window.locator(`[data-pane-id="${shell.id}"] .xterm`).waitFor();
  await window.screenshot({path:path.join(evidence,'agent-desk-session-before-quit.png')});
  await electron.evaluate(({dialog})=>{
    dialog.showMessageBox=async()=>({response:1});
    dialog.showErrorBox=(title,detail)=>{global.fixtureShutdownError={title,detail};};
  });
  // A failed restore-record checkpoint must keep the native app and PTY alive.
  const sessionFile=path.join(base,'profile/data',`terminal-sessions-${manager.workspace}.json`),blocked=sessionFile+'.tmp';
  fs.mkdirSync(blocked);
  try{
    await menuQuit();
    await (async()=>{for(let i=0;i<100;i++){if(await electron.evaluate(()=>global.fixtureShutdownError))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Checkpoint failure did not report incomplete shutdown');})();
    const error=await electron.evaluate(()=>global.fixtureShutdownError);
    assert.equal(error.title,'Previous shutdown is incomplete');assert.match(error.detail,/save terminal sessions/);
    assert.equal(electron.process().exitCode,null);
    const paused=await manager.status();assert.equal(paused.paused,true);assert.deepEqual(paused.sessions.map(item=>item.id),[shell.id]);
    assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
  }finally{fs.rmdirSync(blocked);}
  const stopped=new Promise(resolve=>electron.process().once('exit',resolve));await menuQuit();await stopped;
  assert.equal(fs.existsSync(manager.recordPath),false,'Quit confirms backend exit');
  const saved=JSON.parse(fs.readFileSync(sessionFile,'utf8'));
  assert.deepEqual(saved.sessions.map(item=>item.id),[shell.id]);
  window=await open();
  const pane=window.locator(`[data-pane-id="${shell.id}"]`);
  await pane.locator('.xterm').waitFor();
  await pane.locator('.pane-title').getByText('Saved build shell',{exact:false}).waitFor();
  assert.ok(await window.evaluate(id=>openPaneIds.includes(id),shell.id));
  const liveSessions=(await manager.status()).sessions;
  assert.deepEqual(liveSessions.map(item=>item.id),[shell.id]);
  assert.equal(liveSessions[0].cwd,base);
  const savedCoordinators=await window.evaluate(()=>terminalRequest('/api/coordinators'));
  assert.equal(savedCoordinators.coordinators.find(item=>item.id===c.id)?.name,'Fictional coordinator','SQLite coordinator session also survives stop/start');
  for(const width of [1280,480]){
    await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
    await window.waitForFunction(width=>innerWidth===width,width);
    await pane.scrollIntoViewIfNeeded();
    assert.equal(await window.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await window.screenshot({path:path.join(evidence,`agent-desk-session-restored-${width}.png`)});
  }
  await window.evaluate(id=>terminalRequest('/api/terminals/input',{id,data:btoa("printf 'reopened-%s\\n' desktop\n")}),shell.id);
  await (async()=>{for(let i=0;i<100;i++){if((await paneText(pane)).includes('reopened-desktop'))return;await new Promise(resolve=>setTimeout(resolve,50));}throw Error('Restored terminal did not accept input');})();
  assert.match(await paneText(pane),/Agent Desk restored this terminal after a restart/);
  await window.evaluate(id=>terminalRequest('/api/terminals/stop',{id}),shell.id);
  await electron.evaluate(({dialog})=>{dialog.showMessageBox=async()=>{throw Error('Stopped terminals prompted for quit');};});
  const finalExit=new Promise(resolve=>electron.process().once('exit',resolve));await menuQuit();await finalExit;
  window=await open();
  assert.deepEqual((await manager.status()).sessions,[],'Explicitly stopped terminals stay closed after reopening');
  const emptyExit=new Promise(resolve=>electron.process().once('exit',resolve));await menuQuit();await emptyExit;
  console.log('PASS: native quit choices, idle coordinator quit, failed checkpoint keeping app/PTY alive, successful retry and quit/reopen preserving session ID/title/folder/pane and working PTY at desktop/narrow widths, and explicit Stop staying closed.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(manager)try{await manager.shutdown();}catch{}
  if(electron)try{await electron.evaluate(({app})=>app.exit(0));}catch{}
  console.log('Fixture:',base);
});
