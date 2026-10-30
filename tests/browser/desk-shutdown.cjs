// Shutting a desk down stops every terminal and session on that desk, and it must be obvious
// that only that desk is affected, not all desks.
// Real shells on two desks. The power button sits beside the desk's name and outlines it on
// hover; the dialog names the desk, lists what happens to each session and the desks it leaves
// alone. A session started while the dialog is open, and the other desk, must keep running.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const os=require('node:os');const path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const tag=Math.random().toString(36).slice(2,6);
const DOOMED='Research '+tag,KEPT='Work '+tag,EMPTY='Empty '+tag;
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page;
 try{
  page=await (await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1})).newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForSelector('#desk-button .desk-name');await page.waitForTimeout(600);
  const tmp=os.tmpdir().replace(/\/$/,'');
  const ids=await page.evaluate(async ([doomed,kept,empty,tmp])=>{
    const make=name=>terminalRequest('/api/desks/create',{name});
    const [a,b]=[await make(doomed),await make(kept)];await make(empty);
    const shell=async(name,desk,argv=['/bin/sh'])=>(await terminalRequest('/api/terminals/launch',{cwd:tmp,argv,name,desk})).id;
    return {doomed:a.id,kept:b.id,one:await shell('Data loader',a.id),two:await shell('Log watcher',a.id),
      finished:await shell('Nightly report',a.id,['/bin/sh','-c','exit 0']),other:await shell('API server',b.id)};
  },[DOOMED,KEPT,EMPTY,tmp]);
  launched.push(ids.one,ids.two,ids.finished,ids.other);
  await page.click('#desk-button');await page.click(`#desk-menu [data-desk-id="${ids.doomed}"]`);
  await page.waitForFunction(id=>document.querySelector(`.session-row[data-agent-id="${id}"]`),ids.finished,{timeout:10000});
  await page.waitForFunction(id=>agents.find(a=>a.id===id)?.exit_code!==null,ids.finished,{timeout:10000});

  const power=await page.$eval('#desk-shutdown',n=>({disabled:n.disabled,title:n.title,label:n.getAttribute('aria-label')}));
  check('the power button names this desk and says the others keep running',()=>assert.deepEqual(power,{disabled:false,title:`Shut down everything on the ${DOOMED} desk · other desks keep running`,label:`Shut down the ${DOOMED} desk`}));
  const rest=await page.$eval('#desk-button',n=>getComputedStyle(n).borderColor);
  await page.hover('#desk-shutdown');await page.waitForTimeout(250);
  const hovered=await page.$eval('#desk-button',n=>getComputedStyle(n).borderColor);
  check('hovering the power button outlines the desk it belongs to',()=>assert.notEqual(hovered,rest));
  await page.screenshot({path:path.join(OUT,'desk-shutdown-01-hover.png'),clip:{x:0,y:0,width:320,height:260}});

  await page.click('#desk-shutdown');
  const dialog=await page.$eval('#shutdown-desk-dialog',n=>({open:n.open,title:n.querySelector('h2').textContent,lede:n.querySelector('.desk-shutdown-lede').textContent,
    rows:[...n.querySelectorAll('.desk-shutdown-list li')].map(li=>[li.querySelector('strong').textContent,li.querySelector('.desk-shutdown-outcome').textContent]),
    others:n.querySelector('.desk-shutdown-others').textContent,confirm:n.querySelector('#confirm-shutdown-desk').textContent,focused:document.activeElement.textContent}));
  check('the dialog is titled with this desk',()=>assert.equal(dialog.title,`Shut down the “${DOOMED}” desk?`));
  check('it says what it does, on this desk only',()=>assert.equal(dialog.lede,'Stops 2 terminals and clears 1 finished terminal on this desk only.'));
  check('it lists each session with what happens to it',()=>assert.deepEqual(dialog.rows,[['Data loader','Stops'],['Log watcher','Stops'],['Nightly report','Clears']]));
  check('it names the desks it leaves running, skipping empty ones',()=>{assert.match(dialog.others,/^Other desks keep running:/);assert.ok(dialog.others.includes(KEPT+' · 1 session'));assert.equal(dialog.others.includes(EMPTY),false);});
  check('the destructive button names the desk, and Cancel has focus',()=>assert.deepEqual([dialog.confirm,dialog.focused],[`Shut down ${DOOMED}`,'Cancel']));
  await page.screenshot({path:path.join(OUT,'desk-shutdown-02-dialog.png')});

  // Started on this desk after the list was shown: not in the confirmation, so not stopped.
  const late=await page.evaluate(async ([desk,tmp])=>(await terminalRequest('/api/terminals/launch',{cwd:tmp,argv:['/bin/sh'],name:'Started meanwhile',desk})).id,[ids.doomed,tmp]);
  launched.push(late);
  await page.click('#confirm-shutdown-desk');
  await page.waitForFunction(()=>!document.getElementById('shutdown-desk-dialog').open,null,{timeout:15000});
  const toast=await page.textContent('#toast');
  check('it reports what it did',()=>assert.equal(toast,`${DOOMED} shut down: stopped 2 terminals`));
  const exited=async id=>page.evaluate(async id=>(await (await fetch('/api/agents')).json()).agents.find(a=>a.id===id)?.exit_code,id);
  await page.waitForFunction(async ids=>{const list=(await (await fetch('/api/agents')).json()).agents;return ids.every(id=>list.find(a=>a.id===id)?.exit_code!==null);},[ids.one,ids.two],{timeout:10000});
  const states={one:await exited(ids.one),two:await exited(ids.two),other:await exited(ids.other),late:await exited(late)};
  check('the desk\'s terminals were really stopped',()=>{assert.notEqual(states.one,null);assert.notEqual(states.two,null);});
  check('the other desk\'s terminal is still running',()=>assert.equal(states.other,null));
  check('a session started while the dialog was open is still running',()=>assert.equal(states.late,null));
  await page.evaluate(()=>refresh());await page.waitForTimeout(300);
  const left=await page.$$eval('#agent-grid .session-row',n=>n.map(x=>x.dataset.agentId));
  check('the desk\'s sidebar keeps only what was not shut down',()=>assert.deepEqual(left,[late]));

  // When something cannot be stopped the dialog stays open and says which one and why.
  await page.route('**/api/desks/shutdown',route=>route.fulfill({json:{stopped:[],closed:[],skipped:[],failed:[{id:late,error:'Reconnect this remote environment first.'}]}}));
  await page.click('#desk-shutdown');await page.click('#confirm-shutdown-desk');
  await page.waitForFunction(()=>document.querySelector('#shutdown-desk-dialog [role=alert]').textContent);
  const failed=await page.$eval('#shutdown-desk-dialog',n=>({open:n.open,title:n.querySelector('h2').textContent,alert:n.querySelector('[role=alert]').textContent,
    row:n.querySelector('li.failed .desk-shutdown-outcome')?.textContent,confirmHidden:n.querySelector('#confirm-shutdown-desk').hidden,close:n.querySelector('.close-dialog').textContent}));
  check('a session that could not be stopped is named, with the reason, and the dialog stays open',()=>assert.deepEqual(failed,
    {open:true,title:`“${DOOMED}” is not fully shut down`,alert:'1 session could not be stopped: Reconnect this remote environment first.',row:'Still running',confirmHidden:true,close:'Close'}));
  await page.screenshot({path:path.join(OUT,'desk-shutdown-04-failed.png')});
  await page.click('#shutdown-desk-dialog .close-dialog');await page.unroute('**/api/desks/shutdown');

  await page.click('#desk-button');await page.click(`#desk-menu .desk-option:has(.desk-option-name:text-is("${EMPTY}")) [data-desk-id]`);
  const idle=await page.$eval('#desk-shutdown',n=>({disabled:n.disabled,title:n.title}));
  check('on a desk with nothing running the power button is disabled and says why',()=>assert.deepEqual(idle,{disabled:true,title:`Nothing to shut down on the ${EMPTY} desk`}));
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(300);
  const row=await page.evaluate(()=>{const a=document.getElementById('desk-button').getBoundingClientRect(),b=document.getElementById('desk-shutdown').getBoundingClientRect();return {sameRow:Math.abs(a.top-b.top)<2&&Math.abs(a.bottom-b.bottom)<2,onScreen:b.right<=innerWidth};});
  check('on a phone the power button stays beside the desk name',()=>assert.deepEqual(row,{sameRow:true,onScreen:true}));
  await page.screenshot({path:path.join(OUT,'desk-shutdown-03-narrow.png'),clip:{x:0,y:0,width:390,height:200}});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push('run');console.log('  FAIL  run :: '+(error.stack||error.message));}
 finally{
  if(page){
    for(const id of launched)await page.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
    await page.evaluate(async tag=>{const {desks:list}=await (await fetch('/api/agents')).json();
      for(const desk of list.filter(d=>d.name.endsWith(' '+tag)))await terminalRequest('/api/desks/delete',{id:desk.id,move_to:list[0].id}).catch(()=>{});},tag).catch(()=>{});
  }
  await browser.close();
 }
 if(failures.length){console.log(`${failures.length} desk shutdown check(s) failed`);process.exit(1);}
 console.log('All desk shutdown checks passed · screenshots in '+OUT);
})();
