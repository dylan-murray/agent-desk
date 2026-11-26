// A folder as a tree, with what changed since the last commit marked and counted. It starts at the pane's folder and can
// browse any folder in your home folder. Everything it knows comes through the desk (AgentDesk.call): it can read
// folders, open files in the pane's editor, type a path into the pane's agent, and ask you before moving that agent.
const desk=window.AgentDesk,tree=document.getElementById('tree'),note=document.getElementById('note'),filter=document.getElementById('filter'),changedButton=document.getElementById('changed');
const crumbs=document.getElementById('crumbs'),upButton=document.getElementById('up'),away=document.getElementById('away'),menu=document.getElementById('menu');
const marks={modified:'M',added:'A',untracked:'U',deleted:'D',renamed:'R',conflict:'!'};
const words={modified:'changed',added:'added',untracked:'new, not in Git yet',deleted:'deleted',renamed:'renamed',conflict:'in conflict'};
const icons={
  chevron:'<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  folder:'<svg class="ft" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.6c0-.7.5-1.2 1.2-1.2h2.7l1.5 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2Z"/></svg>',
  open:'<svg class="ft" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 11.5V4.6c0-.7.5-1.2 1.2-1.2h2.7l1.5 1.5h4.2c.7 0 1.2.5 1.2 1.2V7"/><path d="M2.2 11.5 4 7.6c.2-.4.6-.6 1-.6h8.5c.5 0 .9.5.7 1l-1.4 3.6c-.2.4-.6.7-1 .7H3.4"/></svg>',
  file:type=>`<svg class="ft ${type}" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.2h4.9l3 3v8c0 .4-.3.6-.6.6H4.2c-.4 0-.6-.2-.6-.6V2.8c0-.4.2-.6.6-.6Z"/><path d="M9 2.3v2.9h2.9"/></svg>`,
  more:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="3.5" cy="8" r=".9"/><circle cx="8" cy="8" r=".9"/><circle cx="12.5" cy="8" r=".9"/></svg>'
};
const types={py:'py',js:'js',mjs:'js',cjs:'js',ts:'ts',tsx:'ts',jsx:'js',md:'md',json:'json',toml:'toml',yml:'yml',yaml:'yml',css:'css',html:'html',sh:'sh',go:'go',rs:'rs',rb:'rb'};
const typeOf=path=>types[path.split('.').pop().toLowerCase()]||'';
const esc=text=>String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
let files=[],changes={},lines={},current=null,changedOnly=false,loaded=false,shownKey='',said='',truncated=false,listedAt=0,loading=null,editorPath=null;
// root is the folder shown, pane is the folder the pane started in, and workingIn is where its agent works (Move here changes it).
let root='',pane='',workingIn='',home='',repo=null,agentName='';
const expanded=new Set();

const inside=(path,folder)=>path===folder||path.startsWith(folder.replace(/\/$/,'')+'/');
const baseName=path=>path.split('/').filter(Boolean).pop()||'/';
const parentOf=path=>path.replace(/\/[^/]+\/?$/,'')||'/';
const absolute=relative=>root.replace(/\/$/,'')+'/'+relative;
// Paths inside the pane's folder go to the desk as relative ones, so the editor names them the way ⌘P does.
const forDesk=path=>inside(path,pane)&&path!==pane?path.slice(pane.length+1):path;
const browsable=path=>inside(path,pane)||(!!home&&inside(path,home));
const agentWord=()=>agentName||'terminal';
const hereMark=()=>`<span class="here" title="${esc(agentName?agentName+' works here':'The terminal is here')}"></span>`;

function parents(path){const parts=path.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));}
function build(paths){
  const top={folders:new Map(),files:[]};
  for(const path of paths){
    let node=top;
    for(const part of path.split('/').slice(0,-1)){if(!node.folders.has(part))node.folders.set(part,{folders:new Map(),files:[]});node=node.folders.get(part);}
    node.files.push(path);
  }
  return top;
}
function counts(path){
  const [added,removed]=lines[path]||[];if(added==null)return '';
  // Up to five blocks, one per five lines changed, split between added and removed.
  const total=added+removed,filled=Math.min(5,Math.ceil(total/5)),green=total?Math.round(filled*added/total):0;
  return `<span class="lines">${added?`<i>+${added}</i>`:''}${added&&removed?' ':''}${removed?`<b>−${removed}</b>`:''}</span><span class="bars" aria-hidden="true">${[0,1,2,3,4].map(i=>`<i class="${i<green?'a':i<filled?'d':''}"></i>`).join('')}</span>`;
}

