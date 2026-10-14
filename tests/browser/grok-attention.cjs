const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');
const assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[],inputs=[];
  page.on('pageerror',e=>errors.push(e.message));
  const menu='\x1b[2J\x1b[HDo you trust the contents of this directory?\r\n/tmp/fixture\r\nGrok Build may run scripts here.\r\nYes, proceed                 y\r\nNo, quit                     n\r\n';
  let output=Buffer.from(menu);
  const agent={id:'attention-fixture',terminal_id:'attention-fixture',name:'Approval fixture',cwd:'/tmp',harness:'grok',status:'unknown',source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000};
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live','[]'));
  await page.route('**/api/feedback',r=>r.fulfill({json:{notes:[],deleted:[]}}));
  await page.route('**/api/special-agents',r=>r.fulfill({json:{roles:[],inbox:[],runs:[]}}));
  await page.route('**/api/agents',r=>r.fulfill({json:{agents:[agent]}}));
  await page.route('**/api/terminal-auth',r=>r.fulfill({json:{token:'fixture',cwd:'/tmp'}}));
  await page.route('**/api/terminals/**',r=>{
   const url=new URL(r.request().url());
   if(url.pathname.endsWith('/output')){
    const offset=Math.min(Number(url.searchParams.get('cursor')),output.length);
    return r.fulfill({json:{data:output.subarray(offset).toString('base64'),cursor:output.length,truncated:false,exit_code:null}});
   }
   if(url.pathname.endsWith('/input'))inputs.push(r.request().postData());
   return r.fulfill({json:{ok:true}});
  });
  await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');
  if(process.env.CAPTURE_BEFORE){await page.waitForTimeout(2500);await page.screenshot({path:evidence('grok-attention-before.png')});return;}
  await page.waitForFunction(()=>document.title.startsWith('(1)'));
  await page.screenshot({path:evidence('grok-attention-after.png')});
  assert.equal(await page.locator('.terminal-pane').count(),0);
  assert.match(await page.locator('#session-attention').innerText(),/Approval fixture/);
  await page.locator('#open-skills').click();
  assert.equal(await page.locator('#session-attention').isVisible(),true);
  await page.locator('#session-attention .button').click();
  await page.waitForFunction(()=>paneViews.get('attention-fixture')?.restoring===false);
  await page.evaluate(()=>monitorTerminals());
  assert.match(await page.locator('.pane-state').innerText(),/Needs you/);
  // Redraw removes the prompt; stale scrollback must not keep it flagged.
  output=Buffer.concat([output,Buffer.from('\x1b[2J\x1b[HWorking on the task…')]);
  await page.waitForFunction(()=>document.getElementById('session-attention').hidden);
  assert.equal(await page.title(),'Agent Desk');
  await page.evaluate(()=>closePane('attention-fixture'));
  output=Buffer.concat([output,Buffer.from(menu)]);
  await page.waitForFunction(()=>document.title.startsWith('(1)'));
  await page.reload();
  await page.waitForFunction(()=>document.title.startsWith('(1)'));
  // Detector rejects prose and idle questions, and understands y/n prompts.
  const results=await page.evaluate(async()=>{
   const term=new Terminal({cols:100,rows:24});
   const check=async text=>{term.reset();await new Promise(r=>term.write(text,r));return !!terminalApprovalPrompt(term)};
   const cases=[];
   cases.push(await check('What would you like to build?'));
   cases.push(await check('Do you want to allow this?\r\n1. Yes\r\n2. No'));
   cases.push(await check('Continue? [y/n]'));
   cases.push(await check('Would you like to run the following command?\r\n› 1. Yes, proceed (y)\r\n  2. No, and tell Codex what to do differently (esc)'));
   cases.push(await check('Do you want to allow this?\r\n❯ 1. Yes\r\n2. No\r\n'+'done\r\n'.repeat(8)));
   const trust='Do you trust the contents of this directory?\r\n/tmp/project\r\nYes, proceed   y\r\nNo, quit   n';
   cases.push(await check(trust));
   cases.push(await check(trust+'\r\nWorking now'));
   cases.push(await check('Do you trust the contents of this directory?'));
   term.dispose();return cases;
  });
  assert.deepEqual(results,[false,false,true,true,false,true,false,false]);
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:evidence('grok-attention-mobile.png')});
  assert.deepEqual(inputs,[]);assert.deepEqual(errors,[]);
  console.log('PASS: closed/open pane approval, Skills banner, jump to session, redraw clearing, reload, prompt variants, no injected input');
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exit(1)});
