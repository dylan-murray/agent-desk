// Incremental passive screen mirror; never sends terminal responses to the worker.
global.self=global;
const {Terminal}=require('../agent_desk/static/vendor/xterm.js');
let {ready,working}=require('./worker_prompt.cjs');
const {classify}=require('./native_terminal_screen.cjs');
const term=new Terminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
let standaloneShell=false;
term.parser.registerOscHandler(777,data=>{if(data==='agent-desk;shell'){standaloneShell=true;return true;}return false;});
let hidden=false,sync=false,title='',chain=Promise.resolve();
term.onTitleChange(value=>{title=value;});
let lastMessage=null,reloadFailed=false;
function publish(msg){
 // Claude keeps an empty composer while it works, so a working agent is never ready or idle.
 const busy=!!working?.(term,msg.harness,hidden,sync,title);
 const idle=!reloadFailed&&!standaloneShell&&!busy&&ready(term,msg.harness,hidden,sync);
 const state=reloadFailed?'observer_update_failed':standaloneShell?'shell':msg.harness==='grok'?classify(term,hidden,sync).state:busy?'working':idle?'idle':'busy_or_editing';
 process.stdout.write(JSON.stringify({revision:msg.revision,ready:idle,state})+'\n');
}
// Future predicate upgrades preserve the live xterm model and require no
// process attachment or restart. Serialize refreshes with incoming output.
const fs=require('node:fs'),predicate=require.resolve('./worker_prompt.cjs');
fs.watchFile(predicate,{interval:1000,persistent:false},(current,previous)=>{
 if(current.mtimeMs===previous.mtimeMs)return;
 chain=chain.then(()=>{
  try{
   delete require.cache[predicate];const module=require(predicate),candidate=module.ready;
   if(typeof candidate!=='function')throw Error('Prompt predicate is missing');
   ready=candidate;working=typeof module.working==='function'?module.working:null;reloadFailed=false;
  }catch{reloadFailed=true;}
  if(lastMessage)publish(lastMessage);
 }).catch(()=>process.exit(1));
});
for(const final of ['h','l'])term.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(25))hidden=final==='l';if(params.includes(2026))sync=final==='h';return false;});
require('readline').createInterface({input:process.stdin}).on('line',line=>{
 chain=chain.then(async()=>{
  const msg=JSON.parse(line);
  if(msg.op==='resize')term.resize(msg.cols,msg.rows);
  if(msg.op==='output')await new Promise(resolve=>term.write(Buffer.from(msg.data,'base64'),resolve));
  lastMessage=msg;publish(msg);
 }).catch(()=>process.exit(1));
}).on('close',()=>chain.finally(()=>{fs.unwatchFile(predicate);term.dispose();process.exit(0);}));
