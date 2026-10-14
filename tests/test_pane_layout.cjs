const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const context=vm.createContext({document:{addEventListener(){}}});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../agent_desk/static/pane-layout.js'),'utf8'),context);
const run=source=>JSON.parse(JSON.stringify(vm.runInContext(source,context)));
const tile=(layout,count)=>run(`tilePanes(${JSON.stringify(layout)},${count})`);
const settle=(items,anchor=null)=>run(`settlePanes(${JSON.stringify(items)},${JSON.stringify(anchor)})`);
const box=(x,y,w,h)=>({x,y,w,h});
const overlaps=(a,b)=>a.x<b.x+b.w&&b.x<a.x+a.w&&a.y<b.y+b.h&&b.y<a.y+a.h;
function assertNoOverlap(rects,label){
  rects.forEach((a,i)=>rects.slice(i+1).forEach(b=>assert.ok(!overlaps(a,b),`${label}: ${JSON.stringify(a)} overlaps ${JSON.stringify(b)}`)));
}

test('there are five layouts and the 2 × 2 quadrants come first, as the default',()=>{
  const layouts=run('PANE_LAYOUTS');
  assert.equal(layouts.length,5);
  assert.equal(layouts[0].id,'grid');
  assert.deepEqual(tile('grid',4),[box(0,0,6,6),box(6,0,6,6),box(0,6,6,6),box(6,6,6,6)]);
  assert.equal(run('paneLayout("missing").id'),'grid');
});

test('fewer panes than a screen holds stretch to fill it',()=>{
  assert.deepEqual(tile('grid',1),[box(0,0,12,12)]);
  assert.deepEqual(tile('grid',2),[box(0,0,6,12),box(6,0,6,12)]);
  assert.deepEqual(tile('grid',3),[box(0,0,6,6),box(6,0,6,6),box(0,6,12,6)]);
  assert.deepEqual(tile('columns',2),[box(0,0,6,12),box(6,0,6,12)]);
  assert.deepEqual(tile('main',2),[box(0,0,8,12),box(8,0,4,12)]);
});

test('a layout repeats below the first screen instead of capping the pane count',()=>{
  // Two stacked rows: a third pane goes underneath, keeping a half-screen height.
  assert.deepEqual(tile('rows',3),[box(0,0,12,6),box(0,6,12,6),box(0,12,12,6)]);
  assert.deepEqual(tile('grid',5).at(-1),box(0,12,12,6));
  assert.deepEqual(tile('grid',6).slice(4),[box(0,12,6,6),box(6,12,6,6)]);
  assert.deepEqual(tile('columns',4).at(-1),box(0,12,12,12));
  assert.deepEqual(tile('grid-3',7).at(-1),box(0,12,12,6));
  assert.deepEqual(tile('main',5),[box(0,0,8,12),box(8,0,4,4),box(8,4,4,4),box(8,8,4,4),box(0,12,12,6)]);
});

test('every layout tiles 1 to 16 panes without overlap, inside the grid, filling the first screen',()=>{
  for(const {id,screen} of run('PANE_LAYOUTS'))for(let count=1;count<=16;count++){
    const rects=tile(id,count),label=`${id} × ${count}`;
    assert.equal(rects.length,count,label);
    for(const r of rects)assert.ok(run(`validPaneRect(${JSON.stringify(r)})`),`${label}: invalid ${JSON.stringify(r)}`);
    assertNoOverlap(rects,label);
    if(count<=screen)assert.equal(rects.reduce((sum,r)=>sum+r.w*r.h,0),144,`${label} leaves part of the screen empty`);
  }
});

test('growing a pane pushes the panes it covers below it',()=>{
  const start=tile('grid',4).map((r,i)=>({id:'abcd'[i],...r}));
  const grown=settle(start.map(item=>item.id==='a'?{...item,w:9}:item),'a');
  const by=Object.fromEntries(grown.map(({id,...r})=>[id,r]));
  assert.deepEqual(by.a,box(0,0,9,6),'the anchored pane moved');
  assert.deepEqual(by.b,box(6,6,6,6),'the covered pane did not move below');
  assert.deepEqual(by.c,box(0,6,6,6));
  assert.deepEqual(by.d,box(6,12,6,6));
  assertNoOverlap(grown,'grown');
});

test('shrinking a pane lets its neighbours rise and slide into the space',()=>{
  const start=tile('grid',4).map((r,i)=>({id:'abcd'[i],...r}));
  const by=Object.fromEntries(settle(start.map(item=>item.id==='a'?{...item,w:3}:item),'a').map(({id,...r})=>[id,r]));
  assert.deepEqual(by.b,box(3,0,6,6),'the pane beside it did not slide left, leaving a gap it can never fill');
  const taller=Object.fromEntries(settle(tile('rows',3).map((r,i)=>({id:'abc'[i],...r,...(i===0?{h:3}:{})})),'a').map(({id,...r})=>[id,r]));
  assert.deepEqual(taller.b,box(0,3,12,6),'the pane below did not rise');
  assert.deepEqual(taller.c,box(0,9,12,6));
});

