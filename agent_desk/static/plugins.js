// Plugin pages (agent_desk/plugins): each opens as a tab in a terminal pane's dock, in a sandboxed
// frame with no network. Its only way to the pane is the channel set up here, and every call is checked
// against the permissions its plugin.json declared, for the pane it sits in and nothing else.
let dockPlugins=[];
const pluginBridges=new WeakMap(),pluginButtons=new Map(),pluginTabs=new Map();
async function refreshPlugins(){
  try{
    const response=await fetch('/api/plugins');if(!response.ok)return;
    const list=((await response.json()).plugins||[]).filter(plugin=>plugin.status==='bundled'||plugin.status==='approved');
    if(JSON.stringify(list)===JSON.stringify(dockPlugins))return;
    dockPlugins=list;renderPaneDocks();
  }catch{}
}
const pluginEntries=()=>[...dockPlugins].sort((a,b)=>a.order-b.order||a.tab.localeCompare(b.tab)).map(plugin=>({id:'plugin:'+plugin.id,title:plugin.tab,plugin}));

const pluginCalls={
  'pane.info':{run:bridge=>{
    const agent=everyAgent().find(a=>a.id===bridge.pane),info={title:agent?sessionTitle(agent):'',folder:(agent?.cwd||'').split('/').pop(),project:agent?.project||''};
    // Full paths name your home folder, so only a plugin that may browse beyond the pane's folder sees them.
    if(agent&&bridge.plugin.permissions.includes('files.browse'))Object.assign(info,{path:agent.cwd,workingIn:paneFolders.get(agent.id)||agent.cwd,agent:runningAgent(agent)});
    return info;
  }},
  'files.list':{permission:'files.read',run:(bridge,params)=>terminalRequest('/api/files/list',{id:bridge.pane,...browsed(bridge,params.folder)}).then(list=>({files:list.files,truncated:!!list.truncated,branch:list.branch||null,
    ...(bridge.plugin.permissions.includes('files.browse')?{root:list.root,home:list.home,repo:list.repo||null}:{})}))},
  'files.changes':{permission:'files.read',run:(bridge,params)=>terminalRequest('/api/files/changes',{id:bridge.pane,...browsed(bridge,params.folder)}).then(result=>({changes:result.changes,lines:result.lines||{},git:result.git}))},
  'files.read':{permission:'files.read',run:(bridge,params)=>terminalRequest('/api/files/read',{id:bridge.pane,path:pluginPath(bridge,params.path)}).then(file=>({path:file.path,text:file.text,version:file.version}))},
  'files.copyPath':{permission:'files.read',run:async(bridge,params)=>{await navigator.clipboard.writeText(fullPath(bridge,params.path));return {copied:true};}},
  'editor.open':{permission:'editor.open',run:(bridge,params)=>{window.paneEditor.open(bridge.pane,pluginPath(bridge,params.path));return {opened:true};}},
  'editor.current':{permission:'editor.open',run:bridge=>({path:window.paneEditor.current(bridge.pane)})},
  'agent.mention':{permission:'agent.input',run:(bridge,params)=>mentionInPane(bridge,params.path)},
  'agent.move':{permission:'agent.input',run:(bridge,params)=>moveAgent(bridge,params.folder)},
  'buttons.set':{run:(bridge,params)=>setPluginButton(bridge,params)},
  'tab.set':{run:(bridge,params)=>setPluginTab(bridge,params)}
};
function pluginPath(bridge,path){
  // The server keeps a relative path inside the pane's folder and a full one inside your home folder; this only refuses
  // what is not a path at all, and a full path from a plugin that may not leave the pane's folder.
  if(typeof path!=='string'||!path||path.length>4096||/[\u0000-\u001f]/.test(path))throw Error('Name a file in the pane\'s folder');
  if(path.startsWith('/')&&!bridge.plugin.permissions.includes('files.browse'))throw Error(`${bridge.plugin.title} has no permission for files outside the pane's folder (needs files.browse)`);
  return path;
}
function browsed(bridge,folder){
  if(folder==null)return {};
  if(!bridge.plugin.permissions.includes('files.browse'))throw Error(`${bridge.plugin.title} has no permission for other folders (needs files.browse)`);
  if(typeof folder!=='string'||!folder.startsWith('/')||folder.length>4096||/[\u0000-\u001f]/.test(folder))throw Error('Name a folder by its full path');
  return {folder};
}
function fullPath(bridge,path){
  const agent=everyAgent().find(a=>a.id===bridge.pane);if(!agent)throw Error('This pane has closed');
  path=pluginPath(bridge,path);
  return path.startsWith('/')?path.replace(/\/+$/,'')||'/':agent.cwd.replace(/\/+$/,'')+'/'+path;
}

