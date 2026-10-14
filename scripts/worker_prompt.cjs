// Read-only prompt check using the same terminal renderer as Agent Desk.
global.self=global;
const {Terminal}=require('../agent_desk/static/vendor/xterm.js');
const {classify}=require('./native_terminal_screen.cjs');
const RULE=/^─{20,}$/;
// OpenCode's composer is a ┃ box: a blank row, the input row, a blank row, the agent and model, then ╹▀.
function opencode(lines,b){
 const y=b.cursorY,line=lines[y]||'',bar=line.indexOf('┃');
 if(bar<0||line.slice(0,bar).trim()||b.cursorX!==bar+3)return false;
 const blank=row=>(row||'').slice(bar).trimEnd()==='┃';
 if(!blank(lines[y-1])||!blank(lines[y+1])||!(lines[y+2]||'').slice(bar).startsWith('┃  ')||!(lines[y+3]||'').slice(bar).startsWith('╹▀'))return false;
 const draft=line.slice(bar+1).trim();
 // The empty composer shows a grey hint, with the cursor at its start.
 if(draft&&!draft.startsWith('Ask anything...'))return false;
 return !/esc\s+(?:again\s+to\s+)?interrupt|permission required/i.test(lines.slice(Math.max(0,y-3)).join('\n'));
}
// Pi's editor is the row between two full-width rules; it draws its own cursor.
function pi(lines,b){
 const y=b.cursorY;
 if(b.cursorX!==0||(lines[y]||'').trim()||!RULE.test(lines[y-1]||'')||!RULE.test(lines[y+1]||''))return false;
 return !/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|Working\.\.\./m.test(lines.slice(Math.max(0,y-5),y).join('\n'));
}
function ready(term,harness,hidden=false,sync=false){
 if(harness==='grok')return classify(term,hidden,sync).ready;
 if(sync||!term.modes.bracketedPasteMode)return false;
 const b=term.buffer.active;
 const lines=Array.from({length:term.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');
 if(harness==='pi')return pi(lines,b);
 if(hidden)return false;
 if(harness==='opencode')return opencode(lines,b);
 // Claude Code 2.1 draws a no-break space after its prompt marker.
 const line=(lines[b.cursorY]||'').replace(/\u00a0/g,' ');
 const marker=harness==='claude'?'❯':'›';
 const start=line.indexOf(marker)+2;
 if(!line.trimStart().startsWith(marker+' ')||b.cursorX!==start)return false;
 const suffix=line.slice(start).trimEnd();
 if(suffix){
  // Both render the empty composer's hint as dim text with the cursor at its
  // beginning. A real draft (even the same words) uses normal attributes.
  // Claude Code's hint varies: a tip such as Try "refactor <filepath>", or a suggested next prompt.
  if(harness==='codex'&&suffix!=='Ask Codex to do anything')return false;
  const row=b.getLine(b.baseY+b.cursorY);
  for(let x=start;x<start+suffix.length;x++)if(!row.getCell(x)?.isDim())return false;
 }
 const nearby=lines.slice(Math.max(0,b.cursorY-3)).join('\n');
 return !/esc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel)|ctrl\+c.*(?:interrupt|cancel)|\[y\/n\]|\(y\/n\)/i.test(nearby);
}
// Mid-turn. Claude animates a spinner at the start of its window title while it works and
// settles on "✳" when done. Codex (and older Claude) shows an interrupt hint just above its
// composer; both render inline, so look around the cursor, not at the bottom of the screen.
// A frame still being drawn says nothing either way, so it is neither working nor idle.
function working(term,harness,hidden=false,sync=false,title=''){
 if(harness==='grok')return classify(term,hidden,sync).state==='working';
 if(harness==='claude'&&/^[◐◓◑◒\u2801-\u28ff]/u.test(title))return true;
 if(sync)return false;
 const b=term.buffer.active,from=Math.max(0,b.cursorY-8),to=Math.min(term.rows,b.cursorY+5);
 const nearby=Array.from({length:to-from},(_,i)=>b.getLine(b.baseY+from+i)?.translateToString(true)||'').join('\n');
 return /esc(?:ape)?\s+to\s+interrupt/i.test(nearby);
}
if(require.main===module){
 let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>input+=chunk);
 process.stdin.on('end',async()=>{
  const data=JSON.parse(input),term=new Terminal({cols:data.cols,rows:data.rows,scrollback:0,allowProposedApi:true});
  let hidden=false,sync=false,title='';
  term.onTitleChange(value=>{title=value;});
  for(const final of ['h','l'])term.parser.registerCsiHandler({prefix:'?',final},params=>{if(params.includes(25))hidden=final==='h'?false:true;if(params.includes(2026))sync=final==='h';return false;});
  await new Promise(resolve=>term.write(Buffer.from(data.data,'base64'),resolve));
  process.stdout.write(JSON.stringify({ready:!working(term,data.harness,hidden,sync,title)&&ready(term,data.harness,hidden,sync)}));term.dispose();
 });
}
module.exports={ready,working};
