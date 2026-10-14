// Claude and Codex start with one login each. More are added by name and config folder, and show up in every picker.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],launches=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));
  const row=(id,harness,name,config_dir)=>({id,harness,name,label:(harness==='codex'?'Codex':'Claude')+(name?' · '+name:''),config_dir,default:!config_dir,exists:!config_dir});
  let accounts=[row('codex','codex','',''),row('claude','claude','','')];
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname,body=route.request().postDataJSON();
   if(path==='/api/accounts/list')return route.fulfill({json:{accounts}});
   if(path==='/api/accounts/save'){writes.push([path,body]);
    if(!body.config_dir.startsWith('~/')&&!body.config_dir.startsWith('/'))return route.fulfill({status:400,json:{error:'Enter the account’s config folder as an absolute path or one starting with ~/'}});
    const saved=row(body.harness+'-'+body.name.toLowerCase(),body.harness,body.name,body.config_dir);accounts=[...accounts.filter(a=>a.harness==='codex'),...accounts.filter(a=>a.harness==='claude'),saved];
    return route.fulfill({json:{accounts,saved}});}
   if(path==='/api/accounts/delete'){writes.push([path,body]);accounts=accounts.filter(a=>a.id!==body.id);return route.fulfill({json:{accounts}});}
   if(path==='/api/terminals/launch'){launches.push(body);return route.fulfill({json:{id:'t1',terminal_id:'t1',name:body.name,cwd:'/tmp',harness:'claude',status:'idle',source:'terminal',exit_code:null,task:'Interactive terminal',events:[],updated:1}});}
   const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live','[]'));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>typeof openTerminalLauncher==='function');
  await page.evaluate(()=>openTerminalLauncher('/tmp'));
  const options=()=>page.locator('#terminal-harness option').evaluateAll(nodes=>nodes.map(node=>node.value+'='+node.textContent));
  const before=await options();
  check('a new install offers one login per agent',()=>assert.deepEqual(before,['shell=Shell','codex=Codex','claude=Claude','grok=Grok','opencode=OpenCode','pi=Pi','custom=Custom executable']));
  await page.locator('#open-accounts').click();const dialog=page.locator('#accounts-dialog');await dialog.waitFor({state:'visible'});
  await page.locator('#accounts-list li').nth(1).waitFor();
  const listed=await page.locator('#accounts-list li').allInnerTexts(),removable=await page.locator('#accounts-list button').count();
  check('the default logins are listed and cannot be removed',()=>{assert.deepEqual(listed.map(text=>text.replace(/\s+/g,' ')),['Codex Default login','Claude Default login']);assert.equal(removable,0);});
  await page.selectOption('#account-harness','claude');await page.fill('#account-name','Personal');await page.fill('#account-folder','claude-personal');
  const hint=await page.locator('#account-help').innerText();
  check('the form says how that login is used and how to sign in',()=>assert.match(hint,/CLAUDE_CONFIG_DIR=claude-personal claude$/));
  await page.locator('#account-save').click();await page.locator('#accounts-status.error').waitFor();
  const refused=await page.locator('#accounts-status').innerText();
  check('a folder that is not a path is refused with the reason',()=>assert.match(refused,/absolute path or one starting with ~\//));
  await page.fill('#account-folder','~/.claude-personal');await page.locator('#account-save').click();
  await page.locator('#accounts-list li').nth(2).waitFor();
  const added=await page.locator('#accounts-list li').nth(2).innerText(),note=await page.locator('#accounts-status').innerText();
  check('the added login is listed with its folder and a note that it is not signed in yet',()=>{assert.match(added.replace(/\s+/g,' '),/^Claude · Personal ~\/\.claude-personal Remove$/);assert.match(note,/Added Claude · Personal\..*does not exist yet/);});
  const phone=await (async()=>{await page.setViewportSize({width:390,height:844});const fits=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.getElementById('accounts-dialog').getBoundingClientRect().right<=innerWidth);await page.setViewportSize({width:1500,height:900});return fits;})();
  check('the dialog fits a phone',()=>assert.equal(phone,true));
  await page.locator('#accounts-close').click();
  const after=await options();
  check('the launcher offers it straight away, beside its agent',()=>assert.deepEqual(after,['shell=Shell','codex=Codex','claude=Claude','claude-personal=Claude · Personal','grok=Grok','opencode=OpenCode','pi=Pi','custom=Custom executable']));
  const special=await page.locator('#special-choice option').evaluateAll(nodes=>nodes.map(node=>node.value));
  check('automations offer it too',()=>assert.deepEqual(special,['codex','claude','claude-personal','custom']));
  await page.selectOption('#terminal-harness','claude-personal');await page.locator('#launch-terminal-form button[type=submit]').click();
  await page.waitForFunction(()=>!document.getElementById('launch-terminal-dialog').open);
  check('launching it names the account, not a shell alias the user must define',()=>{assert.equal(launches[0].launch_profile,'claude-personal');assert.deepEqual(launches[0].argv.slice(0,4),['/bin/zsh','-lic','claude-personal "$@"','agent-desk']);assert.equal(launches[0].name,'Claude · Personal');});
  await page.evaluate(()=>openTerminalLauncher('/tmp'));await page.selectOption('#terminal-harness','claude-personal');
  await page.locator('#open-accounts').click();await page.locator('#accounts-list button').click();
  await page.waitForFunction(()=>document.querySelectorAll('#accounts-list li').length===2);
  await page.locator('#accounts-close').click();
  const removed=await options(),selected=await page.locator('#terminal-harness').inputValue();
  check('removing it takes it out of the launcher',()=>{assert.deepEqual(removed,before);assert.notEqual(selected,'claude-personal');assert.deepEqual(writes.at(-1),['/api/accounts/delete',{id:'claude-personal'}]);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
