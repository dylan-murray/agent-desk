// Agents spawned by an agent session on a desk, plus a web pane, must all be reachable in the
// Main + side layout by scrolling, not only the main pane and one side pane.
// Runs against a real isolated backend with real shells. The children are started the way an
// agent starts them, with scripts/agent_control.py launch --parent (no desk is sent).
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const {execFileSync}=require('node:child_process');const http=require('node:http');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const python=process.env.AGENT_DESK_TEST_PYTHON||(fs.existsSync('/opt/homebrew/bin/python3.12')?'/opt/homebrew/bin/python3.12':'python3');
const control=path.join(__dirname,'..','..','scripts','agent_control.py');
const tag=Math.random().toString(36).slice(2,6),RESEARCH='Research '+tag;
const panes=page=>page.$$eval('#terminal .terminal-pane',nodes=>nodes.map(n=>n.dataset.paneId));
const spawn=(parent,name,argv=['/bin/sh'])=>JSON.parse(execFileSync(python,[control,'--desk',new URL(APP).origin,'launch','--parent',parent,'--cwd',os.tmpdir(),'--name',name,'--',...argv],{encoding:'utf8',timeout:20000})).id;
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[],launched=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 let page,site;
 try{
  // A page of its own origin: a same-origin frame would share this tab's session storage.
  site=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><title>Dashboard</title><h1>Research dashboard</h1>');});
  await new Promise(resolve=>site.listen(0,'localhost',resolve));
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:1});
  page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto(APP,{waitUntil:'domcontentloaded'});await page.waitForSelector('#desk-button .desk-name');await page.waitForTimeout(800);
  const main=await page.evaluate(()=>desks[0].id);
  await page.click('#desk-button');await page.click('[data-desk-new]');await page.keyboard.type(RESEARCH);await page.keyboard.press('Enter');
  await page.waitForFunction(name=>document.querySelector('#desk-button .desk-name')?.textContent===name,RESEARCH);
  const research=await page.evaluate(()=>activeDesk().id);

  // The agent's own terminal, opened from New, and a web page beside it.
  await page.click('#new-terminal');await page.click('[data-new-pane="terminal"]');
  await page.selectOption('#terminal-harness','shell');
  await page.evaluate(dir=>{const project=document.getElementById('terminal-project');if([...project.options].some(o=>o.value==='manual'))project.value='manual';document.getElementById('terminal-cwd').value=dir;},os.tmpdir());
  await page.click('#launch-terminal-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelectorAll('#terminal .terminal-pane').length===1,null,{timeout:15000});
  const parent=(await panes(page))[0];launched.push(parent);
  await page.click('#new-terminal');await page.click('[data-new-pane="web"]');
  await page.fill('#web-page-url',`http://localhost:${site.address().port}/`);await page.fill('#web-page-name','Dashboard');
  await page.click('#web-page-form button[type=submit]');
  await page.waitForFunction(()=>document.querySelectorAll('#terminal .terminal-pane').length===2);
  await page.click('#pane-layout-button');await page.click('[data-layout=main]');

  // The agent spawns six workers, and one more that has already finished.
  const children=[];for(let i=1;i<=6;i++){const id=spawn(parent,'Worker '+i);children.push(id);launched.push(id);}
  const finished=spawn(parent,'Finished worker',['/usr/bin/true']);launched.push(finished);
  await page.waitForTimeout(1500);
  await page.evaluate(()=>refresh());
  await page.waitForFunction(n=>document.querySelectorAll('#terminal .terminal-pane').length===n,8,{timeout:10000}).catch(()=>{});
  const data=await page.evaluate(async()=>(await fetch('/api/agents')).json());
  check('workers an agent spawns without naming a desk go to its desk',()=>assert.deepEqual(children.map(id=>data.agents.find(a=>a.id===id)?.desk),children.map(()=>research)));
  const rows=await page.$$eval('#agent-grid .session-row',n=>n.map(x=>x.dataset.agentId));
  check('...and are listed there',()=>assert.ok(children.every(id=>rows.includes(id))));
  const open=await panes(page);
  check('every live worker opens as a pane beside the agent and the web page',()=>assert.deepEqual(new Set(open),new Set([parent,open.find(id=>id.startsWith('web-')),...children])));
  check('...and a worker that already finished does not',()=>assert.equal(open.includes(finished),false));
  const count=await page.textContent('#pane-count');
  check('the toolbar counts all eight panes',()=>assert.equal(count,'8 / 16 open'));
  const selected=await page.evaluate(()=>selectedId);
  check('opening them does not take focus from the pane in use',()=>assert.notEqual(children.includes(selected),true));

  // Main + side: one main pane, three beside it, the rest in rows below that scroll into view.
  const layout=await page.evaluate(()=>{const w=document.getElementById('terminal');return {scrolls:w.scrollHeight>w.clientHeight+10,pill:document.getElementById('panes-below').hidden?null:document.querySelector('#panes-below span').textContent};});
  check('Main + side lays out every pane, with the overflow below one screen',()=>assert.deepEqual(layout,{scrolls:true,pill:'4 panes below'}));
  await page.screenshot({path:path.join(OUT,'spawned-panes-01-main-side.png')});
  await page.click('#panes-below');
  const last=children.at(-1);
  // Wait for the smooth scroll to land rather than a fixed delay; with every pane on WebGL it can take ~600ms.
  const reached=await page.waitForFunction(id=>{const w=document.getElementById('terminal').getBoundingClientRect(),r=document.querySelector(`.terminal-pane[data-pane-id="${id}"]`).getBoundingClientRect();return r.top>=w.top-1&&r.bottom<=w.bottom+1;},last,{timeout:3000}).then(()=>true,()=>false);
  check('the panes below can be scrolled to',()=>assert.equal(reached,true));
  await page.screenshot({path:path.join(OUT,'spawned-panes-02-scrolled.png')});

  // Closing a worker's pane keeps it closed, through refreshes and a reload.
  await page.click(`.terminal-pane[data-pane-id="${children[0]}"] .pane-close`);
  await page.evaluate(()=>refresh());await page.waitForTimeout(2500);
  const afterClose=await panes(page);
  check('a closed worker pane stays closed',()=>assert.equal(afterClose.includes(children[0]),false));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForTimeout(2000);
  const afterReload=await panes(page);
  check('...after a reload too',()=>assert.deepEqual([afterReload.includes(children[0]),afterReload.length],[false,7]));
  const later=spawn(parent,'Worker 7');launched.push(later);
  await page.evaluate(()=>refresh());await page.waitForFunction(id=>!!document.querySelector(`.terminal-pane[data-pane-id="${id}"]`),later,{timeout:10000}).catch(()=>{});
  const withLater=await panes(page);
  check('a worker spawned later opens as it arrives',()=>assert.equal(withLater.includes(later),true));

  // The first desk is not touched.
  await page.click('#desk-button');await page.click(`#desk-menu [data-desk-id="${main}"]`);await page.waitForTimeout(500);
  const mainPanes=await panes(page);
  check('another desk does not open them',()=>assert.equal(mainPanes.some(id=>[...children,later].includes(id)),false));
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }catch(error){failures.push('run');console.log('  FAIL  run :: '+(error.stack||error.message));}
 finally{
  if(page){
    for(const id of launched)await page.evaluate(id=>terminalRequest('/api/terminals/stop',{id}).catch(()=>{}),id).catch(()=>{});
    await page.evaluate(async tag=>{const {desks:list}=await (await fetch('/api/agents')).json();
      for(const desk of list.filter(d=>d.name.endsWith(' '+tag)))await terminalRequest('/api/desks/delete',{id:desk.id,move_to:list[0].id}).catch(()=>{});},tag).catch(()=>{});
  }
  await browser.close();site?.close();
 }
 if(failures.length){console.log(`${failures.length} spawned pane check(s) failed`);process.exit(1);}
 console.log('All spawned pane checks passed · screenshots in '+OUT);
})();
