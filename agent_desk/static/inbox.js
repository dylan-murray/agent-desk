(() => {
  let workflowData={configs:[],executions:[]},coordinatorTasks=[],pullRequestEvents=[];
  let saved={roles:[],inbox:[],runs:[]},filter='open',selected=null,signature='';
  // History items cleared from the Inbox. They are only hidden: the reports, runs and results stay where they live.
  let cleared=new Set(),showCleared=false;
  const historyKey=item=>(item.coord?'coord:':item.workflow?'run:':item.pr?'pr:':'report:')+item.id;
  const el=id=>document.getElementById(id);
  const text=(tag,value,className='')=>{const node=document.createElement(tag);node.textContent=value;node.className=className;return node;};
  const renderDocument=window.renderDeskDocument;
  function action(label,fn){
    const button=text('button',label,'button');
    button.onclick=async()=>{button.disabled=true;try{await fn();}catch(error){toast(error.message);}finally{button.disabled=false;}};
    return button;
  }
  async function openSession(id){
    await refresh();
    if(!agents.some(agent=>agent.id===id))throw Error('This session is no longer available. Its saved report stays in your inbox.');
    demo=false;selectPane(id);
  }
  function items(){
    const live=demo?[]:everyAgent().filter(agent=>agent.status==='needs_input').map(agent=>({
      id:'session:'+agent.id,title:agent.name,detail:agent.question||'This agent needs your response.',
      source:agent.project||agent.cwd||'Session',category:'attention',state:'review',
      terminal:agent.id,live:true,created:agent.updated
    }));
    const reports=saved.inbox.map(item=>{
      const run=item.event_key.startsWith('run:')?saved.runs.find(run=>run.id===item.event_key.slice(4)):null;
      const role=saved.roles.find(role=>role.id===item.role_id);
      return {...item,source:role?.name||'Automation',terminal:run?.terminal_id,
        category:item.state!=='review'?'history':['blocked','failed'].includes(run?.state)?'attention':'review'};
    });
    const workflowItems=workflowData.executions.filter(run=>['succeeded','ready','failed','blocked','interrupted'].includes(run.state)&&!(run.agent_run&&saved.inbox.some(item=>item.event_key==='run:'+run.agent_run))).map(run=>{const config=workflowData.configs.find(c=>c.id===run.config_id);return {id:run.id,title:(config?.name||run.config_name||'Scheduled task')+' · '+run.state,detail:run.detail||'Open output to inspect this run.',source:'Run & Schedule',category:run.review_state!=='review'?'history':['failed','blocked','interrupted'].includes(run.state)?'attention':'review',state:run.review_state,created:run.finished||run.created,workflow:true,url:run.state==='ready'&&run.port?'http://127.0.0.1:'+run.port:''};});
    const coordinatorItems=(demo?[]:coordinatorTasks).filter(task=>task.result!==null).map(task=>{
      const active=agents.some(agent=>agent.id===task.controller&&agent.exit_code===null);
      const delivery=task.acknowledged?'Acknowledged':!active?'Coordinator offline':!task.connection?'Manual inbox check required':task.connection==='policy-blocked'?'Claude channels blocked by organization policy · open coordinator and request an inbox check':task.connection==='delivery-error'?(task.coordinator_harness==='grok'?'Reply delivery stopped · restart the coordinator or request a manual inbox check':'Event bridge error · inspect coordinator'):task.connection==='disconnected'?'Event bridge disconnected':task.connection==='delivery-paused'?'Reply delivery paused after interrupt · send a new message in the coordinator to resume':task.connection==='editing'?'Reply queued while you are typing':task.connection==='needs-input'?'Reply queued until you answer the coordinator':task.delivery==='sent'?'Notification sent · awaiting acknowledgement':['sending','uncertain'].includes(task.delivery)?'Delivery uncertain · inspect coordinator before retrying':'Notification queued';
      return {id:task.id,title:task.task.slice(0,100),detail:delivery+'\n\n'+task.result,source:'Coordinator · '+task.outcome,category:task.acknowledged?'history':!active||!task.connection||['disconnected','delivery-error','policy-blocked','delivery-paused','needs-input'].includes(task.connection)||['blocked','failed'].includes(task.outcome)||['sending','uncertain'].includes(task.delivery)?'attention':'review',state:task.acknowledged?'done':'review',terminal:active?task.controller:null,created:task.updated,coord:task.controller,connection:task.connection,harness:task.coordinator_harness,delivery:task.delivery};
    });
    // A pull request's checks failing or a new review on it, seen by the server's gh poll.
    const pullRequestItems=(demo?[]:pullRequestEvents).map(event=>({id:event.id,title:event.title,detail:event.detail,source:'Pull request · '+event.repo+' #'+event.number,
      category:event.state!=='review'?'history':event.category,state:event.state,terminal:event.terminal,created:event.created,url:event.url,pr:true}));
    return [...live,...reports,...workflowItems,...coordinatorItems,...pullRequestItems].map(item=>item.category==='history'&&cleared.has(historyKey(item))?{...item,cleared:true}:item).sort((a,b)=>(a.category==='attention'?0:1)-(b.category==='attention'?0:1)||b.created-a.created);
  }
  function matches(item,key){if(item.cleared&&!(showCleared&&key==='history'))return false;return key==='open'?item.state==='review':key==='all'?true:item.category===key;}
  function render(){
    const all=items(),query=el('inbox-search').value.toLowerCase().trim();
    const open=all.filter(item=>item.state==='review').length;
    el('review-count').textContent=open;el('review-count').classList.toggle('hidden',!open);el('review-count').classList.toggle('has-reviews',open>0);
    el('open-inbox').setAttribute('aria-label',`Inbox, ${open} items need attention or review`);
    const next=JSON.stringify([all,filter,selected,query,showCleared]);if(next===signature)return;signature=next;
    const focused=document.activeElement;
    const focusKey=focused?.dataset.inboxItem||focused?.dataset.inboxFilter||focused?.dataset.inboxAction;
    const focusAttribute=focused?.dataset.inboxItem?'data-inbox-item':focused?.dataset.inboxFilter?'data-inbox-filter':focused?.dataset.inboxAction?'data-inbox-action':null;
    const scroll=el('inbox-list').scrollTop;
    const filters=el('inbox-filters');filters.replaceChildren();
    for(const [key,label] of [['open','Open'],['attention','Needs you'],['review','Ready for review'],['history','History'],['all','All']]){
      const button=action(`${label} ${all.filter(item=>matches(item,key)).length}`,()=>{filter=key;selected=null;render();});
      button.dataset.inboxFilter=key;button.setAttribute('aria-pressed',filter===key);filters.append(button);
    }
    const visible=all.filter(item=>matches(item,filter)&&`${item.title} ${item.detail} ${item.source} ${(item.findings||[]).map(f=>f.title+' '+f.detail).join(' ')}`.toLowerCase().includes(query));
    updateBulkDismiss(visible,query);
    updateClearHistory(all);
    if(!visible.some(item=>item.id===selected))selected=visible[0]?.id||null;
    const list=el('inbox-list');list.replaceChildren();
    if(!visible.length)list.append(text('div',query?'No matching items.':filter==='open'?'You’re caught up. New findings and requests will appear here.':'No items in this view.','special-empty'));
    for(const item of visible){
      const row=document.createElement('button');row.className='inbox-row';row.dataset.inboxItem=item.id;row.setAttribute('aria-pressed',item.id===selected);
      row.append(text('span',item.category==='attention'?'Needs you':item.category==='history'?(item.state==='done'?'Reviewed':'Dismissed'):'Ready for review','inbox-category '+item.category),text('strong',item.title),text('span',item.source,'special-meta'),text('span',item.detail.replace(/^[#=─_-]+\s*/gm,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*`]/g,'').slice(0,160),'inbox-excerpt'));
      row.onclick=()=>{selected=item.id;render();};list.append(row);
    }
    list.scrollTop=scroll;
    const detail=el('inbox-detail');const detailScroll=detail.scrollTop;
    const previous=detail.dataset.item;detail.replaceChildren();detail.dataset.item=selected||'';
    const item=visible.find(item=>item.id===selected);
    if(!item){detail.append(text('div','Select an item to see its context and next steps.','special-empty'));return;}
    detail.append(text('p',item.live?'SESSION · RESPONSE REQUESTED':item.coord?'WORKER REPLY · '+item.source:item.pr?item.source.toUpperCase():'AUTOMATION · '+item.source,'inbox-kicker'),text('h2',item.title));
    if(item.created)detail.append(text('p',new Date(item.created*1000).toLocaleString(),'special-meta'));
    const popout=text('a','Open as document ↗','inbox-popout');popout.href='/inbox-document.html?kind='+(item.live?'session':item.coord?'worker':item.workflow?'workflow':item.pr?'pr':'automation')+'&item='+encodeURIComponent(item.live?item.terminal:item.id);popout.target='_blank';popout.rel='noopener noreferrer';detail.append(popout);
    const body=document.createElement('article');body.className='inbox-body';renderDocument(body,item.detail);detail.append(body);
    for(const finding of item.findings||[]){
      const section=document.createElement('details');section.className='inbox-finding';section.open=true;section.append(text('summary',finding.title));
      const content=document.createElement('article');content.className='inbox-body';renderDocument(content,finding.detail);section.append(content);
      if(/^https?:\/\//.test(finding.url||'')){const link=text('a','View source ↗');link.href=finding.url;link.target='_blank';link.rel='noopener noreferrer';section.append(link);}
      detail.append(section);
    }
    if(item.url&&/^https?:\/\//.test(item.url)){
      const link=text('a',item.pr?'Open on GitHub ↗':'View source ↗');link.href=item.url;link.target='_blank';link.rel='noreferrer';detail.append(link);
    }
    const actions=document.createElement('div');actions.className='special-actions';
    if(item.terminal){const button=action(item.live?'Open session to respond':'Open session',()=>openSession(item.terminal));button.dataset.inboxAction='session';actions.append(button);}
    if(item.workflow)actions.append(action('Open output',()=>window.openWorkflowRun?.(item.id)));
    if(item.coord){
      if(item.state==='review'){
        actions.append(action('Mark handled',async()=>{await terminalRequest('/api/coordinator-events/ack',{id:item.id,controller:item.coord});await refreshCoordinatorEvents();}));
        if(item.terminal&&item.connection!=='policy-blocked'&&!(item.harness==='grok'&&item.connection==='delivery-error'))actions.append(action('Retry notification',async()=>{
          if(!confirm('This may send a duplicate notification. Check the coordinator first. Retry?'))return;
          await terminalRequest('/api/coordinator-events/retry',{id:item.id,controller:item.coord});await refreshCoordinatorEvents();
        }));
      }
    }else if(!item.live){
      for(const [label,state] of item.state==='review'?[['Mark reviewed','done'],['Dismiss','dismissed']]:[['Reopen','review']]){
        const button=action(label,async()=>{await terminalRequest(item.workflow?'/api/workflows/review':item.pr?'/api/pull-requests/review':'/api/special-agents/review',{id:item.id,state});if(item.workflow)await window.refreshWorkflows();else if(item.pr)await refreshPullRequests();else await window.refreshAutomations();});button.dataset.inboxAction=state;actions.append(button);
      }
    }
    detail.append(actions);
    if(item.live)detail.append(text('p','This request stays open until the agent’s prompt clears. Opening the session does not approve it.','muted'));
    if(previous===selected)detail.scrollTop=detailScroll;
    if(focusAttribute){const replacement=[...document.querySelectorAll(`[${focusAttribute}]`)].find(node=>node.getAttribute(focusAttribute)===focusKey);replacement?.focus({preventScroll:true});}
  }
  const dismissDialog=document.createElement('dialog');dismissDialog.className='schedule-delete-dialog inbox-dismiss-dialog';dismissDialog.setAttribute('aria-labelledby','inbox-dismiss-title');
  dismissDialog.innerHTML='<h2 id="inbox-dismiss-title">Dismiss these items?</h2><p class="inbox-dismiss-scope"></p><p class="muted">They move to History with their reports intact, and you can reopen any of them. Sessions waiting on your answer are never dismissed here.</p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button inbox-dismiss-cancel">Keep them</button><button type="button" class="button inbox-dismiss-confirm">Dismiss all</button></div>';
  document.body.append(dismissDialog);
  let dismissing=false,pending=[];
  const dismissable=list=>list.filter(item=>!item.live&&item.state==='review');
  function updateBulkDismiss(visible,query){
    const button=el('inbox-dismiss-all'),items=dismissable(visible);
    button.hidden=!items.length;if(!items.length)return;
    const scope=filter==='all'?'every view':'the '+({open:'Open',attention:'Needs you',review:'Ready for review',history:'History'}[filter]||filter)+' view';
    button.textContent='Dismiss all '+items.length;
    button.setAttribute('aria-label',`Dismiss all ${items.length} items in ${scope}`);
    button.onclick=()=>openBulkDismiss(items,scope,query);
  }
  function openBulkDismiss(items,scope,query){
    if(dismissing)return;pending=items;
    dismissDialog.querySelector('.inbox-dismiss-scope').textContent=`${items.length} item${items.length===1?'':'s'} in ${scope}${query?' matching “'+query+'”':''}.`;
    dismissDialog.querySelector('[role=alert]').textContent='';
    dismissDialog.showModal();dismissDialog.querySelector('.inbox-dismiss-cancel').focus();
  }
  dismissDialog.querySelector('.inbox-dismiss-cancel').onclick=()=>dismissDialog.close();
  dismissDialog.addEventListener('cancel',event=>{if(dismissing)event.preventDefault();});
  function dismissItem(item){
    if(item.coord)return terminalRequest('/api/coordinator-events/ack',{id:item.id,controller:item.coord});
    return terminalRequest(item.workflow?'/api/workflows/review':item.pr?'/api/pull-requests/review':'/api/special-agents/review',{id:item.id,state:'dismissed'});
  }
  dismissDialog.querySelector('.inbox-dismiss-confirm').onclick=async()=>{
    if(dismissing)return;dismissing=true;
    const buttons=[...dismissDialog.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
    let done=0,failure=null;
    for(const item of pending){try{await dismissItem(item);done++;}catch(error){failure=error;break;}}
    // Refresh every source: one view can mix automation, workflow and coordinator items.
    try{await window.refreshAutomations?.();}catch(error){failure=failure||error;}
    try{await window.refreshWorkflows?.();}catch(error){failure=failure||error;}
    await refreshCoordinatorEvents();await refreshPullRequests();
    dismissing=false;buttons.forEach(button=>button.disabled=false);
    if(failure)dismissDialog.querySelector('[role=alert]').textContent=`Dismissed ${done} of ${pending.length}. ${failure.message}`;
    else{dismissDialog.close();toast(`Dismissed ${done} item${done===1?'':'s'}.`);}
    render();
  };
  async function refreshCoordinatorEvents(){
    try{const data=await terminalRequest('/api/coordinator-events');coordinatorTasks=Array.isArray(data.tasks)?data.tasks:[];window.updateWorkerCompletions?.(coordinatorTasks);render();}
    catch(error){if(error.message!=='Not found')console.warn('Coordinator inbox unavailable:',error.message);}
  }
  async function refreshPullRequests(){
    try{const data=await terminalRequest('/api/pull-requests');pullRequestEvents=Array.isArray(data.events)?data.events:[];render();}
    catch(error){if(error.message!=='Not found')console.warn('Pull request inbox unavailable:',error.message);}
  }
  window.refreshCoordinatorEvents=refreshCoordinatorEvents;
  setInterval(()=>{if(!demo){refreshCoordinatorEvents();refreshPullRequests();}},5000);
  refreshCoordinatorEvents();refreshPullRequests();
  const clearDialog=document.createElement('dialog');clearDialog.className='schedule-delete-dialog inbox-dismiss-dialog';clearDialog.setAttribute('aria-labelledby','inbox-clear-title');
  clearDialog.innerHTML='<h2 id="inbox-clear-title">Clear History?</h2><p class="inbox-clear-scope"></p><p class="muted">Nothing is deleted. Run output stays in Run &amp; Schedule, coordinator results stay with their coordinator, and History can show cleared items again.</p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button inbox-clear-cancel">Cancel</button><button type="button" class="button danger inbox-clear-confirm">Clear history</button></div>';
  document.body.append(clearDialog);
  let clearing=[];
  // Clear history is offered on every filter, not only History.
  function updateClearHistory(all){
    const history=all.filter(item=>item.category==='history'),hidden=history.filter(item=>item.cleared).length,shown=history.length-hidden;
    const clear=el('inbox-clear-history'),toggle=el('inbox-show-cleared');
    clear.hidden=!shown||(filter==='history'&&showCleared);clear.textContent='Clear history';
    clear.onclick=()=>{clearing=history.filter(item=>!item.cleared);clearDialog.querySelector('.inbox-clear-scope').textContent=`${clearing.length} item${clearing.length===1?'':'s'} leave the Inbox.`;clearDialog.querySelector('[role=alert]').textContent='';clearDialog.showModal();clearDialog.querySelector('.inbox-clear-cancel').focus();};
    toggle.hidden=filter!=='history'||!hidden;toggle.textContent=showCleared?'Hide cleared':`Show ${hidden} cleared`;
    toggle.setAttribute('aria-pressed',String(showCleared));
    toggle.onclick=()=>{showCleared=!showCleared;render();};
  }
  clearDialog.querySelector('.inbox-clear-cancel').onclick=()=>clearDialog.close();
  clearDialog.querySelector('.inbox-clear-confirm').onclick=async()=>{
    const button=clearDialog.querySelector('.inbox-clear-confirm');button.disabled=true;
    try{const result=await terminalRequest('/api/inbox/clear-history',{keys:clearing.map(historyKey)});cleared=new Set(result.keys);showCleared=false;clearDialog.close();toast(`Cleared ${clearing.length} item${clearing.length===1?'':'s'} from History.`);render();}
    catch(error){clearDialog.querySelector('[role=alert]').textContent=error.message==='Not found'?'Restart Agent Desk to clear History.':error.message;}
    finally{button.disabled=false;}
  };
  fetch('/api/inbox/cleared').then(response=>response.ok?response.json():{keys:[]}).then(data=>{cleared=new Set(data.keys||[]);render();}).catch(()=>{});
  window.updateWorkflowInbox=data=>{workflowData=data;render();};
  window.renderWorkInbox=render;
  window.updateAutomationInbox=data=>{saved=data;render();};
  window.setInboxStatus=message=>{el('inbox-status').textContent=message;};
  el('open-inbox').onclick=()=>{switchPage('inbox');render();window.refreshAutomations?.();refreshCoordinatorEvents();refreshPullRequests();};
  el('refresh-inbox').onclick=async()=>{await refresh();await monitorTerminals();await window.refreshAutomations?.();render();};
  el('inbox-search').oninput=render;
  render();
})();
