// A terminal's pull requests, as a chip in its pane header. The server reads them with gh: the
// branch's pull request leads, and ones the terminal printed sit behind a +N list. A folder without
// gh, a sign-in, a GitHub remote or a pull request has no chip at all.
const prIcons={
  pr:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6"/></svg>',
  merged:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.1a4 4 0 0 0 4 2.9h1.4"/></svg>',
  passing:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  failing:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  pending:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M8 5.5V8l1.6 1.2"/></svg>',
  log:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5 5.5 7.5l-3 3M7.5 11.5h6"/></svg>',
  close:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>'
};
const prStates={open:'Open',draft:'Draft',merged:'Merged',closed:'Closed'};
const prChecks={passing:'Passing',failing:'Failing',pending:'Pending'};
const prReviews={approved:'Approved',changes_requested:'Changes requested',review_required:'Awaiting review'};
const prParts=pr=>{const live=pr.state==='open'||pr.state==='draft';return {live,checks:live&&prChecks[pr.checks]?pr.checks:null,review:live&&prReviews[pr.review]?pr.review:null};};
const prNeedsYou=pr=>{const {checks,review}=prParts(pr);return checks==='failing'||review==='changes_requested';};
// The list open under a +N segment: one at a time, kept on the page so a pane's overflow never clips it.
let prList=null;

function renderPanePullRequest(view,agent){
  const pr=agent.terminal_id&&!demo?agent.pull_request:null;
  let group=view.node.querySelector('.pane-pr');
  if(!pr){group?.remove();if(prList?.id===agent.id)closePullRequestList();return;}
  if(!group){
    group=document.createElement('span');group.className='pane-tool pane-pr';
    // Its own classes, not the tool chip's: pane-docks.js finds and removes .pane-tool-toggle chips by class.
    group.innerHTML='<a class="pane-pr-link" target="_blank" rel="noopener noreferrer"></a><button type="button" class="pane-pr-log" hidden>'+prIcons.log+'</button><button type="button" class="pane-pr-more" aria-haspopup="true" aria-expanded="false" hidden></button>';
    view.node.querySelector('.pane-actions').prepend(group);
    group.querySelector('.pane-pr-log').onclick=event=>pastePullRequestFailure(agent.id,event.currentTarget);
    group.querySelector('.pane-pr-more').onclick=event=>prList?.id===agent.id?closePullRequestList():openPullRequestList(agent.id,event.currentTarget);
  }
  const others=pr.others||[],{live,checks,review}=prParts(pr),number=escapeHTML(String(pr.number)),alerts=others.filter(prNeedsYou).length;
  if(prList?.id===agent.id)renderPullRequestList(pr,view);
  const signature=JSON.stringify([pr.number,pr.url,pr.state,checks,review,pr.title,pr.failed.map(c=>c.name),pr.logs,!!view.term,others.length,alerts]);
  if(group.dataset.signature===signature)return;group.dataset.signature=signature;
  group.dataset.state=pr.state;group.dataset.checks=checks||'';
  const link=group.querySelector('.pane-pr-link');link.href=pr.url;
  link.innerHTML=`<span class="pane-pr-icon">${pr.state==='merged'?prIcons.merged:prIcons.pr}</span><b>#${number}</b><span class="pane-pr-word">${prStates[pr.state]}</span>${checks?`<span class="pane-pr-checks">${prIcons[checks]}<span class="pane-pr-word">${prChecks[checks]}</span></span>`:''}${review?`<span class="pane-pr-review pane-pr-word" data-review="${review}">${prReviews[review]}</span>`:''}`;
  const failed=checks==='failing'?pr.failed.map(c=>c.name).join(', '):'';
  link.title=[`#${pr.number} ${pr.title}`,prStates[pr.state]+(pr.branch?' on '+pr.branch:''),checks&&'Checks '+prChecks[checks].toLowerCase()+(failed?': '+failed:''),live&&prReviews[pr.review],'Click to open the pull request'].filter(Boolean).join('\n');
  link.setAttribute('aria-label',`Pull request #${pr.number}, ${prStates[pr.state]}`+(checks?`, checks ${prChecks[checks].toLowerCase()}`:'')+(review?`, ${prReviews[review].toLowerCase()}`:'')+'. Opens the pull request');
  // Sending the log is opt in: it is pasted into the agent's prompt and waits for Enter.
  const send=group.querySelector('.pane-pr-log');send.hidden=!(checks==='failing'&&pr.logs&&view.term);
  send.title='Paste the failed check’s log into this agent’s prompt';send.setAttribute('aria-label',send.title);
  // Another pull request that needs you shows on the segment, so it is not hidden behind the count.
  const more=group.querySelector('.pane-pr-more');more.hidden=!others.length;
  more.classList.toggle('alert',!!alerts);more.innerHTML=(alerts?'<span class="pane-pr-dot"></span>':'')+'+'+others.length;
  more.title=`${others.length} more pull request${others.length===1?'':'s'} from this terminal`+(alerts?` · ${alerts} need${alerts===1?'s':''} you`:'');
  more.setAttribute('aria-label',more.title);
  if(!others.length&&prList?.id===agent.id)closePullRequestList();
}

