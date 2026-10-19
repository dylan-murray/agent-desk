// The Focus glow setting: on by default at 100%, the brightness slider scales the glow around the
// focused pane and the selected session, off removes it but keeps the agent-colour border and row
// bar, the choice survives a reload, and the controls fit at phone width. Launches one fixture shell.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page;
 try{
  page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/vendor/addon-webgl.js',route=>route.abort());
  await page.goto(APP);await page.evaluate(()=>{try{localStorage.removeItem('agent-desk-focus-glow');}catch{}});await page.reload();
  await page.waitForFunction(()=>typeof terminalRequest==='function');
  const id=await page.evaluate(async()=>{const s=await terminalRequest('/api/terminals/launch',{cwd:'/tmp',name:'Glow fixture',desk:activeDesk().id,argv:['/bin/zsh','-f']});window.__glowFixture={...s,name:'Glow fixture',project:'fixture'};return s.id;});launched.push(id);
  const show=()=>page.evaluate(id=>{if(!agents.some(a=>a.id===id))agents.unshift(window.__glowFixture);openPaneIds=[id];selectedId=id;savePanes();render();},id);
  await show();await page.waitForTimeout(1500);await page.locator('.terminal-pane .xterm-screen').first().click();await page.waitForTimeout(400);
  const look=()=>page.evaluate(()=>{const pane=document.querySelector('.terminal-pane.focused'),row=document.querySelector('.session-row.selected');
   const alphas=s=>[...s.matchAll(/\/ ([\d.]+)\)/g)].map(m=>+m[1]);const p=getComputedStyle(pane),r=getComputedStyle(row);
   return {pane:alphas(p.boxShadow),row:alphas(r.boxShadow),border:p.borderTopColor,rowBar:/inset/.test(r.boxShadow)&&r.boxShadow,glow:document.documentElement.style.getPropertyValue('--glow')};});
  const settings=()=>page.evaluate(()=>({on:document.getElementById('settings-glow-enabled').getAttribute('aria-checked'),value:document.getElementById('settings-glow-strength').value,
   label:document.getElementById('settings-glow-value').textContent,disabled:document.getElementById('settings-glow-strength').disabled,saved:localStorage.getItem('agent-desk-focus-glow')}));

  const base=await look();
  check('the glow is on at 100% by default',()=>{assert.equal(base.glow,'1');assert.deepEqual(base.pane,[.3,.35]);assert.equal(base.row.at(-1),.6);});

  await page.click('#open-settings');await page.waitForTimeout(300);
  const fresh=await settings();
  check('Settings shows the glow switch on and brightness at 100%',()=>{assert.equal(fresh.on,'true');assert.equal(fresh.value,'100');assert.equal(fresh.label,'100%');assert.equal(fresh.disabled,false);});
  await page.locator('#settings-glow-strength').fill('200');await page.waitForTimeout(150);
  await page.click('#open-sessions');await show();await page.waitForTimeout(500);
  const bright=await look();
  check('200% doubles the pane glow and caps the row glow at full strength',()=>{assert.equal(bright.glow,'2');assert.deepEqual(bright.pane,[.6,.7]);assert.ok(!bright.row.length||bright.row.at(-1)===1,'row '+bright.row);});
  await page.screenshot({path:path.join(EVIDENCE,'settings-glow-200.png')});

  await page.click('#open-settings');await page.waitForTimeout(200);
  await page.locator('#settings-glow-strength').fill('25');await page.waitForTimeout(150);
  await page.click('#settings-glow-enabled');await page.waitForTimeout(150);
  const off=await settings();
  check('switching the glow off disables the slider and keeps its value',()=>{assert.equal(off.on,'false');assert.equal(off.disabled,true);assert.equal(off.value,'25');assert.deepEqual(JSON.parse(off.saved),{on:false,strength:25});});
  await page.screenshot({path:path.join(EVIDENCE,'settings-glow-off-settings.png')});
  await page.click('#open-sessions');await show();await page.waitForTimeout(500);
  const dark=await look();
  check('off removes the glow but keeps the agent-colour border and row bar',()=>{assert.equal(dark.glow,'0');assert.ok(dark.pane.every(a=>a===0),'pane '+dark.pane);assert.notEqual(dark.border,'rgb(48, 48, 53)');assert.ok(dark.rowBar,'row bar');});

  await page.reload();await page.waitForFunction(()=>typeof terminalRequest==='function');await page.evaluate(id=>{window.__glowFixture=agents.find(a=>a.id===id)||{id,name:'Glow fixture',cwd:'/tmp',harness:'shell',status:'running',project:'fixture',events:[]};},id);await page.waitForTimeout(1500);await show();await page.waitForTimeout(800);
  await page.locator('.terminal-pane .xterm-screen').first().click();await page.waitForTimeout(300);
  const kept=await look();await page.click('#open-settings');await page.waitForTimeout(200);const keptSettings=await settings();
  check('after a reload the glow is still off at 25%',()=>{assert.equal(kept.glow,'0');assert.equal(keptSettings.on,'false');assert.equal(keptSettings.value,'25');});
  await page.click('#settings-glow-enabled');await page.waitForTimeout(150);
  const back=await page.evaluate(()=>document.documentElement.style.getPropertyValue('--glow'));
  check('back on uses the saved 25%',()=>assert.equal(back,'0.25'));

  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  const narrow=await page.evaluate(()=>{const r=document.getElementById('settings-glow-strength').getBoundingClientRect();return {overflow:document.documentElement.scrollWidth-innerWidth,right:r.right,width:innerWidth};});
  await page.locator('#settings-glow-heading').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(EVIDENCE,'settings-glow-390.png')});
  check('the glow controls fit at 390px',()=>{assert.equal(narrow.overflow,0);assert.ok(narrow.right<=narrow.width,'slider right '+narrow.right);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{
  for(const id of launched)await page?.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
  try{await page?.evaluate(()=>localStorage.removeItem('agent-desk-focus-glow'));}catch{}
  await browser.close();
 }
 if(failures.length){console.log('FAIL: '+failures.join('; '));process.exit(1);}
 console.log('PASS: glow on by default, brightness scales it, off keeps the border, saved across reload, fits at 390px');
})().catch(error=>{console.error(error);process.exit(1);});
