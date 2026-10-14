// A session that needs you plays an alert sound and shows a clear badge, not just a colored dot.
// Covers the reserved badge slot (no layout shift when it appears or clears) and the
// alert tone: once per transition, coalesced, silent for state that predates the load.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const MENU='\x1b[2J\x1b[HDo you want to run the following command?\r\n  rm -rf build\r\n> 1. Yes\r\n  2. No\r\n';
const QUIET='\x1b[2J\x1b[HWorking on the task...\r\n';
const IDS=['alert-fixture-a','alert-fixture-b','alert-fixture-c'];
const agentFor=id=>({id,terminal_id:id,name:'Fixture '+id.slice(-1).toUpperCase(),cwd:'/tmp',harness:'codex',
  status:'unknown',source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  // Each fixture terminal serves its own byte stream; flipping a stream to MENU is the
  // real transition the app's own terminal observer has to notice on its own.
  const streams=new Map(IDS.map(id=>[id,Buffer.from(QUIET)]));
  const broken=new Set();
  // Output only ever grows, exactly as a real PTY's byte log does; replacing a stream
  // would leave the app's cursor pointing into the middle of the new bytes.
  const append=(id,text)=>streams.set(id,Buffer.concat([streams.get(id),Buffer.from(text)]));
  async function open(page,sound){
   await page.addInitScript(enabled=>{
     sessionStorage.setItem('agent-desk-panes-live','[]');
     try{localStorage.setItem('agent-desk-completion-sound',String(enabled));localStorage.removeItem('agent-desk-completion-seen');}catch{}
     window.__tones=[];window.__resumes=0;
     class FakeParam{constructor(){this.value=0}setValueAtTime(){}linearRampToValueAtTime(){}exponentialRampToValueAtTime(){}}
     class FakeCtx{
       constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
       async resume(){window.__resumes++;this.state='running';}
       createOscillator(){const frequency=new FakeParam();
         return {frequency,type:'',connect(){},stop(){},disconnect(){},set onended(v){},start(){window.__tones.push(Math.round(frequency.value));}};}
       createGain(){return {gain:new FakeParam(),connect(){},disconnect(){}};}
     }
     window.AudioContext=FakeCtx;window.webkitAudioContext=FakeCtx;
   },sound);
   await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
     const canned={'/api/agents':{agents:IDS.map(agentFor)},'/api/feedback':{notes:[],deleted:[]},
       '/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
       '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},
       '/api/coordinators':{coordinators:[],messages:[]},'/api/coordinator-events':{tasks:[]},
       '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[],roots:[]}};
     return route.fulfill({json:canned[path]||{}});});
   // Registered last on purpose: Playwright matches route handlers newest-first, so the
   // terminal streams must be added after the catch-all or the catch-all swallows them.
   await page.route('**/api/terminals/**',route=>{
     const url=new URL(route.request().url());
     if(!url.pathname.endsWith('/output'))return route.fulfill({json:{ok:true}});
     const id=url.searchParams.get('id');
     if(broken.has(id))return route.abort();
     const data=streams.get(id)||Buffer.alloc(0);
     const offset=Math.min(Number(url.searchParams.get('cursor')),data.length);
     return route.fulfill({json:{data:data.subarray(offset).toString('base64'),cursor:data.length,truncated:false,exit_code:null}});
   });
  }
  const tones=page=>page.evaluate(()=>window.__tones.slice());
  const badgeState=(page,id)=>page.evaluate(value=>document.querySelector(`[data-agent-id="${value}"] .needs-reply`)?.dataset.attention,id);
  const waitBadge=(page,id,state)=>page.waitForFunction(
    ([value,want])=>document.querySelector(`[data-agent-id="${value}"] .needs-reply`)?.dataset.attention===want,[id,state],{timeout:20000});
  const geometry=page=>page.evaluate(ids=>ids.map(id=>{
    const row=document.querySelector(`[data-agent-id="${id}"]`);if(!row)return null;
    const badge=row.querySelector('.needs-reply'),text=row.querySelector('.session-text');
    const rowBox=row.getBoundingClientRect(),textBox=text.getBoundingClientRect();
    return {id,rowH:+rowBox.height.toFixed(2),rowTop:+rowBox.top.toFixed(2),
      textW:+textBox.width.toFixed(2),textRight:+textBox.right.toFixed(2),
      attention:badge?.dataset.attention,visibility:badge&&getComputedStyle(badge).visibility,
      glyph:badge?badge.querySelectorAll('svg path').length:0,reserved:badge&&getComputedStyle(text).paddingRight};
  }),IDS);

  // ---- 1. Prompt-free start: the slot is reserved and nothing is audible ----
  let page=await browser.newPage({viewport:{width:1920,height:958}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await open(page,true);
  await page.goto(APP);
  await page.waitForFunction(ids=>ids.every(id=>document.querySelector(`[data-agent-id="${id}"] .needs-reply`)),IDS);
  await page.waitForTimeout(4500);
  const quiet=await geometry(page);
  check('every row reserves the badge slot while nothing needs you',()=>{
    assert.equal(quiet.filter(Boolean).length,3,'all three fixtures must be listed');
    for(const row of quiet){
      assert.equal(row.attention,'false',row.id+' must not claim attention');
      assert.equal(row.visibility,'hidden',row.id+' badge must be hidden, not removed');
      assert.equal(row.glyph,3,row.id+' must carry the three-path inline svg glyph');
      assert.equal(row.reserved,'24px',row.id+' must reserve 24px for the badge');
    }
  });
  check('a prompt-free start is silent',()=>assert.deepEqual(quiet.map(r=>r.attention),['false','false','false']));
  const startTones=await tones(page);
  check('no tone plays before any transition',()=>assert.deepEqual(startTones,[]));

  // ---- 2. One session transitions into needs_input ----
  append(IDS[0],MENU);
  await waitBadge(page,IDS[0],'true');
  await page.waitForFunction(()=>window.__tones.length>0,null,{timeout:10000});
  await page.waitForTimeout(500);
  const active=await geometry(page),firstTones=await tones(page);
  check('the transition sounds one falling two-tone alert',()=>
    assert.deepEqual(firstTones,[880,587],'A5 then D5, the opposite contour to the rising completion chime'));
  check('the visible badge changes no geometry at all',()=>{
    for(let i=0;i<3;i++){
      assert.equal(active[i].rowH,quiet[i].rowH,IDS[i]+' row height changed');
      assert.equal(active[i].rowTop,quiet[i].rowTop,IDS[i]+' row moved vertically');
      assert.equal(active[i].textW,quiet[i].textW,IDS[i]+' text column width changed');
      assert.equal(active[i].textRight,quiet[i].textRight,IDS[i]+' text column moved');
    }
    assert.equal(active[0].attention,'true');assert.equal(active[0].visibility,'visible');
    assert.equal(active[1].attention,'false');assert.equal(active[2].attention,'false');
  });
  const label=await page.getAttribute(`[data-agent-id="${IDS[0]}"] .needs-reply`,'aria-label');
  const title=await page.getAttribute(`[data-agent-id="${IDS[0]}"] .needs-reply`,'title');
  const resumes=await page.evaluate(()=>window.__resumes);
  check('the badge announces itself and carries the question',()=>{
    assert.equal(label,'Needs you');
    assert.match(title,/run the following command/);
  });
  check('a suspended audio context is resumed before the tone',()=>assert.ok(resumes>0,'resume() was never called'));

  // ---- 3. Unchanged state on later polls stays silent ----
  await page.evaluate(()=>monitorTerminals());
  await page.waitForTimeout(4500);
  const polled=await tones(page);
  check('repeated polls of unchanged state stay silent',()=>assert.deepEqual(polled,[880,587]));

  // ---- 4. Clearing is silent; two sessions arriving together coalesce to one sound ----
  append(IDS[0],QUIET);
  await waitBadge(page,IDS[0],'false');
  const cleared=await tones(page);
  check('clearing an attention state is silent',()=>assert.deepEqual(cleared,[880,587]));
  append(IDS[1],MENU);
  append(IDS[2],MENU);
  await waitBadge(page,IDS[1],'true');
  await waitBadge(page,IDS[2],'true');
  await page.waitForTimeout(3500);
  const coalesced=await tones(page);
  check('two sessions arriving together make one sound, not two',()=>
    assert.deepEqual(coalesced,[880,587,880,587],'expected exactly one further two-tone alert'));

  // ---- 5. Losing and regaining the connection must not re-alert ----
  broken.add(IDS[1]);broken.add(IDS[2]);
  await waitBadge(page,IDS[1],'false');
  broken.delete(IDS[1]);broken.delete(IDS[2]);
  await waitBadge(page,IDS[1],'true');
  await page.waitForTimeout(3500);
  const reconnected=await tones(page);
  check('a reconnect does not replay the alert for state it already reported',()=>
    assert.deepEqual(reconnected,[880,587,880,587]));

  // ---- 6. A reload with prompts already on screen is silent ----
  await page.reload();
  await waitBadge(page,IDS[1],'true');
  await page.waitForTimeout(5000);
  const afterReload=await tones(page),reloadBadge=await badgeState(page,IDS[2]);
  check('state that predates the page load is recorded silently',()=>
    assert.deepEqual(afterReload,[],'a reload must not sound the alarm for stale state'));
  check('the pre-existing state still shows its badge after reload',()=>assert.equal(reloadBadge,'true'));
  check('no page errors',()=>assert.deepEqual(errors,[]));
  await page.close();

  // ---- 7. Muted: the same transition shows the badge and makes no sound ----
  for(const id of IDS)streams.set(id,Buffer.from(QUIET));
  page=await browser.newPage({viewport:{width:1920,height:958}});
  await open(page,false);
  await page.goto(APP);
  await page.waitForFunction(ids=>ids.every(id=>document.querySelector(`[data-agent-id="${id}"] .needs-reply`)),IDS);
  await page.waitForTimeout(4500);
  append(IDS[0],MENU);
  await waitBadge(page,IDS[0],'true');
  await page.waitForTimeout(3500);
  const mutedTones=await tones(page),pressed=await page.getAttribute('#completion-sound','aria-pressed');
  const mutedBadge=await badgeState(page,IDS[0]);
  check('the shared header mute preference gates the attention alert',()=>{
    assert.deepEqual(mutedTones,[],'muted must produce no tone');
    assert.equal(pressed,'false','the header toggle reflects the same preference');
  });
  check('muting keeps the visual badge',()=>assert.equal(mutedBadge,'true'));
  await page.close();

  if(failures.length){console.error('\nFAILED: '+failures.join(' | '));process.exit(1);}
  console.log('\nPASS: reserved badge slot, one alert per transition, coalesced, silent on stale state, reconnect and mute');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