const split=(start,id,w,h)=>{
  const result=run(`(()=>{const r=splitPaneResize(${JSON.stringify(start)},${JSON.stringify(id)},${w},${h});return {...r,settled:settlePanes(r.items,r.anchors)};})()`);
  return {...result,by:Object.fromEntries(result.settled.map(({id,...r})=>[id,r]))};
};
const named=(ids,rects)=>rects.map((r,i)=>({id:ids[i],...r}));

test('dragging the edge between two panes resizes both, so they still fill the screen',()=>{
  const start=named('ab',tile('grid',2));
  const wider=split(start,'a',8,12);
  assert.deepEqual(wider.by,{a:box(0,0,8,12),b:box(8,0,4,12)},'the neighbour was pushed instead of shrinking');
  assert.deepEqual(wider.anchors,['a','b']);
  const narrower=split(start,'a',4,12);
  assert.deepEqual(narrower.by,{a:box(0,0,4,12),b:box(4,0,8,12)},'the neighbour did not grow into the freed space');
});

test('the shared edge stops where the neighbour reaches its minimum size',()=>{
  const start=named('ab',tile('grid',2));
  const result=split(start,'a',11,12);
  assert.equal(result.w,9);
  assert.deepEqual(result.by,{a:box(0,0,9,12),b:box(9,0,3,12)});
  assert.equal(split(start,'a',1,12).w,3);
});

test('every pane beside a dragged edge follows it',()=>{
  const main=split(named('abcd',tile('main',4)),'a',6,12).by;
  assert.deepEqual(main,{a:box(0,0,6,12),b:box(6,0,6,4),c:box(6,4,6,4),d:box(6,8,6,4)});
  const rows=split(named('ab',tile('rows',2)),'a',12,8).by;
  assert.deepEqual(rows,{a:box(0,0,12,8),b:box(0,8,12,4)},'a bottom edge does not split the height');
});

test('in a grid only the dragged pane\'s row or column changes',()=>{
  const start=named('abcd',tile('grid',4));
  const by=split(start,'a',8,6).by;
  assert.deepEqual(by,{a:box(0,0,8,6),b:box(8,0,4,6),c:box(0,6,6,6),d:box(6,6,6,6)});
  const corner=split(start,'a',4,4).by;
  assert.deepEqual(corner.b,box(4,0,8,6),'the pane beside it did not take the freed width');
  assert.deepEqual(corner.c,box(0,6,6,6),'the pane below grew over the one beside it');
  assertNoOverlap(Object.values(corner),'shrunk corner');
  assert.deepEqual(split(start,'a',6,4).by.c,box(0,4,6,8),'the pane below did not take the freed height');
  assertNoOverlap(split(start,'a',9,9).settled,'grown corner');
});

test('panes ending at the same edge of a larger neighbour move with the dragged one',()=>{
  // b is as tall as a and c together, so its left edge is one edge shared by all three.
  const start=[{id:'a',...box(0,0,6,6)},{id:'b',...box(6,0,6,12)},{id:'c',...box(0,6,6,6)}];
  for(const id of ['a','c']){
    const result=split(start,id,4,6);
    assert.deepEqual(result.by,{a:box(0,0,4,6),b:box(4,0,8,12),c:box(0,6,4,6)},'dragging '+id);
    assertNoOverlap(result.settled,'narrower from '+id);
  }
  assert.deepEqual(split(start,'a',8,6).by,{a:box(0,0,8,6),b:box(8,0,4,12),c:box(0,6,8,6)});
  assert.deepEqual(split(start,'a',11,6).by.b,box(9,0,3,12),'the neighbour went below its smallest size');
  // The same across: one wide pane under two.
  const wide=[{id:'a',...box(0,0,6,9)},{id:'b',...box(6,0,6,9)},{id:'c',...box(0,9,12,3)}];
  assert.deepEqual(split(wide,'b',6,6).by,{a:box(0,0,6,6),b:box(6,0,6,6),c:box(0,6,12,6)});
  assert.deepEqual(split(wide,'a',6,1).by,{a:box(0,0,6,3),b:box(6,0,6,3),c:box(0,3,12,9)},'the panes above went below their smallest size');
  // A pane already under the smallest size is not what stops the edge.
  const short=[{id:'a',...box(0,0,6,9)},{id:'b',...box(6,0,6,9)},{id:'c',...box(0,9,12,3)},{id:'d',...box(0,12,12,6)}];
  assert.deepEqual(split(short,'a',6,10).by.c,box(0,9,12,3),'the wide pane was squeezed under its smallest size');
});

test('a pane with free space beside it grows into it without moving anything',()=>{
  const start=[{id:'a',...box(0,0,4,12)},{id:'b',...box(6,0,6,12)}];
  const result=split(start,'a',6,12);
  assert.deepEqual(result.by,{a:box(0,0,6,12),b:box(6,0,6,12)});
});

