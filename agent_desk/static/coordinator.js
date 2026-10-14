(()=>{
const template=document.getElementById('coordinator-page');template.remove();
const dialogTemplate=document.getElementById('coord-create-dialog');dialogTemplate.remove();
const workspaces=new Map();
const providerLabels={};
function syncProviderLabels(){for(const key of Object.keys(providerLabels))delete providerLabels[key];Object.assign(providerLabels,accountLabels());}
syncProviderLabels();document.addEventListener('agent-desk-accounts',syncProviderLabels);
let drafts={};try{drafts=JSON.parse(localStorage.getItem('agent-desk-coordinator-drafts')||'{}');}catch{}

// Local listboxes keep provider and model choices inside the app's visual system.
function coordinatorPicker(field, entries, editable=false){
 const wrapper=document.createElement('div');wrapper.className='coord-picker';field.before(wrapper);wrapper.append(field);
 const control=editable?field:document.createElement('button');
 if(!editable){field.hidden=true;control.type='button';control.id=field.id+'-trigger';wrapper.append(control);const label=document.querySelector('label[for="'+field.id+'"]');if(label)label.htmlFor=control.id;}
 field.removeAttribute('list');
 control.classList.add('coord-picker-control');control.setAttribute('role','combobox');control.setAttribute('aria-expanded','false');control.setAttribute('aria-haspopup','listbox');
 if(editable){control.autocomplete='off';control.setAttribute('aria-autocomplete','list');}
 const list=document.createElement('div');list.className='coord-picker-list';list.id=field.id+'-choices';list.setAttribute('role','listbox');list.setAttribute('aria-label',editable?'Coordinator models':'Reasoning provider and account');list.hidden=true;wrapper.append(list);control.setAttribute('aria-controls',list.id);
 let choices=entries,active=-1,visible=[];
 const close=()=>{list.hidden=true;control.setAttribute('aria-expanded','false');control.removeAttribute('aria-activedescendant');active=-1;};
 const sync=()=>{if(!editable){control.textContent=choices.find(x=>x.value===field.value)?.label||'Choose provider';control.disabled=field.disabled;}};
 function highlight(index){active=index;[...list.children].forEach((n,i)=>n.classList.toggle('active',i===index));if(list.children[index]){control.setAttribute('aria-activedescendant',list.children[index].id);list.children[index].scrollIntoView({block:'nearest'});}}
 function choose(item){field.value=item.value;field.dispatchEvent(new Event('change',{bubbles:true}));sync();close();control.focus();}
 function open(filter=false){
  if(control.disabled)return;
  const query=editable&&filter?field.value.toLowerCase():'';visible=choices.filter(x=>!query||x.label.toLowerCase().includes(query));
  if(editable&&query&&!choices.some(x=>x.value===field.value))visible.push({value:field.value,label:'Use “'+field.value+'”'});
  list.replaceChildren();visible.forEach((item,i)=>{const option=document.createElement('div');option.id=list.id+'-'+i;option.setAttribute('role','option');option.setAttribute('aria-label',item.label);option.setAttribute('aria-selected',String(item.value===field.value));option.textContent=item.label;option.onmousedown=e=>e.preventDefault();option.onclick=()=>choose(item);list.append(option);});
  list.hidden=false;control.setAttribute('aria-expanded','true');active=-1;
 }
 control.addEventListener('click',()=>{if(list.hidden)open();else if(!editable)close();});
 if(editable)control.addEventListener('input',()=>open(true));
 control.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&!list.hidden){event.preventDefault();event.stopPropagation();close();return;}
  if(event.key==='Tab'){close();return;}
  if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();if(list.hidden)open();highlight((active+(event.key==='ArrowDown'?1:-1)+visible.length)%visible.length);}
  else if(event.key==='Enter'&&!list.hidden){event.preventDefault();if(active>=0)choose(visible[active]);else close();}
  else if(!editable&&event.key.length===1&&event.key!==' '){event.preventDefault();if(list.hidden)open();const index=visible.findIndex(x=>x.label.toLowerCase().startsWith(event.key.toLowerCase()));if(index>=0)highlight(index);}
 });
 wrapper.addEventListener('focusout',event=>{if(!wrapper.contains(event.relatedTarget))close();});
 const dialog=field.closest('dialog');dialog.addEventListener('click',event=>{if(!wrapper.contains(event.target))close();});dialog.addEventListener('close',close);
 field.addEventListener('change',sync);sync();
 return {sync,close,setEntries(items){choices=items;if(!list.hidden)open();}};
}

