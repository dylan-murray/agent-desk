const {test}=require('node:test');
const assert=require('node:assert/strict');
const {restoreBounds}=require('../src/window-state.cjs');
const displays=[{workArea:{x:0,y:25,width:1440,height:875}}];
test('restored bounds fit after unplugging a monitor',()=>{
 assert.deepEqual(restoreBounds({x:2000,y:-900,width:1800,height:1200},displays),{x:0,y:25,width:1440,height:875});
});
test('normal position is retained',()=>{
 const saved={x:50,y:75,width:900,height:700};assert.deepEqual(restoreBounds(saved,displays),saved);
});
