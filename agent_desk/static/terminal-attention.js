// Recognize explicit terminal approval menus, not ordinary questions or silence.
function terminalApprovalPrompt(term){
  const buffer=term.buffer.active;
  const lines=Array.from({length:term.rows},(_,i)=>buffer.getLine(buffer.baseY+i)?.translateToString(true)||'');
  const text=lines.join('\n');
  // Grok's startup trust screen uses unnumbered choices with y/n shortcuts.
  // Require the complete live menu, not a question quoted in scrollback.
  const trust=lines.findIndex(line=>/^\s*Do you trust the contents of this directory\?\s*$/i.test(line));
  if(trust>=0){
    const yes=lines.findIndex((line,i)=>i>trust&&/^\s*Yes, proceed\s+y\s*$/i.test(line));
    const no=lines.findIndex((line,i)=>i>yes&&/^\s*No, quit\s+n\s*$/i.test(line));
    if(yes>trust&&no>yes&&no-trust<=12&&lines.slice(no+1).every(line=>!line.trim()))return 'Do you trust the contents of this directory?';
  }

  const question=/(?:do you (?:want|trust)|would you like|allow .{0,100}\?|approve .{0,100}\?|proceed\?|continue\?)[^\n]*/i;
  const match=text.match(question);
  if(!match)return null;
  const tail=text.slice(match.index);
  const numberedYes=/[1-9][.)]\s*Yes\b/i.test(tail),numberedNo=/[1-9][.)]\s*No\b/i.test(tail);
  const selected=/[❯›>]\s*[1-9][.)]\s*(?:Yes|No)\b/i.test(tail);
  const keyChoice=/\[(?:y\/n|Y\/n|y\/N)\]|\(y\/n\)/i.test(tail);
  if(!(numberedYes&&numberedNo&&selected)&&!keyChoice)return null;
  // Old prompts higher in a scrolling transcript are not current requests.
  const lastOption=lines.reduce((last,line,i)=>/[1-9][.)]\s*(?:Yes|No)\b|\[y\/n\]|\(y\/n\)/i.test(line)?i:last,-1);
  if(buffer.cursorY>lastOption+3)return null;
  return match[0].trim().slice(0,240);
}
// Terminals without an open pane are replayed into a hidden xterm so their screens can be read.
const attentionReaders=new Map();
function disposeAttentionReader(id){
  const reader=attentionReaders.get(id);if(!reader)return;
  reader.subscription?.close();reader.term.dispose();attentionReaders.delete(id);
}
function readPaneAttention(agent,activity){
  const pane=paneViews.get(agent.id);
  if(!pane?.term)return false;
  disposeAttentionReader(agent.id);
  activity.approval=pane.restoring?null:terminalApprovalPrompt(pane.term);
  activity.caughtUp=!pane.restoring;
  return true;
}
async function attentionReader(agent){
  let reader=attentionReaders.get(agent.id);
  if(reader)return reader;
  const saved=readTerminalSnapshot(agent.id);
  const term=new Terminal({cols:saved?.cols||80,rows:saved?.rows||24,scrollback:0,disableStdin:true});
  // No onData handler: this observer can never send input or query responses.
  reader={term,cursor:saved?.cursor||0,caughtUp:false};attentionReaders.set(agent.id,reader);
  reader.ready=saved?new Promise(resolve=>term.write(saved.screen,resolve)).then(()=>restoreTerminalState(term,saved.state)):Promise.resolve();
  await reader.ready;
  return reader;
}
// Streamed: the reader follows the terminal's output as it arrives, so this only reads its screen.
async function followTerminalAttention(agent,activity){
  // An open pane's own subscription reports its connection state.
  if(readPaneAttention(agent,activity))return;
  const reader=await attentionReader(agent);
  if(!reader.subscription){
    let inbox=reader.ready;
    reader.subscription=terminalStream.subscribe(agent.id,reader.cursor,message=>{
      if(message.type==='disconnected'||message.type==='error'){activity.connected=false;return;}
      if(message.type==='exit'){noteTerminalExit(agent.id,message.exit_code);return;}
      if(message.type!=='output')return;
      activity.connected=true;
      inbox=inbox.then(async()=>{
        if(attentionReaders.get(agent.id)!==reader)return;
        if(message.truncated)reader.term.reset();
        const bytes=Uint8Array.from(atob(message.data),char=>char.charCodeAt(0));
        if(bytes.length)await new Promise(resolve=>reader.term.write(bytes,resolve));
        reader.cursor=message.cursor;
        // Replayed history is not activity; only bytes after the first empty reply are.
        if(!bytes.length)reader.caughtUp=true;else if(reader.caughtUp)activity.lastOutput=Date.now();
      });
    });
  }
  activity.caughtUp=reader.caughtUp;
  activity.approval=reader.caughtUp?terminalApprovalPrompt(reader.term):null;
}
async function readTerminalAttention(agent,activity){
  if(readPaneAttention(agent,activity))return;
  const reader=await attentionReader(agent);
  let caughtUp=false;
  for(let page=0;page<18;page++){
    const output=await terminalRequest(`/api/terminals/output?id=${encodeURIComponent(agent.id)}&cursor=${reader.cursor}`);
    if(output.truncated)reader.term.reset();
    const bytes=Uint8Array.from(atob(output.data),char=>char.charCodeAt(0));
    if(bytes.length)await new Promise(resolve=>reader.term.write(bytes,resolve));
    reader.cursor=output.cursor;
    if(!bytes.length){caughtUp=true;break;}
  }
  activity.approval=caughtUp?terminalApprovalPrompt(reader.term):null;
  activity.caughtUp=caughtUp;
}
// Sound the alert on the transition into "needs you", never on the polling tick that
// keeps reporting it. A session can only sound once we have already seen it settled in
// some other state, so a prompt that was on screen before this page loaded (or before a
// terminal observer caught up with its scrollback) is recorded silently instead of
// raising the alarm for stale state. Reconnects report 'unknown', which is not a settled
// state, so losing and regaining the connection does not re-alert either.
const attentionArmed=new Set(),attentionSounded=new Set();
let lastAttentionSound=0;
function attentionSettled(agent){
  if(agent.status==='unknown')return false;
  const live=agent.terminal_id&&agent.exit_code===null&&!agent.runtime_status&&agent.remote_connected!==false;
  if(!live)return true;
  const activity=typeof terminalActivity==='undefined'?null:terminalActivity.get(agent.id);
  return activity?.connected===true&&activity.caughtUp===true;
}
function updateAttentionAlert(all){
  let fresh=false;
  for(const agent of all){
    if(agent.status==='needs_input'){
      if(attentionArmed.has(agent.id)&&!attentionSounded.has(agent.id))fresh=true;
      attentionSounded.add(agent.id);
    }else if(attentionSettled(agent)){
      attentionArmed.add(agent.id);attentionSounded.delete(agent.id);
    }
  }
  const known=new Set(all.map(agent=>agent.id));
  for(const id of [...attentionArmed])if(!known.has(id))attentionArmed.delete(id);
  for(const id of [...attentionSounded])if(!known.has(id))attentionSounded.delete(id);
  // Several sessions arriving in the same tick coalesce into one sound, and the guard
  // keeps two renders of the same tick (monitorTerminals then render) from doubling it.
  if(!fresh||demo||Date.now()-lastAttentionSound<1500)return;
  lastAttentionSound=Date.now();
  window.deskAlerts?.attention();
}
// A session is done when its agent finishes a turn and settles at an empty prompt; the server
// stamps that moment as turn_ended. Each session's stamp is recorded silently the first time
// this page sees it, so loading the page or reconnecting never replays an old finish, and a
// turn that ends on a question is left to the attention alert.
const turnEndsSeen=new Map();
function updateTurnEndAlert(all){
  let fresh=false;
  for(const agent of all){
    const ended=agent.turn_ended??null;
    if(turnEndsSeen.has(agent.id)&&ended&&ended!==turnEndsSeen.get(agent.id)&&agent.status!=='needs_input')fresh=true;
    turnEndsSeen.set(agent.id,ended);
  }
  const known=new Set(all.map(agent=>agent.id));
  for(const id of [...turnEndsSeen.keys()])if(!known.has(id))turnEndsSeen.delete(id);
  if(fresh&&!demo)window.deskAlerts?.completion();
}
// A dismissed alert stays gone until that session asks something new.
const attentionDismissed=new Map();
function attentionKey(agent){return JSON.stringify([agent.id,agent.question||'']);}
function renderAttention(all){
  window.renderWorkInbox?.();
  updateAttentionAlert(all);
  updateTurnEndAlert(all);
  for(const [id,key] of attentionDismissed)if(!all.some(agent=>agent.id===id&&attentionKey(agent)===key))attentionDismissed.delete(id);
  const waiting=all.filter(a=>a.status==='needs_input'&&attentionDismissed.get(a.id)!==attentionKey(a));
  const banner=document.getElementById('session-attention');
  // An agent on another desk is named with its desk, and opening it switches to that desk.
  const elsewhere=agent=>onActiveDesk(agent)?'':desks.find(d=>d.id===deskOf(agent))?.name||'';
  const signature=JSON.stringify(waiting.map(a=>[a.id,a.name,a.question,elsewhere(a)]));
  document.title=waiting.length?`(${waiting.length}) Needs you · Agent Desk`:'Agent Desk';
  if(banner.dataset.signature===signature)return;
  banner.dataset.signature=signature;banner.hidden=!waiting.length;banner.replaceChildren();
  if(!waiting.length)return;
  const label=document.createElement('strong');label.textContent=`${waiting.length} session${waiting.length===1?' needs':'s need'} you`;banner.append(label);
  for(const agent of waiting){
    const button=document.createElement('button');button.className='button';
    button.textContent=agent.name+(elsewhere(agent)?' · '+elsewhere(agent):'')+' →';button.title=(agent.question||'Open session to respond')+(elsewhere(agent)?' · on the '+elsewhere(agent)+' desk':'');
    button.onclick=()=>selectPane(agent.id);banner.append(button);
    const dismiss=document.createElement('button');dismiss.className='attention-dismiss';
    dismiss.title='Dismiss until '+agent.name+' asks something else';dismiss.setAttribute('aria-label','Dismiss alert for '+agent.name);
    dismiss.textContent='\u00d7';
    dismiss.onclick=()=>{attentionDismissed.set(agent.id,attentionKey(agent));banner.dataset.signature='';renderAttention(everyAgent());};
    banner.append(dismiss);
  }
}
if(typeof module!=='undefined')module.exports={terminalApprovalPrompt};
