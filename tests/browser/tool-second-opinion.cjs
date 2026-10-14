// A review tool docked in its coordinator's pane asks other agents for independent reviews from the dock bar.
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[],mutations=[];await withAccounts(page);page.on('pageerror',e=>errors.push(e.message));
 const uis=[{id:'one',title:'Review one',skill:'code-review',agent_id:'coordinator',url:'http://127.0.0.1:49001/one',endpoint:'/apps/one',status:'running',managed:true,context:'/tmp/one'},
  {id:'notes',title:'Notes',skill:'readme-review',agent_id:'worker',url:'http://127.0.0.1:49001/notes',endpoint:'/apps/notes',status:'running',managed:true,context:'/tmp/notes.md'}];
 const agents=[{id:'coordinator',name:'Coordinator fixture',controller:true},{id:'worker',name:'Worker fixture'}].map(a=>({...a,terminal_id:a.id,source:'terminal',exit_code:null,cwd:'/tmp',harness:'claude',project:'fixture',status:'idle',events:[],task:'Interactive terminal',updated:1}));
 await page.route('http://127.0.0.1:49001/**',r=>r.fulfill({contentType:'text/html',body:'<input id="draft" placeholder="Feedback">'}));
 await page.route('**/api/**',r=>{const path=new URL(r.request().url()).pathname;
  if(path==='/api/coordinators/reviewers')return r.fulfill({json:{profiles:[{id:'claude',label:'Claude'},{id:'grok',label:'Grok'}]}});
  if(path==='/api/coordinators/second-opinion'){const p=r.request().postDataJSON();assert.deepEqual(p.profiles,['claude','grok']);assert.equal(p.tool_id,'one');assert.equal(p.id,'coordinator');mutations.push(path);return r.fulfill({json:{workers:['worker-1','worker-2']}});}
  if(r.request().method()==='POST'&&path!=='/api/feedback')mutations.push(path);
  const data={'/api/agents':{agents},'/api/feedback':{notes:[],deleted:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/skill-uis':{uis},'/api/special-agents':{roles:[],runs:[],inbox:[]},'/api/workflows':{configs:[],workflows:[],flows:[],executions:[]}};
  return r.fulfill({json:data[path]||{}});});
 await page.addInitScript(()=>sessionStorage.setItem('agent-desk-panes-live',JSON.stringify(['coordinator','worker'])));
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');
 for(const id of ['coordinator','worker']){await page.locator(`[data-pane-id="${id}"] .pane-tool-toggle`).click();await page.waitForSelector(`[data-pane-id="${id}"] .pane-dock:not([hidden])`);}
 assert.equal(await page.locator('[data-pane-id="worker"] .pane-dock-review').isHidden(),true,'only a review tool offers second opinions');
 await page.locator('[data-pane-id="coordinator"] .pane-dock-review').click();
 const dialog=page.getByRole('dialog',{name:'Request second opinions'});await dialog.waitFor();await dialog.getByLabel('Claude').check();await dialog.getByLabel('Grok',{exact:true}).check();
 await page.setViewportSize({width:390,height:844});assert.ok((await dialog.boundingBox()).width<=390);
 await dialog.getByRole('button',{name:'Start reviews'}).click();await dialog.waitFor({state:'hidden'});assert.deepEqual(mutations,['/api/coordinators/second-opinion']);assert.deepEqual(errors,[]);console.log('PASS: second opinion from a docked review tool, multiple reviewer selection and launch request, desktop/mobile');
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
