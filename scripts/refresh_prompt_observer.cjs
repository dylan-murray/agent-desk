// Refresh only the pure prompt predicate in a passive Node screen observer.
// Never attach to the PTY worker, native agent, or Python terminal supervisor.
const fs=require('node:fs');
const path=require('node:path');
const {execFileSync}=require('node:child_process');

async function refresh(url,pid,expectedScript){
 const socket=new WebSocket(url),pending=new Map(),scripts=[];let sequence=0;
 await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const message=JSON.parse(event.data);
  if(message.method==='Debugger.scriptParsed')scripts.push(message.params);
  if(message.id&&pending.has(message.id)){const {resolve,reject,timer}=pending.get(message.id);pending.delete(message.id);clearTimeout(timer);message.error?reject(Error(message.error.message)):resolve(message.result);}
 };
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;
  const timer=setTimeout(()=>{pending.delete(id);reject(Error('Inspector request timed out'));},5000);
  pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));
 });
 try{
  const actual=await call('Runtime.evaluate',{expression:'process.pid',returnByValue:true});
  if(actual.result.value!==pid)throw Error('Inspector PID does not match the verified observer');
  await call('Debugger.enable');
  const matches=scripts.filter(script=>{
   try{return fs.realpathSync(script.url.startsWith('file://')?require('node:url').fileURLToPath(script.url):script.url)===fs.realpathSync(expectedScript);}catch{return false;}
  });
  if(matches.length!==1)throw Error('Expected exactly one loaded prompt predicate');
  const scriptId=matches[0].scriptId;
  const original=(await call('Debugger.getScriptSource',{scriptId})).scriptSource;
  const next=fs.readFileSync(expectedScript,'utf8');
  // Limit live-edit to the predicate; module setup and CLI entrypoint must match.
  const split=source=>{const a=source.indexOf('function ready('),b=source.indexOf('if(require.main===module)');
   if(a<0||b<a)throw Error('Unrecognized prompt module');return [source.slice(0,a),source.slice(b)];};
  if(JSON.stringify(split(original))!==JSON.stringify(split(next)))throw Error('Changes outside the pure predicate require a normal observer upgrade');
  if(original!==next){
   for(const dryRun of [true,false]){
    const result=await call('Debugger.setScriptSource',{scriptId,scriptSource:next,dryRun});
    if(result.status!=='Ok')throw Error('Predicate live-edit refused: '+result.status);
   }
  }
  await call('Debugger.disable');
  return {pid,changed:original!==next};
 }finally{
  // Close the temporary inspector listener after disconnecting this client.
  try{await call('Runtime.evaluate',{expression:"setTimeout(()=>process.getBuiltinModule('node:inspector').close(),100); undefined"});}catch{}
  socket.close();
 }
}

async function main(){
 const pid=Number(process.argv[2]);
 if(!Number.isSafeInteger(pid)||pid<2)throw Error('Pass one verified passive observer PID');
 const command=execFileSync('ps',['-p',String(pid),'-o','comm=,args='],{encoding:'utf8'}).trim();
 const observer=path.resolve(__dirname,'worker_screen.cjs');
 if(!/\bnode\b/.test(command)||!command.endsWith(observer))throw Error('PID is not this checkout’s passive screen observer');
 // Refuse an existing inspector rather than accidentally touching another process.
 try{await fetch('http://127.0.0.1:9229/json/list');throw Error('Port 9229 already has an inspector; no signal sent');}
 catch(error){if(error.message!=='fetch failed')throw error;}
 process.kill(pid,'SIGUSR1');
 let targets;
 for(let attempt=0;attempt<30;attempt++){
  try{targets=await (await fetch('http://127.0.0.1:9229/json/list')).json();break;}catch{await new Promise(resolve=>setTimeout(resolve,100));}
 }
 if(targets?.length!==1)throw Error('Could not locate the signalled observer inspector');
 console.log(JSON.stringify(await refresh(targets[0].webSocketDebuggerUrl,pid,path.resolve(__dirname,'worker_prompt.cjs'))));
}
module.exports={refresh};
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
