(()=>{
const make=(tag,value,cls='')=>{const n=document.createElement(tag);n.textContent=value;n.className=cls;return n;};
function preview(source){
  const doc=new DOMParser().parseFromString(source,'text/html');
  // Sandbox and CSP enforce isolation. Remove navigation and active elements
  // too: a report is a diagram, not another app or a route to external sites.
  doc.querySelectorAll('script,meta,base,link,iframe,object,embed,form').forEach(n=>n.remove());
  for(const element of doc.querySelectorAll('*'))for(const attr of [...element.attributes]){
    const key=attr.name.toLowerCase();
    if(key.startsWith('on')||['action','formaction','srcdoc','target','download'].includes(key)||
       ((key==='href'||key==='xlink:href')&&!(element.localName!=='a'&&attr.value.startsWith('#'))))element.removeAttribute(attr.name);
  }
  const csp=doc.createElement('meta');csp.httpEquiv='Content-Security-Policy';
  csp.content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  const style=doc.createElement('style');style.textContent=':root{color-scheme:dark}*{box-sizing:border-box}body{margin:0;padding:24px;background:#141414;color:#d1d1cf;font:16px/1.5 system-ui,sans-serif}svg,img{max-width:100%;height:auto}';
  doc.head.prepend(csp,style);
  return '<!doctype html>'+doc.documentElement.outerHTML;
}
window.renderDeskDiagrams=node=>{
  let count=0;
  for(const block of [...node.querySelectorAll('.coord-code-block')]){
    if(block.querySelector('.coord-code-language')?.textContent!=='html-diagram')continue;
    const source=block.querySelector('code').textContent;
    if(source.length>200000||++count>12){block.prepend(make('p','Diagram preview limit reached. HTML source is shown below.'));continue;}
    const parsed=new DOMParser().parseFromString(source,'text/html');
    const title=(parsed.querySelector('title,h1,h2')?.textContent?.trim()||'Diagram').slice(0,120);
    const figure=make('figure','','document-diagram'),bar=make('figcaption','','document-diagram-bar');
    bar.append(make('span',title));
    const expand=make('button','Expand');expand.type='button';expand.setAttribute('aria-expanded','false');
    expand.onclick=()=>{const open=figure.classList.toggle('is-expanded');expand.textContent=open?'Collapse':'Expand';expand.setAttribute('aria-expanded',String(open));};bar.append(expand);
    const frame=document.createElement('iframe');frame.title=title;frame.setAttribute('sandbox','');frame.referrerPolicy='no-referrer';frame.srcdoc=preview(source);
    const details=make('details','','document-diagram-source');details.append(make('summary','HTML source'));
    block.replaceWith(figure);details.append(block);figure.append(bar,frame,details);
  }
};
})();
