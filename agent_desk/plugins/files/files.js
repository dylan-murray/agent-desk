// The pane's folder as a tree, with what changed since the last commit marked and counted. Everything it knows comes
// through the desk (AgentDesk.call); it can read the folder and open files in the pane's editor, nothing else.
const desk=window.AgentDesk,tree=document.getElementById('tree'),note=document.getElementById('note'),filter=document.getElementById('filter'),changedButton=document.getElementById('changed');
const marks={modified:'M',added:'A',untracked:'U',deleted:'D',renamed:'R',conflict:'!'};
const words={modified:'changed',added:'added',untracked:'new, not in Git yet',deleted:'deleted',renamed:'renamed',conflict:'in conflict'};
const icons={
  chevron:'<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>',
  folder:'<svg class="ft" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 4.6c0-.7.5-1.2 1.2-1.2h2.7l1.5 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2Z"/></svg>',
  open:'<svg class="ft" viewBox="0 0 16 16" aria-hidden="true"><path d="M2.2 11.5V4.6c0-.7.5-1.2 1.2-1.2h2.7l1.5 1.5h4.2c.7 0 1.2.5 1.2 1.2V7"/><path d="M2.2 11.5 4 7.6c.2-.4.6-.6 1-.6h8.5c.5 0 .9.5.7 1l-1.4 3.6c-.2.4-.6.7-1 .7H3.4"/></svg>',
  file:type=>`<svg class="ft ${type}" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.2 2.2h4.9l3 3v8c0 .4-.3.6-.6.6H4.2c-.4 0-.6-.2-.6-.6V2.8c0-.4.2-.6.6-.6Z"/><path d="M9 2.3v2.9h2.9"/></svg>`
};
const types={py:'py',js:'js',mjs:'js',cjs:'js',ts:'ts',tsx:'ts',jsx:'js',md:'md',json:'json',toml:'toml',yml:'yml',yaml:'yml',css:'css',html:'html',sh:'sh',go:'go',rs:'rs'};
const typeOf=path=>types[path.split('.').pop().toLowerCase()]||'';
const esc=text=>String(text).replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[ch]);
let files=[],changes={},lines={},current=null,changedOnly=false,loaded=false,shownKey='',said='',folderName='';
const expanded=new Set();

