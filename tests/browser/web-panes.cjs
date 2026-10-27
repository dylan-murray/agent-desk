// Web pages open in a pane like the coordinator pane, chosen from the New terminal menu. New opens a
// menu; a web page opens in a pane beside terminals; a page that refuses framing or cannot be
// reached says so in the pane instead of showing the browser's bare "refused to connect".
const {chromium}=require('playwright');const assert=require('node:assert/strict');const http=require('node:http');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const agent=id=>({id,name:'Adapter '+id.slice(-1),cwd:'/tmp/'+id,harness:'codex',status:'idle',source:'adapter',
  task:'Fixture session',project:'fixture',events:[],question:null,updated:Date.now()/1000});
function site(headers){
  const server=http.createServer((request,response)=>{response.writeHead(200,{'Content-Type':'text/html',...headers});
    response.end('<!doctype html><title>Fixture</title><h1>Fixture page '+request.url+'</h1><button>Inside the frame</button>');});
  return new Promise(resolve=>server.listen(0,'127.0.0.1',()=>resolve(server)));
}
const panes=page=>page.$$eval('#terminal > .terminal-pane',nodes=>nodes.map(node=>node.dataset.paneId));
const stored=page=>page.evaluate(()=>JSON.parse(sessionStorage.getItem('agent-desk-web-pages')||'[]'));
async function openPage(page,address,name){
  await page.locator('#new-terminal').click();await page.locator('[data-new-pane="web"]').click();
  await page.locator('#web-page-url').fill(address);if(name)await page.locator('#web-page-name').fill(name);
  await page.locator('#web-page-form button[type=submit]').click();
}
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 const open=await site({}),deny=await site({'X-Frame-Options':'DENY'});
 const openUrl=`http://127.0.0.1:${open.address().port}/app`,denyHost=`127.0.0.1:${deny.address().port}`;
 const closed=await site({});const deadPort=closed.address().port;await new Promise(resolve=>closed.close(resolve));
 try{
  const context=await browser.newContext({viewport:{width:1500,height:900}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:[agent('web-fixture-a'),agent('web-fixture-b')]}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(()=>{if(window===top&&!sessionStorage.getItem('agent-desk-panes-live'))sessionStorage.setItem('agent-desk-panes-live','["web-fixture-a"]');});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('#terminal .terminal-pane');

  // The button is a menu button with two choices; the keyboard can open, move and dismiss it.
  const button=page.locator('#new-terminal'),menu=page.locator('#new-pane-options');
  const closedState=await button.evaluate(node=>[node.textContent.trim(),node.getAttribute('aria-haspopup'),node.getAttribute('aria-expanded')]);
  check('New is a closed menu button',()=>assert.deepEqual(closedState,['New','menu','false']));
  await button.click();
  const items=await menu.locator('[role=menuitem] strong').allTextContents();
  check('the menu offers a terminal or a web page',()=>assert.deepEqual(items,['Terminal','Web page']));
  await page.mouse.click(700,500);
  const outside=await menu.isHidden();
  check('an outside click closes the menu',()=>assert.equal(outside,true));
  await button.focus();await page.keyboard.press('ArrowDown');
  const firstFocus=await page.evaluate(()=>document.activeElement.dataset.newPane);
  await page.keyboard.press('ArrowDown');const secondFocus=await page.evaluate(()=>document.activeElement.dataset.newPane);
  await page.keyboard.press('ArrowDown');const wrapped=await page.evaluate(()=>document.activeElement.dataset.newPane);
  await page.keyboard.press('Escape');
  const afterEscape=await page.evaluate(()=>[document.activeElement.id,document.querySelector('#new-pane-options').hidden]);
  check('arrow keys walk the menu and wrap; Escape closes it and returns focus',()=>{
    assert.deepEqual([firstFocus,secondFocus,wrapped],['terminal','web','terminal']);assert.deepEqual(afterEscape,['new-terminal',true]);});
  await button.click();await page.locator('[data-new-pane="terminal"]').click();
  const launcher=await page.locator('#launch-terminal-dialog').evaluate(node=>node.open);
  check('Terminal opens the existing terminal launcher',()=>assert.equal(launcher,true));
  await page.locator('#launch-terminal-dialog .launch-dismiss').click();

  // Addresses are checked before a pane opens; only http(s) can reach a frame.
  const addresses=await page.evaluate(()=>['localhost:5173','localhost:3000/a?b=1','127.0.0.1:8080','[::1]:5173','example.com','example.com:8443/x','http://example.com','javascript:alert(1)','mailto:a@b.c','file:///etc/passwd','ftp://example.com','']
    .map(text=>{try{return webAddress(text);}catch(error){return '! '+error.message;}}));
  check('addresses default to http for local hosts and ports, https otherwise, and refuse other schemes',()=>assert.deepEqual(addresses,[
    'http://localhost:5173/','http://localhost:3000/a?b=1','http://127.0.0.1:8080/','http://[::1]:5173/','https://example.com/','http://example.com:8443/x','http://example.com/',
    '! Web pages must use an http or https address','! Web pages must use an http or https address','! Web pages must use an http or https address','! Web pages must use an http or https address','! Enter a web address']));
  await openPage(page,'javascript:alert(1)');
  const refused=await page.locator('#web-page-error').textContent();
  check('a non-web address is refused in the dialog',()=>assert.match(refused,/http or https/));
  await page.locator('#web-page-dialog .launch-dismiss').click();

  await openPage(page,openUrl.replace('http://',''),'Preview');
  const frame=page.locator('.web-pane iframe');
  await page.frameLocator('.web-pane iframe').locator('h1').waitFor();
  const first=await page.locator('.web-pane').evaluate(node=>({title:node.querySelector('.pane-title').textContent,address:node.querySelector('.pane-directory').textContent,
    href:node.querySelector('.pane-open').href,icons:[...node.querySelectorAll('.pane-icon')].map(n=>n.getAttribute('aria-label')),focused:node.classList.contains('focused'),
    sandbox:node.querySelector('iframe').getAttribute('sandbox')}));
  check('a bare host:port opens over http in a new focused pane beside the session',()=>{
    assert.equal(first.address,openUrl);assert.equal(first.href,openUrl);assert.equal(first.title,'Preview');assert.equal(first.focused,true);
    assert.deepEqual(first.icons,['Reload page','Open in a new tab','Full screen','Close web page']);
    assert.doesNotMatch(first.sandbox,/allow-top-navigation/,'a framed page could navigate Agent Desk away');});
  const sessionRows=await page.locator('.session-row').count(),count=await page.locator('#agent-count').textContent();
  check('a web page is not an agent session',()=>{assert.equal(sessionRows,2);assert.equal(count,'2');});

  // Focus inside the frame still selects the pane.
  await page.locator('[data-pane-id="web-fixture-a"] .pane-body').click();
  const box=await frame.boundingBox();await page.mouse.click(box.x+60,box.y+80);
  const followed=await page.waitForFunction(()=>document.querySelector('.web-pane').classList.contains('focused'),null,{timeout:3000}).then(()=>true,()=>false);
  check('clicking into the page focuses its pane',()=>assert.equal(followed,true));

  // A session row never replaces a web page pane: it has no row to come back from.
  await page.locator('.session-row[data-agent-id="web-fixture-b"]').click();
  const afterRow=await panes(page);
  check('choosing a session while a web page is focused adds a pane',()=>assert.equal(afterRow.length,3));

  // Rename and change the address in place.
  const webId=(await stored(page))[0].id;
  await page.locator('.web-pane .pane-title').click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('Docs');await page.keyboard.press('Enter');
  await page.locator('.web-pane .pane-directory').click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type(openUrl+'/next');await page.keyboard.press('Enter');
  await page.frameLocator('.web-pane iframe').locator('h1',{hasText:'/app/next'}).waitFor();
  const edited=(await stored(page))[0];
  check('the title renames and the address line navigates the pane',()=>{assert.equal(edited.name,'Docs');assert.equal(edited.url,openUrl+'/next');});
  await page.locator('.web-pane .pane-directory').click();await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type('file:///etc/passwd');await page.keyboard.press('Enter');
  const kept=(await stored(page))[0].url,toastText=await page.locator('#toast').textContent();
  check('an invalid address keeps the page and says why',()=>{assert.equal(kept,openUrl+'/next');assert.match(toastText,/http or https/);});

  // Reload re-requests the page.
  let requests=0;open.on('request',()=>requests++);
  await page.locator('.web-pane').hover();await page.locator('.web-pane .pane-reload').click();
  await page.waitForTimeout(500);
  check('Reload requests the page again',()=>assert.ok(requests>=1,'no request reached the site'));

  // Pages that refuse framing, and servers that are down, explain themselves.
  await openPage(page,denyHost+'/blocked');
  const blocked=page.locator('.web-pane.focused');
  await blocked.locator('.web-pane-notice:not([hidden]) h2').waitFor();
  const blockedState=await blocked.evaluate(node=>({h2:node.querySelector('.web-pane-notice h2').textContent,frame:node.querySelector('iframe').hidden,
    code:node.querySelector('.web-pane-notice code').textContent,link:node.querySelector('.web-pane-notice a').href}));
  check('a page that refuses framing says so and offers a new tab',()=>{
    assert.equal(blockedState.h2,denyHost+' can’t be shown in a pane');assert.equal(blockedState.frame,true);
    assert.equal(blockedState.code,'X-Frame-Options: DENY');assert.equal(blockedState.link,'http://'+denyHost+'/blocked');});
  const full=await panes(page);
  check('the fourth pane fills the grid',()=>assert.equal(full.length,4));

  await blocked.locator('.pane-close').click();
  await openPage(page,'localhost:'+deadPort);
  const dead=page.locator('.web-pane.focused');
  await dead.locator('.web-pane-notice:not([hidden]) h2').waitFor();
  const deadState=await dead.evaluate(node=>({h2:node.querySelector('.web-pane-notice h2').textContent,p:node.querySelector('.web-pane-notice p').textContent}));
  check('a server that is not running is named with the reason',()=>{assert.equal(deadState.h2,'Couldn’t reach localhost:'+deadPort);assert.match(deadState.p,/refused/i);});
  await dead.locator('.web-pane-anyway').click();
  const shown=await dead.evaluate(node=>[node.querySelector('iframe').hidden,node.querySelector('.web-pane-notice').hidden]);
  check('Show the page anyway reveals the frame',()=>assert.deepEqual(shown,[false,true]));

  // Pane state survives a reload; closing a web page forgets it.
  await page.screenshot({path:require('node:path').join(require('node:os').tmpdir(),'agent-desk-web-panes.png')});
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.web-pane');
  const restored=await page.$$eval('.web-pane .pane-title',nodes=>nodes.map(node=>node.textContent));
  check('web panes come back after a reload',()=>assert.deepEqual(restored,['localhost:'+deadPort,'Docs']));
  await page.locator(`[data-pane-id="${webId}"] .pane-close`).click();
  const forgotten=(await stored(page)).map(item=>item.id),left=await panes(page);
  check('closing a web pane closes the page',()=>{assert.ok(!forgotten.includes(webId));assert.ok(!left.includes(webId));});

  // A frame must not swallow a pane drag passing over it.
  const order=await panes(page);
  const from=await page.locator('#terminal > .terminal-pane').nth(0).locator('.terminal-bar').boundingBox();
  const to=await page.locator('#terminal > .terminal-pane').nth(order.length-1).boundingBox();
  await page.mouse.move(from.x+from.width*0.45,from.y+from.height/2);await page.mouse.down();
  await page.mouse.move(from.x+from.width*0.45+30,from.y+from.height/2,{steps:6});
  await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:18});await page.mouse.up();
  const swapped=await panes(page);
  check('dragging a header across a web page swaps the panes',()=>{assert.equal(swapped[0],order[order.length-1]);assert.equal(swapped[order.length-1],order[0]);});

  // Annotation pins land on a web page instead of disappearing into its frame.
  await openPage(page,openUrl);await page.frameLocator('.web-pane.focused iframe:not([hidden])').locator('h1').waitFor();
  await page.locator('#annotation-launcher').click();
  const target=await page.locator('.web-pane.focused iframe:not([hidden])').boundingBox();
  await page.mouse.click(target.x+target.width/2,target.y+target.height/2);
  const pinned=await page.locator('#annotation-target').textContent();
  check('a pin can be placed over a web page',()=>assert.match(pinned,/^Pin/));
  await page.keyboard.press('Escape');await page.locator('#annotation-launcher').click();

  // Narrow layouts keep the menu on screen.
  for(const width of [760,390]){
   await page.setViewportSize({width,height:800});await page.locator('#new-terminal').scrollIntoViewIfNeeded();await page.locator('#new-terminal').click();
   const rect=await menu.evaluate(node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,shown:!node.hidden&&r.width>0};});
   check(`the menu stays inside a ${width}px viewport`,()=>{assert.ok(rect.shown,'the menu did not open');assert.ok(rect.left>=0,'menu starts off screen at '+rect.left);assert.ok(rect.right<=width,'menu ends off screen at '+rect.right);});
   await page.keyboard.press('Escape');
   const dismissed=await menu.isHidden();
   check(`Escape closes the menu opened by a click at ${width}px`,()=>assert.equal(dismissed,true));
  }
  check('no page errors',()=>assert.deepEqual(errors,[]));
 }finally{await browser.close();open.close();deny.close();}
 if(failures.length){console.error(failures.length+' web pane check(s) failed');process.exit(1);}
 console.log('web pane checks passed');
})().catch(error=>{console.error(error);process.exit(1);});
