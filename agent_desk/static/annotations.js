// Annotate the desk itself with annotate-anything, the npm package the server serves from
// node_modules in development. Notes sync to the desk's feedback.json, Send goes to an Agent
// Desk session through the same delivery as other feedback, and agents report back onto the notes.
(()=>{
if(!window.AGENT_DESK_CONFIG.development)return;
if(!window.AGENT_DESK_CONFIG.annotations){console.info('Agent Desk: run npm ci in the checkout to turn on the annotation tool.');return;}
async function feedbackRequest(path,body){
  const response=await fetch(path,{method:body?'POST':'GET',cache:'no-store',headers:body?{'Content-Type':'application/json','X-Agent-Desk':'feedback'}:{},...(body?{body:JSON.stringify(body)}:{})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)throw Error(data.error||'Agent Desk could not save the notes');
  return data;
}
const codingAgent=a=>['claude','codex','grok','opencode','pi'].includes(a.harness)||/^(claude|codex)(-[a-z0-9-]+)?$/.test(a.launch_profile||'');
// Coordinators and standalone coding agents take notes; workers get theirs from their coordinator.
async function targets(){
  const {agents:live=[]}=await terminalRequest('/api/agents');
  return live.filter(a=>a.exit_code==null&&!a.parent_id&&!a.remote_node&&!a.harness_internal&&(a.coordinator_workspace||a.terminal_id&&codingAgent(a)))
    .map(a=>({agent:a,open:openPaneIds.includes(a.id)}))
    .sort((a,b)=>Number(b.open)-Number(a.open)||sessionTitle(a.agent).localeCompare(sessionTitle(b.agent)))
    .map(({agent,open})=>({id:agent.id,label:sessionTitle(agent),detail:[agent.coordinator_workspace?'Coordinator':'',agent.project||shortPath(agent.cwd||''),open?'Open pane':''].filter(Boolean).join(' · ')}));
}
const transport={
  kind:'http',sends:true,
  pull:()=>feedbackRequest('/api/feedback'),
  push:(notes,deleted)=>feedbackRequest('/api/feedback',{notes,deleted}),
  async submit(notes,page,target){
    if(!target)throw Error('No agent is open to take them. Open a coding agent or coordinator first');
    return terminalRequest('/api/coordinators/submit-annotations',{request_id:crypto.randomUUID(),target_id:target.id,agent:target.label,note_ids:notes.map(n=>n.id),page});
  },
  status:async(ids,status)=>{await feedbackRequest('/api/feedback/status',{ids,status});},
  targets,
};
// Escape belongs to the open toolbar, not to the page under it (the vendored build keeps its UI in an open shadow root).
window.annotationsOpen=()=>!!document.querySelector('annotate-anything')?.shadowRoot?.querySelector('.toolbar:not([hidden])');
// Pages aren't in the URL, so a note's route is the page it was left on.
const route=()=>'/'+(document.querySelector('.page:not(.hidden)')?.id.replace(/-page$/,'')||'agents');
const script=document.createElement('script');
script.src='/annotate-anything.js';script.dataset.manual='';
script.onload=()=>{window.annotations=AnnotateAnything.annotate({
  transport,enabled:true,scope:'agent-desk',route,
  navigate:to=>switchPage(to.replace(/^\//,'')),
  stableAttributes:['data-agent-id','data-testid'],
  theme:{accent:'var(--accent)'},
});};
document.head.append(script);
})();
