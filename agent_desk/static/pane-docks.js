// A pane's dock sits beside or below its terminal and switches between the pane's text editor, a
// review of its changes and any tool its agent opened, so the conversation and its result share
// one pane. A tool with no owner on the desk opens as a web pane instead (skill-uis.js).
const paneDocks=new Map((()=>{try{return Object.entries(JSON.parse(sessionStorage.getItem('agent-desk-pane-docks')||'{}'));}catch{return [];}})());
function savePaneDocks(){try{sessionStorage.setItem('agent-desk-pane-docks',JSON.stringify(Object.fromEntries(paneDocks)));}catch{}}
const dockIcons={
  tool:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/></svg>',
  right:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M9 3v10"/></svg>',
  bottom:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 9h12"/></svg>',
  library:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
  expand:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9"/></svg>',
  shrink:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5 14 2M6.5 9.5 2 14"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
};
// The rail's icons. A plugin names one of these in its manifest; the desk draws it.
const railIcons={
  code:'<path d="M5.6 4.6 2.4 8l3.2 3.4M10.4 4.6 13.6 8l-3.2 3.4"/>',
  folder:'<path d="M2.2 4.6c0-.7.5-1.2 1.2-1.2h2.7l1.5 1.5h5c.7 0 1.2.5 1.2 1.2v5.4c0 .7-.5 1.2-1.2 1.2H3.4c-.7 0-1.2-.5-1.2-1.2Z"/>',
  review:'<path d="M3 3h10c.6 0 1 .4 1 1v6c0 .6-.4 1-1 1H7.5L4.5 13.5V11H3c-.6 0-1-.4-1-1V4c0-.6.4-1 1-1Z"/><path d="m6 7 1.4 1.4L10.2 5.6"/>',
  puzzle:'<path d="M6.5 2.5h3v2a1.2 1.2 0 1 0 2.4 0v-.5h1.6v3h-1a1.2 1.2 0 1 0 0 2.4h1v4h-4v-1a1.2 1.2 0 1 0-2.4 0v1h-4v-4h1a1.2 1.2 0 1 0 0-2.4h-1v-3h3.4Z"/>',
  chart:'<path d="M2.5 13.5h11M4.5 11V8.5M8 11V4.5M11.5 11V6.5"/>',
  list:'<path d="M6 4.5h7.5M6 8h7.5M6 11.5h7.5M2.8 4.5h.01M2.8 8h.01M2.8 11.5h.01"/>',
  bug:'<rect x="5" y="5" width="6" height="8" rx="3"/><path d="M8 5V3.5M6 3l1 1.5M10 3 9 4.5M5 8.5H2.5M13.5 8.5H11M5.3 11.5 3 13M10.7 11.5 13 13M5.3 6 3 4.5M10.7 6 13 4.5"/>',
  book:'<path d="M3 3.5h4c.6 0 1 .4 1 1v9c0-.6-.4-1-1-1H3ZM13 3.5H9c-.6 0-1 .4-1 1v9c0-.6.4-1 1-1h4Z"/>',
  terminal:'<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.8 6.3 2 1.7-2 1.7M8.6 10h2.6"/>',
  globe:'<circle cx="8" cy="8" r="5.6"/><path d="M2.4 8h11.2M8 2.4c1.6 1.6 2.4 3.5 2.4 5.6S9.6 12 8 13.6C6.4 12 5.6 10.1 5.6 8S6.4 4 8 2.4Z"/>',
  check:'<circle cx="8" cy="8" r="5.6"/><path d="m5.6 8.2 1.6 1.6 3.2-3.4"/>',
  search:'<circle cx="7" cy="7" r="4.2"/><path d="m10.2 10.2 3.3 3.3"/>',
  tool:'<path d="M9.8 3.2a3 3 0 0 0 3 4.1L8 12.1a1.5 1.5 0 0 1-2.1-2.1l4.8-4.8a3 3 0 0 0-.9-2Z"/>'
};
const railIcon=item=>`<svg viewBox="0 0 16 16" aria-hidden="true">${railIcons[item.id==='@editor'?'code':item.id==='@review'?'review':item.plugin?item.plugin.icon:'tool']||railIcons.puzzle}</svg>`;
const DOCK_MIN=.2,DOCK_MAX=.8;
const ownedTools=id=>(typeof skillUIs==='undefined'?[]:skillUIs).filter(ui=>ui.agent_id===id&&ui.status!=='stopped');
const dockOwner=ui=>ui?.agent_id&&!demo?everyAgent().find(a=>a.id===ui.agent_id&&(a.terminal_id||a.coordinator_workspace)&&a.exit_code==null):null;
const editorPane=agent=>!!(agent?.terminal_id&&!agent.remote_node&&window.paneEditor);
// A pane's review is the one the desk started for it, or else a code review its agent opened.
const reviewTool=tools=>tools.find(ui=>ui.id.startsWith('pane-review-'))||tools.find(ui=>ui.skill==='code-review');
const reviewStarts=new Map();

