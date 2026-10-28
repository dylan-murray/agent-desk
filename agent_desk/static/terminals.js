// Pane selection and real PTY views. Terminal DOM survives agent refreshes.
let openPaneIds=[], paneMode=null, paneInitialized=false, terminalAuth=null, terminalDefaultCwd='', stopTerminalId=null, removeAfterStop=false;
let draggingPaneId=null, paneDragEndedAt=0;
const paneViews=new Map();
let launchSettings={},sessionLaunchProfiles={};
try{launchSettings=JSON.parse(localStorage.getItem('agent-desk-launch-settings')||'{}');sessionLaunchProfiles=JSON.parse(localStorage.getItem('agent-desk-session-profiles')||'{}');}catch{}
function loadLaunchChoice(){
  const key=$('#terminal-harness').value,choice=launchChoices[key];
  const settings=key.startsWith('preset-')?choice:choice.account?choice:launchSettings[key]||choice;
  $('#terminal-executable').value=settings.command||'';
  $('#terminal-command-mode').value=settings.mode||'direct';
  $('#terminal-args').value=(choice.args||[]).join('\n');
  $('#terminal-readouts-field').hidden=!['claude','codex'].includes(choice.harness);
  updateTerminalPresetControls();
  updateResumeOptions();
}
function rememberLaunchChoice(key,settings,id,controllerGoal=null){
  launchSettings[key]=settings;
  sessionLaunchProfiles[id]={harness:launchChoices[key].harness,launch_label:(controllerGoal?'Controller · ':'')+launchChoices[key].label,controller:!!controllerGoal,controller_goal:controllerGoal};
  const entries=Object.entries(sessionLaunchProfiles).slice(-256);sessionLaunchProfiles=Object.fromEntries(entries);
  try{localStorage.setItem('agent-desk-launch-settings',JSON.stringify(launchSettings));localStorage.setItem('agent-desk-session-profiles',JSON.stringify(sessionLaunchProfiles));}catch{}
}
const freshTerminalIds=new Set();
async function terminalAuthToken(){
  if(!terminalAuth){const response=await fetch('/api/terminal-auth');if(!response.ok)throw Error('Could not connect to terminals');const auth=await response.json();terminalAuth=auth.token;terminalDefaultCwd=auth.cwd;}
  return terminalAuth;
}
async function terminalRequest(path,body){
  await terminalAuthToken();
  const response=await fetch(path,{method:body?'POST':'GET',headers:{'X-Agent-Desk-Terminal':terminalAuth,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json();
  if(!response.ok){if(response.status===403)terminalAuth=null;throw Error(data.error||'Terminal request failed');}
  return data;
}
// Output activity and recognizable approval menus are separate signals.
const terminalActivity=new Map();
// A quiet gap longer than this ends a run of work (matches the server's ACTIVE_GAP).
const ACTIVE_GAP_MS=6000;
// A pane attaching or resizing makes the terminal repaint; that repaint is not work.
function quietRedraw(id){const activity=terminalActivity.get(id);if(activity)activity.redrawUntil=Date.now()+2500;}
function markOutput(activity){const now=Date.now();if(now<(activity.redrawUntil||0))return;if(!activity.lastOutput||now-activity.lastOutput>ACTIVE_GAP_MS)activity.activeSince=now;activity.lastOutput=now;}
function noteTerminalOutput(id){const activity=terminalActivity.get(id);if(activity)markOutput(activity);}
function markTerminalConnection(id,connected){const activity=terminalActivity.get(id);if(activity)activity.connected=connected;}
function noteTerminalExit(id,code){const agent=agents.find(a=>a.id===id);if(agent){agent.exit_code=code;agent.status=code===0?'completed':'error';}}
let dismissedTerminals=new Set();
try{dismissedTerminals=new Set(JSON.parse(localStorage.getItem('agent-desk-closed-terminals')||'[]'));}catch{}
function withTerminalActivity(agent){
  agent={...agent,...(sessionLaunchProfiles[agent.id]||{})};
  agent.controller=!!agent.controller||!!agent.name?.startsWith('Controller · ');
  if(agent.remote_connected===false||!agent.terminal_id||agent.exit_code!==null||agent.runtime_status)return agent;
  const activity=terminalActivity.get(agent.id);
  if(!activity)return {...agent,activity_description:'Interactive terminal · checking output activity'};
  const status=activity.connected?(activity.approval?'needs_input':Date.now()-activity.lastOutput<4000?'output':'quiet'):'unknown';
  return {...agent,status,question:activity.approval||agent.question,terminal_title:activity.title||'',activity_description:status==='needs_input'?'Approval requested · '+activity.approval:status==='output'?'Receiving terminal output; task progress is not confirmed':status==='quiet'?'No recent terminal output; the agent may be thinking or waiting':'Activity connection unavailable'};
}
function dismissTerminal(id){
  dismissedTerminals.add(id);
  try{localStorage.setItem('agent-desk-closed-terminals',JSON.stringify([...dismissedTerminals].slice(-256)));}catch{}
  closePane(id);
  try{sessionStorage.removeItem(terminalSnapshotPrefix+id);}catch{}
}
function requestCloseTerminal(id){
  const agent=agents.find(a=>a.id===id);if(!agent?.terminal_id)return;
  if(agent.exit_code!==null){dismissTerminal(id);return;}
  stopTerminalId=id;removeAfterStop=true;
  $('#stop-terminal-dialog h2').textContent='Close this terminal?';
  $('#confirm-stop-terminal').textContent='Stop and close';
  $('#stop-terminal-dialog').showModal();
}
let monitoringTerminals=false;
async function monitorTerminals(){
  if(monitoringTerminals)return;monitoringTerminals=true;
  try{
    await Promise.all(agents.filter(a=>a.terminal_id&&a.exit_code===null&&!dismissedTerminals.has(a.id)).map(async agent=>{
      const activity=terminalActivity.get(agent.id)||{cursor:null,lastOutput:0,title:readTerminalSnapshot(agent.id)?.title||''};
      terminalActivity.set(agent.id,activity);
      // Streamed terminals report output as it arrives; only polled ones are asked here.
      if(terminalStream.usable(agent.id))return followTerminalAttention(agent,activity);
      try{
        // Asking for the end cursor returns no replay bytes and works for closed panes too.
        const output=await terminalRequest(`/api/terminals/output?id=${encodeURIComponent(agent.id)}&cursor=${Number.MAX_SAFE_INTEGER}`);
        if(activity.cursor!==null&&output.cursor>activity.cursor)markOutput(activity);
        activity.cursor=output.cursor;activity.connected=true;
        await readTerminalAttention(agent,activity);
        if(output.exit_code!==null){agent.exit_code=output.exit_code;agent.status=output.exit_code===0?'completed':'error';}
      }catch{activity.connected=false;}
    }));
    for(const id of attentionReaders.keys()){if(!agents.some(a=>a.id===id&&a.exit_code===null&&!dismissedTerminals.has(id)))disposeAttentionReader(id);}
    renderAttention(everyAgent());
    if(!demo&&!annotating&&!window.annotationNoteOpen?.())render();
  }finally{monitoringTerminals=false;}
}
setInterval(monitorTerminals,2000);
// Open panes belong to this tab and to the desk it shows; each desk keeps its own.
const paneStoreKey=()=>demo?'demo':deskScoped('live');
function savePanes(){try{(window.agentDeskDesktop?localStorage:sessionStorage).setItem('agent-desk-panes-'+paneStoreKey(),JSON.stringify(openPaneIds));}catch{}}
function loadPanes(){
  paneMode=paneStoreKey();
  try{const saved=(window.agentDeskDesktop?localStorage:sessionStorage).getItem('agent-desk-panes-'+paneMode);paneInitialized=saved!==null;openPaneIds=JSON.parse(saved||'[]').filter(x=>typeof x==='string').slice(0,PANE_LIMIT);}catch{openPaneIds=[];paneInitialized=false;}
  loadPaneRects();loadPaneLayout();loadSeenSpawned();
}
// Agents spawn sessions onto the desk they run on (scripts/agent_control.py launch --parent).
// Each live one opens as a pane the first time this tab sees it on this desk, as one started
// from New does; it is remembered, so closing its pane keeps it closed. A coordinator's workers
// are not: the coordinator pane already shows them.
let seenSpawned=new Set();
const seenSpawnedKey=()=>'agent-desk-seen-spawned-'+paneStoreKey();
function loadSeenSpawned(){try{seenSpawned=new Set(JSON.parse(sessionStorage.getItem(seenSpawnedKey())||'[]'));}catch{seenSpawned=new Set();}}
function openSpawnedPanes(all){
  const coordinators=new Set(agents.filter(a=>a.coordinator_workspace).map(a=>a.id));
  const arrived=all.filter(a=>a.parent_id&&!coordinators.has(a.parent_id)&&a.terminal_id&&a.exit_code===null&&!a.harness_internal&&!seenSpawned.has(a.id));
  if(!arrived.length)return;
  for(const a of arrived){seenSpawned.add(a.id);if(!openPaneIds.includes(a.id)&&openPaneIds.length<PANE_LIMIT)openPaneIds.push(a.id);}
  const known=new Set(agents.map(a=>a.id));seenSpawned=new Set([...seenSpawned].filter(id=>known.has(id)));
  try{sessionStorage.setItem(seenSpawnedKey(),JSON.stringify([...seenSpawned]));}catch{}
  savePanes();
}
function selectPane(id,add=false){
  // Opening an agent that is on another desk goes to that desk, like following a link.
  const target=!demo&&everyAgent().find(a=>a.id===id);
  if(target&&!onActiveDesk(target))switchDesk(deskOf(target),{render:false});
  focusCoordinatorFor(id);
  if(add){if(openPaneIds.includes(id)){selectedId=id;}else if(openPaneIds.length>=PANE_LIMIT){toast(PANE_LIMIT+' panes are open. Close a pane to add another.');return;}else{openPaneIds.push(id);selectedId=id;}}
  else if(openPaneIds.includes(id))selectedId=id;
  // A web page has no session row to come back from, so a session never replaces its pane.
  else if(webPages.has(selectedId)){if(openPaneIds.length>=PANE_LIMIT){toast(PANE_LIMIT+' panes are open. Close a pane to add another.');return;}openPaneIds.push(id);selectedId=id;}
  else{const index=openPaneIds.indexOf(selectedId);if(index>=0){handOverPaneRect(selectedId,id);openPaneIds[index]=id;}else openPaneIds=[id];selectedId=id;}
  savePanes();switchPage('agents');render();paneViews.get(id)?.term?.focus();paneViews.get(id)?.coordinator?.focus();
  // Focusing the terminal only scrolls its hidden input into view; show the whole pane.
  paneViews.get(id)?.node.scrollIntoView({block:'nearest'});
}
function closePane(id){paneInitialized=true;openPaneIds=openPaneIds.filter(value=>value!==id);if(selectedId===id)selectedId=openPaneIds[0]||null;savePanes();render();}
// Pane order is openPaneIds; renderTerminal only appends newly created views, so a move
// has to relocate the existing node. Moving it instead of rebuilding keeps xterm's buffer
// and the PTY socket alive. Only out-of-place nodes are touched so a no-op render cannot
// detach a focused terminal.
function syncPaneOrder(){
  const workspace=$('#terminal');
  openPaneIds.forEach((id,index)=>{const view=paneViews.get(id);if(view&&workspace.children[index]!==view.node)workspace.insertBefore(view.node,workspace.children[index]||null);});
}
// Reordering is a swap: the pane you drop on takes the slot of the pane in your hand.
// The drag preview shows exactly that, so the preview and the commit cannot disagree.
// With resized panes the slot is the pane's cell, so the two exchange cells too.
function swapPanes(id,targetId){
  const from=openPaneIds.indexOf(id),to=openPaneIds.indexOf(targetId);
  if(from<0||to<0||from===to)return false;
  [openPaneIds[from],openPaneIds[to]]=[openPaneIds[to],openPaneIds[from]];
  if(paneRects?.[id]&&paneRects[targetId]){[paneRects[id],paneRects[targetId]]=[paneRects[targetId],paneRects[id]];savePaneRects();}
  applyPaneLayout();sortPanesByLayout();savePanes();syncPaneOrder();highlightPanes();
  return true;
}
function movePaneBy(id,delta){
  const target=openPaneIds[openPaneIds.indexOf(id)+delta];
  if(!target||!swapPanes(id,target))return false;
  toast('Pane moved to '+(openPaneIds.indexOf(id)+1)+' of '+openPaneIds.length);
  return true;
}
function clearPaneDrag(){
  draggingPaneId=null;
  document.body.classList.remove('pane-dragging-active');snapPreview(null);
  for(const node of document.querySelectorAll('.pane-swap-target')){node.style.transform='';node.style.clipPath='';}
  document.querySelectorAll('.pane-dragging,.pane-swap-target').forEach(el=>el.classList.remove('pane-dragging','pane-swap-target'));
}
// Pointer events rather than HTML5 drag-and-drop: a plain press-and-move on the header
// moves the pane immediately, with no OS drag image, no dataTransfer, and the same
// behaviour in every browser. Touch is left alone so the stacked layout still scrolls.
let paneDrag=null;
// Slot geometry is read once, before anything is transformed, and the pointer is hit
// tested against it. elementFromPoint cannot be used here: the preview moves the hovered
// pane out from under the cursor, which would make the target oscillate.
function paneSlots(){
  return openPaneIds.map(id=>{const view=paneViews.get(id);return view&&{id,node:view.node,rect:view.node.getBoundingClientRect()};}).filter(Boolean);
}
// Slots were measured before any scrolling during the drag, so the pointer is moved into
// that frame.
function slotAt(state,clientX,clientY){
  clientY+=$('#terminal').scrollTop-state.scroll;
  return state.slots.find(slot=>clientX>=slot.rect.left&&clientX<=slot.rect.right&&clientY>=slot.rect.top&&clientY<=slot.rect.bottom);
}
// Only two drops are offered beyond the swap: a pane as wide as the workspace splits in two,
// taking the held pane on its left or right; and of two panes sharing a row, one dropped on
// the other's bottom edge becomes a full-width row of its own below it. The pointer has to be in
// a band along that edge (a sixth of the width, at most 180px; a fifth of the height, at most
// 120px), or, for a held pane about as wide, the held pane itself past the middle: a wide pane
// held by its title hangs far to the right of the pointer.
function paneSnapAt(state,slot,clientX,clientY){
  const cells=state.cells,cell=cells?.[slot.id],own=cells?.[state.id];if(!cell||!own)return null;
  const home=state.slots.find(item=>item.id===state.id),dx=clientX-state.startX,r=slot.rect,middle=r.left+r.width/2,y=clientY+$('#terminal').scrollTop-state.scroll;
  const bandX=Math.min(180,r.width/6),bandY=Math.min(120,r.height/5),wide=home.rect.width>=r.width*.75;
  let side=null;
  if(cell.w===PANE_GRID)side=clientX>=r.right-bandX?'right':clientX<=r.left+bandX?'left':wide&&home.rect.left+dx>=middle?'right':wide&&home.rect.right+dx<=middle?'left':null;
  else if(own.y===cell.y&&own.h===cell.h&&y>=r.bottom-bandY)side='bottom';
  const rects=side&&paneRectsBeside(cells,state.id,slot.id,side);
  return rects?{side,rects}:null;
}
// A side drop shows only once the pointer has stayed in its band for a moment, so passing over an
// edge on the way somewhere else keeps the ordinary swap preview.
const PANE_SNAP_DWELL=160;
function heldSnap(state,snap,id){
  const key=snap?id+' '+snap.side:'';
  if(!key){clearTimeout(state.dwell);state.pendingKey=state.snapKey='';return null;}
  if(key===state.snapKey)return snap;
  state.snapKey='';
  if(key!==state.pendingKey){
    clearTimeout(state.dwell);state.pendingKey=key;
    state.dwell=setTimeout(()=>{if(paneDrag!==state||state.pendingKey!==key)return;state.snapKey=key;state.target=markPaneSwapTarget(state,state.x,state.y);},PANE_SNAP_DWELL);
  }
  return null;
}
// The marker is a cell of the pane grid where the held pane will land, so it scrolls and
// clips with the panes.
function snapPreview(rect){
  let node=$('#pane-snap-preview');
  if(!rect){node?.remove();return;}
  if(!node){node=document.createElement('div');node.id='pane-snap-preview';node.setAttribute('aria-hidden','true');$('#terminal').append(node);}
  node.style.gridArea=`${rect.y+1} / ${rect.x+1} / span ${rect.h} / span ${rect.w}`;
}
function markPaneSwapTarget(state,clientX,clientY){
  const slot=slotAt(state,clientX,clientY),home=state.slots.find(item=>item.id===state.id);
  const chosen=slot&&slot.id!==state.id?slot:null;
  for(const item of state.slots){
    if(item.id===state.id||item===chosen)continue;
    if(item.node.classList.contains('pane-swap-target')){item.node.classList.remove('pane-swap-target');item.node.style.transform='';item.node.style.clipPath='';}
  }
  if(!chosen||!home){snapPreview(null);return null;}
  const snap=heldSnap(state,paneSnapAt(state,chosen,clientX,clientY),chosen.id);
  if(snap){
    // The hovered pane draws in to the part it keeps (masked, never scaled) and the marker
    // outlines the space it frees for the held pane.
    const from=state.cells[chosen.id],to=snap.rects[chosen.id],step=paneGridStep(),inset=(a,b,unit)=>Math.max(0,(a-b)*unit).toFixed(2)+'px';
    chosen.node.classList.add('pane-swap-target');chosen.node.style.transform='';
    chosen.node.style.clipPath=`inset(${inset(to.y,from.y,step.row)} ${inset(from.x+from.w,to.x+to.w,step.col)} ${inset(from.y+from.h,to.y+to.h,step.row)} ${inset(to.x,from.x,step.col)} round 9px)`;
    snapPreview(snap.rects[state.id]);
    return {id:chosen.id,node:chosen.node,side:snap.side};
  }
  snapPreview(null);
  // Move the hovered pane into the slot the held pane left. Panes are not always the same
  // size (a three-pane grid has one tall pane), and scaling one to fill the other's slot
  // distorts the terminal inside it. So the pane is never stretched: it keeps its own
  // proportions, aligns to the slot's top-left, and is masked to the slot's footprint,
  // with the mask rounded to the pane's own radius so the result reads as a pane in that
  // slot rather than a cut-off one. The uniform scale only engages if a slot is narrower
  // than the pane, as when a full-width pane is previewed in a half-width cell.
  chosen.node.classList.add('pane-swap-target');
  const fit=Math.min(1,home.rect.width/chosen.rect.width);
  const dx=home.rect.left-chosen.rect.left,dy=home.rect.top-chosen.rect.top;
  const cropRight=Math.max(0,chosen.rect.width-home.rect.width/fit);
  const cropBottom=Math.max(0,chosen.rect.height-home.rect.height/fit);
  chosen.node.style.transform='translate3d('+dx.toFixed(2)+'px,'+dy.toFixed(2)+'px,0)'+(fit<.999?' scale('+fit.toFixed(4)+')':'');
  chosen.node.style.clipPath=cropRight||cropBottom?'inset(0px '+cropRight.toFixed(2)+'px '+cropBottom.toFixed(2)+'px 0px round 9px)':'';
  return {id:chosen.id,node:chosen.node};
}
// Only transform and opacity change while a pane is held, so the grid never reflows and
// the live xterm inside it is never resized mid-drag.
function paneLift(state,clientX,clientY){
  if(!state.node)return;
  state.node.style.transform='translate3d('+(clientX-state.startX)+'px,'+(clientY-state.startY)+'px,0) scale(.97) rotate(.4deg)';
}
function settlePane(node){
  if(!node)return;
  node.classList.remove('pane-settled');void node.offsetWidth;node.classList.add('pane-settled');
  setTimeout(()=>node.classList.remove('pane-settled'),420);
}
function endPaneDrag(commit,clientX,clientY){
  const state=paneDrag;paneDrag=null;
  if(!state)return;
  clearTimeout(state.dwell);
  if(state.frame)cancelAnimationFrame(state.frame);
  try{state.bar.releasePointerCapture(state.pointerId);}catch{}
  if(!state.active){clearPaneDrag();return;}
  const target=commit?(markPaneSwapTarget(state,clientX,clientY)||state.target):null;
  const node=state.node;
  if(target){
    // Drop the transitions first, then the transforms, then reorder, all in one frame:
    // the preview already has both panes where they are about to land, so nothing moves.
    clearPaneDrag();
    if(node)node.style.transform='';
    if(target.side?placePaneBeside(state.id,target.id,target.side):swapPanes(state.id,target.id)){settlePane(node);settlePane(target.node);}
  }else if(node){
    // Nothing to commit: ease the pane back to the slot it came from instead of snapping.
    node.classList.add('pane-returning');node.style.transform='';
    setTimeout(()=>node.classList.remove('pane-returning'),220);
    clearPaneDrag();
  }else clearPaneDrag();
  paneDragEndedAt=performance.now();
}
document.addEventListener('DOMContentLoaded',()=>{
  const workspace=$('#terminal');
  workspace.addEventListener('pointerdown',event=>{
    if(paneDrag||event.pointerType==='touch'||(event.pointerType==='mouse'&&event.button!==0))return;
    const bar=event.target.closest('.terminal-bar');
    if(!bar||bar.dataset.paneDrag==='off'||event.target.closest('.pane-actions')||annotating)return;
    const pane=bar.closest('.terminal-pane');
    if(!pane||!openPaneIds.includes(pane.dataset.paneId)||openPaneIds.length<2)return;
    // Not active yet and nothing is prevented here, so an ordinary click on the header
    // still focuses the pane and still opens rename.
    paneDrag={id:pane.dataset.paneId,bar,node:pane,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,active:false,target:null,frame:0,slots:[]};
  });
  document.addEventListener('pointermove',event=>{
    if(!paneDrag||event.pointerId!==paneDrag.pointerId)return;
    if(!paneDrag.active){
      if(Math.hypot(event.clientX-paneDrag.startX,event.clientY-paneDrag.startY)<5)return;
      paneDrag.active=true;draggingPaneId=paneDrag.id;
      try{paneDrag.bar.setPointerCapture(paneDrag.pointerId);}catch{}
      paneDrag.slots=paneSlots();paneDrag.scroll=$('#terminal').scrollTop;
      // Stacked panes on a narrow screen have no row to share.
      paneDrag.cells=getComputedStyle($('#terminal')).gridTemplateColumns.split(' ').length===PANE_GRID?{...resolvePaneRects(openPaneIds)}:null;
      paneDrag.node.classList.add('pane-dragging');
      document.body.classList.add('pane-dragging-active');
    }
    event.preventDefault();
    const state=paneDrag;state.x=event.clientX;state.y=event.clientY;
    // One update per frame, always using the latest position: a fast drag fires far more
    // pointermoves than the screen paints.
    if(!state.frame)state.frame=requestAnimationFrame(()=>{
      state.frame=0;if(paneDrag!==state)return;
      paneLift(state,state.x,state.y);state.target=markPaneSwapTarget(state,state.x,state.y);
    });
  });
  document.addEventListener('pointerup',event=>{if(paneDrag&&event.pointerId===paneDrag.pointerId)endPaneDrag(true,event.clientX,event.clientY);});
  document.addEventListener('pointercancel',event=>{if(paneDrag&&event.pointerId===paneDrag.pointerId)endPaneDrag(false);});
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&paneDrag?.active){event.preventDefault();endPaneDrag(false);}else if(event.key==='Escape'&&fullscreenPaneId&&!document.querySelector('dialog[open]')&&!annotating){event.preventDefault();toggleFullscreen(fullscreenPaneId);}},true);
  // Arrow keys on the focused grip, with or without Alt: Option+arrow is not reachable
  // on every Mac keyboard layout, so the bare arrows are the documented path.
  workspace.addEventListener('keydown',event=>{
    const grip=event.target.closest('.pane-grip');if(!grip)return;
    const back={ArrowLeft:-1,ArrowUp:-1}[event.key],forward={ArrowRight:1,ArrowDown:1}[event.key];
    if(!back&&!forward)return;
    event.preventDefault();event.stopPropagation();
    movePaneBy(grip.closest('.terminal-pane').dataset.paneId,back||forward);
    grip.focus();
  });
});
function highlightPanes(){
  const team=coordinatorTeam();
  document.querySelectorAll('.session-row').forEach(row=>{
    const id=row.dataset.agentId,active=id===selectedId,open=openPaneIds.includes(id);
    row.classList.toggle('selected',active);row.classList.toggle('pane-open',open);row.setAttribute('aria-pressed',String(active));
    row.closest('.session-entry').classList.toggle('coordinator-team',team.has(id));
    const label=row.querySelector('.session-team-label');if(label)label.textContent=team.has(id)&&id!==coordinatorFocusId?' · Coordinated':'';
  });
  document.querySelectorAll('.nav-group').forEach(folder=>{
    const toggle=folder.querySelector('[data-group-toggle]');if(!toggle)return;
    toggle.classList.toggle('holds-selected',!!folder.querySelector('.session-row.selected'));
    toggle.classList.toggle('holds-open',!!folder.querySelector('.session-row.pane-open'));
  });
  for(const [id,view] of paneViews){view.node.classList.toggle('focused',id===selectedId);view.edges.classList.toggle('focused',id===selectedId);}
  applyFullscreen();
}
// One pane can fill the workspace. The others stay mounted so their output keeps streaming.
let fullscreenPaneId=null;
function applyFullscreen(){
  if(fullscreenPaneId&&!paneViews.has(fullscreenPaneId))fullscreenPaneId=null;
  const workspace=$('#terminal');
  workspace.classList.toggle('has-fullscreen',!!fullscreenPaneId);
  updatePanesBelow();
  for(const [id,view] of paneViews){
    const on=id===fullscreenPaneId;
    view.node.classList.toggle('pane-fullscreen',on);view.edges.hidden=!!fullscreenPaneId;
    const button=view.node.querySelector('.pane-expand');
    if(button){button.setAttribute('aria-pressed',String(on));button.title=on?'Leave full screen · Esc':'Full screen · Esc to exit';
      button.setAttribute('aria-label',on?'Leave full screen':'Full screen');}
  }
}
function toggleFullscreen(id){
  fullscreenPaneId=fullscreenPaneId===id?null:id;
  if(fullscreenPaneId){selectedId=id;focusCoordinatorFor(id);}
  highlightPanes();
}
function formatMemory(kb){const mb=kb/1024;return mb>=1024?(mb/1024).toFixed(1)+' GB':Math.round(mb)+' MB';}
// CPU is a share of one core, so a busy agent can pass 100%.
const usageLoad=cpu=>cpu>=150?'bad':cpu>=80?'warn':cpu>=5?'busy':'idle';
const formatSpan=seconds=>seconds<60?Math.max(0,Math.floor(seconds))+'s':seconds<3600?Math.floor(seconds/60)+'m':Math.floor(seconds/3600)+'h '+String(Math.floor(seconds/60)%60).padStart(2,'0')+'m';
// Working while output keeps arriving; idle once it has been quiet past the gap. The terminal's own record is used
// when it has one, so a reload doesn't reset the clock; otherwise what this page has seen.
function activitySpan(a){
  if(!a.terminal_id||a.exit_code!==null)return null;
  const seen=terminalActivity.get(a.id),last=a.last_output??(seen?.lastOutput?seen.lastOutput/1000:null);
  // Quiet since this page opened, and the terminal keeps no record: idle, for an unknown time.
  if(!last)return seen?{state:'idle',seconds:null}:null;
  const since=a.last_output?a.active_since:(seen?.activeSince?seen.activeSince/1000:last),now=Date.now()/1000;
  return now-last<=ACTIVE_GAP_MS/1000?{state:'working',seconds:now-since}:{state:'idle',seconds:now-last};
}
// The right side of the pane's status line, like tmux's status-right: working or idle time, cpu tinted by load, then memory.
function renderUsage(view,a){
  const node=view.node.querySelector('.pane-usage'),span=activitySpan(a);
  if(!a.memory_kb&&!span){if(node.childElementCount)node.replaceChildren();return;}
  const clock=span&&span.seconds!==null?formatSpan(span.seconds):'',cpu=a.cpu_percent??null,time=span?span.state+' '+clock:'',signature=JSON.stringify([cpu,a.memory_kb,time]);
  if(view.usageSignature===signature)return;view.usageSignature=signature;
  node.innerHTML=(span?`<span class="usage-time" data-state="${span.state}"><span class="usage-label">${span.state}</span>${clock?`<span class="usage-span">${clock}</span>`:''}</span>`:'')+(!a.memory_kb?'':(cpu===null?'':`<span class="usage-cpu" data-load="${usageLoad(cpu)}"><span class="usage-label">cpu</span><span class="usage-value">${cpu.toFixed(0)}%</span></span>`)+`<span class="usage-group"><span class="usage-label">mem</span><span class="usage-mem">${formatMemory(a.memory_kb)}</span></span>`);
  node.setAttribute('aria-label',[span?span.state+(clock?' for '+clock:''):'',cpu===null?'':`CPU ${cpu.toFixed(0)}% of one core`,a.memory_kb?'memory '+formatMemory(a.memory_kb):''].filter(Boolean).join(', '));
}
// The working and idle clocks tick between refreshes; unchanged lines are skipped by their signature.
setInterval(()=>{for(const [id,view] of paneViews){const agent=!view.disposed&&agents.find(a=>a.id===id);if(agent)renderUsage(view,withTerminalActivity(agent));}},1000);
function renderTerminal(){
  if(paneMode!==paneStoreKey())loadPanes();
  const all=current();
  // Don't discard restored selection while the initial process fetch is pending.
  if(all.length||agents.length||demo||typeof agentsLoaded!=='undefined'&&agentsLoaded){openPaneIds=openPaneIds.filter(id=>webPages.has(id)||all.some(a=>a.id===id));if(!openPaneIds.length&&!paneInitialized&&selectedId)openPaneIds=[selectedId];paneInitialized=true;if(!demo)openSpawnedPanes(all);}
  if(!openPaneIds.includes(selectedId))selectedId=openPaneIds[0]||null;
  const workspace=$('#terminal');workspace.dataset.count=openPaneIds.length;
  $('#pane-count').textContent=`${openPaneIds.length} / ${PANE_LIMIT} open`;
  // A pane of another desk or mode is put away, not closed: its web page is kept for when that desk is shown again.
  for(const [id,view] of paneViews){if(!openPaneIds.includes(id)||view.paneKey!==paneMode){if(view.paneKey===paneMode)forgetWebPage(id);view.checkpoint?.();view.disposed=true;view.subscription?.close();view.files?.dispose();view.observer?.disconnect();view.term?.dispose();view.cleanup?.();view.node.remove();view.edges.remove();paneViews.delete(id);}}
  workspace.querySelector('.workspace-empty')?.remove();
  if(!openPaneIds.length){workspace.innerHTML='<div class="workspace-empty"><h2>Your workspace is ready.</h2><p>Select a session or start an interactive terminal.</p><button class="button" id="empty-new-terminal">＋ New terminal</button></div>';$('#empty-new-terminal').onclick=()=>openTerminalLauncher();}
  for(const id of openPaneIds){const page=webPages.get(id);if(page){let view=paneViews.get(id);if(!view){view=createWebPane(page);view.paneKey=paneMode;paneViews.set(id,view);workspace.append(view.node,view.edges);}updateWebPane(view,page);continue;}const agent=all.find(a=>a.id===id);if(!agent)continue;let view=paneViews.get(id);if(!view){view=createPane(agent);view.paneKey=paneMode;paneViews.set(id,view);workspace.append(view.node,view.edges);if(agent.terminal_id)mountPTY(view,agent);}if(agent.coordinator_workspace&&!view.coordinator)window.mountCoordinatorPane?.(view,agent);updatePane(view,agent);}
  // A background refresh must not re-settle the grid under a pane that is being resized.
  if(!paneResize){applyPaneLayout({animate:true});sortPanesByLayout();savePaneRects();}
  syncPaneOrder();highlightPanes();savePanes();renderLayoutPicker();
}
function createPane(agent){
  const node=document.createElement('section');node.className='terminal terminal-pane';node.dataset.paneId=agent.id;node.style.setProperty('--agent-color',agentColor(agent.id));node.setAttribute('aria-label',agent.name+' terminal');
  node.innerHTML='<div class="terminal-bar" title="Drag this header to move the pane"><button class="pane-grip" title="Drag the header to move the pane \u00b7 \u2190/\u2192 to move it from the keyboard" aria-label="Move pane"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4h.01M10 4h.01M6 8h.01M10 8h.01M6 12h.01M10 12h.01"/></svg></button><div class="pane-title"></div><div class="pane-actions"><span class="pane-state"></span><button class="pane-protect pane-icon hidden" aria-pressed="false"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.4" y="7.2" width="9.2" height="6.2" rx="1.4"/><path class="lock-shut" d="M5.4 7.2V5.3a2.6 2.6 0 0 1 5.2 0v1.9"/><path class="lock-open" d="M5.4 7.2V4.5a2.6 2.6 0 0 1 5.1-.8"/></svg></button><button class="pane-expand pane-icon" title="Full screen · Esc to exit" aria-label="Full screen"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2.6h3.4M14 6V2.6h-3.4M2 10v3.4h3.4M14 10v3.4h-3.4"/></svg></button><button class="pane-stop hidden" title="Stop the session and close its pane" aria-label="Stop terminal"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.8"/><rect class="stop-glyph" x="5.9" y="5.9" width="4.2" height="4.2" rx=".8"/></svg><span>Stop</span></button><button class="pane-close pane-icon" title="Close pane; session keeps running" aria-label="Close pane"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button></div></div><div class="pane-readouts" hidden></div><div class="pane-main"><div class="pane-body"></div></div><div class="pane-directory pane-status"><span class="pane-path"></span><span class="pane-usage" title="CPU as a share of one core, and memory, for this agent and everything it started"></span></div><div class="pane-connection" role="status"></div>';
  // Resize handles sit in the gap around the pane rather than over the terminal, so they
  // never cover its scrollbar or last row. They share the pane's grid cell.
  const edges=document.createElement('div');edges.className='pane-edges';edges.dataset.edgesFor=agent.id;
  edges.innerHTML='<div class="pane-resize" data-edge="e" aria-hidden="true"></div><div class="pane-resize" data-edge="s" aria-hidden="true"></div><button class="pane-resize" data-edge="se" title="Drag to resize \u00b7 arrow keys resize by one cell" aria-label="Resize '+escapeHTML(agent.name)+' pane"></button>';
  const view={node,edges,demo,disposed:false,signature:null};
  const title=node.querySelector('.pane-title');
  if(agent.terminal_id||agent.coordinator_workspace){title.tabIndex=0;title.setAttribute('role','button');title.title='Click to rename';title.onclick=()=>{if(!annotating&&performance.now()-paneDragEndedAt>250)editPaneName(view,agent.id);};title.onkeydown=event=>{if(event.target===title&&['Enter',' '].includes(event.key)){event.preventDefault();editPaneName(view,agent.id);}};}
  node.querySelector('.pane-close').onclick=()=>closePane(agent.id);
  node.querySelector('.pane-expand').onclick=()=>toggleFullscreen(agent.id);
  node.querySelector('.pane-stop').onclick=()=>requestCloseTerminal(agent.id);
  // A protected session takes input only from this page: agents and local tools are refused.
  node.querySelector('.pane-protect').onclick=async()=>{
    const current=agents.find(item=>item.id===agent.id);if(!current)return;
    try{const result=await terminalRequest('/api/terminals/protect',{id:agent.id,protected:!current.protected});current.protected=result.protected;render();
      toast(result.protected?'Protected: only you can read or type into this session':'No longer protected: agents and local tools can reach this session');}
    catch(error){toast(error.message);}
  };
  node.addEventListener('pointerdown',()=>{selectedId=agent.id;focusCoordinatorFor(agent.id);highlightPanes();});
  node.addEventListener('focusin',()=>{selectedId=agent.id;focusCoordinatorFor(agent.id);highlightPanes();});
  return view;
}
function editPaneName(view,id){
 if(view.renaming)return;
 const agent=current().find(a=>a.id===id);if(!agent)return;
 const title=view.node.querySelector('.pane-title'),input=document.createElement('input');
 view.renaming=true;view.node.querySelector('.terminal-bar').dataset.paneDrag='off';input.className='pane-name-input';input.value=sessionTitle(agent);input.maxLength=100;input.setAttribute('aria-label','Session name');title.replaceChildren(input);
 let finished=false;
 const restore=()=>{view.renaming=false;delete view.node.querySelector('.terminal-bar').dataset.paneDrag;const latest=current().find(a=>a.id===id)||agent;title.textContent=latest.project+' / '+sessionTitle(latest);};
 const save=async()=>{if(finished)return;finished=true;const name=input.value.trim();if(!name||name===sessionTitle(agent)){restore();return;}input.disabled=true;
  try{const updated=await terminalRequest(agent.coordinator_workspace?'/api/coordinators/rename':'/api/terminals/rename',{id,name});const row=agents.find(a=>a.id===id);if(row)Object.assign(row,updated);restore();render();}
  catch(error){restore();toast(error.message==='Not found'?'Restart Agent Desk to enable coordinator renaming.':error.message);}
 };
 input.onkeydown=event=>{event.stopPropagation();if(event.key==='Escape'){finished=true;restore();title.focus();}else if(event.key==='Enter'){event.preventDefault();save();}};
 input.onblur=save;input.focus();input.select();
}
// Readouts: values a pane's own process set (agent-desk-readout or the agent-desk tool). The server
// sends an age, not a timestamp, so a remote node's clock cannot make values look fresh or stale.
function stampReadouts(list){const now=Date.now()/1000;for(const a of list)if(a.readouts)a.readouts.published=now-a.readouts.age;return list;}
function updatePaneReadouts(view,readouts){
  const row=view.node.querySelector('.pane-readouts');
  if(!readouts?.fields?.length){if(!row.hidden){row.hidden=true;row.replaceChildren();view.readoutsSignature=null;}return;}
  const ttl=readouts.ttl_seconds,age=Math.max(0,Date.now()/1000-readouts.published),stale=!!ttl&&age>ttl;
  const ageText=(stale?'Stale · ':'')+deskSince(readouts.published),signature=JSON.stringify([readouts.fields,ageText]);
  if(view.readoutsSignature===signature)return;view.readoutsSignature=signature;
  row.hidden=false;row.classList.toggle('stale',stale);
  row.innerHTML='<span class="pane-readout-fields">'+readouts.fields.map(f=>`<span class="pane-readout" data-tone="${escapeHTML(f.tone)}" title="${escapeHTML(f.label+': '+f.value)}"><span class="pane-readout-label">${escapeHTML(f.label)}</span><span class="pane-readout-value">${escapeHTML(f.value)}</span></span>`).join('')+'</span>'+
    `<span class="pane-readouts-age" title="${escapeHTML('Set '+new Date(readouts.published*1000).toLocaleString()+(ttl?' · expected again within '+deskDuration(ttl):''))}">${escapeHTML(ageText)}</span>`;
}
function deskDuration(seconds){return seconds<120?Math.round(seconds)+'s':seconds<7200?Math.round(seconds/60)+'m':seconds<172800?Math.round(seconds/3600)+'h':Math.round(seconds/86400)+'d';}
function updatePane(view,a){
  updatePaneReadouts(view,a.readouts);
  window.renderPaneDock?.(view,a);
  if(!view.renaming)view.node.querySelector('.pane-title').textContent=a.project+' / '+sessionTitle(a);
  view.node.querySelector('.pane-path').textContent=(a.remote_node?'Remote · '+a.remote_name+(a.remote_connected===false?' · disconnected':'')+' / ':'')+shortPath(a.cwd||'Folder unavailable');
  view.node.querySelector('.pane-directory').title=a.cwd||'';
  const state=a.terminal_id&&a.exit_code!==null?'Exited'+(a.exit_code?' · '+a.exit_code:''):['needs_input','error'].includes(a.status)?labels[a.status]:'';
  view.node.querySelector('.pane-state').textContent=state;
  view.node.querySelector('.pane-state').dataset.state=state?a.exit_code!==null&&a.terminal_id?'exited':a.status:'';
  renderUsage(view,a);
  view.node.querySelector('.pane-stop').classList.toggle('hidden',!a.terminal_id||a.exit_code!==null);
  const protect=view.node.querySelector('.pane-protect'),locked=!!a.protected;
  protect.classList.toggle('hidden',!a.terminal_id||!!a.remote_node);protect.setAttribute('aria-pressed',String(locked));
  protect.title=locked?'Protected: only you can read or type into this session · click to allow agents and tools':'Protect this session from agents and local tools';
  protect.setAttribute('aria-label',locked?'Stop protecting this session':'Protect this session');
  if(a.terminal_id||a.coordinator_workspace)return;
  const signature=JSON.stringify([a.task,a.events,a.question,a.status]);if(view.signature===signature)return;view.signature=signature;
  const body=view.node.querySelector('.pane-body'),scroll=body.scrollTop;
  if(a.harness_internal){
    body.innerHTML=`<div class="terminal-line dim">CLAUDE INTERNAL SUBAGENT · READ-ONLY</div><p class="muted">Runs inside its owning Claude session. It has no separate terminal input. A finished response does not confirm that its task succeeded.</p><pre class="internal-agent-result">${escapeHTML(a.task)}</pre><button class="button internal-agent-parent">Open parent: ${escapeHTML(sessionTitle(agents.find(parent=>parent.id===a.parent_id)||{name:a.parent_id}))}</button>`;
    body.querySelector('.internal-agent-parent').onclick=()=>{if(everyAgent().some(agent=>agent.id===a.parent_id))selectPane(a.parent_id);else toast('The parent session is no longer available.');};
    body.scrollTop=scroll;return;
  }

  body.innerHTML=a.source==='discovered'?'<div class="terminal-empty"><div class="terminal-empty-icon">›_</div><h2>Opened in another terminal</h2><p>This process was started outside Agent Desk. Its terminal input and output belong to that app.</p><div class="resume-actions"><button class="button pane-resume">Resume conversation</button><button class="text-button pane-launch">New terminal in this folder</button></div><small>Resume saved conversation history in a new interactive terminal. Choose the matching conversation; a process ID is not a conversation ID.</small></div>':`<div class="terminal-line dim">${a.source==='demo'?'DEMO · SAMPLE EVENTS':'ADAPTER EVENTS'}</div><div class="terminal-line">${escapeHTML(a.task)}</div>${a.events.map(e=>`<div class="terminal-line"><time>${new Date(e.time*1000).toLocaleTimeString()}</time> ${escapeHTML(e.message)}</div>`).join('')}${a.question?`<div class="terminal-question"><small>INPUT REQUESTED</small><p>${escapeHTML(a.question)}</p></div>`:''}<p class="muted">${a.source==='demo'?'Demo sessions do not run a process.':'This adapter reports events but has no terminal connection.'}</p><button class="button pane-launch">New interactive terminal</button>`;
  body.querySelector('.pane-launch').onclick=()=>openTerminalLauncher(a.cwd);
  const resume=body.querySelector('.pane-resume');if(resume){resume.classList.toggle('hidden',!(a.harness in resumeFlags));resume.onclick=()=>openTerminalLauncher(a.cwd,a.harness,true);}
  body.scrollTop=scroll;
}
function loadWebglRenderer(term){
  if(!window.WebglAddon)return;
  try{const webgl=new WebglAddon.WebglAddon();webgl.onContextLoss(()=>webgl.dispose());term.loadAddon(webgl);}catch{}
}
function mountPTY(view,agent){
  const target=view.node.querySelector('.pane-body');target.classList.add('pty-body');
  const saved=readTerminalSnapshot(agent.id),fresh=freshTerminalIds.delete(agent.id);
  if(saved?.title){const activity=terminalActivity.get(agent.id)||{cursor:null,lastOutput:0,connected:true};activity.title=saved.title;terminalActivity.set(agent.id,activity);}
  const term=new Terminal({cols:saved?.cols||80,rows:saved?.rows||24,cursorBlink:true,fontFamily:'"SFMono-Regular", Menlo, Consolas, monospace',fontSize:12,fontWeight:400,fontWeightBold:600,lineHeight:1.15,letterSpacing:0,smoothScrollDuration:0,scrollback:5000,theme:{background:'#0c0c0d',foreground:'#dedee4',cursor:'#9ccaff',selectionBackground:'#6383ae66'},allowProposedApi:false,disableStdin:true});
  const fit=new FitAddon.FitAddon(),serializer=new SerializeAddon.SerializeAddon();term.loadAddon(fit);term.loadAddon(serializer);term.open(target);loadWebglRenderer(term);
  term.onTitleChange(title=>{const activity=terminalActivity.get(agent.id)||{cursor:null,lastOutput:0,connected:true};activity.title=title.replace(/[\x00-\x1f\x7f]/g,'').slice(0,240);terminalActivity.set(agent.id,activity);});
  view.term=term;view.cursor=saved?.cursor||0;view.queue=Promise.resolve();view.exited=false;view.restoring=true;
  {const activity=terminalActivity.get(agent.id)||{cursor:null,lastOutput:0,connected:true};terminalActivity.set(agent.id,activity);activity.redrawUntil=Date.now()+4000;}
  let writing=false,dirty=false,resizeTimer,lastSaved=0,needsRedraw=!saved?.state;
  let boundary=new TerminalStreamBoundary();
  const status=view.node.querySelector('.pane-connection');status.textContent='Restoring terminal…';
  target.classList.add('pty-restoring');
  const write=data=>new Promise(resolve=>{writing=true;term.write(data,()=>{writing=false;resolve();});});
  view.checkpoint=()=>{
    if(view.disposed||view.restoring||writing||!boundary.complete||!dirty)return;
    for(const scrollback of [1000,100,0]){
      const snapshot={screen:serializer.serialize({scrollback}),cols:term.cols,rows:term.rows,cursor:view.cursor,state:captureTerminalState(term),title:terminalActivity.get(agent.id)?.title||''};
      if(storeTerminalSnapshot(agent.id,snapshot)){dirty=false;lastSaved=performance.now();break;}
    }
  };
  // Keystrokes ride the stream when it is open; the queue keeps them ordered with HTTP fallbacks.
  // Finish ordinary text in its original terminal even if its pane is hidden.
  // File input can be cancelled until its first packet; once started, finish the paste framing.
  const inputFailed=error=>{status.textContent=error.message+' · input was not retried';};
  function send(packets,canSend){
    if(view.restoring||view.exited)return;
    view.lastActivity=performance.now();
    view.queue=view.queue.then(async()=>{
      if(canSend&&!canSend())return;
      for(const data of packets){
        try{await(view.subscription&&terminalStream.send({type:'input',id:agent.id,data})||terminalRequest('/api/terminals/input',{id:agent.id,data}));}
        catch(error){inputFailed(error);}
      }
    }).catch(inputFailed);
    return view.queue;
  }
  const sendResize=(cols,rows)=>(quietRedraw(agent.id),view.subscription)&&terminalStream.send({type:'resize',id:agent.id,cols,rows})||terminalRequest('/api/terminals/resize',{id:agent.id,cols,rows});
  // Ignore responses generated by replayed terminal queries as well as keyboard input.
  function sendText(data,canSend){if(view.restoring||view.exited)return;const bytes=new TextEncoder().encode(data),packets=[];for(let offset=0;offset<bytes.length;offset+=16384)packets.push(btoa(Array.from(bytes.subarray(offset,offset+16384),byte=>String.fromCharCode(byte)).join('')));return send(packets,canSend);}
  const files=TerminalFiles.mount({bridge:window.agentDeskDesktop,target,pane:view.node,term,status,
    available:()=>!view.disposed&&!view.restoring&&!view.exited&&!view.reconnects&&!term.options.disableStdin,
    remote:()=>!!(agents.find(item=>item.id===agent.id)||agent).remote_node||String(agent.id).startsWith('remote:')});
  view.files=files;
  const input=write=>files?files.input(write):write();
  term.onData(data=>input(canSend=>sendText(data,canSend)));
  // Shift+Enter must add a line instead of submitting. xterm sends a bare CR for both,
  // so send the escape sequence coding agents read as a newline, the same one
  // `claude /terminal-setup` binds in iTerm2 and VS Code.
  term.attachCustomKeyEventHandler(event=>{
    if(event.type!=='keydown'||event.key!=='Enter'||!event.shiftKey||event.ctrlKey||event.metaKey||event.altKey)return true;
    event.preventDefault();input(()=>sendText('\x1b\r'));return false;
  });
  term.onBinary(data=>input(()=>send([btoa(data)])));
  function resize(force=false){
    if(view.disposed||view.restoring||!target.clientWidth||!target.clientHeight)return;
    // A pane being resized is refitted once, on release, not at every cell it passes.
    if(writing||paneResize){clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>resize(force),30);return;}
    const oldCols=term.cols,oldRows=term.rows;fit.fit();
    if(oldCols!==term.cols||oldRows!==term.rows)dirty=true;
    if(!view.exited&&(force||oldCols!==term.cols||oldRows!==term.rows)){
      const cols=term.cols,rows=term.rows;
      view.queue=view.queue.then(async()=>{
        if(view.disposed)return;
        if(force){await sendResize(cols>2?cols-1:cols+1,rows);await new Promise(resolve=>setTimeout(resolve,40));}
        await sendResize(cols,rows);
      }).catch(error=>status.textContent=error.message);
    }
    view.checkpoint();
  }
  view.observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>resize(),100);});view.observer.observe(target);
  // Applies one reply from either transport; returns how many bytes it wrote, or null once the session has ended.
  async function consume(output){
    // A reply ends any reconnect notice; without this a single dropped request
    // left "reconnecting…" on a terminal that had already recovered and was streaming again.
    if(view.reconnects){view.reconnects=0;if(!view.restoring&&!view.exited)status.textContent='';}
    if(output.truncated){files?.cancel();term.reset();boundary=new TerminalStreamBoundary();needsRedraw=true;view.restoring=true;term.options.disableStdin=true;status.textContent='Recovering terminal after a gap in output…';}
    const bytes=Uint8Array.from(atob(output.data),char=>char.charCodeAt(0));
    if(bytes.length){view.lastActivity=performance.now();await write(bytes);boundary.feed(bytes);dirty=true;}
    view.cursor=output.cursor;
    if(!bytes.length&&view.restoring){
      view.restoring=false;view.exited=output.exit_code!==null;term.options.disableStdin=view.exited;
      target.classList.remove('pty-restoring');status.textContent='';resize(needsRedraw);needsRedraw=false;dirty=true;view.checkpoint();
    }
    if(output.exit_code!==null&&!bytes.length){files?.cancel();view.exited=true;status.textContent=`Session ended · exit ${output.exit_code}`;term.options.disableStdin=true;view.checkpoint();return null;}
    if(!view.restoring&&performance.now()-lastSaved>300)view.checkpoint();
    return bytes.length;
  }
  function interrupted(message,attempts){
    files?.cancel();
    view.reconnects=attempts;
    // One dropped request is ordinary while the browser or server is busy; say so on the second.
    if(attempts>1)status.textContent=(/failed to fetch|load failed|networkerror/i.test(message)?'Connection interrupted':message)+' · reconnecting…';
  }
  function stream(){
    let inbox=Promise.resolve();
    view.subscription=terminalStream.subscribe(agent.id,view.cursor,message=>{
      if(view.disposed)return;
      if(message.type==='output'||message.type==='exit'){
        markTerminalConnection(agent.id,true);
        if(message.type==='exit')noteTerminalExit(agent.id,message.exit_code);
        const output=message.type==='exit'?{data:'',cursor:message.cursor,truncated:false,exit_code:message.exit_code}:message;
        inbox=inbox.then(async()=>{
          if(view.disposed)return;
          const live=!view.restoring,written=await consume(output);
          if(written&&live)noteTerminalOutput(agent.id);
          if(written===null){view.subscription?.close();view.subscription=null;}
        }).catch(error=>{status.textContent=error.message;});
      }else if(message.type==='disconnected'){interrupted('Connection interrupted',message.attempts);markTerminalConnection(agent.id,false);}
      else if(message.type==='error'){interrupted(message.message,message.attempts);markTerminalConnection(agent.id,false);}
      else if(message.type==='input-error')status.textContent=message.message+' · input was not retried';
    });
  }
  async function poll(){
    if(view.disposed)return;
    if(terminalStream.usable(agent.id))return stream();
    try{
      const output=await terminalRequest(`/api/terminals/output?id=${encodeURIComponent(agent.id)}&cursor=${view.cursor}`);if(view.disposed)return;
      const written=await consume(output);if(written===null)return;
      setTimeout(poll,view.restoring||written>=131072?0:performance.now()-(view.lastActivity||0)<1000?32:120);
    }catch(error){
      if(view.disposed)return;
      interrupted(error.message,(view.reconnects||0)+1);
      setTimeout(poll,Math.min(3000,500*view.reconnects));
    }
  }
  (async()=>{
    await document.fonts.ready;await new Promise(requestAnimationFrame);if(view.disposed)return;
    if(saved){await write(saved.screen);restoreTerminalState(term,saved.state);}else fit.fit();
    if(fresh&&!view.disposed){
      await sendResize(term.cols,term.rows);
      view.restoring=false;needsRedraw=false;term.options.disableStdin=false;target.classList.remove('pty-restoring');status.textContent='';
    }
    await terminalStream.ready();
    if(!view.disposed)poll();
  })().catch(error=>{status.textContent=error.message;});
}
window.addEventListener('pagehide',()=>{for(const view of paneViews.values())view.checkpoint?.();});
document.addEventListener('visibilitychange',()=>{if(document.hidden)for(const view of paneViews.values())view.checkpoint?.();});

