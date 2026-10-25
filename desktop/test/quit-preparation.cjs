const {_electron}=require('../../node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const base=fs.mkdtempSync('/private/tmp/ad-quit-');
 const electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.resolve(__dirname,'..')],env:{...process.env,AGENT_DESK_DESKTOP_TEST:'1',AGENT_DESK_PROFILE_DIR:path.join(base,'profile'),AGENT_DESK_SOCKET_ROOT:path.join(base,'s'),AGENT_DESK_TEST_DELAY:'3000'}});
 try{
  const page=await electron.firstWindow();await page.locator('#status').waitFor();
  const exit=new Promise(resolve=>electron.process().once('exit',resolve));
  await electron.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Agent Desk').click());
  await exit;
  const run=path.join(base,'s/run');
  if(fs.existsSync(run))for(const folder of fs.readdirSync(run))assert.equal(fs.existsSync(path.join(run,folder,'connection.json')),false);
  assert.equal(fs.existsSync(path.join(base,'profile/logs/desktop-bootstrap.log')),false);
  console.log('PASS: quitting during preparation launches no orphan backend.');
 }finally{try{await electron.close();}catch{}}
})().catch(error=>{console.error(error);process.exitCode=1;});
