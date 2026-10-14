(() => {
if(!window.AGENT_DESK_CONFIG.development)return;
let feedback = [], deletedFeedback = [], annotationKind = 'pin', syncingFeedback = false, feedbackReady = false;
try {
  const saved = JSON.parse(localStorage.getItem('agent-desk-feedback') || '[]');
  if (Array.isArray(saved)) feedback = saved;
  const deleted = JSON.parse(localStorage.getItem('agent-desk-feedback-deleted') || '[]');
  if (Array.isArray(deleted)) deletedFeedback = deleted;
} catch {}

function cacheFeedback() {
  localStorage.setItem('agent-desk-feedback', JSON.stringify(feedback));
  localStorage.setItem('agent-desk-feedback-deleted', JSON.stringify(deletedFeedback));
}
async function syncFeedback() {
  if (syncingFeedback) return;
  syncingFeedback = true;
  // Fetch tombstones before displaying or uploading browser-cached annotations.
  if (!feedbackReady) {
    try {
      const response = await fetch('/api/feedback', {cache:'no-store'});
      if (!response.ok) throw new Error('Feedback unavailable');
      const saved = await response.json();
      const deleted = new Set([...saved.deleted, ...deletedFeedback]);
      const merged = new Map([...feedback, ...saved.notes].map(note => [note.id, note]));
      feedback = [...merged.values()].filter(note => !deleted.has(note.id));
      deletedFeedback = [...deleted];
      feedbackReady = true;
      cacheFeedback(); renderFeedback();
    } catch {
      $('#feedback-sync').textContent = 'Checking saved annotations… workspace unavailable; cached pins stay hidden until synced';
      syncingFeedback = false;
      return;
    }
  }
  // Snapshot this request so edits made while it is in flight are preserved.
  const sentNotes = feedback.slice();
  const sentDeleted = deletedFeedback.slice();
  try {
    const response = await fetch('/api/feedback', {
      method: 'POST',
      headers: {'Content-Type': 'application/json', 'X-Agent-Desk': 'feedback'},
      body: JSON.stringify({notes: sentNotes, deleted: sentDeleted})
    });
    if (!response.ok) throw new Error('Workspace save failed');
    const saved = await response.json();
    const edits = feedback.filter(n => !sentNotes.includes(n));
    const deleted = new Set([...saved.deleted, ...deletedFeedback]);
    const merged = new Map(saved.notes.map(n => [n.id, n]));
    edits.forEach(n => merged.set(n.id, n));
    feedback = [...merged.values()].filter(n => !deleted.has(n.id));
    deletedFeedback = [...deleted];
    const pendingChanges = edits.length || deletedFeedback.some(id => !saved.deleted.includes(id));
    $('#feedback-sync').textContent = pendingChanges ? 'Saving your latest changes…' : 'Saved to workspace · available to your development agent';
    try { cacheFeedback(); } catch { $('#feedback-sync').textContent += ' · browser backup unavailable'; }
    renderFeedback();
  } catch {
    $('#feedback-sync').textContent = 'Workspace save unavailable · browser notes will retry automatically';
  } finally { syncingFeedback = false; }
}
// Popovers share the browser's top layer with dialogs. Keep the controls inside
// the active modal as well, so the modal's inert boundary does not block input.
const annotationLayer=$('#annotation-layer');
let annotationDialogs=[];
function syncAnnotationLayer(records=[]){
  annotationDialogs=annotationDialogs.filter(dialog=>dialog.isConnected&&dialog.open);
  for(const record of records){const dialog=record.target;if(dialog.tagName==='DIALOG'&&dialog.open&&!annotationDialogs.includes(dialog))annotationDialogs.push(dialog);}
  for(const dialog of document.querySelectorAll('dialog[open]'))if(!annotationDialogs.includes(dialog))annotationDialogs.push(dialog);
  const parent=annotationDialogs.at(-1)||document.body;
  if(annotationLayer.parentElement!==parent){
    if(annotationLayer.matches(':popover-open'))annotationLayer.hidePopover();
    parent.append(annotationLayer);
  }
  if(!annotationLayer.matches(':popover-open'))annotationLayer.showPopover();
  const editing=parent.id==='clear-feedback-dialog'||parent.id==='annotation-send-dialog';
  $('#annotation-launcher').disabled=editing;
  $('#annotation-toolbar').classList.toggle('hidden',!annotating||editing);
  if(editing&&typeof closeAnnotation==='function')closeAnnotation();
  renderPins();
}
const annotationObserver=new MutationObserver(records=>{
  if(records.some(r=>r.type==='attributes'||[...r.addedNodes,...r.removedNodes].some(n=>n.nodeType===1&&(n.tagName==='DIALOG'||n.querySelector?.('dialog')))))syncAnnotationLayer(records);
});
annotationObserver.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open']});
syncAnnotationLayer();
function setAnnotation(on) {
  annotating = on;
  document.body.classList.toggle('annotating', on);
  $('#annotation-toolbar').classList.toggle('hidden', !on);
  placeLauncher();

  $('#annotation-launcher').setAttribute('aria-pressed',String(on));
  $('#annotation-launcher').setAttribute('aria-expanded',String(on));
  $('#annotation-launcher').title=(on?'Finish annotating':'Annotate interface')+' · drag to move it, double-click to reset';
  $('#highlight').classList.add('hidden');
}
function setAnnotationKind(kind) {
  annotationKind = kind;
  $('#mode-pin').setAttribute('aria-pressed', kind === 'pin');
  $('#mode-element').setAttribute('aria-pressed', kind === 'element');
  $('#mode-region').setAttribute('aria-pressed', kind === 'region');
  document.body.classList.toggle('drawing-region', kind === 'region');
  $('#annotation-hint').textContent = kind === 'pin' ? 'Click anywhere to drop a pin'
    : kind === 'region' ? 'Drag a rectangle over the part you mean' : 'Click an element to leave feedback';
  $('#highlight').classList.add('hidden');
}
function selectorFor(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  const path = [];
  while (el && el !== document.body) {
    if (el.id) { path.unshift('#' + CSS.escape(el.id)); break; }
    if (el.dataset.agentId) { path.unshift(`[data-agent-id="${CSS.escape(el.dataset.agentId)}"]`); break; }
    const siblings = [...el.parentElement.children].filter(s => s.tagName === el.tagName);
    path.unshift(el.tagName.toLowerCase() + (siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(el) + 1})` : ''));
    el = el.parentElement;
  }
  return path.join(' > ') || 'body';
}
function annotationIgnored(el) {
  return el.closest('#clear-feedback-dialog,#annotation-send-dialog,#annotation-layer,#toast,#dev-menu');
}
const KIND_LABEL={pin:'Pin',element:'Element',region:'Area'};
function noteOpen(){return !$('#annotation-note-panel').classList.contains('hidden');}
window.annotationNoteOpen=noteOpen;
function placeNotePanel(note){
  const panel=$('#annotation-note-panel'),edge=10;
  panel.style.left=panel.style.top='0px';
  const size=panel.getBoundingClientRect();
  const box=note.kind==='region'&&note.regionBox?note.regionBox:{x:note.point.viewportX,y:note.point.viewportY,width:0,height:0};
  const below=box.y+box.height+12,above=box.y-size.height-12;
  const top=below+size.height<=innerHeight-edge?below:above>=edge?above:Math.max(edge,innerHeight-size.height-edge);
  panel.style.left=Math.min(Math.max(box.x,edge),Math.max(edge,innerWidth-size.width-edge))+'px';
  panel.style.top=top+'px';
}
function openAnnotation(note){
  pending=note;
  const panel=$('#annotation-note-panel');
  $('#annotation-target').textContent=`${KIND_LABEL[note.kind]||'Element'} · (${Math.round(note.point.viewportX)}, ${Math.round(note.point.viewportY)})`
    +(note.kind==='region'&&note.regionBox?` · ${Math.round(note.regionBox.width)} × ${Math.round(note.regionBox.height)}`:'')
    +` · ${note.viewport.width} × ${note.viewport.height}`;
  $('#annotation-note').value=note.note||'';
  $('#annotation-note-state').textContent='';
  $('#annotation-note-delete').hidden=!feedback.some(saved=>saved.id===note.id);
  panel.classList.remove('hidden');
  placeNotePanel(note);
  $('#annotation-note').focus();
}
function closeAnnotation(){
  pending=null;
  $('#annotation-note-panel').classList.add('hidden');
  $('#annotation-note').value='';
  $('#annotation-note-state').textContent='';
}
$('#annotation-note-close').onclick=closeAnnotation;
$('#annotation-note-delete').onclick=()=>{
  if(!pending)return;
  const previous=feedback,previousDeleted=deletedFeedback;
  deletedFeedback=[...deletedFeedback,pending.id];
  feedback=feedback.filter(saved=>saved.id!==pending.id);
  try{cacheFeedback();}catch{feedback=previous;deletedFeedback=previousDeleted;toast('Could not save this deletion.');return;}
  closeAnnotation();renderFeedback();syncFeedback();toast('Annotation deleted.');
};
// Drawing an area: press, drag a rectangle over any part of the UI, release.
let regionDraw=null;
function regionRect(){
  const draft=regionDraw;
  return {x:Math.min(draft.startX,draft.x),y:Math.min(draft.startY,draft.y),
          width:Math.abs(draft.x-draft.startX),height:Math.abs(draft.y-draft.startY)};
}
function paintRegionDraft(){
  const box=regionRect(),node=$('#annotation-region-draft');
  Object.assign(node.style,{left:box.x+'px',top:box.y+'px',width:box.width+'px',height:box.height+'px'});
  node.classList.remove('hidden');
}
document.addEventListener('pointerdown', e => {
  if (!annotating || annotationKind !== 'region' || annotationIgnored(e.target) || e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  regionDraw={startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY};
  paintRegionDraft();
}, true);
document.addEventListener('pointermove', e => {
  if (!regionDraw) return;
  regionDraw.x=e.clientX; regionDraw.y=e.clientY; paintRegionDraft();
}, true);
document.addEventListener('pointerup', e => {
  if (!regionDraw) return;
  const box=regionRect();
  regionDraw=null;
  $('#annotation-region-draft').classList.add('hidden');
  // A stray click is not an area; below this it would be impossible to see or click again.
  if (box.width < 12 || box.height < 12) return;
  const centre={x:box.x+box.width/2,y:box.y+box.height/2};
  const under=document.elementsFromPoint(centre.x,centre.y).find(node=>!annotationIgnored(node))||document.body;
  const rect=under.getBoundingClientRect();
  openAnnotation({
    id: crypto.randomUUID(), kind:'region', createdAt:new Date().toISOString(),
    url: location.href, page: $('#breadcrumb').textContent, mode: demo ? 'demo' : 'live',
    selector: selectorFor(under), elementText: under.textContent.trim().slice(0,400),
    viewport:{width:innerWidth,height:innerHeight,devicePixelRatio}, scroll:{x:scrollX,y:scrollY},
    point:{viewportX:centre.x,viewportY:centre.y,documentX:centre.x+scrollX,documentY:centre.y+scrollY,
           normalizedX:centre.x/innerWidth,normalizedY:centre.y/innerHeight},
    bounds:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    anchor:{x:rect.width?(centre.x-rect.x)/rect.width:0,y:rect.height?(centre.y-rect.y)/rect.height:0},
    // Kept against the anchor element so the area still covers the same part after a relayout.
    region:{x:rect.width?(box.x-rect.x)/rect.width:0,y:rect.height?(box.y-rect.y)/rect.height:0,
            width:rect.width?box.width/rect.width:0,height:rect.height?box.height/rect.height:0},
    regionBox:{...box},
    agentId: under.closest('[data-agent-id]')?.dataset.agentId || null
  });
}, true);
document.addEventListener('pointermove', e => {
  if (!annotating || annotationKind !== 'element' || annotationIgnored(e.target)) {
    $('#highlight').classList.add('hidden'); return;
  }
  const r = e.target.getBoundingClientRect();
  Object.assign($('#highlight').style, {left:r.x+'px', top:r.y+'px', width:r.width+'px', height:r.height+'px'});
  $('#highlight').classList.remove('hidden');
});
document.addEventListener('click', e => {
  if (!annotating || annotationKind === 'region' || annotationIgnored(e.target)) return;
  e.preventDefault(); e.stopPropagation();
  const el = e.target, r = el.getBoundingClientRect();
  const note = {
    id: crypto.randomUUID(), kind: annotationKind, createdAt: new Date().toISOString(),
    url: location.href, page: $('#breadcrumb').textContent, mode: demo ? 'demo' : 'live',
    selector: selectorFor(el), elementText: el.textContent.trim().slice(0,400),
    viewport: {width:innerWidth, height:innerHeight, devicePixelRatio}, scroll:{x:scrollX,y:scrollY},
    point: {viewportX:e.clientX, viewportY:e.clientY, documentX:e.clientX+scrollX, documentY:e.clientY+scrollY, normalizedX:e.clientX/innerWidth, normalizedY:e.clientY/innerHeight},
    bounds: {x:r.x,y:r.y,width:r.width,height:r.height},
    // Anchor even blank-space pins to their containing element as the layout changes.
    anchor: {x:r.width ? (e.clientX-r.x)/r.width : 0, y:r.height ? (e.clientY-r.y)/r.height : 0},
    agentId: el.closest('[data-agent-id]')?.dataset.agentId || null
  };
  $('#highlight').classList.add('hidden');
  openAnnotation(note);
}, true);
$('#annotation-note-save').onclick = () => saveAnnotation();
// Cmd/Ctrl+Enter saves from the keyboard, since Enter is a newline in the note.
$('#annotation-note').addEventListener('keydown', event => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); saveAnnotation(); }
});
function saveAnnotation() {
  const note = $('#annotation-note').value.trim();
  if (!note || !pending) return;
  const previous = feedback;
  const saved = {...pending, note, updatedAt:new Date().toISOString()};
  feedback = feedback.some(n => n.id === saved.id) ? feedback.map(n => n.id === saved.id ? saved : n) : [...feedback, saved];
  try { cacheFeedback(); }
  catch { feedback = previous; toast('Browser storage unavailable. Copy your note before closing.'); return; }
  renderFeedback(); syncFeedback();
  closeAnnotation();
  toast('Note saved.');
};
function renderPins() {
  const layer = $('#annotation-pins');
  layer.replaceChildren();
  if (!feedbackReady) return;
  feedback.forEach((note,index) => {
    if (note.page !== $('#breadcrumb').textContent || note.mode !== (demo ? 'demo' : 'live')) return;
    let target;
    try { target = document.querySelector(note.selector); } catch { return; }
    if (!target || !target.getClientRects().length || target.closest('#annotation-layer')) return;
    const modal=annotationDialogs.at(-1);
    if(modal&&!modal.contains(target))return;
    const r = target.getBoundingClientRect();
    let container=target.parentElement;
    while(container&&container!==document.body){
      if(/auto|scroll|hidden/.test(getComputedStyle(container).overflowY)){
        const clip=container.getBoundingClientRect();
        if(r.bottom<clip.top||r.top>clip.bottom||r.right<clip.left||r.left>clip.right)return;
      }
      container=container.parentElement;
    }
    const x = note.anchor?.x ?? (note.bounds.width ? (note.point.viewportX-note.bounds.x)/note.bounds.width : 0);
    const y = note.anchor?.y ?? (note.bounds.height ? (note.point.viewportY-note.bounds.y)/note.bounds.height : 0);
    if(note.kind==='region'&&note.region){
      // A saved area is drawn over the same part of its anchor element, with its number in the corner.
      // The rectangle itself never takes clicks, so a pin can still be dropped inside a marked area.
      const area=document.createElement('div');
      area.className='feedback-region';
      area.style.left=r.x+r.width*note.region.x+'px';
      area.style.top=r.y+r.height*note.region.y+'px';
      area.style.width=Math.max(12,r.width*note.region.width)+'px';
      area.style.height=Math.max(12,r.height*note.region.height)+'px';
      const badge=document.createElement('button');
      badge.className='feedback-region-index';
      badge.textContent=index+1;
      badge.title=note.note;
      badge.setAttribute('aria-label',`Annotation ${index+1}: ${note.note}`);
      badge.onclick=()=>openAnnotation(note);
      area.append(badge);
      layer.append(area);
      return;
    }
    const pin = document.createElement('button');
    pin.className = 'feedback-pin';
    pin.style.left = Math.max(14, Math.min(innerWidth-14, r.x+r.width*x)) + 'px';
    pin.style.top = r.y+r.height*y + 'px';
    pin.textContent = index+1;
    pin.title = note.note;
    pin.setAttribute('aria-label', `Annotation ${index+1}: ${note.note}`);
    pin.onclick = () => openAnnotation(note);
    layer.append(pin);
  });
}
function feedbackMarkdown(items) {
  return '# Agent Desk development feedback\n\n' + items.map((f,i) => `## ${i+1}. ${f.note}\n\n- Type: ${f.kind || 'element'}\n- Page: ${f.page} (${f.mode})\n- URL: ${f.url}\n- Selector: \`${f.selector}\`\n- Element text: ${f.elementText}\n- Click (viewport CSS pixels): ${Math.round(f.point.viewportX)}, ${Math.round(f.point.viewportY)}\n- Click (document CSS pixels): ${Math.round(f.point.documentX)}, ${Math.round(f.point.documentY)}\n- Element bounds: ${JSON.stringify(f.bounds)}\n- Viewport: ${f.viewport.width} × ${f.viewport.height}; DPR ${f.viewport.devicePixelRatio}\n- Scroll: ${f.scroll.x}, ${f.scroll.y}\n- Captured: ${f.createdAt}\n`).join('\n');
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], {type}));
  const a = document.createElement('a'); a.href=url; a.download=name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function renderFeedback() {
  if (!feedbackReady) {
    $('#feedback-count').textContent = '0';
    $('#annotation-send').disabled=true;
    $('#clear-feedback').disabled = $('#clear-pins').disabled = true;
    $('#feedback-list').textContent = 'Checking saved annotations…';
    renderPins(); return;
  }
  $('#feedback-count').textContent = feedback.length;
  $('#annotation-send').disabled=!feedback.length;
  $('#clear-feedback').disabled = !feedback.length;
  $('#clear-pins').disabled = !feedback.length;
  $('#feedback-list').innerHTML = feedback.length ? feedback.map((f,i) => `<article class="feedback-card"><h3>${f.kind === 'pin' ? 'PIN' : 'NOTE'} ${String(i+1).padStart(2,'0')} · ${escapeHTML(f.page)} · ${escapeHTML(f.mode)}</h3><p>${escapeHTML(f.note)}</p><div class="feedback-meta">${escapeHTML(f.selector)}<br>Click (${Math.round(f.point.viewportX)}, ${Math.round(f.point.viewportY)}) · Viewport ${escapeHTML(f.viewport.width)} × ${escapeHTML(f.viewport.height)}</div><div class="feedback-actions"><button class="button" data-edit="${i}">Edit note</button><button class="button" data-copy="${i}">Copy for agent</button><button class="button" data-json="${i}">Export JSON</button><button class="text-button" data-delete="${i}">Delete</button></div></article>`).join('') : '<div class="empty" style="margin-top:30px"><h2>Good feedback starts with a point.</h2><p>Choose Annotate to drop a pin anywhere or select an element. Your notes sync to the local workspace for your development agent.</p></div>';
  document.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openAnnotation(feedback[+b.dataset.edit]));
  document.querySelectorAll('[data-copy]').forEach(b => b.onclick = async () => {
    const content = feedbackMarkdown([feedback[+b.dataset.copy]]);
    try { await navigator.clipboard.writeText(content); toast('Copied feedback for your agent.'); }
    catch { download('feedback.md', content, 'text/markdown'); }
  });
  document.querySelectorAll('[data-json]').forEach(b => b.onclick = () => download('feedback.json', JSON.stringify(feedback[+b.dataset.json],null,2), 'application/json'));
  document.querySelectorAll('[data-delete]').forEach(b => b.onclick = () => {
    const previous = feedback, previousDeleted = deletedFeedback;
    const id = feedback[+b.dataset.delete].id;
    deletedFeedback = [...deletedFeedback,id]; feedback = feedback.filter(n => n.id !== id);
    try { cacheFeedback(); }
    catch { feedback=previous; deletedFeedback=previousDeleted; toast('Could not save this deletion.'); return; }
    renderFeedback(); syncFeedback();
  });
  renderPins();
}
$('#export-all').onclick = () => {
  if (!feedback.length) return toast('Add a feedback note first.');
  download('agent-desk-feedback.md', feedbackMarkdown(feedback), 'text/markdown');
};