let sequence=0;
function workspace(root,dialog,initialId){
 const suffix='-'+(++sequence);
 for(const container of [root,dialog]){
  for(const node of [container,...container.querySelectorAll('[id]')]){node.dataset.coordId=node.id;node.id+=suffix;}
  for(const label of container.querySelectorAll('[for]'))label.htmlFor+=suffix;
  for(const input of container.querySelectorAll('[list]'))input.setAttribute('list',input.getAttribute('list')+suffix);
  for(const node of container.querySelectorAll('[aria-labelledby]'))node.setAttribute('aria-labelledby',node.getAttribute('aria-labelledby')+suffix);
 }
 root.querySelector('textarea').rows=1;
const el=id=>root.querySelector('[data-coord-id="'+id+'"]')||dialog.querySelector('[data-coord-id="'+id+'"]')||(dialog.dataset.coordId===id?dialog:null);
let identity=null,snapshot={coordinators:[],messages:[],actions:[]},loading=false,seen=new Set(),pendingText='',editing=false;
const saveDraft=()=>{if(identity){drafts[identity]={text:el('coord-input').value,request_id:drafts[identity]?.request_id||crypto.randomUUID()};try{localStorage.setItem('agent-desk-coordinator-drafts',JSON.stringify(drafts));}catch{}}};
function failure(error){el('coord-error').textContent=error.message==='Not found'?'Restart Agent Desk to enable the dedicated coordinator.':error.message;}
function latest(){el('coord-transcript').scrollTop=el('coord-transcript').scrollHeight;el('coord-latest').classList.add('hidden');}
const textBlocks=window.deskTextBlocks;
function renderReport(container,text){
 container.replaceChildren();
 const lines=String(text||'').split('\n'),sections=[];let current={title:'Report',lines:[]},fence=null;
 const flush=()=>{if(current.lines.some(line=>line.trim()))sections.push(current);};
 for(let i=0;i<lines.length;i++){
  const line=lines[i],trim=line.trim(),code=trim.match(/^(`{3,}|~{3,})/);
  if(code){if(!fence)fence=code[1][0];else if(code[1][0]===fence)fence=null;current.lines.push(line);continue;}
  const explicit=!fence&&line.match(/^#{1,6}\s+(.+)/);
  const plain=!fence&&trim&&line===trim&&trim.length<90&&!/^[\d\-*•`]|[.!?]$/.test(trim)&&(i===0||!lines[i-1].trim())&&(!lines[i+1]?.trim()||/^[-*•]\s/.test(lines[i+1]||'')||/^(what i (started|did)|files changed|how i verified|what remains|summary|verification|next steps)$/i.test(trim)||/^files changed\s*\(/i.test(trim));
  if(explicit||plain){flush();current={title:explicit?explicit[1]:trim,lines:[]};}
  else current.lines.push(line);
 }
 flush();
 if(sections.length<2){textBlocks(container,text,true);return;}
 const priority=title=>/^(what i (started|did)|work (done|completed)|changes|outcome|summary|result)/i.test(title)?0:/^(how i verified|verification|checks|tests|validation)/i.test(title)?1:/^(what remains|remaining|next steps|follow.?up|decisions)/i.test(title)?2:3;
 const nav=document.createElement('div');nav.className='report-view-switch';nav.setAttribute('role','group');nav.setAttribute('aria-label','Report view');
 const review=document.createElement('button'),full=document.createElement('button');review.type=full.type='button';review.textContent='Review';full.textContent='Full report';nav.append(review,full);
 const content=document.createElement('div');content.className='report-sections';
 const original=document.createElement('div');original.className='report-original';original.hidden=true;textBlocks(original,text,true);
 for(const section of [...sections].sort((a,b)=>priority(a.title)-priority(b.title))){
  const item=document.createElement('details');item.className='report-section';item.open=priority(section.title)<3;
  const heading=document.createElement('summary');heading.textContent=section.title;
  const body=document.createElement('div');body.className='report-section-content';textBlocks(body,section.lines.join('\n'),true);item.append(heading,body);content.append(item);
 }
 if(!content.querySelector('details[open]'))content.firstElementChild.open=true;
 const select=isFull=>{content.hidden=isFull;original.hidden=!isFull;review.setAttribute('aria-pressed',String(!isFull));full.setAttribute('aria-pressed',String(isFull));};
 review.onclick=()=>select(false);full.onclick=()=>select(true);select(false);container.append(nav,content,original);
}
const toolLinks=document.createElement('div');toolLinks.className='coord-tool-links';toolLinks.hidden=true;el('coord-transcript').before(toolLinks);
const savedList=el('coord-saved-list');
// The worker bar is redrawn on every poll. This menu is built once and kept, so it stays open while it is used.
const attach=document.createElement('span');attach.className='coord-attach';attach.hidden=true;
const attachTrigger=document.createElement('button');attachTrigger.type='button';attachTrigger.className='coord-attach-trigger';attachTrigger.textContent='Add existing agent';attachTrigger.setAttribute('aria-haspopup','menu');attachTrigger.setAttribute('aria-expanded','false');
const attachList=document.createElement('div');attachList.className='coord-attach-list';attachList.setAttribute('role','menu');attachList.setAttribute('aria-label','Add an existing agent to this coordinator');attachList.hidden=true;
attach.append(attachTrigger,attachList);el('coord-workers').append(attach);
function closeAttach(){attachList.hidden=true;attachTrigger.setAttribute('aria-expanded','false');}
function openAttach(){
 attachList.hidden=false;attachTrigger.setAttribute('aria-expanded','true');
 // The bar scrolls when it holds many workers, so the menu is placed against the window instead of inside it.
 const box=attachTrigger.getBoundingClientRect();attachList.style.bottom=(innerHeight-box.top+6)+'px';
 attachList.style.left=Math.max(8,Math.min(box.left,innerWidth-attachList.offsetWidth-8))+'px';
 attachList.querySelector('[role=menuitem]')?.focus();
}
attachTrigger.onclick=()=>attachList.hidden?openAttach():closeAttach();
attach.onkeydown=e=>{
 if(attachList.hidden)return;
 const items=[...attachList.querySelectorAll('[role=menuitem]')],at=items.indexOf(document.activeElement);
 if(e.key==='Escape'){e.preventDefault();e.stopPropagation();closeAttach();attachTrigger.focus();}
 else if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();items[(at+(e.key==='ArrowDown'?1:-1)+items.length)%items.length]?.focus();}
};
document.addEventListener('pointerdown',e=>{if(!attach.contains(e.target))closeAttach();});
addEventListener('resize',closeAttach);
el('coord-context-open').after(el('coord-saved'));
const savedDialog=document.createElement('dialog');savedDialog.className='coord-saved-dialog';savedDialog.setAttribute('aria-label','Saved worker sessions');
const savedHeading=document.createElement('h2');savedHeading.textContent='Saved sessions';const savedClose=document.createElement('button');savedClose.textContent='×';savedClose.className='saved-dismiss';savedClose.setAttribute('aria-label','Close saved sessions');savedClose.onclick=()=>savedDialog.close();const savedHeader=document.createElement('header');savedHeader.append(savedHeading,savedClose);const savedHint=document.createElement('p');savedHint.className='saved-hint';savedHint.textContent='Pick up a previous worker conversation.';savedDialog.append(savedHeader,savedHint,savedList);document.body.append(savedDialog);
el('coord-saved').querySelector('.coord-saved-open').onclick=()=>savedDialog.showModal();
const deliveryList=document.createElement('div');deliveryList.className='coord-deliveries';deliveryList.hidden=true;el('coord-status').after(deliveryList);
const contextPanel=window.createContextPanel({identity:()=>identity,providers:providerLabels,renderText:textBlocks,onError:failure});
el('coord-context-open').onclick=()=>contextPanel.open();
const retireDialog=document.createElement('dialog');retireDialog.className='coord-retire-dialog';retireDialog.setAttribute('aria-label','Review completed work');
retireDialog.innerHTML=`<form class="coord-retire-form">
 <header class="coord-review-header"><div><div class="coord-review-eyebrow">Worker report</div><h2 class="coord-retire-name"></h2></div><button type="button" class="coord-review-dismiss" aria-label="Close review" autofocus>×</button></header>
 <div class="coord-review-body"><section class="coord-review-assignment"><h3>Assigned task</h3><p class="coord-review-task"></p></section><section class="coord-review-report"><h3>Final report</h3><div class="coord-retire-result"></div></section></div>
 <footer class="coord-review-footer"><p class="coord-review-note">Done reviewing? Save this session and close its terminal. Reopen it from Saved sessions when you need it.</p><div class="coord-session-discovery"><span></span><button type="button" class="text-button coord-session-retry">Retry</button></div><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button coord-retire-cancel">Keep open</button><button type="submit" class="button primary">Confirm &amp; close</button></div></footer>
</form>`;
document.body.append(retireDialog);let retiring=null;
retireDialog.querySelector('.coord-retire-cancel').onclick=()=>retireDialog.close();
retireDialog.querySelector('.coord-review-dismiss').onclick=()=>retireDialog.close();
function confirmRetirement(worker,review){
 retiring={worker_id:worker.id,task_id:review.task_id};
 retireDialog.querySelector('.coord-retire-name').textContent=worker.name;
 const task=snapshot.messages.find(message=>message.reply_task?.id===review.task_id)?.reply_task;
 const taskNode=retireDialog.querySelector('.coord-review-task');taskNode.textContent=task?.text||worker.completed_task||worker.task||'';
 const report=retireDialog.querySelector('.coord-retire-result');report.replaceChildren();
 renderReport(report,review.result||'Review the worker’s final report above before confirming.');
 retiring.session_id=review.session_id||'';
 retireDialog.querySelector('button[type=submit]').disabled=!retiring.session_id;
 retireDialog.querySelector('.coord-session-discovery span').textContent=retiring.session_id?'Session will be saved automatically.':'Finding the saved session…';
 retireDialog.querySelector('.coord-session-retry').hidden=!!retiring.session_id;
 discoverReview();
 retireDialog.querySelector('[role="alert"]').textContent='';retireDialog.showModal();
 retireDialog.querySelector('.coord-review-body').scrollTop=0;
}
async function discoverReview(){
 const target=retiring;if(!target)return;
 const status=retireDialog.querySelector('.coord-session-discovery span'),retry=retireDialog.querySelector('.coord-session-retry');
 if(!snapshot.review_features){if(!target.session_id)status.textContent='Restart Agent Desk to enable automatic session discovery.';return;}
 retry.disabled=true;
 try{const result=await terminalRequest('/api/coordinators/review-worker',{id:identity,...target});if(retiring!==target)return;
  target.session_id=result.session_id||'';
  const report=retireDialog.querySelector('.coord-retire-result');report.replaceChildren();renderReport(report,result.result);
  retireDialog.querySelector('.coord-review-task').textContent=result.task;
  status.textContent=target.session_id?'Session will be saved automatically.':'Session not found yet. Keep the terminal open and retry.';
  retireDialog.querySelector('button[type=submit]').disabled=!target.session_id;retry.hidden=!!target.session_id;
 }catch(error){if(retiring===target)status.textContent=error.message;}
 finally{retry.disabled=false;}
}
retireDialog.querySelector('.coord-session-retry').onclick=discoverReview;
retireDialog.querySelector('form').onsubmit=async event=>{
 event.preventDefault();event.submitter.disabled=true;
 try{
  await terminalRequest('/api/coordinators/retire-worker',{id:identity,...retiring,confirmed:true,session_id:retiring.session_id});
  retireDialog.close();closePane(retiring.worker_id);await refresh();await refreshWorkspace();
 }catch(error){retireDialog.querySelector('[role="alert"]').textContent=error.message;}
 finally{event.submitter.disabled=false;}
};
let quotaRequestedAt=0,quotaIdentity=null,quotaBusy=false,quotaData=null;
function renderQuota(){
 const node=el('coord-quota');node.classList.toggle('hidden',!identity);
 if(!identity)return;
 if(!snapshot.quota_features){el('coord-quota-label').textContent='Account quota · restart Agent Desk to enable';return;}
 const data=quotaData;
 const remaining=w=>Math.round(w.remaining_percent)+'% left';
 el('coord-quota-label').textContent='Account quota · '+(!data?'Checking…':data.state==='ready'?data.label:data.state==='stale'?'Last reading · out of date':data.state==='loading'?'Checking…':data.state==='unsupported'?data.label+' · no live quota adapter':'Unavailable');
 // Only general account windows belong in the compact summary. Named model
 // allowances (e.g. Spark) stay in details; they cannot identify the active model.
 if(data?.state==='ready'){
  const general=data.windows.filter(w=>!w.account_bucket||String(w.bucket).toLowerCase()==='codex');
  const shortLabel=w=>w.bucket&&w.label.startsWith(w.bucket+' · ')?w.label.slice(w.bucket.length+3):w.label;
  el('coord-quota-label').textContent='Account quota · '+(general.length?general.map(w=>shortLabel(w)+' '+remaining(w)).join(' · '):'View account allowances');
 }
 el('coord-quota-updated').textContent=data?.fetched_at?'Updated '+new Date(data.fetched_at*1000).toLocaleTimeString():'';
 const detail=el('coord-quota-detail');detail.replaceChildren();
 if(!data)return;
 for(const w of data.windows){
  const chip=document.createElement('span');chip.className='quota-chip'+(w.remaining_percent<=10?' quota-low':'');
  const label=document.createElement('span');label.textContent=w.label;
  const value=document.createElement('strong');value.textContent=remaining(w);chip.append(label,document.createTextNode(' · '),value);
  chip.title=(data.state==='stale'?'Outdated reading. ':'')+(w.resets_at?'Resets '+new Date(w.resets_at*1000).toLocaleString()+'. ':'')+(data.fetched_at?'Updated '+new Date(data.fetched_at*1000).toLocaleTimeString()+'. ':'')+'Shared account quota; this does not identify the coordinator’s selected model.';
  detail.append(chip);
 }
 if(data.message){const explanation=document.createElement('span');explanation.className='quota-message';explanation.textContent=data.message;detail.append(explanation);}
 detail.title='Account allowance across sessions. Model selection is controlled separately.';

}
async function refreshQuota(){
 if(quotaIdentity!==identity){quotaIdentity=identity;quotaData=null;quotaRequestedAt=0;}
 renderQuota();
 if(!identity||!snapshot.quota_features||quotaBusy||Date.now()-quotaRequestedAt<10000)return;
 const target=identity;quotaBusy=true;quotaRequestedAt=Date.now();
 try{const data=await terminalRequest('/api/coordinators/quota',{id:target});if(identity===target){quotaData=data;renderQuota();}}
 catch{if(identity===target){quotaData={state:'unavailable',windows:[],message:'Could not retrieve quota. Agent Desk may need a restart.'};renderQuota();}}
 finally{quotaBusy=false;}
}
function render(){
 const current=snapshot.coordinators.find(c=>c.id===identity);
 const menu=el('coord-sessions'),value=identity||'';
 const options=snapshot.coordinators.map(c=>[c.id,c.name]);
 if(menu.dataset.options!==JSON.stringify(options)){
  menu.replaceChildren(new Option('New conversation',''),...options.map(([id,name])=>new Option(name,id)));menu.dataset.options=JSON.stringify(options);
 }menu.value=value;
 const log=el('coord-transcript'),bottom=log.scrollHeight-log.scrollTop-log.clientHeight<70;
 for(const message of snapshot.messages){
  if(seen.has(message.id))continue;
  if(!seen.size)log.replaceChildren();seen.add(message.id);
  const node=document.createElement('article');node.className='coord-message '+message.kind;node.dataset.messageId=message.id;
  let body=message.text;
  if(message.kind==='worker'){
   // Older servers embed a shortened task and outcome above the result.
   const legacy=body.match(/^([\s\S]*?) · (completed|failed|blocked)\n\n([\s\S]*)$/);
   const task=message.reply_task||(legacy?{text:legacy[1],outcome:legacy[2],result:legacy[3]}:null);
   const label=document.createElement('small');label.textContent='Worker reported back'+(task?' · '+task.outcome:'');node.append(label);
   if(task){
    const title=document.createElement('div');title.className='coord-reply-task';
    if(task.text.length>160||task.text.includes('\n')){
     const details=document.createElement('details'),summary=document.createElement('summary'),full=document.createElement('div');
     summary.textContent='Task: '+task.text.split('\n')[0].slice(0,160)+'…';full.textContent=task.text;
     details.append(summary,full);title.append(details);
    }else title.textContent='Task: '+task.text;
    if(task.id)title.title=task.id;
    node.append(title);body=task.result;
   }
  }
  const clean=body.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g,'');
  if(message.kind==='tool'&&clean.length>240){const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent=clean.split('\n')[0].slice(0,160);details.append(summary);textBlocks(details,clean);node.append(details);}else textBlocks(node,clean);
  if(message.kind==='tool'){
   let group=log.lastElementChild;
   if(!group?.classList.contains('coord-activity')){group=document.createElement('details');group.className='coord-activity';const summary=document.createElement('summary');summary.textContent='Activity';group.append(summary);log.append(group);}
   group.append(node);group.firstElementChild.textContent='Activity · '+(group.children.length-1);
  }else log.append(node);
 }
 if(bottom)latest();else if(snapshot.messages.length)el('coord-latest').classList.remove('hidden');
 const tools=snapshot.hook_tools||[];toolLinks.hidden=!tools.length;const toolSignature=JSON.stringify(tools);if(toolLinks.dataset.signature!==toolSignature){toolLinks.dataset.signature=toolSignature;toolLinks.replaceChildren();for(const tool of tools){const link=document.createElement('a');link.href=/^\/apps\/[\w-]+$/.test(tool.endpoint)?tool.endpoint:'#';link.textContent='Review · '+tool.target.split('/').filter(Boolean).at(-1);link.title=tool.target;link.onclick=e=>{if(e.button||e.metaKey||e.ctrlKey||e.shiftKey)return;e.preventDefault();window.openDeskTool(tool.endpoint);};toolLinks.append(link);}}
 const workers=(window.coordinatorWorkers||[]).filter(w=>w.parent_id===identity);
 const workerBar=el('coord-workers');for(const node of [...workerBar.children])if(node!==attach)node.remove();
 for(const worker of workers){
  const group=document.createElement('span');group.className='coord-worker-group';group.dataset.workerId=worker.id;
  const button=document.createElement('button');button.textContent=worker.name+' · '+(labels[worker.status]||worker.status);button.onclick=()=>selectPane(worker.id);group.append(button);
  const review=(snapshot.worker_reviews||[]).find(r=>r.worker_id===worker.id);
  if(review){
   group.classList.add('ready-for-review');button.textContent=worker.name;
   const state=document.createElement('span');state.className='coord-worker-state';state.textContent='✓ Ready for review';group.append(state);
   button.title='Worker reported this task complete. Review its result before closing.';
   const close=document.createElement('button');close.className='coord-retire';close.textContent='Review & close';close.onclick=()=>confirmRetirement(worker,review);group.append(close);
  }
  attach.before(group);
 }
 const attachable=snapshot.attachable_workers||[],attachSignature=JSON.stringify(attachable.map(w=>[w.worker_id,w.name,w.profile,w.cwd]));
 attach.hidden=!attachable.length;if(!attachable.length)closeAttach();
 if(attach.dataset.signature!==attachSignature){
  attach.dataset.signature=attachSignature;attachList.replaceChildren();
  for(const worker of attachable){
   const item=document.createElement('button'),name=document.createElement('strong'),meta=document.createElement('small');
   item.type='button';item.setAttribute('role','menuitem');name.textContent=worker.name;meta.textContent=(providerLabels[worker.profile]||worker.profile)+' · '+shortPath(worker.cwd);item.title=worker.cwd;item.append(name,meta);
   item.onclick=async()=>{closeAttach();attachTrigger.disabled=true;try{await terminalRequest('/api/coordinators/attach-worker',{id:identity,worker_id:worker.worker_id});await refresh();await refreshWorkspace();toast('Agent attached. Its conversation and current work are preserved.');}catch(error){failure(error);}finally{attachTrigger.disabled=false;}};
   attachList.append(item);
  }
 }
 const saved=(snapshot.saved_workers||[]).filter(w=>w.state!=='active'||w.can_resume);
 el('coord-saved').classList.toggle('hidden',!saved.length);savedList.replaceChildren();el('coord-saved').querySelector('.coord-saved-open').textContent='Saved sessions · '+saved.length;
 for(const worker of saved){
  const row=document.createElement('div'),label=document.createElement('span'),button=document.createElement('button');
  const name=document.createElement('strong'),meta=document.createElement('small');name.textContent=worker.name;meta.textContent=worker.profile+' · '+shortPath(worker.cwd)+(worker.pending_tasks?.length?' · unfinished task':'');meta.title=worker.cwd;label.append(name,meta);label.title=worker.last_task||'';
  button.textContent=worker.can_resume?'Resume':worker.state==='unavailable'?'Link session & resume':'Needs inspection';button.disabled=!worker.can_resume&&worker.state!=='unavailable';
  button.onclick=async()=>{let session_id;if(worker.state==='unavailable'){session_id=prompt('Exact native conversation ID for '+worker.name);if(!session_id)return;}button.disabled=true;try{const result=await terminalRequest('/api/coordinators/resume-worker',{id:identity,worker_id:worker.worker,session_id});savedDialog.close();await refresh();selectPane(result.worker_id,true);await refreshWorkspace();}catch(error){failure(error);}finally{button.disabled=false;}};
  row.append(label);
  if(worker.report_task_id){const report=document.createElement('a');report.className='button';report.textContent='Open report ↗';report.href='/inbox-document.html?kind=worker&item='+encodeURIComponent(worker.report_task_id);report.target='_blank';report.rel='noopener noreferrer';row.append(report);}
  row.append(button);savedList.append(row);
 }
 el('coord-context-open').classList.toggle('hidden',!identity||!snapshot.context_features);
 refreshQuota();
 const usage=snapshot.usage;
 el('coord-usage').classList.toggle('hidden',!usage);
 if(usage){
  const number=value=>Number(value||0).toLocaleString();
  const total=(usage.totals?.input_tokens||0)+(usage.totals?.output_tokens||0);
  const last=usage.last;
  el('coord-usage-label').textContent='Usage · '+(usage.reported_turns?number(total)+' reported tokens':'No reported tokens yet')+(last?' · Context '+Math.ceil(last.context_bytes/1024)+' / '+Math.ceil(usage.context_limit_bytes/1024)+' KB':'');
  const detail=el('coord-usage-detail'),signature=JSON.stringify(usage);
  if(detail.dataset.signature!==signature){
   detail.dataset.signature=signature;detail.replaceChildren();
   const metrics=document.createElement('div');metrics.className='usage-metrics';
   for(const [label,key] of [['Input','input_tokens'],['Output','output_tokens'],['Cached input','cached_input_tokens']]){
    const cell=document.createElement('div'),caption=document.createElement('span'),value=document.createElement('strong');
    caption.textContent=label;value.textContent=usage.reported_turns?number(usage.totals?.[key]):'—';cell.append(caption,value);metrics.append(cell);
   }
   const context=document.createElement('div');context.className='usage-context';
   const caption=document.createElement('span');caption.textContent=last?'Context · '+Math.ceil(last.context_bytes/1024)+' of '+Math.ceil(usage.context_limit_bytes/1024)+' KB':'Context · waiting for first turn';
   const meter=document.createElement('progress');meter.max=usage.context_limit_bytes||96000;meter.value=last?.context_bytes||0;meter.setAttribute('aria-label','Supplied context budget');
   const hint=document.createElement('small');hint.textContent=last?.context_trimmed?'Older history was trimmed · full record saved':last?.estimated_input_tokens!=null?'~'+number(last.estimated_input_tokens)+' prompt tokens · estimated':'Usage starts with your next turn';
   context.append(caption,meter,hint);
   const note=document.createElement('details');note.className='usage-explanation';const summary=document.createElement('summary');summary.textContent=number(usage.reported_turns)+' of '+number(usage.turns)+' calls measured · About these counts';
   const text=document.createElement('p');text.textContent='Coordinator and optional reader calls; native worker terminals excluded. Cached input is included in Input. Missing usage is unknown, not zero. Prompt estimates exclude CLI-added context. These are usage records, not billing totals.';
   note.append(summary,text);detail.append(metrics,context,note);
  }
 }
 const queued=(snapshot.actions||[]).filter(a=>a.state==='queued');deliveryList.hidden=!queued.length;
 const deliverySignature=JSON.stringify(queued);if(deliveryList.dataset.signature!==deliverySignature){deliveryList.dataset.signature=deliverySignature;deliveryList.replaceChildren();
  for(const action of queued){const row=document.createElement('div'),text=document.createElement('span'),cancel=document.createElement('button');text.textContent='Waiting to deliver · '+(action.task||action.detail||'').slice(0,240);text.title=action.detail;cancel.type='button';cancel.textContent='Cancel';cancel.onclick=async()=>{cancel.disabled=true;try{await terminalRequest('/api/coordinators/cancel-delivery',{id:identity,action_id:action.id});await refreshWorkspace();}catch(e){failure(e);}finally{cancel.disabled=false;}};row.append(text,cancel);deliveryList.append(row);}
 }
 const status=el('coord-status');status.classList.toggle('busy',current?.state==='working');status.classList.toggle('attention',['needs_input','error'].includes(current?.state));
 status.textContent=!current?'Ready for your task':current.state==='error'?'Action failed · '+(current.attention_reason||[...snapshot.messages].reverse().find(m=>m.kind==='error')?.text||'Check the error below before continuing'):current.paused?(current.state==='needs_input'?(current.attention_reason||'Needs your answer'):'Paused · send a message to continue'):current.state==='working'?'Coordinating… · Esc to pause':workers.some(w=>w.exit_code===null)?'Available · worker terminals connected':'Ready for your task';
 const activity=snapshot.activity;
 if(activity&&current){
  const elapsed=Number.isFinite(activity.elapsed_seconds)?Math.max(0,Math.floor(activity.elapsed_seconds)):null;
  const clock=elapsed===null?'':Math.floor(elapsed/60)+':'+String(elapsed%60).padStart(2,'0');
  status.dataset.phase=activity.phase;
  status.classList.toggle('busy',['planning','queued'].includes(activity.phase));
  status.classList.toggle('attention',['error','needs_input'].includes(activity.phase));
  status.textContent=activity.label+(activity.count?' · '+activity.count+' '+(activity.phase==='waiting'?'pending report'+(activity.count===1?'':'s'):'queued'):'')+(clock?' · '+clock+' elapsed':'')+(activity.phase==='planning'?' · Esc to pause':'');
 }else{status.dataset.phase=current?.state==='working'?'planning':'idle';}
 el('coord-model-edit').classList.toggle('hidden',!current);el('coord-close').classList.toggle('hidden',!current);
 el('coord-model-edit').textContent='Model: '+(current?.model||'CLI default')+(current?.router?' · workers routed':'')+' ▾';
 el('coord-model-edit').title=(current?.router?'The model router picks each new worker’s model and harness. ':'')+'Change the coordinator model for the next turn or worker routing. Quota buckets are separate account limits.';
 el('coord-context').textContent=current?(current.remote_node?'Remote · '+current.remote_name+' / '+current.profile:(providerLabels[current.profile]||current.profile))+(current.model?' / '+current.model:'')+' · '+shortPath(current.cwd):'Choose a project to start';
 el('coord-pause').classList.toggle('hidden',!current||!!current.paused);
 el('coord-input').placeholder=current?.state==='working'?'Add instructions for the next turn…':'Describe a task or type / for commands';
}
async function refreshWorkspace(){
 if(loading)return;loading=true;
 try{const captured=identity;const data=await terminalRequest('/api/coordinators'+(captured?'?id='+encodeURIComponent(captured):''));if(identity!==captured)return;snapshot=data;el('coord-error').textContent='';window.coordinatorWorkers=agents;render();}
 catch(e){failure(e);const status=el('coord-status');status.dataset.phase='disconnected';status.classList.remove('busy');status.textContent='Connection lost · activity status unavailable';}finally{loading=false;}
}
async function open(id){
 saveDraft();identity=id||null;demo=false;seen=new Set();snapshot.messages=[];
 el('coord-transcript').innerHTML='<div class="coord-welcome"><strong>Agent Desk <span> / coordinator</span></strong><p>Describe a task to delegate work to your agents.</p><p class="coord-muted">/help for commands · /workers for your team</p></div>';
 el('coord-input').value=drafts[identity]?.text||'';await refreshWorkspace();el('coord-input').focus();
};
const providerPicker=coordinatorPicker(el('coord-profile'),[...el('coord-profile').options].map(o=>({value:o.value,label:o.textContent})));
const defaultModel={value:'',label:'CLI default'};
const modelPicker=coordinatorPicker(el('coord-model'),[defaultModel],true);
let remoteNodes=[];
const environmentPicker=coordinatorPicker(el('coord-environment'),[{value:'',label:'This computer'}]);
function environmentChanged(reset=true){
 const node=remoteNodes.find(n=>n.id===el('coord-environment').value),prior=el('coord-profile').value;
 const choices=node?(node.profiles||[]).map(p=>({value:p,label:p[0].toUpperCase()+p.slice(1)+' · Remote environment'})):Object.entries(providerLabels).map(([value,label])=>({value,label}));
 el('coord-profile').replaceChildren(...choices.map(c=>new Option(c.label,c.value)));
 if(choices.some(c=>c.value===prior))el('coord-profile').value=prior;
 providerPicker.setEntries(choices);providerPicker.sync();environmentPicker.sync();
 el('coord-environment-help').textContent=node?'Remote · '+node.name+' — coordinator and workers use remote executables, environment variables, and saved logins. '+(!node.connected?'Reconnect this environment before continuing.':!node.node?'Node is missing on the remote machine. Install it before creating agents.':''):'';
 if(reset){el('coord-cwd').value=node?node.home:terminalDefaultCwd||'';el('coord-model').value='';}
 el('coord-profile').onchange();routerToggle.refresh();
}
el('coord-environment').onchange=()=>environmentChanged();
const workerModelHelp=el('coord-worker-model-help').textContent;
const routerToggle=window.modelRouter.bindToggle({checkbox:el('coord-router'),status:el('coord-router-status'),settings:el('coord-router-settings'),
 unavailable:()=>el('coord-environment').value?'Model routing runs on this computer only; remote coordinators choose worker models themselves.':null,
 onChange:()=>{el('coord-worker-model-help').textContent=el('coord-router').checked?'The router picks each new worker’s model from its task, and Agent Desk opens the harness that runs it with this account family. Models you name explicitly still win. Existing workers keep their models.':workerModelHelp;}});
el('coord-connect-remote').onclick=()=>{dialog.close();window.connectRemoteEnvironment();};
async function loadModels(){
 const profile=el('coord-profile').value,remote_node=el('coord-environment').value;modelPicker.setEntries([defaultModel]);
 try{const data=await terminalRequest('/api/coordinators/models',{profile,...(remote_node?{remote_node}:{})});if(el('coord-profile').value!==profile||el('coord-environment').value!==remote_node)return;modelPicker.setEntries([defaultModel,...data.models.map(model=>({value:model,label:model}))]);el('coord-model-help').textContent=data.source;}
 catch{el('coord-model-help').textContent='Enter the model ID accepted by your selected CLI. Empty uses its default.';}
}
async function createDialog(edit=false,remoteNode=null){
 editing=edit;const c=snapshot.coordinators.find(c=>c.id===identity);
 try{remoteNodes=(await terminalRequest('/api/remote/nodes',{})).nodes||[];}catch{remoteNodes=[];}
 const wanted=remoteNode?.id||(edit?c?.remote_node:'')||'';
 if(wanted&&!remoteNodes.some(n=>n.id===wanted))remoteNodes.push(remoteNode||{id:wanted,name:c?.remote_name||'Disconnected',profiles:[c?.profile],home:c?.cwd,connected:false});
 const environments=[{value:'',label:'This computer'},...remoteNodes.map(n=>({value:n.id,label:'Remote · '+n.name+(n.connected?'':' · disconnected')}))];
 el('coord-environment').replaceChildren(...environments.map(e=>new Option(e.label,e.value)));el('coord-environment').value=wanted;
 environmentPicker.setEntries(environments);environmentChanged(false);
 el('coord-connect-remote').hidden=edit;
 for(const id of ['coord-name','coord-cwd','coord-profile','coord-environment'])el(id).disabled=edit;
 el('coord-create-title').textContent=edit?'Coordinator and worker models':'Start a conversation';
 el('coord-create-form').querySelector('[type="submit"]').textContent=edit?'Save':'Create coordinator';
 el('coord-router').checked=!!(edit&&c?.router);routerToggle.refresh();
 if(edit&&c){el('coord-name').value=c.name;el('coord-cwd').value=c.cwd;el('coord-profile').value=c.profile;el('coord-model').value=c.model||'';}
 else if(wanted){el('coord-cwd').value=remoteNodes.find(n=>n.id===wanted)?.home||'';el('coord-model').value='';}
 else{el('coord-cwd').value=current().find(a=>a.id===selectedId)?.cwd||terminalDefaultCwd||'';el('coord-model').value='';}
 environmentPicker.sync();environmentPicker.close();providerPicker.sync();providerPicker.close();modelPicker.close();el('coord-create-error').textContent='';el('coord-profile').onchange();el('coord-create-dialog').showModal();
}
el('coord-model-edit').onclick=()=>createDialog(true);
el('coord-close').onclick=()=>window.closeCoordinator(identity);
el('coord-quota-refresh').onclick=async()=>{if(!identity||quotaBusy)return;quotaBusy=true;try{quotaData=await terminalRequest('/api/coordinators/quota',{id:identity,refresh:true});quotaRequestedAt=0;renderQuota();}catch(e){failure(e);}finally{quotaBusy=false;}};
el('coord-profile').onchange=()=>{
 const provider=el('coord-profile').value;providerPicker.sync();loadModels();
 el('coord-provider-help').textContent=el('coord-environment').value?'Uses the CLI and credentials configured on the remote machine. Your laptop’s harness credentials are not sent.':['grok','opencode','pi'].includes(provider)?'Uses the installed '+providerLabels[provider]+' CLI and its saved login.':'Uses your saved '+providerLabels[provider]+' CLI login. Workers keep their own accounts and terminals.';
};
el('coord-new').onclick=()=>{pendingText='';createDialog();};
el('coord-sessions').onchange=event=>window.openCoordinatorWorkspace(event.target.value);
el('coord-create-form').onsubmit=async event=>{
 event.preventDefault();const button=event.submitter;button.disabled=true;
 try{if(editing){await terminalRequest('/api/coordinators/configure',{id:identity,model:el('coord-model').value.trim(),router:el('coord-router').checked});el('coord-create-dialog').close();await refreshWorkspace();return;}const c=await terminalRequest('/api/coordinators/create',{desk:activeDesk().id,name:el('coord-name').value,cwd:el('coord-cwd').value,profile:el('coord-profile').value,...(el('coord-environment').value?{remote_node:el('coord-environment').value}:{}),model:el('coord-model').value.trim(),...(el('coord-router').checked?{router:true}:{})});el('coord-create-dialog').close();await refresh();const target=await window.openCoordinatorWorkspace(c.id);if(pendingText){await target.submit(pendingText);pendingText='';}}
 catch(e){el('coord-create-error').textContent=e.message==='Not found'?'Restart Agent Desk to enable the dedicated coordinator.':e.message;}finally{button.disabled=false;}
};
const hooksDialog=document.createElement('dialog');hooksDialog.className='coord-hooks-dialog';hooksDialog.setAttribute('aria-label','Coordinator hooks');
hooksDialog.innerHTML=`<header><h2>Hooks</h2><button type="button" class="hooks-close" aria-label="Close hooks">×</button></header>
<p class="hooks-intro">Your rules for when the coordinator should act.</p><div class="hooks-scope-section">
<label class="hooks-defaults"><input type="checkbox"> Edit default hooks</label>
<p class="hooks-scope"></p><div class="hooks-default-preview"></div></div><div class="hooks-list-heading"><div><h3 class="hooks-list-title">Session hooks</h3><span class="hooks-count"></span></div><button type="button" class="hooks-add">+ Add hook</button></div><div class="hooks-list"></div>
<form hidden><button type="button" class="hooks-preset">Use pre-PR review example</button><h3 class="hooks-form-title">Add hook</h3><label>Tool / skill UI<input class="hooks-skill" aria-label="Hook tool"></label><label>When<textarea class="hooks-instruction" aria-label="When" maxlength="1000" required placeholder="If creating a Notion doc, open our document review skill so I can review the draft first."></textarea></label><details class="hooks-timing"><summary>Advanced timing</summary><label>Evaluate<input class="hooks-event" aria-label="Hook event"></label><p>By default, your condition is checked throughout the task. Choose a specific event only if you need one.</p></details><label><input class="hooks-enabled" type="checkbox" checked> Enabled</label><footer><button type="submit">Save hook</button><button type="button" class="hooks-cancel">Cancel</button></footer></form>
<details class="hook-projects"><summary>Review projects</summary><p>Allow this coordinator to review another Git repository and its worktrees.</p><input class="hook-project-path" aria-label="Review project directory" placeholder="/absolute/path/to/repository"><button type="button" class="hook-project-add">Allow project</button><div class="hook-project-list"></div></details><p role="alert"></p><details><summary>Recent hook events</summary><div class="hooks-runs"></div></details>`;
document.body.append(hooksDialog);
const hq=s=>hooksDialog.querySelector(s);let hooksState=null,hookDefaultsState=null,editingHook=null,hooksBusy=false;
async function loadReviewProjects(){try{const data=await terminalRequest('/api/coordinators/review-projects',{id:identity});const list=hq('.hook-project-list');list.replaceChildren();for(const project of data.projects||[]){const row=document.createElement('div'),name=document.createElement('span'),remove=document.createElement('button');name.textContent=project.project;remove.textContent='Remove';remove.type='button';remove.onclick=async()=>{try{await terminalRequest('/api/coordinators/save-review-project',{id:identity,project:project.project,remove:true});await loadReviewProjects();}catch(e){hq('[role=alert]').textContent=e.message;}};row.append(name,remove);list.append(row);}}catch(e){hq('[role=alert]').textContent=e.message;}}
hq('.hook-projects').ontoggle=()=>{if(hq('.hook-projects').open)loadReviewProjects();};
hq('.hook-project-add').onclick=async()=>{try{await terminalRequest('/api/coordinators/save-review-project',{id:identity,project:hq('.hook-project-path').value.trim()});hq('.hook-project-path').value='';await loadReviewProjects();}catch(e){hq('[role=alert]').textContent=e.message;}};
const hookEventField=hq('.hooks-event');hookEventField.id='hook-event-'+crypto.randomUUID();
const hookPicker=coordinatorPicker(hookEventField,[]);hookPicker.control?.setAttribute('aria-label','Hook event');
hookEventField.parentElement.querySelector('[role=combobox]').setAttribute('aria-label','Hook event');hookEventField.parentElement.querySelector('[role=listbox]').setAttribute('aria-label','Hook events');
const hookSkillField=hq('.hooks-skill');hookSkillField.id='hook-skill-'+crypto.randomUUID();const hookSkillPicker=coordinatorPicker(hookSkillField,[]);hq('.hooks-skill').parentElement.querySelector('[role=combobox]').setAttribute('aria-label','Hook tool');
function hookPayload(){return {id:identity,defaults:hq('.hooks-defaults input').checked};}
function resetHook(){hq('form').hidden=true;editingHook=null;hq('form').reset();hq('.hooks-form-title').textContent='Add hook';hq('.hooks-cancel').hidden=false;hq('.hooks-timing').open=false;hookEventField.value='condition';hookPicker.sync();hookSkillField.value='';hookSkillPicker.sync();}
function renderHooks(){
 hookSkillPicker.setEntries([{value:'',label:'Coordinator instruction only'},...(hooksState.tools||[]).map(t=>({value:t.id,label:t.title}))]);
 hookPicker.setEntries(Object.entries(hooksState.events).map(([value,label])=>({value,label})));
 hq('.hooks-scope').hidden=!hookPayload().defaults;
 hq('.hooks-scope').textContent=hookPayload().defaults?(hooksState?.live_defaults?'Enabled defaults apply to all coordinators, including existing sessions. Changes apply on their next turn.':'Restart Agent Desk to enable defaults for existing sessions.'):'';
 const preview=hq('.hooks-default-preview');preview.replaceChildren();preview.hidden=hookPayload().defaults;
 if(!preview.hidden){
  const defaults=hookDefaultsState?.hooks||[],heading=document.createElement('strong');heading.textContent='Default hooks · '+defaults.filter(h=>h.enabled).length+' enabled';preview.append(heading);const scope=document.createElement('p');scope.textContent=hookDefaultsState?.live_defaults?'Enabled defaults apply to this session.':'Restart Agent Desk to apply these defaults to existing sessions.';preview.append(scope);
  if(!defaults.length){const empty=document.createElement('p');empty.textContent='No default hooks configured.';preview.append(empty);}
  for(const hook of defaults){const row=document.createElement('div');row.className='hooks-default-item';
   const name=document.createElement('div'),title=document.createElement('strong');title.textContent=hook.skill?((hooksState.tools||[]).find(t=>t.id===hook.skill)?.title||hook.skill):'Coordinator instruction';const condition=document.createElement('p');condition.textContent=hook.instruction;name.append(title,condition);
   const status=document.createElement('span');status.className='hooks-default-status';status.dataset.enabled=String(!!hook.enabled);status.textContent=hook.enabled?'On':'Off';row.append(name,status);preview.append(row);}
 }
 hq('.hooks-list-title').textContent=hookPayload().defaults?'Default hooks':'Session hooks';
 hq('.hooks-count').textContent=hooksState.hooks.filter(h=>h.enabled).length+' enabled · '+hooksState.hooks.length+' total';
 const list=hq('.hooks-list');list.replaceChildren();
 if(!hooksState.hooks.length){const empty=document.createElement('p');empty.textContent='No hooks yet.';list.append(empty);}
 for(const hook of hooksState.hooks){const row=document.createElement('article');row.className='hooks-row';row.dataset.enabled=String(!!hook.enabled);
 const top=document.createElement('div');top.className='hooks-card-top';
 const title=document.createElement('strong');title.textContent=hook.skill?((hooksState.tools||[]).find(t=>t.id===hook.skill)?.title||hook.skill):'Coordinator instruction';
 const toggle=document.createElement('button');toggle.type='button';toggle.className='hooks-toggle';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(!!hook.enabled));toggle.setAttribute('aria-label','Enable '+title.textContent);toggle.textContent=hook.enabled?'On':'Off';toggle.onclick=()=>saveHook({...hook,hook_id:hook.id,enabled:!hook.enabled});top.append(title,toggle);
 const text=document.createElement('p');text.className='hooks-condition';text.textContent=hook.instruction;
 const bottom=document.createElement('div');bottom.className='hooks-card-bottom';const timing=document.createElement('span');timing.textContent=({condition:'Prompt condition',before_publish:'Before publish'})[hook.event]||hooksState.events[hook.event];bottom.append(timing);
 const edit=document.createElement('button');edit.type='button';edit.textContent='Edit';edit.onclick=()=>{editingHook=hook.id;hq('form').hidden=false;hookSkillField.value=hook.skill||'';hookSkillPicker.sync();hookEventField.value=hook.event;hq('.hooks-timing').open=hook.event!=='condition';hookPicker.sync();hq('.hooks-instruction').value=hook.instruction;hq('.hooks-enabled').checked=!!hook.enabled;hq('.hooks-form-title').textContent='Edit hook';hq('.hooks-instruction').focus();};
 const remove=document.createElement('button');remove.type='button';remove.textContent='Delete';remove.onclick=()=>saveHook({hook_id:hook.id,delete:true});bottom.append(edit,remove);row.append(top,text,bottom);list.append(row);}
 const runs=hq('.hooks-runs');runs.replaceChildren();for(const run of hooksState.runs){const p=document.createElement('p');p.textContent=new Date(run.created*1000).toLocaleString()+' · '+hooksState.events[run.event]+' · '+run.instruction;runs.append(p);}
 if(!hooksState.runs.length)runs.textContent='No hook events yet. Entries record instructions queued, not completed work.';
}
async function loadHooks(){const payload=hookPayload();if(payload.defaults){hooksState=await terminalRequest('/api/coordinators/hooks',payload);hookDefaultsState=hooksState;}else{[hooksState,hookDefaultsState]=await Promise.all([terminalRequest('/api/coordinators/hooks',payload),terminalRequest('/api/coordinators/hooks',{...payload,defaults:true})]);}renderHooks();resetHook();}
async function saveHook(change){if(hooksBusy)return;hooksBusy=true;hq('[role="alert"]').textContent='';hooksDialog.querySelectorAll('button,input,textarea').forEach(n=>n.disabled=true);
 try{hooksState=await terminalRequest('/api/coordinators/save-hook',{...change,...hookPayload()});if(hookPayload().defaults)hookDefaultsState=hooksState;renderHooks();resetHook();}
 catch(e){hq('[role="alert"]').textContent=e.message;await loadHooks().catch(()=>{});}
 finally{hooksBusy=false;hooksDialog.querySelectorAll('button,input,textarea').forEach(n=>n.disabled=false);}}