// Where a pane's agent was last moved to with Move here; the pane's own folder is where it started.
const paneFolders=new Map();
const runningAgent=agent=>!agent.agent_exited&&agent.exit_code==null?paneAgentName(agent):'';
const shellWord=text=>/^[\w@%+=:,./-]+$/.test(text)?text:"'"+text.replace(/'/g,"'\\''")+"'";
function typeInPane(id,text,{enter=false}={}){
  const view=paneViews.get(id);if(!view?.term||view.exited)throw Error('This pane\'s terminal is not running');
  // A paste, so an agent's input box takes it as text and not as keys; nothing is sent unless asked to.
  view.term.paste(text);if(enter)view.term.input('\r');
  // After a dialog closes it hands focus back to what opened it; the terminal takes it after that.
  view.term.focus();setTimeout(()=>view.term.focus());
}
// Add to agent: a coding agent gets an @mention it reads on send; a shell gets the path as a word.
function mentionInPane(bridge,path){
  const agent=everyAgent().find(a=>a.id===bridge.pane),full=fullPath(bridge,path),name=runningAgent(agent);
  // An agent reads a mention from the folder it started in; a shell from wherever it was moved to.
  const base=(name?agent.cwd:paneFolders.get(agent.id)||agent.cwd).replace(/\/+$/,'')+'/';
  const shown=full.startsWith(base)?full.slice(base.length):full;
  typeInPane(agent.id,name?'@'+shown+' ':shellWord(shown)+' ');
  return {typed:true};
}
function moveAgent(bridge,folder){
  const agent=everyAgent().find(a=>a.id===bridge.pane);if(!agent)throw Error('This pane has closed');
  folder=browsed(bridge,folder).folder.replace(/\/+$/,'')||'/';
  const dialog=$('#move-agent-dialog'),name=runningAgent(agent),from=paneFolders.get(agent.id)||agent.cwd,short=path=>{const home=window.AGENT_DESK_CONFIG?.home;return home&&(path===home||path.startsWith(home+'/'))?'~'+path.slice(home.length):path;};
  const choices=name?[['tell',`Tell ${name} to work there`,`Puts a message in ${name}'s input for you to send. Same conversation.`],['new',`Start a new ${name} there`,`Opens the launcher with this folder. This ${name} keeps running.`]]
    :[['cd','Change this terminal\'s folder','Runs cd in the terminal.'],['new','Start an agent there','Opens the launcher with this folder.']];
  dialog.querySelector('h2').textContent=`Move ${name||'this terminal'} to ${folder.split('/').pop()||folder}?`;
  dialog.querySelector('.move-agent-path').textContent=short(folder);
  dialog.querySelector('.move-agent-why').textContent=name?`${name} can't change folders in the middle of a conversation. It works in ${short(from)}.`:`It's in ${short(from)}.`;
  dialog.querySelector('.move-agent-choices').innerHTML=choices.map(([id,title,detail])=>`<button type="button" data-choice="${id}"><strong>${escapeHTML(title)}</strong><small>${escapeHTML(detail)}</small></button>`).join('');
  return new Promise(resolve=>{
    let choice=null;
    dialog.querySelectorAll('[data-choice]').forEach(button=>button.onclick=()=>{choice=button.dataset.choice;dialog.close();});
    dialog.addEventListener('close',()=>{
      try{
        if(choice==='cd'){typeInPane(agent.id,'\x15cd '+shellWord(folder),{enter:true});paneFolders.set(agent.id,folder);}
        if(choice==='tell'){typeInPane(agent.id,`From here on, work in ${folder}.`);paneFolders.set(agent.id,folder);}
        if(choice==='new'){const key=[agent.launch_profile,agent.harness].find(k=>k&&launchChoices[k]);openTerminalLauncher(folder,key||null);}
        resolve({choice});
      }catch(error){toast(error.message);resolve({choice:null});}
    },{once:true});
    dialog.showModal();dialog.querySelector('[data-choice]').focus();
  });
}

function connectPlugin(frame,plugin,pane){
  frame.addEventListener('load',()=>{
    // Every load gets a new channel; the old one stops being answered.
    pluginBridges.get(frame)?.port.close();
    const channel=new MessageChannel(),bridge={port:channel.port1,plugin,pane,busy:0};
    pluginBridges.set(frame,bridge);
    channel.port1.onmessage=event=>answerPlugin(bridge,event.data);
    // The frame is sandboxed without allow-same-origin, so its origin is opaque and no origin string can name it.
    frame.contentWindow?.postMessage({agentDesk:'connect',version:1},'*',[channel.port2]); // nosemgrep: javascript.browser.security.wildcard-postmessage-configuration.wildcard-postmessage-configuration
    if(plugin.permissions.includes('editor.open'))sendPlugin(bridge,'editor',{path:window.paneEditor?.current(pane)||null});
  });
}
async function answerPlugin(bridge,message){
  const {id,method,params={}}=message||{};
  if(!Number.isSafeInteger(id))return;
  const reply=body=>bridge.port.postMessage({id,...body});
  const call=pluginCalls[method];
  if(!call||typeof params!=='object'||params===null)return reply({error:`Unknown call: ${String(method).slice(0,60)}`});
  if(call.permission&&!bridge.plugin.permissions.includes(call.permission))return reply({error:`${bridge.plugin.title} has no permission for ${method} (needs ${call.permission})`});
  // A plugin can't flood the desk: a few calls at a time, the rest refused until those finish.
  if(bridge.busy>=4)return reply({error:'Too many calls at once'});
  bridge.busy++;
  try{reply({result:await call.run(bridge,params)});}
  catch(error){reply({error:String(error?.message||error).slice(0,300)});}
  finally{bridge.busy--;}
}
function sendPlugin(bridge,event,detail){try{bridge.port.postMessage({event,detail});}catch{}}
function paneBridges(pane){
  const view=paneViews.get(pane);
  return [...(view?.node.querySelectorAll('.pane-dock-frame[data-plugin]')||[])].map(frame=>pluginBridges.get(frame)).filter(Boolean);
}
document.addEventListener('pane-editor-active',event=>{
  for(const bridge of paneBridges(event.detail.id))if(bridge.plugin.permissions.includes('editor.open'))sendPlugin(bridge,'editor',{path:event.detail.path});
});

// What a plugin may say about its own tab: a subtitle and a short note in the panel's title bar, and a dot on its rail
// item. Plain text only, drawn by the desk.
const pluginTab=(pane,plugin)=>pluginTabs.get(pane+'\n'+plugin)||{};
function setPluginTab(bridge,params){
  const words=(value,most)=>{if(value==null)return '';if(typeof value!=='string'||value.length>most||/[\u0000-\u001f\u007f]/.test(value))throw Error(`Tab text is plain text of at most ${most} characters`);return value;};
  const next={...pluginTab(bridge.pane,bridge.plugin.id)};
  if('subtitle' in params)next.subtitle=words(params.subtitle,60);
  if('note' in params)next.note=words(params.note,24);
  if('badge' in params){if(typeof params.badge!=='boolean')throw Error('badge is true or false');next.badge=params.badge;}
  pluginTabs.set(bridge.pane+'\n'+bridge.plugin.id,next);
  const view=paneViews.get(bridge.pane),agent=everyAgent().find(a=>a.id===bridge.pane);
  if(view&&agent)renderPaneDock(view,agent);
  return next;
}

// A plugin's buttons are drawn by the desk from its manifest; the plugin can only press, release or disable its own.
function setPluginButton(bridge,params){
  const button=bridge.plugin.buttons.find(item=>item.id===params.id);
  if(!button)throw Error('No such button');
  const key=bridge.pane+'\n'+bridge.plugin.id,state={...pluginButtons.get(key)};
  state[button.id]={...state[button.id],...(typeof params.pressed==='boolean'&&button.toggle?{pressed:params.pressed}:{}),...(typeof params.disabled==='boolean'?{disabled:params.disabled}:{})};
  pluginButtons.set(key,state);
  const view=paneViews.get(bridge.pane);if(view)renderPluginButtons(view.node.querySelector('.pane-dock'),bridge.pane,{id:'plugin:'+bridge.plugin.id,plugin:bridge.plugin});
  return state[button.id];
}
function renderPluginButtons(panel,pane,entry){
  const holder=panel?.querySelector('.pane-dock-actions');if(!holder)return;
  if(panel.dataset.entry!==entry.id)return;
  const plugin=entry.plugin,state=plugin&&pluginButtons.get(pane+'\n'+plugin.id)||{};
  holder.innerHTML=(plugin?.buttons||[]).map(button=>`<button type="button" class="text-button" data-button="${escapeHTML(button.id)}" title="${escapeHTML(button.title)}"${button.toggle?` aria-pressed="${!!state[button.id]?.pressed}"`:''}${state[button.id]?.disabled?' disabled':''}>${escapeHTML(button.label)}</button>`).join('');
  holder.hidden=!holder.children.length;
  holder.querySelectorAll('button').forEach(node=>node.onclick=()=>{
    const button=plugin.buttons.find(item=>item.id===node.dataset.button),key=pane+'\n'+plugin.id,current={...pluginButtons.get(key)};
    const pressed=button.toggle?!current[button.id]?.pressed:undefined;
    if(button.toggle){current[button.id]={...current[button.id],pressed};pluginButtons.set(key,current);node.setAttribute('aria-pressed',String(pressed));}
    const frame=panel.querySelector(`.pane-dock-frame[data-plugin="${CSS.escape(plugin.id)}"]`),bridge=frame&&pluginBridges.get(frame);
    if(bridge)sendPlugin(bridge,'button',{id:button.id,...(button.toggle?{pressed}:{})});
  });
}

refreshPlugins();setInterval(refreshPlugins,15000);
