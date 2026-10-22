// Pane layouts. The workspace is a 12-column grid whose row unit is a twelfth of its
// visible height, so a layout describes one screen and any further rows scroll below it.
// A layout is a pattern rather than a pane count: panes fill it in order and the pattern
// repeats as more open. Resizing a pane switches to explicit sizes; the other panes move
// out of its way and rise into any gap, and picking a layout again tiles everything afresh.
// Panes that share the dragged edge give or take the difference, so the row still fills.
// Whatever changes, the panes cover the whole width and at least one screen: no dead space.
const PANE_GRID=12,PANE_MIN=3,PANE_MAX_ROWS=24,PANE_LIMIT=16;
const PANE_LAYOUTS=[
  {id:'grid',label:'2 × 2',cols:2,rows:2,screen:4,growth:'Four quadrants. More panes add rows of two below.'},
  {id:'rows',label:'Rows',cols:1,rows:2,screen:2,growth:'Two stacked rows. Each new pane is added below.'},
  {id:'columns',label:'Columns',cols:3,rows:1,screen:3,growth:'Three side by side. More panes start a new row below.'},
  {id:'grid-3',label:'3 × 2',cols:3,rows:2,screen:6,growth:'Six panes. More panes add rows of three below.'},
  {id:'main',label:'Main + side',screen:4,growth:'One large pane with three beside it. More panes add rows of three below.'},
];
function paneLayout(id){return PANE_LAYOUTS.find(layout=>layout.id===id)||PANE_LAYOUTS[0];}
// Panes fill rows left to right; a row that is not full shares its width evenly.
function tilePaneRows(count,cols,rowHeight,top){
  return Array.from({length:count},(_,i)=>{
    const row=Math.floor(i/cols),inRow=Math.min(cols,count-row*cols),w=PANE_GRID/inRow;
    return {x:(i%cols)*w,y:top+row*rowHeight,w,h:rowHeight};
  });
}
// Fewer rows than a screen holds stretch to fill it; more rows keep a screen's row height.
function tilePanes(layoutId,count){
  const layout=paneLayout(layoutId);
  if(layout.id==='main'){
    if(count<2)return tilePaneRows(count,1,PANE_GRID,0);
    const side=Math.min(count-1,3),h=PANE_GRID/side;
    return [{x:0,y:0,w:8,h:PANE_GRID},...Array.from({length:side},(_,i)=>({x:8,y:i*h,w:4,h})),...tilePaneRows(count-1-side,3,6,PANE_GRID)];
  }
  const rows=Math.ceil(count/layout.cols);
  return tilePaneRows(count,layout.cols,PANE_GRID/Math.max(1,Math.min(rows,layout.rows)),0);
}
const rectsOverlap=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
// Anything the anchored panes now cover is pushed below them, and every other pane, in
// reading order, rises and slides left as far as it can. Free space therefore collects at
// the right and bottom, where a pane can grow into it: panes only resize right and down.
function settlePanes(items,anchors=[]){
  const ids=[].concat(anchors);
  const placed=items.filter(item=>ids.includes(item.id)).map(item=>({...item}));
  const free=rect=>!placed.some(other=>rectsOverlap(rect,other));
  for(const item of items.filter(item=>!ids.includes(item.id)).sort((a,b)=>a.y-b.y||a.x-b.x)){
    const rect={...item};
    for(let moved=true;moved;){
      moved=false;
      while(rect.y>0&&free({...rect,y:rect.y-1})){rect.y--;moved=true;}
      while(rect.x>0&&free({...rect,x:rect.x-1})){rect.x--;moved=true;}
    }
    for(let hit;(hit=placed.find(other=>rectsOverlap(rect,other)));)rect.y=hit.y+hit.h;
    placed.push(rect);
  }
  return placed;
}
// The first spot, top to bottom then left to right, where a pane of this size fits.
function freePaneSlot(items,w,h){
  for(let y=0;;y++)for(let x=0;x+w<=PANE_GRID;x++){const rect={x,y,w,h};if(!items.some(item=>rectsOverlap(rect,item)))return rect;}
}
// Panes grow into any empty space left beside them, one whole row or column of cells at a
// time, until they cover the full width and every row down to the end of the first screen
// or the lowest pane. Widening comes before growing taller, so a short row fills its own
// width instead of a tall pane beside it stretching down. Panes listed in `last` grow only
// when nothing else can fill a gap.
function fillPaneGaps(items,last=[]){
  const rects=items.map(item=>({...item})),bottom=Math.max(PANE_GRID,...rects.map(r=>r.y+r.h));
  const empty=(x,y,w,h)=>x>=0&&y>=0&&x+w<=PANE_GRID&&y+h<=bottom&&!rects.some(other=>rectsOverlap({x,y,w,h},other));
  const wider=r=>empty(r.x+r.w,r.y,1,r.h)?(r.w++,true):empty(r.x-1,r.y,1,r.h)?(r.x--,r.w++,true):false;
  const taller=r=>r.h>=PANE_MAX_ROWS?false:empty(r.x,r.y+r.h,r.w,1)?(r.h++,true):empty(r.x,r.y-1,r.w,1)?(r.y--,r.h++,true):false;
  for(const group of [rects.filter(r=>!last.includes(r.id)),rects.filter(r=>last.includes(r.id))])
    for(let grew=true;grew;)grew=group.filter(wider).length>0||group.filter(taller).length>0;
  return rects;
}
// Cells of that area no pane covers. Panes never overlap, so this is area arithmetic.
function paneGapCells(items){
  const bottom=Math.max(PANE_GRID,...items.map(r=>r.y+r.h));
  return PANE_GRID*bottom-items.reduce((sum,r)=>sum+r.w*r.h,0);
}
const validPaneRect=r=>!!r&&[r.x,r.y,r.w,r.h].every(Number.isInteger)&&r.x>=0&&r.y>=0&&r.w>=1&&r.h>=1&&r.x+r.w<=PANE_GRID&&r.h<=PANE_MAX_ROWS;