async function openHooks(){if(!identity){toast('Create a coordinator first to configure hooks.');return;}hq('[role="alert"]').textContent='';await loadHooks();hooksDialog.showModal();}
hq('form').onsubmit=e=>{e.preventDefault();saveHook({hook_id:editingHook,event:hookEventField.value,skill:hookSkillField.value,instruction:hq('.hooks-instruction').value,enabled:hq('.hooks-enabled').checked});};
hq('.hooks-defaults input').onchange=()=>loadHooks().catch(e=>hq('[role="alert"]').textContent=e.message);
hq('.hooks-add').onclick=()=>{resetHook();hq('form').hidden=false;hq('.hooks-instruction').focus();};
hq('.hooks-preset').onclick=()=>{resetHook();hq('form').hidden=false;hookEventField.value='before_publish';hq('.hooks-timing').open=true;hookPicker.sync();hookSkillField.value='code-review';hookSkillPicker.sync();hq('.hooks-instruction').value='Before pushing or opening a PR on GitHub, launch our code review UI so I can review the code locally and iterate before publishing.';};
hq('.hooks-close').onclick=()=>hooksDialog.close();hq('.hooks-cancel').onclick=resetHook;

const commands={'/hooks':'Configure event hooks and defaults','/model':'Change coordinator model','/close':'Close and save this coordinator','/help':'Show keyboard shortcuts and commands','/workers':'Show worker terminals','/pause':'Pause coordination; leave workers running','/new':'Start a new coordinator conversation'};
async function send(){
 const text=el('coord-input').value.trim();if(!text)return;
 if(text.startsWith('/')&&commands[text]){
  if(text==='/hooks'){await openHooks();}
  else if(text==='/model'){createDialog(true);}
  else if(text==='/close'){if(identity)window.closeCoordinator(identity);}
  else if(text==='/new'){pendingText='';createDialog();}
  else if(text==='/pause'){if(identity)await terminalRequest('/api/coordinators/pause',{id:identity});await refreshWorkspace();}
  else if(text==='/workers'){el('coord-workers').scrollIntoView({block:'nearest'});toast('Click a worker below the conversation to open its native terminal.');}
  else toast('Enter sends · Shift+Enter adds a line · Esc pauses · /hooks · /workers · /new');
  el('coord-input').value='';saveDraft();el('coord-commands').classList.add('hidden');return;
 }
 if(!identity){pendingText=text;createDialog();return;}
 saveDraft();el('coord-send').disabled=true;
 const target=identity,request=drafts[target].request_id,submitted=el('coord-input').value;
 try{await terminalRequest('/api/coordinators/message',{id:target,text,request_id:request});if(drafts[target]?.request_id===request){drafts[target]={text:'',request_id:crypto.randomUUID()};if(identity===target&&el('coord-input').value===submitted)el('coord-input').value='';saveDraft();}await refreshWorkspace();latest();}
 finally{el('coord-send').disabled=false;}
}
el('coord-composer').onsubmit=event=>{event.preventDefault();send().catch(failure);};
el('coord-input').oninput=()=>{
 if(identity)drafts[identity]={text:el('coord-input').value,request_id:crypto.randomUUID()};saveDraft();
 const input=el('coord-input');input.style.height='auto';input.style.height=Math.min(190,input.scrollHeight)+'px';
 const menu=el('coord-commands');menu.replaceChildren();const prefix=input.value;
 menu.classList.toggle('hidden',!prefix.startsWith('/')||prefix.includes('\n'));
 for(const [command,description] of Object.entries(commands).filter(([command])=>command.startsWith(prefix))){const button=document.createElement('button');button.type='button';button.textContent=command+'  '+description;button.onclick=()=>{input.value=command;menu.classList.add('hidden');input.focus();};menu.append(button);}
};
el('coord-input').onkeydown=event=>{if(event.isComposing)return;if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();if(!el('coord-send').disabled)send().catch(failure);}if(event.key==='Escape'&&identity){event.preventDefault();terminalRequest('/api/coordinators/pause',{id:identity}).then(refreshWorkspace).catch(failure);}};
el('coord-pause').onclick=()=>terminalRequest('/api/coordinators/pause',{id:identity}).then(refreshWorkspace).catch(failure);
el('coord-latest').onclick=latest;
dialog.querySelector('.close-dialog').onclick=()=>dialog.close();
const timer=setInterval(()=>{if(root.isConnected&&!document.getElementById('agents-page').classList.contains('hidden'))refreshWorkspace();},1200);
if(initialId)open(initialId);
return {submit:async text=>{el('coord-input').value=text;saveDraft();await send();},focus:()=>el('coord-input').focus({preventScroll:true}),create:createDialog,dispose:()=>{saveDraft();clearInterval(timer);dialog.remove();retireDialog.remove();savedDialog.remove();hooksDialog.remove();contextPanel.destroy();}};
}
window.mountCoordinatorPane=(view,agent)=>{
 const root=template.cloneNode(true),dialog=dialogTemplate.cloneNode(true);
 root.classList.remove('hidden');root.classList.add('coord-embedded');
 const body=view.node.querySelector('.pane-body');body.classList.add('coord-pane-body');body.append(root);document.body.append(dialog);
 const ui=workspace(root,dialog,agent.id);workspaces.set(agent.id,ui);
 let pointerStart=null;
 view.node.addEventListener('pointerdown',event=>{pointerStart={x:event.clientX,y:event.clientY};});
 view.node.addEventListener('click',event=>{
  if(event.defaultPrevented||event.button!==0||event.detail>1||annotating)return;
  if(event.target.closest('button,a,input,textarea,select,summary,[contenteditable],[tabindex]'))return;
  if(pointerStart&&Math.hypot(event.clientX-pointerStart.x,event.clientY-pointerStart.y)>5)return;
  if(window.getSelection()?.isCollapsed===false)return;
  ui.focus();
 });
 view.coordinator=ui;view.cleanup=()=>{ui.dispose();workspaces.delete(agent.id);};
};
window.openCoordinatorWorkspace=async id=>{
 demo=false;
 if(!id){starter.create();return;}
 if(!agents.some(a=>a.id===id)){await refresh();if(!agents.some(a=>a.id===id)){await terminalRequest('/api/coordinators/reopen',{id});await refresh();}}
 selectPane(id);const ui=workspaces.get(id);ui?.focus();return ui;
};
const closeDialog=document.createElement('dialog');closeDialog.innerHTML='<h2>Close coordinator?</h2><p class="coord-close-summary"></p><p>Coordination pauses and the conversation is saved. Worker terminals keep running. Reopen it from Coordinator sessions.</p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button class="button coord-close-cancel">Cancel</button><button class="button primary coord-close-confirm">Close & save</button></div>';document.body.append(closeDialog);
let closingId=null;
window.closeCoordinator=id=>{closingId=id;closeDialog.querySelector('.coord-close-summary').textContent=sessionTitle(agents.find(a=>a.id===id)||{name:'Coordinator'});closeDialog.querySelector('[role="alert"]').textContent='';closeDialog.showModal();};
closeDialog.querySelector('.coord-close-cancel').onclick=()=>closeDialog.close();
closeDialog.querySelector('.coord-close-confirm').onclick=async event=>{event.target.disabled=true;try{await terminalRequest('/api/coordinators/close',{id:closingId});closePane(closingId);closeDialog.close();await refresh();}catch(error){closeDialog.querySelector('[role="alert"]').textContent=error.message;}finally{event.target.disabled=false;}};

