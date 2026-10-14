// Serves the page's config with two added accounts, as someone who set up a second Claude and Codex login would have.
const accounts=[{id:'codex',harness:'codex',name:'',label:'Codex'},{id:'codex-personal',harness:'codex',name:'Personal',label:'Codex · Personal'},
  {id:'claude',harness:'claude',name:'',label:'Claude'},{id:'claude-personal',harness:'claude',name:'Personal',label:'Claude · Personal'}];
module.exports=page=>page.route('**/config.js',async route=>{const response=await route.fetch();await route.fulfill({response,body:await response.text()+'window.AGENT_DESK_CONFIG.accounts='+JSON.stringify(accounts)+';'});});
