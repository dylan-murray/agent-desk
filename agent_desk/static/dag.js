// Shared DAG surface. Nodes are real buttons; edges never imply inferred lineage.
function drawDeskDAG(container,nodes,edges,onSelect){
  const signature=JSON.stringify([nodes,edges]);if(container.dataset.signature===signature)return;container.dataset.signature=signature;
  const scroll={left:container.scrollLeft,top:container.scrollTop};container.replaceChildren();
  if(!nodes.length){const empty=document.createElement('p');empty.className='special-empty';empty.textContent='No nodes yet. Start an agent or add tasks to a workflow.';container.append(empty);return;}
  const known=new Set(nodes.map(n=>n.id)),levels=new Map();let pending=nodes.slice();
  for(let pass=0;pass<=nodes.length&&pending.length;pass++){
    const ready=pending.filter(n=>edges.filter(e=>e.to===n.id&&known.has(e.from)).every(e=>levels.has(e.from)));
    if(!ready.length){for(const n of pending)levels.set(n.id,0);break;}
    for(const n of ready){const parents=edges.filter(e=>e.to===n.id&&levels.has(e.from));levels.set(n.id,parents.length?Math.max(...parents.map(e=>levels.get(e.from)))+1:0);}
    const ids=new Set(ready.map(n=>n.id));pending=pending.filter(n=>!ids.has(n.id));
  }
  const counts={},positions=new Map();for(const n of nodes){const level=levels.get(n.id)||0,row=counts[level]||0;counts[level]=row+1;positions.set(n.id,{x:28+level*300,y:28+row*142});}
  const board=document.createElement('div');board.className='dag-board';board.style.zoom=container.dataset.zoom||'1';board.style.width=(Math.max(...Object.values(Object.fromEntries(levels)))*300+310)+'px';board.style.height=(Math.max(...Object.values(counts))*142+35)+'px';
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.classList.add('dag-edges');
  for(const e of edges){const a=positions.get(e.from),b=positions.get(e.to);if(!a||!b)continue;const path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',`M ${a.x+246} ${a.y+48} C ${a.x+277} ${a.y+48}, ${b.x-31} ${b.y+48}, ${b.x} ${b.y+48}`);if(e.kind==='delegated')path.setAttribute('stroke-dasharray','5 5');svg.append(path);const arrow=document.createElementNS(svg.namespaceURI,'path');arrow.setAttribute('d',`M ${b.x-7} ${b.y+44} L ${b.x} ${b.y+48} L ${b.x-7} ${b.y+52}`);svg.append(arrow);}
  board.append(svg);
  for(const node of nodes){const pos=positions.get(node.id),button=document.createElement('button');button.className='dag-node';button.dataset.nodeId=node.id;button.dataset.status=node.status||'unknown';button.style.left=pos.x+'px';button.style.top=pos.y+'px';button.title=node.detail||node.title;
    for(const [tag,txt,cls] of [['span',node.status||'unknown','dag-state'],['strong',node.title,''],['span',node.detail||'','dag-description']]){const el=document.createElement(tag);el.textContent=txt;el.className=cls;button.append(el);}button.onclick=()=>onSelect(node.id);board.append(button);}
  container.append(board);container.scrollLeft=scroll.left;container.scrollTop=scroll.top;
}
