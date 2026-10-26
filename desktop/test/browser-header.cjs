const {chromium}=require('../../node_modules/playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const browser=await chromium.launch({channel:'chrome'});
 try{
  const page=await browser.newPage();
  await page.route('http://fixture.test/**',async route=>{
   const pathname=new URL(route.request().url()).pathname;
   if(pathname==='/config.js')return route.fulfill({contentType:'application/javascript',body:'window.AGENT_DESK_CONFIG={development:false,accounts:[]};'});
   if(pathname.startsWith('/api/'))return route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture offline"}'});
   const file=path.join(__dirname,'../../agent_desk/static',pathname==='/'?'index.html':pathname);
   await route.fulfill({path:file});
  });
  await page.goto('http://fixture.test/');
  for(const width of [1280,520,480]){
   await page.setViewportSize({width,height:850});
   assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('desktop-mac')),false);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  }
  await page.locator('#app-fullscreen').click();await page.waitForFunction(()=>!!document.fullscreenElement);
  await page.evaluate(()=>document.exitFullscreen());await page.waitForFunction(()=>document.querySelector('#app-fullscreen').getAttribute('aria-pressed')==='false');
  console.log('PASS: browser widths and browser-owned fullscreen preserved.');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
