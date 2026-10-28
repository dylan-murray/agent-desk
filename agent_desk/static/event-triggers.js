(() => {
  const $=id=>document.getElementById(id);
  const node=(tag,text='',cls='')=>{const n=document.createElement(tag);n.textContent=text;n.className=cls;return n;};
  let state={sources:[],events:[]},editing=null,saving=false,loading=null;
  const kinds={webhook:'Webhook',file:'File',directory:'Directory',pr:'GitHub PR',url:'URL'};
  const date=value=>value?new Date(value*1000).toLocaleString():'Never';
  const manager=node('dialog','','event-manager');manager.id='event-sources-dialog';manager.setAttribute('aria-labelledby','event-sources-title');
  const entry=node('button','Event sources','button');entry.id='open-event-sources';entry.type='button';
  document.querySelector('#workflows-page > .special-heading > .special-actions').prepend(entry);
  function openSources(){manager.showModal();refresh();}
  entry.onclick=openSources;
  const panel=node('section','','event-panel');panel.id='event-sources';panel.setAttribute('aria-label','Event sources');
  panel.innerHTML=`<div class="event-manager-heading"><div><h2 id="event-sources-title">Event sources</h2><p class="muted">Connect a signal, then use it in a workflow.</p></div><button type="button" class="event-manager-close" aria-label="Close event sources">×</button></div>
    <div class="event-manager-toolbar"><p id="event-bus-status" class="muted" role="status">Loading sources…</p><button id="new-event-source" class="button" disabled>＋ Source</button></div><div id="event-source-list"></div>
    <details class="event-policy"><summary>Queue, sleep &amp; delivery policy</summary><p id="event-policy-text"></p><p>Source event IDs are remembered permanently. Unmatched events are recorded without running anything; enabling a rule does not replay them. URL and PR sources check every three minutes while enabled. File sources check every five seconds.</p></details>
    <details class="event-deliveries"><summary>Recent events <span id="event-count"></span></summary><div id="event-delivery-list"></div></details>`;
  manager.append(panel);document.body.append(manager);panel.querySelector('.event-manager-close').onclick=()=>manager.close();
  const dialog=node('dialog','','event-source-dialog');dialog.id='event-source-dialog';dialog.setAttribute('aria-labelledby','event-source-title');
  dialog.innerHTML=`<form id="event-source-form"><h2 id="event-source-title">New event source</h2>
    <label>Name<input id="event-source-name" required maxlength="100" placeholder="Slack triage"></label>
    <label>Source<select id="event-source-kind"><option value="webhook">Webhook · local adapter</option><option value="file">File changes</option><option value="directory">Directory changes · recursive</option><option value="pr">GitHub pull request</option><option value="url">URL changes</option></select></label>
    <label id="event-source-path-label" hidden>Absolute path<input id="event-source-path" placeholder="/absolute/project/path"></label>
    <label id="event-source-url-label" hidden>URL<input id="event-source-url" type="url" placeholder="https://"></label>
    <p id="event-source-help" class="muted"></p><p class="muted">Saving pauses this source and discards its waiting events. Enable it from the source list when ready.</p>
    <p id="event-source-error" class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button" data-close>Cancel</button><button type="submit" class="button primary">Save source</button></div></form>`;
  const tokenDialog=node('dialog','','event-source-dialog');tokenDialog.id='event-token-dialog';tokenDialog.setAttribute('aria-labelledby','event-token-title');
  tokenDialog.innerHTML=`<h2 id="event-token-title">Connect your local adapter</h2><p class="muted">Copy this token now. Agent Desk stores only its hash. Rotating it invalidates the previous token.</p><label>Webhook URL<input id="event-webhook-url" readonly></label><label id="event-workspace-label" hidden>Workspace address<input id="event-workspace" readonly></label><label id="event-socket-label" hidden>Unix socket<input id="event-webhook-socket" readonly></label><label>Bearer token<input id="event-webhook-token" readonly type="password"></label><button type="button" id="event-token-copy" class="text-button">Copy token</button><p class="muted">POST JSON with <code>Authorization: Bearer TOKEN</code> and <code>Content-Type: application/json</code>. Slack credentials stay in your separate adapter process.</p><pre id="event-webhook-example" tabindex="0"></pre><button type="button" id="event-example-copy" class="text-button">Copy curl example</button><button type="button" class="button" data-close>Done</button>`;
  tokenDialog.addEventListener('close',()=>{$('event-webhook-token').value='';$('event-webhook-example').textContent='';});
  const confirm=node('dialog','','event-source-dialog');confirm.id='event-source-confirm';confirm.setAttribute('aria-labelledby','event-confirm-title');
  confirm.innerHTML='<h2 id="event-confirm-title"></h2><p id="event-confirm-detail"></p><p class="error-banner" role="alert"></p><div class="dialog-actions"><button type="button" class="button" data-close>Cancel</button><button type="button" class="button" id="event-confirm-action"></button></div>';
  document.body.append(dialog,tokenDialog,confirm);
  for(const d of [dialog,tokenDialog,confirm])d.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>d.close());
  const fields=node('div','','event-rule-fields');fields.id='schedule-event-fields';fields.hidden=true;
  fields.innerHTML=`<div class="event-rule-source"><label>Event source<select id="schedule-event-source"></select></label><button type="button" id="manage-event-sources" class="text-button">Manage sources</button></div><div class="event-predicate"><label>Payload field<input id="schedule-event-field" placeholder="event.type" maxlength="200"></label><label>Comparison<select id="schedule-event-op"><option value="equals">Equals</option><option value="contains">Contains text</option><option value="exists">Exists</option></select></label><label id="schedule-event-value-label">Value<input id="schedule-event-value" placeholder='message, true, or 42'></label></div><p class="muted">Fields use dotted paths inside the payload. Equals accepts JSON values or plain text. Each event goes to the first matching enabled rule in the list.</p><p class="muted">Event rules always save paused. Review the tasks, save, then select Enable in the list. Editing requires enabling again. Pausing discards waiting events.</p><p class="muted">Automations receive the event in their prompt. Commands receive its JSON in AGENT_DESK_EVENT.</p>`;
  $('schedule-once-fields').after(fields);
  $('manage-event-sources').onclick=openSources;
  const option=node('option','Event');option.value='event';option.disabled=true;$('schedule-trigger').append(option);
  function action(label,fn){const b=node('button',label,'text-button');b.type='button';b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){toast(e.message);}finally{b.disabled=false;}};return b;}
  async function request(name,payload){const result=await terminalRequest('/api/event-bus/'+name,payload);await refresh();return result;}
  const shellQuote=value=>"'"+value.replaceAll("'", "'\\''")+"'";
  const copyText=text=>window.agentDeskDesktop?.copyText?window.agentDeskDesktop.copyText(text):navigator.clipboard.writeText(text);
  function showToken(result){
    const connection=result.connection;
    $('event-webhook-url').value=connection.url;
    $('event-workspace').value=connection.workspace;
    $('event-webhook-socket').value=connection.socket||'';
    $('event-workspace-label').hidden=!connection.socket;
    $('event-socket-label').hidden=!connection.socket;
    $('event-webhook-token').value=result.token;
    $('event-webhook-example').textContent=['curl',...(connection.socket?['--unix-socket',shellQuote(connection.socket)]:[]),shellQuote(connection.url),'-H',shellQuote('Authorization: Bearer '+result.token),'-H',"'Content-Type: application/json'",'--data',shellQuote(JSON.stringify({id:'stable-source-event-id',payload:{type:'message'}}))].join(' ');
    tokenDialog.showModal();
  }
  $('event-example-copy').onclick=async()=>{try{await copyText($('event-webhook-example').textContent);toast('curl example copied');}catch{toast('Select the example to copy it.');}};
  $('event-token-copy').onclick=async()=>{try{await copyText($('event-webhook-token').value);toast('Token copied');}catch{toast('Select the token field to copy it.');}};
  function confirmation(title,detail,label,fn){$('event-confirm-title').textContent=title;$('event-confirm-detail').textContent=detail;confirm.querySelector('[role=alert]').textContent='';const b=$('event-confirm-action');b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await fn();confirm.close();}catch(e){confirm.querySelector('[role=alert]').textContent=e.message;}finally{b.disabled=false;}};confirm.showModal();}
  function render(){
    $('event-bus-status').dataset.state='ready';
    $('event-bus-status').textContent=`${state.queued||0} / ${state.capacity||256} events waiting · one run per configuration`;
    $('event-policy-text').textContent=state.policy||'Event sources require the updated backend.';
    const list=$('event-source-list');list.replaceChildren();
    for(const source of state.sources){
      const row=node('article','','event-source-row');row.dataset.sourceId=source.id;
      const identity=node('div','','event-source-identity'),title=node('h3',source.name),badge=node('span',source.enabled?'Enabled':'Paused','event-source-state');badge.dataset.enabled=String(source.enabled);
      identity.append(title,badge,node('p',[kinds[source.kind],source.settings.path||source.settings.url].filter(Boolean).join(' · '),'muted'));
      const health=node('dl','','event-source-health');health.append(node('dt','Last seen'),node('dd',date(source.last_seen)),node('dt','Last error'),node('dd',source.last_error||'None',source.last_error?'event-source-error':''));
      const actions=node('div','','event-source-actions');actions.append(action(source.enabled?'Pause':'Enable',()=>request('toggle-source',{id:source.id,enabled:!source.enabled})),action('Edit',()=>edit(source)));
      if(source.kind==='webhook')actions.append(action('New token',()=>confirmation('Replace source token?',`The adapter for ${source.name} will need the new token.`,'Replace token',async()=>{const result=await request('rotate-token',{id:source.id});confirm.close();showToken(result);} )));
      actions.append(action('Delete',()=>confirmation('Delete event source?',`Delete ${source.name}. Remove rules using it first. Past event receipts and runs stay available.`,'Delete source',()=>request('delete-source',{id:source.id}))));
      row.append(identity,health,actions);list.append(row);
    }
    if(!state.sources.length){const empty=node('div','','event-empty');empty.append(node('h3','Connect your first source'),node('p','Use a local webhook, a file or directory, a URL, or a pull request. Sources start paused.','muted'));list.append(empty);}
    $('event-count').textContent=`(${state.events.length})`;
    const deliveries=$('event-delivery-list');deliveries.replaceChildren();
    for(const event of state.events){const row=node('div','','event-delivery');row.append(node('strong',state.sources.find(s=>s.id===event.source_id)?.name||'Deleted source'),node('code',event.event_id),node('span',event.state,'event-outcome'),node('span',event.detail,'muted'));if(event.flow_id)row.append(action('View run',()=>{manager.close();return window.showEventRun?.(event.flow_id);}));deliveries.append(row);}
    if(!state.events.length)deliveries.append(node('p','No events received yet.','muted'));
  }
  function refresh(){if(loading)return loading;loading=(async()=>{try{
    const result=await terminalRequest('/api/event-bus');
    if(!Array.isArray(result.sources)||!Array.isArray(result.events))throw Error('Not found');
    state=result;$('new-event-source').disabled=false;option.disabled=false;render();sourceOptions($('schedule-event-source').value);
  }catch(e){
    $('new-event-source').disabled=true;option.disabled=true;
    $('event-bus-status').dataset.state='unavailable';
    $('event-bus-status').textContent=e.message==='Not found'?'Restart Agent Desk to connect event sources. Save active terminal sessions first.':'Event sources unavailable: '+e.message;
  }})().finally(()=>{loading=null;});return loading;}
  function sourceOptions(identity){const picker=$('schedule-event-source');picker.replaceChildren();for(const source of state.sources){const o=node('option',source.name+(source.enabled?'':' · paused'));o.value=source.id;picker.append(o);}picker.value=state.sources.some(s=>s.id===identity)?identity:state.sources[0]?.id||'';}
  function sourceFields(){const kind=$('event-source-kind').value,isPath=['file','directory'].includes(kind),isUrl=['pr','url'].includes(kind);$('event-source-path-label').hidden=!isPath;$('event-source-url-label').hidden=!isUrl;$('event-source-path').required=isPath;$('event-source-url').required=isUrl;$('event-source-help').textContent=kind==='webhook'?'A local adapter posts events using a per-source token. No Slack credentials are stored here.':isPath?'Changes are compared every five seconds, including creations and deletions. Directories include up to 2,000 entries; symlinks are not followed.':'Uses the coordinator watch runner. First check establishes a baseline; later changes emit events. PR checks use your existing GitHub CLI login.';}
  function edit(source){editing=source?.id||null;$('event-source-title').textContent=source?'Edit event source':'New event source';$('event-source-name').value=source?.name||'';$('event-source-kind').value=source?.kind||'webhook';$('event-source-kind').disabled=!!source;$('event-source-path').value=source?.settings.path||'';$('event-source-url').value=source?.settings.url||'';$('event-source-error').textContent='';sourceFields();dialog.showModal();}
  $('new-event-source').onclick=()=>edit();$('event-source-kind').onchange=sourceFields;
  $('event-source-form').onsubmit=async e=>{e.preventDefault();if(saving)return;saving=true;const b=e.submitter||dialog.querySelector('[type=submit]');b.disabled=true;try{const result=await request('save-source',{id:editing||undefined,name:$('event-source-name').value,kind:$('event-source-kind').value,settings:{path:$('event-source-path').value,url:$('event-source-url').value}});dialog.close();if(result.token)showToken(result);}catch(error){$('event-source-error').textContent=error.message;}finally{saving=false;b.disabled=false;}};
  $('schedule-event-op').onchange=()=>$('schedule-event-value-label').hidden=$('schedule-event-op').value==='exists';
  window.eventControls={
    // The schedule dialog opens without waiting for this, so the rule's fields are filled in
    // before the source list is fetched; filling them after it overwrote what was already typed.
    async load(rule){$('schedule-event-field').value=rule?.predicate.field||'type';$('schedule-event-op').value=rule?.predicate.op||'equals';const value=rule?.predicate.value;$('schedule-event-value').value=typeof value==='string'?JSON.stringify(value):value===undefined?'':JSON.stringify(value);$('schedule-event-op').onchange();await refresh();sourceOptions(rule?.source_id);},
    update(){const event=$('schedule-trigger').value==='event';fields.hidden=!event;$('schedule-enabled').disabled=event;$('schedule-enabled').closest('label').hidden=event;$('schedule-timezone').closest('label').hidden=event;document.querySelector('.schedule-explainer p:last-child').hidden=event;},
    value(){let value=$('schedule-event-value').value;const op=$('schedule-event-op').value;if(op==='equals'){try{value=JSON.parse(value);}catch{}}return {source_id:$('schedule-event-source').value,predicate:{field:$('schedule-event-field').value,op,...(op==='exists'?{}:{value})}};},
    name(id){return state.sources.find(s=>s.id===id)?.name||'source';}
  };
  refresh();setInterval(refresh,4000);
})();