let feedbackReceipts={};try{feedbackReceipts=JSON.parse(localStorage.getItem('agent-desk-feedback-sent')||'{}');}catch{}
const feedbackVersion=note=>JSON.stringify([note.updatedAt||note.createdAt,note.note]);
const sendDialog=document.createElement('dialog');sendDialog.id='annotation-send-dialog';sendDialog.setAttribute('aria-label','Send annotations to an agent');
sendDialog.innerHTML=`<form id="annotation-send-form"><h2>Send feedback</h2><p class="muted">Choose an agent by the name shown in Sessions.</p><div class="annotation-picker-heading"><label for="annotation-agent-search">Agent</label><button type="button" id="annotation-agent-refresh" class="text-button">Refresh</button></div><input id="annotation-agent-search" type="search" placeholder="Search open agents…" autocomplete="off"><div id="annotation-recipient-list" role="radiogroup" aria-label="Open agents"></div><input id="annotation-recipient" type="hidden"><p id="annotation-recipient-detail" class="annotation-send-help"></p><h3 class="annotation-notes-heading">Notes to send</h3><div id="annotation-send-notes"></div><section id="annotation-deliveries" aria-label="Delivery status"></section><p id="annotation-send-status" role="status"></p><div class="dialog-actions"><button type="button" class="button annotation-send-cancel">Cancel</button><button type="submit" class="button primary">Send feedback</button></div></form>`;
document.body.append(sendDialog);
let submissionNotes=[],submissionKey=null,submissionSignature=null,submitting=false,recipients=[],recipientAgent=null,recipientLoad=0,recipientsLoading=false;
try{const pending=JSON.parse(localStorage.getItem('agent-desk-feedback-pending')||'null');if(pending){submissionKey=pending.key;submissionSignature=pending.signature;}}catch{}
function openFeedbackList(){setAnnotation(false);switchPage('feedback');}
$('#annotation-review').onclick=openFeedbackList;
sendDialog.querySelector('.annotation-send-cancel').onclick=()=>{if(!submitting)sendDialog.close();};
sendDialog.addEventListener('cancel',event=>{if(submitting)event.preventDefault();});
function recipientCandidates(live){
 const active=live.filter(a=>a.exit_code==null&&!(['completed','ready_for_review'].includes(a.status)&&!a.terminal_id)).map(withTerminalActivity);
 const byId=new Map(active.map(a=>[a.id,a]));
 const direct=a=>!a.remote_node&&!a.harness_internal&&(a.coordinator_workspace||(a.terminal_id&&(['claude','codex','grok','opencode','pi'].includes(a.harness)||/^(claude|codex)(-[a-z0-9-]+)?$/.test(a.launch_profile||''))));
 return active.map(agent=>{
  let target=agent;const seen=new Set();
  while(target?.parent_id&&!seen.has(target.id)){seen.add(target.id);target=byId.get(target.parent_id);}
  const allowed=target&&!seen.has(target.id)&&direct(target);
  const name=sessionTitle(agent),targetName=target?sessionTitle(target):'';
  const detail=[agent.project||shortPath(agent.cwd||''),agent.launch_label||(/codex/.test(agent.launch_profile||agent.harness)?'Codex':/claude/.test(agent.launch_profile||agent.harness)?'Claude':agent.harness),openPaneIds.includes(agent.id)?'Open pane':''].filter(Boolean).join(' · ');
  return {id:agent.id,name,targetName,detail,target:allowed?target.id:null,help:allowed?(target.id!==agent.id?'Delivered to '+targetName+', this agent’s coordinator.':target.coordinator_workspace?'Feedback queues for '+name+'.':'Send to '+name+' when its prompt is ready.'):(agent.remote_node?'Open this remote workspace to send feedback.':agent.parent_id?'Its coordinator is not available for feedback.':'View-only session · open a managed coding-agent terminal to send feedback.')};
 }).sort((a,b)=>Number(openPaneIds.includes(b.id))-Number(openPaneIds.includes(a.id))||a.name.localeCompare(b.name));
}
function updateRecipient(){
 const chosen=recipients.find(a=>a.id===recipientAgent);
 $('#annotation-recipient').value=chosen?.target||'';
 $('#annotation-recipient-detail').textContent=chosen?.help||'Choose an agent to handle these notes.';
 sendDialog.querySelector('[type=submit]').disabled=submitting||recipientsLoading||!chosen?.target||!$('#annotation-send-notes input:checked');
}
function renderRecipients(){
 const list=$('#annotation-recipient-list'),query=$('#annotation-agent-search').value.trim().toLowerCase();list.replaceChildren();
 const matches=recipients.filter(a=>(a.name+' '+a.detail).toLowerCase().includes(query));
 for(const agent of matches){
  const row=document.createElement('label'),radio=document.createElement('input'),text=document.createElement('span'),title=document.createElement('strong'),meta=document.createElement('small');
  row.className='annotation-agent';row.dataset.agentId=agent.id;
  radio.type='radio';radio.name='feedback-agent';radio.value=agent.id;radio.checked=agent.id===recipientAgent;radio.disabled=submitting||!agent.target;
  title.textContent=agent.name;meta.textContent=agent.detail;text.append(title,meta);
  if(!agent.target){row.classList.add('unavailable');const why=document.createElement('small');why.textContent=agent.help;text.append(why);}
  row.append(radio,text);list.append(row);
  radio.onchange=()=>{recipientAgent=agent.id;updateRecipient();};
 }
 if(!matches.length){const empty=document.createElement('p');empty.className='annotation-picker-empty';empty.textContent=query?'No open agents match this search.':'No agents are open. Open a coding agent or coordinator in Agent Desk.';list.append(empty);}
 updateRecipient();
}
async function loadRecipients(){
 const turn=++recipientLoad;recipientsLoading=true;updateRecipient();$('#annotation-agent-refresh').disabled=true;
 $('#annotation-send-status').textContent='Loading open agents…';
 try{
  const live=await terminalRequest('/api/agents');if(turn!==recipientLoad||!sendDialog.open)return;
  recipients=recipientCandidates(live.agents||[]);
  if(!recipients.some(a=>a.id===recipientAgent&&a.target))recipientAgent=recipients.find(a=>a.id===selectedId&&a.target)?.id||recipients.find(a=>a.target)?.id||null;
  renderRecipients();$('#annotation-send-status').textContent='Your notes stay saved after sending.';
 }catch{if(turn===recipientLoad){recipients=[];recipientAgent=null;renderRecipients();$('#annotation-send-status').textContent='Could not load agents. Use Refresh to try again.';}}
 finally{if(turn===recipientLoad){recipientsLoading=false;$('#annotation-agent-refresh').disabled=false;updateRecipient();}}
}
$('#annotation-agent-search').oninput=renderRecipients;
$('#annotation-agent-refresh').onclick=()=>{loadRecipients();refreshFeedbackDeliveries();};
$('#annotation-send-notes').onchange=updateRecipient;
$('#annotation-send').onclick=async()=>{
 await refreshFeedbackDeliveries();
 submissionNotes=structuredClone(feedback);
 const list=$('#annotation-send-notes');list.replaceChildren();
 for(const note of submissionNotes){
  const row=document.createElement('label'),check=document.createElement('input'),text=document.createElement('span'),meta=document.createElement('small');
  const receipt=feedbackReceipts[note.id];
  const sent=receipt?.version===feedbackVersion(note)&&!['failed','cancelled'].includes(receipt.state);
  const state=receipt?.state||(receipt?.queued?'queued':'sent');
  check.type='checkbox';check.value=note.id;check.checked=!sent;
  text.textContent=note.note;meta.textContent=(note.page||'Interface')+' · '+(sent?(state==='queued'?'Waiting for agent':state==='uncertain'?'Delivery uncertain — inspect terminal':'Delivered previously'):'Not sent');text.append(meta);row.append(check,text);list.append(row);
 }
 recipients=[];recipientAgent=null;$('#annotation-agent-search').value='';renderRecipients();sendDialog.showModal();
 await loadRecipients();if(sendDialog.open)$('#annotation-agent-search').focus();
};
sendDialog.querySelector('form').onsubmit=async event=>{
 event.preventDefault();if(submitting)return;
 const selected=new Set([...$('#annotation-send-notes').querySelectorAll('input:checked')].map(n=>n.value));
 const notes=submissionNotes.filter(n=>selected.has(n.id));const target=$('#annotation-recipient').value;
 if(!notes.length||!target){$('#annotation-send-status').textContent='Choose at least one annotation and an agent.';return;}
 const signature=JSON.stringify([target,notes]);if(signature!==submissionSignature){submissionKey=crypto.randomUUID();submissionSignature=signature;}
 try{localStorage.setItem('agent-desk-feedback-pending',JSON.stringify({key:submissionKey,signature:submissionSignature}));}catch{$('#annotation-send-status').textContent='Browser storage is unavailable. Nothing was sent.';return;}
 submitting=true;const controls=[...sendDialog.querySelectorAll('input,select,button')];controls.forEach(n=>n.disabled=true);$('#annotation-send-status').textContent='Sending feedback…';
 try{
  const result=await terminalRequest('/api/coordinators/submit-feedback',{request_id:submissionKey,target_id:target,notes});
  for(const note of notes)feedbackReceipts[note.id]={version:feedbackVersion(note),target,request:submissionKey,sentAt:Date.now(),state:result.queued?'queued':'sent',queued:!!result.queued};
  try{localStorage.setItem('agent-desk-feedback-sent',JSON.stringify(feedbackReceipts));}catch{}
  try{localStorage.removeItem('agent-desk-feedback-pending');}catch{}
  submissionKey=null;submissionSignature=null;
  const label=recipients.find(a=>a.id===recipientAgent)?.targetName||'agent';
  sendDialog.close();setAnnotation(false);
  toast((result.queued?'Queued ':'Sent ')+notes.length+' annotation'+(notes.length===1?'':'s')+(result.queued?' for '+label+'; delivery waits for an empty prompt.':' to '+label+'.'));
 }catch(error){$('#annotation-send-status').textContent=error.message==='Not found'?'Feedback endpoint unavailable. Your notes remain saved; check the backend connection.':error.message;}
 finally{submitting=false;controls.forEach(n=>n.disabled=false);renderRecipients();}
};
// The annotate button is draggable, so it can be moved off whatever is being annotated.
// Its place is kept as a fraction of the viewport and clamped back into view on every resize.
const LAUNCHER_PLACE='agent-desk-annotation-launcher';
let launcherPlace=(()=>{try{const saved=JSON.parse(localStorage.getItem(LAUNCHER_PLACE)||'null');
  return saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y)?saved:null;}catch{return null;}})();
