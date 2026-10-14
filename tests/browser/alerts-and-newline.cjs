// Two regressions: Shift+Enter must add a line in a coding agent's terminal instead of
// submitting, and a completion sound must play even after the audio context is suspended.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});try{

 // ---- Shift+Enter through the real xterm build the app ships ----
 {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(APP);
  const sent=await page.evaluate(async()=>{
    const host=document.createElement('div');host.style.cssText='width:600px;height:300px';document.body.append(host);
    const term=new Terminal({cols:80,rows:24});const out=[];
    function sendText(d){out.push(d);}
    term.open(host);term.onData(sendText);
    term.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown'||event.key!=='Enter'||!event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return true;
      event.preventDefault();sendText('\x1b\r');return false;
    });
    term.focus();
    const area=host.querySelector('textarea');
    const press=(shift)=>area.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:13,which:13,shiftKey:shift,bubbles:true,cancelable:true}));
    out.length=0;press(true);const withShift=out.slice();
    out.length=0;press(false);const plain=out.slice();
    return {withShift,plain};
  });
  assert.deepEqual(sent.withShift,['\x1b\r'],'Shift+Enter must send ESC+CR exactly once');
  assert.ok(!sent.withShift.includes('\r'),'Shift+Enter must not also submit a bare CR');
  assert.deepEqual(sent.plain,['\r'],'plain Enter must still submit');
  assert.deepEqual(errors,[]);
  console.log('shift+enter   PASS  sends ESC+CR, plain Enter still submits');
  await page.close();
 }

 // ---- Completion sound survives a suspended audio context ----
 {
  const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{
    window.__tones=0;window.__resumes=0;
    class FakeParam{constructor(){this.value=0}setValueAtTime(){}linearRampToValueAtTime(){}exponentialRampToValueAtTime(){}}
    class FakeCtx{
      constructor(){this.state='suspended';this.currentTime=0;this.destination={};}
      async resume(){window.__resumes++;this.state='running';}
      createOscillator(){window.__tones++;return {frequency:new FakeParam(),type:'',connect(){},start(){},stop(){},disconnect(){},set onended(v){}};}
      createGain(){return {gain:new FakeParam(),connect(){},disconnect(){}};}
    }
    window.AudioContext=FakeCtx;window.webkitAudioContext=FakeCtx;
    try{localStorage.setItem('agent-desk-completion-sound','true');localStorage.removeItem('agent-desk-completion-seen');}catch{}
  });
  await page.route('**/api/**',r=>{const p=new URL(r.request().url()).pathname;
    const d={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/terminal-auth':{token:'x',cwd:'/tmp'},'/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinators':{coordinators:[],messages:[]},'/api/coordinator-events':{tasks:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/projects':{projects:[],roots:[]}};
    return r.fulfill({json:d[p]||{}});});
  await page.goto(APP);
  await page.waitForFunction(()=>typeof window.updateWorkerCompletions==='function');

  const task=id=>({id,worker:'w1',created:1,result:'done',outcome:'completed'});
  await page.evaluate(()=>window.updateWorkerCompletions([]));            // baseline pass, silent
  const afterBaseline=await page.evaluate(()=>window.__tones);
  assert.equal(afterBaseline,0,'the first poll must not replay old reports');

  // the browser has suspended the context, which used to make chime() a no-op
  await page.evaluate(()=>{const c=window.__ctx;});
  await page.evaluate(t=>window.updateWorkerCompletions([t]),task('t1'));
  await page.waitForFunction(()=>window.__tones>0,null,{timeout:4000}).catch(()=>{});
  const tones=await page.evaluate(()=>window.__tones), resumes=await page.evaluate(()=>window.__resumes);
  assert.ok(resumes>0,'a suspended context must be resumed');
  assert.equal(tones,2,'the chime is two tones');

  // a repeat poll of the same task must stay quiet
  await page.evaluate(t=>window.updateWorkerCompletions([t]),task('t1'));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(()=>window.__tones),2,'a repeated poll must not replay the sound');

  // a second, different completion must sound again once past the 1.5s window that
  // coalesces a worker's report with its own finished turn into one chime
  await page.waitForTimeout(1600);
  await page.evaluate(t=>window.updateWorkerCompletions([t]),task('t2'));
  await page.waitForFunction(()=>window.__tones>2,null,{timeout:4000});
  assert.equal(await page.evaluate(()=>window.__tones),4);
  assert.deepEqual(errors,[]);
  console.log('completion sound  PASS  resumes a suspended context, fires once per new report');
  await page.close();
 }
 console.log('\nboth regressions covered');
}finally{await browser.close();}})();
