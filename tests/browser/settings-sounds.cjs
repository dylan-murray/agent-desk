// The Settings page chooses which events sound: only sessions that need you, or those and
// sessions that are done. Covers the page and its header entry, sync with the header speaker,
// the done chime on a finished turn (once, never for state that predates the load), silence
// for finished turns in needs-you mode, previews while muted, and phone-width layout.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const DONE=[784,1175],ATTENTION=[880,587];
const agentFor=(id,turn_ended)=>({id,name:'Fixture '+id.slice(-1).toUpperCase(),cwd:'/tmp',harness:'claude',status:'idle',
  source:'reported',task:'Fixture task',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000,turn_ended});

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const turns={'settings-fixture-a':1000,'settings-fixture-b':null};
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{
    sessionStorage.setItem('agent-desk-panes-live','[]');
    if(!sessionStorage.getItem('settings-fixture-booted')){
      sessionStorage.setItem('settings-fixture-booted','1');
      try{localStorage.removeItem('agent-desk-completion-sound');localStorage.removeItem('agent-desk-sound-events');localStorage.removeItem('agent-desk-completion-seen');}catch{}
    }
    window.__tones=[];
    class FakeParam{constructor(){this.value=0}setValueAtTime(){}linearRampToValueAtTime(){}exponentialRampToValueAtTime(){}}
    class FakeCtx{
      constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
      async resume(){this.state='running';}
      createOscillator(){const frequency=new FakeParam();
        return {frequency,type:'',connect(){},stop(){},disconnect(){},set onended(v){},start(){window.__tones.push(Math.round(frequency.value));}};}
      createGain(){return {gain:new FakeParam(),connect(){},disconnect(){}};}
    }
    window.AudioContext=FakeCtx;window.webkitAudioContext=FakeCtx;
  });
  await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
    const canned={'/api/agents':{agents:Object.entries(turns).map(([id,t])=>agentFor(id,t))},'/api/feedback':{notes:[],deleted:[]},
      '/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},
      '/api/coordinators':{coordinators:[],messages:[]},'/api/coordinator-events':{tasks:[]},
      '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[],roots:[]}};
    return route.fulfill({json:canned[p]||{}});});
  await page.goto(APP);
  await page.waitForFunction(()=>document.getElementById('sync-status').classList.contains('connected'));
  const tones=()=>page.evaluate(()=>window.__tones.splice(0));
  const poll=async()=>{await page.evaluate(()=>refresh());await page.waitForTimeout(150);};
  const state=()=>page.evaluate(()=>({
    page:!document.getElementById('settings-page').classList.contains('hidden'),
    crumb:document.getElementById('breadcrumb').textContent,
    active:[...document.querySelectorAll('#header-nav .button.active')].map(b=>b.id),
    switchOn:document.getElementById('settings-sound-enabled').getAttribute('aria-checked'),
    header:document.getElementById('completion-sound').getAttribute('aria-pressed'),
    headerTitle:document.getElementById('completion-sound').title,
    choice:document.querySelector('input[name="settings-sound-events"]:checked')?.value,
    saved:[localStorage.getItem('agent-desk-completion-sound'),localStorage.getItem('agent-desk-sound-events')],
    overflow:document.documentElement.scrollWidth-innerWidth}));

  await page.click('#open-settings');await page.waitForTimeout(400);
  const opened=await state();
  check('the gear opens Settings as the active header destination',()=>{
    assert.equal(opened.page,true);assert.equal(opened.crumb,'Settings');assert.deepEqual(opened.active,['open-settings']);
  });
  check('defaults: sounds off, needs-you-or-done selected',()=>{
    assert.equal(opened.switchOn,'false');assert.equal(opened.header,'false');assert.equal(opened.choice,'needs-you-and-done');
  });
  await page.screenshot({path:path.join(EVIDENCE,'settings-sounds-off-1440.png')});

  await page.click('#settings-sound-enabled');await page.waitForTimeout(150);
  const enabled=await state(),enableTones=await tones();
  check('the Settings switch turns sounds on, in sync with the header speaker, and plays the chosen sound',()=>{
    assert.equal(enabled.switchOn,'true');assert.equal(enabled.header,'true');assert.equal(enabled.saved[0],'true');
    assert.deepEqual(enableTones,DONE);
  });
  await page.screenshot({path:path.join(EVIDENCE,'settings-sounds-on-1440.png')});

  // Fixture A already had a finished turn when the page loaded; B had none.
  await poll();
  const baseline=await tones();
  turns['settings-fixture-b']=2000;await poll();
  const firstFinish=await tones();
  await poll();await poll();
  const repeatPolls=await tones();
  check('a turn that ended before the page loaded stays silent',()=>assert.deepEqual(baseline,[]));
  check('a session finishing its turn plays the done chime once',()=>{assert.deepEqual(firstFinish,DONE);assert.deepEqual(repeatPolls,[]);});

  await page.click('input[name="settings-sound-events"][value="needs-you"]');await page.waitForTimeout(150);
  const needsYou=await state();
  turns['settings-fixture-a']=3000;await poll();
  const mutedFinish=await tones();
  check('needs-you mode is saved, reflected in the header title, and silences finished turns',()=>{
    assert.equal(needsYou.choice,'needs-you');assert.equal(needsYou.saved[1],'needs-you');
    assert.match(needsYou.headerTitle,/Sessions that need you\./);
    assert.deepEqual(mutedFinish,[]);
  });

  await page.click('#completion-sound');await page.waitForTimeout(150);
  const headerOff=await state();await tones();
  await page.click('.settings-preview[data-preview="attention"]');await page.click('.settings-preview[data-preview="completion"]');await page.waitForTimeout(150);
  const previews=await tones();
  check('the header speaker turns the Settings switch off and previews still play while muted',()=>{
    assert.equal(headerOff.switchOn,'false');assert.equal(headerOff.header,'false');
    assert.deepEqual(previews,[...ATTENTION,...DONE]);
  });

  await page.reload();await page.waitForFunction(()=>document.getElementById('sync-status').classList.contains('connected'));
  await page.evaluate(()=>switchPage('settings'));
  const reloaded=await state();
  check('choices survive a reload',()=>{assert.equal(reloaded.choice,'needs-you');assert.equal(reloaded.switchOn,'false');});

  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
  const phone=await state();
  const fits=await page.evaluate(()=>[...document.querySelectorAll('#settings-page .settings-option,#settings-page .settings-row')].every(el=>el.getBoundingClientRect().right<=innerWidth+.5));
  await page.screenshot({path:path.join(EVIDENCE,'settings-sounds-390.png'),fullPage:true});
  check('phone width: no horizontal scroll and every row fits',()=>{assert.ok(phone.overflow<=0,'overflow '+phone.overflow);assert.ok(fits);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: Settings chooses which session events play a sound');
})();