function dockEntries(agent){
  const tools=agent.terminal_id||agent.coordinator_workspace?ownedTools(agent.id):[];
  if(!editorPane(agent))return tools.map(ui=>({id:ui.id,title:ui.title,ui}));
  const review=reviewTool(tools);
  // Editor and Review sit among the plugins by order (Editor 20, Review 40), so Files (10) comes first.
  const placed=[{id:'@editor',title:'Editor',order:20},{id:'@review',title:'Review',heading:'Code review',ui:review,order:40},...(typeof pluginEntries==='function'?pluginEntries().map(entry=>({...entry,order:entry.plugin.order})):[])];
  return [...placed.sort((a,b)=>a.order-b.order),...tools.filter(ui=>ui!==review).map(ui=>({id:ui.id,title:ui.title,ui}))];
}
// The tab a tool appears under in its owner's dock: the pane's review shows under Review.
function dockEntryId(ui,owner=dockOwner(ui)){return owner&&editorPane(owner)&&reviewTool(ownedTools(owner.id))?.id===ui.id?'@review':ui.id;}

function renderPaneDock(view,agent){
  if(view.disposed||!view.node.querySelector('.pane-main'))return;
  const entries=dockEntries(agent);
  let dock=paneDocks.get(agent.id);
  if(dock&&!entries.some(entry=>entry.id===dock.tool)){
    const review=entries.find(entry=>entry.id==='@review');
    // A tool that stopped closes the dock rather than swapping the editor in.
    const next=review?.ui?.id===dock.tool?review:entries.find(entry=>entry.ui&&entry.id!=='@review')||entries[0];
    dock=next?{...dock,tool:next.id,open:dock.open&&(next===review||!!next.ui)}:null;
    if(dock)paneDocks.set(agent.id,dock);else paneDocks.delete(agent.id);
    savePaneDocks();
  }
  const tools=entries.filter(entry=>entry.ui&&!entry.ui.id.startsWith('pane-review-')).map(entry=>entry.ui);
  let chip=view.node.querySelector('.pane-tool-toggle');
  const toggle=view.node.querySelector('.pane-edit');
  toggle?.setAttribute('aria-pressed',String(!!dock?.open));
  // The button draws the panel where it opens: on the right, or below the terminal.
  if(toggle)toggle.dataset.side=dock?.side==='bottom'||matchMedia('(max-width:760px)').matches?'bottom':'right';
  if(!tools.length)chip?.closest('.pane-tool')?.remove();
  // Each tab keeps its own page loaded while another is shown; a tool that went away is unloaded.
  const live=new Set(entries.filter(entry=>entry.ui||entry.plugin).map(entry=>entry.ui?.id||entry.id));
  view.node.querySelectorAll('.pane-dock-frame').forEach(frame=>{if(!live.has(frame.dataset.ui))frame.remove();});
  if(!entries.length){hideDock(view);return;}
  if(tools.length){
    // The chip says an agent opened a tool here and shows or hides it; its × closes the tool for good.
    if(!chip){
      const group=document.createElement('span');group.className='pane-tool';
      group.innerHTML=`<button type="button" class="pane-tool-toggle">${dockIcons.tool}<span></span></button><button type="button" class="pane-tool-exit">${dockIcons.close}</button>`;
      (view.node.querySelector('.pane-edit')||view.node.querySelector('.pane-expand')).before(group);
      chip=group.querySelector('.pane-tool-toggle');
    }
    const ui=tools.find(item=>dockEntryId(item,agent)===dock?.tool)||tools[0],entry=dockEntryId(ui,agent),shown=!!dock?.open&&dock.tool===entry;
    chip.onclick=()=>updateDock(agent.id,shown?{open:false}:{open:true,tool:entry});
    chip.closest('.pane-tool').querySelector('.pane-tool-exit').onclick=()=>exitDockedTool(ui);
    chip.querySelector('span').textContent=ui.title+(tools.length>1?' +'+(tools.length-1):'');
    chip.setAttribute('aria-pressed',String(shown));
    chip.title=(shown?'Hide ':'Show ')+ui.title+' in this pane';
    chip.setAttribute('aria-label',chip.title);
    const exit=view.node.querySelector('.pane-tool-exit'),stops=ui.managed&&ui.status==='running';
    exit.title=stops?'Stop '+ui.title:'Close '+ui.title+' · it was started outside Agent Desk, so only its entry here is removed';
    exit.setAttribute('aria-label',(stops?'Stop ':'Close ')+ui.title);
  }
  if(dock?.open)showDock(view,agent,dock,entries);else hideDock(view);
}