// The chosen layout is a preference for this browser; explicit sizes belong to the open
// panes, so they live in session storage next to the pane list.
let paneLayoutId=PANE_LAYOUTS[0].id,paneRects=null,paneResize=null;
// Each desk has its own layout, as it has its own panes.
function loadPaneLayout(){try{paneLayoutId=paneLayout(localStorage.getItem(deskScoped('agent-desk-pane-layout'))).id;}catch{paneLayoutId=PANE_LAYOUTS[0].id;}}
const paneRectsKey=()=>'agent-desk-pane-rects-'+(demo?'demo':deskScoped('live'));
function loadPaneRects(){
  try{const saved=JSON.parse(sessionStorage.getItem(paneRectsKey())||'null');
    paneRects=saved&&typeof saved==='object'&&Object.values(saved).every(validPaneRect)?saved:null;}
  catch{paneRects=null;}
}
function savePaneRects(){try{if(paneRects)sessionStorage.setItem(paneRectsKey(),JSON.stringify(paneRects));else sessionStorage.removeItem(paneRectsKey());}catch{}}
// Explicit sizes for every open pane. Closed panes are dropped and the rest rise into their
// space; a newly opened pane takes the layout's cell size at the first spot it fits. Then the
// panes grow to fill any gap; one that no pane can grow into whole (a pinwheel of four panes
// around a hole) tiles the layout afresh rather than leave dead space.
function resolvePaneRects(ids){
  const tiled=()=>Object.fromEntries(tilePanes(paneLayoutId,ids.length).map((rect,i)=>[ids[i],rect]));
  if(!paneRects)return tiled();
  const layout=paneLayout(paneLayoutId),cell=tilePanes(layout.id,layout.screen).at(-1);
  const items=settlePanes(ids.filter(id=>paneRects[id]).map(id=>({id,...paneRects[id]})));
  for(const id of ids)if(!paneRects[id])items.push({id,...freePaneSlot(items,cell.w,cell.h)});
  const filled=fillPaneGaps(items);
  if(paneGapCells(filled)){paneRects=null;savePaneRects();return tiled();}
  paneRects=Object.fromEntries(filled.map(({id,...rect})=>[id,rect]));
  return paneRects;
}
// A pane switched to another agent keeps its place and size; the new agent takes it over.
function handOverPaneRect(from,to){
  if(!paneRects?.[from]||from===to)return;
  paneRects[to]=paneRects[from];delete paneRects[from];savePaneRects();
}
// Pane order follows reading order, so the keyboard, the DOM and screen readers agree with
// what is on screen.
function sortPanesByLayout(){
  if(!paneRects)return;
  openPaneIds.sort((a,b)=>(paneRects[a]?.y??0)-(paneRects[b]?.y??0)||(paneRects[a]?.x??0)-(paneRects[b]?.x??0));
}
const reducedMotion=()=>window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
// Places every pane in its grid cell. With animate, panes that move glide from where they
// were (they are translated, never scaled, so the terminal inside is never distorted).
// The held pane is placed directly: it is tracking the pointer.
function applyPaneLayout({animate=false,held=[]}={}){
  const workspace=$('#terminal');if(!workspace)return;
  const rects=resolvePaneRects(openPaneIds);
  // Only panes already placed glide; a pane that just opened appears in its cell.
  const before=animate&&!reducedMotion()?new Map([...paneViews].filter(([,view])=>view.node.style.gridArea).map(([id,view])=>[id,view.node.getBoundingClientRect()])):null;
  let bottom=0;
  for(const id of openPaneIds){
    const view=paneViews.get(id),rect=rects[id];if(!view||!rect)continue;
    view.node.style.gridArea=view.edges.style.gridArea=`${rect.y+1} / ${rect.x+1} / span ${rect.h} / span ${rect.w}`;
    bottom=Math.max(bottom,rect.y+rect.h);
  }
  workspace.classList.toggle('pane-overflow',bottom>PANE_GRID);
  updatePanesBelow();
  if(!before)return;
  for(const [id,old] of before){
    if(held.includes(id))continue;
    const node=paneViews.get(id)?.node;if(!node)continue;
    const now=node.getBoundingClientRect(),dx=old.left-now.left,dy=old.top-now.top;
    if(Math.abs(dx)<.5&&Math.abs(dy)<.5)continue;
    node.reflow?.cancel();
    node.reflow=node.animate([{transform:`translate(${dx}px,${dy}px)`},{transform:'none'}],{duration:200,easing:'cubic-bezier(.2,.7,.3,1)'});
  }
}
// The row unit is a twelfth of the visible height, less the gaps between rows.
function measurePaneRows(){
  const workspace=$('#terminal');if(!workspace?.clientHeight)return;
  const gap=parseFloat(getComputedStyle(workspace).rowGap)||0;
  workspace.style.setProperty('--pane-row',Math.max(8,(workspace.clientHeight-gap*(PANE_GRID-1))/PANE_GRID)+'px');
}
// Overlay scrollbars stay hidden until you scroll, so say when panes are out of sight below.
function panesBelow(){
  const workspace=$('#terminal');if(!workspace.clientHeight)return [];
  const limit=workspace.getBoundingClientRect().bottom+1;
  return openPaneIds.map(id=>paneViews.get(id)?.node).filter(node=>node&&node.getBoundingClientRect().bottom>limit);
}
function updatePanesBelow(){
  const pill=$('#panes-below');if(!pill)return;
  const hidden=paneMode===null||fullscreenPaneId?[]:panesBelow();
  // Count only panes that start out of sight; ones merely cut off at the bottom are visible.
  const limit=$('#terminal').getBoundingClientRect().bottom-1,below=hidden.filter(node=>node.getBoundingClientRect().top>=limit).length;
  pill.hidden=!hidden.length;
  pill.querySelector('span').textContent=!below?'More below':below===1?'1 pane below':below+' panes below';
}
function paneGridStep(){
  const workspace=$('#terminal'),style=getComputedStyle(workspace),gap=parseFloat(style.columnGap)||0;
  return {col:(workspace.clientWidth-gap*(PANE_GRID-1))/PANE_GRID+gap,row:parseFloat(style.getPropertyValue('--pane-row'))+gap};
}
function choosePaneLayout(id){
  paneLayoutId=paneLayout(id).id;paneRects=null;
  try{localStorage.setItem(deskScoped('agent-desk-pane-layout'),paneLayoutId);}catch{}
  savePaneRects();applyPaneLayout({animate:true});syncPaneOrder();savePanes();renderLayoutPicker();
}

