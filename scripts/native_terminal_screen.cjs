// Passive screen observer. Uses the same vendored renderer as the browser;
// terminal responses are deliberately never wired to the agent's input.
global.self = global;
const {Terminal} = require('../agent_desk/static/vendor/xterm.js');

function classify(term, hidden=false, synchronizing=false) {
  const b=term.buffer.active;
  const lines=Array.from({length:term.rows},(_,i)=>b.getLine(b.baseY+i)?.translateToString(true)||'');
  const footer=lines.slice(-4).join('\n').toLowerCase();
  const unknown={state:'unknown',ready:false};
  if(synchronizing)return unknown;
  if((footer.includes(':select')&&footer.includes(':cancel')) ||
     (footer.includes('tab:scrollback')&&footer.includes('shift+x:dismiss')) ||
     lines.some(l=>/^\s*┃.*[●○]/u.test(l)))return {state:'needs-input',ready:false};
  if(/(?:esc|ctrl\+c):cancel|ctrl\+b:send to bg/.test(footer))return {state:'working',ready:false};
  const row=b.cursorY, line=lines[row]||'';
  if(hidden || !/^\s*│\s*❯/u.test(line))return unknown;
  let top=row-1,bottom=row+1;
  while(top>=0&&!/^\s*╭─/u.test(lines[top]))top--;
  while(bottom<lines.length&&!/^\s*╰─/u.test(lines[bottom]))bottom++;
  if(top<0||bottom>=lines.length||bottom-top>8||!lines[bottom].includes('Grok'))return unknown;
  const recent=lines.slice(Math.max(0,top-3),top).join('\n');
  if(/\[stop\]|still running|waiting for (?:response|reply)|thinking[….]/i.test(recent))return {state:'working',ready:false};
  if(!/ctrl\+[x.]:shortcuts/.test(footer))return unknown;
  const empty=lines.slice(top+1,bottom).every((l,i)=>i===0 ? /^\s*│\s*❯\s*│\s*$/u.test(l) : /^\s*│\s*│\s*$/u.test(l));
  const cursorAtStart=row===top+1 && b.cursorX===line.indexOf('❯')+2;
  return {state:empty?'idle':'typing',ready:empty&&cursorAtStart&&term.modes.bracketedPasteMode};
}

if(require.main===module){
  const term=new Terminal({cols:80,rows:24,scrollback:0,allowProposedApi:true});
  let hidden=false,synchronizing=false,chain=Promise.resolve();
  for(const final of ['h','l'])term.parser.registerCsiHandler({prefix:'?',final},params=>{
    if(params.includes(25))hidden=final==='l';
    if(params.includes(2026))synchronizing=final==='h';
    return false;
  });
  require('readline').createInterface({input:process.stdin}).on('line',line=>{
    chain=chain.then(async()=>{
      const msg=JSON.parse(line);
      if(msg.op==='resize')term.resize(msg.cols,msg.rows);
      if(msg.op==='output')await new Promise(resolve=>term.write(Buffer.from(msg.data,'base64'),resolve));
      process.stdout.write(JSON.stringify({revision:msg.revision,...classify(term,hidden,synchronizing)})+'\n');
    }).catch(()=>process.exit(1));
  }).on('close',()=>chain.finally(()=>{term.dispose();process.exit(0);}));
}
module.exports={classify};