let launcherDragged=false;
function placeLauncher(){
  const launcher=$('#annotation-launcher'),toolbar=$('#annotation-toolbar');
  if(!launcherPlace){
    for(const node of [launcher,toolbar])node.style.removeProperty('left'),node.style.removeProperty('top'),node.style.removeProperty('bottom');
    return;
  }
  const size=launcher.getBoundingClientRect(),edge=8;
  const x=Math.min(Math.max(launcherPlace.x*innerWidth,edge),Math.max(edge,innerWidth-size.width-edge));
  const y=Math.min(Math.max(launcherPlace.y*innerHeight,edge),Math.max(edge,innerHeight-size.height-edge));
  launcher.style.left=x+'px';launcher.style.top=y+'px';launcher.style.bottom='auto';
  if(toolbar.classList.contains('hidden'))return;
  // The toolbar sits above the button when there is room for it, otherwise below, and never off-screen.
  const panel=toolbar.getBoundingClientRect();
  const above=y-panel.height-10,below=y+size.height+10;
  toolbar.style.left=Math.min(Math.max(x,edge),Math.max(edge,innerWidth-panel.width-edge))+'px';
  toolbar.style.top=(above>=edge?above:Math.min(below,Math.max(edge,innerHeight-panel.height-edge)))+'px';
  toolbar.style.bottom='auto';
}
$('#annotation-launcher').addEventListener('pointerdown',event=>{
  const launcher=$('#annotation-launcher');
  if(event.button!==0||launcher.disabled)return;
  const start=launcher.getBoundingClientRect(),grabX=event.clientX-start.left,grabY=event.clientY-start.top;
  let moving=false;
  const move=step=>{
    if(!moving&&Math.hypot(step.clientX-event.clientX,step.clientY-event.clientY)<4)return;
    moving=true;launcher.classList.add('dragging');
    launcherPlace={x:(step.clientX-grabX)/innerWidth,y:(step.clientY-grabY)/innerHeight};
    placeLauncher();
  };
  const finish=()=>{
    launcher.removeEventListener('pointermove',move);
    launcher.removeEventListener('pointerup',finish);
    launcher.removeEventListener('pointercancel',finish);
    launcher.classList.remove('dragging');
    if(!moving)return;
    launcherDragged=true;setTimeout(()=>{launcherDragged=false;},0);
    try{localStorage.setItem(LAUNCHER_PLACE,JSON.stringify(launcherPlace));}catch{}
  };
  launcher.setPointerCapture(event.pointerId);
  launcher.addEventListener('pointermove',move);
  launcher.addEventListener('pointerup',finish);
  launcher.addEventListener('pointercancel',finish);
});
// Double-click returns it to its usual corner.
$('#annotation-launcher').addEventListener('dblclick',()=>{
  launcherPlace=null;try{localStorage.removeItem(LAUNCHER_PLACE);}catch{}
  placeLauncher();toast('Annotate button back in its corner.');
});
addEventListener('resize',placeLauncher);
placeLauncher();
$('#annotation-launcher').onclick=()=>{if(!launcherDragged)setAnnotation(!annotating);};
$('#stop-annotation').onclick = () => setAnnotation(false);
$('#mode-pin').onclick = () => setAnnotationKind('pin');
$('#mode-element').onclick = () => setAnnotationKind('element');
$('#mode-region').onclick = () => setAnnotationKind('region');
document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&noteOpen()){e.preventDefault();e.stopImmediatePropagation();closeAnnotation();return;}
  if(e.key==='Escape'&&annotating&&!noteOpen()&&!$('#clear-feedback-dialog').open&&!$('#annotation-send-dialog').open){e.preventDefault();e.stopImmediatePropagation();setAnnotation(false);}
},true);
window.addEventListener('resize', renderPins);
window.addEventListener('scroll', renderPins, {passive:true,capture:true});
renderFeedback(); syncFeedback(); setInterval(syncFeedback, 5000);