function showDock(view,agent,dock,entries){
  const id=agent.id,main=view.node.querySelector('.pane-main');
  let panel=main.querySelector('.pane-dock');
  if(!panel){
    main.insertAdjacentHTML('beforeend',`<div class="pane-divider" role="separator" tabindex="0" aria-label="Resize the dock" aria-valuemin="${DOCK_MIN*100}" aria-valuemax="${DOCK_MAX*100}"></div><div class="pane-dock"><nav class="pane-dock-tabs" role="tablist" aria-orientation="vertical" aria-label="Shown in this pane"></nav><div class="pane-dock-main"><div class="pane-dock-bar"><span class="pane-dock-title"><b></b><span class="pane-dock-subtitle"></span><span class="pane-dock-flag"></span></span><div class="pane-dock-actions" hidden></div><button type="button" class="pane-dock-review text-button" hidden>Second opinion…</button><button type="button" class="pane-dock-expand pane-icon"></button><button type="button" class="pane-dock-side pane-icon"></button><a class="pane-dock-library pane-icon" target="_blank" rel="noopener noreferrer" title="Open in a browser tab" aria-label="Open in a browser tab">${dockIcons.library}</a><button type="button" class="pane-dock-hide pane-icon" title="Hide the dock · everything in it stays open" aria-label="Hide the dock">${dockIcons.close}</button></div><div class="pane-dock-editor" hidden></div><div class="pane-dock-note" role="status" hidden></div></div></div>`);
    panel=main.querySelector('.pane-dock');
    panel.querySelector('.pane-dock-side').onclick=()=>updateDock(id,{side:paneDocks.get(id)?.side==='bottom'?'right':'bottom'});
    panel.querySelector('.pane-dock-expand').onclick=()=>updateDock(id,{expanded:!paneDocks.get(id)?.expanded});
    panel.querySelector('.pane-dock-review').onclick=()=>requestSecondOpinion(skillUIs.find(item=>item.id===panel.dataset.ui));
    panel.querySelector('.pane-dock-hide').onclick=()=>updateDock(id,{open:false});
    // The desktop app has no browser tab: the shell opens the tool in its own window, without desk access.
    const library=panel.querySelector('.pane-dock-library');
    if(window.agentDeskDesktop?.openTool){
      library.title='Open in a new window';library.setAttribute('aria-label',library.title);
      library.onclick=event=>{event.preventDefault();window.agentDeskDesktop.openTool(library.href).catch(error=>toast(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'')));};
    }
    bindDockDivider(main.querySelector('.pane-divider'),main,id);
  }
  // A phone-width pane is too narrow to split sideways.
  const bottom=dock.side==='bottom'||matchMedia('(max-width:760px)').matches,size=Math.min(DOCK_MAX,Math.max(DOCK_MIN,dock.size||.5));
  main.classList.add('docked');main.classList.toggle('dock-bottom',bottom);main.classList.toggle('dock-expanded',!!dock.expanded);
  main.style.setProperty('--dock-size',(size*100).toFixed(1)+'%');
  panel.hidden=false;
  const divider=main.querySelector('.pane-divider');divider.hidden=false;
  divider.setAttribute('aria-orientation',bottom?'horizontal':'vertical');divider.setAttribute('aria-valuenow',String(Math.round(size*100)));
  const side=panel.querySelector('.pane-dock-side');
  side.innerHTML=bottom?dockIcons.right:dockIcons.bottom;side.title=bottom?'Dock to the right':'Dock below';side.setAttribute('aria-label',side.title);
  const expand=panel.querySelector('.pane-dock-expand');
  expand.innerHTML=dock.expanded?dockIcons.shrink:dockIcons.expand;expand.title=dock.expanded?'Show the terminal again':'Fill the pane, hiding the terminal';expand.setAttribute('aria-label',expand.title);expand.setAttribute('aria-pressed',String(!!dock.expanded));
  const entry=entries.find(item=>item.id===dock.tool)||entries[0];
  const tabs=panel.querySelector('.pane-dock-tabs'),labels=JSON.stringify(entries.map(item=>[item.id,item.title]));
  if(tabs.dataset.entries!==labels){
    tabs.dataset.entries=labels;
    tabs.innerHTML=entries.map(item=>`<button type="button" role="tab" class="pane-dock-tab" data-entry="${escapeHTML(item.id)}" title="${escapeHTML(item.ui?.title||item.plugin?.title||item.title)}">${railIcon(item)}<span>${escapeHTML(item.title)}</span><i class="pane-dock-badge" hidden></i></button>`).join('');
    tabs.querySelectorAll('.pane-dock-tab').forEach(tab=>tab.onclick=()=>{updateDock(id,{tool:tab.dataset.entry});if(tab.dataset.entry==='@editor')window.paneEditor?.focus(id);});
    tabs.onkeydown=event=>{
      if(event.key!=='ArrowDown'&&event.key!=='ArrowUp')return;
      const all=[...tabs.querySelectorAll('.pane-dock-tab')],at=all.indexOf(document.activeElement);if(at<0)return;
      event.preventDefault();all[(at+(event.key==='ArrowDown'?1:all.length-1))%all.length].focus();
    };
  }
  const tabState=item=>item?.plugin&&typeof pluginTab==='function'?pluginTab(id,item.plugin.id):{};
  tabs.querySelectorAll('.pane-dock-tab').forEach(tab=>{
    tab.setAttribute('aria-selected',String(tab.dataset.entry===entry.id));
    tab.querySelector('.pane-dock-badge').hidden=!tabState(entries.find(item=>item.id===tab.dataset.entry)).badge;
  });
  // The title bar names what is shown; a plugin may add a subtitle and a short note of its own.
  const shown=tabState(entry);
  panel.querySelector('.pane-dock-title b').textContent=entry.ui&&!entry.id.startsWith('@')?entry.ui.title:entry.heading||entry.title;
  panel.querySelector('.pane-dock-subtitle').textContent=shown.subtitle||'';
  panel.querySelector('.pane-dock-flag').textContent=shown.note||'';
  const editor=panel.querySelector('.pane-dock-editor'),note=panel.querySelector('.pane-dock-note');
  editor.hidden=entry.id!=='@editor';note.hidden=true;
  panel.dataset.ui=entry.ui?.id||'';panel.dataset.entry=entry.id;
  let frame=null;
  if(entry.plugin){
    // A plugin page gets scripts and nothing else: no origin of its own, no forms, popups or navigation of the desk.
    frame=[...panel.querySelectorAll('.pane-dock-frame')].find(item=>item.dataset.ui===entry.id);
    if(!frame){
      const host=panel.querySelector('.pane-dock-main');
      host.insertAdjacentHTML('beforeend','<iframe class="pane-dock-frame" sandbox="allow-scripts" referrerpolicy="same-origin" allow=""></iframe>');
      frame=host.lastElementChild;frame.dataset.ui=entry.id;frame.dataset.plugin=entry.plugin.id;
      connectPlugin(frame,entry.plugin,id);
      frame.src=entry.plugin.entry;
    }
    frame.title=entry.plugin.title;
  }else if(entry.ui){
    frame=[...panel.querySelectorAll('.pane-dock-frame')].find(item=>item.dataset.ui===entry.ui.id);
    if(!frame){
      const host=panel.querySelector('.pane-dock-main');
      host.insertAdjacentHTML('beforeend','<iframe class="pane-dock-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" allow="clipboard-write; fullscreen"></iframe>');
      frame=host.lastElementChild;frame.dataset.ui=entry.ui.id;
    }
    frame.title=entry.ui.title;
    if(frame.dataset.url!==entry.ui.url){frame.src=framePageUrl(entry.ui.url)||'about:blank';frame.dataset.url=entry.ui.url;}
    if(entry.id==='@review')sendReviewPullRequests(frame,agent,entry.ui.url);
  }else if(entry.id==='@review')showReviewStart(view,agent,note);
  panel.querySelectorAll('.pane-dock-frame').forEach(item=>item.hidden=item!==frame);
  renderPluginButtons(panel,id,entry);
  const library=panel.querySelector('.pane-dock-library');library.hidden=!entry.ui;library.href=entry.ui?framePageUrl(entry.ui.url)||'about:blank':'about:blank';
  // A coordinator's review can send reviewers that report back to it. A pane's own review asks for a second opinion
  // from inside the review, where the notes land, so it has no button here.
  panel.querySelector('.pane-dock-review').hidden=entry.ui?.skill!=='code-review'||entry.ui.id.startsWith('pane-review-');
  if(entry.id==='@editor')window.paneEditor.mount(view,id,editor);
}

