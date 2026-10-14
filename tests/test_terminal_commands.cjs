const test=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {spawnSync}=require('node:child_process');
const {launchChoices,buildTerminalCommand,applyAccounts}=require('../agent_desk/static/terminal-commands.js');
test('default and added accounts retain their native harness identity',()=>{
  assert.deepEqual(Object.keys(launchChoices).filter(key=>launchChoices[key].account),['codex','claude']);
  applyAccounts([{id:'codex',harness:'codex',label:'Codex'},{id:'codex-personal',harness:'codex',label:'Codex · Personal'},{id:'claude',harness:'claude',label:'Claude'}]);
  assert.equal(launchChoices.codex.command,'codex');
  assert.equal(launchChoices['codex-personal'].command,'codex-personal');
  assert.equal(launchChoices['codex-personal'].harness,'codex');
  applyAccounts([{id:'codex',harness:'codex',label:'Codex'},{id:'claude',harness:'claude',label:'Claude'}]);
  assert.equal(launchChoices['codex-personal'],undefined);
  assert.equal(launchChoices.shell.harness,'shell');
});
test('shell command field cannot inject shell syntax',()=>{
  for(const command of ['codex; echo bad','$(echo bad)','codex --resume','alias\nfalse','--help'])assert.throws(()=>buildTerminalCommand(command,'/bin/zsh',[]));
  assert.deepEqual(buildTerminalCommand('/tmp/a b','direct',['a b']),['/tmp/a b','a b']);
});
test('login shell loads aliases and functions, preserving resume arguments literally',()=>{
  const dir=mkdtempSync(join(tmpdir(),'agent-desk-alias-'));
  try{
    writeFileSync(join(dir,'.zshrc'),`alias codex-personal='print -rl -- PERSONAL'\nclaude-personal() { print -rl -- CLAUDE "$@"; }\n`);
    for(const command of ['codex-personal','claude-personal']){
      const args=['resume','a session with spaces',"quote'and\"double",'$(echo MUST_NOT_EXECUTE)','; echo NO'];
      const [exe,...argv]=buildTerminalCommand(command,'/bin/zsh',args);
      const result=spawnSync(exe,argv,{encoding:'utf8',env:{...process.env,ZDOTDIR:dir},timeout:5000});
      assert.equal(result.status,0,result.stderr);
      assert.deepEqual(result.stdout.trim().split('\n'),[command==='codex-personal'?'PERSONAL':'CLAUDE',...args]);
    }
  }finally{rmSync(dir,{recursive:true,force:true});}
});