// How each CLI reopens a conversation. One without a picker flag offers only the latest session or an ID.
const resumeFlags={
  codex:{picker:['resume'],latest:['resume','--last'],id:identity=>['resume',identity]},
  claude:{picker:['--resume'],latest:['--continue'],id:identity=>['--resume',identity]},
  grok:{latest:['--continue'],id:identity=>['--resume',identity]},
  opencode:{latest:['--continue'],id:identity=>['--session',identity]},
  pi:{picker:['--resume'],latest:['--continue'],id:identity=>['--session',identity]},
  cortex:{picker:['--resume'],latest:['--continue'],id:identity=>['--resume',identity]}
};
function resumeCommand(harness,mode,identity){
  if(mode==='new'||mode==='portable')return [];
  const flags=resumeFlags[harness];
  if(!flags)throw Error('Resume is not configured for this harness');
  if(mode==='picker'){
    if(!flags.picker)throw Error('Choose the latest session or enter an ID/title for '+launchChoices[harness].label);
    return flags.picker;
  }
  if(mode==='latest')return flags.latest;
  if(mode==='id'){
    if(!identity||identity.startsWith('-')||identity.includes('\n'))throw Error('Enter a session ID or name, not a command-line flag');
    return flags.id(identity);
  }
  throw Error('Choose a conversation mode');
}
function updateResumeOptions(){
  const harness=launchChoices[$('#terminal-harness').value].harness,supported=harness in resumeFlags,noPicker=supported&&!resumeFlags[harness].picker;
  $('#terminal-custom-field').classList.toggle('hidden',harness==='shell');
  if(harness==='custom')$('#terminal-advanced').open=true;
  $('#terminal-resume-options').classList.toggle('hidden',!supported||$('#terminal-controller').checked);
  const picker=$('#terminal-session-mode option[value="picker"]');picker.disabled=noPicker;picker.hidden=noPicker;
  if(!supported||$('#terminal-controller').checked)$('#terminal-session-mode').value='new';
  else if(noPicker&&$('#terminal-session-mode').value==='picker')$('#terminal-session-mode').value='id';
  const mode=$('#terminal-session-mode').value;
  $('#portable-conversation-fields').hidden=mode!=='portable';
  if(mode==='portable')window.loadPortableConversations?.();
  $('#terminal-session-id-field').classList.toggle('hidden',mode!=='id'||!supported);
  $('#terminal-session-id').required=supported&&mode==='id';
  $('#terminal-resume-help').textContent=mode==='new'?'':mode==='portable'?'Carries messages and tool history into the selected harness. Native permissions and hidden model state stay with their source.':mode==='picker'?'The harness opens its conversation picker inside the terminal.':mode==='latest'?'Resumes the latest saved conversation for the working directory below.':'Reopens the specified conversation with its saved history.';
  $('#launch-terminal-form button[type="submit"]').textContent=$('#terminal-controller').checked?'Launch coordinator':mode==='new'?'Launch terminal':'Resume conversation';
}
async function openTerminalLauncher(cwd,harness=null,resume=false,controller=false){
  try{if(!terminalAuth)await terminalRequest('/api/terminal-auth');}catch(error){toast(error.message);return;}
  $('#terminal-controller').checked=controller;updateControllerOptions();
  // Readouts are chosen per terminal, so the box never carries over from the last launch.
  $('#terminal-readouts').checked=false;
  $('#terminal-cwd').value=cwd||current().find(a=>a.id===selectedId)?.cwd||terminalDefaultCwd;
  if(harness&&launchChoices[$('#terminal-harness').value].harness!==harness)$('#terminal-harness').value=harness;
  loadLaunchChoice();
  $('#terminal-session-mode').value=resume?(resumeFlags[harness]?.picker?'picker':'id'):'new';
  $('#terminal-session-id').value='';
  if(resume)$('#terminal-args').value='';
  updateResumeOptions();
  $('#terminal-launch-error').textContent='';$('#launch-terminal-dialog').showModal();prepareProjectPicker();
}
document.addEventListener('DOMContentLoaded',()=>{
  $('#terminal-harness').onchange=loadLaunchChoice;
  loadLaunchChoice();
  $('#terminal-session-mode').onchange=updateResumeOptions;
  $('#launch-terminal-form').onsubmit=async event=>{
    event.preventDefault();const submit=event.submitter;submit.disabled=true;
    try{
      const choiceKey=$('#terminal-harness').value,choice=launchChoices[choiceKey],harness=choice.harness,args=$('#terminal-args').value.split('\n').map(s=>s.trim()).filter(Boolean);
      const command=$('#terminal-executable').value.trim(),commandMode=$('#terminal-command-mode').value;
      const body={cwd:$('#terminal-cwd').value.trim(),launch_profile:choice.account?choiceKey:null,name:harness==='custom'&&!choiceKey.startsWith('preset-')?command:choice.label};
      const mode=$('#terminal-session-mode').value;
      const goal=$('#terminal-controller').checked?$('#controller-goal').value.trim():null;
      if(goal!==null){
        if(!goal||!['codex','claude','grok'].includes(harness))throw Error('Choose Codex, Claude or Grok and enter a coordinator objective');
        let events;try{events=await terminalRequest('/api/coordinator-events');}catch{throw Error('Restart Agent Desk to enable event-driven coordinators.');}
        if(harness==='grok'&&!events.native_grok_terminal)throw Error('Restart Agent Desk to enable native Grok coordinators.');
        if(!events.event_delivery)throw Error('Restart Agent Desk to enable event-driven coordinators.');
        body.name='Controller · '+choice.label+' · '+crypto.randomUUID().slice(0,6);
        body.coordinator_harness=harness;
        args.push(controllerPrompt(goal,body.name,$('#controller-router').checked));
      }
      if(mode==='portable'){const prepared=await window.preparePortableConversation();args.push(prepared.prompt);}
      if(harness!=='shell')body.argv=buildTerminalCommand(command,commandMode,[...resumeCommand(harness,mode,$('#terminal-session-id').value.trim()),...args]);
      if(mode!=='new')body.name+=mode==='portable'?' · continued':' · resumed';
      if(harness==='shell'&&args.length)throw Error('For shell arguments, choose Custom executable and specify the shell.');
      body.cwd=await resolveProjectDirectory();
      body.desk=activeDesk().id;
      if(!$('#terminal-readouts-field').hidden&&$('#terminal-readouts').checked)body.readouts=true;
      const session=await terminalRequest('/api/terminals/launch',body);rememberLaunchChoice(choiceKey,{command,mode:commandMode},session.id,goal);freshTerminalIds.add(session.id);demo=false;paneMode=paneStoreKey();
      agents.unshift({...session,project:session.cwd.split('/').pop()||session.cwd});
      if(openPaneIds.length>=PANE_LIMIT)openPaneIds=openPaneIds.filter(id=>id!==selectedId).slice(0,PANE_LIMIT-1);
      openPaneIds.push(session.id);selectedId=session.id;savePanes();$('#launch-terminal-dialog').close();switchPage('agents');render();paneViews.get(session.id)?.node.scrollIntoView({block:'nearest'});
    }catch(error){$('#terminal-launch-error').textContent=error.message;}finally{submit.disabled=false;}
  };
  $('#confirm-stop-terminal').onclick=async()=>{try{await terminalRequest('/api/terminals/stop',{id:stopTerminalId});$('#stop-terminal-dialog').close();if(removeAfterStop)dismissTerminal(stopTerminalId);refresh();}catch(error){toast(error.message);}};
});
