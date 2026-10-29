// Sidebar folders. Dropping a session onto the middle of another puts both in a named,
// collapsible group, the way phone app folders and Discord server folders work. Groups are
// stored in this browser beside the session order they extend, and a group only ever holds
// sessions of one kind (coordinators or agents & shells), like the order itself.
const groupsKey=()=>'agent-desk-groups-'+(demo?'demo':'live');
let renamingGroup=null;
function sessionGroups(){
  try{
    const value=JSON.parse(localStorage.getItem(groupsKey())||'[]');
    return Array.isArray(value)?value.filter(g=>g&&typeof g.id==='string'&&Array.isArray(g.ids)).map(g=>({id:g.id,name:typeof g.name==='string'&&g.name.trim()?g.name:'Group',ids:[...new Set(g.ids.filter(id=>typeof id==='string'))],collapsed:!!g.collapsed})):[];
  }catch{return [];}
}
// Closed sessions and single-member groups are only dropped when the user changes groups,
// never on a refresh: a backend that is still restoring its terminals must not erase them.
// Folders on other desks are not this desk's to settle, so every desk's sessions count.
function settledGroups(groups){
  const live=new Set(everyAgent().filter(a=>!a.harness_internal).map(a=>a.id));
  return groups.map(g=>({...g,ids:g.ids.filter(id=>live.has(id))})).filter(g=>g.ids.length>1);
}
function saveSessionGroups(groups){
  try{localStorage.setItem(groupsKey(),JSON.stringify(groups));return true;}catch{toast('Could not save session groups in this browser');return false;}
}
function groupOf(id,groups=sessionGroups()){return groups.find(g=>g.ids.includes(id))||null;}
function nextGroupName(groups){const used=new Set(groups.map(g=>g.name));let n=1;while(used.has('Group '+n))n++;return 'Group '+n;}
// A finished subagent sits under its parent, so it belongs to whatever group the parent is in.
function sidebarGroupOf(agent,sessions,groups){
  let owner=agent;
  for(let depth=0;owner?.harness_internal&&depth<20;depth++)owner=sessions.find(a=>a.id===owner.parent_id);
  return owner&&!owner.harness_internal?groupOf(owner.id,groups):null;
}
function updateGroup(id,change){
  const groups=sessionGroups(),group=groups.find(g=>g.id===id);if(!group)return false;
  change(group);return saveSessionGroups(groups);
}
function ungroup(id){
  const groups=sessionGroups(),group=groups.find(g=>g.id===id);if(!group)return;
  if(saveSessionGroups(groups.filter(g=>g!==group)))toast(`Ungrouped “${group.name}”`);
  render();
}
function removeFromGroup(id){
  const group=groupOf(id);if(!group)return;
  if(moveSession({session:id},{group:group.id},'after'))toast(`Removed from “${group.name}”`);
  render();
}
function toggleGroup(id){updateGroup(id,group=>{group.collapsed=!group.collapsed;});render();}
const groupChevron='<svg class="nav-group-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6.25 3.5 3.5 3.5-3.5"/></svg>';
function sessionGroupHeader(group,sessions,forceOpen){
  const members=sessions.filter(a=>!a.harness_internal&&group.ids.includes(a.id)),open=forceOpen||!group.collapsed;
  const needsYou=members.filter(a=>a.status==='needs_input').length,working=members.some(a=>matchesStatus(a,'working'));
  const peek=members.slice(0,4).map(a=>`<span class="nav-group-peek-avatar" style="--agent-color:${agentColor(a.id)}">${({codex:'CX',claude:'CC',grok:'GX',opencode:'OC',pi:'PI',cortex:'CO'})[a.harness]||'AI'}</span>`).join('');
  return `<button type="button" class="nav-group-toggle" draggable="true" data-group-toggle="${escapeHTML(group.id)}" aria-expanded="${open}" title="${escapeHTML(group.name)} · click to ${open?'collapse':'expand'} · right-click to rename · drag to move">${groupChevron}<span class="nav-group-name">${escapeHTML(group.name)}</span><span class="nav-group-count">${members.length}</span>${working?'<span class="nav-group-working" title="A session in this group is working" aria-hidden="true"></span>':''}<span class="nav-group-peek" aria-hidden="true">${peek}</span>${needsYou?`<span class="nav-group-attention" role="img" aria-label="${needsYou} need${needsYou===1?'s':''} you" title="${needsYou} session${needsYou===1?'':'s'} in this group need${needsYou===1?'s':''} you">${attentionGlyph}</span>`:''}</button>`;
}
// The sidebar list with each group's members wrapped in its folder. orderedSessions keeps a
// group's members next to each other, so a folder opens at its first member and closes at
// the first session outside it. A search or status filter opens every folder, so a match is
// never hidden inside a collapsed one.
function sessionListHTML(visible,entry){
  const all=current(),groups=sessionGroups(),forceOpen=filter!=='all'||!!$('#search').value.trim();
  const lastGrouped=visible.reduce((last,agent,index)=>sidebarGroupOf(agent,all,groups)?index:last,-1);
  let html='',open=null;
  visible.forEach((agent,index)=>{
    const group=sidebarGroupOf(agent,all,groups);
    if(open&&open!==group){html+='</div></div>';open=null;
      // Marks where the lowest folder ends and the loose sessions begin.
      if(index-1===lastGrouped)html+='<div class="nav-group-divider" role="separator" aria-label="Ungrouped sessions"><span aria-hidden="true">Ungrouped</span></div>';}
    html+=sessionGroupHeading(agent,index,visible);
    if(group&&open!==group){
      open=group;
      html+=`<div class="nav-group ${forceOpen||!group.collapsed?'':'collapsed'}" data-group="${escapeHTML(group.id)}">${sessionGroupHeader(group,all,forceOpen)}<div class="nav-group-members"${forceOpen||!group.collapsed?'':' hidden'}>`;
    }
    html+=entry(agent);
  });
  if(open)html+='</div></div>';
  // The focused and open highlights on rows and folder headers are applied by highlightPanes.
  return html;
}
function startGroupRename(id){
  const toggle=document.querySelector(`[data-group-toggle="${CSS.escape(id)}"]`),group=sessionGroups().find(g=>g.id===id);
  if(!toggle||!group)return;
  renamingGroup=id;
  const field=document.createElement('div');field.className='nav-group-toggle renaming';field.innerHTML=groupChevron;
  const input=document.createElement('input');
  Object.assign(input,{className:'nav-group-rename',value:group.name,maxLength:40,spellcheck:false});
  input.setAttribute('aria-label','Group name');
  field.append(input);toggle.replaceWith(field);input.focus();input.select();
  let done=false;
  const finish=save=>{
    if(done)return;done=true;
    const name=input.value.trim();
    if(save&&name&&name!==group.name)updateGroup(id,g=>{g.name=name;});
    renamingGroup=null;render();
    document.querySelector(`[data-group-toggle="${CSS.escape(id)}"]`)?.focus({preventScroll:true});
  };
  input.addEventListener('keydown',event=>{
    if(event.key==='Enter'){event.preventDefault();finish(true);}
    else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();finish(false);}
  });
  input.addEventListener('blur',()=>finish(true));
}
function closeGroupMenu(restoreFocus){
  const menu=$('#session-group-menu');if(!menu||menu.hidden)return;
  closeGroupSubmenu(false);menu.hidden=true;
  if(restoreFocus)menu.returnFocus?.focus({preventScroll:true});
}
function openGroupMenu(x,y,items,returnFocus){
  let menu=$('#session-group-menu');
  if(!menu){menu=document.createElement('div');menu.id='session-group-menu';menu.setAttribute('role','menu');document.body.append(menu);}
  menu.returnFocus=returnFocus;
  menu.innerHTML=items.map(([label,,danger,fill],index)=>`<button type="button" role="menuitem" data-menu-index="${index}" class="${danger?'danger':''}"${fill?' aria-haspopup="menu" aria-expanded="false"':''}>${escapeHTML(label)}${fill?submenuChevron:''}</button>`).join('');
  menu.querySelectorAll('[data-menu-index]').forEach(button=>{
    const [,run,,fill]=items[+button.dataset.menuIndex];
    button.onclick=()=>{if(fill){openGroupSubmenu(button,fill);$('#session-group-submenu button')?.focus();}else{closeGroupMenu(false);run();}};
    button.onpointerenter=()=>{if(fill)openGroupSubmenu(button,fill);else closeGroupSubmenu(false);};
  });
  menu.hidden=false;
  const box=menu.getBoundingClientRect();
  menu.style.left=Math.max(8,Math.min(x,innerWidth-box.width-8))+'px';
  menu.style.top=Math.max(8,Math.min(y,innerHeight-box.height-8))+'px';
  menu.querySelector('button')?.focus();
}
const submenuChevron='<svg class="menu-more" viewBox="0 0 16 16" aria-hidden="true"><path d="m6.5 4.5 3.5 3.5-3.5 3.5"/></svg>';
// An item with a submenu (its fourth entry fills the panel) opens it beside the menu, or over it
// where there is no room beside, below the item so the item stays readable.
function openGroupSubmenu(button,fill){
  let sub=$('#session-group-submenu');
  if(!sub){sub=document.createElement('div');sub.id='session-group-submenu';sub.setAttribute('role','menu');document.body.append(sub);}
  if(!sub.hidden&&sub.parentButton===button)return;
  sub.parentButton?.setAttribute('aria-expanded','false');sub.parentButton=button;button.setAttribute('aria-expanded','true');
  fill(sub);sub.hidden=false;
  const menu=$('#session-group-menu').getBoundingClientRect(),at=button.getBoundingClientRect(),box=sub.getBoundingClientRect();
  const right=menu.right+4,left=menu.left-box.width-4,beside=right+box.width<=innerWidth-8||left>=8;
  sub.style.left=(right+box.width<=innerWidth-8?right:left>=8?left:Math.max(8,innerWidth-box.width-8))+'px';
  sub.style.top=Math.max(8,Math.min(beside?at.top-6:at.bottom+4,innerHeight-box.height-8))+'px';
}
function closeGroupSubmenu(restoreFocus){
  const sub=$('#session-group-submenu');if(!sub||sub.hidden)return;
  sub.hidden=true;sub.parentButton?.setAttribute('aria-expanded','false');
  if(restoreFocus)sub.parentButton?.focus();
}
document.addEventListener('DOMContentLoaded',()=>{
  const grid=$('#agent-grid');
  grid.addEventListener('click',event=>{
    const toggle=event.target.closest('[data-group-toggle]');if(toggle)toggleGroup(toggle.dataset.groupToggle);
  });
  // Shift+F10 and the context-menu key also land here, so the menu works from the keyboard.
  grid.addEventListener('contextmenu',event=>{
    if(annotating)return;
    const toggle=event.target.closest('[data-group-toggle]'),row=event.target.closest('.session-row');
    const at=event.clientX||event.clientY?[event.clientX,event.clientY]:(box=>[box.x+16,box.bottom])((toggle||row).getBoundingClientRect());
    if(toggle){
      const id=toggle.dataset.groupToggle,collapsed=toggle.getAttribute('aria-expanded')==='false';
      event.preventDefault();
      const group=sessionGroups().find(g=>g.id===id),members=current().filter(a=>!a.harness_internal&&group?.ids.includes(a.id)).map(a=>a.id);
      openGroupMenu(...at,[['Rename',()=>startGroupRename(id)],[collapsed?'Expand':'Collapse',()=>toggleGroup(id)],
        ...(demo||!members.length?[]:deskMoveItems(members,`“${group.name}”`)),['Ungroup',()=>ungroup(id),true]],toggle);
    }else if(row&&!row.closest('.internal-session')&&!demo){
      // A finished subagent follows its parent, so only the parent can be moved to another desk.
      const id=row.dataset.agentId,agent=current().find(a=>a.id===id);if(!agent)return;
      event.preventDefault();
      openGroupMenu(...at,[...(groupOf(id)?[['Remove from group',()=>removeFromGroup(id)]]:[]),...deskMoveItems([id],`“${sessionTitle(agent)}”`)],row);
    }
  });
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('#session-group-menu,#session-group-submenu'))closeGroupMenu(false);},true);
  document.addEventListener('keydown',event=>{
    const menu=$('#session-group-menu');if(!menu||menu.hidden)return;
    const sub=$('#session-group-submenu'),inSub=!!sub&&!sub.hidden&&sub.contains(document.activeElement);
    // Escape or ← steps back out of a submenu before a second Escape closes the menu.
    if(inSub&&(event.key==='Escape'||event.key==='ArrowLeft'&&!event.target.closest('input'))){event.preventDefault();closeGroupSubmenu(true);return;}
    if(event.target.closest('#session-group-submenu form'))return;
    const items=[...(inSub?sub:menu).querySelectorAll('button')],index=items.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();closeGroupMenu(true);}
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();items[(index+(event.key==='ArrowDown'?1:items.length-1))%items.length].focus();}
    else if(event.key==='ArrowRight'&&document.activeElement?.getAttribute('aria-haspopup')==='menu'){event.preventDefault();document.activeElement.click();}
    else if(event.key==='Tab')closeGroupMenu(false);
  });
  window.addEventListener('blur',()=>closeGroupMenu(false));
  grid.addEventListener('scroll',()=>closeGroupMenu(false));
});
