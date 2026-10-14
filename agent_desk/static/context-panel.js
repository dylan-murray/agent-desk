// A user-visible view of the same memory and retrieval tools available to coordinators.
window.createContextPanel = ({identity,providers,renderText}) => {
 const dialog=document.createElement('dialog');dialog.className='context-panel';dialog.setAttribute('aria-label','Context and memory');
 dialog.innerHTML=`<div class="context-panel-heading"><h2>Context & memory</h2><button class="button context-close" aria-label="Close context panel">×</button></div>
 <p class="context-intro">A small working memory. Everything else, on demand.</p>
 <section><h3>Saved memory</h3><div class="context-notes"></div><form class="context-memory-form"><input name="name" aria-label="Memory name" maxlength="80" required placeholder="Name, e.g. Review policy"><textarea name="text" aria-label="Memory note" rows="2" maxlength="1500" required placeholder="A decision or constraint to keep across turns"></textarea><button class="button" type="submit">Save note</button></form></section>
 <section><h3>Search history & reports</h3><form class="context-search"><input name="query" aria-label="Search coordinator history" maxlength="200" required placeholder="Search this coordinator’s history"><button class="button" type="submit">Search</button></form><div class="context-matches"></div><div class="context-source"></div><button class="button context-more hidden">Next page</button><details><summary>Saved artifacts</summary><div class="context-artifacts"></div></details></section>
 <section><h3>Optional source reader</h3><p>Delegate broad source questions to a model you choose. Unchanged files and questions reuse the cache.</p><form class="context-reader"><label>Provider<select name="profile" aria-label="Reader provider"></select></label><label>Model<input name="model" aria-label="Reader model" maxlength="200" required placeholder="Explicit model name"></label><div class="context-actions"><button type="submit" class="button">Enable reader</button><button type="button" class="button context-reader-disable">Disable</button></div></form><p class="context-cache"></p></section>
 <section><h3>PR monitors</h3><p>Watch GitHub without an agent polling loop. Checks about every three minutes; stops on merge/close, two idle hours, or after 24 hours.</p><div class="context-watches"></div><form class="context-watch"><input name="url" type="url" aria-label="Pull request URL" required placeholder="https://github.com/owner/repo/pull/123"><button type="submit" class="button">Watch PR</button></form></section><p class="context-error" role="alert"></p>`;
 document.body.append(dialog);
 const el=s=>dialog.querySelector(s);let selectedSource=null,lastQuery='',nextOffset=null;
 const error=e=>{el('.context-error').textContent=e.message;};
 const nav=document.createElement('nav');nav.className='context-tabs';nav.setAttribute('role','tablist');nav.setAttribute('aria-label','Context tools');
 const content=document.createElement('div');content.className='context-panels';
 const sections=[...dialog.querySelectorAll(':scope > section')],tabs=[];
 const names=['Memory','History','Reader','PR monitors'],scope=crypto.randomUUID();
 function activate(index,focus=false){
  sections.forEach((section,i)=>{section.hidden=i!==index;tabs[i].setAttribute('aria-selected',String(i===index));tabs[i].tabIndex=i===index?0:-1;});
  content.scrollTop=0;if(focus)tabs[index].focus();
 }
 sections.forEach((section,i)=>{
  const tab=document.createElement('button');tab.type='button';tab.textContent=names[i];tab.setAttribute('role','tab');tab.id='context-tab-'+scope+'-'+i;section.id='context-panel-'+scope+'-'+i;
  tab.setAttribute('aria-controls',section.id);section.setAttribute('role','tabpanel');section.setAttribute('aria-labelledby',tab.id);section.tabIndex=0;
  tab.onclick=()=>activate(i);tab.onkeydown=event=>{let target;if(event.key==='ArrowRight')target=(i+1)%4;else if(event.key==='ArrowLeft')target=(i+3)%4;else if(event.key==='Home')target=0;else if(event.key==='End')target=3;else return;event.preventDefault();activate(target,true);};
  tabs.push(tab);nav.append(tab);content.append(section);
 });
 el('.context-intro').after(nav,content);activate(0);
 const editor=document.createElement('details');editor.className='context-note-editor';
 const editorTitle=document.createElement('summary');editorTitle.textContent='＋ Add a memory';
 const memoryForm=el('.context-memory-form');memoryForm.before(editor);editor.append(editorTitle,memoryForm);

 const request=(route,payload={})=>terminalRequest('/api/coordinators/'+route,{...payload,id:identity()});
 const button=(label,fn)=>{const node=document.createElement('button');node.className='button';node.type='button';node.textContent=label;node.onclick=async()=>{node.disabled=true;try{await fn();}catch(e){error(e);}finally{node.disabled=false;}};return node;};
 for(const [value,label] of Object.entries(providers)){const option=document.createElement('option');option.value=value;option.textContent=label;el('.context-reader select').append(option);}
 async function retrieve(reference,offset=0){
  activate(1);
  const data=await request('retrieve',{reference,offset});selectedSource=reference;nextOffset=data.next_offset;
  el('.context-source').replaceChildren();const title=document.createElement('strong');title.textContent=data.title+' · '+reference;el('.context-source').append(title);renderText(el('.context-source'),data.text);
  el('.context-more').classList.toggle('hidden',nextOffset==null);
 }
 async function search(query,offset=0){
  const data=await request('retrieve',{query,offset});lastQuery=query;selectedSource=null;nextOffset=data.next_offset;
  const list=el('.context-matches');list.replaceChildren();el('.context-source').replaceChildren();
  if(!data.matches.length)list.textContent='No matching messages.';
  for(const match of data.matches)list.append(button(match.kind+' · '+match.excerpt,()=>retrieve(match.reference,match.offset)));
  el('.context-more').classList.toggle('hidden',nextOffset==null);
 }
 el('.context-more').onclick=()=> (selectedSource?retrieve(selectedSource,nextOffset):search(lastQuery,nextOffset)).catch(error);
 async function load(){
  const data=await request('context');el('.context-error').textContent='';
  const notes=el('.context-notes');notes.replaceChildren();
  if(!data.notes.length)notes.textContent='No saved notes yet. You or the coordinator can save decisions here.';
  for(const note of data.notes){
   const row=document.createElement('div'),title=document.createElement('strong'),text=document.createElement('p');title.textContent=note.name;text.textContent=note.text;row.append(title,text);
   if(note.source!=='user')row.append(button('Source · '+note.source,()=>retrieve(note.source)));
   else{const label=document.createElement('small');label.textContent='Pinned by you';row.append(label);}
   row.append(button('Edit',()=>{editor.open=true;el('.context-memory-form [name=name]').value=note.name;el('.context-memory-form [name=text]').value=note.text;}),button('Remove',async()=>{await request('delete-memory',{name:note.name});await load();}));notes.append(row);
  }
  const artifacts=el('.context-artifacts');artifacts.replaceChildren();
  for(const a of data.artifacts)artifacts.append(button(a.title+' · '+Math.ceil(a.bytes/1024)+' KB',()=>retrieve('artifact:'+a.id)));
  const reader=el('.context-reader');if(data.reader){reader.elements.profile.value=data.reader.profile;reader.elements.model.value=data.reader.model;}
  el('.context-cache').textContent=(data.reader?'Enabled · '+data.reader.profile+' / '+data.reader.model:'Reader disabled')+' · '+data.cache_hits+' cache hits · '+Math.ceil(data.cached_input_bytes/1024)+' KB reused (not a billing estimate)';
  el('.context-reader-disable').disabled=!data.reader;
  const watches=el('.context-watches');watches.replaceChildren();
  for(const watch of data.watches||[]){const row=document.createElement('div'),label=document.createElement('p');label.textContent=watch.url+' · '+watch.state+' · '+watch.detail;row.append(label);if(watch.state==='watching')row.append(button('Stop',async()=>{await request('stop-watch',{watch_id:watch.id});await load();}));watches.append(row);}
 }
 function form(selector,fn){el(selector).onsubmit=async event=>{event.preventDefault();const submit=event.submitter;submit.disabled=true;try{await fn(Object.fromEntries(new FormData(event.target)));}catch(e){error(e);}finally{submit.disabled=false;}};}
 form('.context-memory-form',async values=>{await request('save-memory',values);el('.context-memory-form').reset();editor.open=false;await load();});
 form('.context-search',values=>search(values.query));
 form('.context-reader',async values=>{await request('configure-reader',{...values,enabled:true});await load();});
 el('.context-reader-disable').onclick=()=>request('configure-reader',{enabled:false}).then(load).catch(error);
 form('.context-watch',async values=>{await request('watch-pr',values);el('.context-watch').reset();await load();});
 el('.context-close').onclick=()=>dialog.close();
 return {open:async()=>{dialog.showModal();try{await load();}catch(e){error(e);}},destroy:()=>dialog.remove()};
};
