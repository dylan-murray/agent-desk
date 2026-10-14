// Explicit source selection; a folder or active pane never picks the history.
(()=>{
 let rows=[],loaded=false,imported=null,revision=0,nextOffset=null;
 const source=document.getElementById('portable-source'),details=document.getElementById('portable-details');
 function render(){
  const selected=source.value,query=document.getElementById('portable-search').value.toLowerCase().trim();
  source.replaceChildren(new Option('Choose the exact conversation…',''));
  for(const row of rows.filter(r=>[r.title,r.name,r.profile,r.cwd].join(' ').toLowerCase().includes(query)))source.add(new Option((row.title||row.name)+' · '+row.profile+' · '+new Date(row.updated*1000).toLocaleString(),row.id));
  source.value=selected;
  if(!source.value){imported=null;revision++;}
 }
 window.loadPortableConversations=async(force=false)=>{
  if(loaded&&!force)return;loaded=true;details.textContent='Loading saved conversations…';
  try{const result=await terminalRequest('/api/conversations/list',{});rows=result.conversations;nextOffset=result.next_offset??null;document.getElementById('portable-more').hidden=nextOffset===null;render();details.textContent=rows.length?'Choose a source; the destination harness is selected above.':'No saved conversations found.';}
  catch(error){loaded=false;details.textContent=error.message;}
 };
 document.getElementById('portable-more').onclick=async()=>{
  const button=document.getElementById('portable-more');button.disabled=true;
  try{const result=await terminalRequest('/api/conversations/list',{offset:nextOffset});rows=[...new Map([...rows,...result.conversations].map(r=>[r.id,r])).values()];nextOffset=result.next_offset??null;button.hidden=nextOffset===null;render();}
  catch(error){details.textContent=error.message;}finally{button.disabled=false;}
 };
 document.getElementById('portable-refresh').onclick=()=>window.loadPortableConversations(true);
 document.getElementById('portable-search').oninput=render;
 source.onchange=async()=>{
  const current=++revision;imported=null;if(!source.value){details.textContent='Choose a conversation.';return;}
  details.textContent='Importing conversation…';
  try{const record=await terminalRequest('/api/conversations/import',{source_id:source.value});if(current!==revision)return;imported=record;
   details.textContent=record.message_count+' messages · '+record.source.profile+' → selected harness'+(record.warnings.length?' · '+record.warnings.join(' '):'');
   if(record.cwd)document.getElementById('terminal-cwd').value=record.cwd;
  }catch(error){if(current===revision)details.textContent=error.message;}
 };
 window.preparePortableConversation=async()=>{
  if(!imported)throw Error('Choose a source conversation and wait for its import.');
  return terminalRequest('/api/conversations/prepare',{conversation_id:imported.id,task:document.getElementById('portable-task').value.trim()});
 };
})();
