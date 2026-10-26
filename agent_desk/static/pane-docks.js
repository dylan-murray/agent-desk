// A tool docks inside the pane of the agent that opened it, beside or below its terminal,
// so the conversation and its result share one pane. A tool with no owner on the desk
// opens as a web pane instead (skill-uis.js).
const paneDocks=new Map((()=>{try{return Object.entries(JSON.parse(sessionStorage.getItem('agent-desk-pane-docks')||'{}'));}catch{return [];}})());
function savePaneDocks(){try{sessionStorage.setItem('agent-desk-pane-docks',JSON.stringify(Object.fromEntries(paneDocks)));}catch{}}
const dockIcons={
  tool:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76Z"/></svg>',
  right:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M9 3v10"/></svg>',
  bottom:'<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="M2 9h12"/></svg>',
  library:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
};
const DOCK_MIN=.2,DOCK_MAX=.8;
const ownedTools=id=>(typeof skillUIs==='undefined'?[]:skillUIs).filter(ui=>ui.agent_id===id&&ui.status!=='stopped');
const dockOwner=ui=>ui?.agent_id&&!demo?everyAgent().find(a=>a.id===ui.agent_id&&(a.terminal_id||a.coordinator_workspace)&&a.exit_code==null):null;

function renderPaneDock(view,agent){
  if(view.disposed||!view.node.querySelector('.pane-main'))return;
  const tools=agent.terminal_id||agent.coordinator_workspace?ownedTools(agent.id):[];
  let dock=paneDocks.get(agent.id);
  if(dock&&!tools.some(ui=>ui.id===dock.tool)){
    if(tools.length)dock={...dock,tool:tools[0].id};else dock=null;
    if(dock)paneDocks.set(agent.id,dock);else paneDocks.delete(agent.id);
    savePaneDocks();
  }
  let chip=view.node.querySelector('.pane-tool-toggle');
  if(!tools.length){chip?.closest('.pane-tool')?.remove();hideDock(view);const frame=view.node.querySelector('.pane-dock-frame');if(frame?.dataset.url){frame.src='about:blank';delete frame.dataset.url;}return;}
  // The chip shows or hides the tool; its × closes the tool for good.
  if(!chip){
    const group=document.createElement('span');group.className='pane-tool';
    group.innerHTML=`<button type="button" class="pane-tool-toggle">${dockIcons.tool}<span></span></button><button type="button" class="pane-tool-exit">${dockIcons.close}</button>`;
    view.node.querySelector('.pane-expand').before(group);
    chip=group.querySelector('.pane-tool-toggle');
    chip.onclick=()=>toggleDock(agent.id);
    group.querySelector('.pane-tool-exit').onclick=()=>exitDockedTool(ownedTools(agent.id).find(item=>item.id===paneDocks.get(agent.id)?.tool)||ownedTools(agent.id)[0]);
  }
  const ui=tools.find(item=>item.id===dock?.tool)||tools[0],open=!!dock?.open;
  chip.querySelector('span').textContent=ui.title+(tools.length>1?' +'+(tools.length-1):'');
  chip.setAttribute('aria-pressed',String(open));
  chip.title=(open?'Hide ':'Show ')+ui.title+' in this pane';
  chip.setAttribute('aria-label',chip.title);
  const exit=view.node.querySelector('.pane-tool-exit'),stops=ui.managed&&ui.status==='running';
  exit.title=stops?'Stop '+ui.title:'Close '+ui.title+' · it was started outside Agent Desk, so only its entry here is removed';
  exit.setAttribute('aria-label',(stops?'Stop ':'Close ')+ui.title);
  if(open)showDock(view,agent.id,dock,ui,tools);else hideDock(view);
}

