// The wheel while panes run past the screen: over the focused pane it scrolls that terminal,
// over any other pane it scrolls the workspace, a gesture keeps its target as panes slide under
// the pointer, Option scrolls the workspace from anywhere, and with no overflow nothing changes.
// Launches five fixture shells with scrollback.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const os=require('node:os'),path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const EVIDENCE=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();

(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page;
 try{
  page=await browser.newPage({viewport:{width:1920,height:958}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/vendor/addon-webgl.js',route=>route.abort());
  await page.goto(APP);await page.evaluate(()=>{try{localStorage.removeItem('agent-desk-pane-layout');}catch{}});await page.reload();
  await page.waitForFunction(()=>typeof terminalRequest==='function');
  const ids=await page.evaluate(async()=>{const out=[];for(let i=0;i<5;i++){const s=await terminalRequest('/api/terminals/launch',{cwd:'/tmp',name:'Wheel fixture '+(i+1),desk:activeDesk().id,argv:['/bin/zsh','-f','-c','for i in {1..400}; do echo line $i; done; exec /bin/zsh -f']});out.push(s.id);window.__wheelFixtures=[...(window.__wheelFixtures||[]),{...s,name:'Wheel fixture '+(i+1),project:'fixture'}];}return out;});
  launched.push(...ids);
  await page.waitForFunction(ids=>ids.every(id=>agents.some(a=>a.id===id)),ids,{timeout:15000}).catch(()=>{});
  const show=open=>page.evaluate(([ids,open])=>{for(const s of window.__wheelFixtures)if(!agents.some(a=>a.id===s.id))agents.unshift(s);openPaneIds=ids.slice(0,open);selectedId=ids[0];paneRects=null;savePanes();render();applyPaneLayout();},[ids,open]);
  await show(5);await page.waitForTimeout(2500);
  const state=()=>page.evaluate(ids=>({ws:document.querySelector('#terminal').scrollTop,overflow:document.querySelector('#terminal').classList.contains('pane-overflow'),
   y:Object.fromEntries(ids.map(id=>[id,paneViews.get(id)?.term?.buffer.active.viewportY]))}),ids);
  const box=id=>page.evaluate(id=>{const r=paneViews.get(id).node.querySelector('.pty-body').getBoundingClientRect(),w=document.querySelector('#terminal').getBoundingClientRect(),top=Math.max(r.top,w.top),bottom=Math.min(r.bottom,w.bottom);return {x:r.left+r.width/2,y:(top+bottom)/2};},id);
  const quiet=()=>page.waitForTimeout(400);
  const wheel=async(at,dy,steps=6)=>{await page.mouse.move(at.x,at.y);for(let i=0;i<steps;i++){await page.mouse.wheel(0,dy/steps);await page.waitForTimeout(30);}await page.waitForTimeout(150);};
  const top=()=>page.evaluate(()=>{document.querySelector('#terminal').scrollTop=0;});

  const start=await state();
  const room=await page.evaluate(()=>{const ws=document.querySelector('#terminal');return ws.scrollHeight-ws.clientHeight;});
  check('five panes in 2 × 2 run past the screen',()=>{assert.equal(start.overflow,true);assert.equal(start.ws,0);assert.ok(room>300,'room '+room);});
  await page.screenshot({path:path.join(EVIDENCE,'pane-wheel-before-scroll.png')});

  await page.evaluate(()=>{document.querySelector('#terminal').scrollTop=300;});await quiet();const down=await state();
  await wheel(await box(ids[1]),-200);const unfocused=await state();
  check('the wheel over an unfocused pane scrolls the workspace, not that terminal',()=>{assert.ok(unfocused.ws<down.ws,'workspace '+down.ws+' → '+unfocused.ws);assert.equal(unfocused.y[ids[1]],down.y[ids[1]]);});
  await page.screenshot({path:path.join(EVIDENCE,'pane-wheel-after-scroll.png')});

  await quiet();await top();await quiet();const before=await state();
  await wheel(await box(ids[0]),-300);const focused=await state();
  check('the wheel over the focused pane scrolls its terminal, not the workspace',()=>{assert.equal(focused.ws,0);assert.ok(focused.y[ids[0]]<before.y[ids[0]],'viewportY '+before.y[ids[0]]+' → '+focused.y[ids[0]]);});

  await quiet();await top();await quiet();
  const gap=await page.evaluate(id=>{const r=paneViews.get(id).node.getBoundingClientRect();return {x:r.right+5,y:r.top+r.height/2};},ids[0]);
  const mid=await state();
  await page.mouse.move(gap.x,gap.y);for(let i=0;i<10;i++){await page.mouse.wheel(0,60);await page.waitForTimeout(30);}
  const focusedNow=await box(ids[0]);await page.mouse.move(focusedNow.x,focusedNow.y);for(let i=0;i<6;i++){await page.mouse.wheel(0,-40);await page.waitForTimeout(30);}
  await page.waitForTimeout(150);const latched=await state();
  check('a gesture that starts on the workspace keeps scrolling it over the focused pane',()=>{assert.ok(latched.ws>0&&latched.ws<600,'workspace '+latched.ws);assert.equal(latched.y[ids[0]],mid.y[ids[0]]);});

  await quiet();await top();await quiet();const pre=await state();
  await page.keyboard.down('Alt');await wheel(await box(ids[0]),300);await page.keyboard.up('Alt');const option=await state();
  check('Option + wheel over the focused pane scrolls the workspace',()=>{assert.ok(option.ws>0,'workspace '+option.ws);assert.equal(option.y[ids[0]],pre.y[ids[0]]);});

  await quiet();await show(4);await page.waitForTimeout(1200);const fit=await state();
  await wheel(await box(ids[3]),-300);const fitAfter=await state();
  check('with every pane on screen the wheel still scrolls any terminal',()=>{assert.equal(fit.overflow,false);assert.ok(fitAfter.y[ids[3]]<fit.y[ids[3]],'viewportY '+fit.y[ids[3]]+' → '+fitAfter.y[ids[3]]);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{
  for(const id of launched)await page?.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
  await browser.close();
 }
 if(failures.length){console.log('FAIL: '+failures.join('; '));process.exit(1);}
 console.log('PASS: the wheel scrolls the focused terminal or the workspace, keeps its target mid-gesture, and is unchanged without overflow');
})().catch(error=>{console.error(error);process.exit(1);});