// Review switches between the pane's open pull requests, which the desk already watches for the PR chip. The list
// goes only to the review's own origin, again whenever its page loads, and the review reads each one from Git.
function sendReviewPullRequests(frame,agent,url){
  const pr=agent.pull_request,list=pr?[pr,...(pr.others||[])].filter(p=>p.state==='open'||p.state==='draft').map(p=>({url:p.url,title:p.title||'',branch:p.branch||'',comments:p.comments||0})):[];
  const message={agentDesk:'pull-requests',prs:list,hidden:agent.pull_requests_hidden||[]};
  try{const at=new URL(url);frame.reviewOrigin=at.protocol+'//'+at.host;}catch{return;}
  if(!frame.reviewPrs)frame.addEventListener('load',()=>frame.contentWindow?.postMessage(frame.reviewPrs,frame.reviewOrigin));
  if(JSON.stringify(message)===JSON.stringify(frame.reviewPrs))return;
  frame.reviewPrs=message;frame.contentWindow?.postMessage(message,frame.reviewOrigin);
}
// Review's send button names the coding agent it goes to; a pane whose agent the desk can't tell names the session.
const reviewTarget=agent=>{
  const names={claude:'Claude',codex:'Codex',grok:'Grok',opencode:'OpenCode',pi:'Pi',cortex:'Cortex Code','cursor-agent':'Cursor'};
  // The launch choice says which agent a pane runs, whatever process is in front; an account names its CLI.
  const account=(window.AGENT_DESK_CONFIG?.accounts||[]).find(item=>item.id===agent.launch_profile);
  return names[account?.harness||agent.launch_profile||agent.harness||'']||sessionTitle(agent);
};
// Review starts the desk's own code review on the pane's folder the first time it is shown.
function showReviewStart(view,agent,note){
  const state=reviewStarts.get(agent.id);
  note.hidden=false;
  if(state?.error){
    note.innerHTML=`<p>${escapeHTML(state.error)}</p><button type="button" class="text-button">Try again</button>`;
    note.querySelector('button').onclick=()=>{reviewStarts.delete(agent.id);renderPaneDock(view,everyAgent().find(a=>a.id===agent.id)||agent);};
    return;
  }
  note.innerHTML=`<p>Opening a review of the changes in ${escapeHTML(shortPath(agent.cwd||''))}…</p>`;
  if(state)return;
  reviewStarts.set(agent.id,{});
  terminalRequest('/api/tools/pane-review',{id:agent.id,name:reviewTarget(agent)})
    .then(()=>{reviewStarts.delete(agent.id);return refreshSkillUIs();})
    .catch(error=>reviewStarts.set(agent.id,{error:'Could not open the review: '+error.message}))
    .finally(()=>{const current=paneViews.get(agent.id),owner=everyAgent().find(a=>a.id===agent.id);if(current&&owner)renderPaneDock(current,owner);});
}

