// Tools are skill UIs. Each one lives on the desk: docked in the pane of the agent that opened it,
// or, when no agent on the desk owns it, as a web pane. Skills is where tools are launched and built.
let skillUIs=[],registryReady=false;
const knownToolIds=new Set();
function openToolOnDesk(ui){
  if(!ui)return;
  if(!dockTool(ui))openWebPage(ui.url,ui.title);
}
async function refreshSkillUIs(){
  try{
    const response=await fetch('/api/skill-uis');if(!response.ok)throw Error('Could not refresh tools');
    skillUIs=(await response.json()).uis;
    for(const ui of skillUIs){
      // A tool an agent opens appears on the desk by itself, like a terminal an agent spawns.
      if(registryReady&&!knownToolIds.has(ui.id)&&ui.status!=='stopped'&&!autoDockTool(ui)&&!dockOwner(ui))openWebPage(ui.url,ui.title,{quiet:true});
      knownToolIds.add(ui.id);
    }
    renderPaneDocks();
    if(!registryReady&&location.pathname.startsWith('/apps/')){
      const ui=skillUIs.find(item=>item.id===location.pathname.split('/')[2]);
      history.replaceState({},'','/');
      if(ui)openToolOnDesk(ui);else toast('This tool is no longer available.');
    }
    registryReady=true;
  }catch{}
}
refreshSkillUIs();setInterval(refreshSkillUIs,5000);

window.openDeskTool=async endpoint=>{await refreshSkillUIs();const ui=skillUIs.find(item=>item.endpoint===endpoint);if(ui)openToolOnDesk(ui);else toast('This tool is no longer available. Launch it again from Skills.');};

const reviewerDialog=document.createElement('dialog');reviewerDialog.className='reviewer-dialog';reviewerDialog.setAttribute('aria-label','Request second opinions');reviewerDialog.innerHTML='<h2>Second opinion</h2><p>Choose independent reviewers. Each opens as an Agent Desk worker and reports back to the coordinator.</p><div class="reviewer-options"></div><p class="reviewer-error" role="alert"></p><footer><button type="button" class="reviewer-cancel">Cancel</button><button type="button" class="reviewer-start">Start reviews</button></footer>';document.body.append(reviewerDialog);
let reviewerTarget=null,reviewRequest=null;
reviewerDialog.querySelector('.reviewer-cancel').onclick=()=>reviewerDialog.close();
async function requestSecondOpinion(ui){reviewerTarget=ui;if(!reviewerTarget?.agent_id)return;reviewRequest=crypto.randomUUID();const options=reviewerDialog.querySelector('.reviewer-options');options.replaceChildren();reviewerDialog.querySelector('.reviewer-error').textContent='';try{const data=await terminalRequest('/api/coordinators/reviewers',{id:reviewerTarget.agent_id,tool_id:reviewerTarget.id});for(const profile of data.profiles){const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=profile.id;label.append(input,document.createTextNode(profile.label));options.append(label);}reviewerDialog.showModal();}catch(e){toast(e.message);}}
reviewerDialog.querySelector('.reviewer-start').onclick=async()=>{const button=reviewerDialog.querySelector('.reviewer-start');button.disabled=true;try{const profiles=[...reviewerDialog.querySelectorAll('input:checked')].map(n=>n.value);const result=await terminalRequest('/api/coordinators/second-opinion',{id:reviewerTarget.agent_id,tool_id:reviewerTarget.id,profiles,request_id:reviewRequest});reviewerDialog.close();toast(result.workers.length+' reviewers launched; results return to the coordinator.');}catch(e){reviewerDialog.querySelector('.reviewer-error').textContent=e.message;}finally{button.disabled=false;}};
