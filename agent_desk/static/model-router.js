// Model router settings and the routing toggles in both coordinator launch dialogs.
// The server owns the API key: it is write-only here and never returned.
(()=>{
const $=id=>document.getElementById(id);
const labels={claude:'Claude Code',codex:'Codex',grok:'Grok'};
let cached=null,saved=null,accounts={};
const accountChoices=harness=>[['','Same account as coordinator'],...launchAccounts.filter(account=>account.harness===harness).map(account=>[account.id,account.label])];
// Mirrors model_router.harness_for for the live preview; the server validates on save.
function harnessFor(model){
 const lower=model.toLowerCase(),slash=lower.lastIndexOf('/'),provider=slash<0?'':lower.slice(0,slash),name=lower.slice(slash+1);
 if(['anthropic','claude'].includes(provider)||/^(claude|opus|sonnet|haiku)/.test(name))return 'claude';
 if(['openai','codex'].includes(provider)||/^(gpt|codex)/.test(name)||/^o\d/.test(name))return 'codex';
 if(['xai','grok'].includes(provider)||name.startsWith('grok'))return 'grok';
 return null;
}
function host(endpoint){try{return new URL(endpoint).host;}catch{return endpoint;}}
// Keep each "model → harness" pair on one line when the status wraps.
function describeNodes(status){
 const parts=[document.createTextNode(host(status.endpoint)+' · ')];
 status.models.forEach((m,i)=>{if(i)parts.push(document.createTextNode(', '));const pair=document.createElement('span');pair.textContent=m.model+' → '+(accountLabels()[m.account]||labels[m.harness]||m.harness);parts.push(pair);});
 return parts;
}
async function status(refresh=false){
 if(!cached||refresh)cached=terminalRequest('/api/model-router/settings',{}).catch(error=>{cached=null;throw error;});
 return cached;
}
function lines(){return $('model-router-models').value.split('\n').map(s=>s.trim()).filter(Boolean);}
function preview(){
 const list=$('model-router-harnesses');list.replaceChildren();
 for(const model of lines()){
  const harness=harnessFor(model),item=document.createElement('li'),name=document.createElement('code'),target=document.createElement('span');
  name.textContent=model;target.textContent=harness?'→ '+labels[harness]:'No harness runs this model';item.dataset.harness=harness||'none';item.append(name,target);
  if(harness&&harness!=='grok'){
   const account=document.createElement('select');account.setAttribute('aria-label','Account for '+model);
   for(const [value,label] of accountChoices(harness))account.add(new Option(label,value));
   account.value=accounts[model]||'';account.onchange=()=>{accounts[model]=account.value;};item.append(account);
  }
  list.append(item);
 }
}
function payload(){
 const key=$('model-router-key').value.trim();
 return {endpoint:$('model-router-endpoint').value.trim(),preference:document.querySelector('input[name="model-router-preference"]:checked').value,models:lines().map(model=>({model,account:accounts[model]||''})),...(key?{api_key:key}:{})};
}
function fill(data){
 saved=data;$('model-router-endpoint').value=data.endpoint||'';$('model-router-key').value='';
 $('model-router-key').placeholder=data.has_api_key?'Saved · leave blank to keep':'Optional · leave blank if the router needs no key';
 $('model-router-forget').hidden=!data.has_api_key;
 for(const radio of document.querySelectorAll('input[name="model-router-preference"]'))radio.checked=radio.value===(data.preference||'auto');
 accounts=Object.fromEntries(data.models.map(m=>[m.model,m.account||'']));
 $('model-router-models').value=data.models.map(m=>m.model).join('\n');preview();
}
let onSaved=null;
async function save(extra={}){
 $('model-router-error').textContent='';
 const data=await terminalRequest('/api/model-router/save',{...payload(),...extra});
 cached=Promise.resolve(data);fill(data);onSaved?.(data);return data;
}
async function busy(work){
 const buttons=[...$('model-router-form').querySelectorAll('button')];buttons.forEach(b=>b.disabled=true);
 try{await work();}catch(error){$('model-router-error').textContent=error.message==='Not found'?'Restart Agent Desk to enable the model router.':error.message;}
 finally{buttons.forEach(b=>b.disabled=false);}
}
function showResult(routing){
 const result=$('model-router-result');result.hidden=false;result.replaceChildren();
 const head=document.createElement('strong');head.textContent=routing.model+' → '+labels[routing.harness];
 const why=document.createElement('span');why.textContent=[routing.bucket&&'Task: '+routing.bucket,routing.reason,routing.fallback&&'classifier fell back to its default bucket'].filter(Boolean).join(' · ');
 const meta=document.createElement('small');meta.textContent=[routing.decision_id,routing.policy_version!=null&&'policy v'+routing.policy_version,routing.ranked?.length&&'ranked: '+routing.ranked.join(', ')].filter(Boolean).join(' · ');
 result.append(head,why,meta);
}
async function open(callback){
 onSaved=callback;$('model-router-error').textContent='';$('model-router-result').hidden=true;
 try{fill(await status(true));}catch(error){fill({endpoint:'',has_api_key:false,preference:'auto',models:[{model:'gpt-6-luna'},{model:'claude-opus-5-5'}]});$('model-router-error').textContent=error.message==='Not found'?'Restart Agent Desk to enable the model router.':error.message;}
 $('model-router-dialog').showModal();$('model-router-endpoint').focus();
}
document.addEventListener('DOMContentLoaded',()=>{
 $('model-router-models').addEventListener('input',preview);
 $('model-router-dialog').querySelector('.close-dialog').onclick=()=>$('model-router-dialog').close();
 $('model-router-form').onsubmit=event=>{event.preventDefault();busy(async()=>{await save();$('model-router-dialog').close();});};
 $('model-router-forget').onclick=()=>busy(async()=>{await save({clear_api_key:true});});
 $('model-router-test').onclick=()=>busy(async()=>{
  $('model-router-result').hidden=true;await save();
  showResult(await terminalRequest('/api/model-router/decide',{task:$('model-router-sample').value}));
 });
});
// One routing toggle: status line, settings button, and availability.
function bindToggle({checkbox,status:line,settings,unavailable=()=>null,onChange=()=>{}}){
 async function refresh(){
  const reason=unavailable();let data=null,error=null;
  if(!reason){try{data=await status();}catch(e){error=e;}}
  const usable=!reason&&!error&&data?.configured;
  checkbox.disabled=!usable;if(!usable)checkbox.checked=false;
  if(usable)line.replaceChildren(...describeNodes(data));
  else line.textContent=reason||(error?(error.message==='Not found'?'Restart Agent Desk to enable the model router.':error.message):'Not set up yet. The router picks each worker’s model and harness from its task.');
  line.dataset.state=usable?'ready':'unavailable';
  settings.hidden=!!reason;settings.textContent=data?.configured?'Router settings':'Set up router';
  onChange();
 }
 checkbox.addEventListener('change',onChange);
 settings.addEventListener('click',()=>open(()=>{cached=null;refresh();}));
 return {refresh};
}
window.modelRouter={status,open,bindToggle};
})();
