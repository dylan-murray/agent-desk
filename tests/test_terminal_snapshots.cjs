const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
const context=vm.createContext({TextDecoder});
vm.runInContext(fs.readFileSync(require('node:path').join(__dirname,'../agent_desk/static/terminal-snapshots.js'),'utf8'),context);
function boundary(){return vm.runInContext('new TerminalStreamBoundary()',context)}
test('checkpoints wait for split CSI, OSC, DCS and UTF-8 sequences',()=>{
 for(const sequence of ['\x1b[38;2;10;20;30m','\x1b]0;window title\x1b\\','\x1bP1;2|payload\x1b\\','\x1b]0;title\x07','界']){
  const bytes=Buffer.from(sequence);
  for(let split=1;split<bytes.length;split++){
   const state=boundary();state.feed(bytes.subarray(0,split));assert.equal(state.complete,false,sequence+' split '+split);
   state.feed(bytes.subarray(split));assert.equal(state.complete,true,sequence+' finished');
  }
 }
});
test('ordinary text and completed redraw sequences allow a checkpoint',()=>{
 const state=boundary();state.feed(Buffer.from('\x1b[2J\x1b[Hhello café\r\n\x1b[32mready\x1b[0m'));
 assert.equal(state.complete,true);
});
test('cancelled controls release a checkpoint',()=>{const state=boundary();state.feed(Buffer.from('\x1b[12;'));assert.equal(state.complete,false);state.feed(Buffer.from('\x18'));assert.equal(state.complete,true)});