function openPullRequestList(id,button){
  closePullRequestList();
  const node=document.createElement('div');node.className='pane-pr-list';node.setAttribute('role','dialog');node.setAttribute('aria-label','Pull requests from this terminal');
  document.body.append(node);
  prList={id,button,node};button.setAttribute('aria-expanded','true');
  const agent=everyAgent().find(a=>a.id===id);
  if(agent?.pull_request)renderPullRequestList(agent.pull_request,paneViews.get(id));
  node.querySelector('a,button')?.focus({preventScroll:true});
}
function closePullRequestList(focus=false){
  if(!prList)return;
  const {node,button}=prList;prList=null;node.remove();
  button.setAttribute('aria-expanded','false');if(focus&&button.isConnected)button.focus({preventScroll:true});
}
function placePullRequestList(){
  if(!prList)return;
  if(!prList.button.isConnected){closePullRequestList();return;}
  // Right-aligned under the tab, or above it when there is more room there, and always inside the window:
  // a long list scrolls rather than running off the edge.
  const box=prList.button.closest('.pane-pr').getBoundingClientRect(),width=prList.node.offsetWidth;
  const below=innerHeight-box.bottom-14,above=box.top-14,up=below<200&&above>below;
  prList.node.style.maxHeight=Math.max(120,Math.round(up?above:below))+'px';
  prList.node.style.top=Math.round(up?box.top-6-prList.node.offsetHeight:box.bottom+6)+'px';
  prList.node.style.left=Math.round(Math.max(8,Math.min(box.right-width,innerWidth-width-8)))+'px';
}
function renderPullRequestList(pr,view){
  const rows=[pr,...pr.others||[]],signature=JSON.stringify([rows,!!view?.term]);
  if(prList.node.dataset.signature!==signature){
    prList.node.dataset.signature=signature;
    const focused=document.activeElement?.closest('.pane-pr-list [data-url]')?.dataset.url,focusRole=document.activeElement?.dataset.role;
    prList.node.innerHTML=`<p class="pane-pr-list-title"><span>Pull requests from this terminal</span><span>${rows.length}</span></p>`+rows.map(item=>{
      const {checks,review}=prParts(item),url=escapeHTML(item.url);
      return `<div class="pane-pr-row" data-url="${url}" data-state="${item.state}" data-checks="${checks||''}"><span class="pane-pr-icon">${item.state==='merged'?prIcons.merged:prIcons.pr}</span>`+
        `<a class="pane-pr-row-title" data-role="open" href="${url}" target="_blank" rel="noopener noreferrer" title="Open the pull request"><b>#${escapeHTML(String(item.number))}</b>${escapeHTML(item.title)}</a>`+
        `<span class="pane-pr-row-actions">${checks==='failing'&&item.logs&&view?.term?`<button type="button" data-role="log" title="Paste the failed check’s log into this agent’s prompt" aria-label="Paste the failed log of #${escapeHTML(String(item.number))} into this agent’s prompt">${prIcons.log}</button>`:''}`+
        `${item.seen?`<button type="button" data-role="forget" title="Stop showing this pull request here" aria-label="Stop showing #${escapeHTML(String(item.number))} here">${prIcons.close}</button>`:''}</span>`+
        `<span class="pane-pr-row-meta">${item.branch?`<code>${escapeHTML(item.branch)}</code>`:''}<span>${prStates[item.state]}</span>${checks?`<span class="pane-pr-checks">${prIcons[checks]}${prChecks[checks]}</span>`:''}${review?`<span class="pane-pr-review" data-review="${review}">${prReviews[review]}</span>`:''}<span class="pane-pr-row-why" title="${item.seen?escapeHTML(new Date(item.seen*1000).toLocaleString()):''}">${item.seen?'printed '+deskSince(item.seen):'this folder’s branch'}</span></span></div>`;
    }).join('');
    for(const button of prList.node.querySelectorAll('[data-role=log]'))button.onclick=()=>pastePullRequestFailure(prList.id,button,button.closest('[data-url]').dataset.url);
    for(const button of prList.node.querySelectorAll('[data-role=forget]'))button.onclick=()=>forgetPullRequest(prList.id,button.closest('[data-url]').dataset.url);
    if(focused)prList.node.querySelector(`[data-url="${CSS.escape(focused)}"] [data-role="${focusRole}"]`)?.focus({preventScroll:true});
  }
  placePullRequestList();
}
async function forgetPullRequest(id,url){
  try{await terminalRequest('/api/pull-requests/forget',{id,url});await refresh();}
  catch(error){toast(error.message);}
}
document.addEventListener('pointerdown',event=>{if(prList&&!event.target.closest('.pane-pr-list,.pane-pr-more'))closePullRequestList();});
document.addEventListener('keydown',event=>{if(prList&&event.key==='Escape'){event.preventDefault();closePullRequestList(true);}});
addEventListener('resize',placePullRequestList);
document.addEventListener('scroll',placePullRequestList,true);

async function pastePullRequestFailure(id,button,url){
  const view=paneViews.get(id);if(!view?.term)return;
  button.disabled=true;
  try{
    const failure=await terminalRequest('/api/pull-requests/failure-log',{id,url});
    view.term.paste(`The CI check "${failure.check}" is failing on pull request #${failure.number} (${failure.url}). The end of its failed log:\n\n${failure.log}\n\nFind the cause and fix it.`);
    closePullRequestList();view.term.focus();
    toast(`Pasted the ${failure.check} log into the prompt. Press Enter to send it.`);
  }catch(error){toast(error.message);}
  finally{button.disabled=false;}
}
