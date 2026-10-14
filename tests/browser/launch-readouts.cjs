// Readouts are an opt-in option in the new terminal dialog, per terminal, never always on.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],launches=[],agents=[];await withAccounts(page);
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   if(path==='/api/terminals/launch'){const body=route.request().postDataJSON();launches.push(body);
    const session={id:'t'+launches.length,terminal_id:'t'+launches.length,name:body.name,cwd:'/tmp',harness:'claude',status:'idle',source:'terminal',exit_code:null,task:'Interactive terminal',events:[],updated:1};
    agents.push(session);return route.fulfill({json:session});}
   const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live','[]'));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof openTerminalLauncher==='function');
  await page.evaluate(()=>openTerminalLauncher('/tmp'));
  const shown={};
  for(const key of ['shell','claude','claude-personal','codex','codex-personal','grok','custom']){await page.selectOption('#terminal-harness',key);shown[key]=!(await page.locator('#terminal-readouts-field').isHidden());}
  check('Readouts is offered for Claude and Codex only',()=>assert.deepEqual(shown,{shell:false,claude:true,'claude-personal':true,codex:true,'codex-personal':true,grok:false,custom:false}));
  await page.selectOption('#terminal-harness','claude');
  const off=!(await page.isChecked('#terminal-readouts'));
  const box=await page.locator('#terminal-readouts').boundingBox();
  check('it is off by default and looks like the other checkbox',()=>{assert.equal(off,true);assert.ok(box.width<=16&&box.height<=16,`checkbox is ${box.width}x${box.height}`);});
  await page.check('#terminal-readouts');await page.locator('#launch-terminal-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.getElementById('launch-terminal-dialog').open);
  await page.evaluate(()=>openTerminalLauncher('/tmp'));await page.selectOption('#terminal-harness','claude');
  const reset=!(await page.isChecked('#terminal-readouts'));
  await page.locator('#launch-terminal-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.getElementById('launch-terminal-dialog').open);
  await page.evaluate(()=>openTerminalLauncher('/tmp'));await page.selectOption('#terminal-harness','claude');await page.check('#terminal-readouts');await page.selectOption('#terminal-harness','shell');
  await page.locator('#launch-terminal-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.getElementById('launch-terminal-dialog').open);
  check('only the terminal it was ticked for asks for readouts, and the box never carries over',()=>{
   assert.equal(reset,true);assert.deepEqual(launches.map(body=>body.readouts??false),[true,false,false]);
  });
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>openTerminalLauncher('/tmp'));await page.selectOption('#terminal-harness','codex');
  const width=await page.evaluate(()=>document.documentElement.scrollWidth);
  check('the dialog fits a phone',()=>assert.equal(width,390));
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: Readouts is a per-terminal launch option for Claude and Codex, off by default, never carried over');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