// Hidden rather than removed, so everything in the dock keeps its state (and any unsent notes) while it is out of the way.
function hideDock(view){
  const main=view.node.querySelector('.pane-main');if(!main?.classList.contains('docked'))return;
  main.classList.remove('docked','dock-bottom','dock-expanded');
  main.querySelectorAll('.pane-dock,.pane-divider').forEach(node=>node.hidden=true);
}

function bindDockDivider(divider,main,id){
  const sizeAt=event=>{const box=main.getBoundingClientRect();return main.classList.contains('dock-bottom')?(box.bottom-event.clientY)/box.height:(box.right-event.clientX)/box.width;};
  const clamp=value=>Math.min(DOCK_MAX,Math.max(DOCK_MIN,value));
  divider.onpointerdown=event=>{
    if(event.button!==0)return;event.preventDefault();divider.setPointerCapture(event.pointerId);main.classList.add('dock-resizing');
    const move=moveEvent=>{main.style.setProperty('--dock-size',(clamp(sizeAt(moveEvent))*100).toFixed(1)+'%');window.paneEditor?.resize(id);};
    const end=endEvent=>{divider.removeEventListener('pointermove',move);main.classList.remove('dock-resizing');updateDock(id,{size:clamp(sizeAt(endEvent))});};
    divider.addEventListener('pointermove',move);divider.addEventListener('pointerup',end,{once:true});divider.addEventListener('pointercancel',end,{once:true});
  };
  divider.onkeydown=event=>{
    const bottom=main.classList.contains('dock-bottom'),grow=bottom?'ArrowUp':'ArrowLeft',shrink=bottom?'ArrowDown':'ArrowRight';
    if(![grow,shrink].includes(event.key))return;event.preventDefault();
    updateDock(id,{size:clamp((paneDocks.get(id)?.size||.5)+(event.key===grow?.05:-.05))});
  };
}

