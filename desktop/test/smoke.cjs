'use strict';
// Actual Electron window, real fixture PTY and tool, disposable private state.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {execFileSync, spawnSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {Backend} = require('../src/backend.cjs');
const root = path.resolve(__dirname, '../..');
const fixture = fs.mkdtempSync('/private/tmp/ad-ui-');
const profile = path.join(fixture, 'profile');
const data = path.join(profile, 'data');fs.mkdirSync(data, {recursive:true, mode: 0o700});
const skill = path.join(fixture, 'skills/fixture');fs.mkdirSync(skill, {recursive: true});
fs.copyFileSync(path.join(root, 'tests/fixtures/desktop/tool.py'), path.join(skill, 'tool.py'));
fs.writeFileSync(path.join(skill, 'agent-desk-ui.json'), JSON.stringify({runtime: 'python-http', entrypoint: 'tool.py', title: 'Fixture review', target: 'none', transports: ['unix-http-v1']}));
const env = {...process.env, AGENT_DESK_DESKTOP_TEST: '1', AGENT_DESK_PROFILE_DIR: profile, AGENT_DESK_SOCKET_ROOT: path.join(fixture, 's'), AGENT_DESK_TOOL_ROOTS: path.join(fixture, 'skills')};
let electron, manager, electronLog = '';
(async () => {
  electron = await _electron.launch({executablePath: require('../node_modules/electron'), args: [path.join(root, 'desktop')], env, timeout: 30000});
  electron.process().stderr.on('data', chunk => {electronLog += chunk;});
  // Main-process errors must fail CI instead of waiting on a native error box.
  await electron.evaluate(({app})=>process.prependListener('uncaughtException',error=>{console.error(error.stack);app.exit(1);}));
  let page = await electron.firstWindow();page.setDefaultTimeout(10000);page.on('console',message=>{if(message.type()==='error')console.log('Renderer error:',message.text());});
  const errors = [];const pageError=error=>{errors.push(error.message);console.error('Renderer exception:',error.stack);};page.on('pageerror',pageError);
  await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('Connected'), {timeout: 30000});
  await page.waitForLoadState('load');
  console.log('Connected desktop workspace');
  assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await page.evaluate(async()=>(await fetch('/api/desktop/status')).status),403,'Lifecycle authority stays in the native menu');
  manager = new Backend({dataDir: data, source: root, python: execFileSync('which', ['python3'], {encoding: 'utf8'}).trim(), node: process.execPath, env});
  manager.loadRecord();
  const originalPid = manager.record.pid;
  const terminal = await page.evaluate(() => terminalRequest('/api/terminals/launch', {cwd: '/private/tmp', argv: ['/bin/sh'], name: 'Desktop fixture'}));
  await page.evaluate(async id => {await refresh();selectPane(id);}, terminal.id);
  await page.waitForSelector('.xterm');
  await page.evaluate(id => terminalRequest('/api/terminals/input', {id, data: btoa('echo desktop-stream-ok\n')}), terminal.id);
  await page.waitForFunction(id => {const b=paneViews.get(id)?.term?.buffer.active;if(!b)return false;for(let i=0;i<b.length;i++)if(b.getLine(i)?.translateToString(true).includes('desktop-stream-ok'))return true;return false;}, terminal.id, {timeout:10000});
  await page.evaluate(id=>{const link=document.createElement('a');link.id='report-fixture';link.href='/inbox-document.html?kind=session&item='+encodeURIComponent(id);link.target='_blank';link.rel='noopener noreferrer';link.textContent='Open report';link.style.cssText='position:fixed;top:10px;left:200px;z-index:100000';document.body.append(link);},terminal.id);
  const [report]=await Promise.all([electron.waitForEvent('window'),page.locator('#report-fixture').click()]);
  await report.locator('#document h1').waitFor();
  assert.equal(await report.locator('#document h1').textContent(),'Desktop fixture');
  await report.reload();await report.locator('#document h1').waitFor();
  assert.equal(await report.locator('#document h1').textContent(),'Desktop fixture');
  await report.close();
  await page.locator('#report-fixture').evaluate(link=>link.remove());
  // A real connection failure never causes automatic terminal input retries.
  console.log('PTY output received');
  const identity=await page.evaluate(()=>window.fixtureIdentity=crypto.randomUUID());
  await page.evaluate(()=>{document.getElementById('controller-goal').value='Unsent fixture draft';});
  process.kill(originalPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 300));
  const rejected=await page.evaluate(async()=>{const response=await fetch('/api/terminals/launch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({cwd:'/private/tmp',argv:['/bin/sh'],name:'Must not replay'})});return response.status;});
  assert.equal(rejected,503);
  // No Retry click: the shell reconnects itself after the backend crash.
  await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('Connected'), {timeout: 30000});
  await page.locator('.desktop-connection').waitFor({state:'hidden'});
  manager.loadRecord();assert.notEqual(manager.record.pid, originalPid);
  assert.equal(await page.evaluate(()=>window.fixtureIdentity),identity);
  const surviving = await page.evaluate(() => terminalRequest('/api/agents'));
  assert.ok(surviving.agents.some(row => row.id === terminal.id && row.exit_code === null));
  assert.equal(surviving.agents.filter(row=>row.terminal_id).length,1);
  assert.equal(await page.locator('#controller-goal').inputValue(),'Unsent fixture draft');
  assert.equal(await page.evaluate(id=>openPaneIds.includes(id),terminal.id),true);
  console.log('Automatically recovered surviving terminal and draft; disconnected mutation was not replayed');
  const tool = await page.evaluate(id => terminalRequest('/api/tools/launch', {skill: 'fixture', agent_id:id}),terminal.id);
  await page.evaluate(()=>refreshSkillUIs());
  console.log('Tool registry refreshed');
  await page.evaluate(tool=>{openToolOnDesk(tool);},tool);
  await page.waitForFunction(() => [...document.querySelectorAll('iframe')].some(frame => frame.src.startsWith('agent-tool:')), {timeout: 10000});
  await page.frameLocator('iframe[src^="agent-tool:"]').locator('#send').waitFor({timeout:15000});
  const frame = page.frames().find(frame => frame.url().startsWith('agent-tool:'));
  assert.ok(frame);assert.equal(await frame.evaluate(() => typeof window.agentDeskDesktop), 'undefined');
  await frame.waitForFunction(()=>typeof document.querySelector('#send')?.onclick==='function');
  await page.locator('iframe[src^="agent-tool:"]').elementHandle().then(handle=>handle.waitForElementState('stable'));
  await electron.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});await frame.click('#send');
  await frame.waitForSelector('#result:text("Saved")',{timeout:10000});
  const before = await manager.status();assert.equal(before.tools.length, 1);
  const pidList = [manager.record.pid];
  const listeners = spawnSync('/usr/sbin/lsof', ['-nP', '-a', '-p', pidList.join(','), '-iTCP', '-sTCP:LISTEN'], {encoding: 'utf8', stdio: ['ignore','pipe','pipe']});
  assert.equal(listeners.stdout.trim(), '');
  const evidence = process.env.AGENT_DESK_EVIDENCE_DIR || os.tmpdir();
  async function checkHeader(fullscreen = false) {
    const brand=await page.locator('.brand-lockup').boundingBox(),sidebar=await page.locator('.sidebar').boundingBox(),header=await page.locator('.desktop-sidebar-header').boundingBox();
    assert.equal(header.y,0,'Header starts at the window edge');
    assert.equal(header.height,60,'Header uses one compact row');
    assert.ok(Math.abs(brand.y+brand.height/2-30)<1,'Logo is vertically aligned with traffic lights');
    if (fullscreen) assert.ok(Math.abs(brand.x+brand.width/2-sidebar.x-sidebar.width/2)<2,'Fullscreen logo is centered');
    else assert.equal(brand.x,88,'Logo leaves 20px after the native controls');
    assert.equal(Math.round(brand.width),158,'Logo retains its full size');
    assert.ok(brand.x+brand.width<=sidebar.x+sidebar.width,'Logo fits inside the sidebar');
    assert.equal(await page.locator('.desktop-sidebar-header').evaluate(el=>getComputedStyle(el).webkitAppRegion),'drag');
    assert.equal(await page.locator('.brand').evaluate(el=>getComputedStyle(el).webkitAppRegion),'no-drag');
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await checkHeader();
  assert.deepEqual(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getWindowButtonPosition()),{x:14,y:22});
  const toolbar=await page.locator('.topbar').boundingBox();assert.equal(toolbar.height,60,'Workspace toolbar aligns with the sidebar header');
  await page.locator('#open-settings').click();
  await page.locator('.brand').click();
  assert.equal(await page.locator('#agents-page').isVisible(),true,'Logo returns to Sessions');
  assert.equal(await page.evaluate(()=>window.fixtureIdentity),identity,'Logo navigation preserves the document');
  await page.screenshot({path: path.join(evidence, 'agent-desk-desktop-wide.png')});
  const addon=path.join(fixture,'window-buttons.node'),include=path.resolve(fs.realpathSync(process.execPath),'../../include/node');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-bundle','-undefined','dynamic_lookup','-framework','AppKit','-I',include,path.join(__dirname,'native-window-buttons.m'),'-o',addon],{stdio:'pipe'});
  await electron.evaluate((_,addon)=>{const mod={exports:{}};process.dlopen(mod,addon);global.windowButtonsFixture=mod.exports;},addon);
  const buttonsHidden=()=>electron.evaluate(({BrowserWindow})=>global.windowButtonsFixture.hidden(BrowserWindow.getAllWindows()[0].getNativeWindowHandle()));
  async function checkButtons(hidden) {
    for(let i=0;i<50;i++){
      if((await buttonsHidden()).every(value=>value===hidden))return;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.deepEqual(await buttonsHidden(),[hidden,hidden,hidden]);
  }
  assert.deepEqual(await buttonsHidden(),[false,false,false]);
  const expandedButtons=[];
  for(const width of [1280,480]){
    await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
    await page.waitForFunction(width=>innerWidth===width,width);
    await page.waitForFunction(width=>document.querySelector('.pane-main')?.classList.contains('dock-bottom')===(width<=760),width);
    await page.locator(`[data-pane-id="${terminal.id}"] .pane-expand`).click();
    await page.waitForSelector('.pane-fullscreen');
    assert.equal(await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isFullScreen()),false);
    await checkButtons(true);
    await page.screenshot({path:path.join(evidence,`agent-desk-pane-fullscreen-${width}.png`)});
    expandedButtons.push(await buttonsHidden());
    if(width===1280){
      await page.evaluate(()=>switchPage('settings'));await checkButtons(false);
      await page.evaluate(()=>switchPage('agents'));await checkButtons(true);
    }
    await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.pane-fullscreen'));
    await checkButtons(false);
  }
  assert.deepEqual(expandedButtons,[[true,true,true],[true,true,true]],'Expanded panes hide all three native buttons at desktop and narrow widths');
  for (const width of [1024,761]) {
    await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
    await page.waitForFunction(width=>innerWidth===width,width);
    await checkHeader();
  }
  await electron.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(520, 800));
  await page.waitForFunction(()=>innerWidth<=520&&!!document.querySelector('.pane-main.dock-bottom'));
  await checkHeader();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path: path.join(evidence, 'agent-desk-desktop-narrow.png')});
  await electron.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(480, 800));
  await page.waitForFunction(()=>innerWidth===480);
  await checkHeader();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(evidence,'agent-desk-desktop-480.png')});
  await page.locator('#app-fullscreen').click();
  await page.waitForFunction(()=>document.querySelector('#app-fullscreen').getAttribute('aria-pressed')==='true');
  await checkHeader(true);
  await page.screenshot({path:path.join(evidence,'agent-desk-desktop-fullscreen.png')});
  await page.locator(`[data-pane-id="${terminal.id}"] .pane-expand`).click();
  await page.waitForSelector('.pane-fullscreen');
  await electron.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setFullScreen(false));
  await page.waitForFunction(()=>document.querySelector('#app-fullscreen').getAttribute('aria-pressed')==='false');
  await checkButtons(true);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('.pane-fullscreen'));await checkButtons(false);
  await checkHeader();
  const persisted=await page.evaluate(tool=>{
    openWebPage(tool.url,'Saved fixture web pane');
    paneRects=Object.fromEntries(openPaneIds.map((id,index)=>[id,{x:0,y:index*12,w:12,h:12}]));
    savePaneRects();savePanes();return {panes:[...openPaneIds],rects:paneRects,pages:[...webPages.values()]};
  },tool);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  await page.waitForSelector('.xterm');
  assert.deepEqual(await page.evaluate(()=>openPaneIds),persisted.panes);
  assert.deepEqual(await page.evaluate(()=>paneRects),persisted.rects);
  const webId=persisted.pages[0].id;
  await page.evaluate(id=>paneViews.get(id).node.scrollIntoView({block:'nearest'}),webId);
  await page.screenshot({path:path.join(evidence,'agent-desk-web-pane-before-restart.png')});
  // A new Electron process has no sessionStorage. Keep the fixture backend and
  // tool alive while checking that the window restores its persistent records.
  await electron.evaluate(({session})=>session.fromPartition('persist:agent-desk').flushStorageData());
  const exit=new Promise(resolve=>electron.process().once('exit',resolve));
  await electron.evaluate(({app})=>app.exit(0));await exit;
  electron=await _electron.launch({executablePath:require('../node_modules/electron'),args:[path.join(root,'desktop')],env,timeout:30000});
  page=await electron.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror',pageError);
  await electron.evaluate((_,addon)=>{const mod={exports:{}};process.dlopen(mod,addon);global.windowButtonsFixture=mod.exports;},addon);
  await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  await page.waitForLoadState('load');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('agent-desk-web-pages')),null,'A cold window must not reuse the previous session records');
  assert.deepEqual(await page.evaluate(()=>[...webPages.values()]),persisted.pages);
  assert.deepEqual(await page.evaluate(()=>openPaneIds),persisted.panes);
  assert.deepEqual(await page.evaluate(()=>paneRects),persisted.rects);
  const restored=page.locator(`.web-pane[data-pane-id="${webId}"]`);
  await restored.locator('.pane-title').getByText('Saved fixture web pane',{exact:true}).waitFor();
  await page.frameLocator(`.web-pane[data-pane-id="${webId}"] iframe`).locator('#send').waitFor();
  for(const width of [1280,480]){
    await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,800),width);
    await page.waitForFunction(width=>innerWidth===width,width);
    await restored.scrollIntoViewIfNeeded();await checkHeader();
    await page.screenshot({path:path.join(evidence,`agent-desk-web-pane-restored-${width}.png`)});
  }
  await restored.locator('.pane-expand').click();await checkButtons(true);
  await page.reload();await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  await checkButtons(false);
  await restored.locator('.pane-expand').click();await checkButtons(true);
  await restored.locator('.pane-close').click();await checkButtons(false);
  await page.reload();
  await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  assert.deepEqual(await page.evaluate(()=>[...webPages.values()]),[],'Closing the restored web pane must remove its saved record');
  assert.deepEqual(errors, []);
  await manager.shutdown();
  console.log('PASS: desktop launch, report windows, fixture PTY streaming, backend crash recovery, isolated visual tool feedback, responsive layout, pane fullscreen hiding/restoring native buttons across Escape/navigation/reload/close/native fullscreen, cold-start web pane/geometry restoration, closing restored panes, and shutdown.');
})().catch(error => {console.error(error);console.error(electronLog.slice(-8000));if(fs.existsSync(path.join(profile,'logs/desktop-backend.log'))) console.error(fs.readFileSync(path.join(profile,'logs/desktop-backend.log'),'utf8').slice(-8000));process.exitCode=1;}).finally(async () => {
  if(manager)try{await manager.shutdown();}catch{}
  if(electron)try{await electron.evaluate(({app})=>app.exit(0));}catch{}
  // The fixture path remains available for diagnosing a failed check; contains no real sessions.
  console.log('Fixture state:', fixture);
});