// The path bar: each folder from your home folder down is a step up. Above it (or above a pane started outside it)
// nothing can be browsed, so that part is one ellipsis holding the full path.
function renderBar(){
  const steps=[];let path='';
  for(const part of root.split('/').filter(Boolean)){path+='/'+part;steps.push({name:part,path});}
  let first=steps.findIndex(step=>browsable(step.path));if(first<0)first=steps.length-1;
  const shown=steps.slice(first);
  if(home&&shown[0]?.path===home)shown[0]={name:'~',path:home};
  const lead=first>0&&shown[0].name!=='~'?`<span class="crumb lead" title="${esc(steps[first-1].path)}">…</span><span class="sep">/</span>`:'';
  crumbs.innerHTML=lead+shown.map((step,i)=>{
    const mark=step.path===workingIn?hereMark():'';
    return i===shown.length-1?`<span class="crumb current" aria-current="location" title="${esc(root)}">${mark}${esc(step.name)}</span>`
      :`<button type="button" class="crumb" data-go="${esc(step.path)}" title="${esc(step.path)}">${mark}${esc(step.name)}</button><span class="sep">/</span>`;
  }).join('');
  crumbs.scrollLeft=crumbs.scrollWidth;
  upButton.disabled=root==='/'||!browsable(parentOf(root));
  // Looking somewhere else keeps a way back, and a way to bring the agent along.
  away.hidden=!workingIn||root===workingIn;
  if(!away.hidden)away.innerHTML=`<span>${esc(agentName||'The terminal')} is in <b title="${esc(workingIn)}">${esc(baseName(workingIn))}</b></span><button type="button" data-go="${esc(workingIn)}">Back</button><button type="button" data-move="${esc(root)}">Move ${esc(agentWord())} here…</button>`;
}