// The launcher owns only a dialog; conversations live in ordinary session panes.
const starterRoot=template.cloneNode(true),starterDialog=dialogTemplate.cloneNode(true);
document.body.append(starterDialog);
const starter=workspace(starterRoot,starterDialog,null);
window.openRemoteCoordinator=node=>starter.create(false,node);
const historyDialog=document.createElement('dialog');historyDialog.className='coord-history-dialog';
historyDialog.innerHTML='<div class="coord-history-heading"><h2>Coordinator sessions</h2><button class="button coord-history-new">＋ New coordinator</button></div><p>Pick up a conversation with its task history and worker sessions.</p><div class="coord-history-list"></div><p class="error-banner" role="alert"></p><div class="dialog-actions"><button class="button coord-history-close">Close</button></div>';
document.body.append(historyDialog);
historyDialog.querySelector('.coord-history-close').onclick=()=>historyDialog.close();
historyDialog.querySelector('.coord-history-new').onclick=()=>{historyDialog.close();starter.create();};
document.getElementById('new-controller').onclick=async()=>{
 try{
  const data=await terminalRequest('/api/coordinators');
  if(!data.coordinators.length){starter.create();return;}
  const list=historyDialog.querySelector('.coord-history-list');list.replaceChildren();
  historyDialog.querySelector('[role="alert"]').textContent='';
  for(const coordinator of data.coordinators){
   const button=document.createElement('button');button.className='coord-history-session';
   const name=document.createElement('strong'),context=document.createElement('span'),status=document.createElement('small');
   name.textContent=coordinator.name;context.textContent=(coordinator.remote_node?'Remote · '+coordinator.remote_name+' · ':'')+shortPath(coordinator.cwd)+' · '+(providerLabels[coordinator.profile]||coordinator.profile);
   status.textContent=(coordinator.closed?'Closed · saved':coordinator.paused?'Paused':coordinator.state==='working'?'Working':'Open conversation')+(coordinator.worker_count!=null?' · '+coordinator.worker_count+' worker sessions':'')+(coordinator.last_activity?' · '+new Date(coordinator.last_activity*1000).toLocaleString():'');
   button.append(name,context,status);button.onclick=async()=>{try{await window.openCoordinatorWorkspace(coordinator.id);historyDialog.close();}catch(error){historyDialog.querySelector('[role="alert"]').textContent=error.message;}};
   list.append(button);
  }
  historyDialog.showModal();
 }catch(error){toast(error.message);}
};
const restore=new URLSearchParams(location.search);
if(restore.get('view')==='coordinator'&&restore.get('id'))window.openCoordinatorWorkspace(restore.get('id'));
})();
