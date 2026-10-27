const $ = (s) => document.querySelector(s);
const escapeHTML = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels = {working:'Working',needs_input:'Needs you',idle:'Idle',completed:'Completed',ready_for_review:'Ready for review',error:'Error',unknown:'Unknown',output:'Output active',quiet:'Quiet'};
let agents = [], agentsLoaded = false, demo = false, filter = 'all', annotating = false, pending = null, selectedId = null;
const demoAgents = [
  ['frontend','Interface polish','claude','needs_input','Refine the agent dashboard and interaction states','agent-desk','Should the sidebar stay expanded on smaller screens?'],
  ['adapters','Harness adapters','codex','working','Normalize session events across agent harnesses','agent-desk'],
  ['tests','Integration tests','codex','working','Verify reconnect behavior and status transitions','agent-desk'],
  ['research','Research assistant','grok','idle','Compare approaches to local session discovery','research'],
  ['feedback','Feedback capture','claude','completed','Add element targeting and coordinate exports','agent-desk'],
  ['worker','Background worker','codex','error','Investigate a failed workspace connection','tools']
].map(([id,name,harness,status,task,project,question]) => ({id,name,harness,status,task,project,question,source:'demo',updated:Date.now()/1000,events:[{time:Date.now()/1000,message:status==='error'?'Example error: workspace connection closed.':'Example session event. This is demonstration data.'}]}));
let showFinishedSubagents=false;
// Every listed agent on every desk; current() is the ones on the desk this tab shows.
const everyAgent = () => demo ? demoAgents : agents.filter(a=>a.source!=='discovered'&&!dismissedTerminals.has(a.id)&&(showFinishedSubagents||!a.harness_internal||!(a.archived||a.status==='completed'||!agents.some(parent=>parent.id===a.parent_id&&parent.exit_code===null)))).map(withTerminalActivity).map(withWorkerCompletion);
const current = () => everyAgent().filter(onActiveDesk);
const shortPath = value => (value || '').replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
// A session's color comes from where it runs: its project picks one of twelve hue bands and its own id
// nudges hue and lightness inside that band, so panes in one repo read as a family without being identical.
// Worktrees under <repo>/.<tool>/worktrees/ belong to their parent repo's family.
const colorHash=text=>{let h=0x811c9dc5;for(const char of String(text))h=Math.imul(h^char.charCodeAt(0),0x01000193);h=Math.imul(h^h>>>16,0x85ebca6b);h=Math.imul(h^h>>>13,0xc2b2ae35);return (h^h>>>16)>>>0;};
const colorProject=agent=>(agent.repo||agent.cwd||agent.project||'').replace(/\/\.[^/]+\/worktrees\/.*$/,'');
function agentColor(agent){
  const own=colorHash(agent.id),hue=colorHash(colorProject(agent)||agent.id)%12*30+(own%21-10),lightness=0.74+((own>>>8)%5-2)*0.015;
  return `oklch(${lightness.toFixed(3)} 0.095 ${hue})`;
}
const relative = (t) => {if(!t)return 'Discovered';const s=Math.max(0,Math.floor(Date.now()/1000-t));return s<60?'Updated just now':`Updated ${Math.floor(s/60)}m ago`;};
// Shared compact age for lists that show when something last happened.
const deskSince = (t) => {
  if(!t)return '';
  const minutes=Math.round((Date.now()/1000-t)/60);
  if(minutes<1)return 'just now';
  if(minutes<60)return minutes+'m ago';
  if(minutes<1440)return Math.round(minutes/60)+'h ago';
  return Math.round(minutes/1440)+'d ago';
};
function toast(message){$('#toast').textContent=message;$('#toast').classList.remove('hidden');clearTimeout(toast.timer);toast.timer=setTimeout(()=>$('#toast').classList.add('hidden'),3500);}
const statusFilters=[['all','All sessions'],['needs_input','Needs you'],['working','Active'],['idle','Quiet'],['completed','Done'],['error','Errors'],['unknown','Unknown']];
function matchesStatus(a,value){return value==='all'||a.status===value||(value==='completed'&&a.status==='ready_for_review')||(value==='working'&&a.status==='output')||(value==='idle'&&a.status==='quiet');}
function setFilter(value){filter=value;const menu=$('#status-menu');const wasOpen=menu.open;menu.open=false;render();if(wasOpen)menu.querySelector('summary').focus();}
function sessionTitle(agent){
  return (agent.display_name||((agent.harness_internal||agent.coordinator_workspace)&&agent.name)||agent.terminal_title||agent.controller_goal||(agent.task&&!/^(Interactive terminal|Untitled task|Task unavailable)/.test(agent.task)&&agent.task)||agent.name||'Session').replace(/^[◐◑◒◓✳✶✻✽✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u,'');
}
// A session that needs you shows a clear glyph, not just a small colored dot. The slot is
// rendered on every row and only revealed in an attention state, so the glyph appearing or
// clearing cannot move the row.
const attentionGlyph='<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M7.13 2.16a1 1 0 0 1 1.74 0l5.44 9.79a1 1 0 0 1-.87 1.49H2.56a1 1 0 0 1-.87-1.49Z"/><path d="M8 6.15v3.1"/><path d="M8 11.4h.01"/></svg>';
function attentionBadge(agent){
  if(agent.status!=='needs_input')return `<span class="needs-reply" data-attention="false" aria-hidden="true">${attentionGlyph}</span>`;
  return `<span class="needs-reply" data-attention="true" role="img" aria-label="Needs you" title="${escapeHTML(agent.question||'This session is waiting on you')}">${attentionGlyph}</span>`;
}
function render(){
  if(draggingSession||draggingGroup||renamingGroup)return;
  const all=orderedSessions(current()),team=coordinatorTeam(all);
  $('#show-finished-subagents').setAttribute('aria-checked',String(showFinishedSubagents));
  // An agent on another desk that needs you still raises the alert.
  renderAttention(everyAgent());
  renderDeskSwitcher();
  window.renderAgentMap?.();
  const focused=document.activeElement;
  const focusKey=focused?.closest('#agent-grid, #filters')?['data-filter','data-agent-id','data-group-toggle','data-add-pane','data-close-terminal'].find(key=>focused.hasAttribute(key)):null;
  const focusValue=focusKey?focused.getAttribute(focusKey):null;
  const listScroll={top:$('#agent-grid').scrollTop,left:$('#agent-grid').scrollLeft};
  $('#mode-title').textContent=demo?'Demo':'Live';
  $('#mode-title').classList.toggle('demo-badge',demo);
  if($('#toggle-demo'))$('#toggle-demo').textContent=demo?'Return to live':'Explore demo';
  $('#stats').innerHTML=[['all','agents',all.length],['needs_input','need you',all.filter(a=>a.status==='needs_input').length],['working','active',all.filter(a=>matchesStatus(a,'working')).length]].map(([f,label,n])=>`<button class="header-stat ${f}" data-stat="${f}" aria-label="${n} ${label}"><b>${n}</b> ${label}</button>`).join('');
  document.querySelectorAll('[data-stat]').forEach(b=>b.onclick=()=>setFilter(b.dataset.stat));

  const activeFilters=(filter!=='all')+showFinishedSubagents,badge=$('#filter-badge');badge.hidden=!activeFilters;badge.textContent=activeFilters||'';
  $('#status-menu summary').setAttribute('aria-label',activeFilters?`Filter sessions · ${activeFilters} on`:'Filter sessions');
  $('#filters').innerHTML=statusFilters.map(([value,label])=>`<button type="button" data-filter="${value}" class="${filter===value?'selected':''}" aria-pressed="${filter===value}">${label}<span>${all.filter(a=>matchesStatus(a,value)).length}</span></button>`).join('');
  document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>setFilter(button.dataset.filter));
  const query=$('#search').value.toLowerCase();
  const visible=all.filter(a=>matchesStatus(a,filter)&&[a.display_name,a.name,a.task,a.terminal_title,a.harness,a.project,a.cwd,a.repo].join(' ').toLowerCase().includes(query));
  $('#agent-count').textContent=visible.length===all.length?all.length:`${visible.length} of ${all.length}`;
  $('#agent-grid').innerHTML=visible.length?sessionListHTML(visible,a=>`<div class="session-entry ${a.harness_internal?'internal-session':''} ${a.controller?'controller-session':''} ${team.has(a.id)?'coordinator-team':''} ${a.terminal_id||a.coordinator_workspace?'managed-session':''}"><button draggable="${!a.harness_internal}" title="Drag to reorder · drop onto another session to group them · Alt+↑/↓ to move with keyboard" class="session-row ${selectedId===a.id?'selected':''} ${openPaneIds.includes(a.id)?'pane-open':''}" data-agent-id="${escapeHTML(a.id)}" data-harness="${escapeHTML(a.harness)}" style="--agent-color:${agentColor(a)}" aria-pressed="${selectedId===a.id}"><span class="session-avatar" title="${escapeHTML(a.activity_description||labels[a.status])}">${({codex:'CX',claude:'CC',grok:'GX',opencode:'OC',pi:'PI',cortex:'CO'})[a.harness]||'AI'}<span class="session-status ${escapeHTML(a.status)}">${a.status==='ready_for_review'?'✓':''}</span></span><span class="session-text"><span class="session-heading" title="${escapeHTML(a.project+' / '+sessionTitle(a))}"><strong>${escapeHTML(a.project)}</strong><span class="session-heading-divider" aria-hidden="true">/</span><span class="session-name">${escapeHTML(sessionTitle(a))}</span></span><small class="session-folder" title="${escapeHTML(a.cwd||a.project)}">${a.harness_internal?'↳ '+escapeHTML(sessionTitle(agents.find(parent=>parent.id===a.parent_id)||{name:'Previous session · '+a.parent_id})):escapeHTML(shortPath(a.cwd||a.project))}</small><span>${escapeHTML(a.launch_label||a.harness)}${a.pid?' #'+escapeHTML(a.pid):''} · ${escapeHTML(labels[a.status])}<span class="session-team-label">${team.has(a.id)&&a.id!==coordinatorFocusId?' · Coordinated':''}</span></span>${attentionBadge(a)}</span></button><button class="session-add" data-add-pane="${escapeHTML(a.id)}" title="Add terminal pane" aria-label="Add ${escapeHTML(a.name)} as another pane"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg></button>${a.coordinator_workspace?`<button class="session-remove" data-close-coordinator="${escapeHTML(a.id)}" title="Close and save coordinator" aria-label="Close ${escapeHTML(a.name)} coordinator">×</button>`:''}${a.terminal_id?`<button class="session-remove" data-close-terminal="${escapeHTML(a.id)}" title="Close terminal${a.exit_code===null?' (stops its command)':''}" aria-label="Close ${escapeHTML(a.name)} terminal"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>`:''}</div>`):`<div class="empty"><p>${all.length?'No matching sessions.':'No sessions detected.'}</p><button class="button" id="empty-action">${all.length?'Reset filters':'New terminal'}</button></div>`;
  if(!all.some(a=>a.id===selectedId)&&!webPages.has(selectedId)) selectedId=visible[0]?.id||all[0]?.id||null;
  $('#agent-grid').scrollTop=listScroll.top;
  $('#agent-grid').scrollLeft=listScroll.left;
  renderTerminal();
  document.querySelectorAll('.session-row').forEach(b=>b.onclick=event=>selectPane(b.dataset.agentId,event.metaKey||event.ctrlKey||event.shiftKey));
  document.querySelectorAll('[data-add-pane]').forEach(b=>b.onclick=()=>selectPane(b.dataset.addPane,true));
  document.querySelectorAll('[data-close-coordinator]').forEach(b=>b.onclick=()=>window.closeCoordinator(b.dataset.closeCoordinator));
  document.querySelectorAll('[data-close-terminal]').forEach(b=>b.onclick=()=>requestCloseTerminal(b.dataset.closeTerminal));
  if(focusKey)document.querySelector(`[${focusKey}="${CSS.escape(focusValue)}"]`)?.focus({preventScroll:true});
  requestAnimationFrame(() => { if (typeof renderPins === 'function') renderPins(); });
  if($('#empty-action'))$('#empty-action').onclick=()=>{if(all.length){filter='all';$('#search').value='';}else openTerminalLauncher();render();};
}
function openDetails(id){selectedId=id;renderDetails();$('#details').showModal();}
function renderDetails(){const a=current().find(a=>a.id===selectedId);if(!a)return;$('#detail-content').innerHTML=`<div class="eyebrow">${escapeHTML(a.harness)} / ${escapeHTML(a.source)}</div><h2>${escapeHTML(a.name)}</h2><span class="status ${escapeHTML(a.status)}">${escapeHTML(labels[a.status])}</span><p>${escapeHTML(a.task)}</p><p class="muted">${escapeHTML(a.project)}${a.pid?' · PID '+escapeHTML(a.pid):''} · ${relative(a.updated)}</p>${a.question?'<div class="question"><strong>Waiting for your answer</strong><p>'+escapeHTML(a.question)+'</p><small>Reply in the original harness. Responses from this app are not connected yet.</small></div>':''}<h3>Activity</h3>${a.events.length?a.events.slice().reverse().map(e=>`<div class="event"><small>${new Date(e.time*1000).toLocaleTimeString()}</small>${escapeHTML(e.message)}</div>`).join(''):'<p class="muted">No adapter events yet. A detected process doesn’t reveal its task or whether it needs input.</p>'}`;}
async function refresh(){try{const r=await fetch('/api/agents');if(!r.ok)throw Error();const data=await r.json();setDesks(data.desks);agents=stampReadouts(data.agents);agentsLoaded=true;$('#sync-status').textContent='● Connected';$('#sync-status').classList.remove('error-banner');$('#sync-status').classList.add('connected');if(!annotating&&!window.annotationNoteOpen?.())render();if($('#details').open)renderDetails();}catch{$('#sync-status').textContent='Connection lost · showing last update';$('#sync-status').classList.add('error-banner');$('#sync-status').classList.remove('connected');}}
// Header controls keep their order when switching pages. One declared header order, in
// the same order as .top-actions in index.html, applied on every page switch. Sessions is a destination like the others and
// is the active chip on the Agents page, so the cluster is one width everywhere without an
// invisible reserved slot opening a hole beside it.
const headerDestinations={'open-sessions':'agents','open-special-agents':'special-agents','open-inbox':'inbox','open-workflows':'workflows','open-skills':'skills','open-settings':'settings'};
// The destinations are one segmented control and a single
// neutral thumb slides to the current one. It is measured from the active button, so it
// follows label, badge and wrap changes; with no destination active it is hidden.
function placeHeaderThumb(){
  const nav=$('#header-nav'),thumb=nav?.querySelector('.header-nav-thumb');if(!thumb)return;
  const on=nav.querySelector('.button.active');
  thumb.hidden=!on;if(!on)return;
  thumb.style.width=on.offsetWidth+'px';thumb.style.height=on.offsetHeight+'px';
  thumb.style.transform=`translate(${on.offsetLeft}px,${on.offsetTop}px)`;
}
function switchPage(page){
  if(page!=='coordinator'&&new URLSearchParams(location.search).get('view')==='coordinator')history.replaceState({},'',location.pathname);
  if(page==='feedback'&&!window.AGENT_DESK_CONFIG.development)return;
  document.body.classList.toggle('feedback-open',page==='feedback');
  document.body.classList.toggle('skills-open',page==='skills');
  ['agents','feedback','skills','special-agents','inbox','workflows','settings'].forEach(name=>$('#'+name+'-page').classList.toggle('hidden',name!==page));
  if($('#dev-menu'))$('#dev-menu').open=false;
  $('#breadcrumb').textContent=page==='coordinator'?'Coordinator':page==='workflows'?'Run & Schedule':page==='inbox'?'Inbox':page==='special-agents'?'Automations':page==='agents'?'Agents':page==='skills'?'Skills':page==='settings'?'Settings':'Feedback';
  for(const [id,owner] of Object.entries(headerDestinations))$('#'+id).classList.toggle('active',page===owner);
  placeHeaderThumb();
  if(page==='feedback')renderFeedback();
  requestAnimationFrame(()=>{if(typeof renderPins==='function')renderPins();});
}

