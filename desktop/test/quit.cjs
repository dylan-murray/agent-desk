// Real backend status and native quit menu, with deterministic dialog answers.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {execFileSync}=require('node:child_process');
const {_electron}=require('../../node_modules/playwright');
const {Backend}=require('../src/backend.cjs');
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
  console.log('PASS: coordinator-only and monitor-only quit confirmations, Cancel, Keep Running, Stop Work and Quit, idle saved coordinator without confirmation.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(manager)try{await manager.shutdown();}catch{}
  if(electron)try{await electron.evaluate(({app})=>app.exit(0));}catch{}
  console.log('Fixture:',base);
});
