// The Tools page folds into Skills, since a running tool is always attached to an agent session.
// Skills marks skills that have a tool,
// launches one beside a new agent pane, and starts an agent session to build a new tool.
require('./check-isolated-url.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const page=await browser.newPage({viewport:{width:1500,height:900}}),errors=[],calls=[];await withAccounts(page);
  page.on('pageerror',error=>errors.push(error.message));
  const skills=[{id:'readme-review',name:'readme-review',description:'Annotate a README.',path:'/home/me/.agents/skills/readme-review/SKILL.md',content:'# readme',availability:{claude:true},portability:[]},
   {id:'scratchpad',name:'scratchpad',description:'A shared scratchpad.',path:'/home/me/.agents/skills/scratchpad/SKILL.md',content:'# s',availability:{claude:true},portability:[]},
   {id:'example-pr-writer',name:'example-pr-writer',description:'Write PR descriptions.',path:'/home/me/.agents/skills/example-pr-writer/SKILL.md',content:'# pr',availability:{claude:true},portability:[]}];
  const agents=[];let uis=[];const harnesses=[{id:'claude',label:'Claude Code'},{id:'codex',label:'Codex'}];
  skills.forEach(skill=>skill.availability={claude:true,codex:true});
  await page.route('http://127.0.0.1:49501/**',route=>route.fulfill({contentType:'text/html',body:'<h1>README tool</h1>'}));
  await page.route('**/api/**',route=>{const request=route.request(),path=new URL(request.url()).pathname,body=request.method()==='POST'?request.postDataJSON():null;
   if(path==='/api/tools/launch'){calls.push([path,body]);
    if(body.target==='/missing.md')return route.fulfill({status:400,json:{error:'Target must be an existing file'}});
    const ui={id:'readme-review-abc',title:'Markdown annotations · README.md',skill:'readme-review',url:'http://127.0.0.1:49501/',endpoint:'/apps/readme-review-abc',context:body.target,managed:true,status:'running',...(body.agent_id?{agent_id:body.agent_id}:{})};
    uis=[ui];return route.fulfill({json:ui});}
   if(path==='/api/skills/sync'){calls.push([path,body]);skills.forEach(skill=>skill.availability={claude:true,codex:true});return route.fulfill({json:{skills,harnesses,linked:[],conflicts:[]}});}
   if(path==='/api/terminals/launch'){calls.push([path,body]);
    const session={id:'terminal-'+(agents.length+1),terminal_id:'terminal-'+(agents.length+1),name:body.name,cwd:body.cwd,harness:'claude',status:'idle',source:'terminal',exit_code:null,task:'Interactive terminal',events:[],updated:1};
    agents.push(session);return route.fulfill({json:session});}
   const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/home/me'},
    '/api/skill-uis':{uis},'/api/skills':{skills,harnesses},'/api/coordinator-events':{tasks:[]},
    '/api/tool-launchers':{launchers:[{id:'readme-review',title:'Markdown annotations',description:'Annotate a README or markdown document.',target:'file'},{id:'scratchpad',title:'Scratchpad',description:'Notes beside an agent.',target:'none'}]}};
   return route.fulfill({json:data[path]||{}});});
  await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live','[]'));
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  const tools=await page.locator('#open-tools').count();
  check('the header has no Tools destination',()=>assert.equal(tools,0));

  await page.locator('#open-skills').click();await page.waitForSelector('.skill-item');
  const tags=await page.$$eval('.skill-item',nodes=>nodes.map(node=>[node.querySelector('strong').textContent,!!node.querySelector('.skill-source.tool')]));
  check('skills that have a tool are marked in the list',()=>assert.deepEqual(tags,[['readme-review',true],['scratchpad',true],['example-pr-writer',false]]));
  await page.locator('.skill-item',{hasText:'scratchpad'}).click();
  const standalone=await page.locator('#skill-tool-target-field').isHidden();
  check('a tool that opens on nothing asks for no path',()=>assert.equal(standalone,true));
  await page.locator('.skill-item',{hasText:'example-pr-writer'}).click();
  const noPanel=await page.locator('#skill-tool-panel').isHidden();
  await page.locator('.skill-item',{hasText:'readme-review'}).click();
  const panel=await page.evaluate(()=>({hidden:document.getElementById('skill-tool-panel').hidden,title:document.getElementById('skill-tool-title').textContent,label:document.getElementById('skill-tool-target-label').textContent,agents:[...document.querySelectorAll('#skill-tool-agent option')].map(o=>o.textContent)}));
  check('a tool skill offers to launch its tool with a chosen agent',()=>{
   assert.equal(noPanel,true,'a skill without a tool shows no launcher');
   assert.equal(panel.hidden,false);assert.equal(panel.title,'Markdown annotations');assert.equal(panel.label,'File');
   assert.deepEqual(panel.agents,['Codex','Codex · Personal','Claude','Claude · Personal']);
  });

  await page.fill('#skill-tool-target','/missing.md');await page.click('#skill-tool-launch');
  await page.waitForFunction(()=>document.getElementById('skill-tool-error').textContent);
  const failed={error:await page.textContent('#skill-tool-error'),terminals:calls.filter(([path])=>path==='/api/terminals/launch').length};
  check('a bad path fails before any agent is started',()=>{assert.equal(failed.error,'Target must be an existing file');assert.equal(failed.terminals,0);});

  calls.length=0;
  await page.selectOption('#skill-tool-agent','claude-personal');
  await page.fill('#skill-tool-target','/home/me/repo/README.md');await page.click('#skill-tool-launch');
  await page.waitForSelector('[data-pane-id="terminal-1"] .pane-dock:not([hidden])');
  const launched=await page.evaluate(()=>({page:document.querySelector('#breadcrumb').textContent,frame:document.querySelector('[data-pane-id="terminal-1"] .pane-dock-frame').getAttribute('src'),chip:document.querySelector('[data-pane-id="terminal-1"] .pane-tool-toggle').textContent,webPanes:webPages.size}));
  const [first,terminal,owned]=calls;
  check('launching starts the tool, then a new agent beside it, then hands the tool to that agent',()=>{
   assert.deepEqual(calls.map(([path])=>path),['/api/tools/launch','/api/terminals/launch','/api/tools/launch']);
   assert.deepEqual(first[1],{skill:'readme-review',target:'/home/me/repo/README.md'});
   assert.equal(terminal[1].launch_profile,'claude-personal');assert.equal(terminal[1].cwd,'/home/me/repo');
   const prompt=terminal[1].argv.at(-1);
   assert.match(prompt,/already running at http:\/\/127\.0\.0\.1:49501\//);assert.match(prompt,/do not start another copy/);
   assert.match(prompt,/\/home\/me\/\.agents\/skills\/readme-review\/SKILL\.md/);
   assert.equal(owned[1].agent_id,'terminal-1');assert.equal(owned[1].id,'readme-review-abc');
  });
  check('the new agent pane opens with the tool docked, and the tool never opens on its own elsewhere',()=>{
   assert.equal(launched.page,'Agents');assert.equal(launched.frame,'http://127.0.0.1:49501/');
   assert.equal(launched.chip,'Markdown annotations · README.md');assert.equal(launched.webPanes,0);
  });

  calls.length=0;
  await page.locator('#open-skills').click();await page.click('#skills-build-tool');
  const remembered=await page.inputValue('#tool-build-agent');
  await page.fill('#tool-build-name','api-diff-review');await page.fill('#tool-build-purpose','Pin comments on changed endpoints.');
  await page.click('#tool-builder-form button[type=submit]');
  await page.waitForSelector('[data-pane-id="terminal-2"]');
  const build=calls.find(([path])=>path==='/api/terminals/launch')[1],buildPrompt=build.argv.at(-1);
  check('Build a tool starts an agent session in the skill library with a brief',()=>{
   assert.equal(remembered,'claude-personal','the agent last used for tools is remembered');
   assert.equal(build.cwd,'/home/me/.agents/skills');assert.equal(build.name,'Build tool · api-diff-review');
   assert.match(buildPrompt,/Pin comments on changed endpoints\./);assert.match(buildPrompt,/\/home\/me\/\.agents\/skills\/api-diff-review\//);
   assert.match(buildPrompt,/"runtime":"python-http"/);assert.match(buildPrompt,/"target":"file\|directory\|none"/);
   // The building agent decides what the tool opens on; the dialog does not ask.
   assert.match(buildPrompt,/Decide from that what the tool opens on: a file, a folder or repository, or nothing at all/);
   assert.match(buildPrompt,/readme-review skill at \/home\/me\/\.agents\/skills\/readme-review/);
  });
  const buildPage=await page.textContent('#breadcrumb');
  check('the builder opens on the desk',()=>assert.equal(buildPage,'Agents'));

  // The agent writes the skill into the shared folder, which only some agents read. Opening Skills shares it.
  calls.length=0;
  skills.push({id:'api-diff-review',name:'api-diff-review',description:'Pin comments on changed endpoints.',path:'/home/me/.agents/skills/api-diff-review/SKILL.md',content:'# api',availability:{claude:false,codex:true},portability:[]});
  await page.locator('#open-skills').click();
  await page.waitForFunction(()=>installedSkills.find(skill=>skill.id==='api-diff-review')?.availability.claude===true);
  await page.locator('#open-skills').click();await page.waitForTimeout(400);
  check('a tool an agent built is shared with every agent once it appears, and only once',()=>assert.deepEqual(calls.map(([path])=>path),['/api/skills/sync']));

  await page.setViewportSize({width:390,height:844});await page.locator('#open-skills').click();
  await page.locator('.skill-item',{hasText:'readme-review'}).click();
  const width=await page.evaluate(()=>document.documentElement.scrollWidth);
  check('Skills with its tool launcher fits a phone',()=>assert.equal(width,390));
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: Skills marks tools, launches one beside a new agent with the tool docked, fails bad paths early, and starts an agent to build a tool; no Tools page');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
