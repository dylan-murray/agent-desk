'use strict';
// Real desktop dialog, source-only curl authentication and narrow layouts.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {Backend} = require('../src/backend.cjs');
const root = path.resolve(__dirname,'../..'), base = fs.mkdtempSync('/private/tmp/ad-webhooks-');
const env = {...process.env, AGENT_DESK_DESKTOP_TEST:'1', AGENT_DESK_PROFILE_DIR:path.join(base,'profile'), AGENT_DESK_SOCKET_ROOT:path.join(base,'s')};
let electron, manager;
(async () => {
  electron = await _electron.launch({executablePath:require('../node_modules/electron'), args:[path.join(root,'desktop')], env});
  const page = await electron.firstWindow();
  await page.waitForFunction(()=>document.querySelector('#sync-status')?.textContent.includes('Connected'));
  await electron.evaluate(({clipboard})=>{const write=clipboard.writeText;clipboard.writeText=value=>{global.fixtureCopied=value;write(value);};});
  manager = new Backend({dataDir:path.join(base,'profile/data'),source:root,python:'unused',node:'unused',env});manager.loadRecord();
  await page.locator('#open-workflows').click();await page.locator('#open-event-sources').click();
  await page.locator('#new-event-source').click();await page.locator('#event-source-name').fill('Fictional local adapter');
  await page.locator('#event-source-form [type=submit]').click();await page.locator('#event-token-dialog').waitFor();
  const url = await page.locator('#event-webhook-url').inputValue(), token = await page.locator('#event-webhook-token').inputValue();
  const source = url.split('/').pop();
  assert.equal(await page.locator('#event-workspace').inputValue(),'agent-desk://'+manager.workspace);
  assert.equal(await page.locator('#event-webhook-socket').inputValue(),manager.socket);
  assert.equal(url,'http://app/api/event-bus/webhook/'+source);
  const example = await page.locator('#event-webhook-example').textContent();assert.ok(example.includes('--unix-socket'));
  await electron.evaluate(({app,BrowserWindow})=>{app.focus({steal:true});BrowserWindow.getAllWindows()[0].focus();});
  await page.locator('#event-example-copy').click();
  await page.waitForFunction(()=>document.querySelector('#toast')?.textContent==='curl example copied');
  assert.ok(await electron.evaluate((_,example)=>global.fixtureCopied===example,example),'Copy curl writes the example through native clipboard');
  for (const width of [1280,480]) {
    await electron.evaluate(({BrowserWindow},width)=>BrowserWindow.getAllWindows()[0].setSize(width,900),width);
    await page.waitForFunction(width=>innerWidth===width,width);
    assert.ok(await page.locator('#event-token-dialog').evaluate(d=>d.getBoundingClientRect().right<=innerWidth && d.scrollWidth<=d.clientWidth));
    await page.screenshot({path:path.join(process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir(),`agent-desk-webhook-${width}.png`)});
  }
  await page.locator('#event-token-dialog [data-close]').click();
  await page.waitForFunction(()=>document.getElementById('event-webhook-token').value==='');
  assert.equal(await page.locator('#event-webhook-example').textContent(),'');
  assert.equal(await page.locator('#event-webhook-token').inputValue(),'');
  await page.evaluate(id=>terminalRequest('/api/event-bus/toggle-source',{id,enabled:true}),source);
  function curl(value) {
    const output = execFileSync('/usr/bin/curl',['--silent','--show-error','--unix-socket',manager.socket,url,'-H','Authorization: Bearer '+value,'-H','Content-Type: application/json','--data','{"id":"fixture-event","payload":{"type":"message"}}','-w','\n%{http_code}'],{encoding:'utf8'}).trim().split('\n');
    return {status:Number(output.pop()),body:JSON.parse(output.join('\n'))};
  }
  assert.equal(curl('bad-token').status,403);assert.equal(curl(token).status,202);assert.equal(curl(token).body.duplicate,true);
  const row = page.locator(`[data-source-id="${source}"]`);
  await row.getByRole('button',{name:'New token',exact:true}).click();await page.locator('#event-confirm-action').click();
  await page.locator('#event-token-dialog').waitFor();
  const rotated = await page.locator('#event-webhook-token').inputValue();assert.notEqual(rotated,token);
  assert.equal(curl(token).status,403);assert.equal(curl(rotated).status,200);
  await page.locator('#event-token-dialog [data-close]').click();
  console.log('PASS: desktop webhook connection details, clipboard curl, real Unix-socket source authentication/rotation/duplicates, 1280px and 480px dialogs.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(manager)try{await manager.shutdown();}catch{}
  if(electron)try{await electron.evaluate(({app})=>app.exit(0));}catch{}
});
