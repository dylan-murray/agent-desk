'use strict';
// Rasterize the existing vector mark without changing the in-app artwork.
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {chromium} = require('../../node_modules/playwright');
(async () => {
  const folder = path.resolve(__dirname, '../resources');
  const iconset = path.resolve(__dirname, '../.build/AgentDesk.iconset');fs.mkdirSync(iconset, {recursive:true});
  const mark = fs.readFileSync(path.resolve(__dirname, '../../agent_desk/static/agent-desk-mark.svg'),'utf8');
  const browser = await chromium.launch({channel:'chrome'});
  try {
    // Keep each export in its own fixed-size surface. Repeatedly resizing the
    // same page can leave stale compositor tiles in the resulting Dock icon.
    async function rasterize(size, artwork) {
      const page = await browser.newPage({viewport:{width:size,height:size},deviceScaleFactor:1});
      try {
        await page.setContent('<style>html,body{margin:0;overflow:hidden}svg{display:block;width:100vw;height:100vh}</style>'+artwork);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        return await page.locator('svg').screenshot({omitBackground:true,scale:'css'});
      } finally {await page.close();}
    }
    for (const size of [16,32,64,128,256,512,1024]) {
      const png = await rasterize(size, mark);
      if(size<=512) fs.writeFileSync(path.join(iconset,`icon_${size}x${size}.png`),png);
      if(size>=32) fs.writeFileSync(path.join(iconset,`icon_${size/2}x${size/2}@2x.png`),png);
      if(size===512) fs.writeFileSync(path.join(folder,'agent-desk.png'),png);
    }
    execFileSync('/usr/bin/iconutil',['-c','icns',iconset,'-o',path.join(folder,'agent-desk.icns')]);
  } finally {await browser.close();}
})();
