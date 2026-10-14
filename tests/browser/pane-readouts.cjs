// Readouts a pane's own process sets render in a row under its header:
// hidden when nothing was published, colored only by the publisher's tone, aged, and marked
// stale once the publisher's TTL passes so a dead loop never looks current.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const IDS=['readouts-fixture-fresh','readouts-fixture-stale','readouts-fixture-none'];
const fields=[{label:'Jobs done',value:'412',tone:'good'},{label:'Queue',value:'4',tone:'neutral'},{label:'Failure rate',value:'1.2%',tone:'bad'},{label:'Flaky',value:'7',tone:'warn'}];
const fixtures={'readouts-fixture-fresh':{fields,ttl_seconds:900,age:5},'readouts-fixture-stale':{fields:fields.slice(0,2),ttl_seconds:60,age:600},'readouts-fixture-none':null};
let served=fixtures;
const agent=id=>({id,terminal_id:id,name:'Readouts fixture',cwd:'/tmp/'+id,harness:'zsh',status:'unknown',source:'terminal',task:'Interactive terminal',
  project:'fixture',events:[],question:null,exit_code:null,updated:Date.now()/1000,readouts:served[id]});
const read=page=>page.$$eval('#terminal > .terminal-pane',nodes=>Object.fromEntries(nodes.map(node=>{const row=node.querySelector('.pane-readouts');
  return [node.dataset.paneId,{hidden:row.hidden,display:getComputedStyle(row).display,stale:row.classList.contains('stale'),age:row.querySelector('.pane-readouts-age')?.textContent||'',
    fields:[...row.querySelectorAll('.pane-readout')].map(m=>({label:m.querySelector('.pane-readout-label').textContent,value:m.querySelector('.pane-readout-value').textContent,tone:m.dataset.tone,
      color:getComputedStyle(m.querySelector('.pane-readout-value')).color})),
    ageTop:row.querySelector('.pane-readouts-age')?.getBoundingClientRect().top,firstTop:row.querySelector('.pane-readout')?.getBoundingClientRect().top}];})));
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await (await browser.newContext({viewport:{width:1040,height:800}})).newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:IDS.map(agent)}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  // Fixture terminals have no PTY behind them; answer their output polls as quiet and live.
  await page.route('**/api/terminals/output*',route=>route.fulfill({json:{data:'',cursor:0,truncated:false,exit_code:null}}));
  await page.addInitScript(ids=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(ids)),IDS);
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane .pane-readout',{timeout:15000});
  let panes=await read(page);
  const fresh=panes['readouts-fixture-fresh'],stale=panes['readouts-fixture-stale'],none=panes['readouts-fixture-none'];
  check('published fields render in order with their labels and values',()=>assert.deepEqual(fresh.fields.map(f=>[f.label,f.value,f.tone]),fields.map(f=>[f.label,f.value,f.tone])));
  check('only the publisher tone colors a value',()=>{const colors=Object.fromEntries(fresh.fields.map(f=>[f.tone,f.color]));
    assert.equal(new Set(Object.values(colors)).size,4,'good, neutral, bad and warn should be distinct colors');});
  check('a fresh publish shows its age and is not stale',()=>{assert.equal(fresh.stale,false);assert.equal(fresh.age,'just now');});
  check('the age stays on the first line beside the fields',()=>assert.ok(Math.abs(fresh.ageTop-fresh.firstTop)<4,`age at ${fresh.ageTop}, fields at ${fresh.firstTop}`));
  check('values older than their TTL are marked stale',()=>{assert.equal(stale.stale,true);assert.match(stale.age,/^Stale · 10m ago$/);});
  check('a pane that never published shows no row',()=>{assert.equal(none.hidden,true);assert.equal(none.display,'none');});
  served={...fixtures,'readouts-fixture-fresh':null};
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="readouts-fixture-fresh"] .pane-readouts').hidden,null,{timeout:10000});
  panes=await read(page);
  check('clearing removes the row',()=>{assert.equal(panes['readouts-fixture-fresh'].hidden,true);assert.equal(panes['readouts-fixture-fresh'].fields.length,0);});
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();}
 if(failures.length){console.log(`\n${failures.length} failed`);process.exit(1);}console.log('\nAll pane readouts checks passed');
})();