const resolve=(rects,ids,layout='grid')=>run(`(()=>{paneLayoutId=${JSON.stringify(layout)};paneRects=${JSON.stringify(rects)};return {rects:resolvePaneRects(${JSON.stringify(ids)}),kept:paneRects};})()`);
const covers=(rects,label)=>{
  const list=Object.values(rects);assertNoOverlap(list,label);
  assert.equal(run(`paneGapCells(${JSON.stringify(list)})`),0,label+' leaves dead space: '+JSON.stringify(rects));
};

test('switching the agent in a resized pane keeps the pane where it was and as big',()=>{
  const ids=run(`(()=>{paneRects={a:{x:0,y:0,w:8,h:12},b:{x:8,y:0,w:4,h:12}};handOverPaneRect('b','c');return paneRects;})()`);
  assert.deepEqual(ids,{a:box(0,0,8,12),c:box(8,0,4,12)});
  const {rects}=resolve(ids,['a','c']);
  assert.deepEqual(rects,{a:box(0,0,8,12),c:box(8,0,4,12)});
  assert.deepEqual(run(`(()=>{paneRects=null;handOverPaneRect('a','b');return paneRects;})()`),null,'an untouched layout gained sizes');
});

test('an agent that arrives without a size never leaves the screen part empty',()=>{
  // What switching did before: the replaced pane's size was dropped and the newcomer took a
  // 6 × 6 cell below the screen, leaving four empty columns beside the first pane.
  const {rects}=resolve({a:box(0,0,8,12),b:box(8,0,4,12)},['a','c']);
  covers(rects,'newcomer');
  assert.deepEqual(rects.a,box(0,0,12,12),'the first pane did not widen into the empty columns');
});

test('closing a pane in a resized layout lets the others fill its space',()=>{
  const start={a:box(0,0,6,8),b:box(6,0,6,6),c:box(0,8,6,4),d:box(6,6,6,6)};
  for(const gone of 'abcd'){const ids=[...'abcd'].filter(id=>id!==gone);covers(resolve(start,ids).rects,'without '+gone);}
  covers(resolve({a:box(0,0,9,12),b:box(9,0,3,12)},['a']).rects,'last pane');
  assert.deepEqual(resolve({a:box(0,0,9,12),b:box(9,0,3,12)},['a']).rects.a,box(0,0,12,12));
});

test('a pane added to a resized layout fills its row below the screen',()=>{
  const {rects}=resolve({a:box(0,0,8,12),b:box(8,0,4,12)},['a','b','c']);
  covers(rects,'added');
  assert.deepEqual(rects.c,box(0,12,12,6));
});

test('stored sizes with gaps from older versions are filled when they load',()=>{
  covers(resolve({a:box(0,0,4,12),b:box(0,12,6,12)},['a','b']).rects,'old push-below layout');
  covers(resolve({a:box(0,0,4,4)},['a']).rects,'shrunken single pane');
});

test('a hole no single pane can grow into tiles the layout afresh',()=>{
  const pinwheel={t:box(0,0,8,4),r:box(8,0,4,8),b:box(4,8,8,4),l:box(0,4,4,8)};
  assert.ok(run(`paneGapCells(fillPaneGaps(${JSON.stringify(Object.entries(pinwheel).map(([id,r])=>({id,...r})))}))`)>0,'the fixture is not a pinwheel');
  const {rects,kept}=resolve(pinwheel,['t','r','b','l']);
  assert.equal(kept,null,'the layout was not reset');
  assert.deepEqual(Object.values(rects),tile('grid',4));
});

test('a gap opened by a drag is filled by the other panes before the dragged one',()=>{
  const items=[{id:'a',...box(0,0,6,12)},{id:'b',...box(6,0,6,12)},{id:'c',...box(0,12,12,6)}];
  const filled=run(`fillPaneGaps(${JSON.stringify([{...items[0],w:4},items[1],items[2]])},['a'])`);
  assert.deepEqual(filled.map(({id,...r})=>[id,r]),[['a',box(0,0,4,12)],['b',box(4,0,8,12)],['c',box(0,12,12,6)]]);
  assert.deepEqual(run(`fillPaneGaps(${JSON.stringify([{...items[0],h:9},items[1]])},['a'])`)[0],{id:'a',...box(0,0,6,12)},'only the dragged pane could fill the gap, and did not');
});

test('a pane opened into a resized layout takes the first free cell',()=>{
  const items=[{id:'a',...box(0,0,6,12)},{id:'b',...box(6,0,6,6)}];
  assert.deepEqual(run(`freePaneSlot(${JSON.stringify(items)},6,6)`),box(6,6,6,6));
  assert.deepEqual(run(`freePaneSlot(${JSON.stringify([...items,{id:'c',...box(6,6,6,6)}])},6,6)`),box(0,12,6,6));
});

test('stored sizes are validated before they are trusted',()=>{
  for(const bad of [null,box(-1,0,6,6),box(0,0,13,6),box(7,0,6,6),box(0,0,0,6),box(0,0,6,25),box(.5,0,6,6)])
    assert.equal(run(`validPaneRect(${JSON.stringify(bad)})`),false,JSON.stringify(bad));
  assert.equal(run(`validPaneRect(${JSON.stringify(box(6,30,6,24))})`),true);
});
