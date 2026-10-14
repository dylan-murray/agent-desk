const {chromium}=require('playwright');const assert=require('node:assert/strict');
(async()=>{const browser=await chromium.launch({executablePath:process.env.CHROME_PATH || undefined,headless:true});try{
 const page=await browser.newPage({viewport:{width:1500,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(process.env.AGENT_DESK_TEST_URL || 'http://127.0.0.1:4310/');await page.locator('#open-special-agents').click();await page.locator('#new-special-agent').click();
 await page.locator('#special-name').fill('Watcher fixture');await page.locator('#special-scope').fill('Test fixtures only');await page.locator('#special-cwd').fill('/tmp');await page.locator('#special-choice').selectOption('custom');await page.locator('#special-command').fill('/usr/bin/true');await page.locator('#special-mode').selectOption('direct');await page.locator('#special-agent-form button[type=submit]').click();
 await page.locator('#special-roles h3').filter({hasText:'Watcher fixture'}).waitFor();await page.locator('#special-roles button').filter({hasText:'Run now'}).last().click();
 await page.waitForFunction(()=>agents.some(a=>a.name==='Watcher fixture'));
 const report=await page.evaluate(async()=>{const data=await terminalRequest('/api/special-agents');const run=data.runs[0];return terminalRequest('/api/special-agents/report',{run_id:run.id,state:'review',detail:'Fixture result. No external systems were accessed.'});});
 await page.locator('#open-inbox').click();await page.locator('.inbox-row').filter({hasText:'Watcher fixture'}).first().click();const waiting=Number(await page.locator('#review-count').textContent()||0);await page.locator('[data-inbox-action=done]').click();await page.waitForFunction(before=>Number(document.getElementById('review-count').textContent||0)===before-1,waiting);
 await page.reload();await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter=history]').click();await page.locator('.inbox-row').filter({hasText:'Watcher fixture'}).first().waitFor();assert.match(await page.locator('#inbox-list').innerText(),/Reviewed/);await page.locator('#open-special-agents').click();
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('#new-special-agent').isVisible(),true);assert.deepEqual(errors,[]);
 // Delete the fixture automation through the real endpoint, so the check leaves the
 // server as it found it and a second run cannot collide with the first.
 await page.setViewportSize({width:1500,height:950});
 // Counted rather than expected to be zero, so one left behind by a failed run cannot fail the next.
 const fixtures=page.locator('.automation-card').filter({hasText:'Watcher fixture'}),before=await fixtures.count();
 await fixtures.first().locator('.automation-delete').click();
 await page.locator('.automation-delete-confirm').click();
 await page.waitForFunction(count=>[...document.querySelectorAll('.automation-card')].filter(card=>card.innerText.includes('Watcher fixture')).length===count-1,before);
 // Its report is deliberately kept: deleting the automation is not deleting the work.
 await page.locator('#open-inbox').click();await page.locator('[data-inbox-filter=history]').click();
 await page.locator('.inbox-row').filter({hasText:'Watcher fixture'}).first().waitFor();
 assert.deepEqual(errors,[]);
 console.log('PASS: save role, safe fixture launch, durable report, mark reviewed, reload, mobile, delete through the real endpoint keeps the report, no browser errors');
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