// --- Resizing ------------------------------------------------------------------------
// Each pane has a right edge, a bottom edge and a corner. A drag snaps the pane to whole
// grid cells and moves the edge it shares with its neighbours, as a split view does: a pane
// that starts at that edge, beside the dragged one, keeps its far edge and gives or takes
// the difference, down to PANE_MIN cells, where the edge stops. A neighbour that would
// cover another pane by growing holds its place. Panes the drag still covers move below it and
// the rest rise into freed space. Terminals inside are refitted once the pointer is released.
// The panes that share the dragged edge. A neighbour wider than the dragged pane also touches
// the panes beside it, so those end at the same edge and move with it: the top edge of a
// full-width bottom pane is one edge, whichever pane above it is dragged.
function paneEdgeGroup(start,origin,pos,size,cross,span){
  const line=origin[pos]+origin[size],touch=(a,b)=>a[cross]<b[cross]+b[span]&&b[cross]<a[cross]+a[span];
  const before=[origin],after=[];
  for(let grew=true;grew;){
    grew=false;
    for(const item of start){
      if(item[pos]===line&&!after.includes(item)&&before.some(other=>touch(other,item))){after.push(item);grew=true;}
      if(item[pos]+item[size]===line&&!before.includes(item)&&after.some(other=>touch(other,item))){before.push(item);grew=true;}
    }
  }
  return {before:before.slice(1),after};
}
function splitPaneResize(start,id,w,h){
  const origin=start.find(item=>item.id===id);
  const across=paneEdgeGroup(start,origin,'x','w','y','h'),down=paneEdgeGroup(start,origin,'y','h','x','w');
  const room=(items,pos,size)=>Math.min(...items.map(item=>item[pos]+item[size]-Math.min(PANE_MIN,item[size])));
  // Panes ending at the same edge shrink with the dragged one, each down to PANE_MIN.
  const least=(items,size)=>Math.max(PANE_MIN,...items.map(item=>origin[size]-item[size]+Math.min(PANE_MIN,item[size])));
  w=Math.max(least(across.before,'w'),Math.min(PANE_GRID-origin.x,room(across.after,'x','w')-origin.x,w));
  h=Math.max(least(down.before,'h'),Math.min(PANE_MAX_ROWS,room(down.after,'y','h')-origin.y,h));
  const dw=w-origin.w,dh=h-origin.h,moved=new Map();
  const change=(item,edit)=>{if(!moved.has(item.id))moved.set(item.id,{...item});edit(moved.get(item.id));};
  if(dw){across.before.forEach(item=>change(item,rect=>{rect.w+=dw;}));across.after.forEach(item=>change(item,rect=>{rect.x+=dw;rect.w-=dw;}));}
  if(dh){down.before.forEach(item=>change(item,rect=>{rect.h+=dh;}));down.after.forEach(item=>change(item,rect=>{rect.y+=dh;rect.h-=dh;}));}
  const next=new Map(start.map(item=>[item.id,item]));next.set(id,{...origin,w,h});
  // One that would cover another pane by moving holds its place. Panes giving up space go first,
  // so the ones taking it are checked against where those ended up.
  const proposed=[];
  for(let waiting=[...moved.values()],placed=true;placed&&waiting.length;){
    placed=false;
    for(const item of waiting.slice())if([...next.values()].every(other=>other.id===item.id||!rectsOverlap(item,other))){
      next.set(item.id,item);proposed.push(item);waiting.splice(waiting.indexOf(item),1);placed=true;}
  }
  return {w,h,items:[...next.values()],anchors:[id,...proposed.map(item=>item.id)]};
}
function resizePaneTo(state,w,h){
  const split=splitPaneResize(state.start,state.id,w,h);
  if(split.w===state.w&&split.h===state.h)return false;
  // Gaps the drag opens are filled by the other panes first; a step that would leave one
  // nothing can fill is not taken, so the edge stays where it was.
  const items=fillPaneGaps(settlePanes(split.items,split.anchors),[state.id]);
  if(paneGapCells(items))return false;
  state.w=split.w;state.h=split.h;
  paneRects=Object.fromEntries(items.map(({id,...rect})=>[id,rect]));
  // The panes whose edge follows the pointer are placed directly; the rest glide.
  applyPaneLayout({animate:true,held:split.anchors});
  return true;
}
function beginPaneResize(id,extra={}){
  const rects=resolvePaneRects(openPaneIds);
  paneRects={...rects};
  const origin=rects[id];
  return {id,origin,w:origin.w,h:origin.h,start:openPaneIds.map(pane=>({id:pane,...rects[pane]})),...extra};
}
function finishPaneResize(state){
  const node=paneViews.get(state.id)?.node;
  node?.classList.remove('pane-resizing');const edges=paneViews.get(state.id)?.edges;if(edges)delete edges.dataset.active;
  document.body.classList.remove('pane-resizing-active');
  document.body.style.removeProperty('--pane-resize-cursor');
  sortPanesByLayout();syncPaneOrder();savePanes();savePaneRects();renderLayoutPicker();
}
document.addEventListener('DOMContentLoaded',()=>{
  const workspace=$('#terminal');
  new ResizeObserver(()=>{measurePaneRows();updatePanesBelow();}).observe(workspace);measurePaneRows();
  workspace.addEventListener('scroll',updatePanesBelow,{passive:true});
  // Brings the first pane that is cut off to the top of the workspace.
  $('#panes-below').onclick=()=>{
    const first=panesBelow()[0];if(!first)return;
    workspace.scrollBy({top:first.getBoundingClientRect().top-workspace.getBoundingClientRect().top,behavior:reducedMotion()?'auto':'smooth'});
  };
  // While panes run past the screen, the wheel scrolls the focused pane's terminal and the
  // workspace everywhere else. A gesture keeps the target it started on, so a pane sliding under
  // the pointer mid-scroll never catches it; Option scrolls the workspace from anywhere.
  let wheelTarget=null,wheelIdle=0;
  workspace.addEventListener('wheel',event=>{
    clearTimeout(wheelIdle);wheelIdle=setTimeout(()=>{wheelTarget=null;},250);
    if(!workspace.classList.contains('pane-overflow')||fullscreenPaneId){wheelTarget=null;return;}
    if(!wheelTarget){const pane=event.target.closest('.terminal-pane');wheelTarget=!event.altKey&&pane&&paneViews.get(selectedId)?.node===pane?pane:workspace;}
    if(wheelTarget!==workspace||Math.abs(event.deltaX)>Math.abs(event.deltaY))return;
    event.stopPropagation();
  },{capture:true,passive:true});
  workspace.addEventListener('pointerdown',event=>{
    const handle=event.target.closest('.pane-resize');
    if(!handle||paneResize||annotating||event.pointerType==='mouse'&&event.button!==0)return;
    const id=handle.closest('.pane-edges')?.dataset.edgesFor;if(!openPaneIds.includes(id))return;
    selectedId=id;highlightPanes();
    event.preventDefault();event.stopPropagation();
    try{handle.setPointerCapture(event.pointerId);}catch{}
    paneResize=beginPaneResize(id,{edge:handle.dataset.edge,handle,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:event.clientX,y:event.clientY,pull:0,scroll:workspace.scrollTop,step:paneGridStep()});
    paneViews.get(id).node.classList.add('pane-resizing');paneViews.get(id).edges.dataset.active=handle.dataset.edge;document.body.classList.add('pane-resizing-active');
    document.body.style.setProperty('--pane-resize-cursor',getComputedStyle(handle).cursor);
  });
  const dragPaneEdge=state=>{
    const dx=state.x-state.startX,dy=state.y-state.startY+workspace.scrollTop-state.scroll+state.pull;
    resizePaneTo(state,state.edge==='s'?state.origin.w:state.origin.w+Math.round(dx/state.step.col),state.edge==='e'?state.origin.h:state.origin.h+Math.round(dy/state.step.row));
  };
  // Holding the pointer at the bottom of the workspace keeps growing the pane, so a pane on the
  // bottom row can be made taller with no screen left to drag into. The workspace scrolls with
  // it; where there is nothing to scroll yet, the hold counts as if the pointer had kept going.
  const pullPaneEdge=()=>{
    const state=paneResize;if(!state)return;
    if(state.edge!=='e'&&state.y>state.startY+4&&state.y>workspace.getBoundingClientRect().bottom-28&&state.h<PANE_MAX_ROWS){
      const before=workspace.scrollTop;workspace.scrollTop+=4;
      state.pull+=4-(workspace.scrollTop-before);dragPaneEdge(state);
    }
    state.frame=requestAnimationFrame(pullPaneEdge);
  };
  document.addEventListener('pointermove',event=>{
    const state=paneResize;if(!state||event.pointerId!==state.pointerId)return;
    event.preventDefault();
    state.x=event.clientX;state.y=event.clientY;
    if(state.frame===undefined)state.frame=requestAnimationFrame(pullPaneEdge);
    dragPaneEdge(state);
  });
  const end=event=>{const state=paneResize;if(!state||event.pointerId!==state.pointerId)return;paneResize=null;cancelAnimationFrame(state.frame);try{state.handle.releasePointerCapture(state.pointerId);}catch{}finishPaneResize(state);};
  document.addEventListener('pointerup',end);document.addEventListener('pointercancel',end);
  // Arrow keys on a focused corner resize by one cell.
  workspace.addEventListener('keydown',event=>{
    const handle=event.target.closest('.pane-resize');if(!handle)return;
    const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;
    event.preventDefault();event.stopPropagation();
    const state=beginPaneResize(handle.closest('.pane-edges').dataset.edgesFor);
    resizePaneTo(state,state.w+delta[0],state.h+delta[1]);finishPaneResize(state);
    paneViews.get(state.id)?.edges.querySelector('.pane-resize[data-edge=se]')?.focus();
  });
  const button=$('#pane-layout-button'),menu=$('#pane-layout-menu');
  const close=()=>{menu.hidden=true;button.setAttribute('aria-expanded','false');};
  button.onclick=()=>{const open=menu.hidden;menu.hidden=!open;button.setAttribute('aria-expanded',String(open));if(open)menu.querySelector('[aria-checked=true]')?.focus();};
  menu.onclick=event=>{const option=event.target.closest('[data-layout]');if(!option)return;choosePaneLayout(option.dataset.layout);close();button.focus();};
  menu.addEventListener('keydown',event=>{
    const options=[...menu.querySelectorAll('[data-layout]')],index=options.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();close();button.focus();}
    else if(['ArrowRight','ArrowDown','ArrowLeft','ArrowUp'].includes(event.key)){event.preventDefault();const step=['ArrowRight','ArrowDown'].includes(event.key)?1:-1;options[(index+step+options.length)%options.length].focus();}
  });
  document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.target.closest('.layout-picker'))close();});
  renderLayoutPicker();
});
// A small drawing of one screen of the layout, from the same tiling the workspace uses.
function layoutGlyph(layoutId,count){
  return `<svg class="layout-glyph" viewBox="0 0 48 32" aria-hidden="true">${tilePanes(layoutId,count).map(r=>`<rect x="${(r.x*4+1).toFixed(2)}" y="${(r.y*32/12+1).toFixed(2)}" width="${(r.w*4-2).toFixed(2)}" height="${(r.h*32/12-2).toFixed(2)}" rx="1.6"/>`).join('')}</svg>`;
}
// Rebuilt only when the layout or its resized state changes: the workspace re-renders every
// few seconds, and rebuilding an open menu would take keyboard focus away from it.
let layoutPickerState='';
function renderLayoutPicker(){
  const button=$('#pane-layout-button'),menu=$('#pane-layout-menu');if(!button||!menu)return;
  const layout=paneLayout(paneLayoutId),state=layout.id+(paneRects?':resized':'');
  if(state===layoutPickerState)return;layoutPickerState=state;
  button.querySelector('.layout-glyph')?.remove();button.insertAdjacentHTML('afterbegin',layoutGlyph(layout.id,layout.screen));
  $('#pane-layout-label').textContent=layout.label;
  $('#pane-layout-custom').hidden=!paneRects;
  button.title=paneRects?'Pane layout · resized. Choose a layout to reset sizes.':'Pane layout';
  menu.innerHTML=`<div class="layout-options">${PANE_LAYOUTS.map(item=>`<button type="button" role="menuitemradio" class="layout-option" data-layout="${item.id}" aria-checked="${item.id===layout.id}" title="${escapeHTML(item.growth)}">${layoutGlyph(item.id,item.screen)}<span>${escapeHTML(item.label)}</span></button>`).join('')}</div><p class="layout-note">${escapeHTML(layout.growth)}${paneRects?' Choose it again to reset pane sizes.':' Drag a pane edge to resize it.'}</p>`;
}
