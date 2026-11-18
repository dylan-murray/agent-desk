(()=>{
const text=(tag,value)=>{const n=document.createElement(tag);n.textContent=value;return n;};
  function renderDocument(node,source){
    const lines=String(source).split('\n');let fence=null;
    const prose=lines.map((line,i)=>{
      const marker=line.match(/^ {0,3}(`{3,}|~{3,})/);
      if(marker){if(!fence)fence=marker[1][0];else if(fence===marker[1][0])fence=null;return line;}
      if(fence)return line;
      const divider=value=>/^\s*[=─_-]{6,}\s*$/.test(value||'');
      const underline=value=>/^\s*(?:-{3,}|={3,})\s*$/.test(value||'');
      if(divider(line))return '';
      // A line between two dividers is a section title, unless it reads as a sentence: then it is the
      // report's banner ("RESULT: could not finish. No PR opened.") and stands out as a callout instead.
      if(line.trim()&&divider(lines[i-1])&&divider(lines[i+1]))return /[.!?]$/.test(line.trim())?'> **'+line.trim()+'**':'## '+line.trim();
      // A short line underlined with dashes or equals signs ("What I tried" over "----") is a heading.
      if(line.trim().length<=60&&underline(lines[i+1])&&!divider(lines[i-1])&&!/^\s*([-*+>|#`]|\d+[.)])/.test(line)&&!(i>0&&lines[i-1].trim()))return '## '+line.trim();
      if(underline(line)&&lines[i-1]?.trim()&&lines[i-1].trim().length<=60&&!(i>1&&lines[i-2].trim()))return '';
      if(/^\s{2,}[a-z]\.\s+/.test(line))return '- '+line.trim();
      return line;
    }).join('\n');
    window.deskTextBlocks(node,prose,true);
    window.renderDeskDiagrams(node);
    // Emphasize short, explicit lead-in labels, never inferred keywords or
    // whole sentences. Work on text nodes so links, code and authored bold survive.
    for(const block of node.querySelectorAll('p, li')){
      const first=block.firstChild;
      if(first?.nodeType!==Node.TEXT_NODE)continue;
      const match=first.textContent.match(/^([A-Za-z][^:\n.!?;]{0,55}:)(?=\s)/);
      if(!match||match[1].trim().split(/\s+/).length>6||/^Sources checked:/i.test(match[1]))continue;
      if(!block.textContent.slice(match[1].length).trim())continue;
      const label=text('strong',match[1]);label.className='document-lead-in';
      first.textContent=first.textContent.slice(match[1].length);block.insertBefore(label,first);
    }
    // Legacy reports use numbered, all-caps section titles. Keep the source
    // intact; soften only their display, preserving acronyms and mixed-case names.
    const acronyms=new Set('AI API APIs AWS CI CD CLI CPU CSS DAG DB GPU HTML HTTP HTTPS IAM ID IDs JSON LLM ML PDF PR PRs RAM SDK SQL SSM TUI UI URL URLs UTC UX XML YAML'.split(' '));
    for(const heading of node.querySelectorAll('h2, h3')){
      // Every top-level heading is a section; the number treatment is optional.
      if(heading.tagName==='H2')heading.classList.add('document-section');
      const original=heading.textContent,match=original.match(/^(\d+)[.)]\s+(.+)/);
      if(!match||heading.children.length)continue;
      let label=match[2].replace(/\b[A-Z][A-Z']+\b/g,word=>acronyms.has(word)?word:word.toLowerCase());
      label=label.replace(/[a-zA-Z]/,char=>char.toUpperCase());
      heading.classList.add('document-section');heading.title=original;
      const number=text('span',match[1].padStart(2,'0'));number.className='document-section-number';
      const name=text('span',label);heading.replaceChildren(number,name);
    }
    for(const link of node.querySelectorAll('a')){
      if(link.textContent!==link.href)continue;
      const url=new URL(link.href),tail=url.pathname.split('/').filter(Boolean).at(-1)||'';
      let label;try{label=decodeURIComponent(tail).replace(/[-_]/g,' ');}catch{label=tail;}
      link.title=link.href;link.textContent=url.hostname.replace(/^www\./,'')+(label?' · '+(label.length>36?label.slice(0,33)+'…':label):'')+' ↗';
    }
    // A report's opening summary and its whole-line italic notes are authored
    // structure, not guessed keywords: promote one, quiet the other.
    for(const paragraph of [...node.children].slice(0,3)){
      if(paragraph.tagName!=='P'||paragraph.classList.length)continue;
      const lead=paragraph.firstElementChild;
      if(lead===paragraph.firstChild&&lead?.tagName==='STRONG'&&!lead.classList.length&&/:$/.test(lead.textContent.trim())&&
         lead.textContent.trim().split(/\s+/).length<=6&&paragraph.textContent.length>lead.textContent.length+40){
        paragraph.classList.add('document-lede');break;
      }
    }
    for(const paragraph of node.querySelectorAll('p:not(.document-lede)')){
      const only=paragraph.firstElementChild;
      if(only?.tagName==='EM'&&paragraph.children.length===1&&paragraph.textContent.trim()===only.textContent.trim()&&paragraph.textContent.trim().length>24)paragraph.classList.add('document-aside');
    }
    for(const paragraph of [...node.children]){
      if(paragraph.tagName!=='P'||!/^Sources checked:/i.test(paragraph.textContent))continue;
      const sources=document.createElement('details');sources.className='inbox-sources';sources.append(text('summary','Sources checked'));paragraph.before(sources);sources.append(paragraph);
    }
  }
  // A report's own first line, when it is a heading or a short title line, names the report; the rest is
  // its body. Reports that open straight into prose keep their text and fall back to the item's title.
  function reportTitle(source){
    const lines=String(source||'').split('\n'),first=lines.findIndex(line=>line.trim());
    if(first<0)return {title:'',body:''};
    const line=lines[first].trim();
    const heading=line.match(/^#{1,2}\s+(.+)/);
    const plain=!heading&&line.length<=90&&!/^([-*+>|`=─_]|\d+[.)]|<)/.test(line)&&!/[.:;,]$/.test(line)&&(!lines[first+1]?.trim()||/^\s*[=─_-]{3,}\s*$/.test(lines[first+1]));
    if(!heading&&!plain)return {title:'',body:String(source)};
    return {title:(heading?heading[1]:line).replace(/\*\*/g,'').trim(),body:lines.slice(first+1).join('\n').replace(/^\s*\n/,'')};
  }
window.renderDeskDocument=renderDocument;
window.deskReportTitle=reportTitle;
})();
