// Web pages in workspace panes. A web page is not an agent session: it lives in this tab's
// pane state beside openPaneIds, and never in /api/agents, the agent map or the agent counts.
// Closing its pane closes the page, like closing a browser tab.
const webPages=new Map();
try{for(const page of JSON.parse(sessionStorage.getItem('agent-desk-web-pages')||'[]'))if(page?.id&&framePageUrl(page.url))webPages.set(page.id,page);}catch{}
let recentWebPages=[];
try{recentWebPages=JSON.parse(localStorage.getItem('agent-desk-recent-web-pages')||'[]').filter(url=>typeof url==='string');}catch{}
function saveWebPages(){try{sessionStorage.setItem('agent-desk-web-pages',JSON.stringify([...webPages.values()]));}catch{}}
function forgetWebPage(id){if(webPages.delete(id))saveWebPages();}
// "localhost:3000" parses as a URL whose scheme is "localhost:", so a colon followed by digits
// is a port, not a scheme. Local and port-qualified hosts default to http, the rest to https.
// The http(s) address a frame or link may use, or '' for anything else. The desk's own address is
// refused too: a frame on this origin, sandboxed or not, could act as the desk.
function framePageUrl(text){
  let url;try{url=new URL(String(text||''));}catch{return '';}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname)return '';
  const local=host=>['localhost','127.0.0.1','[::1]','0.0.0.0'].includes(host)||host.endsWith('.localhost');
  const port=at=>at.port||(at.protocol==='https:'?'443':'80');
  if(port(url)===port(location)&&(url.hostname===location.hostname||local(url.hostname)&&local(location.hostname)))return '';
  return url.href;
}
function webAddress(text){
  let value=String(text||'').trim();
  if(!value)throw Error('Enter a web address');
  if(!/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(value))value=(/^(localhost|127\.|0\.0\.0\.0|\[::1\]|[^/?#]+:\d+(?:[/?#]|$))/i.test(value)?'http://':'https://')+value;
  let url;try{url=new URL(value);}catch{throw Error('That is not a web address');}
  if(!['http:','https:'].includes(url.protocol)||!url.hostname)throw Error('Web pages must use an http or https address');
  if(!framePageUrl(url.href))throw Error('Agent Desk cannot open itself in a pane');
  return url.href;
}
const webPageHost=url=>{try{return new URL(url).host;}catch{return url;}};
const webPageTitle=page=>page.name||webPageHost(page.url);
function rememberWebPage(url){
  recentWebPages=[url,...recentWebPages.filter(item=>item!==url)].slice(0,8);
  try{localStorage.setItem('agent-desk-recent-web-pages',JSON.stringify(recentWebPages));}catch{}
}
// quiet: opened on an agent's behalf, so it joins the desk without taking focus or the page.
function openWebPage(url,name='',{quiet=false}={}){
  url=framePageUrl(url);if(!url)return;
  const page={id:'web-'+crypto.randomUUID().slice(0,8),url,name};
  if(quiet&&openPaneIds.length>=PANE_LIMIT)return;
  webPages.set(page.id,page);saveWebPages();rememberWebPage(url);
  demo=false;paneMode=paneStoreKey();
  if(openPaneIds.length>=PANE_LIMIT)openPaneIds=openPaneIds.filter(id=>id!==selectedId).slice(0,PANE_LIMIT-1);
  openPaneIds.push(page.id);
  if(quiet){savePanes();render();return;}
  selectedId=page.id;savePanes();switchPage('agents');render();paneViews.get(page.id)?.node.scrollIntoView({block:'nearest'});
}

const webIcons={
  reload:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13 8a5 5 0 1 1-1.46-3.54"/><path d="M13 2.5v3h-3"/></svg>',
  open:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 7.5 8.5"/><path d="M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3"/></svg>',
  globe:'<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>'
};
// A web pane is the same pane shell as a terminal, without the process controls.
function createWebPane(page){
  const view=createPane({id:page.id,name:webPageTitle(page)}),node=view.node;
  node.classList.add('web-pane');
  node.querySelectorAll('.pane-usage,.pane-state,.pane-stop,.pane-protect,.pane-connection,.pane-readouts').forEach(item=>item.remove());
  node.querySelector('.pane-expand').insertAdjacentHTML('beforebegin',`<button class="pane-reload pane-icon" title="Reload page" aria-label="Reload page">${webIcons.reload}</button><a class="pane-open pane-icon" target="_blank" rel="noopener noreferrer" title="Open in a new tab" aria-label="Open in a new tab">${webIcons.open}</a>`);
  // A web page's address stays at the top, where it is edited; terminals carry their folder in the status line.
  const status=node.querySelector('.pane-directory');status.classList.remove('pane-status');node.querySelector('.terminal-bar').after(status);
  const close=node.querySelector('.pane-close');close.title='Close web page';close.setAttribute('aria-label','Close web page');
  const body=node.querySelector('.pane-body');body.classList.add('web-pane-body');
  // No allow-top-navigation: a framed page can never navigate Agent Desk itself away.
  body.innerHTML='<iframe class="web-pane-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox" referrerpolicy="no-referrer" allow="clipboard-write; fullscreen"></iframe><div class="web-pane-notice" hidden></div>';
  const title=node.querySelector('.pane-title'),address=node.querySelector('.pane-directory');
  for(const [target,label,edit] of [[title,'Click to rename',()=>editWebPane(view,page.id,'name')],[address,'Click to change the address',()=>editWebPane(view,page.id,'url')]]){
    target.tabIndex=0;target.setAttribute('role','button');target.title=label;
    target.onclick=()=>{if(!annotating&&performance.now()-paneDragEndedAt>250)edit();};
    target.onkeydown=event=>{if(event.target===target&&['Enter',' '].includes(event.key)){event.preventDefault();edit();}};
  }
  node.querySelector('.pane-reload').onclick=()=>loadWebPane(view,webPages.get(page.id));
  return view;
}
function updateWebPane(view,page){
  const title=view.node.querySelector('.pane-title'),address=view.node.querySelector('.pane-directory');
  if(!view.renaming){title.textContent=webPageTitle(page);address.textContent=page.url;}
  address.title=page.url+' · click to change';
  view.node.querySelector('.pane-open').href=framePageUrl(page.url)||'about:blank';
  view.node.querySelector('.web-pane-frame').title=webPageTitle(page);view.node.setAttribute('aria-label',webPageTitle(page)+' web page');
  if(view.loadedUrl!==page.url)loadWebPane(view,page);
}
// The frame loads at once; the desk's own request runs alongside it and only steps in when
// the page refuses to be framed or cannot be reached, which the browser would otherwise show
// as a bare "refused to connect" that reads like the site being down.
function loadWebPane(view,page){
  const frame=view.node.querySelector('.web-pane-frame'),ticket=(view.check||0)+1;
  view.check=ticket;view.loadedUrl=page.url;
  showWebPaneNotice(view,null);frame.src=framePageUrl(page.url)||'about:blank';
  terminalRequest('/api/web-pages/check?url='+encodeURIComponent(page.url)).then(result=>{
    if(!view.disposed&&view.check===ticket&&(!result.reachable||result.embeddable===false))showWebPaneNotice(view,page,result);
  // An unavailable check leaves the frame exactly as the browser rendered it.
  }).catch(()=>{});
}
function showWebPaneNotice(view,page,result){
  const notice=view.node.querySelector('.web-pane-notice'),frame=view.node.querySelector('.web-pane-frame');
  notice.hidden=!result;frame.hidden=!!result;
  if(!result){notice.replaceChildren();return;}
  const host=escapeHTML(webPageHost(result.url||page.url)),open=`<a class="button" href="${escapeHTML(page.url)}" target="_blank" rel="noopener noreferrer">Open in a new tab</a>`;
  notice.innerHTML=result.reachable
    ?`<div class="terminal-empty"><div class="terminal-empty-icon">${webIcons.globe}</div><h2>${host} can’t be shown in a pane</h2><p>The site tells browsers not to display it inside another page.</p><div class="resume-actions">${open}</div><small><code>${escapeHTML(result.header+': '+result.value)}</code></small></div>`
    :`<div class="terminal-empty"><div class="terminal-empty-icon">${webIcons.globe}</div><h2>Couldn’t reach ${host}</h2><p>${escapeHTML((result.reason||'the page did not respond').replace(/^./,c=>c.toUpperCase()))}. If it is a local server, check that it is running.</p><div class="resume-actions"><button class="button web-pane-retry">Retry</button><button class="text-button web-pane-anyway">Show the page anyway</button></div></div>`;
  notice.querySelector('.web-pane-retry')?.addEventListener('click',()=>loadWebPane(view,webPages.get(view.node.dataset.paneId)));
  notice.querySelector('.web-pane-anyway')?.addEventListener('click',()=>showWebPaneNotice(view,null));
}
function editWebPane(view,id,field){
  const page=webPages.get(id);if(view.renaming||!page)return;
  const target=view.node.querySelector(field==='name'?'.pane-title':'.pane-directory'),bar=view.node.querySelector('.terminal-bar'),input=document.createElement('input');
  view.renaming=true;bar.dataset.paneDrag='off';
  input.className='pane-name-input'+(field==='url'?' web-address-input':'');input.value=field==='name'?webPageTitle(page):page.url;input.maxLength=field==='name'?100:4000;input.spellcheck=false;
  input.setAttribute('aria-label',field==='name'?'Page name':'Web address');target.replaceChildren(input);
  let finished=false;
  const restore=()=>{view.renaming=false;delete bar.dataset.paneDrag;const latest=webPages.get(id);if(latest)updateWebPane(view,latest);};
  const save=()=>{
    if(finished)return;finished=true;const value=input.value.trim();
    try{
      if(field==='name')page.name=value===webPageHost(page.url)?'':value;
      else if(value){page.url=webAddress(value);rememberWebPage(page.url);}
      saveWebPages();
    }catch(error){toast(error.message);}
    restore();
  };
  input.onkeydown=event=>{event.stopPropagation();if(event.key==='Escape'){finished=true;restore();target.focus();}else if(event.key==='Enter'){event.preventDefault();save();}};
  input.onblur=save;input.focus();input.select();
}
// Focus inside a frame never reaches the pane's own listeners, so follow it from the window.
window.addEventListener('blur',()=>setTimeout(()=>{
  const pane=document.activeElement?.closest?.('.web-pane');
  if(pane&&selectedId!==pane.dataset.paneId){selectedId=pane.dataset.paneId;highlightPanes();}
}));

function openWebPageDialog(){
  $('#web-page-recent').innerHTML=recentWebPages.map(url=>`<option value="${escapeHTML(url)}"></option>`).join('');
  $('#web-page-url').value='';$('#web-page-name').value='';$('#web-page-error').textContent='';
  $('#web-page-dialog').showModal();
}
// New opens a menu: a terminal, or a web page.
function setNewPaneMenu(open,focus){
  const menu=$('#new-pane-options'),items=[...menu.querySelectorAll('[role=menuitem]')];
  menu.hidden=!open;$('#new-terminal').setAttribute('aria-expanded',String(open));
  // The menu hangs from the button's right edge, unless a narrow toolbar wrapped New to the left.
  menu.classList.remove('align-start');
  if(open&&menu.getBoundingClientRect().left<8)menu.classList.add('align-start');
  if(open&&focus)items[focus==='last'?items.length-1:0].focus();
}
document.addEventListener('DOMContentLoaded',()=>{
  const button=$('#new-terminal'),menu=$('#new-pane-options');
  button.onclick=()=>setNewPaneMenu(menu.hidden,false);
  button.onkeydown=event=>{
    if(['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();setNewPaneMenu(true,event.key==='ArrowUp'?'last':'first');}
    else if(event.key==='Escape'&&!menu.hidden){event.preventDefault();setNewPaneMenu(false);}
  };
  menu.onkeydown=event=>{
    const items=[...menu.querySelectorAll('[role=menuitem]')],index=items.indexOf(document.activeElement);
    if(event.key==='Escape'){event.preventDefault();setNewPaneMenu(false);button.focus();}
    else if(event.key==='Tab')setNewPaneMenu(false);
    else if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
      event.preventDefault();
      const next={ArrowDown:index+1,ArrowUp:index-1,Home:0,End:items.length-1}[event.key];
      items[(next+items.length)%items.length].focus();
    }
  };
  menu.onclick=event=>{
    const item=event.target.closest('[data-new-pane]');if(!item)return;
    setNewPaneMenu(false);
    if(item.dataset.newPane==='web')openWebPageDialog();else openTerminalLauncher();
  };
  document.addEventListener('pointerdown',event=>{if(!menu.hidden&&!event.target.closest('.new-pane-menu'))setNewPaneMenu(false);});
  $('#web-page-form').onsubmit=event=>{
    event.preventDefault();
    try{openWebPage(webAddress($('#web-page-url').value),$('#web-page-name').value.trim());$('#web-page-dialog').close();}
    catch(error){$('#web-page-error').textContent=error.message;}
  };
});
