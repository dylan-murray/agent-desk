const assert=require('node:assert/strict');global.self=global;
const {Terminal}=require('../agent_desk/static/vendor/xterm.js');const {ready,working}=require('../scripts/worker_prompt.cjs');
(async()=>{
 for(const [harness,marker] of [['claude','❯'],['codex','›']]){
  const term=new Terminal({cols:80,rows:24,allowProposedApi:true});
  const write=text=>new Promise(resolve=>term.write(text,resolve));
  await write('\x1b[?2004h'+marker+' ');assert.equal(ready(term,harness),true);
  await write('unsent draft');assert.equal(ready(term,harness),false);
  await write('\r\x1b[2K'+marker+' 1. Yes');assert.equal(ready(term,harness),false);
  await write('\r\x1b[2K'+marker+' \r\nEsc to interrupt\x1b[1A\x1b[3G');assert.equal(ready(term,harness),false);
  await write('\x1b[2J\x1b[H'+marker+' ');assert.equal(ready(term,harness,true),false);assert.equal(ready(term,harness,false,true),false);
  await write('\x1b[?2004l');assert.equal(ready(term,harness),false);term.dispose();
 }
 const n=new Terminal({cols:80,rows:24,allowProposedApi:true});
 await new Promise(r=>n.write('\x1b[?2004h❯\u00a0',r));
 assert.equal(ready(n,'claude'),true,'no-break space after the Claude marker is an empty prompt');
 await new Promise(r=>n.write('unsent draft',r));assert.equal(ready(n,'claude'),false);n.dispose();
 const t=new Terminal({cols:80,rows:24,allowProposedApi:true});
 const w=s=>new Promise(r=>t.write(s,r));
 await w('\x1b[?2004h› \x1b[2mAsk Codex to do anything\x1b[0m\r\x1b[3G');
 assert.equal(ready(t,'codex'),true,'dim empty-composer placeholder is deliverable');
 await w('\r\x1b[2K› Ask Codex to do anything\r\x1b[3G');
 assert.equal(ready(t,'codex'),false,'real draft at start must not be submitted');t.dispose();
 // Claude Code 2.1 fills its empty composer with a dim tip or suggested prompt.
 const c=new Terminal({cols:80,rows:24,allowProposedApi:true}),cw=s=>new Promise(r=>c.write(s,r));
 for(const hint of ['Try "how does <filepath> work?"','commit this']){
  await cw('\x1b[?2004h\r\x1b[2K❯\u00a0\x1b[2m'+hint+'\x1b[0m\r\x1b[3G');
  assert.equal(ready(c,'claude'),true,'dim hint in an empty Claude composer is deliverable');
  await cw('\r\x1b[2K❯\u00a0'+hint+'\r\x1b[3G');
  assert.equal(ready(c,'claude'),false,'the same words typed as a draft must not be submitted');}
 await cw('\r\x1b[2K❯\u00a0\x1b[2mcommit\x1b[0m this\r\x1b[3G');
 assert.equal(ready(c,'claude'),false,'a partly dim line is not a hint');c.dispose();
 // OpenCode 1.3.5: a ┃ composer box whose input row holds the cursor three columns after the bar.
 const box=(input,footer='')=>'\x1b[?2004h\x1b[2J\x1b[H\r\n  ┃\r\n  ┃  '+input+'\r\n  ┃\r\n  ┃  Build  Some Model Provider\r\n  ╹▀▀▀▀▀▀▀▀▀▀▀▀\r\n'+footer+'\x1b[3;6H';
 const o=new Terminal({cols:80,rows:24,allowProposedApi:true}),ow=s=>new Promise(r=>o.write(s,r));
 await ow(box(''));assert.equal(ready(o,'opencode'),true,'empty OpenCode composer');
 await ow(box('Ask anything... "Fix broken tests"'));assert.equal(ready(o,'opencode'),true,'OpenCode placeholder hint');
 await ow(box('unsent draft'));assert.equal(ready(o,'opencode'),false);
 await ow(box('','   ⬝⬝⬝■■■  esc interrupt'));assert.equal(ready(o,'opencode'),false,'OpenCode is working');
 await ow(box('')+'\x1b[3;9H');assert.equal(ready(o,'opencode'),false,'cursor is not at the start of the input');
 await ow('\x1b[2J\x1b[H  ┃  Permission required\r\n  ┃  Allow once  Always  Reject\x1b[1;6H');assert.equal(ready(o,'opencode'),false);o.dispose();
 // Pi 0.79: the editor is the row between two rules, and Pi hides the terminal cursor to draw its own.
 const rule='─'.repeat(80),editor=(above,input)=>'\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H'+above+'\r\n'+rule+'\r\n'+input+'\r\n'+rule+'\r\n~/project\r\n0.0%/262k\x1b[3;'+(input.length+1)+'H';
 const q=new Terminal({cols:80,rows:24,allowProposedApi:true}),qw=s=>new Promise(r=>q.write(s,r));
 await qw(editor(' ok',''));assert.equal(ready(q,'pi',true),true,'empty Pi editor with its hidden cursor');
 await qw(editor(' ok','unsent draft'));assert.equal(ready(q,'pi',true),false);
 await qw(editor(' ⠋ Working...',''));assert.equal(ready(q,'pi',true),false,'Pi is working');
 await qw(editor(' ok','')+'\x1b[?2004l');assert.equal(ready(q,'pi',true),false);q.dispose();
 const composer=(input,above='',hint=true)=>'\x1b[?2004h\x1b[?25l\x1b[2J\x1b[H'+above+'\r\n\r\n  \x1b[2m→ \x1b[0m'+(hint?'\x1b[7mA\x1b[27m\x1b[2mdd a follow-up\x1b[0m':input+'\x1b[7m \x1b[27m')+'\r\n\r\n  Auto · 6.2%\r\n  ~/project';
 const u=new Terminal({cols:120,rows:24,allowProposedApi:true}),uw=s=>new Promise(r=>u.write(s,r));
 await uw(composer(''));assert.equal(ready(u,'cursor-agent',true),true,'empty Cursor composer');assert.equal(working(u,'cursor-agent'),false);
 await uw(composer('unsent draft',' READY',false));assert.equal(ready(u,'cursor-agent',true),false,'Cursor draft');
 await uw(composer('Add a follow-up','',false));assert.equal(ready(u,'cursor-agent',true),false,'the hint\'s words typed as a draft');
 await uw(composer('',' ⠘⠆ Working  21 tokens'));assert.equal(working(u,'cursor-agent'),true,'Cursor is working');
 await uw(composer('')+'\x1b[5;100Hctrl+c to stop');assert.equal(working(u,'cursor-agent'),true,'Cursor shows how to stop a turn');
 await uw('\x1b[2J\x1b[H Write to this file?\r\n  → Proceed (y)\r\n    Reject & propose changes (esc or n or p)');assert.equal(ready(u,'cursor-agent',true),false,'an approval question is not the composer');u.dispose();
 console.log('PASS: worker prompt guards reject drafts, approval choices, busy states, hidden cursors, and incomplete redraws');
})().catch(error=>{console.error(error);process.exitCode=1;});