document.querySelectorAll('.close-dialog').forEach(b=>b.onclick=()=>b.closest('dialog').close());

$('#search').oninput=render;
document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>setFilter(b.dataset.filter));
render();refresh();setInterval(refresh,4000);
placeHeaderThumb();
// Only animate after the first placement, so the thumb never slides in from the corner.
requestAnimationFrame(()=>$('#header-nav')?.classList.add('ready'));
// A resize is not a page change: place the thumb instantly instead of sliding it across,
// which also stops it sitting at its old, wider position for the length of the slide.
if(window.ResizeObserver&&$('#header-nav'))new ResizeObserver(()=>{const nav=$('#header-nav'),ready=nav.classList.contains('ready');
  nav.classList.remove('ready');placeHeaderThumb();void nav.offsetWidth;if(ready)nav.classList.add('ready');}).observe($('#header-nav'));
document.fonts?.ready.then(placeHeaderThumb);


if(!window.AGENT_DESK_CONFIG.development) document.querySelectorAll('.dev-only').forEach(el=>el.remove());

document.addEventListener('click',event=>{if(!event.target.closest('#status-menu'))$('#status-menu').open=false;});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&$('#status-menu').open){$('#status-menu').open=false;$('#status-menu summary').focus();}});

$('#show-finished-subagents').onclick=()=>{showFinishedSubagents=!showFinishedSubagents;render();};

// Full screen for the whole app. The browser owns the state, so the control follows it rather than
// tracking its own: leaving with Escape or the browser's own shortcut still updates the button.
const fullscreenButton=$('#app-fullscreen');
if(!document.documentElement.requestFullscreen)fullscreenButton.hidden=true;
else{
  fullscreenButton.onclick=async()=>{
    try{
      if(document.fullscreenElement)await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({navigationUI:'hide'});
    }catch(error){toast('Your browser would not switch to full screen: '+error.message);}
  };
  document.addEventListener('fullscreenchange',()=>{
    const on=!!document.fullscreenElement;
    document.body.classList.toggle('app-fullscreen',on);
    fullscreenButton.setAttribute('aria-pressed',String(on));
    fullscreenButton.title=on?'Leave full screen':'Put Agent Desk in full screen';
    fullscreenButton.setAttribute('aria-label',on?'Leave full screen':'Full screen');
  });
}
