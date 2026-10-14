// Switching pages must not reorder the header or hide the connection light.
// Every header control must sit on the same pixel on every page, at a 1920x958 desktop and
// at the narrow layouts, and the connection status must survive every page.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=['open-sessions','open-special-agents','open-inbox','open-workflows','open-skills','app-fullscreen','completion-sound','open-settings','mode-title'];
const PAGES=['agents','special-agents','inbox','workflows','skills','settings'];
const agent=id=>({id,terminal_id:id,name:'Header fixture '+id.slice(-1),cwd:'/tmp',harness:'codex',status:'unknown',
  source:'terminal',task:'Interactive terminal',project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000});
const geometry=ids=>({barH:+document.querySelector('header.topbar').getBoundingClientRect().height.toFixed(1),
  barX:+document.querySelector('header.topbar').getBoundingClientRect().x.toFixed(1),
  barY:+document.querySelector('header.topbar').getBoundingClientRect().y.toFixed(1),
  actions:+document.querySelector('.top-actions').getBoundingClientRect().width.toFixed(1),
  connected:document.getElementById('sync-status').classList.contains('connected'),
  active:[...document.querySelectorAll('.top-actions .button.active')].map(el=>el.id),
  thumb:(()=>{const thumb=document.querySelector('.header-nav-thumb'),on=document.querySelector('#header-nav .button.active');
    if(!thumb)return null;const a=thumb.getBoundingClientRect();
    return {hidden:thumb.hidden,off:on?Math.round(Math.abs(a.left-on.getBoundingClientRect().left)+Math.abs(a.top-on.getBoundingClientRect().top)+Math.abs(a.width-on.getBoundingClientRect().width)+Math.abs(a.height-on.getBoundingClientRect().height)):null};})(),
  items:Object.fromEntries(ids.map(id=>{const el=document.getElementById(id),r=el.getBoundingClientRect(),style=getComputedStyle(el);
    return [id,{x:+r.x.toFixed(1),y:+r.y.toFixed(1),width:+r.width.toFixed(1),display:style.display,visibility:style.visibility}];}))});
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1920,height:958},deviceScaleFactor:1});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/agents',route=>route.fulfill({status:200,contentType:'application/json',
    body:JSON.stringify({agents:['header-fixture-a','header-fixture-b'].map(agent),demo:false})}));
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live','[]'));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>document.getElementById('sync-status').classList.contains('connected'));
  const visit=async name=>{await page.evaluate(n=>switchPage(n),name);await page.waitForTimeout(250);
    return page.evaluate(geometry,IDS);};
  const measureAll=async()=>{const out={};for(const name of PAGES)out[name]=await visit(name);return out;};
  // Before any navigation: the app boots on Agents without calling switchPage, so the
  // Sessions chip has to ship active rather than wait for the first click.
  const booted=await page.evaluate(()=>[...document.querySelectorAll('.top-actions .button.active')].map(el=>el.id));
  const wide=await measureAll();
  const reference=wide.agents;
  check('every header control keeps its pixel on every page at 1920x958',()=>{
    for(const name of PAGES){
      assert.equal(wide[name].actions,reference.actions,`${name}: .top-actions width moved`);
      assert.equal(wide[name].barH,reference.barH,`${name}: topbar height moved`);
      for(const id of IDS)assert.deepEqual({x:wide[name].items[id].x,y:wide[name].items[id].y},
        {x:reference.items[id].x,y:reference.items[id].y},`${name}: #${id} moved`);
    }});
  // The connection lives on the Live dot beside the page name, so it is the
  // dot that has to survive every page; the status text stays for screen readers.
  check('the connection status stays in place and connected on the Skills page',()=>{
    const dot=wide.skills.items['mode-title'];
    assert.notEqual(dot.display,'none','the Live dot left the flow on Skills');
    assert.equal(dot.visibility,'visible');
    assert.ok(dot.width>0,'the Live dot collapsed on Skills');
    assert.equal(wide.skills.connected,true,'#sync-status is not connected on Skills');
  });
  check('Sessions is the active destination on the Agents page and holds one slot on every page',()=>{
    assert.equal(wide.agents.items['open-sessions'].visibility,'visible','Sessions is an invisible hole on the Agents page again');
    assert.notEqual(wide.agents.items['open-sessions'].display,'none');
    assert.equal(wide.agents.items['open-sessions'].width,wide.skills.items['open-sessions'].width);
    assert.equal(wide.workflows.items['open-sessions'].visibility,'visible');
    // Exactly one destination is active on every page, and on the Agents page it is Sessions.
    for(const [pageName,snapshot] of Object.entries(wide))assert.equal(snapshot.active.length,1,pageName+' has '+snapshot.active.length+' active destinations');
    assert.deepEqual(wide.agents.active,['open-sessions'],'Sessions is not the active destination on the Agents page');
    assert.deepEqual(booted,['open-sessions'],'on first load the Agents page shows '+(booted.join(',')||'no')+' active destination');
  });
  // One neutral thumb sits exactly on the current destination on every page,
  // moves with a transition once the page has loaded, and hides when nothing is current.
  const settled={};
  for(const name of PAGES){await page.evaluate(n=>switchPage(n),name);await page.waitForTimeout(450);settled[name]=await page.evaluate(geometry,IDS);}
  const withoutDestination=await page.evaluate(()=>{switchPage('coordinator');const thumb=document.querySelector('.header-nav-thumb');const out={hidden:thumb.hidden};switchPage('agents');return out;});
  const thumbStyle=await page.evaluate(()=>({ready:document.getElementById('header-nav').classList.contains('ready'),transition:getComputedStyle(document.querySelector('.header-nav-thumb')).transitionDuration}));
  check('the quiet segmented thumb sits on the current destination on every page',()=>{
    for(const name of PAGES){
      assert.ok(settled[name].thumb,'there is no header thumb');
      assert.equal(settled[name].thumb.hidden,false,name+': the thumb is hidden');
      assert.ok(settled[name].thumb.off<=2,`${name}: the thumb is ${settled[name].thumb.off}px off its destination`);
    }
    assert.equal(withoutDestination.hidden,true,'the thumb stays visible on a page with no destination');
    assert.equal(thumbStyle.ready,true,'the thumb never became ready to animate');
    assert.notEqual(thumbStyle.transition.split(',')[0].trim(),'0s','the thumb snaps instead of sliding');
  });
  // A window resize must not leave the thumb at its old, wider position: that briefly made
  // the page scroll sideways at phone width while the thumb slid back.
  await page.evaluate(()=>switchPage('workflows'));await page.setViewportSize({width:1440,height:958});await page.waitForTimeout(500);
  await page.setViewportSize({width:390,height:844});
  const resizeFrames=[];
  for(let frame=0;frame<8;frame++){resizeFrames.push(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth));await page.waitForTimeout(40);}
  const resizedThumb=await page.evaluate(()=>{const t=document.querySelector('.header-nav-thumb').getBoundingClientRect(),on=document.querySelector('#header-nav .button.active').getBoundingClientRect();return Math.round(Math.abs(t.left-on.left)+Math.abs(t.width-on.width));});
  await page.setViewportSize({width:1920,height:958});await page.evaluate(()=>switchPage('agents'));await page.waitForTimeout(500);
  check('resizing never scrolls the page sideways and the thumb follows without sliding',()=>{
    assert.ok(resizeFrames.every(extra=>extra<=0),'the page scrolled sideways for a moment after resizing: '+resizeFrames.join(','));
    assert.ok(resizedThumb<=2,`the thumb is ${resizedThumb}px off its destination after resizing`);
  });
  const zeroed=await page.evaluate(ids=>{const badge=document.getElementById('review-count');badge.classList.add('hidden');
    const style=getComputedStyle(badge);
    const out={display:style.display,visibility:style.visibility,
      items:Object.fromEntries(ids.map(id=>[id,+document.getElementById(id).getBoundingClientRect().x.toFixed(1)]))};
    badge.classList.remove('hidden');return out;},IDS);
  check('an Inbox count of zero keeps its badge slot and moves nothing',()=>{
    assert.notEqual(zeroed.display,'none');assert.equal(zeroed.visibility,'visible','a zero Inbox count is an invisible gap inside the chip again');
    for(const id of IDS)assert.equal(zeroed.items[id],reference.items[id].x,`#${id} moved when the Inbox badge cleared`);
  });
  const narrow={};
  for(const width of [1728,1510,1500,1472,1464,1280,1040,900,760,390]){
    await page.setViewportSize({width,height:958});await page.waitForTimeout(250);
    narrow[width]=await measureAll();
    narrow[width].noHorizontalScroll=await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);
  }
  check('narrow layouts keep the same page-independent header geometry',()=>{
    for(const [width,sizes] of Object.entries(narrow)){
      assert.ok(sizes.noHorizontalScroll,`${width}px: the page scrolls horizontally`);
      const base=sizes.agents;
      for(const name of PAGES){
        assert.equal(sizes[name].actions,base.actions,`${width}px ${name}: .top-actions width moved`);
        for(const id of IDS){const item=sizes[name].items[id],reference=base.items[id];
          if(item.display==='none'||reference.display==='none'||!item.width||!reference.width)continue;
          assert.deepEqual({x:+(item.x-sizes[name].barX).toFixed(1),y:+(item.y-sizes[name].barY).toFixed(1)},
            {x:+(reference.x-base.barX).toFixed(1),y:+(reference.y-base.barY).toFixed(1)},
            `${width}px ${name}: #${id} moved inside the bar`);}
      }}});
  check('no page errors',()=>assert.deepEqual(errors,[]));
  await context.close();
 }finally{await browser.close();}
 if(failures.length){console.log('FAILED: '+failures.join(', '));process.exit(1);}
 console.log('PASS: header controls hold one declared order and the connection status survives every page');
})();
