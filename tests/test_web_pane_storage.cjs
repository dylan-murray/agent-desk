const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {webcrypto}=require('node:crypto');
const source=fs.readFileSync(path.join(__dirname,'../agent_desk/static/web-panes.js'),'utf8');

function storage(){
  const values=new Map();
  return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,String(value))};
}
function document({desktop=false,local=storage(),session=storage()}={}){
  const context=vm.createContext({URL,crypto:webcrypto,localStorage:local,sessionStorage:session,
    ...(desktop?{agentDeskDesktop:{}}:{}),
    location:new URL(desktop?'agent-desk://app/':'http://127.0.0.1:4322/'),
    document:{addEventListener(){}},addEventListener(){},
    openPaneIds:[],PANE_LIMIT:16,paneViews:new Map(),paneStoreKey:()=> 'live',
    savePanes(){},switchPage(){},render(){}});
  vm.runInContext('window=globalThis',context);
  vm.runInContext(source,context);
  return code=>JSON.parse(JSON.stringify(vm.runInContext(code,context))??'null');
}

test('desktop web pages retain their IDs, names and URLs across cold starts',()=>{
  const local=storage(),first=document({desktop:true,local});
  first("openWebPage('https://example.invalid/docs','Fictional docs')");
  first("openWebPage('agent-tool://t'+'a'.repeat(32),'Fictional tool')");
  const pages=first('[...webPages.values()]');
  assert.equal(pages.length,2);
  const reopened=document({desktop:true,local});
  assert.deepEqual(reopened('[...webPages.values()]'),pages);
  reopened(`forgetWebPage(${JSON.stringify(pages[0].id)})`);
  assert.deepEqual(document({desktop:true,local})('[...webPages.values()]'),[pages[1]],'A closed page must stay closed');
});

test('desktop migrates existing session pages once and respects a later empty workspace',()=>{
  const local=storage(),session=storage();
  const pages=[{id:'web-fixture',name:'Existing page',url:'https://example.invalid/old'}];
  session.setItem('agent-desk-web-pages',JSON.stringify(pages));
  const migrated=document({desktop:true,local,session});
  assert.deepEqual(migrated('[...webPages.values()]'),pages);
  assert.deepEqual(document({desktop:true,local})('[...webPages.values()]'),pages);
  migrated("forgetWebPage('web-fixture')");
  assert.deepEqual(document({desktop:true,local,session})('[...webPages.values()]'),[],'Stale session records must not reopen a closed page');
});

test('browser reloads retain pages while a separate tab starts with its own pages',()=>{
  const local=storage(),session=storage();
  const first=document({local,session});
  first("openWebPage('https://example.invalid/','Tab page')");
  const pages=first('[...webPages.values()]');
  assert.deepEqual(document({local,session})('[...webPages.values()]'),pages);
  assert.equal(local.getItem('agent-desk-web-pages'),null);
  assert.deepEqual(document({local})('[...webPages.values()]'),[]);
});
