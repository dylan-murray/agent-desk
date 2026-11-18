(()=>{
if(!window.ace)return;
ace.config.set('basePath','/vendor/ace');
const STORE='agent-desk-pane-editor';
const MODES=new Set(['text','markdown','python','javascript','typescript','tsx','jsx','json','yaml','toml','html','css','scss','sh','sql','ruby','golang','rust','dockerfile','ini','xml','diff','makefile','java','c_cpp']);
const modelist=ace.require('ace/ext/modelist');
const mac=/Mac|iPhone|iPad/.test(navigator.platform),cmd=mac?'⌘':'Ctrl+';
const saved=(()=>{try{return JSON.parse(localStorage.getItem(STORE))||{};}catch{return {};}})();
const docks=new Map();
const icons={
  file:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9 2H4.5A1.5 1.5 0 0 0 3 3.5v9A1.5 1.5 0 0 0 4.5 14h7a1.5 1.5 0 0 0 1.5-1.5V6Z"/><path d="M9 2v4h4"/></svg>',
  plus:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
};
const fileLabel=name=>/^claude-prompt-[\w-]+\.md$|^\.tmp\w+\.md$|^COMMIT_EDITMSG$/.test(name)?(name==='COMMIT_EDITMSG'?'commit message':'prompt'):name;
const baseName=path=>path.split('/').pop();
function modeFor(path){const mode=modelist.getModeForPath(path||'').mode.replace('ace/mode/','');return 'ace/mode/'+(MODES.has(mode)?mode:'text');}
const agentOf=id=>everyAgent().find(a=>a.id===id);
const paneName=id=>{const a=agentOf(id);return a?sessionTitle(a):'the pane';};

function persist(){
  const out={};
  for(const [id,dock] of docks){
    out[id]={active:dock.tabs.indexOf(dock.active),
      tabs:dock.tabs.filter(tab=>tab.kind!=='edit').map(tab=>tab.kind==='file'?{kind:'file',path:tab.path}:{kind:'scratch',name:tab.name,text:tab.session.getValue()})};
  }
  for(const [id,value] of Object.entries(saved))if(!docks.has(id)&&agentOf(id))out[id]=value;
  try{localStorage.setItem(STORE,JSON.stringify(out));}catch{}
}
let persistTimer;
const persistSoon=()=>{clearTimeout(persistTimer);persistTimer=setTimeout(persist,400);};

function dockFor(id){
  let dock=docks.get(id);
  if(!dock){
    const was=saved[id]||{};
    dock={id,tabs:[],active:null,restore:was,view:null,files:null};
    docks.set(id,dock);
  }
  return dock;
}

function makeTab(dock,kind,{path='',name='',text='',version=null,edit=null}={}){
  const session=ace.createEditSession(text,modeFor(path||name));
  session.setUseWorker(false);session.setTabSize(2);session.setUseSoftTabs(true);session.setUseWrapMode(kind!=='file'||/\.(md|txt)$/i.test(path));
  session.setUndoManager(new ace.UndoManager());
  const tab={kind,path,name:name||baseName(path)||'Untitled',session,version,savedText:text,edit};
  session.on('change',()=>{renderTabs(dock);renderStatus(dock);if(tab.kind==='scratch')persistSoon();});
  session.on('changeMode',()=>{if(dock.active===tab)renderStatus(dock);});
  return tab;
}
const dirty=tab=>tab.kind!=='scratch'&&tab.session.getValue()!==tab.savedText;

function build(view,id,host){
  const dock=dockFor(id);
  host.insertAdjacentHTML('beforeend',`<section class="pane-editor" aria-label="Text editor">
  <div class="pane-editor-bar">
    <div class="pane-editor-tabs" role="tablist" aria-label="Open files"></div>
    <button type="button" class="pane-icon pane-editor-open" title="Open a file from this pane's folder · ${cmd}P" aria-label="Open a file">${icons.file}</button>
    <button type="button" class="pane-icon pane-editor-new" title="New untitled text" aria-label="New untitled text">${icons.plus}</button>
  </div>
  <div class="pane-editor-banner" role="alert" hidden></div>
  <div class="pane-editor-body"><div class="pane-editor-ace"></div>
    <div class="pane-editor-finder" hidden><input type="text" spellcheck="false" autocomplete="off" placeholder="Open a file in this pane's folder…" aria-label="File to open"><ul role="listbox"></ul></div>
  </div>
  <div class="pane-editor-status"><span class="pane-editor-path"></span><span class="pane-editor-state"></span><span class="pane-editor-where"></span><span class="pane-editor-mode"></span></div>
</section>`);
  const panel=host.querySelector('.pane-editor');
  const editor=ace.edit(panel.querySelector('.pane-editor-ace'),{theme:'ace/theme/tomorrow_night',fontSize:12.5,fontFamily:'"SFMono-Regular", Menlo, Consolas, monospace',showPrintMargin:false,scrollPastEnd:.5,useWorker:false,highlightActiveLine:true,showFoldWidgets:true,displayIndentGuides:true});
  editor.setKeyboardHandler('ace/keyboard/sublime');
  editor.commands.addCommand({name:'deskSave',bindKey:{mac:'Cmd-S',win:'Ctrl-S'},exec:()=>save(dock)});
  editor.commands.addCommand({name:'deskOpen',bindKey:{mac:'Cmd-P',win:'Ctrl-P'},exec:()=>openFinder(dock)});
  editor.on('changeSelection',()=>renderStatus(dock));
  dock.view=view;dock.panel=panel;dock.editor=editor;
  panel.querySelector('.pane-editor-open').onclick=()=>openFinder(dock);
  panel.querySelector('.pane-editor-new').onclick=()=>{const tab=makeTab(dock,'scratch',{name:'Untitled'});dock.tabs.push(tab);activate(dock,tab);persist();};
  bindFinder(dock);
  const previous=view.cleanup;view.cleanup=()=>{previous?.();editor.destroy();dock.view=dock.panel=dock.editor=null;};
  if(!dock.tabs.length){
    for(const item of dock.restore.tabs||[]){
      if(item.kind==='scratch')dock.tabs.push(makeTab(dock,'scratch',{name:item.name,text:item.text}));
      else if(item.kind==='file')dock.tabs.push(Object.assign(makeTab(dock,'file',{path:item.path,text:''}),{pending:true}));
    }
    if(!dock.tabs.length)dock.tabs.push(makeTab(dock,'scratch',{name:'Untitled'}));
    dock.active=dock.tabs[Math.max(0,Math.min(dock.restore.active||0,dock.tabs.length-1))];
  }
  activate(dock,dock.active||dock.tabs[0],false);
}

const shown=dock=>!!dock.panel?.offsetParent;

function renderTabs(dock){
  const strip=dock.panel?.querySelector('.pane-editor-tabs');if(!strip)return;
  strip.replaceChildren(...dock.tabs.map(tab=>{
    const item=document.createElement('div');item.className='pane-editor-tab';item.dataset.kind=tab.kind;
    const active=tab===dock.active,label=tab.kind==='edit'?fileLabel(tab.name):tab.name;
    item.innerHTML=`<button type="button" role="tab" aria-selected="${active}" title="${escapeHTML(tab.kind==='file'?tab.path:tab.kind==='edit'?paneName(dock.id)+' is waiting for this':label)}"><span>${escapeHTML(label)}</span>${dirty(tab)?'<i class="pane-editor-dirty" aria-label="unsaved"></i>':''}</button><button type="button" class="pane-editor-close" aria-label="Close ${escapeHTML(label)}">${icons.close}</button>`;
    item.querySelector('[role=tab]').onclick=()=>activate(dock,tab);
    item.querySelector('.pane-editor-close').onclick=()=>closeTab(dock,tab);
    return item;
  }));
}

function renderStatus(dock){
  const tab=dock.active,panel=dock.panel;if(!tab||!panel)return;
  const where=dock.editor.getCursorPosition(),lines=tab.session.getLength();
  panel.querySelector('.pane-editor-path').textContent=tab.kind==='file'?tab.path:tab.kind==='edit'?'From '+paneName(dock.id):'Not saved to a file';
  panel.querySelector('.pane-editor-where').textContent=`Ln ${where.row+1}, Col ${where.column+1} · ${lines} line${lines===1?'':'s'}`;
  panel.querySelector('.pane-editor-mode').textContent=tab.session.getMode().$id.replace('ace/mode/','').replace('c_cpp','c/c++').replace('golang','go').replace('sh','shell');
  panel.querySelector('.pane-editor-state').textContent=tab.saving?'Saving…':dirty(tab)?'Unsaved':tab.kind==='file'?'Saved':'';
}

function banner(dock,html,actions){
  const node=dock.panel.querySelector('.pane-editor-banner');
  if(!html){node.hidden=true;node.replaceChildren();return;}
  node.hidden=false;node.innerHTML=`<span>${html}</span>`;
  for(const [label,run,primary] of actions||[]){const button=document.createElement('button');button.type='button';button.className=primary?'pane-editor-action primary':'pane-editor-action';button.textContent=label;button.onclick=run;node.append(button);}
}

function showBanner(dock){
  const tab=dock.active;if(!tab||!dock.panel)return;
  if(tab.kind==='edit')banner(dock,`${escapeHTML(paneName(dock.id))} is waiting for this ${escapeHTML(fileLabel(tab.name))}.`,[['Cancel',()=>finishEdit(dock,tab,false)],['Save & return · '+cmd+'S',()=>finishEdit(dock,tab,true),true]]);
  else if(tab.theirs)banner(dock,`${escapeHTML(tab.path)} changed on disk while you were editing.`,[['Use the file\'s version',()=>{load(dock,tab,tab.theirs);tab.theirs=null;showBanner(dock);dock.editor.focus();}],['Keep mine',()=>{tab.version=tab.theirs.version;tab.theirs=null;showBanner(dock);save(dock);},true]]);
  else if(tab.asking)return;
  else if(tab.error)banner(dock,escapeHTML(tab.error),[['Close',()=>closeTab(dock,tab)]]);
  else banner(dock,null);
}

function activate(dock,tab,focus=true){
  if(!tab||!dock.editor)return;
  dock.active=tab;dock.editor.setSession(tab.session);
  if(tab.pending)refresh(dock,tab,true);
  renderTabs(dock);renderStatus(dock);showBanner(dock);persistSoon();
  if(focus)dock.editor.focus();
  // Plugins in this pane, such as the file list, follow which file the editor shows.
  document.dispatchEvent(new CustomEvent('pane-editor-active',{detail:{id:dock.id,path:tab.kind==='file'?tab.path:null}}));
}

function load(dock,tab,file){
  const cursor=dock.active===tab?dock.editor.getCursorPosition():null;
  tab.session.setValue(file.text);tab.savedText=file.text;tab.version=file.version;tab.pending=false;tab.error=null;
  tab.session.setMode(modeFor(tab.path));
  if(cursor)dock.editor.moveCursorToPosition(cursor),dock.editor.clearSelection();
  renderTabs(dock);renderStatus(dock);
}

async function refresh(dock,tab,first=false){
  if(tab.kind!=='file'||tab.loading)return;
  tab.loading=true;
  try{
    const file=await terminalRequest('/api/files/read',{id:dock.id,path:tab.path});
    if(first||tab.pending)load(dock,tab,file);
    else if(file.version!==tab.version){
      if(dirty(tab)){if(!tab.theirs||tab.theirs.version!==file.version){tab.theirs=file;if(dock.active===tab)showBanner(dock);}}
      else{load(dock,tab,file);if(dock.active===tab)flash(dock,'Reloaded: '+tab.path+' changed on disk');}
    }
  }catch(error){if(first||tab.pending){tab.error='Could not open '+tab.path+': '+error.message;tab.pending=false;if(dock.active===tab)showBanner(dock);}}
  finally{tab.loading=false;}
}

function flash(dock,message){const state=dock.panel?.querySelector('.pane-editor-state');if(!state)return;state.textContent=message;dock.flashUntil=Date.now()+4000;clearTimeout(dock.flashTimer);dock.flashTimer=setTimeout(()=>{dock.flashUntil=0;renderStatus(dock);},4000);}

async function save(dock){
  const tab=dock.active;if(!tab)return;
  if(tab.kind==='edit')return finishEdit(dock,tab,true);
  if(tab.kind==='scratch')return askPath(dock,tab);
  tab.saving=true;renderStatus(dock);
  const text=tab.session.getValue();
  try{
    const result=await terminalRequest('/api/files/write',{id:dock.id,path:tab.path,text,version:tab.version});
    if(result.conflict){tab.theirs={text:result.text,version:result.version,path:result.path};showBanner(dock);return;}
    tab.version=result.version;tab.savedText=text;tab.theirs=null;showBanner(dock);
  }catch(error){flash(dock,'Not saved: '+error.message);}
  finally{tab.saving=false;renderTabs(dock);if(!(dock.flashUntil>Date.now()))renderStatus(dock);}
}

function askPath(dock,tab){
  tab.asking=true;
  const node=dock.panel.querySelector('.pane-editor-banner');node.hidden=false;
  node.innerHTML=`<label>Save as <input type="text" spellcheck="false" placeholder="notes/plan.md" aria-label="File path inside this pane's folder"></label>`;
  const input=node.querySelector('input'),add=(label,run,primary)=>{const b=document.createElement('button');b.type='button';b.className='pane-editor-action'+(primary?' primary':'');b.textContent=label;b.onclick=run;node.append(b);};
  const done=()=>{tab.asking=false;showBanner(dock);dock.editor.focus();};
  const commit=async()=>{
    const path=input.value.trim();if(!path)return;
    try{
      const result=await terminalRequest('/api/files/write',{id:dock.id,path,text:tab.session.getValue(),version:null});
      Object.assign(tab,{kind:'file',path:result.path,name:baseName(result.path),version:result.version,savedText:tab.session.getValue()});
      tab.session.setMode(modeFor(result.path));tab.session.setUseWrapMode(/\.(md|txt)$/i.test(result.path));
      done();renderTabs(dock);renderStatus(dock);persist();flash(dock,'Saved as '+result.path);
    }catch(error){input.setCustomValidity(error.message);input.reportValidity();input.oninput=()=>input.setCustomValidity('');}
  };
  add('Cancel',done);add('Save',commit,true);
  input.onkeydown=event=>{event.stopPropagation();if(event.key==='Enter'){event.preventDefault();commit();}if(event.key==='Escape'){event.preventDefault();done();}};
  input.focus();
}

function closeTab(dock,tab){
  if(tab.kind==='edit'){finishEdit(dock,tab,false);return;}
  if(dirty(tab)&&!confirmClose(dock,tab))return;
  const at=dock.tabs.indexOf(tab);dock.tabs.splice(at,1);
  if(!dock.tabs.length)dock.tabs.push(makeTab(dock,'scratch',{name:'Untitled'}));
  if(dock.active===tab)activate(dock,dock.tabs[Math.min(at,dock.tabs.length-1)]);else renderTabs(dock);
  persist();
}
function confirmClose(dock,tab){
  if(tab.confirming)return true;
  tab.confirming=true;dock.active!==tab&&activate(dock,tab);
  banner(dock,`${escapeHTML(tab.name)} has unsaved changes.`,[['Keep editing',()=>{tab.confirming=false;showBanner(dock);dock.editor.focus();}],['Close without saving',()=>closeTab(dock,tab)],['Save',async()=>{tab.confirming=false;await save(dock);if(!dirty(tab))closeTab(dock,tab);},true]]);
  return false;
}

async function openPath(dock,path){
  const existing=dock.tabs.find(tab=>tab.kind==='file'&&tab.path===path);
  if(existing){activate(dock,existing);return;}
  const tab=Object.assign(makeTab(dock,'file',{path}),{pending:true});
  const lone=dock.tabs.length===1&&dock.tabs[0].kind==='scratch'&&!dock.tabs[0].session.getValue();
  if(lone)dock.tabs=[tab];else dock.tabs.splice(dock.tabs.indexOf(dock.active)+1,0,tab);
  activate(dock,tab);persist();
}

function openFinder(dock){
  const finder=dock.panel.querySelector('.pane-editor-finder'),input=finder.querySelector('input');
  finder.hidden=false;input.value='';input.focus();renderFinder(dock);
  if(!dock.files||Date.now()-dock.files.at>15000){
    terminalRequest('/api/files/list',{id:dock.id}).then(list=>{dock.files={...list,at:Date.now()};if(!finder.hidden)renderFinder(dock);}).catch(error=>{dock.files={files:[],error:error.message,at:Date.now()};renderFinder(dock);});
  }
}
function score(path,query){
  if(!query)return 1;
  const lower=path.toLowerCase(),name=baseName(lower);let at=-1,total=0;
  for(const ch of query.toLowerCase()){const next=lower.indexOf(ch,at+1);if(next<0)return 0;total+=next===at+1?3:1;at=next;}
  if(name.includes(query.toLowerCase()))total+=20;
  return total-path.length/200;
}
function renderFinder(dock){
  const finder=dock.panel.querySelector('.pane-editor-finder'),query=finder.querySelector('input').value.trim(),list=finder.querySelector('ul');
  if(!dock.files){list.innerHTML='<li class="pane-editor-note">Reading the folder…</li>';return;}
  if(dock.files.error){list.innerHTML=`<li class="pane-editor-note">${escapeHTML(dock.files.error)}</li>`;return;}
  const ranked=dock.files.files.map(path=>[score(path,query),path]).filter(([s])=>s>0).sort((a,b)=>b[0]-a[0]).slice(0,60);
  dock.finderPick=Math.min(dock.finderPick||0,Math.max(0,ranked.length-1));
  if(!ranked.length){list.innerHTML=`<li class="pane-editor-note">${query?'No file matches “'+escapeHTML(query)+'”':'This folder has no files'}</li>`;return;}
  list.innerHTML=ranked.map(([,path],i)=>`<li role="option" aria-selected="${i===dock.finderPick}" data-path="${escapeHTML(path)}"><b>${escapeHTML(baseName(path))}</b><span>${escapeHTML(path.includes('/')?path.slice(0,path.lastIndexOf('/')):'')}</span></li>`).join('');
  list.querySelector('[aria-selected=true]')?.scrollIntoView({block:'nearest'});
}
function bindFinder(dock){
  const finder=dock.panel.querySelector('.pane-editor-finder'),input=finder.querySelector('input'),list=finder.querySelector('ul');
  const close=()=>{finder.hidden=true;dock.editor.focus();};
  input.oninput=()=>{dock.finderPick=0;renderFinder(dock);};
  input.onkeydown=event=>{
    event.stopPropagation();
    const items=[...list.querySelectorAll('[role=option]')];
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();dock.finderPick=Math.max(0,Math.min(items.length-1,(dock.finderPick||0)+(event.key==='ArrowDown'?1:-1)));renderFinder(dock);}
    else if(event.key==='Enter'){event.preventDefault();const pick=items[dock.finderPick||0];if(pick){finder.hidden=true;openPath(dock,pick.dataset.path);}}
    else if(event.key==='Escape'){event.preventDefault();close();}
  };
  list.onmousedown=event=>{const pick=event.target.closest('[role=option]');if(pick){event.preventDefault();finder.hidden=true;openPath(dock,pick.dataset.path);}};
  input.onblur=()=>setTimeout(()=>{if(!finder.contains(document.activeElement))finder.hidden=true;},120);
}

// The pane's dock owns where the editor sits and whether it shows (pane-docks.js).
function openEditor(id,focus=true){
  const state=paneDocks.get(id);
  if(!state?.open||state.tool!=='@editor')updateDock(id,{open:true,tool:'@editor'});
  const dock=dockFor(id);
  if(focus)dock.editor?.focus();
  return dock;
}
window.togglePaneEditor=id=>{
  const state=paneDocks.get(id);
  if(state?.open)updateDock(id,{open:false});
  else{updateDock(id,{open:true,tool:state?.tool||'@editor'});if((state?.tool||'@editor')==='@editor')dockFor(id).editor?.focus();}
};
window.paneEditor={
  mount(view,id,host){
    const dock=dockFor(id);
    if(dock.view&&dock.view!==view)dock.view=dock.panel=dock.editor=null;
    if(!dock.panel||!host.contains(dock.panel))build(view,id,host);
    requestAnimationFrame(()=>dock.editor?.resize());
  },
  focus:id=>docks.get(id)?.editor?.focus(),
  resize:id=>docks.get(id)?.editor?.resize(),
  open(id,path){const dock=openEditor(id,false);openPath(dock,path);dock.editor?.focus();},
  current:id=>{const tab=docks.get(id)?.active;return tab?.kind==='file'?tab.path:null;}
};

setInterval(()=>{
  if(document.hidden)return;
  for(const dock of docks.values())if(shown(dock)&&dock.active?.kind==='file'&&!dock.active.saving)refresh(dock,dock.active);
},2500);
addEventListener('resize',()=>{for(const dock of docks.values())if(shown(dock))dock.editor.resize();});
addEventListener('beforeunload',event=>{persist();if([...docks.values()].some(dock=>dock.tabs.some(tab=>tab.kind==='file'&&dirty(tab)))){event.preventDefault();event.returnValue='';}});

document.addEventListener('keydown',event=>{
  const toggleKey=mac?event.metaKey&&!event.ctrlKey&&!event.altKey&&!event.shiftKey&&event.key.toLowerCase()==='e':event.ctrlKey&&event.shiftKey&&event.key.toLowerCase()==='e';
  if(!toggleKey||document.querySelector('dialog[open]'))return;
  const id=selectedId,agent=id&&agentOf(id);
  if(!agent?.terminal_id||agent.remote_node||!paneViews.has(id))return;
  event.preventDefault();event.stopPropagation();
  const dock=dockFor(id),state=paneDocks.get(id);
  if(state?.open&&state.tool==='@editor'&&dock.panel?.contains(document.activeElement))paneViews.get(id)?.term?.focus();
  else openEditor(id);
},true);

function startEdit(edit){
  const id=edit.terminal_id;
  if(!openPaneIds.includes(id))selectPane(id,true);
  const dock=openEditor(id,false);
  if(!dock.panel)return;
  if(dock.tabs.some(tab=>tab.edit===edit.id))return;
  const tab=makeTab(dock,'edit',{name:edit.name,text:edit.text,edit:edit.id});
  tab.session.setMode(modeFor(edit.name.endsWith('.md')?edit.name:'x.md'));tab.session.setUseWrapMode(true);
  dock.tabs.push(tab);activate(dock,tab);
  dock.editor.navigateFileEnd();
}
async function finishEdit(dock,tab,keep){
  try{await terminalRequest('/api/editor/finish',{edit:tab.edit,text:keep?tab.session.getValue():null});}
  catch(error){if(!/already closed/.test(error.message)){flash(dock,error.message);return;}}
  dropEdit(dock,tab);paneViews.get(dock.id)?.term?.focus();
}
function dropEdit(dock,tab,keepText){
  const at=dock.tabs.indexOf(tab);if(at<0)return;
  if(keepText&&tab.session.getValue()!==tab.savedText){Object.assign(tab,{kind:'scratch',name:'Untitled',edit:null});renderTabs(dock);showBanner(dock);flash(dock,paneName(dock.id)+' stopped waiting. Your text is kept here.');persist();return;}
  dock.tabs.splice(at,1);
  if(!dock.tabs.length)dock.tabs.push(makeTab(dock,'scratch',{name:'Untitled'}));
  if(dock.active===tab)activate(dock,dock.tabs[Math.min(at,dock.tabs.length-1)],false);else renderTabs(dock);
}
async function watchEdits(){
  let since=null;
  for(;;){
    try{
      const result=await terminalRequest('/api/editor/pending',{since});since=result.revision;
      const live=new Set(result.edits.map(edit=>edit.id));
      for(const dock of docks.values())for(const tab of [...dock.tabs])if(tab.kind==='edit'&&!live.has(tab.edit))dropEdit(dock,tab,true);
      for(const edit of result.edits)startEdit(edit);
    }catch{await new Promise(resolve=>setTimeout(resolve,3000));}
  }
}
if(!demo)watchEdits();
})();
