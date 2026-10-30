// Desks: named sets of agents, like herdr's sessions, so separate projects
// each get their own sidebar, panes and layout. The server decides which desk every agent is
// on (desks.py); this tab chooses which desk it shows, and a new tab opens the last one used.
// Inbox, Automations, Skills and Tools stay global, and an agent on another desk that needs you
// still raises the alert, so switching desks never hides a question. A desk can be saved and closed
// (its sessions stop) and reopened later from the menu, with its conversations resumed in its panes.
const DESK_TAB='agent-desk-desk',DESK_LAST='agent-desk-last-desk',DESK_LIST='agent-desk-desks';
// The last list seen, so a tab on another desk does not open on the first one and then jump.
let desks=(()=>{try{const saved=JSON.parse(localStorage.getItem(DESK_LIST)||'null');if(Array.isArray(saved)&&saved.length&&saved.every(d=>typeof d?.id==='string'&&typeof d.name==='string'))return saved;}catch{}return [{id:'main',name:'Main'}];})();
let activeDeskId=(()=>{try{return sessionStorage.getItem(DESK_TAB)||localStorage.getItem(DESK_LAST)||'main';}catch{return 'main';}})();
let deskEditing=null;
function activeDesk(){return desks.find(d=>d.id===activeDeskId)||desks[0];}
const firstOpenDesk=()=>desks.find(d=>!d.saved_at)||desks[0];
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
  // The desk this tab showed was deleted, or saved and closed, in another tab, so show an open desk.
  if(!desks.some(d=>d.id===activeDeskId&&!d.saved_at)){activeDeskId=firstOpenDesk().id;rememberDesk();}
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
  save:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11L8 11l-3.5 2.5z"/></svg>',
  rename:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5l2 2L6 12l-2.6.6L4 10z"/></svg>',
  remove:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 5h9M6.5 5V3.5h3V5M5 5l.6 7.5h4.8L11 5"/></svg>',
  plus:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  restore:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 6.5h5.5a3 3 0 0 1 0 6H6M4 6.5 6.5 4M4 6.5 6.5 9"/></svg>'
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
    if(desk.saved_at&&deskEditing?.id!==desk.id)return `<div class="desk-option saved"><button type="button" role="menuitem" data-desk-reopen="${escapeHTML(desk.id)}" title="Saved ${escapeHTML(deskSince(desk.saved_at))} · reopen it with its conversations resumed">${deskMark(desk)}<span class="desk-option-name">${escapeHTML(desk.name)}</span><span class="desk-option-saved">Saved</span></button>`+
      `<span class="desk-option-actions"><button type="button" class="desk-option-action" data-desk-rename="${escapeHTML(desk.id)}" title="Rename ${escapeHTML(desk.name)}" aria-label="Rename ${escapeHTML(desk.name)}">${deskIcons.rename}</button><button type="button" class="desk-option-action danger" data-desk-delete="${escapeHTML(desk.id)}" title="Delete ${escapeHTML(desk.name)}" aria-label="Delete ${escapeHTML(desk.name)}">${deskIcons.remove}</button></span></div>`;
    if(deskEditing?.id===desk.id)return `<div class="desk-option editing">${deskMark(desk)}<input class="desk-name-input" data-desk-rename-input="${escapeHTML(desk.id)}" value="${escapeHTML(desk.name)}" maxlength="40" spellcheck="false" aria-label="Desk name"></div>`;
    return `<div class="desk-option${current?' current':''}"><button type="button" role="menuitemradio" aria-checked="${current}" data-desk-id="${escapeHTML(desk.id)}">${deskMark(desk)}<span class="desk-option-name">${escapeHTML(desk.name)}</span>${count.waiting?`<span class="desk-option-waiting" title="${count.waiting} need${count.waiting===1?'s':''} you">${attentionGlyph}${count.waiting}</span>`:''}<span class="desk-option-count" title="${count.agents} session${count.agents===1?'':'s'}">${count.agents}</span><span class="desk-option-check">${current?deskIcons.check:''}</span></button>`+
      `<span class="desk-option-actions"><button type="button" class="desk-option-action" data-desk-rename="${escapeHTML(desk.id)}" title="Rename ${escapeHTML(desk.name)}" aria-label="Rename ${escapeHTML(desk.name)}">${deskIcons.rename}</button>`+
      (only?'':`<button type="button" class="desk-option-action danger" data-desk-delete="${escapeHTML(desk.id)}" title="Delete ${escapeHTML(desk.name)}" aria-label="Delete ${escapeHTML(desk.name)}">${deskIcons.remove}</button>`)+`</span></div>`;
  }).join('');
  const create=deskEditing?.id==='new'
    ?`<form class="desk-new-form">${deskIcons.plus}<input class="desk-name-input" data-desk-new-input maxlength="40" spellcheck="false" placeholder="Name, e.g. Research" aria-label="New desk name"><button type="submit" class="desk-new-save">Create</button></form>`
    :`<button type="button" role="menuitem" class="desk-new" data-desk-new>${deskIcons.plus}<span>New desk</span></button>`;
  const open=desks.filter(d=>!d.saved_at).length,plan=shutdownPlan(),nothing=!plan.stop.length&&!plan.close.length&&!openPaneIds.length;
  const save=`<button type="button" role="menuitem" class="desk-new" data-desk-save${open<2||nothing?` disabled title="${open<2?'Open another desk first: the last open desk cannot be saved and closed':'Nothing on this desk to save'}"`:''}>${deskIcons.save}<span>Save &amp; close desk</span></button>`;
  menu.innerHTML=`<div class="desk-menu-heading">Desks</div><div class="desk-options" role="group" aria-label="Desks">${rows}</div><div class="desk-menu-divider" role="separator"></div>${create}${save}<p class="desk-menu-error" role="alert" hidden></p>`;
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
// The context-menu entry for moving a session (or a folder of them): one Move to desk item whose
// submenu lists the other desks, then a new desk named in place, so the move never leaves the menu.
function deskMoveItems(ids,label){return [['Move to desk',null,false,sub=>fillDeskMoveMenu(sub,ids,label)]];}
function fillDeskMoveMenu(sub,ids,label){
  const others=desks.filter(d=>d.id!==activeDesk().id&&!d.saved_at);
  sub.innerHTML=others.map(desk=>`<button type="button" role="menuitem" data-move-desk="${escapeHTML(desk.id)}">${deskMark(desk)}<span>${escapeHTML(desk.name)}</span></button>`).join('')
    +(others.length?'<div class="desk-menu-divider" role="separator"></div>':'')
    +`<button type="button" role="menuitem" data-move-new>${deskIcons.plus}<span>New desk…</span></button>`;
  sub.querySelectorAll('[data-move-desk]').forEach(button=>button.onclick=()=>{
    const desk=desks.find(d=>d.id===button.dataset.moveDesk);closeGroupMenu(false);if(desk)moveSessionsTo(ids,desk,label);});
  sub.querySelector('[data-move-new]').onclick=event=>{
    const form=document.createElement('form');form.className='desk-new-form';
    form.innerHTML=`${deskIcons.plus}<input class="desk-name-input" maxlength="40" spellcheck="false" placeholder="Name, e.g. Research" aria-label="New desk name"><button type="submit" class="desk-new-save">Create</button>`;
    event.currentTarget.replaceWith(form);const input=form.querySelector('input');input.focus();
    form.onsubmit=async submit=>{
      submit.preventDefault();const name=input.value.trim();if(!name){input.focus();return;}
      input.disabled=true;
      try{const desk=await terminalRequest('/api/desks/create',{name});desks=[...desks,desk];closeGroupMenu(false);moveSessionsTo(ids,desk,label);}
      catch(error){input.disabled=false;input.focus();toast('Could not create the desk: '+error.message);}
    };
  };
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
// Shutting down and saving use one dialog: saving stops the same sessions, but says what each one
// comes back as when the desk is reopened (from the server's restart records, as a restart would).
async function openShutdownDesk(save=false){
  const desk=activeDesk(),plan=shutdownPlan();
  if(!plan.stop.length&&!plan.close.length&&!plan.clear.length&&!(save&&openPaneIds.length))return;
  closeDeskMenu(false);
  let preview={};
  if(save){try{preview=Object.fromEntries((await terminalRequest('/api/desks/save-preview',{ids:plan.stop.map(a=>a.id)})).sessions.map(p=>[p.id,p]));}catch(error){toast('Could not check what this desk saves: '+error.message);return;}}
  const dialog=$('#shutdown-desk-dialog'),coordinators=new Set(plan.close.map(a=>a.id));
  shutdownState={desk:desk.id,plan,save,drop:new Set()};
  dialog.querySelector('.desk-shutdown-mark').innerHTML=deskMark(desk);
  // Saving reads top to bottom on one edge: what happens, the name it is kept under (with its mark), what comes back.
  dialog.classList.toggle('saving',save);
  dialog.querySelector('h2').textContent=save?'Save and close this desk':`Shut down the “${desk.name}” desk?`;
  const summary=shutdownSummary(plan);
  dialog.querySelector('.desk-save-name').hidden=!save;dialog.querySelector('#save-desk-name').value=desk.name;dialog.querySelector('.desk-save-mark').innerHTML=deskMark(desk);
  dialog.querySelector('.desk-shutdown-lede').textContent=save?'Everything on it stops. Reopen it from the desk menu to bring back its panes and resume each Claude and Codex conversation.':summary[0].toUpperCase()+summary.slice(1)+' on this desk only.';
  const savable=agent=>save&&(preview[agent.id]||plan.close.includes(agent)&&!agent.remote_node);
  const outcome=agent=>save&&shutdownState.drop.has(agent.id)?['Stops · not reopened','Left out: it stops and does not come back with the desk']
    :save&&preview[agent.id]?[preview[agent.id].resumes?'Saves · resumes':'Saves · starts fresh',preview[agent.id].detail]
    :save&&plan.close.includes(agent)&&!agent.remote_node?['Saves · reopens','Closed and saved; it reopens with the desk']
    // A coordinator's worker is not the desk's to keep: the coordinator saves it and resumes it itself.
    :save&&plan.stop.includes(agent)&&coordinators.has(agent.parent_id)?(lead=>['Saves · with coordinator',`${lead} keeps this conversation and can resume it once the desk reopens. Leave out ${lead} to leave this out too.`])(sessionTitle(plan.close.find(a=>a.id===agent.parent_id)))
    :save&&plan.stop.includes(agent)&&!coordinators.has(agent.parent_id)?['Stops · not reopened',agent.remote_node?'Remote sessions are not reopened':'Not in the restart records, so it cannot be started again']
    :plan.close.includes(agent)?['Closes · saved','The conversation is saved; reopen it from Coordinator sessions']
    :plan.stop.includes(agent)?(coordinators.has(agent.parent_id)?['Stops · saved','Saved so its coordinator can resume it']:['Stops','The command running in it is ended'])
    :plan.clear.includes(agent)?['Clears','Already finished; removed from the sidebar']:['Keeps running','Not started by Agent Desk, so it cannot be stopped from here'];
  // Leaving a session out takes its workers with it; a worker whose parent is left out has no choice.
  const parentDropped=agent=>shutdownState.drop.has(agent.parent_id),toggle=agent=>{if(!savable(agent)||parentDropped(agent))return save?'<span class="desk-shutdown-drop" aria-hidden="true"></span>':'';const left=shutdownState.drop.has(agent.id),label=`${left?'Save':'Don\'t save'} ${sessionTitle(agent)}`;
    return `<button type="button" class="desk-option-action desk-shutdown-drop${left?'':' danger'}" data-shutdown-drop="${escapeHTML(agent.id)}" title="${left?'Save it after all':'Don\'t save'}" aria-label="${escapeHTML(label)}">${left?deskIcons.restore:deskIcons.close}</button>`;};
  // Workers sit under the session that started them.
  const listed=[...plan.stop,...plan.close,...plan.clear,...plan.leave],inList=new Set(listed.map(a=>a.id)),depth=new Map(),ordered=[];
  const place=(agent,level)=>{ordered.push(agent);depth.set(agent.id,level);for(const child of listed)if(child.parent_id===agent.id&&!depth.has(child.id))place(child,level+1);};
  for(const agent of listed)if(!inList.has(agent.parent_id))place(agent,0);
  for(const agent of listed)if(!depth.has(agent.id))place(agent,0);
  const row=agent=>{const [label,detail]=outcome(agent),level=depth.get(agent.id);
    return `<li data-shutdown-id="${escapeHTML(agent.id)}" class="${plan.leave.includes(agent)?'kept':label.startsWith('Saves')?'saved':''}${shutdownState.drop.has(agent.id)?' dropped':''}${level?' child':''}"${level?` style="--depth:${level}"`:''}><span class="session-avatar" style="--agent-color:${agentColor(agent.id)}">${({codex:'CX',claude:'CC',grok:'GX',opencode:'OC',pi:'PI',cortex:'CO'})[agent.harness]||'AI'}</span><span class="desk-shutdown-name"><strong>${escapeHTML(sessionTitle(agent))}</strong><small>${escapeHTML(agent.project||'')}${agent.cwd?' · '+escapeHTML(shortPath(agent.cwd)):''}</small></span><span class="desk-shutdown-outcome" title="${escapeHTML(detail)}">${escapeHTML(label)}</span>${toggle(agent)}</li>`;};
  const confirm=dialog.querySelector('#confirm-shutdown-desk'),kept=[...plan.stop,...plan.close].filter(savable);
  shutdownState.render=()=>{
    dialog.querySelector('.desk-shutdown-list').innerHTML=ordered.map(row).join('');
    const dropped=kept.filter(a=>shutdownState.drop.has(a.id)).length;
    confirm.textContent=save?(dropped?`Save ${kept.length-dropped} of ${kept.length} & close`:'Save & close'):`Shut down ${desk.name}`;
  };
  shutdownState.descendants=id=>[...plan.stop,...plan.close].filter(a=>a.parent_id===id).flatMap(a=>[a.id,...shutdownState.descendants(a.id)]);
  shutdownState.render();
  const counts=deskCounts(),others=desks.filter(d=>d.id!==desk.id&&counts.get(d.id).agents).map(d=>`<span class="desk-shutdown-other">${deskMark(d)}${escapeHTML(d.name)} · ${plural(counts.get(d.id).agents,'session')}</span>`);
  const othersNote=dialog.querySelector('.desk-shutdown-others');
  othersNote.innerHTML=others.length?'<span>Other desks keep running:</span>'+others.join(''):'';othersNote.hidden=!others.length;
  dialog.querySelector('[role=alert]').textContent='';
  confirm.hidden=false;confirm.disabled=false;
  confirm.classList.toggle('danger',!save);confirm.classList.toggle('primary',save);
  dialog.querySelector('.close-dialog').textContent='Cancel';
  dialog.showModal();
}
// This tab's panes for the desk, which the server keeps with a saved desk.
// Panes left out are dropped, and so are the sizes, which would leave their space empty.
function deskLayout(drop=new Set()){
  const ids=openPaneIds.filter(id=>!drop.has(id)),rects=paneRects&&ids.length===openPaneIds.length?resolvePaneRects(ids):{};
  return {layout:paneLayoutId,panes:ids.map(id=>({id,...(rects[id]?{rect:rects[id]}:{})})),pages:openPaneIds.filter(id=>webPages.has(id)).map(id=>{const {url,name}=webPages.get(id);return {id,url,name:name||''};})};
}
async function shutdownDesk(){
  const dialog=$('#shutdown-desk-dialog'),confirm=dialog.querySelector('#confirm-shutdown-desk'),{desk,plan,save}=shutdownState;
  let name=desks.find(d=>d.id===desk)?.name||'desk';
  confirm.disabled=true;confirm.textContent=save?'Saving…':'Shutting down…';
  try{
    // Exactly the sessions listed above; the server stops none that has since left this desk.
    const result=await terminalRequest(save?'/api/desks/save':'/api/desks/shutdown',{id:desk,ids:[...plan.stop,...plan.close].map(a=>a.id),...(save?{layout:deskLayout(shutdownState.drop),drop:[...shutdownState.drop],name:dialog.querySelector('#save-desk-name').value}:{})});
    for(const id of result.stopped)dismissTerminal(id);
    for(const agent of plan.clear)dismissTerminal(agent.id);
    for(const id of result.closed)closePane(id);
    if(save){
      name=result.desks.find(d=>d.id===desk)?.name||name;
      // The server has the desk's panes now; this tab forgets them and moves to an open desk.
      for(const id of openPaneIds)forgetWebPage(id);
      openPaneIds=[];paneRects=null;savePanes();savePaneRects();setDesks(result.desks);
    }
    await refresh();
    const done=[result.stopped.length&&`stopped ${plural(result.stopped.length,'terminal')}`,result.closed.length&&`closed ${plural(result.closed.length,'coordinator')}`].filter(Boolean).join(' and ')||'nothing was running';
    if(!result.failed.length){dialog.close();toast(save?`Saved “${name}” · reopen it from the desk menu`:`${name} shut down: ${done}`);return;}
    // Say which ones are still running and why; the rest already stopped.
    for(const failure of result.failed){
      const item=dialog.querySelector(`[data-shutdown-id="${CSS.escape(failure.id)}"]`);
      item?.classList.add('failed');const tag=item?.querySelector('.desk-shutdown-outcome');if(tag){tag.textContent='Still running';tag.title=failure.error;}
    }
    const rest=result.stopped.length||result.closed.length?` Otherwise ${done}.`:'';
    dialog.querySelector('[role=alert]').textContent=`${plural(result.failed.length,'session')} could not be stopped: ${result.failed.map(f=>f.error).join(' · ')}${rest}`;
    dialog.querySelector('h2').textContent=save?`“${name}” is saved, but not everything stopped`:`“${name}” is not fully shut down`;
    confirm.hidden=true;dialog.querySelector('.close-dialog').textContent='Close';
    for(const button of dialog.querySelectorAll('[data-shutdown-drop]'))button.remove();
  }catch(error){dialog.querySelector('[role=alert]').textContent=error.message;confirm.disabled=false;shutdownState.render();}
}
// Reopens a saved desk: the server starts its terminals as a restart would (each with a new ID) and
// reopens its coordinators, and this tab puts them back in the panes and sizes they had.
async function reopenDesk(id){
  const desk=desks.find(d=>d.id===id);if(!desk)return;
  closeDeskMenu(false);toast(`Reopening “${desk.name}”…`);
  let result;
  try{result=await terminalRequest('/api/desks/reopen',{id});}catch(error){toast(`Could not reopen “${desk.name}”: ${error.message}`);return;}
  setDesks(result.desks);switchDesk(id,{quiet:true,render:false});
  const moved=Object.fromEntries(result.results.filter(r=>r.new_id).map(r=>[r.id,r.new_id])),layout=result.layout||{layout:paneLayoutId,panes:[],pages:[]};
  for(const page of layout.pages)webPages.set(page.id,page);
  saveWebPages();
  for(const started of Object.values(moved))freshTerminalIds.add(started);
  const kept=layout.panes.filter(p=>moved[p.id]||webPages.has(p.id)).slice(0,PANE_LIMIT),paneId=p=>moved[p.id]||p.id;
  demo=false;paneMode=paneStoreKey();paneInitialized=true;openPaneIds=kept.map(paneId);selectedId=openPaneIds[0]||null;
  paneLayoutId=paneLayout(layout.layout).id;try{localStorage.setItem(deskScoped('agent-desk-pane-layout'),paneLayoutId);}catch{}
  paneRects=kept.some(p=>p.rect)?Object.fromEntries(kept.filter(p=>p.rect).map(p=>[paneId(p),p.rect])):null;
  savePaneRects();savePanes();switchPage('agents');await refresh();render();
  const failed=result.results.filter(r=>r.error),resumed=result.results.filter(r=>r.resumed).length,fresh=result.results.length-failed.length-resumed;
  if(!failed.length){toast(`Reopened “${desk.name}”`+(result.results.length?` · ${[resumed&&`${resumed} resumed`,fresh&&`${fresh} started fresh`].filter(Boolean).join(', ')}`:''));return;}
  // Say which sessions did not come back and why; the rest are already open.
  const dialog=$('#shutdown-desk-dialog');
  dialog.classList.remove('saving');dialog.querySelector('.desk-save-name').hidden=true;
  dialog.querySelector('.desk-shutdown-mark').innerHTML=deskMark(desk);
  dialog.querySelector('h2').textContent=`“${desk.name}” reopened with ${result.results.length-failed.length} of ${plural(result.results.length,'session')}`;
  dialog.querySelector('.desk-shutdown-lede').textContent='The rest are open on the desk.';
  dialog.querySelector('.desk-shutdown-list').innerHTML=failed.map(r=>`<li class="failed"><span class="session-avatar" style="--agent-color:${agentColor(r.id)}">AI</span><span class="desk-shutdown-name"><strong>${escapeHTML(r.name)}</strong><small>${escapeHTML(r.error)}</small></span><span class="desk-shutdown-outcome">Not reopened</span></li>`).join('');
  dialog.querySelector('.desk-shutdown-others').hidden=true;dialog.querySelector('[role=alert]').textContent='';
  dialog.querySelector('#confirm-shutdown-desk').hidden=true;dialog.querySelector('.close-dialog').textContent='Close';
  dialog.showModal();
}
function confirmDeleteDesk(id){
  const desk=desks.find(d=>d.id===id);if(!desk||desks.length<2)return;
  closeDeskMenu(false);
  const dialog=$('#delete-desk-dialog'),count=deskCounts().get(id).agents,others=desks.filter(d=>d.id!==id);
  const fallback=others.find(d=>d.id===activeDesk().id)||others[0];
  dialog.querySelector('h2').textContent=`Delete the “${desk.name}” desk?`;
  dialog.querySelector('.desk-delete-detail').textContent=desk.saved_at?'It is saved and closed. Its sessions will not be reopened; their conversations stay in each agent\'s own history.':count?`Its ${count} session${count===1?'':'s'} keep running and move to the desk you choose.`:'It has no sessions. Nothing else changes.';
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
    const pick=event.target.closest('[data-desk-id]'),rename=event.target.closest('[data-desk-rename]'),remove=event.target.closest('[data-desk-delete]'),reopen=event.target.closest('[data-desk-reopen]');
    if(pick){switchDesk(pick.dataset.deskId);$('#desk-button').focus();}
    else if(reopen)reopenDesk(reopen.dataset.deskReopen);
    else if(event.target.closest('[data-desk-save]'))openShutdownDesk(true);
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
      const items=[...menu.querySelectorAll('[data-desk-id],[data-desk-reopen],[data-desk-new],[data-desk-save]:not(:disabled)')],index=items.indexOf(document.activeElement);
      event.preventDefault();items[(index+(event.key==='ArrowDown'?1:items.length-1))%items.length]?.focus();
    }else if(event.key==='Tab'&&!event.target.closest('.desk-new-form'))closeDeskMenu(false);
  });
  document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.target.closest('#desk-switcher'))closeDeskMenu(false);},true);
  $('#desk-shutdown').onclick=()=>openShutdownDesk();
  $('#confirm-shutdown-desk').onclick=shutdownDesk;
  $('#save-desk-name').oninput=event=>{const desk=desks.find(d=>d.id===shutdownState?.desk);if(desk)$('#shutdown-desk-dialog .desk-save-mark').innerHTML=deskMark({...desk,name:event.target.value.trim()||desk.name});};
  $('#save-desk-name').onkeydown=event=>{if(event.key==='Enter'){event.preventDefault();$('#confirm-shutdown-desk').click();}};
  $('#shutdown-desk-dialog .desk-shutdown-list').onclick=event=>{
    const button=event.target.closest('[data-shutdown-drop]');if(!button||!shutdownState)return;
    const id=button.dataset.shutdownDrop,ids=[id,...shutdownState.descendants(id)],drop=!shutdownState.drop.has(id);
    for(const item of ids)drop?shutdownState.drop.add(item):shutdownState.drop.delete(item);
    shutdownState.render();$(`#shutdown-desk-dialog [data-shutdown-drop="${CSS.escape(id)}"]`)?.focus();
  };
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
