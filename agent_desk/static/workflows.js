(() => {
  let data={configs:[],workflows:[],flows:[],executions:[]},selected=null,workflowEditing=null,configEditing=null,scheduleSaving=false,workflowUpdating=false,taskRows=[],agentMap=false,mapFocusId=null,loading=false,refreshPromise=null;
  const $id=id=>document.getElementById(id),labels={queued:'Queued',starting:'Starting',running:'Running',ready:'Ready',succeeded:'Succeeded',failed:'Failed',blocked:'Blocked',skipped:'Skipped',cancelled:'Cancelled',interrupted:'Interrupted'};
  function node(tag,text,cls=''){const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;}
  function button(label,fn){const b=node('button',label,'button');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
  const date=value=>value?new Date(value*1000).toLocaleString():'—';
  async function request(action,payload){const result=await terminalRequest('/api/workflows/'+action,payload);await refresh();return result;}
  async function logs(run){const result=await terminalRequest('/api/workflows/logs?id='+encodeURIComponent(run.id));$id('run-log-content').textContent=result.text;$id('run-log-title').textContent='Output · '+(data.configs.find(c=>c.id===run.config_id)?.name||run.config_name||run.node_id||run.id);$id('run-log-dialog').showModal();}
  function showRun(run){if(run.terminal_id){demo=false;selectPane(run.terminal_id);}else logs(run);}
  const configDeleteDialog=document.createElement('dialog');configDeleteDialog.id='run-config-delete-dialog';configDeleteDialog.className='schedule-delete-dialog';configDeleteDialog.setAttribute('aria-labelledby','run-config-delete-title');
  configDeleteDialog.innerHTML='<h2 id="run-config-delete-title">Delete launch configuration?</h2><p class="schedule-delete-name"></p><p class="muted">Past runs, logs, and Inbox results stay available. A saved automation used by this configuration is kept.</p><p class="muted config-delete-usage"></p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button config-delete-cancel">Keep configuration</button><button type="button" class="button config-delete-confirm">Delete configuration</button></div>';
  document.body.append(configDeleteDialog);let deletingConfig=null,configDeleting=false;
  function openDeleteConfig(config){
    if(configDeleting)return;deletingConfig=config.id;
    configDeleteDialog.querySelector('.schedule-delete-name').textContent=config.name;
    const used=data.workflows.filter(w=>w.nodes.some(n=>n.config_id===config.id)).map(w=>w.name);
    configDeleteDialog.querySelector('.config-delete-usage').textContent=used.length?'Used by '+used.join(', ')+'. Remove this task from those workflows, or delete the workflows first.':'';
    configDeleteDialog.querySelector('[role=alert]').textContent='';configDeleteDialog.showModal();configDeleteDialog.querySelector('.config-delete-cancel').focus();
  }
  configDeleteDialog.querySelector('.config-delete-cancel').onclick=()=>configDeleteDialog.close();
  configDeleteDialog.addEventListener('cancel',event=>{if(configDeleting)event.preventDefault();});
  configDeleteDialog.querySelector('.config-delete-confirm').onclick=async()=>{
    if(configDeleting)return;configDeleting=true;const buttons=[...configDeleteDialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{
      await terminalRequest('/api/workflows/delete-config',{id:deletingConfig});
      data.configs=data.configs.filter(c=>c.id!==deletingConfig);render();configDeleteDialog.close();await refresh();
    }catch(error){configDeleteDialog.querySelector('.config-delete-usage').textContent='';configDeleteDialog.querySelector('[role=alert]').textContent=error.message==='Not found'?'Restart Agent Desk to activate configuration deletion. A restart stops managed agent terminals. This configuration has not been deleted.':error.message;}
    finally{configDeleting=false;buttons.forEach(b=>b.disabled=false);}
  };
  const deleteDialog=document.createElement('dialog');deleteDialog.className='schedule-delete-dialog';deleteDialog.setAttribute('aria-labelledby','schedule-delete-title');
  deleteDialog.innerHTML='<h2 id="schedule-delete-title">Delete schedule?</h2><p class="schedule-delete-name"></p><p class="muted">Future runs will stop. Existing runs and history will stay available.</p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button schedule-delete-cancel">Keep schedule</button><button type="button" class="button schedule-delete-confirm">Delete schedule</button></div>';
  document.body.append(deleteDialog);let deletingSchedule=null,deleting=false;
  function openDeleteSchedule(workflow){if(deleting)return;deletingSchedule=workflow.id;deleteDialog.querySelector('.schedule-delete-name').textContent=workflow.name;deleteDialog.querySelector('[role="alert"]').textContent='';deleteDialog.showModal();deleteDialog.querySelector('.schedule-delete-cancel').focus();}
  deleteDialog.querySelector('.schedule-delete-cancel').onclick=()=>deleteDialog.close();
  deleteDialog.addEventListener('cancel',event=>{if(deleting)event.preventDefault();});
  deleteDialog.querySelector('.schedule-delete-confirm').onclick=async()=>{
    if(deleting)return;deleting=true;const buttons=[...deleteDialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
    try{
      await terminalRequest('/api/workflows/delete',{id:deletingSchedule});
      data.workflows=data.workflows.filter(w=>w.id!==deletingSchedule);render();deleteDialog.close();await refresh();
    }catch(error){deleteDialog.querySelector('[role="alert"]').textContent=error.message==='Not found'?'The backend needs a restart to enable schedule deletion. Your schedule has not been deleted.':error.message;}
    finally{deleting=false;buttons.forEach(b=>b.disabled=false);}
  };
  function runActions(config){const actions=node('div','','special-actions'),run=data.executions.find(r=>r.config_id===config.id&&!r.flow_id)||data.executions.find(r=>r.config_id===config.id);
    actions.append(button('Run',()=>request('launch',{id:config.id})),button('Schedule',()=>scheduleConfig(config.id)),button('Edit',()=>editConfig(config)));
    if(run){actions.append(button('Logs',()=>logs(run)));if(run.terminal_id)actions.append(button('Agent session',()=>showRun(run)));if(run.state==='ready'&&run.port){const a=node('a','Open ↗','button');a.href='http://127.0.0.1:'+run.port;a.target='_blank';a.rel='noreferrer';actions.append(a);}if(['queued','starting','running','ready'].includes(run.state))actions.append(button('Stop',()=>request('stop',{id:run.id})));}
    const remove=button('Delete',()=>openDeleteConfig(config));remove.className='button config-delete';remove.setAttribute('aria-label','Delete');remove.title='Delete '+config.name;remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg>';actions.append(remove);
    return actions;
  }
  function render(){
    const configs=$id('run-configs');configs.replaceChildren();
    for(const config of data.configs){const card=node('article','','special-card'),run=data.executions.find(r=>r.config_id===config.id);card.append(node('h3',config.name),node('p',`${config.kind} · ${labels[run?.state]||'Not run yet'}`,'special-meta'),node('p',config.cwd||'Saved automation','muted'),runActions(config));configs.append(card);}
    if(!data.configs.length)configs.append(node('p','Add a project command or choose a saved automation. Use it from Run or a scheduled workflow.','special-empty'));
    const body=$id('schedule-rows');body.replaceChildren();
    for(const workflow of data.workflows){const latest=data.flows.find(f=>f.workflow_id===workflow.id),row=document.createElement('tr');for(const value of [workflow.name,workflow.trigger==='cron'?workflow.cron:workflow.trigger==='once'?'Once':workflow.trigger==='event'?'Event · '+window.eventControls.name(workflow.event.source_id):'Manual',workflow.timezone,workflow.enabled?'Enabled':'Paused',date(workflow.next_due),latest?labels[latest.state]:'Not run yet'])row.append(node('td',value));const actions=document.createElement('td');actions.className='special-actions';actions.append(button('DAG',()=>{selected=workflow.id;renderGraph();}),...(workflow.trigger==='event'?[]:[button('Run now',()=>request('run',{id:workflow.id}))]),button(workflow.enabled?'Pause':'Enable',()=>request('toggle',{id:workflow.id,enabled:!workflow.enabled})),button('Edit',()=>editWorkflow(workflow)),button('Delete',()=>openDeleteSchedule(workflow)));row.append(actions);body.append(row);}
    if(!data.workflows.length){const row=document.createElement('tr'),cell=node('td','No workflows yet. Add tasks, connect their dependencies, and choose a schedule.');cell.colSpan=7;row.append(cell);body.append(row);}
    const picker=$id('workflow-choice'),prior=selected;picker.replaceChildren();const overview=node('option','All workflows');overview.value='all';picker.append(overview);for(const flow of data.workflows){const option=node('option',flow.name);option.value=flow.id;picker.append(option);}selected=prior==='all'||data.workflows.some(w=>w.id===prior)?prior:'all';picker.value=selected||'';renderGraph();renderHistory();
    window.updateWorkflowInbox?.(data);
  }
  function renderGraph(){
    if(selected==='all'){
      $id('workflow-choice').value='all';$id('workflow-graph-status').textContent='All workflows · schedule roots connect to their task DAGs';
      const nodes=[],edges=[],runs=new Map();
      for(const workflow of data.workflows){const latest=data.flows.find(f=>f.workflow_id===workflow.id);nodes.push({id:workflow.id,title:workflow.name,status:workflow.enabled?'scheduled':'paused',detail:(workflow.cron||workflow.trigger)+' · next '+date(workflow.next_due)});
        for(const task of workflow.nodes){const id=workflow.id+':'+task.id,run=data.executions.find(r=>r.flow_id===latest?.id&&r.node_id===task.id);nodes.push({id,title:data.configs.find(c=>c.id===task.config_id)?.name||task.id,status:run?.state||'waiting',detail:run?.detail||'Waiting for this workflow to run'});if(run)runs.set(id,run);for(const parent of task.depends_on.length?task.depends_on:[null])edges.push({from:parent?workflow.id+':'+parent:workflow.id,to:id});}
      }
      drawDeskDAG($id('workflow-graph'),nodes,edges,id=>{if(data.workflows.some(w=>w.id===id)){selected=id;renderGraph();}else if(runs.has(id))showRun(runs.get(id));else toast('This task has not run yet.');});return;
    }
    const workflow=data.workflows.find(w=>w.id===selected),flow=data.flows.find(f=>f.workflow_id===selected);$id('workflow-choice').value=selected||'';
    $id('workflow-graph-status').textContent=workflow?`${workflow.name} · ${flow?labels[flow.state]+' · '+date(flow.created):'No runs yet'} · arrows mean “wait for success”`:'Choose or create a workflow';
    drawDeskDAG($id('workflow-graph'),(workflow?.nodes||[]).map(n=>{const config=data.configs.find(c=>c.id===n.config_id),run=data.executions.find(r=>r.flow_id===flow?.id&&r.node_id===n.id);return {id:n.id,title:config?.name||n.id,status:run?.state||'scheduled',detail:run?.detail||config?.kind||''};}),(workflow?.nodes||[]).flatMap(n=>n.depends_on.map(from=>({from,to:n.id}))),id=>{const run=data.executions.find(r=>r.flow_id===flow?.id&&r.node_id===id);if(run)showRun(run);else toast('This task has not run yet.');});
  }
  const kindLabels={app:'App',command:'Task',automation:'Agent'};
  const historyFilters={workflow:'all',kind:'all',state:'all'};
  function flowKinds(flow){return new Set(data.executions.filter(run=>run.flow_id===flow.id).map(run=>data.configs.find(config=>config.id===run.config_id)?.kind||run.config_kind).filter(Boolean));}
  function renderHistoryFilters(){
    const picker=$id('history-workflow');
    const signature=JSON.stringify(data.workflows.map(workflow=>[workflow.id,workflow.name]));
    if(picker.dataset.signature!==signature){
      picker.dataset.signature=signature;picker.replaceChildren();
      const every=node('option','All workflows');every.value='all';picker.append(every);
      for(const workflow of data.workflows){const option=node('option',workflow.name);option.value=workflow.id;picker.append(option);}
    }
    if(historyFilters.workflow!=='all'&&!data.workflows.some(workflow=>workflow.id===historyFilters.workflow))historyFilters.workflow='all';
    picker.value=historyFilters.workflow;$id('history-kind').value=historyFilters.kind;$id('history-state').value=historyFilters.state;
  }
  const expandedRuns=new Set();
  function duration(start,end){
    if(!start||!end)return '';
    const seconds=Math.max(0,Math.round(end-start));
    if(seconds<60)return seconds+'s';
    const minutes=Math.floor(seconds/60);
    if(minutes<60)return minutes+'m '+String(seconds%60).padStart(2,'0')+'s';
    return Math.floor(minutes/60)+'h '+String(minutes%60).padStart(2,'0')+'m';
  }
  // The expanded run: what each task was, when it ran, how long it took, how it ended and
  // what it said, with the ways into its output. Built from data the poll already has.
  function runDetail(flow,runs){
    const panel=node('div','','run-detail');panel.id='run-detail-'+flow.id;panel.setAttribute('role','region');
    const workflow=data.workflows.find(item=>item.id===flow.workflow_id);
    const summary=node('div','','run-detail-summary');
    const facts=[['Started',date(flow.created)],['Finished',flow.finished?date(flow.finished):flow.state==='running'?'Still running':'—'],
      ['Duration',duration(flow.created,flow.finished)||(flow.state==='running'?deskSince(flow.created).replace(' ago','')+' so far':'—')],
      ['Trigger',workflow?(workflow.trigger==='cron'?workflow.cron+' · '+workflow.timezone:workflow.trigger==='once'?'Once':workflow.trigger==='event'?'Event · '+window.eventControls.name(workflow.event.source_id):'Manual'):({manual:'Manual',once:'Once',cron:'Recurring',event:'Event'}[flow.trigger]||'—')]];
    for(const [label,value] of facts){const fact=node('div','','run-fact');fact.append(node('span',label),node('strong',value));summary.append(fact);}
    panel.append(summary);
    if(!runs.length)panel.append(node('p','No tasks started for this run.','run-detail-empty'));
    for(const run of runs){
      const config=data.configs.find(item=>item.id===run.config_id)||(run.config_name?{name:run.config_name,kind:run.config_kind}:null);
      const task=node('div','','run-detail-task');task.dataset.status=run.state;
      const head=node('div','','run-detail-head');
      const dot=node('span','','run-dot');dot.dataset.status=run.state;
      head.append(dot,node('strong',config?.name||run.node_id),node('span',run.node_id+(config?' · '+(kindLabels[config.kind]||config.kind):''),'run-detail-meta'));
      const state=node('span',labels[run.state]||run.state,'run-state');state.dataset.status=run.state;
      const time=node('span',[date(run.created),duration(run.created,run.finished)].filter(value=>value&&value!=='—').join(' · '),'run-detail-meta');
      head.append(time,state);
      task.append(head);
      if(run.detail)task.append(node('p',run.detail,'run-detail-text'));
      const actions=node('div','','run-detail-actions');
      const output=button('Output',()=>logs(run));output.className='text-button';actions.append(output);
      if(run.terminal_id){const session=button('Agent session',()=>showRun(run));session.className='text-button';actions.append(session);}
      if(run.state==='ready'&&run.port){const open=node('a','Open app ↗','text-button');open.href='http://127.0.0.1:'+run.port;open.target='_blank';open.rel='noreferrer';actions.append(open);}
      task.append(actions);panel.append(task);
    }
    return panel;
  }
  function renderHistory(){
    renderHistoryFilters();
    const list=$id('workflow-history');list.replaceChildren();
    const matching=data.flows.filter(flow=>(historyFilters.workflow==='all'||flow.workflow_id===historyFilters.workflow)
      &&(historyFilters.state==='all'||flow.state===historyFilters.state)
      &&(historyFilters.kind==='all'||flowKinds(flow).has(historyFilters.kind)));
    const shown=matching.slice(0,20);
    $id('history-count').textContent=!data.flows.length?'':shown.length===data.flows.length?`${data.flows.length} run${data.flows.length===1?'':'s'}`:`${shown.length} of ${data.flows.length} runs`;
    if(!shown.length){list.append(node('p',data.flows.length?'No runs match these filters.':'Runs appear here once a workflow has started.','special-empty'));return;}
    const table=node('div','','run-table');table.setAttribute('role','table');
    const head=node('div','','run-head');head.setAttribute('role','row');
    for(const column of ['Workflow','Type','Tasks','Started','Status']){const cell=node('span',column);cell.setAttribute('role','columnheader');head.append(cell);}
    table.append(head);
    for(const flow of shown){
      const row=node('div','','run-row');row.setAttribute('role','row');
      const runs=data.executions.filter(run=>run.flow_id===flow.id);
      const open=expandedRuns.has(flow.id);row.classList.toggle('open',open);
      const name=node('div','','run-name');
      const dot=node('span','','run-dot');dot.dataset.status=flow.state;
      const toggle=node('button','','run-open');toggle.type='button';
      toggle.setAttribute('aria-expanded',String(open));toggle.setAttribute('aria-controls','run-detail-'+flow.id);
      const title=node('strong',data.workflows.find(workflow=>workflow.id===flow.workflow_id)?.name||flow.workflow_name||'Workflow');
      toggle.title=(open?'Hide':'Show')+' details for '+title.textContent;
      const chevron=node('span','','run-chevron');chevron.setAttribute('aria-hidden','true');
      toggle.append(chevron,title);name.append(dot,toggle);
      const flip=()=>{if(expandedRuns.has(flow.id))expandedRuns.delete(flow.id);else expandedRuns.add(flow.id);renderHistory();document.querySelector(`#workflow-history [aria-controls="run-detail-${CSS.escape(flow.id)}"]`)?.focus();};
      toggle.onclick=flip;
      // The whole row opens its details; the task links and Cancel keep their own clicks.
      row.onclick=event=>{if(event.target.closest('button,a'))return;flip();};
      const types=node('div','','run-types');
      for(const kind of flowKinds(flow))types.append(node('span',kindLabels[kind]||kind,'run-type'));
      const tasks=node('div','','run-tasks');
      for(const run of runs){
        const task=node('button',run.node_id,'run-task');task.type='button';task.dataset.status=run.state;
        task.title=`${run.node_id} · ${labels[run.state]||run.state} · open its output`;
        task.onclick=()=>showRun(run);tasks.append(task);
      }
      const when=node('div',deskSince(flow.created)||'—','run-when');when.title=date(flow.created);
      const status=node('div','','run-status');
      const state=node('span',labels[flow.state]||flow.state,'run-state');state.dataset.status=flow.state;
      status.append(state);
      if(flow.state==='running'){const cancel=button('Cancel',()=>request('cancel',{id:flow.id}));cancel.className='text-button run-cancel';status.append(cancel);}
      row.append(name,types,tasks,when,status);table.append(row);
      if(open)table.append(runDetail(flow,runs));
    }
    list.append(table);
  }

  function refresh(){if(refreshPromise)return refreshPromise;refreshPromise=(async()=>{try{data=await terminalRequest('/api/workflows');$id('workflows-status').textContent='Local scheduler · runs while Agent Desk is running and this Mac is awake · missed ticks coalesce into one run';render();}catch(e){$id('workflows-status').textContent='Run and Schedule need the updated backend. Existing terminals are unaffected.';}})().finally(()=>{refreshPromise=null;});return refreshPromise;}
  async function editConfig(config){configEditing=config?.id||null;$id('run-config-title').textContent=config?'Edit launch configuration':'New launch configuration';for(const key of ['name','kind','cwd','timeout'])$id('run-'+key).value=config?.[key]||({kind:'app',cwd:terminalDefaultCwd,timeout:3600}[key]||'');$id('run-argv').value=(config?.argv||[]).join('\n');$id('run-error').textContent='';
    const roles=await terminalRequest('/api/special-agents'),picker=$id('run-automation');picker.replaceChildren();for(const role of roles.roles){const option=node('option',role.name);option.value=role.id;picker.append(option);}picker.value=config?.role_id||roles.roles[0]?.id||'';
    updateConfigKind();$id('run-config-dialog').showModal();
    const projects=await terminalRequest('/api/projects');const projectPicker=$id('run-project');projectPicker.replaceChildren(node('option','Choose a discovered project…'));projectPicker.firstChild.value='';for(const project of projects.projects){const option=node('option',project.path);option.value=project.path;projectPicker.append(option);}
  }
  function updateConfigKind(){const automation=$id('run-kind').value==='automation';$id('run-command-fields').classList.toggle('hidden',automation);$id('run-automation-fields').classList.toggle('hidden',!automation);for(const id of ['run-cwd','run-argv'])$id(id).required=!automation;}
  function editWorkflow(workflow,configId){window.eventControls?.load(workflow?.event);if(scheduleSaving)return;if(!data.configs.length){toast('Add a launch configuration first.');return;}workflowUpdating=!!workflow;workflowEditing=workflow?.id||crypto.randomUUID();$id('schedule-dialog').querySelector('h2').textContent=workflow?'Edit schedule':'New schedule';$id('schedule-name').value=workflow?.name||data.configs.find(c=>c.id===configId)?.name||'';$id('schedule-trigger').value=workflow?.trigger||'manual';window.scheduleControls.load(workflow?.cron||'0 9 * * 1-5');$id('schedule-timezone').value=workflow?.timezone||Intl.DateTimeFormat().resolvedOptions().timeZone;window.scheduleControls.refresh();$id('schedule-enabled').checked=workflow?.enabled||false;$id('schedule-at').value=workflow?.at?new Date(workflow.at*1000).toISOString().slice(0,16):'';taskRows=workflow?structuredClone(workflow.nodes):[{id:'task-1',config_id:configId||data.configs[0].id,depends_on:[]}];$id('schedule-error').textContent='';renderTaskRows();updateTrigger();$id('schedule-dialog').showModal();}
  function renderTaskRows(){const list=$id('schedule-tasks');list.replaceChildren();for(const task of taskRows){const row=node('div','','schedule-task'),select=document.createElement('select');select.setAttribute('aria-label',task.id+' launch configuration');for(const config of data.configs){const option=node('option',config.name);option.value=config.id;select.append(option);}select.value=task.config_id;select.onchange=()=>task.config_id=select.value;row.append(node('strong',task.id),select);const dependencies=node('div','','dependency-choices');dependencies.append(node('span',taskRows.length>1?'After: ':'Runs first'));for(const other of taskRows.filter(n=>n.id!==task.id)){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=task.depends_on.includes(other.id);check.onchange=()=>task.depends_on=check.checked?[...task.depends_on,other.id]:task.depends_on.filter(id=>id!==other.id);label.append(check,document.createTextNode(other.id));dependencies.append(label);}row.append(dependencies,button('Remove',()=>{taskRows=taskRows.filter(n=>n.id!==task.id).map(n=>({...n,depends_on:n.depends_on.filter(id=>id!==task.id)}));renderTaskRows();}));list.append(row);}}
  function updateTrigger(){window.eventControls?.update();$id('schedule-cron-fields').classList.toggle('hidden',$id('schedule-trigger').value!=='cron');$id('schedule-once-fields').classList.toggle('hidden',$id('schedule-trigger').value!=='once');}
  $id('open-workflows').onclick=()=>{switchPage('workflows');refresh();};$id('new-run-config').onclick=()=>editConfig().catch(e=>toast(e.message));$id('new-workflow').onclick=()=>editWorkflow();$id('run-kind').onchange=updateConfigKind;$id('run-project').onchange=()=>{if($id('run-project').value)$id('run-cwd').value=$id('run-project').value;};$id('workflow-choice').onchange=()=>{selected=$id('workflow-choice').value;renderGraph();};
  for(const [id,key] of [['history-workflow','workflow'],['history-kind','kind'],['history-state','state']])$id(id).onchange=()=>{historyFilters[key]=$id(id).value;renderHistory();};
  $id('schedule-trigger').onchange=updateTrigger;$id('schedule-add-task').onclick=()=>{let count=1;while(taskRows.some(n=>n.id==='task-'+count))count++;taskRows.push({id:'task-'+count,config_id:data.configs[0].id,depends_on:[]});renderTaskRows();};
  $id('run-config-form').onsubmit=async event=>{event.preventDefault();try{await request('save-config',{id:configEditing||undefined,update:!!configEditing,name:$id('run-name').value,kind:$id('run-kind').value,cwd:$id('run-cwd').value,argv:$id('run-argv').value.split('\n').filter(Boolean),role_id:$id('run-automation').value,timeout:Number($id('run-timeout').value)});$id('run-config-dialog').close();}catch(e){$id('run-error').textContent=e.message;}};
  $id('schedule-form').onsubmit=async event=>{event.preventDefault();if(scheduleSaving)return;scheduleSaving=true;const submit=$id('schedule-form').querySelector('button[type=submit]');submit.disabled=true;try{await request('save',{id:workflowEditing,update:workflowUpdating,name:$id('schedule-name').value,nodes:taskRows,trigger:$id('schedule-trigger').value,event:$id('schedule-trigger').value==='event'?window.eventControls.value():undefined,cron:$id('schedule-cron').value,timezone:$id('schedule-timezone').value,at:Date.parse($id('schedule-at').value+'Z')/1000,enabled:$id('schedule-enabled').checked});$id('schedule-dialog').close();}catch(e){$id('schedule-error').textContent=e.message;}finally{scheduleSaving=false;submit.disabled=false;}};
  function updateAgentView(){$id('agent-map-toggle').setAttribute('aria-pressed',String(agentMap));const toggle=$id('agent-map-toggle');toggle.lastChild.textContent=agentMap?'Terminal panes':'Agent map';}
  function openMappedSession(id){agentMap=false;$id('agent-map-tools').classList.add('hidden');$id('agent-map').classList.add('hidden');$id('terminal').classList.remove('hidden');updateAgentView();selectPane(id);}
  window.renderAgentMap=()=>{
    if(!agentMap)return;const all=current(),team=agentDescendants(mapFocusId,all),focused=all.find(a=>a.id===mapFocusId),visible=focused?all.filter(a=>team.has(a.id)):all;
    $id('agent-map-scope').textContent=focused?sessionTitle(focused)+' · '+(visible.length-1)+' agents':'All agents';
    $id('agent-map-all').classList.toggle('hidden',!focused);$id('agent-map-open-coordinator').classList.toggle('hidden',!focused);
    drawDeskDAG($id('agent-map'),visible.map(a=>({id:a.id,title:a.display_name||a.name,status:labels[a.status]||a.status,detail:sessionTitle(a)})),visible.filter(a=>a.parent_id&&visible.some(parent=>parent.id===a.parent_id)).map(a=>({from:a.parent_id,to:a.id})),id=>{
      if(all.find(a=>a.id===id)?.controller){mapFocusId=id;window.renderAgentMap();}else openMappedSession(id);
    });
  };
  $id('agent-map-all').onclick=()=>{mapFocusId=null;window.renderAgentMap();};
  $id('agent-map-open-coordinator').onclick=()=>openMappedSession(mapFocusId);
  $id('agent-map-toggle').onclick=()=>{agentMap=!agentMap;if(agentMap)mapFocusId=null;$id('agent-map-tools').classList.toggle('hidden',!agentMap);$id('agent-map').classList.toggle('hidden',!agentMap);$id('terminal').classList.toggle('hidden',agentMap);updateAgentView();window.renderAgentMap();};
  document.querySelectorAll('[data-dag-zoom]').forEach(button=>button.onclick=()=>{const container=$id(button.dataset.dagZoom),zoom=Math.max(.4,Math.min(1.9,Number(container.dataset.zoom||1)+Number(button.dataset.delta)));container.dataset.zoom=zoom;const board=container.querySelector('.dag-board');if(board)board.style.zoom=zoom;});
  async function scheduleConfig(configId){await refresh();const matches=data.workflows.filter(w=>w.nodes.some(n=>n.config_id===configId));if(matches.length>1){switchPage('workflows');toast('Multiple schedules use this task. Choose Edit beside the schedule you want.');return;}editWorkflow(matches[0]||null,configId);}
  window.scheduleAutomation=async role=>{await refresh();let config=data.configs.find(c=>c.kind==='automation'&&c.role_id===role.id);if(!config)config=await request('save-config',{name:role.name,kind:'automation',role_id:role.id,timeout:3600});switchPage('workflows');await scheduleConfig(config.id);};
  window.openWorkflowRun=id=>{const run=data.executions.find(r=>r.id===id);if(run)showRun(run);};
  window.showEventRun=async id=>{await refresh();historyFilters.workflow='all';historyFilters.kind='all';historyFilters.state='all';expandedRuns.add(id);renderHistory();const detail=$id('run-detail-'+id);if(detail)detail.scrollIntoView({behavior:'smooth',block:'center'});else toast('This run is older than the displayed history.');};
  window.refreshWorkflows=refresh;
  refresh();setInterval(refresh,4000);
})();
