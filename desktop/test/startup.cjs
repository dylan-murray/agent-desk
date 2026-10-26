const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {_electron}=require('../../node_modules/playwright');
const root=path.resolve(__dirname,'../..'),base=fs.mkdtempSync('/private/tmp/ad-start-');
const evidence=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
let electron;
(async()=>{
 const start=Date.now();
 electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(root,'desktop')],env:{...process.env,AGENT_DESK_DESKTOP_TEST:'1',AGENT_DESK_PROFILE_DIR:path.join(base,'profile'),AGENT_DESK_SOCKET_ROOT:path.join(base,'s'),AGENT_DESK_TEST_DELAY:'4000',AGENT_DESK_TEST_FAIL_ONCE:'1'}});
 const page=await electron.firstWindow();await page.locator('#status').waitFor();
 const visible=Date.now()-start;
 assert.ok(page.url().endsWith('/startup.html'));
 assert.equal(await page.locator('#header-nav').count(),0);
 assert.equal(await page.locator('img').evaluate(el=>getComputedStyle(el).width),'48px');
 assert.equal(await page.locator('#status').textContent(),'Opening your workspace…');
 assert.equal(await page.locator('body').evaluate(el=>getComputedStyle(el).webkitAppRegion),'drag');
 assert.deepEqual(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getWindowButtonPosition()),{x:14,y:22});
 const result=await page.evaluate(async()=>{const r=await fetch('/api/terminals/launch',{method:'POST',body:'{}'});return {status:r.status,value:await r.json()};});
 assert.equal(result.status,503);assert.equal(result.value.code,'workspace_not_ready');
 assert.equal(await page.evaluate(()=>typeof agentDeskDesktop.request),'undefined');
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.dot').evaluate(el=>getComputedStyle(el).animationName),'none');
 for(const width of [1280,520,480]){
  await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,850),width);
  await page.waitForFunction(width=>innerWidth===width,width);
  const center=await page.locator('main').evaluate(el=>{const r=el.getBoundingClientRect();return {x:Math.abs(r.x+r.width/2-innerWidth/2),y:Math.abs(r.y+r.height/2-innerHeight/2),overflow:document.documentElement.scrollWidth>innerWidth};});
  assert.ok(center.x<1&&center.y<1&&!center.overflow,JSON.stringify(center));
  await page.screenshot({path:path.join(evidence,`agent-desk-loading-${width}.png`)});
 }
 await page.waitForFunction(async()=>(await agentDeskDesktop.snapshot()).connection==='failed');
 await page.locator('#retry').waitFor({state:'visible'});
 await page.screenshot({path:path.join(evidence,'agent-desk-loading-failed.png')});
 // The real runtime worker publishes this stage while copying a first installation.
 const failed=await page.evaluate(()=>agentDeskDesktop.snapshot());
 await electron.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('desk:state',state),{...failed,stage:'setup',connection:'preparing',error:null});
 await page.waitForFunction(()=>document.querySelector('#status').textContent==='Setting up Agent Desk…');
 await page.screenshot({path:path.join(evidence,'agent-desk-loading-setup.png')});
 await electron.evaluate(({BrowserWindow},state)=>BrowserWindow.getAllWindows()[0].webContents.send('desk:state',state),failed);
 // The injected transient failure recovers without a click.
 await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
 assert.equal(await page.locator('#retry').count(),0);
 assert.equal(await page.evaluate(()=>AGENT_DESK_CONFIG.development),true,'source runs enable development tools');
 assert.ok(await page.evaluate(()=>Array.isArray(AGENT_DESK_CONFIG.accounts)&&AGENT_DESK_CONFIG.accounts.length>0));
 assert.equal(await page.evaluate(async()=>(await terminalRequest('/api/agents')).agents.filter(agent=>agent.terminal_id).length),0);
 const identity=await page.evaluate(()=>window.testIdentity=crypto.randomUUID());
 await page.locator('#open-settings').click();await page.locator('#open-sessions').click();
 await page.evaluate(()=>Promise.all([agentDeskDesktop.recover('retry'),agentDeskDesktop.recover('retry')]));
 await page.waitForFunction(async()=>(await agentDeskDesktop.snapshot()).connection==='connected');
 assert.equal(await page.evaluate(()=>window.testIdentity),identity);
 await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
 assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),false);
 // Dock activation must reopen the hidden window without a menu bar shortcut.
 await electron.evaluate(({app})=>app.emit('activate'));
 assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),true);
 assert.equal(await page.evaluate(()=>window.testIdentity),identity);
 console.log(JSON.stringify({loadingVisibleMs:visible,workspaceMs:Date.now()-start,injectedDelayMs:12000}));
 await electron.evaluate(({Menu})=>Menu.getApplicationMenu().items[0].submenu.items.find(item=>item.label==='Quit Agent Desk').click());
 console.log('PASS: minimal loading, pending mutation rejected, Reduce Motion, setup/failure, automatic recovery, concurrent manual Retry, real config, same-document recovery and close/reopen.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{if(electron)try{await electron.close();}catch{};console.log('Fixture:',base);});
