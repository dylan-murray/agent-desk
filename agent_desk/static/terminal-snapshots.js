// Per-tab screen checkpoints pair rendered state with the exact consumed byte offset.
const terminalSnapshotPrefix='agent-desk-screen-v1-';
function readTerminalSnapshot(id){
  try{const value=JSON.parse(sessionStorage.getItem(terminalSnapshotPrefix+id));
    return value&&typeof value.screen==='string'&&Number.isSafeInteger(value.cursor)&&value.cursor>=0&&Number.isInteger(value.cols)&&value.cols>=2&&value.cols<=500&&Number.isInteger(value.rows)&&value.rows>=1&&value.rows<=300?value:null;
  }catch{return null;}
}
function storeTerminalSnapshot(id,snapshot){
  try{sessionStorage.setItem(terminalSnapshotPrefix+id,JSON.stringify(snapshot));return true;}catch{return false;}
}
// Don't checkpoint halfway through UTF-8 or an ANSI control sequence: serialization
// preserves screen state, but not a parser's incomplete sequence.
class TerminalStreamBoundary{
  constructor(){this.state='ground';this.utf8=0;this.decoder=new TextDecoder();}
  feed(bytes){
    for(const byte of bytes){if(byte>=0xc2&&byte<=0xf4)this.utf8=byte<0xe0?1:byte<0xf0?2:3;else if(byte>=0x80&&byte<=0xbf)this.utf8=Math.max(0,this.utf8-1);else this.utf8=0;}
    for(const char of this.decoder.decode(bytes,{stream:true})){
      const code=char.codePointAt(0);
      if(code===0x18||code===0x1a){this.state='ground';continue;}
      if(this.state==='string'){if(code===7||code===0x9c)this.state='ground';else if(code===27)this.state='string-escape';continue;}
      if(this.state==='string-escape'){this.state=char==='\\'?'ground':'string';continue;}
      if(code===27){this.state='escape';continue;}
      if(code===0x9b){this.state='csi';continue;}
      if([0x90,0x98,0x9d,0x9e,0x9f].includes(code)){this.state='string';continue;}
      if(this.state==='escape'){
        if(char==='[')this.state='csi';else if(']PX^_'.includes(char))this.state='string';else if(code>=0x30&&code<=0x7e)this.state='ground';
      }else if(this.state==='csi'&&code>=0x40&&code<=0x7e)this.state='ground';
    }
  }
  get complete(){return this.state==='ground'&&this.utf8===0;}
}
// xterm 6.0's serialize addon saves visible cells but omits saved cursors and
// scrolling margins. TUIs use those on their next incremental redraw. Keep this
// adapter together with the pinned vendor version and its continuation tests.
function captureTerminalState(term){
  const core=term._core, buffers=core._bufferService.buffers;
  const capture=b=>({x:b.x,y:b.y,savedX:b.savedX,savedRow:b.savedY-b.ybase,
    savedFg:b.savedCurAttrData.fg,savedBg:b.savedCurAttrData.bg,savedCharset:b.savedCharset,
    scrollTop:b.scrollTop,scrollBottom:b.scrollBottom,tabs:{...b.tabs}});
  return {version:1,normal:capture(buffers.normal),alternate:capture(buffers.alt),
    modes:{...core.coreService.modes},decModes:{...core.coreService.decPrivateModes},
    cursorHidden:core.coreService.isCursorHidden};
}
function restoreTerminalState(term,state){
  if(state?.version!==1)return false;
  const core=term._core,buffers=core._bufferService.buffers;
  const restore=(buffer,saved)=>{
    if(!saved)return;
    buffer.x=Math.max(0,Math.min(term.cols,saved.x));buffer.y=Math.max(0,Math.min(term.rows-1,saved.y));
    buffer.savedX=saved.savedX;buffer.savedY=buffer.ybase+saved.savedRow;
    buffer.savedCurAttrData.fg=saved.savedFg;buffer.savedCurAttrData.bg=saved.savedBg;buffer.savedCharset=saved.savedCharset;
    buffer.scrollTop=saved.scrollTop;buffer.scrollBottom=saved.scrollBottom;buffer.tabs={...saved.tabs};
  };
  restore(buffers.normal,state.normal);restore(buffers.alt,state.alternate);
  Object.assign(core.coreService.modes,state.modes);Object.assign(core.coreService.decPrivateModes,state.decModes);
  core.coreService.isCursorHidden=state.cursorHidden;
  term.refresh(0,term.rows-1);return true;
}