function render(){
  const query=filter.value.trim().toLowerCase();
  let paths=changedOnly?Object.keys(changes):[...new Set([...files,...Object.keys(changes)])];
  if(query)paths=paths.filter(path=>path.toLowerCase().includes(query));
  const key=JSON.stringify([root,workingIn,agentName,paths.join('\n'),changes,lines,current,changedOnly,query,[...expanded]]);
  if(key===shownKey&&loaded)return;
  shownKey=key;
  filter.placeholder=files.length?`Filter ${files.length.toLocaleString()}${truncated?'+':''} file${files.length===1?'':'s'}`:'Filter files';
  const holding=new Map();Object.keys(changes).flatMap(parents).forEach(folder=>holding.set(folder,(holding.get(folder)||0)+1));
  const rows=[],more=`<span class="more" data-more title="More actions">${icons.more}</span>`;
  const walk=(node,prefix,depth)=>{
    for(const [name,child] of [...node.folders].sort(([a],[b])=>a.localeCompare(b))){
      // A filter or the Changed view shows every match, so every folder holding one is open.
      const path=prefix+name,open=changedOnly||!!query||expanded.has(path);
      rows.push(`<button type="button" class="row folder" role="treeitem" aria-expanded="${open}" data-folder="${esc(path)}" style="--depth:${depth}">${icons.chevron}${open?icons.open:icons.folder}<span class="name">${esc(name)}</span>${absolute(path)===workingIn?hereMark():''}<span class="end">${holding.get(path)&&!open?`<span class="count" title="${holding.get(path)} changed inside">${holding.get(path)}</span>`:''}${more}</span></button>`);
      if(open)walk(child,path+'/',depth+1);
    }
    for(const path of node.files.sort((a,b)=>a.localeCompare(b))){
      const kind=changes[path],name=path.split('/').pop();
      rows.push(`<button type="button" class="row file${kind?' changed '+kind:''}" role="treeitem" data-path="${esc(path)}" aria-current="${path===current}" title="${esc(path)}${kind?' · '+words[kind]:''}" style="--depth:${depth}"${kind==='deleted'?' aria-disabled="true"':''}><span class="gap"></span>${icons.file(typeOf(path))}<span class="name">${esc(name)}</span><span class="end">${kind?counts(path)+`<span class="mark" aria-label="${words[kind]}">${marks[kind]}</span>`:''}${kind==='deleted'?'':more}</span></button>`);
    }
  };
  walk(build(paths),'',0);
  tree.innerHTML=rows.join('');
  note.hidden=!!rows.length&&!truncated;
  note.textContent=!rows.length?(query?`No file matches “${filter.value.trim()}”.`:changedOnly?'Nothing has changed since the last commit.':'This folder has no files.')
    :`Showing the first ${files.length.toLocaleString()} files. Filter, or open a smaller folder.`;
}
// The panel's title bar carries the folder and how much changed; the rail gets a dot while anything has.
function tell(){
  const changed=Object.keys(changes).length,text=JSON.stringify([root,changed]);
  if(text===said)return;said=text;
  desk.call('tab.set',{subtitle:baseName(root).slice(0,60),note:changed?`${changed} changed`:'',badge:!!changed}).catch(()=>{});
}
function load(){
  if(loading)return loading;
  loading=(async()=>{
    const asked=root;
    try{
      const folder=root&&root!==pane?{folder:root}:{};
      // A folder outside Git is walked, which can be slow, so it is read again only now and then.
      const stale=!loaded||!!repo||Date.now()-listedAt>15000;
      const [list,status]=await Promise.all([stale?desk.call('files.list',folder):null,desk.call('files.changes',folder)]);
      if(root!==asked)return;
      if(list){
        if(!pane)pane=root=list.root;
        files=list.files;truncated=list.truncated;home=list.home||'';repo=list.repo;listedAt=Date.now();
      }
      changes=status.changes||{};lines=status.lines||{};
      // The first look at a folder opens the folders that hold changes, which is usually where you want to be.
      if(!loaded)Object.keys(changes).flatMap(parents).forEach(path=>expanded.add(path));
      loaded=true;renderBar();render();tell();
    }catch(error){if(root===asked){tree.innerHTML='';note.hidden=false;note.textContent=error.message;}}
    finally{loading=null;}
  })();
  return loading;
}
async function go(folder){
  if(!folder||folder===root)return;
  await loading;
  root=folder;files=[];changes={};lines={};expanded.clear();filter.value='';loaded=false;listedAt=0;repo=null;current=null;
  renderBar();tree.innerHTML='';note.hidden=false;note.textContent='Reading the folder…';
  await load();
  if(loaded)reveal(fromEditor(editorPath));
}
function reveal(path){
  current=path;
  if(path)parents(path).forEach(folder=>expanded.add(folder));
  render();
  tree.querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest'});
}
// The editor names files from the pane's folder; the tree names them from the folder it shows.
function fromEditor(path){
  if(!path||!pane)return null;
  const full=path.startsWith('/')?path:pane+'/'+path;
  return inside(full,root)&&full!==root?full.slice(root.replace(/\/$/,'').length+1):null;
}

// Right-click a row, or its … button, for what you can do with it.
function openMenu(row,x,y){
  const folder=row.dataset.folder,path=absolute(folder||row.dataset.path),mention=agentName?`Add to ${agentName}`:'Paste path in terminal';
  const items=folder?[['browse','Open this folder'],['mention',mention],['move',`Move ${agentWord()} here…`],['copy','Copy path']]:[['open','Open in editor'],['mention',mention],['copy','Copy path']];
  menu.innerHTML=items.map(([id,label])=>`<button type="button" role="menuitem" data-act="${id}">${esc(label)}</button>`).join('');
  menu.dataset.path=path;menu.hidden=false;
  const box=menu.getBoundingClientRect();
  menu.style.left=Math.max(4,Math.min(x,innerWidth-box.width-4))+'px';menu.style.top=Math.max(4,Math.min(y,innerHeight-box.height-4))+'px';
  menu.returnTo=row;menu.querySelector('button').focus();
}
function closeMenu(focus=true){if(menu.hidden)return;menu.hidden=true;if(focus)menu.returnTo?.focus();}
function shout(error){note.hidden=false;note.textContent=error.message;shownKey='';setTimeout(render,4000);}
function act(action,path){
  if(action==='browse')return go(path);
  if(action==='open')return desk.call('editor.open',{path:forDesk(path)}).catch(shout);
  if(action==='mention')return desk.call('agent.mention',{path:forDesk(path)}).catch(shout);
  if(action==='copy')return desk.call('files.copyPath',{path:forDesk(path)}).catch(shout);
  if(action==='move')return desk.call('agent.move',{folder:path}).then(({choice})=>{if(choice!=='cd'&&choice!=='tell')return;workingIn=path;if(root===path){renderBar();render();}else go(path);}).catch(shout);
}
menu.addEventListener('click',event=>{const button=event.target.closest('[data-act]');if(!button)return;closeMenu(button.dataset.act!=='browse');act(button.dataset.act,menu.dataset.path);});
menu.addEventListener('keydown',event=>{
  const items=[...menu.querySelectorAll('button')],at=items.indexOf(document.activeElement);
  if(event.key==='Escape'||event.key==='Tab'){event.preventDefault();closeMenu();}
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(at+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus();}
});
document.addEventListener('pointerdown',event=>{if(!menu.contains(event.target))closeMenu(false);});
addEventListener('blur',()=>closeMenu(false));

