// Settings › Desks › Terminals per desk is kept by the server: the slider changes it, the pane
// counter follows it in this tab and, with the next agents poll, in another, and a phone fits it.
// Runs against an isolated server and puts the limit back to 32 when it finishes.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const evidence=require('./evidence.cjs');
const APP=process.env.AGENT_DESK_TEST_URL;

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 const served=async page=>page.evaluate(async()=>Number((await (await fetch('/config.js')).text()).match(/"terminal_limit": (\d+)/)[1]));
 const counter=page=>page.textContent('#pane-count');
 let page;
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900}});
  page=await context.newPage();const other=await context.newPage();
  const errors=[];for(const p of [page,other])p.on('pageerror',error=>errors.push(error.message));
  await page.goto(APP);await other.goto(APP);
  await page.evaluate(()=>terminalRequest('/api/desks/limit',{limit:32}));
  await page.reload();await other.reload();await page.waitForTimeout(800);

  await page.click('#open-settings');await page.waitForTimeout(300);
  const start=await page.evaluate(()=>({value:document.getElementById('settings-terminal-limit').value,shown:document.getElementById('settings-terminal-limit-value').textContent,
    min:document.getElementById('settings-terminal-limit').min,max:document.getElementById('settings-terminal-limit').max}));
  check('Settings shows Terminals per desk at 32, from 16 to 64',()=>assert.deepEqual(start,{value:'32',shown:'32',min:'16',max:'64'}));

  await page.focus('#settings-terminal-limit');await page.keyboard.press('End');await page.waitForTimeout(600);
  await page.screenshot({path:evidence('settings-terminal-limit-1440.png')});
  const raised={shown:await page.textContent('#settings-terminal-limit-value'),server:await served(page),limit:await page.evaluate(()=>PANE_LIMIT)};
  check('moving the slider to the end saves 64 on the server',()=>assert.deepEqual(raised,{shown:'64',server:64,limit:64}));
  await page.evaluate(()=>switchPage('agents'));
  const here=await counter(page);
  check('the pane counter reads out of 64 in this tab',()=>assert.match(here,/ \/ 64 open$/));
  await other.waitForFunction(()=>/ \/ 64 open$/.test(document.getElementById('pane-count').textContent),null,{timeout:12000}).catch(()=>{});
  const there=await counter(other);
  check('...and in another tab after its next poll',()=>assert.match(there,/ \/ 64 open$/));

  await page.evaluate(()=>switchPage('settings'));await page.focus('#settings-terminal-limit');await page.keyboard.press('Home');await page.waitForTimeout(600);
  const lowered={shown:await page.textContent('#settings-terminal-limit-value'),server:await served(page)};
  check('Home lowers it to 16',()=>assert.deepEqual(lowered,{shown:'16',server:16}));

  const agent=await page.evaluate(async()=>{const r=await fetch('/api/desks/limit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({limit:64})});return r.status;});
  check('a request without the desk page token cannot change it',()=>assert.equal(agent,403));

  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
  const narrow=await page.evaluate(()=>{const box=document.getElementById('settings-terminal-limit').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth-innerWidth,inside:box.left>=0&&box.right<=innerWidth};});
  await page.locator('#settings-desks-heading').scrollIntoViewIfNeeded();
  await page.screenshot({path:evidence('settings-terminal-limit-390.png')});
  check('on a phone the slider fits without sideways scroll',()=>{assert.equal(narrow.overflow,0);assert.ok(narrow.inside);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{
  if(page)await page.evaluate(()=>terminalRequest('/api/desks/limit',{limit:32})).catch(()=>{});
  await browser.close();
 }
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: Terminals per desk is a server setting shared by every tab');
})();
