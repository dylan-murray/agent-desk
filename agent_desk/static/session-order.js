let coordinatorFocusId=null;
function coordinatorTeam(sessions=current()){
  if(!sessions.some(a=>a.id===coordinatorFocusId&&a.controller)){coordinatorFocusId=null;return new Set();}
  return agentDescendants(coordinatorFocusId,sessions);
}
function agentDescendants(root,sessions=current()){
  const team=new Set([root]);let changed=true;
  while(changed){changed=false;for(const agent of sessions)if(agent.parent_id&&team.has(agent.parent_id)&&!team.has(agent.id)){team.add(agent.id);changed=true;}}
  return team;
}
function focusCoordinatorFor(id){
  const all=current(),agent=all.find(a=>a.id===id);
  if(agent?.controller)coordinatorFocusId=id;
  else if(!coordinatorTeam(all).has(id))coordinatorFocusId=null;
}
let draggingSession=null,draggingGroup=null;
const orderKey=()=>'agent-desk-order-'+(demo?'demo':'live');
function sessionOrder(){
  try{const value=JSON.parse(localStorage.getItem(orderKey())||'[]');return Array.isArray(value)?value.filter(id=>typeof id==='string'):[];}catch{return [];}
}
function orderedSessions(sessions){
  const team=coordinatorTeam(sessions);
  const rank=new Map(sessionOrder().map((id,index)=>[id,index]));
  const sorted=[...sessions].filter(a=>!a.harness_internal).sort((a,b)=>Number(!!b.controller)-Number(!!a.controller)||(!a.controller&&!b.controller?Number(team.has(b.id))-Number(team.has(a.id)):0)||(rank.get(a.id)??Infinity)-(rank.get(b.id)??Infinity));
  // A group's members stay together, at the place of whichever member sorts first.
  const groups=sessionGroups(),grouped=[],placed=new Set();
  for(const agent of sorted){
    const group=groupOf(agent.id,groups);
    if(!group){grouped.push(agent);continue;}
    const key=group.id+':'+!!agent.controller;if(placed.has(key))continue;placed.add(key);
    grouped.push(...sorted.filter(member=>group.ids.includes(member.id)&&!!member.controller===!!agent.controller));
  }
  const result=[],seen=new Set();
  function append(agent){if(seen.has(agent.id))return;seen.add(agent.id);result.push(agent);for(const child of sessions)if(child.harness_internal&&child.parent_id===agent.id)append(child);}
  grouped.forEach(append);sessions.filter(a=>a.harness_internal).forEach(append);return result;
}
// Moves a session, or a whole group, before, after or into a target session or group, and
// settles membership the way the drop looks: "into" joins the target's group or founds a new
// one with it; before/after a session takes that session's membership, so a session dropped
// between two members joins their group and one dropped beside an ungrouped session leaves
// its own; before/after a group's header keeps it outside that group.
function moveSession(source,target,position){
  const live=orderedSessions(current()).filter(a=>!a.harness_internal),groups=sessionGroups();
  const kind=id=>!!live.find(a=>a.id===id)?.controller;
  const sourceGroup=source.group?groups.find(g=>g.id===source.group):null,targetGroup=target.group?groups.find(g=>g.id===target.group):null;
  const block=source.group?live.filter(a=>sourceGroup?.ids.includes(a.id)).map(a=>a.id):[source.session];
  if(!block.length||(target.group&&!targetGroup)||(target.session&&!live.some(a=>a.id===target.session)))return false;
  let anchor=targetGroup?[...targetGroup.ids]:[target.session];
  if(anchor.every(id=>block.includes(id))||(sourceGroup&&targetGroup===sourceGroup))return false;
  if(kind(block[0])!==kind(anchor.find(id=>live.some(a=>a.id===id))))return false;
  if(source.group){
    // Groups do not nest: a group dropped on another group's member lands beside that group.
    const holder=target.session&&groupOf(target.session,groups);
    if(holder){if(holder===sourceGroup)return false;anchor=[...holder.ids];}
    if(position==='into')return false;
  }else{
    for(const group of groups)group.ids=group.ids.filter(id=>id!==source.session);
    if(position==='into'&&targetGroup)targetGroup.ids.push(source.session);
    else if(target.session){
      const holder=groupOf(target.session,groups);
      if(holder)holder.ids.push(source.session);
      else if(position==='into'){
        const name=nextGroupName(settledGroups(groups));
        groups.push({id:'group-'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),name,ids:[target.session,source.session],collapsed:false});
        toast(`Grouped into “${name}” · right-click it to rename`);
      }
    }
  }
  const order=live.map(a=>a.id).filter(id=>!block.includes(id)),indexes=anchor.map(id=>order.indexOf(id)).filter(index=>index>=0);
  if(!indexes.length)return false;
  order.splice(position==='before'?Math.min(...indexes):Math.max(...indexes)+1,0,...block);
  // Only this desk's sessions were reordered; the other desks' keep their places after them.
  const others=sessionOrder().filter(id=>!order.includes(id));
  try{localStorage.setItem(orderKey(),JSON.stringify([...order,...others]));}catch{toast('Could not save session order in this browser');return false;}
  return saveSessionGroups(settledGroups(groups));
}
function sessionGroupHeading(agent,index,visible){
  if(agent.harness_internal)return '';
  if(agent.controller&&!visible.slice(0,index).some(a=>a.controller))return '<div class="session-group-heading controller-group-heading">Coordinators</div>';
  if(!agent.controller&&visible.slice(0,index).some(a=>a.controller)&&!visible.slice(0,index).some(a=>!a.controller&&!a.harness_internal))return '<div class="session-group-heading worker-group-heading">Agents &amp; shells</div>';
  return '';
}
function clearSessionDrag(){
  draggingSession=null;draggingGroup=null;
  document.querySelectorAll('.dragging,.drop-before,.drop-after,.drop-into').forEach(el=>el.classList.remove('dragging','drop-before','drop-after','drop-into'));
}
// Where a drop would land. On a session the edges place it before or after and the middle
// groups the two, so grouping is a deliberate "put it on top of that one" gesture and a
// reorder stays a reorder. On a group header the top edge places the session above the
// folder and the rest drops it into the folder.
function sessionDropAt(event){
  const horizontal=matchMedia('(max-width:760px)').matches,groups=sessionGroups();
  const along=element=>{const box=element.getBoundingClientRect();return horizontal?(event.clientX-box.x)/box.width:(event.clientY-box.y)/box.height;};
  const toggle=event.target.closest('[data-group-toggle]'),entry=!toggle&&event.target.closest('.session-entry');
  const source=draggingGroup?{group:draggingGroup}:{session:draggingSession};
  if(toggle){
    const id=toggle.dataset.groupToggle,folder=toggle.closest('.nav-group');if(id===draggingGroup)return null;
    const ratio=along(toggle);
    if(draggingGroup)return {source,target:{group:id},position:ratio<.5?'before':'after',mark:folder,markClass:ratio<.5?'drop-before':'drop-after'};
    if(ratio<.3)return {source,target:{group:id},position:'before',mark:folder,markClass:'drop-before'};
    return {source,target:{group:id},position:'into',mark:toggle,markClass:'drop-into'};
  }
  if(!entry||entry.classList.contains('internal-session'))return null;
  const id=entry.querySelector('.session-row').dataset.agentId;if(id===draggingSession)return null;
  const holder=groupOf(id,groups);
  if(draggingGroup){
    if(holder?.id===draggingGroup)return null;
    const mark=holder?entry.closest('.nav-group'):entry,ratio=along(mark);
    return {source,target:holder?{group:holder.id}:{session:id},position:ratio<.5?'before':'after',mark,markClass:ratio<.5?'drop-before':'drop-after'};
  }
  const ratio=along(entry),position=ratio<.28?'before':ratio>.72?'after':'into';
  return {source,target:{session:id},position,mark:entry,markClass:'drop-'+position};
}
function sameKind(drop){
  const all=current(),kind=id=>!!all.find(a=>a.id===id)?.controller,groups=sessionGroups();
  const first=id=>groups.find(g=>g.id===id)?.ids.find(member=>all.some(a=>a.id===member));
  const from=drop.source.group?first(drop.source.group):drop.source.session,to=drop.target.group?first(drop.target.group):drop.target.session;
  return !!from&&!!to&&kind(from)===kind(to);
}
document.addEventListener('DOMContentLoaded',()=>{
  const grid=document.querySelector('#agent-grid');
  grid.addEventListener('dragstart',event=>{
    if(annotating||renamingGroup){event.preventDefault();return;}
    const toggle=event.target.closest('[data-group-toggle]');
    if(toggle){
      draggingGroup=toggle.dataset.groupToggle;
      event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggingGroup);
      toggle.closest('.nav-group').classList.add('dragging');return;
    }
    const row=event.target.closest('.session-row');if(!row||row.getAttribute('draggable')==='false'){event.preventDefault();return;}
    draggingSession=row.dataset.agentId;
    event.dataTransfer.effectAllowed='move';event.dataTransfer.setData('text/plain',draggingSession);
    row.closest('.session-entry').classList.add('dragging');
  });
  grid.addEventListener('dragover',event=>{
    if(!draggingSession&&!draggingGroup)return;
    const drop=sessionDropAt(event);
    grid.querySelectorAll('.drop-before,.drop-after,.drop-into').forEach(el=>el.classList.remove('drop-before','drop-after','drop-into'));
    if(!drop||!sameKind(drop))return;
    event.preventDefault();event.dataTransfer.dropEffect='move';
    drop.mark.classList.add(drop.markClass);
    const horizontal=matchMedia('(max-width:760px)').matches,box=grid.getBoundingClientRect();
    if(horizontal){if(event.clientX>box.right-30)grid.scrollLeft+=12;else if(event.clientX<box.left+30)grid.scrollLeft-=12;}
    else{if(event.clientY>box.bottom-35)grid.scrollTop+=12;else if(event.clientY<box.top+35)grid.scrollTop-=12;}
  });
  grid.addEventListener('drop',event=>{
    if(!draggingSession&&!draggingGroup)return;event.preventDefault();
    const drop=sessionDropAt(event);
    if(drop&&sameKind(drop))moveSession(drop.source,drop.target,drop.position);
    clearSessionDrag();render();
  });
  document.addEventListener('dragend',()=>{if(draggingSession||draggingGroup){clearSessionDrag();render();}});
  // Alt+↑/↓ moves a session one place, stepping out at a folder's edge and over a whole
  // folder rather than into it; on a folder header it moves the folder past its neighbour.
  grid.addEventListener('keydown',event=>{
    if(!event.altKey||!['ArrowUp','ArrowDown'].includes(event.key))return;
    const toggle=event.target.closest('[data-group-toggle]'),row=!toggle&&event.target.closest('.session-row');if(!row&&!toggle)return;
    event.preventDefault();
    const down=event.key==='ArrowDown',groups=sessionGroups(),live=orderedSessions(current()).filter(a=>!a.harness_internal);
    const ownGroup=toggle?groups.find(g=>g.id===toggle.dataset.groupToggle):groupOf(row.dataset.agentId,groups);
    const ids=live.map(a=>a.id),self=toggle?live.filter(a=>ownGroup?.ids.includes(a.id)).map(a=>a.id):[row.dataset.agentId];
    if(!self.length)return;
    const neighbour=live[down?ids.indexOf(self[self.length-1])+1:ids.indexOf(self[0])-1];
    const source=toggle?{group:ownGroup.id}:{session:self[0]};
    let target;
    if(!toggle&&ownGroup&&(!neighbour||groupOf(neighbour.id,groups)!==ownGroup))target={group:ownGroup.id};
    else if(!neighbour||!!neighbour.controller!==!!live.find(a=>a.id===self[0]).controller)return;
    else{const holder=groupOf(neighbour.id,groups);target=holder&&holder!==ownGroup?{group:holder.id}:{session:neighbour.id};}
    if(moveSession(source,target,down?'after':'before')){
      render();toast((toggle?'Group':'Session')+' moved '+(down?'down':'up'));
      document.querySelector(toggle?`[data-group-toggle="${CSS.escape(source.group)}"]`:`.session-row[data-agent-id="${CSS.escape(source.session)}"]`)?.focus({preventScroll:true});
    }
  });
});
