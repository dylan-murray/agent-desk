// A "failed to fetch - reconnecting" notice must clear once a working terminal's output resumes.
// A dropped output poll used to leave that line on a pane forever, because only a recovery or a
// fresh mount ever cleared it.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const {paneText}=require('./terminal-text.cjs');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const agent={id:'pane-net',terminal_id:'pane-net',name:'Streaming agent',parent_id:null,harness:'codex',status:'working',
  source:'terminal',exit_code:null,cwd:'/tmp/pane-net',project:'fixture',task:'Interactive terminal',events:[],question:null,updated:Date.now()/1000};
const chunk=text=>Buffer.from(text,'utf8').toString('base64');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1200,height:800}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  let cursor=0,drop=0,served=0;
  await page.route('**/api/**',route=>{const url=new URL(route.request().url()),path=url.pathname;
   if(path==='/api/terminals/output'){
    if(drop>0){drop--;return route.abort('connectionreset');}  // what "Failed to fetch" is in the browser
    served++;
    const text=served===1?'agent ready\r\n':'';
    cursor+=text.length;
    return route.fulfill({json:{data:chunk(text),cursor,truncated:false,exit_code:null}});
   }
   const data={'/api/agents':{agents:[agent]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(['pane-net'])));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('[data-pane-id="pane-net"] .pane-body');
  const line=page.locator('[data-pane-id="pane-net"] .pane-connection');
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="pane-net"] .pane-connection').textContent==='');

  // One dropped poll is ordinary and must not shout about it.
  drop=1;
  await page.waitForTimeout(1200);
  const afterOne=await line.textContent();
  check('one blip leaves the pane quiet',()=>assert.equal(afterOne,''));

  // A real interruption says so, and then clears itself once polling recovers.
  drop=4;
  await page.waitForFunction(()=>/reconnecting/.test(document.querySelector('[data-pane-id="pane-net"] .pane-connection').textContent),null,{timeout:10000});
  const shown=await line.textContent();
  check('a repeated failure reports a connection problem in plain words',()=>{
   assert.match(shown,/reconnecting/);
   assert.match(shown,/Connection interrupted/,'the browser\'s "Failed to fetch" should not be shown raw: '+shown);
  });
  const before=served;
  await page.waitForFunction(()=>document.querySelector('[data-pane-id="pane-net"] .pane-connection').textContent==='',null,{timeout:15000});
  const recovered=await page.evaluate(()=>document.querySelector('[data-pane-id="pane-net"] .pane-connection').textContent);
  check('the notice clears as soon as polling recovers',()=>{
   assert.equal(recovered,'');
   assert.ok(served>before,'polling did not resume');
  });

  // The terminal kept its output through all of it.
  const text=await paneText(page.locator('[data-pane-id="pane-net"]'));
  check('output from before the interruption is still on screen',()=>assert.match(text,/agent ready/));
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: a dropped output poll stays quiet once, reports plainly when it repeats, and clears when the terminal recovers');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
