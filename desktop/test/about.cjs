'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {execFileSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {DevelopmentAppPlugin} = require('../scripts/dev-app.cjs');
const {buildInfo} = require('../scripts/build-info.cjs');
const {aboutOptions} = require('../src/about.cjs');
const root=path.resolve(__dirname,'../..'),fixture=fs.mkdtempSync('/private/tmp/ad-about-ui-');
let electron;
(async()=>{
  const include=path.resolve(fs.realpathSync(process.execPath),'../../include/node');
  const addon=path.join(fixture,'about.node');
  execFileSync('/usr/bin/clang',['-fobjc-arc','-bundle','-undefined','dynamic_lookup','-framework','AppKit','-I',include,path.join(__dirname,'native-about.m'),'-o',addon],{stdio:'pipe'});
  const executable=await new DevelopmentAppPlugin().startLogic();
  electron=await _electron.launch({executablePath:executable,args:[path.join(root,'desktop')],env:{...process.env,AGENT_DESK_DESKTOP_TEST:'1',AGENT_DESK_PROFILE_DIR:path.join(fixture,'profile'),AGENT_DESK_SOCKET_ROOT:path.join(fixture,'s'),AGENT_DESK_TEST_DELAY:'60000'}});
  const page=await electron.firstWindow();await page.locator('#status').waitFor();
  const info=buildInfo(root);
  const expected=aboutOptions(info);
  await electron.evaluate(({app,Menu},addon)=>{
    const mod={exports:{}};process.dlopen(mod,addon);global.aboutFixture=mod.exports;
    if(!Menu.getApplicationMenu().items[0].submenu.items.some(item=>item.role==='about')) throw Error('Native About menu is missing');
    app.focus({steal:true});app.showAboutPanel();
  },addon);
  await new Promise(resolve=>setTimeout(resolve,300));
  const output=path.join(process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir(),'agent-desk-native-about.png');
  let text='';
  for(let attempt=0;attempt<20;attempt++) {
    text=await electron.evaluate((_,args)=>global.aboutFixture.inspect(args.expected,args.output),{expected:expected.copyright,output});
    if(text.includes(expected.copyright))break;
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(text.split('\n').some(line=>line.endsWith('Version '+expected.applicationVersion)),text);
  assert.ok(text.split('\n').includes(expected.copyright),text);
  const diagnostic=JSON.parse(fs.readFileSync(path.join(fixture,'profile/logs/build-info.json'),'utf8'));
  assert.equal(diagnostic.version,info.version);
  assert.equal(diagnostic.commit,info.commit);
  assert.equal(diagnostic.dirty,info.dirty);
  assert.ok(diagnostic.packagedAt);
  assert.ok(fs.existsSync(output),'Native panel screenshot was captured');
  console.log('PASS: native About displays Version '+expected.applicationVersion+' and '+expected.copyright);
  console.log('Native panel screenshot:',output);
  await electron.evaluate(()=>global.aboutFixture.close());
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  if(electron)try{await electron.evaluate(({app})=>app.exit(0));}catch{}
});
