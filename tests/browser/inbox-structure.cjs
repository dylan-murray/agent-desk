const evidence=require('./evidence.cjs');
const {chromium}=require('playwright');const withAccounts=require('./accounts-fixture.cjs');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH,headless:true});try{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();await withAccounts(page);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const diagram=`<title>Report pipeline</title><style>.step{padding:14px 18px;border:1px solid #9ccaff40;border-radius:10px;background:#9ccaff08;color:#c8c8c6}</style><div class="step"><b>01 · Worker reports</b></div>`;
 const detail=['# Friday build debrief',
  '',
  '**Short version:** the nightly build is green after four red runs, and the flaky suite is the reason to stay careful rather than call it fixed.',
  '',
  '*Sample report. Figures are from the last nightly run.*',
  '',
  '---',
  '',
  '## 1. Where things stand',
  '',
  '| | Level | Note |',
  '|---|---:|:---|',
  '| Build & test | 1,204 | 4th straight pass |',
  '| Flaky tests | 16 | Pipe \\| inside a cell |',
  '',
  '## Signals',
  '',
  '> Watch the retry rate. A 5% jump changes the plan.',
  '',
  '### Cache and the slow suite',
  '',
  '- **Why it spiked:** cache misses on the integration runners.',
  '- **Why it eased today:**',
  '  - A cache fix is expected Monday.',
  '  - The meeting is *not confirmed*.',
  '- Read `config.py` before the next pass.',
  '',
  '#### Fine print',
  '',
  'A literal `**not bold**` span and a **bold `call()` span** stay readable.',
  '',
  '<script>window.reportEscaped=true</script>',
  '',
  '<div onclick="window.reportEscaped=true">Raw HTML stays text.</div>',
  '',
  '```html-diagram',
  diagram,
  '```'].join('\n');
 const store={roles:[{id:'watcher',name:'Build watch',kind:'watcher'}],runs:[],inbox:[{id:'structure-report',event_key:'source:structure',role_id:'watcher',title:'Friday build debrief',detail,state:'review',created:1788980000,findings:[]}]};
 await context.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;const data={'/api/special-agents':store,'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/tool-launchers':{launchers:[]},'/api/skill-uis':{uis:[]},'/api/skills':{skills:[]}};return route.fulfill({json:data[path]||{}});});
 await page.goto(process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/');
 await page.locator('#open-inbox').click();await page.locator('.inbox-row').first().click();
 const body=page.locator('#inbox-detail .inbox-body');await body.locator('table').waitFor();

 // Hierarchy: one title, sections, subsections and fine print all distinct.
 assert.equal(await body.locator('h1.document-title').count(),1);
 assert.equal(await body.locator('h2.document-section').count(),2);
 assert.match(await body.locator('h2').first().textContent(),/01Where things stand/);
 assert.equal(await body.locator('h2').nth(1).textContent(),'Signals');
 assert.equal(await body.locator('h3').first().textContent(),'Cache and the slow suite');
 assert.equal(await body.locator('h4').first().textContent(),'Fine print');
 const sizes=await body.evaluate(n=>['h1','h2','h3','h4','p'].map(tag=>parseFloat(getComputedStyle(n.querySelector(tag)).fontSize)));
 assert.ok(sizes[0]>sizes[1]&&sizes[1]>sizes[2]&&sizes[2]>sizes[3],'heading scale descends: '+sizes);

 // Pipe tables become real tables with the authored alignment; no raw pipes remain.
 assert.equal(await body.locator('table').count(),1);
 assert.deepEqual(await body.locator('thead th').allTextContents(),['','Level','Note']);
 assert.equal(await body.locator('tbody tr').count(),2);
 assert.deepEqual(await body.locator('tbody tr').first().locator('td').allTextContents(),['Build & test','1,204','4th straight pass']);
 assert.equal(await body.locator('tbody tr').nth(1).locator('td').nth(2).textContent(),'Pipe | inside a cell');
 const alignment=await body.locator('tbody tr').first().evaluate(row=>[...row.children].map(cell=>getComputedStyle(cell).textAlign));
 assert.deepEqual(alignment,['start','right','left']);
 assert.equal(await page.locator('#inbox-detail p, #inbox-detail li').evaluateAll(nodes=>nodes.filter(n=>n.textContent.trim().startsWith('|')).length),0);

 // Emphasis, callouts, rules and nesting.
 assert.equal(await body.locator('p.document-lede').count(),1);
 assert.match(await body.locator('p.document-lede strong').textContent(),/^Short version:$/);
 assert.equal(await body.locator('p.document-aside').count(),1);
 assert.equal(await body.locator('hr.document-rule').count(),1);
 assert.equal(await body.locator('blockquote.document-callout').count(),1);
 assert.match(await body.locator('blockquote.document-callout p').textContent(),/Watch the retry rate/);
 assert.equal(await body.locator('ul ul > li').count(),2);
 assert.equal(await body.locator('ul ul em').textContent(),'not confirmed');
 const lede=await body.locator('p.document-lede').evaluate(n=>[parseFloat(getComputedStyle(n).fontSize),getComputedStyle(n).borderLeftStyle]);
 assert.ok(lede[0]>16&&lede[1]==='solid','the opening summary is promoted: '+lede);

 // Untrusted report text never becomes markup, and code spans stay literal.
 assert.equal(await body.locator('script, div[onclick]').count(),0);
 assert.match(await body.textContent(),/Raw HTML stays text\./);
 assert.equal(await page.evaluate(()=>window.reportEscaped),undefined);
 assert.equal(await body.locator('code').filter({hasText:'**not bold**'}).count(),1);
 assert.equal(await body.locator('strong code').textContent(),'call()');

 // html-diagram blocks keep their sandboxed frame beside the new structures.
 const frame=body.locator('.document-diagram iframe');
 assert.equal(await frame.getAttribute('sandbox'),'');
 await page.frameLocator('.document-diagram iframe').locator('.step').waitFor();
 assert.equal(await body.locator('.document-diagram-source code').count(),1);

 await page.screenshot({path:evidence('inbox-structure-after.png')});
 await page.locator('#inbox-detail').screenshot({path:evidence('inbox-structure-detail.png')});
 await page.setViewportSize({width:390,height:844});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow on mobile');
 await page.locator('#inbox-detail').scrollIntoViewIfNeeded();
 await page.screenshot({path:evidence('inbox-structure-mobile.png')});
 assert.deepEqual(errors,[]);
 console.log('PASS: heading scale, pipe tables with alignment and escapes, opening summary, italic aside, callout, thematic rule, nested lists, literal code spans, inert HTML, sandboxed diagram, mobile; mocked APIs');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
