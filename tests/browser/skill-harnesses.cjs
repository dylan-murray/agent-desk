// Every skill in the Skills tab is harness agnostic.
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[],syncs=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 const evidence=process.env.AGENT_DESK_FEEDBACK_EVIDENCE_DIR;
 const harnesses=[{id:'codex',label:'Codex'},{id:'codex-personal',label:'Codex · Personal'},{id:'claude',label:'Claude Code'},{id:'claude-personal',label:'Claude Code · Personal'},{id:'grok',label:'Grok'}];
 const every=value=>Object.fromEntries(harnesses.map(h=>[h.id,value]));
 const mk=(id,o={})=>({id,name:id,description:'Does '+id,path:'/skills/'+id+'/SKILL.md',content:'# '+id,availability:{...every(true),'claude-personal':false},explicit_only:false,portability:[],conflicts:[],sources:[],...o});
 let skills=[mk('example-pr-writer'),mk('example-planner',{explicit_only:true,portability:['Depends on a /example-questioner skill that is not installed for any harness.']}),mk('code-review')],added=[];
 await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
  if(path==='/api/skills/discover')return route.fulfill({json:{root:'/home/example/projects',skills:[{name:'local-review',path:'/home/example/projects/local-review',installed:false}],truncated:false}});
  if(path==='/api/skills/add'){added.push(route.request().postDataJSON());skills.push(mk('local-review',{path:'/home/example/projects/local-review/SKILL.md',availability:every(true)}));return route.fulfill({json:{skills,harnesses,linked:[],conflicts:[]}});}
  if(path==='/api/skills/sync'){syncs.push(route.request().headers()['x-agent-desk-terminal']||'');skills=skills.map(s=>({...s,availability:every(true)}));return route.fulfill({json:{linked:[{path:'/home/.claude-personal/skills/example-pr-writer',source:'/skills/example-pr-writer',status:'linked'},{path:'/home/.claude-personal/skills/example-planner',source:'/skills/example-planner',status:'linked'},{path:'/home/.claude-personal/skills/code-review',source:'/skills/code-review',status:'linked'}],conflicts:[],harnesses,skills}});}
  const data={'/api/skills':{harnesses,skills},'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
   '/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/coordinator-events':{tasks:[]}};
  return route.fulfill({json:data[path]||{}});});
 await page.goto(APP,{waitUntil:'domcontentloaded'});await page.locator('#open-skills').click();
 await page.waitForFunction(()=>document.querySelectorAll('.skill-item').length===3);
 // The page says how far from agnostic the library is and offers the fix.
 assert.equal(await page.locator('#skills-status').innerText(),'3 skills on this machine · 3 gaps across 5 agents');
 assert.equal(await page.locator('#skills-sync').isVisible(),true);
 const first=page.locator('.skill-item').first();
 assert.deepEqual(await first.locator('.skill-source').allInnerTexts(),['Codex','Codex · Personal','Claude','Claude · Personal','Grok']);
 assert.equal(await first.locator('.skill-source.off').innerText(),'Claude · Personal');
 assert.deepEqual(await page.locator('#skill-availability .skill-harness.off').allInnerTexts(),['— Claude Code · Personal']);
 assert.equal(await page.locator('#skill-availability .skill-harness.on').count(),4);
 // An explicit-only skill with a missing dependency says both.
 const planner=page.locator('.skill-item').filter({hasText:'example-planner'});
 assert.equal(await planner.locator('.skill-source.tag').innerText(),'Explicit');
 assert.equal(await planner.locator('.skill-source.warn').innerText(),'1 caveat');
 await planner.click();
 assert.equal(await page.locator('#skill-explicit').isVisible(),true);
 assert.match(await page.locator('#skill-portability').innerText(),/\/example-questioner skill that is not installed/);
 await page.waitForTimeout(400);await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agentdesk-skill-harnesses-before.png')});
 // One click links everything, through the authenticated route, and the gaps close in place.
 await page.locator('#skills-sync').click();
 await page.waitForFunction(()=>document.getElementById('skills-sync').hidden);
 assert.equal(syncs.length,1);assert.equal(syncs[0],'fixture','the sync ran without terminal authentication');
 assert.equal(await page.locator('#skills-status').innerText(),'3 skills on this machine · every one available to all 5 agents');
 assert.match(await page.locator('#skill-location').innerText(),/\/skills\/example-planner\/SKILL\.md/);
 assert.equal(await page.locator('.skill-source.off').count(),0);
 assert.equal(await page.locator('#skill-availability .skill-harness.on').count(),5,'the open skill did not refresh');
 assert.match(await page.locator('#toast').innerText(),/Linked 3 skills/);
 assert.equal(await page.locator('.skill-item[aria-pressed=true] strong').innerText(),'example-planner','the selection jumped');
 await page.locator('#skills-find-local').click();
 await page.locator('#skills-find-root').fill('/home/example/projects');
 await page.locator('#skills-find-scan').click();
 await page.getByText('/home/example/projects/local-review').waitFor();
 if(evidence)await page.screenshot({path:require('node:path').join(evidence,'2026-09-24-skills-finder-after.png')});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.ok(await page.locator('#skills-find-dialog').evaluate(d=>d.getBoundingClientRect().right<=innerWidth));
 await page.waitForTimeout(150);
 if(evidence)await page.screenshot({path:require('node:path').join(evidence,'2026-09-24-skills-finder-after-narrow.png')});
 await page.locator('#annotation-launcher').click();
 await page.waitForFunction(()=>document.getElementById('annotation-layer').parentElement.id==='skills-find-dialog');
 await page.keyboard.press('Escape');
 assert.equal(await page.locator('#skills-find-dialog').evaluate(d=>d.open),true);
 assert.equal(await page.locator('.skills-find-result').count(),1);
 await page.setViewportSize({width:1500,height:950});
 await page.locator('.skills-find-result button').click();
 await page.waitForFunction(()=>document.querySelectorAll('.skill-item').length===4);
 assert.deepEqual(added,[{path:'/home/example/projects/local-review'}]);
 assert.equal(await page.locator('.skills-find-result button').innerText(),'Added');
 await page.locator('#skills-find-close').click();
 await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agentdesk-skill-harnesses-after.png')});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(errors,[]);
 console.log('PASS: per-agent skill availability, explicit-only and caveats, gap count, authenticated sync, local discovery and add, phone width; mocked APIs');
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exit(1);});