function updateDock(id,changes){
  const agent=everyAgent().find(a=>a.id===id);
  const dock={side:'right',size:.5,open:false,...paneDocks.get(id),...changes};
  if(!dock.tool)dock.tool=agent?dockEntries(agent)[0]?.id:undefined;
  paneDocks.set(id,dock);savePaneDocks();
  const view=paneViews.get(id);
  if(view&&agent)renderPaneDock(view,agent);
  if(changes.open===false){const chip=view?.node.querySelector('.pane-tool-toggle');if(chip&&dockEntries(agent||{id}).find(entry=>entry.id===dock.tool)?.ui)chip.focus({preventScroll:true});else view?.term?.focus();}
}
function toggleDock(id){updateDock(id,{open:!paneDocks.get(id)?.open});}
function renderPaneDocks(){for(const [id,view] of paneViews){const agent=everyAgent().find(a=>a.id===id);if(agent)renderPaneDock(view,agent);}}
matchMedia('(max-width:760px)').addEventListener('change',renderPaneDocks);

// Open a tool where its agent is: dock it in that agent's pane, opening the pane if needed.
// Returns false when the tool has no live owner, so the caller can open it as a web pane.
function dockTool(ui){
  const owner=dockOwner(ui);if(!owner)return false;
  paneDocks.set(owner.id,{side:'right',size:.5,...paneDocks.get(owner.id),tool:dockEntryId(ui,owner),open:true});savePaneDocks();
  selectPane(owner.id,true);
  return openPaneIds.includes(owner.id);
}
// A tool that appears while its agent's pane is open docks there instead of waiting on the Tools page.
function autoDockTool(ui){
  const owner=dockOwner(ui);if(!owner||!openPaneIds.includes(owner.id))return false;
  // The review a pane asked for is already on screen under Review.
  if(ui.id.startsWith('pane-review-'))return true;
  updateDock(owner.id,{tool:dockEntryId(ui,owner),open:true});
  return true;
}

// Exit stops a tool Agent Desk launched. A tool started elsewhere has a server that is not
// ours to stop, so exiting removes it from the desk instead, as Remove does in the library.
async function exitDockedTool(ui){
  if(!ui)return;
  const stops=ui.managed&&ui.status==='running';
  try{
    await terminalRequest(stops?'/api/tools/stop':'/api/tools/forget',{id:ui.id});
    await refreshSkillUIs();
    toast(stops?'Stopped '+ui.title+'. Launch it again from Skills.':'Closed '+ui.title+'.');
  }catch(error){toast('Could not '+(stops?'stop ':'close ')+ui.title+': '+error.message);}
}
