// The annotate button can be dragged anywhere, and the spot is remembered.
const {chromium}=require('playwright');const assert=require('node:assert/strict');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1300,height:850}});
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',route=>{const path=new URL(route.request().url()).pathname;
   const data={'/api/agents':{agents:[]},'/api/feedback':{notes:[],deleted:[]},'/api/special-agents':{roles:[],runs:[],inbox:[]},
    '/api/workflows':{configs:[],workflows:[],flows:[],executions:[]},'/api/terminal-auth':{token:'fixture',cwd:'/tmp'},
    '/api/skill-uis':{uis:[]},'/api/tool-launchers':{launchers:[]},'/api/skills':{skills:[]},'/api/coordinator-events':{tasks:[]}};
   return route.fulfill({json:data[path]||{}});});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  const launcher=page.locator('#annotation-launcher');
  await launcher.waitFor();
  const box=async locator=>{const rect=await locator.boundingBox();return {x:Math.round(rect.x),y:Math.round(rect.y),w:Math.round(rect.width),h:Math.round(rect.height)};};
  const corner=await box(launcher);
  const drag=async(toX,toY)=>{const rect=await launcher.boundingBox();
   await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2);
   await page.mouse.down();await page.mouse.move(toX,toY,{steps:12});await page.mouse.up();await page.waitForTimeout(150);};

  await drag(900,200);
  const moved=await box(launcher);
  check('dragging the button moves it',()=>{
   assert.notDeepEqual({x:moved.x,y:moved.y},{x:corner.x,y:corner.y});
   assert.ok(Math.abs(moved.x+moved.w/2-900)<3&&Math.abs(moved.y+moved.h/2-200)<3,'it did not land under the pointer: '+JSON.stringify(moved));
  });
  const annotatingAfterDrag=await page.evaluate(()=>document.body.classList.contains('annotating'));
  check('dragging never toggles annotate mode',()=>assert.equal(annotatingAfterDrag,false));

  await page.reload();
  await launcher.waitFor();
  await page.waitForFunction(()=>getComputedStyle(document.getElementById('annotation-launcher')).top!=='auto');
  const remembered=await box(launcher);
  check('the place it was dropped is remembered across a reload',()=>assert.deepEqual({x:remembered.x,y:remembered.y},{x:moved.x,y:moved.y}));

  // A plain click still does what it always did, and the toolbar follows the button.
  await launcher.click();
  await page.waitForSelector('#annotation-toolbar:not(.hidden)');
  const toolbar=await box(page.locator('#annotation-toolbar'));
  const annotatingAfterClick=await page.evaluate(()=>document.body.classList.contains('annotating'));
  check('clicking still starts annotating',()=>assert.equal(annotatingAfterClick,true));
  check('the toolbar follows the button instead of staying in the corner',()=>{
   assert.ok(Math.abs(toolbar.x-remembered.x)<=4,'toolbar x '+toolbar.x+' vs button '+remembered.x);
   assert.ok(toolbar.y>=remembered.y-toolbar.h-14&&toolbar.y<=remembered.y+remembered.h+14,'toolbar is not beside the button: '+JSON.stringify(toolbar));
   assert.ok(toolbar.x>=0&&toolbar.y>=0&&toolbar.x+toolbar.w<=1300&&toolbar.y+toolbar.h<=850,'the toolbar hangs off screen');
  });
  await page.keyboard.press('Escape');

  // A smaller window must not strand it off screen.
  await page.setViewportSize({width:500,height:600});
  await page.waitForTimeout(250);
  const small=await box(launcher);
  check('a smaller window keeps it on screen',()=>{
   assert.ok(small.x>=0&&small.y>=0&&small.x+small.w<=500&&small.y+small.h<=600,'it ended up off screen: '+JSON.stringify(small));
  });

  // Double-click puts it back.
  await launcher.dblclick();
  await page.waitForTimeout(200);
  const reset=await box(launcher);
  const stored=await page.evaluate(()=>localStorage.getItem('agent-desk-annotation-launcher'));
  check('double-click returns it to its corner and forgets the position',()=>{
   assert.equal(stored,null);
   assert.ok(reset.x<=20,'it is not back at the left edge: '+JSON.stringify(reset));
   assert.ok(reset.y+reset.h>=600-20,'it is not back at the bottom: '+JSON.stringify(reset));
  });
  check('no page errors',()=>assert.deepEqual(errors,[]));
  if(failures.length)throw Error(failures.length+' checks failed: '+failures.join(', '));
  console.log('PASS: the annotate button drags, remembers where it was dropped, keeps its click, carries its toolbar, stays on screen and resets');
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exit(1);});
