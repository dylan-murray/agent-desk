const assert=require('node:assert/strict');
global.self=global;
const {Terminal}=require('../agent_desk/static/vendor/xterm.js');
const {classify}=require('../scripts/native_terminal_screen.cjs');
const term=new Terminal({cols:80,rows:24,allowProposedApi:true});
const screen=(draft='',footer='Shift+Tab:mode │ Ctrl+x:shortcuts',above='Worked for 2s')=>
  `\x1b[2J\x1b[?2004h\x1b[17;3H${above}\x1b[19;3H╭${'─'.repeat(72)}╮\x1b[20;3H│ ❯ ${draft.padEnd(69)}│\x1b[21;3H╰${'─'.repeat(35)} Grok 4.6 (high) ─╯\x1b[23;3H${footer}\x1b[20;7H`;
const write=text=>new Promise(resolve=>term.write(text,resolve));
(async()=>{
 await write(screen());assert.deepEqual(classify(term),{state:'idle',ready:true});
 await write(screen('my unfinished thought'));assert.deepEqual(classify(term),{state:'typing',ready:false});
 await write(screen('', 'Shift+Tab:mode │ Esc:cancel │ Ctrl+x:shortcuts'));assert.equal(classify(term).state,'working');
 await write(screen('', '1/3:select │ Ctrl+o:yolo │ Ctrl+c:cancel'));assert.equal(classify(term).state,'needs-input');
 await write(screen('', 'tab:scrollback │ shift+x:dismiss'));assert.equal(classify(term).state,'needs-input');
 await write(screen('','Shift+Tab:mode │ Ctrl+x:shortcuts','Waiting for reply…'));assert.equal(classify(term).state,'working');
 await write(screen());assert.equal(classify(term,true).ready,false);assert.equal(classify(term,false,true).ready,false);
 await write('\x1b[?2004l');assert.equal(classify(term).ready,false);
 await write('\x1b[2J\x1b[H$ ');assert.equal(classify(term).state,'unknown');
 await write(screen());await write('\x1b[20;7Hunfinished');assert.equal(classify(term).ready,false);
 await write('\x1b[20;7H'+ ' '.repeat(10)+'\x1b[20;7H');assert.equal(classify(term).ready,true);
 term.dispose();console.log('PASS: native Grok empty prompt, drafts, approvals, busy states, redraws, paste mode and shell rejection');
})().catch(e=>{console.error(e);process.exit(1);});
