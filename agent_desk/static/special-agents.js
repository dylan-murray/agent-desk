(() => {
let state={roles:[],inbox:[],runs:[]},editing=null,loading=false,signature='';
const templates={watcher:'Review the specified sources for actionable work. Explain relevance, urgency, and a suggested next step. Include source links and use stable source IDs. Report missing access explicitly. Do not send messages or modify sources.',fixer:'Investigate issues within the repository scope, prepare a focused local fix, and run relevant tests. Return changed files, validation, uncertainties, and a review summary. Do not merge, deploy, or post messages.',researcher:'Investigate the specified topic using available sources. Return evidence, source links, open questions, and recommended next steps.',custom:'Complete the scoped task and return findings or changes for review.'};
const el=id=>document.getElementById(id);
function commandChoice(){const choice=el('special-choice').value,config=launchSettings[choice]||launchChoices[choice];el('special-command').value=config.command||'';el('special-mode').value=config.mode||'direct';el('special-command').closest('details').open=choice==='custom';}
function editor(role){editing=role?.id||null;el('special-agent-title').textContent=role?'Edit automation':'New automation';el('special-kind').value=role?.kind||'watcher';for(const key of ['name','scope','instructions','cwd','choice','command','mode'])el('special-'+key).value=role?.[key]||({instructions:templates.watcher,cwd:terminalDefaultCwd,choice:'claude',mode:'/bin/zsh'}[key]||'');if(!role)commandChoice();el('special-error').textContent='';el('special-agent-dialog').showModal();}
function button(text,action){const b=document.createElement('button');b.className='button';b.textContent=text;b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
function paragraph(text,className=''){const p=document.createElement('p');p.textContent=text;p.className=className;return p;}
const RUN_STATES={launching:['Starting','running'],running:['Running','running'],review:['Ready for review','review'],
 blocked:['Blocked','problem'],failed:['Failed','problem'],interrupted:['Interrupted','problem']};
const KIND_LABELS={watcher:'Watcher',fixer:'Fixer',researcher:'Researcher',custom:'Custom'};
const ICONS={play:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3.5v9l7-4.5z"/></svg>',clock:'<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.3"/></svg>',
 edit:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.5 3.5 12.5 5.5 6 12H4v-2z"/></svg>',trash:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"/></svg>'};
// A schedule in the words Run & Schedule's builder uses.
function scheduleLabel(s,short=false){
 const when=s.trigger==='cron'?(window.scheduleControls?.describe(s.cron,short)||s.cron):s.trigger==='once'?'Once · '+new Date(s.at*1000).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}):s.trigger==='event'?'On an event':'Run by hand';
 return when+(s.enabled?'':' · off');
}
function iconButton(icon,label,action,className=''){
 const b=textButton('',action,('automation-icon '+className).trim());b.innerHTML=ICONS[icon];b.title=label;b.setAttribute('aria-label',label);return b;
}
function textButton(label,action,className=''){
 const b=document.createElement('button');b.type='button';b.className=('text-button '+className).trim();b.textContent=label;
 b.onclick=async()=>{b.disabled=true;try{await action();}catch(e){toast(e.message);}finally{b.disabled=false;}};
 return b;
}
const deleteDialog=document.createElement('dialog');
deleteDialog.className='schedule-delete-dialog automation-delete-dialog';deleteDialog.setAttribute('aria-labelledby','automation-delete-title');
deleteDialog.innerHTML='<h2 id="automation-delete-title">Delete this automation?</h2><p class="automation-delete-name"></p><p class="muted automation-delete-note"></p><ul class="automation-delete-uses"></ul><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button automation-delete-cancel">Keep it</button><button type="button" class="button automation-delete-confirm">Delete automation</button></div>';
document.body.append(deleteDialog);
let deletingRole=null,deletingUses=null,deleting=false;
deleteDialog.querySelector('.automation-delete-cancel').onclick=()=>deleteDialog.close();
deleteDialog.addEventListener('cancel',event=>{if(deleting)event.preventDefault();});
function confirmDelete(role){
 if(deleting)return;deletingRole=role.id;
 deleteDialog.querySelector('.automation-delete-name').textContent=role.name;
 // What Run & Schedule loses with it is named before anything goes.
 const uses=role.uses||{configs:[],schedules:[]},list=deleteDialog.querySelector('.automation-delete-uses');deletingUses=uses;list.replaceChildren();
 for(const schedule of uses.schedules){const row=document.createElement('li');const name=document.createElement('span');name.textContent=schedule.name;const what=document.createElement('span');what.className='automation-delete-what';
  what.textContent=scheduleLabel(schedule)+' · '+(schedule.others?`keeps its other ${schedule.others} task${schedule.others===1?'':'s'}`:'deleted');row.append(name,what);list.append(row);}
 if(uses.configs.length&&!uses.schedules.length){const row=document.createElement('li');row.textContent=uses.configs.map(c=>c.name).join(', ')+' · its launch configuration in Run & Schedule';list.append(row);}
 list.hidden=!uses.configs.length;
 const removed=uses.schedules.filter(s=>!s.others).length;
 deleteDialog.querySelector('.automation-delete-note').textContent=uses.configs.length?'Run & Schedule uses it, and deleting it removes these too. Findings it already sent stay in your Inbox, and its past runs stay in the run history.':'It stops being available to run or schedule. Findings it already sent stay in your Inbox, and its past runs stay in the run history.';
 deleteDialog.querySelector('.automation-delete-confirm').textContent=removed?`Delete and remove ${removed} schedule${removed===1?'':'s'}`:uses.configs.length?'Delete and remove from Run & Schedule':'Delete automation';
 deleteDialog.querySelector('[role=alert]').textContent='';
 deleteDialog.showModal();deleteDialog.querySelector('.automation-delete-cancel').focus();
}
deleteDialog.querySelector('.automation-delete-confirm').onclick=async()=>{
 if(deleting)return;deleting=true;
 const buttons=[...deleteDialog.querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{
  await terminalRequest('/api/special-agents/delete',{id:deletingRole,remove_schedules:!!deletingUses?.configs.length});
  deleteDialog.close();await refreshSpecial();toast('Automation deleted.');
 }catch(error){
  deleteDialog.querySelector('[role=alert]').textContent=error.message==='Not found'?'Restart Agent Desk to enable deleting automations. Nothing has been deleted.':error.message;
 }finally{deleting=false;buttons.forEach(b=>b.disabled=false);}
};
async function runNow(role){
 const result=await terminalRequest('/api/special-agents/launch',{id:role.id,desk:activeDesk().id});const session=result.session;
 sessionLaunchProfiles[session.id]={harness:launchChoices[role.choice].harness,launch_label:role.name};
 try{localStorage.setItem('agent-desk-session-profiles',JSON.stringify(sessionLaunchProfiles));}catch{}
 agents.unshift({...session,project:session.cwd.split('/').pop()});freshTerminalIds.add(session.id);demo=false;selectPane(session.id);await refreshSpecial();
}
function render(){
 window.updateAutomationInbox?.(state);
 const next=JSON.stringify(state);if(next===signature)return;signature=next;
 const roles=el('special-roles');roles.replaceChildren();
 if(!state.roles.length)roles.append(paragraph('Create a Slack watcher, a fix agent, or a researcher. Define where it should look and what to bring back.','special-empty'));
 for(const role of state.roles){
  const run=state.runs.find(r=>r.role_id===role.id);
  const [label,tone]=RUN_STATES[run?.state]||['Never run','idle'];
  const card=document.createElement('article');card.className='special-card automation-card';card.dataset.tone=tone;
  const head=document.createElement('header');head.className='automation-head';
  const dot=document.createElement('span');dot.className='automation-dot';dot.dataset.tone=tone;
  const name=document.createElement('h3');name.textContent=role.name;name.title=role.name;
  const kind=document.createElement('span');kind.className='automation-kind';kind.textContent=KIND_LABELS[role.kind]||role.kind;
  head.append(dot,name,kind);card.append(head);
  const scope=paragraph(role.scope,'automation-scope');scope.title=role.scope;card.append(scope);
  const last=document.createElement('div');last.className='automation-last';
  const state_=document.createElement('span');state_.className='automation-state';state_.dataset.tone=tone;state_.textContent=label;
  last.append(state_);
  if(run?.created){const when=document.createElement('span');when.className='automation-when';when.textContent=deskSince(run.created);when.title=new Date(run.created*1000).toLocaleString();last.append(when);}
  const openSession=async()=>{await refresh();if(!agents.some(a=>a.id===run.terminal_id))throw Error('This terminal is no longer available. Its review history is saved here.');demo=false;selectPane(run.terminal_id);};
  const live=tone==='running'&&run?.terminal_id;
  // A finished run's session is reached from its status; while it runs, it is the card's main button.
  if(run?.terminal_id&&!live){const dot=document.createElement('span');dot.className='automation-when';dot.textContent='·';last.append(dot,textButton('Open last session',openSession,'automation-open-last'));}
  card.append(last);
  if(run?.detail)card.append(paragraph(run.detail,'automation-detail'));
  const actions=document.createElement('footer');actions.className='automation-actions';
  const primary=live?button('Open session',openSession):button('Run now',()=>runNow(role));
  primary.classList.add('automation-run',live?'automation-live':'automation-start');primary.insertAdjacentHTML('afterbegin',live?'<span class="automation-pulse" aria-hidden="true"></span>':ICONS.play);
  const schedules=role.uses?.schedules||[];
  const schedule=textButton(schedules.length?scheduleLabel(schedules[0],true)+(schedules.length>1?` +${schedules.length-1}`:''):'Schedule…',()=>window.scheduleAutomation(role),'automation-schedule');
  schedule.insertAdjacentHTML('afterbegin',ICONS.clock);schedule.classList.toggle('unscheduled',!schedules.length);
  schedule.title=schedules.length?schedules.map(s=>s.name+' · '+scheduleLabel(s)).join('\n'):'Add it to Run & Schedule';
  const spacer=document.createElement('span');spacer.className='automation-spacer';
  actions.append(primary,schedule,spacer,iconButton('edit','Edit '+role.name,()=>editor(role)),iconButton('trash','Delete '+role.name,()=>confirmDelete(role),'automation-delete'));
  card.append(actions);
  roles.append(card);
 }
}

async function refreshSpecial(){if(loading)return;loading=true;try{state=await terminalRequest('/api/special-agents');el('special-status').textContent='';window.setInboxStatus?.('');render();}catch(e){el('special-status').textContent='Could not load automations. Check the local server connection.';window.setInboxStatus?.('Could not refresh saved findings. Showing the last loaded inbox.');}finally{loading=false;}}
el('open-special-agents').onclick=()=>{switchPage('special-agents');refreshSpecial();};el('open-sessions').onclick=()=>switchPage('agents');el('new-special-agent').onclick=()=>editor();el('special-choice').onchange=commandChoice;el('special-kind').onchange=()=>{el('special-instructions').value=templates[el('special-kind').value];};
el('special-agent-form').onsubmit=async event=>{event.preventDefault();const submit=event.submitter;submit.disabled=true;try{const payload={id:editing||''};for(const key of ['name','kind','scope','instructions','cwd','choice','command','mode'])payload[key]=el('special-'+key).value;await terminalRequest('/api/special-agents/save',payload);el('special-agent-dialog').close();await refreshSpecial();}catch(e){el('special-error').textContent=e.message;}finally{submit.disabled=false;}};
window.refreshAutomations=refreshSpecial;
refreshSpecial();setInterval(refreshSpecial,5000);
})();
