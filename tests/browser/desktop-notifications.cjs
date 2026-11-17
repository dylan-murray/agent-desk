// Settings turns on desktop notifications for the moments the alert sounds mark. Covers asking the
// browser's permission from the switch, nothing while Agent Desk has your attention (this tab or
// another one), a notification per finished turn, question and worker report while it doesn't, the
// needs-you-only choice, quiet pop-ups when the tab already chimes, clicking one to open the session,
// a blocked page, previews and phone-width layout. The Notification API and focus are faked; a
// granted permission is kept for the tab, as a browser keeps it for the page.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const agentFor=([id,state])=>({id,name:'Fixture '+id.slice(-1).toUpperCase(),cwd:'/tmp',harness:'claude',status:state.status||'idle',
  source:'reported',task:'Interactive terminal',project:'fixture',events:[],question:state.question||null,exit_code:null,updated:Date.now()/1000,turn_ended:state.turn??null});
const fakes=permission=>`
  sessionStorage.setItem('agent-desk-panes-live','[]');
  if(!sessionStorage.getItem('notify-fixture-booted')){
    sessionStorage.setItem('notify-fixture-booted','1');
    for(const key of ['agent-desk-notifications','agent-desk-focused-tab','agent-desk-completion-sound','agent-desk-sound-events'])localStorage.removeItem(key);
  }
  window.__focused=true;Document.prototype.hasFocus=function(){return window.__focused;};
  window.__shown=[];window.__asked=0;
  class FakeNotification{
    constructor(title,options={}){this.title=title;Object.assign(this,options);this.closed=false;window.__shown.push(this);}
    close(){this.closed=true;}
    static async requestPermission(){window.__asked++;if(FakeNotification.permission==='default')sessionStorage.setItem('notify-fixture-permission',FakeNotification.permission='granted');return FakeNotification.permission;}
  }
  FakeNotification.permission=sessionStorage.getItem('notify-fixture-permission')||${JSON.stringify(permission)};
  window.Notification=FakeNotification;
  class FakeCtx{constructor(){this.state='running';this.currentTime=0;this.destination={};}async resume(){}
    createOscillator(){return {frequency:{value:0,exponentialRampToValueAtTime(){}},connect(){},stop(){},disconnect(){},set onended(v){},start(){}};}
    createGain(){return {gain:{setValueAtTime(){},linearRampToValueAtTime(){},exponentialRampToValueAtTime(){}},connect(){},disconnect(){}};}}
  window.AudioContext=FakeCtx;window.webkitAudioContext=FakeCtx;`;

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const sessions={'notify-fixture-a':{turn:1000},'notify-fixture-b':{}};
  const open=async(permission,viewport={width:1440,height:900})=>{
    const page=await browser.newPage({viewport});
    const errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.addInitScript(fakes(permission));
    await page.route('**/api/**',route=>{const p=new URL(route.request().url()).pathname;
      const canned={'/api/agents':{agents:Object.entries(sessions).map(agentFor)},'/api/feedback':{notes:[],deleted:[]},
        '/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},
        '/api/coordinators':{coordinators:[],messages:[]},'/api/coordinator-events':{tasks:[]},
        '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[],roots:[]}};
      return route.fulfill({json:canned[p]||{}});});
    await page.goto(APP);
    await page.waitForFunction(()=>document.getElementById('sync-status').classList.contains('connected'));
    return {page,errors};
  };
  const {page,errors}=await open('default');
  const shown=()=>page.evaluate(()=>window.__shown.splice(0).map(n=>({title:n.title,body:n.body,tag:n.tag,silent:n.silent})));
  const poll=async()=>{await page.evaluate(()=>refresh());await page.waitForTimeout(150);};
  const away=on=>page.evaluate(on=>{window.__focused=!on;window.dispatchEvent(new Event(on?'blur':'focus'));},on);
  const state=()=>page.evaluate(()=>({
    switchOn:document.getElementById('settings-notify-enabled').getAttribute('aria-checked'),
    choice:document.querySelector('input[name="settings-notify-events"]:checked')?.value,
    muted:document.getElementById('settings-notify-events').classList.contains('muted-choices'),
    detail:document.getElementById('settings-notify-detail').textContent,
    saved:JSON.parse(localStorage.getItem('agent-desk-notifications')||'null'),asked:window.__asked,
    overflow:document.documentElement.scrollWidth-innerWidth}));

  await page.click('#open-settings');await page.waitForTimeout(300);
  const initial=await state();
  check('Settings has a Notifications group, off by default, with needs-you-or-done chosen',()=>{
    assert.equal(initial.switchOn,'false');assert.equal(initial.choice,'needs-you-and-done');assert.equal(initial.muted,true);assert.equal(initial.saved,null);
    assert.match(initial.detail,/Nothing pops up while you're looking at Agent Desk/);
  });
  await page.screenshot({path:path.join(EVIDENCE,'notifications-settings-off-1440.png')});

  await page.click('#settings-notify-enabled');await page.waitForTimeout(150);
  const enabled=await state();
  check('the switch asks the browser once and turns notifications on',()=>{
    assert.equal(enabled.asked,1);assert.equal(enabled.switchOn,'true');assert.equal(enabled.muted,false);assert.deepEqual(enabled.saved,{on:true,events:'needs-you-and-done'});
  });
  await page.screenshot({path:path.join(EVIDENCE,'notifications-settings-on-1440.png')});

  // Fixture A finished a turn before the page loaded; B has none yet.
  await poll();await shown();
  sessions['notify-fixture-b'].turn=2000;await poll();
  const whileLooking=await shown();
  check('nothing pops up while Agent Desk has your attention',()=>assert.deepEqual(whileLooking,[]));

  await away(true);
  sessions['notify-fixture-b'].turn=3000;await poll();
  const finished=await shown();await poll();await poll();
  const repeats=await shown();
  check('a finished turn in the background notifies once, out loud while sounds are off',()=>{
    assert.deepEqual(finished,[{title:'Fixture B is done',body:'Finished its turn and is waiting at the prompt.',tag:'agent-desk-done-notify-fixture-b',silent:false}]);
    assert.deepEqual(repeats,[]);
  });

  sessions['notify-fixture-a']={turn:1000,status:'needs_input',question:'Allow fixture edit?\nYes / No'};await poll();
  const question=await shown();
  check('a session that starts needing you notifies with its question',()=>
    assert.deepEqual(question,[{title:'Fixture A needs you',body:'Allow fixture edit?',tag:'agent-desk-needs-you-notify-fixture-a',silent:false}]));

  await page.evaluate(()=>window.updateWorkerCompletions([{id:'notify-task-1',worker:'notify-fixture-b',created:1,result:null}]));
  await page.evaluate(()=>window.updateWorkerCompletions([{id:'notify-task-1',worker:'notify-fixture-b',created:1,outcome:'completed',result:'Fixture report ready\nDetails follow'}]));
  const report=await shown();
  check('a worker reporting its task complete notifies with the first line of its report',()=>
    assert.deepEqual(report,[{title:'Fixture B finished its task',body:'Fixture report ready',tag:'agent-desk-done-notify-fixture-b',silent:false}]));

  await page.evaluate(()=>localStorage.setItem('agent-desk-focused-tab',JSON.stringify({tab:'another-fixture-tab',at:Date.now()})));
  sessions['notify-fixture-a']={turn:1000};await poll();
  sessions['notify-fixture-b'].turn=4000;await poll();
  const otherTab=await shown();
  await page.evaluate(()=>localStorage.setItem('agent-desk-focused-tab',JSON.stringify({tab:'another-fixture-tab',at:Date.now()-120000})));
  sessions['notify-fixture-b'].turn=5000;await poll();
  const staleTab=await shown();
  check('another Agent Desk tab in front holds them back, and a stale claim from a closed tab does not',()=>{
    assert.deepEqual(otherTab,[]);assert.equal(staleTab.length,1);
  });

  await page.evaluate(()=>switchPage('settings'));
  await page.click('input[name="settings-notify-events"][value="needs-you"]');await page.waitForTimeout(150);
  sessions['notify-fixture-b'].turn=6000;await poll();
  const quietDone=await shown();
  await page.evaluate(()=>window.deskAlerts.setEnabled(true));
  sessions['notify-fixture-a']={turn:1000,status:'needs_input',question:'Another fixture question?'};await poll();
  const chimed=await shown();
  check('needs-you only skips finished turns, and a pop-up is silent when the tab already chimes',()=>{
    assert.deepEqual(quietDone,[]);assert.equal(chimed.length,1);assert.equal(chimed[0].silent,true);
  });

  await page.evaluate(()=>{window.__shown.length=0;});
  sessions['notify-fixture-a']={turn:1000};await poll();
  sessions['notify-fixture-a']={turn:1000,status:'needs_input',question:'Open me?'};await poll();
  const clicked=await page.evaluate(()=>{const note=window.__shown.at(-1);window.__focused=true;note.onclick();return {closed:note.closed,selected:selectedId,page:!document.getElementById('agents-page').classList.contains('hidden')};});
  check('clicking a notification closes it and opens that session',()=>{
    assert.equal(clicked.closed,true);assert.equal(clicked.selected,'notify-fixture-a');assert.equal(clicked.page,true);
  });

  await page.evaluate(()=>switchPage('settings'));await shown();
  await page.click('#settings-notify-events .settings-preview[data-preview="needs-you"]');
  await page.click('#settings-notify-events .settings-preview[data-preview="done"]');await page.waitForTimeout(150);
  const previews=await shown();
  check('previews show even while you are looking',()=>assert.deepEqual(previews.map(n=>n.tag),['agent-desk-needs-you-preview','agent-desk-done-preview']));

  await page.reload();await page.waitForFunction(()=>document.getElementById('sync-status').classList.contains('connected'));
  await page.evaluate(()=>switchPage('settings'));
  const reloaded=await state();
  check('choices survive a reload',()=>{assert.equal(reloaded.switchOn,'true');assert.equal(reloaded.choice,'needs-you');});

  const blocked=await open('denied');
  await blocked.page.evaluate(()=>switchPage('settings'));
  await blocked.page.click('#settings-notify-enabled');await blocked.page.waitForTimeout(150);
  const denied=await blocked.page.evaluate(()=>({on:document.getElementById('settings-notify-enabled').getAttribute('aria-checked'),detail:document.getElementById('settings-notify-detail').textContent}));
  await blocked.page.screenshot({path:path.join(EVIDENCE,'notifications-settings-blocked-1440.png')});
  check('a page the browser blocked stays off and says where to allow it',()=>{
    assert.equal(denied.on,'false');assert.match(denied.detail,/Blocked by the browser\. Allow notifications for this page in its site settings/);
  });
  await blocked.page.close();

  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(400);
  const phone=await state();
  const fits=await page.evaluate(()=>[...document.querySelectorAll('#settings-page .settings-option,#settings-page .settings-row')].every(el=>el.getBoundingClientRect().right<=innerWidth+.5));
  await page.locator('section[aria-labelledby="settings-notify-heading"]').screenshot({path:path.join(EVIDENCE,'notifications-settings-390.png')});
  check('phone width: no horizontal scroll and every row fits',()=>{assert.ok(phone.overflow<=0,'overflow '+phone.overflow);assert.ok(fits);});
  check('no page errors',()=>assert.deepEqual([...errors,...blocked.errors],[]));
 }finally{await browser.close();}
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: desktop notifications reach you outside Agent Desk');
})();
