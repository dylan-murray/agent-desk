(()=>{
function linkText(container,text){
 let offset=0;
 for(const match of text.matchAll(/\[([^\]\n]+)\]\((https?:\/\/[^\s<>")]+)\)|\bhttps?:\/\/[^\s<>"`]+/gi)){
  let url=match[2]||match[0];
  // Sentence punctuation and wrapping parentheses belong to the prose.
  while(url){
   const last=url.at(-1),opening={')':'(',']':'[','}':'{'}[last];
   if(/[.,!?:;']/.test(last)||(opening&&url.split(last).length>url.split(opening).length))url=url.slice(0,-1);
   else break;
  }
  try{if(!['http:','https:'].includes(new URL(url).protocol))continue;}catch{continue;}
  if(match.index>offset)container.append(document.createTextNode(text.slice(offset,match.index)));
  const link=document.createElement('a');link.href=url;link.textContent=match[1]||url;
  link.target='_blank';link.rel='noopener noreferrer';if(typeof window.openDeskTool==='function'&&new URL(url).origin===location.origin&&new URL(url).pathname.startsWith('/apps/')){link.removeAttribute('target');link.onclick=e=>{if(e.metaKey||e.ctrlKey||e.shiftKey)return;e.preventDefault();window.openDeskTool(new URL(url).pathname);};}container.append(link);
  offset=match.index+(match[2]?match[0].length:url.length);
 }
 if(offset<text.length)container.append(document.createTextNode(text.slice(offset)));
}
function inlineCode(container,text){
 const pattern=/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)/g;
 let offset=0;
 for(const match of text.matchAll(pattern)){
  linkText(container,text.slice(offset,match.index));
  const code=document.createElement('code');code.className='coord-inline-code';
  let content=match[2].replace(/\r?\n/g,' ');
  if(content.startsWith(' ')&&content.endsWith(' ')&&content.trim())content=content.slice(1,-1);
  code.textContent=content;container.append(code);offset=match.index+match[0].length;
 }
 linkText(container,text.slice(offset));
}
function codeBlock(container,source,language){
 const block=document.createElement('div');block.className='coord-code-block';
 const label=document.createElement('div');label.className='coord-code-language';label.textContent=language||'code';
 const pre=document.createElement('pre'),code=document.createElement('code');
 code.textContent=source;
 // Only the local highlighter's escaped output becomes markup. Unknown languages stay literal.
 if(source.length<=50000&&window.hljs?.getLanguage(language)){
  try{code.innerHTML=window.hljs.highlight(source,{language,ignoreIllegals:true}).value;}catch{}
 }
 pre.tabIndex=0;pre.setAttribute('aria-label',(language||'Plain text')+' code');
 pre.append(code);block.append(label,pre);container.append(block);
}
// Emphasis, code spans and links in one left-to-right pass, so bold wrapping a
// code span and a code span containing asterisks both stay literal.
function richText(container,text,depth=0){
 const pattern=/(?<!`)(`+)(?!`)([\s\S]*?)(?<!`)\1(?!`)|\*\*(?=[^\s*])([^*]+?)\*\*(?!\*)|(?<![\w*])\*(?=[^\s*])([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?=[^\s_])([^_\n]+?)_(?![\w_])/g;
 let offset=0;
 for(const match of text.matchAll(pattern)){
  linkText(container,text.slice(offset,match.index));
  if(match[1]!==undefined){
   const code=document.createElement('code');code.className='coord-inline-code';
   let content=match[2].replace(/\r?\n/g,' ');
   if(content.startsWith(' ')&&content.endsWith(' ')&&content.trim())content=content.slice(1,-1);
   code.textContent=content;container.append(code);
  }else{
   const value=match[3]??match[4]??match[5],node=document.createElement(match[3]!==undefined?'strong':'em');
   if(depth<4)richText(node,value,depth+1);else node.textContent=value;
   container.append(node);
  }
  offset=match.index+match[0].length;
 }
 linkText(container,text.slice(offset));
}
function tableCells(row){
 let value=row.trim();
 if(value.startsWith('|'))value=value.slice(1);
 if(value.endsWith('|')&&!value.endsWith('\\|'))value=value.slice(0,-1);
 const cells=[];let cell='';
 for(let index=0;index<value.length;index++){
  if(value[index]==='\\'&&value[index+1]==='|'){cell+='|';index++;continue;}
  if(value[index]==='|'){cells.push(cell.trim());cell='';continue;}
  cell+=value[index];
 }
 cells.push(cell.trim());return cells;
}
function reportProse(container,text){
 const inline=(node,value)=>richText(node,value);
 const lines=String(text).replace(/\r/g,'').split('\n');
 const isBullet=line=>line.match(/^([ \t]*)(?:([-*•+])|(\d+)[.)])[ \t]+(.*)$/);
 const isTableRow=line=>/^\s*\|/.test(line);
 const isTableRule=line=>{const cells=tableCells(line);return line.includes('|')&&cells.length>1&&cells.every(cell=>/^:?-{2,}:?$/.test(cell));};
 let paragraph=[],lists=[];
 const flush=()=>{
  if(!paragraph.length)return;
  const value=paragraph.join('\n'),node=document.createElement('p');
  inline(node,value);container.append(node);paragraph=[];
 };
 const endBlock=()=>{flush();lists=[];};
 let titled=false;
 const heading=(rank,value)=>{
  endBlock();
  // Only the report's first level-one heading is its title; later ones are sections.
  const level=rank===1&&titled?2:rank;
  if(level===1)titled=true;
  const node=document.createElement(level===1?'h1':level===2?'h2':level===3?'h3':'h4');
  if(level===1)node.className='document-title';
  inline(node,value.replace(/\s+#+\s*$/,''));container.append(node);
 };
 for(let index=0;index<lines.length;index++){
  const line=lines[index];
  if(!line.trim()){endBlock();continue;}

  const action=line.match(/^Action:\s*((?:git|uv|python3?|pytest|ruff|node|npm|pnpm|yarn|gh)\s+[^;\n]+);\s*(.*)$/);
  if(action){endBlock();const label=document.createElement('h3');label.textContent='Action';container.append(label);codeBlock(container,action[1]+'\n','bash');const rest=document.createElement('p');inline(rest,action[2]);container.append(rest);continue;}

  if(isTableRow(line)&&isTableRule(lines[index+1]||'')){
   endBlock();
   const heads=tableCells(line),align=tableCells(lines[index+1]).map(cell=>/^:-+:$/.test(cell)?'center':/^-+:$/.test(cell)?'right':/^:-+$/.test(cell)?'left':'');
   const wrap=document.createElement('div');wrap.className='document-table';
   const table=document.createElement('table'),body=document.createElement('tbody');
   if(heads.some(value=>value)){
    const head=document.createElement('thead'),row=document.createElement('tr');
    heads.forEach((value,column)=>{const cell=document.createElement('th');if(align[column])cell.style.textAlign=align[column];inline(cell,value);row.append(cell);});
    head.append(row);table.append(head);
   }
   index+=2;
   let rows=0;
   while(index<lines.length&&isTableRow(lines[index])&&rows++<1000){
    const values=tableCells(lines[index]),row=document.createElement('tr');
    for(let column=0;column<Math.max(heads.length,values.length);column++){
     const cell=document.createElement('td');if(align[column])cell.style.textAlign=align[column];
     inline(cell,values[column]??'');row.append(cell);
    }
    body.append(row);index++;
   }
   index--;
   table.append(body);wrap.append(table);container.append(wrap);continue;
  }

  if(!line.includes('|')&&/^\s*(?:-{3,}|\*{3,}|_{3,}|—{2,})\s*$/.test(line)){
   endBlock();const rule=document.createElement('hr');rule.className='document-rule';container.append(rule);continue;
  }

  const quote=line.match(/^\s{0,3}>\s?(.*)$/);
  if(quote){
   endBlock();
   const quoted=[quote[1]];
   while(index+1<lines.length&&/^\s{0,3}>\s?/.test(lines[index+1]))quoted.push(lines[++index].replace(/^\s{0,3}>\s?/,''));
   const callout=document.createElement('blockquote');callout.className='document-callout';
   reportProse(callout,quoted.join('\n'));container.append(callout);continue;
  }

  const bullet=isBullet(line);
  if(bullet){
   flush();
   const indent=bullet[1].replace(/\t/g,'  ').length,kind=bullet[2]?'ul':'ol';
   while(lists.length&&indent<lists.at(-1).indent)lists.pop();
   const top=lists.at(-1);
   if(!top)lists.push({indent,list:container.appendChild(document.createElement(kind)),item:null});
   else if(indent>=top.indent+2&&top.item)lists.push({indent,list:top.item.appendChild(document.createElement(kind)),item:null});
   else if(top.list.tagName.toLowerCase()!==kind){
    lists.pop();
    const parent=lists.at(-1)?.item||container;
    lists.push({indent,list:parent.appendChild(document.createElement(kind)),item:null});
   }
   const level=lists.at(-1);
   if(kind==='ol'&&!level.list.children.length&&Number(bullet[3])>1)level.list.start=Number(bullet[3]);
   const item=document.createElement('li');inline(item,bullet[4]);level.list.append(item);level.item=item;continue;
  }
  if(lists.length&&lists.at(-1).item&&/^\s{2,}\S/.test(line)){
   const detail=document.createElement('p');inline(detail,line.trim());lists.at(-1).item.append(detail);continue;
  }
  const marked=line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
  if(marked){heading(marked[1].length,marked[2]);continue;}
  // Legacy plaintext reports title their sections in capitals, and agents often
  // label a bullet group with a single bold line. Both read as structure.
  const opening=!paragraph.length;
  const shouted=opening&&line.match(/^([A-Z][A-Z &/—-]{2,70}):?$/);
  if(shouted){heading(2,shouted[1]);continue;}
  if(opening&&line.length<80&&isBullet(lines[index+1]||'')){
   heading(3,line.replace(/^\*\*([^*]+)\*\*$/,'$1'));continue;
  }
  lists=[];paragraph.push(line);
 }
 endBlock();
}
function textBlocks(container,text,rich=false){
 let prose='',source='',fence=null,language='';
 const flush=()=>{if(prose){if(rich){reportProse(container,prose);prose='';return;}const node=document.createElement('div');node.className='coord-text';inlineCode(node,prose);container.append(node);prose='';}};
 for(const line of String(text).match(/[^\n]*\n|[^\n]+$/g)||[]){
  if(fence){
   const closing=line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*\r?\n?$/);
   if(closing&&closing[1][0]===fence[0]&&closing[1].length>=fence.length){codeBlock(container,source,language);fence=null;source='';}
   else source+=line;
  }else{
   const opening=line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*([^\r\n]*)\r?\n?$/);
   if(opening&&!(opening[1][0]==='`'&&opening[2].includes('`'))){flush();fence=opening[1];language=opening[2].trim().split(/\s+/)[0].toLowerCase();}
   else prose+=line;
  }
 }
 if(fence)codeBlock(container,source,language);
 flush();
}
window.deskTextBlocks=textBlocks;
})();
