const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {spawn}=require('node:child_process');
const {once}=require('node:events');
const {refresh}=require('../scripts/refresh_prompt_observer.cjs');
for(const mode of ['inspector','automatic'])test(mode+' refresh preserves the screen, rejects drafts, and keeps the observer alive',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'desk-observer-refresh-'));
 const scripts=path.resolve(__dirname,'../scripts');
 const adapt=source=>source.replaceAll("'../agent_desk/static/vendor/xterm.js'",JSON.stringify(path.resolve(scripts,'../agent_desk/static/vendor/xterm.js'))).replaceAll("'./native_terminal_screen.cjs'",JSON.stringify(path.join(scripts,'native_terminal_screen.cjs')));
 const current=adapt(fs.readFileSync(path.join(scripts,'worker_prompt.cjs'),'utf8'));
 const predicate=path.join(root,'worker_prompt.cjs');
 fs.writeFileSync(predicate,current.replace('if(suffix){','if(suffix)return false; if(false){'));
 fs.writeFileSync(path.join(root,'worker_screen.cjs'),adapt(fs.readFileSync(path.join(scripts,'worker_screen.cjs'),'utf8')));
 const child=spawn(process.execPath,['--inspect=127.0.0.1:0',path.join(root,'worker_screen.cjs')]);
 let revision=0,buffer='';const lines=[];
 child.stdout.on('data',data=>{buffer+=data;while(buffer.includes('\n')){const at=buffer.indexOf('\n');lines.push(JSON.parse(buffer.slice(0,at)));buffer=buffer.slice(at+1);}});
 const wait=async check=>{for(let i=0;i<100;i++){const value=check();if(value)return value;await new Promise(r=>setTimeout(r,30));}throw Error('Fixture timed out');};
 let stderr='';child.stderr.on('data',data=>stderr+=data);
 const send=async data=>{child.stdin.write(JSON.stringify({op:'output',harness:'codex',revision:++revision,data:Buffer.from(data).toString('base64')})+'\n');return wait(()=>lines.find(row=>row.revision===revision));};
 try{
  const url=await wait(()=>stderr.match(/ws:\/\/[^\s]+/)?.[0]);
  const idle='\x1b[?2004h\x1b[2J\x1b[H› \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[2C';
  assert.equal((await send(idle)).ready,false);
  if(mode==='automatic'){
   fs.writeFileSync(predicate,'incomplete edit (');
   await wait(()=>lines.some(row=>row.state==='observer_update_failed'&&!row.ready));
   assert.equal(child.exitCode,null,'invalid update must preserve the screen process');
  }
  fs.writeFileSync(predicate,current);
  if(mode==='inspector')assert.deepEqual(await refresh(url,child.pid,predicate),{pid:child.pid,changed:true});
  else await wait(()=>lines.some(row=>row.revision===revision&&row.ready));
  await new Promise(resolve=>setTimeout(resolve,250));
  assert.equal(child.exitCode,null,'cleanup must leave the observer alive');
  assert.equal((await send('')).ready,true,'retained screen reclassified with new predicate');
  assert.equal((await send('\x1b[2J\x1b[H› Ask Codex to do anything\r\x1b[2C')).ready,false,'typed hint remains a draft');
 }finally{child.kill();await once(child,'exit');fs.rmSync(root,{recursive:true,force:true});}
});
