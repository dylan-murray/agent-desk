const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage(),sent=[];let release;const gate=new Promise(r=>release=r);
 await page.addInitScript(()=>{localStorage.setItem('agent-desk-feedback',JSON.stringify([{id:'deleted-fixture',note:'An old annotation',page:'Agents',mode:'live',selector:'body',viewport:{width:100,height:100},point:{viewportX:10,viewportY:10},bounds:{x:0,y:0,width:100,height:100}}]));});
 await page.route('**/api/feedback',async route=>{await gate;if(route.request().method()==='POST')sent.push(route.request().postDataJSON());await route.fulfill({json:{notes:[],deleted:['deleted-fixture']}})});
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/',{waitUntil:'domcontentloaded'});await page.waitForTimeout(200);assert.equal(await page.locator('.feedback-pin').count(),0);assert.equal(await page.locator('#feedback-count').textContent(),'0');release();await page.waitForFunction(()=>document.getElementById('feedback-sync').textContent.startsWith('Saved to workspace'));
 assert.equal(await page.locator('.feedback-pin').count(),0);assert.ok(sent.every(p=>p.notes.length===0));assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('agent-desk-feedback')).length),0);
 console.log('PASS: cached deleted annotations never flash or upload before tombstone reconciliation');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
