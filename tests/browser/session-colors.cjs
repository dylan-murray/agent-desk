// Session colors come from the project a session runs in: sessions in one repo (worktrees included)
// get close hues from the same band, and different repos land in different bands. Read back from the
// rendered sidebar and pane, not from the color function.
const {chromium}=require('playwright');const assert=require('node:assert/strict');const os=require('node:os');const path=require('node:path');
const APP=process.env.AGENT_DESK_TEST_URL||'http://127.0.0.1:4310/';
const OUT=process.env.AGENT_DESK_EVIDENCE_DIR||os.tmpdir();
const agent=(id,name,cwd,repo)=>({id,terminal_id:id,name,display_name:name,cwd,repo,harness:'claude',status:'idle',source:'terminal',runtime_status:true,
  task:'Interactive terminal',project:path.basename(repo||cwd),events:[],question:null,exit_code:null,updated:Date.now()/1000});
const DESK='/Users/fixture/projects/agent-desk',TRADER='/Users/fixture/projects/copytrader';
const AGENTS=[agent('color-a','Desk one',DESK,DESK),agent('color-b','Desk two',DESK+'/agent_desk/static',DESK),
  agent('color-c','Desk worktree',DESK+'/.claude/worktrees/fix-colors',DESK+'/.claude/worktrees/fix-colors'),
  agent('color-d','Trader one',TRADER,TRADER),agent('color-e','Trader two',TRADER,TRADER),agent('color-f','Scratch','/tmp/scratch',null)];
// The rendered --agent-color, resolved to oklch hue degrees by the browser.
const hues=page=>page.$$eval('.session-row',rows=>Object.fromEntries(rows.map(row=>{
  const color=getComputedStyle(row).getPropertyValue('--agent-color').trim(),match=color.match(/oklch\(\s*[\d.]+\s+[\d.]+\s+(-?[\d.]+)/);
  return [row.dataset.agentId,match?Number(match[1]):color];})));
const gap=(a,b)=>{const d=Math.abs(((a-b)%360+360)%360);return Math.min(d,360-d);};
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||undefined,headless:true});
 const failures=[];
 const check=(name,fn)=>{try{fn();console.log('  PASS  '+name);}catch(error){failures.push(name);console.log('  FAIL  '+name+' :: '+error.message);}};
 try{
  const context=await browser.newContext({viewport:{width:1440,height:900},deviceScaleFactor:2});
  const page=await context.newPage();const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/agents',route=>route.fulfill({json:{agents:AGENTS,demo:false}}));
  await page.route('**/api/feedback',route=>route.fulfill({json:{notes:[],deleted:[]}}));
  await page.addInitScript(()=>{localStorage.removeItem('agent-desk-groups-live');localStorage.removeItem('agent-desk-order-live');});
  await page.goto(APP,{waitUntil:'domcontentloaded'});
  await page.waitForSelector('.session-row[data-agent-id="color-f"]',{timeout:15000});await page.waitForTimeout(400);
  const hue=await hues(page);
  check('every session row has an oklch color',()=>Object.values(hue).forEach(value=>assert.equal(typeof value,'number',String(value))));
  check('sessions in one repo share a hue band',()=>{assert.ok(gap(hue['color-a'],hue['color-b'])<=20);assert.ok(gap(hue['color-d'],hue['color-e'])<=20);});
  check('a worktree joins its parent repo band',()=>assert.ok(gap(hue['color-a'],hue['color-c'])<=20));
  check('sessions in one repo are not forced identical',()=>assert.notEqual(hue['color-a'],hue['color-b']));
  check('different repos land in different bands',()=>assert.ok(gap(hue['color-a'],hue['color-d'])>=10,`${hue['color-a']} vs ${hue['color-d']}`));
  await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('.session-row[data-agent-id="color-f"]');await page.waitForTimeout(400);
  const again=await hues(page);
  check('colors are stable across reloads',()=>assert.deepEqual(again,hue));
  await page.screenshot({path:path.join(OUT,'session-colors.png'),clip:{x:0,y:0,width:420,height:620}});
  check('no page errors',()=>assert.deepEqual(errors,[]));
  console.log('hues',JSON.stringify(hue));
 }finally{await browser.close();}
 if(failures.length){console.error(failures.length+' failed');process.exit(1);}
})();