tree.addEventListener('click',event=>{
  const row=event.target.closest('.row');if(!row)return;
  if(event.target.closest('[data-more]')){const box=row.getBoundingClientRect();openMenu(row,box.right-8,box.bottom);return;}
  if(row.dataset.folder){
    if(changedOnly||filter.value.trim())return;
    expanded.has(row.dataset.folder)?expanded.delete(row.dataset.folder):expanded.add(row.dataset.folder);render();tree.querySelector(`[data-folder="${CSS.escape(row.dataset.folder)}"]`)?.focus();return;
  }
  if(changes[row.dataset.path]==='deleted')return;
  desk.call('editor.open',{path:forDesk(absolute(row.dataset.path))}).catch(shout);
});
tree.addEventListener('contextmenu',event=>{
  const row=event.target.closest('.row');if(!row||changes[row.dataset.path]==='deleted')return;
  event.preventDefault();openMenu(row,event.clientX,event.clientY);
});
tree.addEventListener('keydown',event=>{
  const rows=[...tree.querySelectorAll('.row')],at=rows.indexOf(document.activeElement),row=rows[at];
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();rows[Math.max(0,Math.min(rows.length-1,at+(event.key==='ArrowDown'?1:-1)))]?.focus();}
  if(row&&(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10'))&&changes[row.dataset.path]!=='deleted'){event.preventDefault();const box=row.getBoundingClientRect();openMenu(row,box.left+24,box.bottom);}
  if(!row?.dataset.folder)return;
  if((event.key==='ArrowRight'&&!expanded.has(row.dataset.folder))||(event.key==='ArrowLeft'&&expanded.has(row.dataset.folder))){event.preventDefault();row.click();}
});
document.querySelector('header').addEventListener('click',event=>{
  const button=event.target.closest('[data-go],[data-move]');if(!button)return;
  if(button.dataset.move)act('move',button.dataset.move);else go(button.dataset.go);
});
upButton.addEventListener('click',()=>go(parentOf(root)));
filter.addEventListener('input',render);
filter.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&filter.value){event.preventDefault();filter.value='';render();}
  if(event.key==='ArrowDown'){event.preventDefault();tree.querySelector('.row')?.focus();}
});
changedButton.addEventListener('click',()=>{changedOnly=!changedOnly;changedButton.setAttribute('aria-pressed',String(changedOnly));render();});
document.getElementById('collapse').addEventListener('click',()=>{expanded.clear();render();});
desk.on('editor',({path})=>{editorPath=path;reveal(fromEditor(path));});
async function info(){
  try{
    const about=await desk.call('pane.info');agentName=about.agent||'';
    // The desk names the pane's folder as it was typed; the listing names it with links resolved, so the pane's own
    // folder is taken from the listing and only a folder it was moved to from the desk.
    if(pane)workingIn=about.workingIn&&about.workingIn!==about.path?about.workingIn:pane;
    if(loaded){renderBar();render();}
  }catch{}
}
(async()=>{await load();await info();})();
setInterval(load,3000);setInterval(info,5000);
