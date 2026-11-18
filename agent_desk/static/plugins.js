// Dock plugins (agent_desk/plugins.py): each opens as a tab in a terminal pane's dock, in a sandboxed
// frame with no network. Its only way to the pane is the channel set up here, and every call is checked
// against the permissions its manifest declared, for the pane it sits in and nothing else.
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
  'pane.info':{run:bridge=>{const agent=everyAgent().find(a=>a.id===bridge.pane);return {title:agent?sessionTitle(agent):'',folder:(agent?.cwd||'').split('/').pop(),project:agent?.project||''};}},
  'files.list':{permission:'files.read',run:bridge=>terminalRequest('/api/files/list',{id:bridge.pane}).then(list=>({files:list.files,truncated:!!list.truncated}))},
  'files.changes':{permission:'files.read',run:bridge=>terminalRequest('/api/files/changes',{id:bridge.pane}).then(result=>({changes:result.changes,lines:result.lines||{},git:result.git}))},
  'files.read':{permission:'files.read',run:(bridge,params)=>terminalRequest('/api/files/read',{id:bridge.pane,path:pluginPath(params.path)}).then(file=>({path:file.path,text:file.text,version:file.version}))},
  'editor.open':{permission:'editor.open',run:(bridge,params)=>{window.paneEditor.open(bridge.pane,pluginPath(params.path));return {opened:true};}},
  'editor.current':{permission:'editor.open',run:bridge=>({path:window.paneEditor.current(bridge.pane)})},
  'buttons.set':{run:(bridge,params)=>setPluginButton(bridge,params)},
  'tab.set':{run:(bridge,params)=>setPluginTab(bridge,params)}
};
function pluginPath(path){
  // The server keeps every path inside the pane's folder; this only refuses what is not a path at all.
  if(typeof path!=='string'||!path||path.length>1000||path.includes('\0'))throw Error('Name a file in the pane\'s folder');
  return path;
}

function connectPlugin(frame,plugin,pane){
  frame.addEventListener('load',()=>{
    // Every load gets a new channel; the old one stops being answered.
    pluginBridges.get(frame)?.port.close();
    const channel=new MessageChannel(),bridge={port:channel.port1,plugin,pane,busy:0};
    pluginBridges.set(frame,bridge);
    channel.port1.onmessage=event=>answerPlugin(bridge,event.data);
    frame.contentWindow?.postMessage({agentDesk:'connect',version:1},'*',[channel.port2]);
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