function parents(path){const parts=path.split('/');return parts.slice(0,-1).map((_,i)=>parts.slice(0,i+1).join('/'));}
function build(paths){
  const root={folders:new Map(),files:[]};
  for(const path of paths){
    let node=root;
    for(const part of path.split('/').slice(0,-1)){if(!node.folders.has(part))node.folders.set(part,{folders:new Map(),files:[]});node=node.folders.get(part);}
    node.files.push(path);
  }
  return root;
}
function counts(path){
  const [added,removed]=lines[path]||[];if(added==null)return '';
  // Up to five blocks, one per five lines changed, split between added and removed.
  const total=added+removed,filled=Math.min(5,Math.ceil(total/5)),green=total?Math.round(filled*added/total):0;
  return `<span class="lines">${added?`<i>+${added}</i>`:''}${added&&removed?' ':''}${removed?`<b>−${removed}</b>`:''}</span><span class="bars" aria-hidden="true">${[0,1,2,3,4].map(i=>`<i class="${i<green?'a':i<filled?'d':''}"></i>`).join('')}</span>`;
}
function render(){
  const query=filter.value.trim().toLowerCase();
  let paths=changedOnly?Object.keys(changes):[...new Set([...files,...Object.keys(changes)])];
  if(query)paths=paths.filter(path=>path.toLowerCase().includes(query));
  const key=JSON.stringify([paths.join('\n'),changes,lines,current,changedOnly,query,[...expanded]]);
  if(key===shownKey&&loaded)return;
  shownKey=key;
  const inside=new Map();Object.keys(changes).flatMap(parents).forEach(folder=>inside.set(folder,(inside.get(folder)||0)+1));
  const rows=[];
  const walk=(node,prefix,depth)=>{
    for(const [name,child] of [...node.folders].sort(([a],[b])=>a.localeCompare(b))){
      // A filter or the Changed view shows every match, so every folder holding one is open.
      const path=prefix+name,open=changedOnly||!!query||expanded.has(path);
      rows.push(`<button type="button" class="row folder" role="treeitem" aria-expanded="${open}" data-folder="${esc(path)}" style="--depth:${depth}">${icons.chevron}${open?icons.open:icons.folder}<span class="name">${esc(name)}</span>${inside.get(path)&&!open?`<span class="end"><span class="count" title="${inside.get(path)} changed inside">${inside.get(path)}</span></span>`:''}</button>`);
      if(open)walk(child,path+'/',depth+1);
    }
    for(const path of node.files.sort((a,b)=>a.localeCompare(b))){
      const kind=changes[path],name=path.split('/').pop();
      rows.push(`<button type="button" class="row file${kind?' changed '+kind:''}" role="treeitem" data-path="${esc(path)}" aria-current="${path===current}" title="${esc(path)}${kind?' · '+words[kind]:''}" style="--depth:${depth}"${kind==='deleted'?' aria-disabled="true"':''}><span class="gap"></span>${icons.file(typeOf(path))}<span class="name">${esc(name)}</span>${kind?`<span class="end">${counts(path)}<span class="mark" aria-label="${words[kind]}">${marks[kind]}</span></span>`:''}</button>`);
    }
  };
  walk(build(paths),'',0);
  tree.innerHTML=rows.join('');
  note.hidden=!!rows.length;
  note.textContent=query?`No file matches “${filter.value.trim()}”.`:changedOnly?'Nothing has changed since the last commit.':'This folder has no files.';
}
// The panel's title bar carries the folder and how much changed; the rail gets a dot while anything has.
function tell(){
  const changed=Object.keys(changes).length,text=JSON.stringify([folderName,changed]);
  if(text===said)return;said=text;
  desk.call('tab.set',{subtitle:folderName,note:changed?`${changed} changed`:'',badge:!!changed}).catch(()=>{});
}
desk.call('pane.info').then(info=>{folderName=info.folder||'';tell();}).catch(()=>{});
async function load(){
  try{
    const [list,status]=await Promise.all([desk.call('files.list'),desk.call('files.changes')]);
    files=list.files;changes=status.changes||{};lines=status.lines||{};
    // The first look opens the folders that hold changes, which is usually where you want to be.
    if(!loaded)Object.keys(changes).flatMap(parents).forEach(path=>expanded.add(path));
    loaded=true;render();tell();
  }catch(error){tree.innerHTML='';note.hidden=false;note.textContent=error.message;}
}
function reveal(path){
  current=path;
  if(path)parents(path).forEach(folder=>expanded.add(folder));
  render();
  tree.querySelector('[aria-current=true]')?.scrollIntoView({block:'nearest'});
}

tree.addEventListener('click',event=>{
  const row=event.target.closest('.row');if(!row)return;
  if(row.dataset.folder){
    if(changedOnly||filter.value.trim())return;
    expanded.has(row.dataset.folder)?expanded.delete(row.dataset.folder):expanded.add(row.dataset.folder);render();tree.querySelector(`[data-folder="${CSS.escape(row.dataset.folder)}"]`)?.focus();return;
  }
  if(changes[row.dataset.path]==='deleted')return;
  desk.call('editor.open',{path:row.dataset.path}).catch(error=>{note.hidden=false;note.textContent=error.message;});
});
tree.addEventListener('keydown',event=>{
  const rows=[...tree.querySelectorAll('.row')],at=rows.indexOf(document.activeElement);
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();rows[Math.max(0,Math.min(rows.length-1,at+(event.key==='ArrowDown'?1:-1)))]?.focus();}
  const row=rows[at];if(!row?.dataset.folder)return;
  if((event.key==='ArrowRight'&&!expanded.has(row.dataset.folder))||(event.key==='ArrowLeft'&&expanded.has(row.dataset.folder))){event.preventDefault();row.click();}
});
filter.addEventListener('input',render);
filter.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&filter.value){event.preventDefault();filter.value='';render();}
  if(event.key==='ArrowDown'){event.preventDefault();tree.querySelector('.row')?.focus();}
});
changedButton.addEventListener('click',()=>{changedOnly=!changedOnly;changedButton.setAttribute('aria-pressed',String(changedOnly));render();});
document.getElementById('collapse').addEventListener('click',()=>{expanded.clear();render();});
desk.on('editor',({path})=>reveal(path));
load();setInterval(load,3000);
