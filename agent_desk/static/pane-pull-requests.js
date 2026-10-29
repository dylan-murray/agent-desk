// The pull request for a terminal's branch, as a chip in its pane header. The server reads it
// with gh; a folder without gh, a sign-in, a GitHub remote or a pull request has no chip at all.
const prIcons={
  pr:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="12.5" r="1.6"/><path d="M4.5 5.1v5.8M11.5 10.9V6.5a2 2 0 0 0-2-2H7.5M9 3l-1.5 1.5L9 6"/></svg>',
  merged:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4.5" cy="3.5" r="1.6"/><circle cx="4.5" cy="12.5" r="1.6"/><circle cx="11.5" cy="8" r="1.6"/><path d="M4.5 5.1v5.8M4.5 5.1a4 4 0 0 0 4 2.9h1.4"/></svg>',
  passing:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  failing:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 4.5 7 7M11.5 4.5l-7 7"/></svg>',
  pending:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5"/><path d="M8 5.5V8l1.6 1.2"/></svg>',
  log:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4.5 5.5 7.5l-3 3M7.5 11.5h6"/></svg>'
};
const prStates={open:'Open',draft:'Draft',merged:'Merged',closed:'Closed'};
const prChecks={passing:'Passing',failing:'Failing',pending:'Pending'};
const prReviews={approved:'Approved',changes_requested:'Changes requested',review_required:'Awaiting review'};

function renderPanePullRequest(view,agent){
  const pr=agent.terminal_id&&!demo?agent.pull_request:null;
  let group=view.node.querySelector('.pane-pr');
  if(!pr){group?.remove();return;}
  if(!group){
    group=document.createElement('span');group.className='pane-tool pane-pr';
    group.innerHTML='<a class="pane-tool-toggle pane-pr-link" target="_blank" rel="noopener noreferrer"></a><button type="button" class="pane-tool-exit pane-pr-log" hidden>'+prIcons.log+'</button>';
    view.node.querySelector('.pane-actions').prepend(group);
    group.querySelector('.pane-pr-log').onclick=event=>pastePullRequestFailure(agent.id,event.currentTarget);
    new ResizeObserver(()=>fitPullRequest(view)).observe(view.node.querySelector('.terminal-bar'));
  }
  requestAnimationFrame(()=>fitPullRequest(view));
  const live=pr.state==='open'||pr.state==='draft',checks=live&&prChecks[pr.checks]?pr.checks:null,review=live&&prReviews[pr.review]?pr.review:null,number=escapeHTML(String(pr.number));
  const signature=JSON.stringify([pr.number,pr.url,pr.state,checks,review,pr.title,pr.failed.map(c=>c.name),pr.logs,!!view.term]);
  if(group.dataset.signature===signature)return;group.dataset.signature=signature;
  group.dataset.state=pr.state;group.dataset.checks=checks||'';
  const link=group.querySelector('.pane-pr-link');link.href=pr.url;
  link.innerHTML=`<span class="pane-pr-icon">${pr.state==='merged'?prIcons.merged:prIcons.pr}</span><b>#${number}</b><span class="pane-pr-word">${prStates[pr.state]}</span>${checks?`<span class="pane-pr-checks">${prIcons[checks]}<span class="pane-pr-word">${prChecks[checks]}</span></span>`:''}${review?`<span class="pane-pr-review pane-pr-word" data-review="${review}">${prReviews[review]}</span>`:''}`;
  const failed=checks==='failing'?pr.failed.map(c=>c.name).join(', '):'';
  link.title=[`#${pr.number} ${pr.title}`,prStates[pr.state]+' on '+pr.branch,checks&&'Checks '+prChecks[checks].toLowerCase()+(failed?': '+failed:''),live&&pr.review&&prReviews[pr.review],'Click to open the pull request'].filter(Boolean).join('\n');
  link.setAttribute('aria-label',`Pull request #${pr.number}, ${prStates[pr.state]}`+(checks?`, checks ${prChecks[checks].toLowerCase()}`:'')+(live&&prReviews[pr.review]?`, ${prReviews[pr.review].toLowerCase()}`:'')+'. Opens the pull request');
  // Sending the log is opt in: it is pasted into the agent's prompt and waits for Enter.
  const send=group.querySelector('.pane-pr-log');send.hidden=!(checks==='failing'&&pr.logs&&view.term);
  send.title='Paste the failed check’s log into this agent’s prompt';send.setAttribute('aria-label',send.title);
}

// The pane title comes first. While it would be cut short, the tab drops its words: the review,
// then the checks word, then the state, then the pull request icon, leaving the number and the checks icon.
function fitPullRequest(view){
  const group=view.node.querySelector('.pane-pr'),title=view.node.querySelector('.pane-title');if(!group||view.renaming)return;
  for(const fit of ['0','1','2','3','4']){group.dataset.fit=fit;if(title.scrollWidth<=title.clientWidth+1)return;}
}

async function pastePullRequestFailure(id,button){
  const view=paneViews.get(id);if(!view?.term)return;
  button.disabled=true;
  try{
    const failure=await terminalRequest('/api/pull-requests/failure-log',{id});
    view.term.paste(`The CI check "${failure.check}" is failing on pull request #${failure.number} (${failure.url}). The end of its failed log:\n\n${failure.log}\n\nFind the cause and fix it.`);
    view.term.focus();
    toast(`Pasted the ${failure.check} log into the prompt. Press Enter to send it.`);
  }catch(error){toast(error.message);}
  finally{button.disabled=false;}
}