function showDock(view,id,dock,ui,tools){
  const main=view.node.querySelector('.pane-main');
  let panel=main.querySelector('.pane-dock');
  if(!panel){
    main.insertAdjacentHTML('beforeend',`<div class="pane-divider" role="separator" tabindex="0" aria-label="Resize the tool" aria-valuemin="${DOCK_MIN*100}" aria-valuemax="${DOCK_MAX*100}"></div><div class="pane-dock"><div class="pane-dock-bar"><span class="pane-dock-icon">${dockIcons.tool}</span><select class="pane-dock-pick" aria-label="Tool shown in this pane"></select><span class="pane-dock-name"></span><button type="button" class="pane-dock-side pane-icon"></button><button type="button" class="pane-dock-review text-button" hidden>Second opinion…</button><a class="pane-dock-library pane-icon" target="_blank" rel="noopener noreferrer" title="Open in a browser tab" aria-label="Open in a browser tab">${dockIcons.library}</a><button type="button" class="pane-dock-hide pane-icon" title="Hide the tool · it keeps running" aria-label="Hide the tool">${dockIcons.close}</button></div><iframe class="pane-dock-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" allow="clipboard-write; fullscreen"></iframe></div>`);
    panel=main.querySelector('.pane-dock');
    panel.querySelector('.pane-dock-pick').onchange=event=>updateDock(id,{tool:event.target.value});
    panel.querySelector('.pane-dock-side').onclick=()=>updateDock(id,{side:paneDocks.get(id)?.side==='bottom'?'right':'bottom'});
    panel.querySelector('.pane-dock-review').onclick=()=>requestSecondOpinion(skillUIs.find(item=>item.id===paneDocks.get(id)?.tool));
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
  main.classList.add('docked');main.classList.toggle('dock-bottom',bottom);
  main.style.setProperty('--dock-size',(size*100).toFixed(1)+'%');
  panel.hidden=false;main.querySelector('.pane-divider').hidden=false;
  const divider=main.querySelector('.pane-divider');
  divider.setAttribute('aria-orientation',bottom?'horizontal':'vertical');divider.setAttribute('aria-valuenow',String(Math.round(size*100)));
  const side=panel.querySelector('.pane-dock-side');
  side.innerHTML=bottom?dockIcons.right:dockIcons.bottom;side.title=bottom?'Dock to the right':'Dock below';side.setAttribute('aria-label',side.title);
  const pick=panel.querySelector('.pane-dock-pick'),name=panel.querySelector('.pane-dock-name');
  pick.hidden=tools.length<2;name.hidden=tools.length>1;name.textContent=ui.title;
  const options=JSON.stringify(tools.map(item=>[item.id,item.title]));
  if(pick.dataset.options!==options){pick.dataset.options=options;pick.innerHTML=tools.map(item=>`<option value="${escapeHTML(item.id)}">${escapeHTML(item.title)}</option>`).join('');}
  pick.value=ui.id;
  panel.querySelector('.pane-dock-library').href=framePageUrl(ui.url)||'about:blank';
  // Independent reviewers report to the session that owns the review; the server says if it can't take them.
  panel.querySelector('.pane-dock-review').hidden=ui.skill!=='code-review';
  const frame=panel.querySelector('.pane-dock-frame');frame.title=ui.title;
  if(frame.dataset.url!==ui.url){frame.src=framePageUrl(ui.url)||'about:blank';frame.dataset.url=ui.url;}
}

// Hidden rather than removed, so a tool keeps its state (and any unsent notes) while it is out of the way.
function hideDock(view){
  const main=view.node.querySelector('.pane-main');if(!main?.classList.contains('docked'))return;
  main.classList.remove('docked','dock-bottom');
  main.querySelectorAll('.pane-dock,.pane-divider').forEach(node=>node.hidden=true);
}

function bindDockDivider(divider,main,id){
  const sizeAt=event=>{const box=main.getBoundingClientRect();return main.classList.contains('dock-bottom')?(box.bottom-event.clientY)/box.height:(box.right-event.clientX)/box.width;};
  const clamp=value=>Math.min(DOCK_MAX,Math.max(DOCK_MIN,value));
  divider.onpointerdown=event=>{
    if(event.button!==0)return;event.preventDefault();divider.setPointerCapture(event.pointerId);main.classList.add('dock-resizing');
    const move=moveEvent=>main.style.setProperty('--dock-size',(clamp(sizeAt(moveEvent))*100).toFixed(1)+'%');
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
  const dock={side:'right',size:.5,open:false,...paneDocks.get(id),...changes};
  if(!dock.tool)dock.tool=ownedTools(id)[0]?.id;
  paneDocks.set(id,dock);savePaneDocks();
  const view=paneViews.get(id),agent=everyAgent().find(a=>a.id===id);
  if(view&&agent)renderPaneDock(view,agent);
  if(changes.open===false)view?.node.querySelector('.pane-tool-toggle')?.focus({preventScroll:true});
}
function toggleDock(id){updateDock(id,{open:!paneDocks.get(id)?.open});}
function renderPaneDocks(){for(const [id,view] of paneViews){const agent=everyAgent().find(a=>a.id===id);if(agent)renderPaneDock(view,agent);}}

// Open a tool where its agent is: dock it in that agent's pane, opening the pane if needed.
// Returns false when the tool has no live owner, so the caller can open it as a web pane.
function dockTool(ui){
  const owner=dockOwner(ui);if(!owner)return false;
  paneDocks.set(owner.id,{side:'right',size:.5,...paneDocks.get(owner.id),tool:ui.id,open:true});savePaneDocks();
  selectPane(owner.id,true);
  return openPaneIds.includes(owner.id);
}
// A tool that appears while its agent's pane is open docks there instead of waiting on the Tools page.
function autoDockTool(ui){
  const owner=dockOwner(ui);if(!owner||!openPaneIds.includes(owner.id))return false;
  updateDock(owner.id,{tool:ui.id,open:true});
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
