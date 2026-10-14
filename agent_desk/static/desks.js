// Desks: named sets of agents, like herdr's sessions, so separate projects
// each get their own sidebar, panes and layout. The server decides which desk every agent is
// on (desks.py); this tab chooses which desk it shows, and a new tab opens the last one used.
// Inbox, Automations, Skills and Tools stay global, and an agent on another desk that needs you
// still raises the alert, so switching desks never hides a question.
const DESK_TAB='agent-desk-desk',DESK_LAST='agent-desk-last-desk',DESK_LIST='agent-desk-desks';
// The last list seen, so a tab on another desk does not open on the first one and then jump.
let desks=(()=>{try{const saved=JSON.parse(localStorage.getItem(DESK_LIST)||'null');if(Array.isArray(saved)&&saved.length&&saved.every(d=>typeof d?.id==='string'&&typeof d.name==='string'))return saved;}catch{}return [{id:'main',name:'Main'}];})();
let activeDeskId=(()=>{try{return sessionStorage.getItem(DESK_TAB)||localStorage.getItem(DESK_LAST)||'main';}catch{return 'main';}})();
let deskEditing=null;
function activeDesk(){return desks.find(d=>d.id===activeDeskId)||desks[0];}
// An agent the server has not placed yet (one this tab just started) is on the first desk.
const deskOf=agent=>desks.some(d=>d.id===agent.desk)?agent.desk:desks[0].id;
const onActiveDesk=agent=>demo||deskOf(agent)===activeDesk().id;
// Browser state kept per desk. The first desk keeps the keys from before desks existed, so
// the panes and layout open when desks arrived are still open on it.
const deskScoped=key=>activeDesk().id==='main'?key:key+'@'+activeDesk().id;
function setDesks(list){
  if(!Array.isArray(list)||!list.length)return;
  const shown=activeDesk().id;
  desks=list;try{localStorage.setItem(DESK_LIST,JSON.stringify(list));}catch{}
  // The desk this tab showed was deleted in another tab, so show the first desk.
  if(!desks.some(d=>d.id===activeDeskId)){activeDeskId=desks[0].id;rememberDesk();}
  // Nothing is saved first: the panes in hand belong to a desk that is gone or never shown.
  if(activeDesk().id!==shown){loadPanes();coordinatorFocusId=null;selectedId=openPaneIds[0]||null;}
}
function rememberDesk(){try{sessionStorage.setItem(DESK_TAB,activeDeskId);localStorage.setItem(DESK_LAST,activeDeskId);}catch{}}
function switchDesk(id,{quiet=false,render:draw=true}={}){
  const desk=desks.find(d=>d.id===id);if(!desk)return;
  const changed=desk.id!==activeDesk().id;
  // Save this desk's panes under its own name before the name changes, then read the next
  // desk's before anything can open a pane on it.
  if(changed){savePanes();savePaneRects();}
  activeDeskId=desk.id;rememberDesk();
  if(changed){
    loadPanes();coordinatorFocusId=null;selectedId=openPaneIds[0]||null;
    if(!quiet)toast('Switched to '+desk.name);
  }
  closeDeskMenu(false);
  if(draw)render();
}
const deskInitial=desk=>[...desk.name.trim()][0]?.toUpperCase()||'?';
const deskMark=desk=>`<span class="desk-mark" style="--desk-color:${agentColor(desk.id)}" aria-hidden="true">${escapeHTML(deskInitial(desk))}</span>`;
// Counts per desk over the agents the sidebar would list, so a desk's count matches its sidebar.
function deskCounts(){
  const counts=new Map(desks.map(d=>[d.id,{agents:0,waiting:0}]));
  for(const agent of everyAgent()){
    if(agent.harness_internal)continue;
    const count=counts.get(deskOf(agent));count.agents++;if(agent.status==='needs_input')count.waiting++;
  }
  return counts;
}
const deskIcons={
  chevron:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6.5 3 3 3-3"/></svg>',
  check:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  rename:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12l-2.6.6L4 10z"/></svg>',
  remove:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.6 7.5h4.8L11 5"/></svg>',
  plus:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>'
};
function renderDeskSwitcher(){
  const button=$('#desk-button');if(!button)return;
  const desk=activeDesk(),counts=deskCounts();
  const elsewhere=[...counts].filter(([id])=>id!==desk.id).reduce((sum,[,c])=>sum+c.waiting,0);
  $('#desk-switcher').hidden=demo;
  button.querySelector('.desk-current').innerHTML=deskMark(desk)+`<span class="desk-label"><small>Desk</small><span class="desk-name">${escapeHTML(desk.name)}</span></span>`;
  const badge=$('#desk-elsewhere');badge.hidden=!elsewhere;
  badge.title=`${elsewhere} session${elsewhere===1?'':'s'} on other desks need${elsewhere===1?'s':''} you`;
  badge.setAttribute('aria-label',badge.title);badge.innerHTML=`${attentionGlyph}<b>${elsewhere}</b>`;
  button.title=`Desk: ${desk.name} · switch desks or start a new one`;
  const plan=shutdownPlan(),power=$('#desk-shutdown'),count=plan.stop.length+plan.close.length+plan.clear.length;
  power.disabled=!count;
  power.title=count?`Shut down everything on the ${desk.name} desk · other desks keep running`:`Nothing to shut down on the ${desk.name} desk`;
  power.setAttribute('aria-label',`Shut down the ${desk.name} desk`);
  if(!$('#desk-menu').hidden&&!deskEditing)renderDeskMenu();
}
function renderDeskMenu(){
  const menu=$('#desk-menu'),counts=deskCounts(),only=desks.length===1;
  const rows=desks.map(desk=>{
    const count=counts.get(desk.id),current=desk.id===activeDesk().id;
    if(deskEditing?.id===desk.id)return `<div class="desk-option editing">${deskMark(desk)}<input class="desk-name-input" data-desk-rename-input="${escapeHTML(desk.id)}" value="${escapeHTML(desk.name)}" maxlength="40" spellcheck="false" aria-label="Desk name"></div>`;
    return `<div class="desk-option${current?' current':''}"><button type="button" role="menuitemradio" aria-checked="${current}" data-desk-id="${escapeHTML(desk.id)}">${deskMark(desk)}<span class="desk-option-name">${escapeHTML(desk.name)}</span>${count.waiting?`<span class="desk-option-waiting" title="${count.waiting} need${count.waiting===1?'s':''} you">${attentionGlyph}${count.waiting}</span>`:''}<span class="desk-option-count" title="${count.agents} session${count.agents===1?'':'s'}">${count.agents}</span><span class="desk-option-check">${current?deskIcons.check:''}</span></button>`+
      `<span class="desk-option-actions"><button type="button" class="desk-option-action" data-desk-rename="${escapeHTML(desk.id)}" title="Rename ${escapeHTML(desk.name)}" aria-label="Rename ${escapeHTML(desk.name)}">${deskIcons.rename}</button>`+
      (only?'':`<button type="button" class="desk-option-action danger" data-desk-delete="${escapeHTML(desk.id)}" title="Delete ${escapeHTML(desk.name)}" aria-label="Delete ${escapeHTML(desk.name)}">${deskIcons.remove}</button>`)+`</span></div>`;
  }).join('');
  const create=deskEditing?.id==='new'
    ?`<form class="desk-new-form">${deskIcons.plus}<input class="desk-name-input" data-desk-new-input maxlength="40" spellcheck="false" placeholder="Name, e.g. Research" aria-label="New desk name"><button type="submit" class="desk-new-save">Create</button></form>`
    :`<button type="button" role="menuitem" class="desk-new" data-desk-new>${deskIcons.plus}<span>New desk</span></button>`;
  menu.innerHTML=`<div class="desk-menu-heading">Desks</div><div class="desk-options" role="group" aria-label="Desks">${rows}</div><div class="desk-menu-divider" role="separator"></div>${create}<p class="desk-menu-error" role="alert" hidden></p>`;
  const input=menu.querySelector('.desk-name-input');
  if(input){input.focus();if(input.value)input.select();}
}
function deskMenuError(message){const error=$('#desk-menu .desk-menu-error');if(error){error.textContent=message;error.hidden=!message;}}
function openDeskMenu(){
  const menu=$('#desk-menu');deskEditing=null;renderDeskMenu();menu.hidden=false;
  $('#desk-button').setAttribute('aria-expanded','true');
  (menu.querySelector('[aria-checked="true"]')||menu.querySelector('button'))?.focus();
}
function closeDeskMenu(restoreFocus){
  const menu=$('#desk-menu');if(!menu||menu.hidden)return;
  menu.hidden=true;deskEditing=null;$('#desk-button').setAttribute('aria-expanded','false');
  if(restoreFocus)$('#desk-button').focus();
}
// moveAfter: sessions to move onto a desk once it exists, for "Move to a new desk…".
function startNewDesk(moveAfter=null){
  if($('#desk-menu').hidden)openDeskMenu();
  deskEditing={id:'new',moveAfter};renderDeskMenu();
}
async function createDesk(name){
  const moveAfter=deskEditing?.moveAfter;
  const desk=await terminalRequest('/api/desks/create',{name});
  desks=[...desks,desk];deskEditing=null;
  if(moveAfter){await placeOnDesk(moveAfter.ids,desk,moveAfter.label);closeDeskMenu(true);return;}
  switchDesk(desk.id,{quiet:true});toast(`Created “${desk.name}” · new terminals start here`);
}
async function renameDesk(id,name){
  const desk=await terminalRequest('/api/desks/rename',{id,name});
  desks=desks.map(d=>d.id===desk.id?desk:d);deskEditing=null;renderDeskMenu();renderDeskSwitcher();
  $(`#desk-menu [data-desk-id="${CSS.escape(desk.id)}"]`)?.focus();
}
// Moves sessions, with everything that follows them, onto another desk and leaves this tab here.
async function placeOnDesk(ids,desk,label){
  await terminalRequest('/api/desks/place',{ids,desk:desk.id});
  for(const agent of agents)if(ids.includes(agent.id))agent.desk=desk.id;
  await refresh();
  toast(`Moved ${label} to “${desk.name}”`);
}
function moveSessionsTo(ids,desk,label){
  // A session leaving for another desk leaves its folder here; a whole folder moves intact.
  const groups=sessionGroups(),single=ids.length===1&&groupOf(ids[0],groups);
  if(single){single.ids=single.ids.filter(id=>id!==ids[0]);saveSessionGroups(settledGroups(groups));}
  placeOnDesk(ids,desk,label).catch(error=>toast('Could not move '+label+': '+error.message));
}
// Context-menu entries for moving a session (or a folder of them) to each other desk.
function deskMoveItems(ids,label){
  return [...desks.filter(d=>d.id!==activeDesk().id).map(desk=>[`Move to ${desk.name}`,()=>moveSessionsTo(ids,desk,label)]),
    ['Move to a new desk…',()=>startNewDesk({ids,label})]];
}
// Shutting a desk down. What happens to each session on this desk, in the words the dialog uses.
// Subagents inside a harness are not listed: they end with the session that runs them.
function shutdownPlan(){
  const plan={stop:[],close:[],clear:[],leave:[]};
  for(const agent of current()){
    if(agent.harness_internal)continue;
    if(agent.coordinator_workspace)plan.close.push(agent);
    else if(agent.terminal_id&&agent.exit_code===null)plan.stop.push(agent);
    else if(agent.terminal_id)plan.clear.push(agent);
    else plan.leave.push(agent);
  }
  return plan;
}
const plural=(n,word)=>`${n} ${word}${n===1?'':'s'}`;
function shutdownSummary(plan){
  return [plan.stop.length&&`stops ${plural(plan.stop.length,'terminal')}`,plan.close.length&&`closes ${plural(plan.close.length,'coordinator')}`,plan.clear.length&&`clears ${plural(plan.clear.length,'finished terminal')}`].filter(Boolean).join(', ').replace(/, ([^,]*)$/,' and $1');
}
let shutdownState=null;
function openShutdownDesk(){
  const desk=activeDesk(),plan=shutdownPlan();
  if(!plan.stop.length&&!plan.close.length&&!plan.clear.length)return;
  closeDeskMenu(false);
  const dialog=$('#shutdown-desk-dialog'),coordinators=new Set(plan.close.map(a=>a.id));
  shutdownState={desk:desk.id,plan};
  dialog.querySelector('.desk-shutdown-mark').innerHTML=deskMark(desk);
  dialog.querySelector('h2').textContent=`Shut down the “${desk.name}” desk?`;
  const summary=shutdownSummary(plan);
  dialog.querySelector('.desk-shutdown-lede').textContent=summary[0].toUpperCase()+summary.slice(1)+' on this desk only.';
  const outcome=agent=>plan.close.includes(agent)?['Closes · saved','The conversation is saved; reopen it from Coordinator sessions']
    :plan.stop.includes(agent)?(coordinators.has(agent.parent_id)?['Stops · saved','Saved so its coordinator can resume it']:['Stops','The command running in it is ended'])
    :plan.clear.includes(agent)?['Clears','Already finished; removed from the sidebar']:['Keeps running','Not started by Agent Desk, so it cannot be stopped from here'];
  const row=agent=>{const [label,detail]=outcome(agent);
    return `<li data-shutdown-id="${escapeHTML(agent.id)}" class="${plan.leave.includes(agent)?'kept':''}"><span class="session-avatar" style="--agent-color:${agentColor(agent.id)}">${({codex:'CX',claude:'CC',grok:'GX',opencode:'OC',pi:'PI'})[agent.harness]||'AI'}</span><span class="desk-shutdown-name"><strong>${escapeHTML(sessionTitle(agent))}</strong><small>${escapeHTML(agent.project||'')}${agent.cwd?' · '+escapeHTML(shortPath(agent.cwd)):''}</small></span><span class="desk-shutdown-outcome" title="${escapeHTML(detail)}">${escapeHTML(label)}</span></li>`;};
  dialog.querySelector('.desk-shutdown-list').innerHTML=[...plan.stop,...plan.close,...plan.clear,...plan.leave].map(row).join('');
  const counts=deskCounts(),others=desks.filter(d=>d.id!==desk.id&&counts.get(d.id).agents).map(d=>`<span class="desk-shutdown-other">${deskMark(d)}${escapeHTML(d.name)} · ${plural(counts.get(d.id).agents,'session')}</span>`);
  const othersNote=dialog.querySelector('.desk-shutdown-others');
  othersNote.innerHTML=others.length?'<span>Keeps running:</span>'+others.join(''):'';othersNote.hidden=!others.length;
  dialog.querySelector('[role=alert]').textContent='';
  const confirm=dialog.querySelector('#confirm-shutdown-desk');
  confirm.hidden=false;confirm.disabled=false;confirm.textContent=`Shut down ${desk.name}`;
  dialog.querySelector('.close-dialog').textContent='Cancel';
  dialog.showModal();
}
async function shutdownDesk(){
  const dialog=$('#shutdown-desk-dialog'),confirm=dialog.querySelector('#confirm-shutdown-desk'),{desk,plan}=shutdownState;
  const name=desks.find(d=>d.id===desk)?.name||'desk';
  confirm.disabled=true;confirm.textContent='Shutting down…';
  try{
    // Exactly the sessions listed above; the server stops none that has since left this desk.
    const result=await terminalRequest('/api/desks/shutdown',{id:desk,ids:[...plan.stop,...plan.close].map(a=>a.id)});
    for(const id of result.stopped)dismissTerminal(id);
    for(const agent of plan.clear)dismissTerminal(agent.id);
    for(const id of result.closed)closePane(id);
    await refresh();
    const done=[result.stopped.length&&`stopped ${plural(result.stopped.length,'terminal')}`,result.closed.length&&`closed ${plural(result.closed.length,'coordinator')}`].filter(Boolean).join(' and ')||'nothing was running';
    if(!result.failed.length){dialog.close();toast(`${name} shut down: ${done}`);return;}
    // Say which ones are still running and why; the rest already stopped.
    for(const failure of result.failed){
      const item=dialog.querySelector(`[data-shutdown-id="${CSS.escape(failure.id)}"]`);
      item?.classList.add('failed');const tag=item?.querySelector('.desk-shutdown-outcome');if(tag){tag.textContent='Still running';tag.title=failure.error;}
    }
    const rest=result.stopped.length||result.closed.length?` Otherwise ${done}.`:'';
    dialog.querySelector('[role=alert]').textContent=`${plural(result.failed.length,'session')} could not be stopped: ${result.failed.map(f=>f.error).join(' · ')}${rest}`;
    dialog.querySelector('h2').textContent=`“${name}” is not fully shut down`;
    confirm.hidden=true;dialog.querySelector('.close-dialog').textContent='Close';
  }catch(error){dialog.querySelector('[role=alert]').textContent=error.message;confirm.disabled=false;confirm.textContent=`Shut down ${name}`;}
}
function confirmDeleteDesk(id){
  const desk=desks.find(d=>d.id===id);if(!desk||desks.length<2)return;
  closeDeskMenu(false);
  const dialog=$('#delete-desk-dialog'),count=deskCounts().get(id).agents,others=desks.filter(d=>d.id!==id);
  const fallback=others.find(d=>d.id===activeDesk().id)||others[0];
  dialog.querySelector('h2').textContent=`Delete the “${desk.name}” desk?`;
  dialog.querySelector('.desk-delete-detail').textContent=count?`Its ${count} session${count===1?'':'s'} keep running and move to the desk you choose.`:'It has no sessions. Nothing else changes.';
  const select=dialog.querySelector('#delete-desk-target');
  select.innerHTML=others.map(d=>`<option value="${escapeHTML(d.id)}"${d===fallback?' selected':''}>${escapeHTML(d.name)}</option>`).join('');
  dialog.querySelector('.desk-delete-move').hidden=!count;
  dialog.querySelector('[role=alert]').textContent='';
  dialog.dataset.deskId=id;dialog.showModal();
}
document.addEventListener('DOMContentLoaded',()=>{
  const button=$('#desk-button'),menu=$('#desk-menu');
  button.onclick=()=>menu.hidden?openDeskMenu():closeDeskMenu(true);
  button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'&&menu.hidden){event.preventDefault();openDeskMenu();}});
  menu.addEventListener('click',event=>{
    const pick=event.target.closest('[data-desk-id]'),rename=event.target.closest('[data-desk-rename]'),remove=event.target.closest('[data-desk-delete]');
    if(pick){switchDesk(pick.dataset.deskId);$('#desk-button').focus();}
    else if(rename){deskEditing={id:rename.dataset.deskRename};renderDeskMenu();}
    else if(remove)confirmDeleteDesk(remove.dataset.deskDelete);
    else if(event.target.closest('[data-desk-new]'))startNewDesk();
  });
  menu.addEventListener('submit',event=>{
    event.preventDefault();
    const input=menu.querySelector('[data-desk-new-input]'),name=input.value.trim();
    if(!name){deskMenuError('Enter a name for the desk');input.focus();return;}
    input.disabled=true;
    createDesk(name).catch(error=>{input.disabled=false;deskMenuError(error.message);input.focus();});
  });
  menu.addEventListener('keydown',event=>{
    const renameInput=event.target.closest('[data-desk-rename-input]'),newInput=event.target.closest('[data-desk-new-input]');
    if(event.key==='Escape'){
      event.preventDefault();event.stopPropagation();
      if(deskEditing){deskEditing=null;renderDeskMenu();(menu.querySelector('[aria-checked="true"]')||menu.querySelector('button'))?.focus();}
      else closeDeskMenu(true);
      return;
    }
    if(renameInput&&event.key==='Enter'){
      event.preventDefault();const id=renameInput.dataset.deskRenameInput,name=renameInput.value.trim();
      if(!name||name===desks.find(d=>d.id===id)?.name){deskEditing=null;renderDeskMenu();return;}
      renameInput.disabled=true;renameDesk(id,name).catch(error=>{renameInput.disabled=false;deskMenuError(error.message);renameInput.focus();});
      return;
    }
    if(renameInput||newInput)return;
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      const items=[...menu.querySelectorAll('[data-desk-id],[data-desk-new]')],index=items.indexOf(document.activeElement);
      event.preventDefault();items[(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();
    }else if(event.key==='Tab'&&!event.target.closest('.desk-new-form'))closeDeskMenu(false);
  });
  document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.target.closest('#desk-switcher'))closeDeskMenu(false);},true);
  $('#desk-shutdown').onclick=openShutdownDesk;
  $('#confirm-shutdown-desk').onclick=shutdownDesk;
  const dialog=$('#delete-desk-dialog');
  dialog.querySelector('#confirm-delete-desk').onclick=async()=>{
    const id=dialog.dataset.deskId,moveTo=dialog.querySelector('#delete-desk-target').value,confirm=dialog.querySelector('#confirm-delete-desk');
    confirm.disabled=true;
    try{
      const result=await terminalRequest('/api/desks/delete',{id,move_to:moveTo});
      const gone=desks.find(d=>d.id===id)?.name;
      dialog.close();
      // Leave the desk while it still exists, so its panes are saved under its own name.
      if(activeDesk().id===id)switchDesk(moveTo,{quiet:true,render:false});
      setDesks(result.desks);
      await refresh();toast(`Deleted “${gone}”`);
    }catch(error){dialog.querySelector('[role=alert]').textContent=error.message;}
    finally{confirm.disabled=false;}
  };
});
