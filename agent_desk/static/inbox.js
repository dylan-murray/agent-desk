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
      source:agent.name||agent.project||agent.cwd||'Session',category:'attention',state:'review',
      terminal:agent.id,live:true,created:agent.updated
    }));
    const reports=saved.inbox.map(item=>{
      const run=item.event_key.startsWith('run:')?saved.runs.find(run=>run.id===item.event_key.slice(4)):null;
      const role=saved.roles.find(role=>role.id===item.role_id);
      return {...item,source:role?.name||'Automation',terminal:run?.terminal_id,
        category:item.state!=='review'?'history':'review',problem:{blocked:'Blocked',failed:'Failed'}[run?.state]||null};
    });
    const workflowItems=workflowData.executions.filter(run=>['succeeded','ready','failed','blocked','interrupted'].includes(run.state)&&!(run.agent_run&&saved.inbox.some(item=>item.event_key==='run:'+run.agent_run))).map(run=>{const config=workflowData.configs.find(c=>c.id===run.config_id);return {id:run.id,title:(config?.name||run.config_name||'Scheduled task')+' · '+run.state,detail:run.detail||'Open output to inspect this run.',source:'Run & Schedule',category:run.review_state!=='review'?'history':'review',problem:{failed:'Failed',blocked:'Blocked',interrupted:'Interrupted'}[run.state]||null,state:run.review_state,created:run.finished||run.created,workflow:true,url:run.state==='ready'&&run.port?'http://127.0.0.1:'+run.port:''};});
    const coordinatorItems=(demo?[]:coordinatorTasks).filter(task=>task.result!==null).map(task=>{
      const active=agents.some(agent=>agent.id===task.controller&&agent.exit_code===null);
      const delivery=task.acknowledged?'Acknowledged':!active?'Coordinator offline':!task.connection?'Manual inbox check required':task.connection==='policy-blocked'?'Claude channels blocked by organization policy · open coordinator and request an inbox check':task.connection==='delivery-error'?(task.coordinator_harness==='grok'?'Reply delivery stopped · restart the coordinator or request a manual inbox check':'Event bridge error · inspect coordinator'):task.connection==='disconnected'?'Event bridge disconnected':task.connection==='delivery-paused'?'Reply delivery paused after interrupt · send a new message in the coordinator to resume':task.connection==='editing'?'Reply queued while you are typing':task.connection==='needs-input'?'Reply queued until you answer the coordinator':task.delivery==='sent'?'Notification sent · awaiting acknowledgement':['sending','uncertain'].includes(task.delivery)?'Delivery uncertain · inspect coordinator before retrying':'Notification queued';
      return {id:task.id,title:task.task.slice(0,100),detail:delivery+'\n\n'+task.result,source:'Coordinator · '+task.outcome,category:task.acknowledged?'history':'review',problem:task.acknowledged?null:{failed:'Failed',blocked:'Blocked'}[task.outcome]||(!active||!task.connection||['disconnected','delivery-error','policy-blocked','delivery-paused','needs-input'].includes(task.connection)||['sending','uncertain'].includes(task.delivery)?'Not delivered':null),state:task.acknowledged?'done':'review',terminal:active?task.controller:null,created:task.updated,coord:task.controller,connection:task.connection,harness:task.coordinator_harness,delivery:task.delivery};
    });
    // A pull request's checks failing or a new review on it, seen by the server's gh poll.
    const pullRequestItems=(demo?[]:pullRequestEvents).map(event=>({id:event.id,title:event.title,detail:event.detail,source:'Pull request · '+event.repo+' #'+event.number,
      category:event.state!=='review'?'history':'review',problem:event.state==='review'&&event.category==='attention'?(event.kind==='checks'?'Checks failing':'Changes requested'):null,state:event.state,terminal:event.terminal,created:event.created,url:event.url,pr:true}));
    return [...live,...reports,...workflowItems,...coordinatorItems,...pullRequestItems].map(item=>item.category==='history'&&cleared.has(historyKey(item))?{...item,cleared:true}:item).sort((a,b)=>(a.category==='attention'?0:1)-(b.category==='attention'?0:1)||b.created-a.created);
  }
  function matches(item,key){if(item.cleared&&!(showCleared&&key==='history'))return false;return key==='open'?item.state==='review':key==='all'?true:item.category===key;}
  // Only a session stopped on a question is waiting on you; everything else is a report that says how it went.
  const PROBLEM=new Set(['failed','blocked','interrupted']);
  const replies=new Map(),drafts=new Map();
  const live=id=>agents.some(agent=>agent.id===id&&agent.exit_code===null);
  // An automation's report names itself in its first line; other kinds already carry a title of their own.
  const ownTitle=item=>!item.live&&!item.coord&&!item.workflow&&!item.pr;
  // A waiting session's question is its title when it fits on one line; what follows is the body.
  const question=item=>{const lines=(item.detail||'').trim().split('\n');return lines[0]&&lines[0].length<=90?{title:lines[0].replace(/^#+\s*/,''),body:lines.slice(1).join('\n').trim()}:null;};
  const titleOf=item=>item.live?question(item)?.title||item.title:ownTitle(item)&&window.deskReportTitle(item.detail).title||item.title;
  const bodyOf=item=>item.live?(question(item)?question(item).body:item.detail):ownTitle(item)&&window.deskReportTitle(item.detail).title?window.deskReportTitle(item.detail).body:item.detail;
  const stateOf=item=>item.category==='history'?(item.state==='done'?'Reviewed':'Dismissed'):item.live?'Waiting on you':item.problem||'Ready for review';
  const toneOf=item=>item.category==='history'?'done':item.live?'waiting':item.problem?'problem':'review';
  // Where a reply goes, said before it is sent: a waiting or open session gets it typed in (or queued until
  // its prompt is free), a coordinator gets it as a message, and a finished automation run gets a follow-up pass.
  function replyRoute(item){
    if(item.live)return {kind:'session',target:item.terminal,say:`Typed into ${item.source}’s prompt. If it is showing a choice menu, the reply waits until that is answered in the session.`,send:'Send answer'};
    if(item.terminal&&live(item.terminal))return {kind:'session',target:item.terminal,say:item.coord?'Sent to the coordinator as a message.':'Typed into its session, or queued until its prompt is free.',send:item.coord?'Send to coordinator':'Send reply'};
    if(!item.workflow&&!item.coord&&!item.pr&&item.role_id&&item.state==='review')return {kind:'follow-up',say:'Its session has ended. Sending starts a follow-up pass of this automation with the report and your reply.',send:'Start follow-up pass'};
    return null;
  }
  async function sendReply(item,route,reply){
    if(route.kind==='follow-up'){
      await terminalRequest('/api/special-agents/follow-up',{id:item.id,reply,desk:activeDesk().id});
      await window.refreshAutomations?.();return 'Follow-up pass started. Its report comes back here.';
    }
    const request='inbox-'+crypto.randomUUID().replace(/-/g,'');
    const prompt=item.live?reply:`Reply from your Inbox about “${titleOf(item)}”:\n\n${reply}`;
    const result=await terminalRequest('/api/coordinators/submit-feedback',{request_id:request,target_id:route.target,prompt,notes:[{id:request,note:reply}]});
    return result.queued?'Queued. It types when the agent’s prompt is free.':'Typed into its prompt.';
  }
  // Long logs and lists open folded; their full length is one click away.
  function foldLongBlocks(column){
    for(const pre of column.querySelectorAll('.coord-code-block pre')){
      const lines=pre.textContent.replace(/\n$/,'').split('\n').length;if(lines<=12)continue;
      pre.classList.add('inbox-folded');const more=text('button',`Show all ${lines} lines`,'inbox-show-all');more.type='button';
      more.onclick=()=>{const folded=pre.classList.toggle('inbox-folded');more.textContent=folded?`Show all ${lines} lines`:'Show less';};
      pre.closest('.coord-code-block').after(more);
    }
    for(const list of column.querySelectorAll('.inbox-body > ul, .inbox-body > ol')){
      const entries=[...list.children];if(entries.length<=6)continue;
      entries.slice(5).forEach(entry=>entry.hidden=true);const more=text('button',`Show ${entries.length-5} more`,'inbox-show-all');more.type='button';
      more.onclick=()=>{const hidden=entries[5].hidden;entries.slice(5).forEach(entry=>entry.hidden=!hidden);more.textContent=hidden?'Show less':`Show ${entries.length-5} more`;};
      list.after(more);
    }
  }
  // A bare address on a line of its own reads as its address; one inside a sentence becomes a small number,
  // with the addresses gathered at the end, so sentences stay sentences. Links the agent named keep their names.
  function footnoteLinks(column){
    const bare=link=>link.title===link.href;
    const address=link=>{const url=new URL(link.href);const node=document.createElement('span');node.append(text('b',url.hostname.replace(/^www\./,'')),document.createTextNode(url.pathname+url.search));return node;};
    for(const link of column.querySelectorAll('.inbox-body li > a[href^="http"], .inbox-body p > a[href^="http"]')){
      if(!bare(link))continue;
      const rest=link.parentElement.textContent.replace(link.textContent,'').trim();
      if(rest&&!/^[^.]{1,30}:$/.test(rest))continue;
      link.classList.add('inbox-address');link.replaceChildren(address(link));
    }
    const inline=[...column.querySelectorAll('.inbox-body a[href^="http"]:not(.inbox-address)')].filter(link=>bare(link)&&!link.closest('.inbox-finding summary'));
    if(!inline.length)return;
    const box=document.createElement('section');box.className='inbox-links';box.append(text('h4','Links in this report'));const list=document.createElement('ol');box.append(list);
    inline.forEach((link,index)=>{
      const entry=document.createElement('li'),target=document.createElement('a');target.href=link.href;target.target='_blank';target.rel='noopener noreferrer';target.title=link.href;target.append(address(link));entry.append(target);list.append(entry);
      const mark=text('a',String(index+1),'inbox-footnote');mark.href=link.href;mark.target='_blank';mark.rel='noopener noreferrer';mark.title=link.href;mark.setAttribute('aria-label',`Link ${index+1}: ${link.href}`);
      const before=link.previousSibling;if(before?.nodeType===Node.TEXT_NODE)before.textContent=before.textContent.replace(/:\s*$/,' ');
      link.replaceWith(mark);
    });
    column.append(box);
  }
  // The report's sections, beside it, following the scroll; a short report has none.
  function outline(detail,column,doc){
    const heads=[...column.querySelectorAll('.inbox-body > h2, .inbox-body > h3')];
    if(heads.length<2)return null;
    const nav=document.createElement('nav');nav.className='inbox-outline';nav.setAttribute('aria-label','In this report');nav.append(text('p','In this report','inbox-outline-heading'));
    const offset=heading=>heading.getBoundingClientRect().top-detail.getBoundingClientRect().top;
    // A report with sections and subsections shows the subsections indented under their section.
    const nested=heads.some(heading=>heading.tagName==='H2')&&heads.some(heading=>heading.tagName==='H3');
    const links=heads.map(heading=>{const link=text('a',heading.textContent.replace(/^\d+\s*/,''),nested&&heading.tagName==='H3'?'sub':'');link.href='#';link.onclick=event=>{event.preventDefault();detail.scrollTo({top:detail.scrollTop+offset(heading)-80,behavior:'smooth'});};nav.append(link);return link;});
    doc.append(nav);
    return ()=>{let on=0;heads.forEach((heading,index)=>{if(offset(heading)<=120)on=index;});if(detail.scrollTop+detail.clientHeight>=detail.scrollHeight-4)on=heads.length-1;links.forEach((link,index)=>link.classList.toggle('on',index===on));};
  }
  function replyBox(item,route,column){
    const box=document.createElement('section');box.className='inbox-reply';box.setAttribute('aria-label',(item.live?'Answer ':'Reply to ')+item.source);
    const label=text('label',(item.live?'Answer ':'Reply to ')+item.source);label.htmlFor='inbox-reply-text';
    box.append(label,text('p',route.say,'inbox-reply-route'+(item.live?' waiting':'')));
    const options=item.live?[...item.detail.matchAll(/^\s*[-*]\s+\*\*([^*\n]{1,24})\*\*/gm)].map(match=>match[1]):[];
    const area=document.createElement('textarea');area.id='inbox-reply-text';area.rows=3;area.dataset.inboxAction='reply-text';area.value=drafts.get(item.id)||'';
    area.placeholder=item.live?'Answer in your own words…':'Ask a follow-up, answer a question, or tell it what to do next…';
    area.oninput=()=>drafts.set(item.id,area.value);
    const send=action(route.send,async()=>{
      const reply=area.value.trim();if(!reply){area.focus();return;}
      const status=await sendReply(item,route,reply);
      drafts.delete(item.id);replies.set(item.id,[...(replies.get(item.id)||[]),{reply,status,at:Date.now()/1000}]);signature='';render();
    });
    send.classList.add('inbox-reply-send');send.dataset.inboxAction='reply-send';
    area.onkeydown=event=>{if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();send.click();}};
    if(options.length){const quick=document.createElement('div');quick.className='inbox-reply-quick';for(const option of options){const button=action(option,async()=>{area.value=option;send.click();});button.dataset.inboxAction='quick-'+option;quick.append(button);}box.append(quick);}
    const row=document.createElement('div');row.className='inbox-reply-row';row.append(text('span','⌘↵ to send','inbox-reply-hint'),send);
    box.append(area,row);
    for(const sent of replies.get(item.id)||[]){const said=document.createElement('div');said.className='inbox-reply-sent';said.append(text('p','You · '+deskSince(sent.at),'inbox-reply-who'),text('p',sent.reply,'inbox-reply-said'),text('p',sent.status,'inbox-reply-status'));box.append(said);}
    column.append(box);
    // A question the agent asked gets its own Reply, which quotes it into the box.
    for(const heading of column.querySelectorAll('.inbox-body > h2, .inbox-body > h3')){
      if(!/needs from you|open questions?|questions for you/i.test(heading.textContent))continue;
      let list=heading.nextElementSibling;while(list&&!/^(UL|OL|H2|H3)$/.test(list.tagName))list=list.nextElementSibling;
      if(!list||/^H/.test(list.tagName))continue;
      for(const entry of list.children){const asked=entry.textContent.trim();const quote=text('button','Reply','inbox-quote-reply');quote.type='button';quote.setAttribute('aria-label','Reply to: '+asked);
        quote.onclick=()=>{area.value=`> ${asked}\n\n`;drafts.set(item.id,area.value);box.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>{area.focus();area.setSelectionRange(area.value.length,area.value.length);},250);};entry.append(quote);}
    }
    return {box,area};
  }
  function render(){
    const all=items(),query=el('inbox-search').value.toLowerCase().trim();
    const open=all.filter(item=>item.state==='review').length;
    el('review-count').textContent=open;el('review-count').classList.toggle('hidden',!open);el('review-count').classList.toggle('has-reviews',open>0);
    el('open-inbox').setAttribute('aria-label',`Inbox, ${open} items need attention or review`);
    const next=JSON.stringify([all,filter,selected,query,showCleared,[...replies],agents.map(agent=>[agent.id,agent.exit_code])]);if(next===signature)return;signature=next;
    const focused=document.activeElement;
    const focusKey=focused?.dataset.inboxItem||focused?.dataset.inboxFilter||focused?.dataset.inboxAction;
    const focusAttribute=focused?.dataset.inboxItem?'data-inbox-item':focused?.dataset.inboxFilter?'data-inbox-filter':focused?.dataset.inboxAction?'data-inbox-action':null;
    const caret=focused?.tagName==='TEXTAREA'?[focused.selectionStart,focused.selectionEnd]:null;
    const scroll=el('inbox-list').scrollTop;
    const filters=el('inbox-filters');filters.replaceChildren();
    for(const [key,label] of [['open','Open'],['history','History']]){
      const button=action(label,()=>{filter=key;selected=null;render();});
      button.append(text('span',String(all.filter(item=>matches(item,key)).length),'inbox-filter-count'));
      button.dataset.inboxFilter=key;button.setAttribute('aria-pressed',filter===key);filters.append(button);
    }
    const visible=all.filter(item=>matches(item,filter)&&`${item.title} ${titleOf(item)} ${item.detail} ${item.source} ${(item.findings||[]).map(f=>f.title+' '+f.detail).join(' ')}`.toLowerCase().includes(query));
    updateBulkDismiss(visible,query);
    updateClearHistory(all);
    if(!visible.some(item=>item.id===selected))selected=visible[0]?.id||null;
    const list=el('inbox-list');list.replaceChildren();
    if(!visible.length)list.append(text('div',query?'No matching items.':filter==='open'?'You’re caught up. New findings and requests will appear here.':'No items in this view.','special-empty'));
    // Open groups itself: what is waiting on you, then the reports.
    const groups=filter==='open'?[['waiting','Waiting on you',visible.filter(item=>item.live)],['reports','Reports',visible.filter(item=>!item.live)]]:[[null,'',visible]];
    for(const [key,label,members] of groups){
      if(!members.length)continue;
      if(key){const group=document.createElement('div');group.className='inbox-group '+key;group.append(text('span',label),text('span',String(members.length)));list.append(group);}
      for(const item of members){
        const row=document.createElement('button');row.className='inbox-row';row.dataset.inboxItem=item.id;row.setAttribute('aria-pressed',item.id===selected);
        const dot=text('span','','inbox-dot');dot.dataset.tone=toneOf(item);dot.title=stateOf(item);
        const when=text('span',item.created?deskSince(item.created):'','inbox-when');if(item.created)when.title=new Date(item.created*1000).toLocaleString();
        row.append(dot,text('span',item.source,'special-meta inbox-source'),when,text('strong',titleOf(item)),
          text('span',bodyOf(item).replace(/^[#=─_>-]+\s*/gm,'').replace(/\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[*`|]/g,'').replace(/\s+/g,' ').trim().slice(0,160),'inbox-excerpt'),
          text('span',stateOf(item),'inbox-category '+toneOf(item)));
        row.onclick=()=>{selected=item.id;render();};list.append(row);
      }
    }
    list.scrollTop=scroll;
    const detail=el('inbox-detail');const detailScroll=detail.scrollTop;
    const previous=detail.dataset.item;detail.replaceChildren();detail.dataset.item=selected||'';detail.onscroll=null;
    const item=visible.find(item=>item.id===selected);
    if(!item){detail.classList.remove('shrunk');detail.append(text('div','Select an item to see its context and next steps.','special-empty'));return;}
    // The header stays while you read: the report's own title, what it is, and what you can do with it.
    const head=document.createElement('header');head.className='inbox-head';
    const heading=document.createElement('div');heading.className='inbox-heading';
    const meta=document.createElement('p');meta.className='inbox-meta';
    const state=text('span',stateOf(item),'inbox-state');state.dataset.tone=toneOf(item);meta.append(state,text('span',item.source,'inbox-meta-source'));
    if(item.created){const when=text('span',deskSince(item.created),'inbox-meta-when');when.title=new Date(item.created*1000).toLocaleString();meta.append(when);}
    const popout=text('a','Open as document ↗','inbox-popout');popout.href='/inbox-document.html?kind='+(item.live?'session':item.coord?'worker':item.workflow?'workflow':item.pr?'pr':'automation')+'&item='+encodeURIComponent(item.live?item.terminal:item.id);popout.target='_blank';popout.rel='noopener noreferrer';meta.append(popout);
    heading.append(text('h2',titleOf(item)),meta);
    const actions=document.createElement('div');actions.className='special-actions inbox-head-actions';
    const route=replyRoute(item);let reply=null;
    if(route){const button=action(item.live?'Answer':'Reply',()=>{reply?.box.scrollIntoView({behavior:'smooth',block:'center'});setTimeout(()=>reply?.area.focus(),250);});button.classList.add('inbox-reply-open');button.dataset.inboxAction='reply';actions.append(button);}
    if(item.terminal){const button=action(item.live?'Open session':'Open session',()=>openSession(item.terminal));button.dataset.inboxAction='session';actions.append(button);}
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
        const button=action(label,async()=>{await terminalRequest(item.workflow?'/api/workflows/review':item.pr?'/api/pull-requests/review':'/api/special-agents/review',{id:item.id,state});if(item.workflow)await window.refreshWorkflows();else if(item.pr)await refreshPullRequests();else await window.refreshAutomations();});
        button.dataset.inboxAction=state;if(state==='dismissed')button.classList.add('inbox-quiet');actions.append(button);
      }
    }
    head.append(heading,actions);detail.append(head);
    const doc=document.createElement('div');doc.className='inbox-doc';const column=document.createElement('div');column.className='inbox-column';doc.append(column);detail.append(doc);
    const body=document.createElement('article');body.className='inbox-body';renderDocument(body,bodyOf(item));column.append(body);
    for(const finding of item.findings||[]){
      const section=document.createElement('details');section.className='inbox-finding';section.open=true;section.append(text('summary',finding.title));
      const content=document.createElement('article');content.className='inbox-body';renderDocument(content,finding.detail);section.append(content);
      if(/^https?:\/\//.test(finding.url||'')){const link=text('a','View source ↗');link.href=finding.url;link.target='_blank';link.rel='noopener noreferrer';section.append(link);}
      column.append(section);
    }
    if(item.url&&/^https?:\/\//.test(item.url)){
      const link=text('a',item.pr?'Open on GitHub ↗':'View source ↗','inbox-source-link');link.href=item.url;link.target='_blank';link.rel='noreferrer';column.append(link);
    }
    if(item.live)column.append(text('p','This request stays open until the agent’s prompt clears. Opening the session does not approve it.','muted'));
    foldLongBlocks(column);footnoteLinks(column);
    if(route)reply=replyBox(item,route,column);
    const spy=outline(detail,column,doc);
    detail.onscroll=()=>{detail.classList.toggle('shrunk',detail.scrollTop>40);spy?.();};
    if(previous===selected)detail.scrollTop=detailScroll;else detail.scrollTop=0;
    detail.classList.toggle('shrunk',detail.scrollTop>40);spy?.();
    if(focusAttribute){const replacement=[...document.querySelectorAll(`[${focusAttribute}]`)].find(node=>node.getAttribute(focusAttribute)===focusKey);replacement?.focus({preventScroll:true});if(caret&&replacement?.tagName==='TEXTAREA')replacement.setSelectionRange(...caret);}
  }
  const dismissDialog=document.createElement('dialog');dismissDialog.className='schedule-delete-dialog inbox-dismiss-dialog';dismissDialog.setAttribute('aria-labelledby','inbox-dismiss-title');
  dismissDialog.innerHTML='<h2 id="inbox-dismiss-title">Dismiss these items?</h2><p class="inbox-dismiss-scope"></p><p class="muted">They move to History with their reports intact, and you can reopen any of them. Sessions waiting on your answer are never dismissed here.</p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button inbox-dismiss-cancel">Keep them</button><button type="button" class="button inbox-dismiss-confirm">Dismiss all</button></div>';
  document.body.append(dismissDialog);
  let dismissing=false,pending=[];
  const dismissable=list=>list.filter(item=>!item.live&&item.state==='review');
  function updateBulkDismiss(visible,query){
    const button=el('inbox-dismiss-all'),items=dismissable(visible);
    button.hidden=!items.length;if(!items.length)return;
    const scope='the '+({open:'Open',history:'History'}[filter]||filter)+' view';
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