let clearSnapshot = [];
function requestClearFeedback() {
  if (!feedback.length) return toast('No annotations to clear.');
  clearSnapshot = feedback.map(note => note.id);
  $('#clear-description').textContent = `Remove ${clearSnapshot.length} saved annotation${clearSnapshot.length === 1 ? '' : 's'} and their pins from this app and the local feedback file? Export them first if you want to keep a copy.`;
  $('#clear-feedback-dialog').showModal();
}
$('#clear-feedback').onclick = $('#clear-pins').onclick = requestClearFeedback;
$('#confirm-clear-feedback').onclick = () => {
  const previous = feedback, previousDeleted = deletedFeedback;
  const ids = new Set(clearSnapshot);
  feedback = feedback.filter(note => !ids.has(note.id));
  deletedFeedback = [...new Set([...deletedFeedback, ...ids])];
  try { cacheFeedback(); }
  catch { feedback = previous; deletedFeedback = previousDeleted; toast('Could not clear annotations. Nothing was removed.'); return; }
  $('#clear-feedback-dialog').close();
  renderFeedback(); syncFeedback();
  toast('Annotations cleared.');
};

window.renderPins=renderPins;window.renderFeedback=renderFeedback;

async function refreshFeedbackDeliveries(){
 try{
  const {submissions=[]}=await terminalRequest('/api/coordinators/feedback-status',{});
  const list=$('#annotation-deliveries');list.replaceChildren();
  for(const row of submissions){
   for(const [id,receipt] of Object.entries(feedbackReceipts)){
    const legacyMatch=!receipt.request&&receipt.target===row.target&&(row.note_versions||[]).some(n=>n.id===id&&JSON.stringify(n.version)===receipt.version);
    if(receipt.request===row.request||legacyMatch){receipt.request=row.request;receipt.state=row.state;}
   }
   if(!['queued','failed','uncertain'].includes(row.state))continue;
   const item=document.createElement('p');item.className='annotation-delivery';
   item.textContent=(row.state==='queued'?'Waiting for agent':row.state==='failed'?'Delivery failed':'Delivery uncertain')+' · '+(recipients.find(r=>r.target===row.target)?.targetName||row.target)+': '+(row.detail||'Inspect the recipient terminal.');
   if(row.state==='queued'){
    const cancel=document.createElement('button');cancel.type='button';cancel.className='text-button';cancel.textContent='Cancel delivery';
    cancel.onclick=async()=>{try{await terminalRequest('/api/coordinators/cancel-feedback',{request_id:row.request});await refreshFeedbackDeliveries();}catch(e){$('#annotation-send-status').textContent=e.message;}};
    item.append(' ',cancel);
   }
   list.append(item);
  }
  for(const note of submissionNotes){
   const check=[...$('#annotation-send-notes').querySelectorAll('input')].find(n=>n.value===note.id);
   const receipt=feedbackReceipts[note.id];if(!check||receipt?.version!==feedbackVersion(note))continue;
   const label={queued:'Waiting for agent',sent:'Delivered previously',failed:'Delivery failed — select to resend',cancelled:'Cancelled — select to resend',uncertain:'Delivery uncertain — inspect terminal'}[receipt.state];
   if(label)check.parentElement.querySelector('small').textContent=(note.page||'Interface')+' · '+label;
  }
  localStorage.setItem('agent-desk-feedback-sent',JSON.stringify(feedbackReceipts));
 }catch(error){$('#annotation-deliveries').textContent='Delivery status unavailable: '+error.message;}
}
setInterval(()=>{if(sendDialog.open)refreshFeedbackDeliveries();},3000);

})();
