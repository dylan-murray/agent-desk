// Tools are skills with a UI. Skills launches one beside a new agent session, so there is always an
// agent to send notes to, and starts an agent session to build a new one.
let toolLaunchers=[];
const toolAgents=()=>launchAccounts.filter(account=>['claude','codex'].includes(account.harness)).map(account=>account.id);
function preferredToolAgent(){try{const key=localStorage.getItem('agent-desk-tool-agent');return toolAgents().includes(key)?key:'claude';}catch{return 'claude';}}
function fillToolAgents(select){select.innerHTML=toolAgents().map(key=>`<option value="${escapeHTML(key)}">${escapeHTML(launchChoices[key].label)}</option>`).join('');select.value=preferredToolAgent();}
async function loadToolLaunchers(){try{toolLaunchers=(await terminalRequest('/api/tool-launchers')).launchers||[];}catch{toolLaunchers=[];}}
const launcherFor=skill=>skill?toolLaunchers.find(launcher=>launcher.id===skill.id):null;

function renderSkillTool(skill){
  const launcher=launcherFor(skill),panel=$('#skill-tool-panel');
  panel.hidden=!launcher;if(!launcher)return;
  const folder=launcher.target==='directory',standalone=launcher.target==='none',input=$('#skill-tool-target');
  $('#skill-tool-target-field').hidden=standalone;
  $('#skill-tool-title').textContent=launcher.title;
  $('#skill-tool-description').textContent=launcher.description||'';
  $('#skill-tool-target-label').textContent=folder?'Folder or repository':'File';
  input.placeholder=folder?'/absolute/path/to/repository':'/absolute/path/to/file';
  if(input.dataset.skill!==skill.id){input.dataset.skill=skill.id;input.value=folder?current().find(a=>a.id===selectedId)?.cwd||'':'';}
  if(!$('#skill-tool-agent').options.length)fillToolAgents($('#skill-tool-agent'));
  $('#skill-tool-error').textContent='';
}

async function launchAgentSession({cwd,profile,name,prompt}){
  const choice=launchChoices[profile];
  const session=await terminalRequest('/api/terminals/launch',{cwd,launch_profile:profile,name,argv:buildTerminalCommand(choice.command,choice.mode,[prompt]),desk:activeDesk().id});
  rememberLaunchChoice(profile,{command:choice.command,mode:choice.mode},session.id);
  freshTerminalIds.add(session.id);demo=false;paneMode=paneStoreKey();
  agents.unshift({...session,project:session.cwd.split('/').pop()||session.cwd});
  return session;
}
function showSessionPane(id){
  if(openPaneIds.length>=PANE_LIMIT)openPaneIds=openPaneIds.filter(value=>value!==selectedId).slice(0,PANE_LIMIT-1);
  openPaneIds.push(id);selectedId=id;savePanes();switchPage('agents');render();paneViews.get(id)?.node.scrollIntoView({block:'nearest'});
}
function rememberToolAgent(profile){try{localStorage.setItem('agent-desk-tool-agent',profile);}catch{}}

const toolSessionPrompt=(skill,launcher,ui)=>`Agent Desk opened the ${launcher.title} tool from the ${skill.name} skill${ui.context?' on '+ui.context:''}. It is already running at ${ui.url} and shown beside you in this pane, so do not start another copy. Read the skill's instructions at ${skill.path} and follow its feedback workflow for that running UI: wait for my notes from the tool and act on them.`;

// The tool starts first so a bad path fails before an agent is started, then the agent, then the
// tool is handed to the agent's pane.
$('#skill-tool-launch').onclick=async()=>{
  const skill=selectedSkill,launcher=launcherFor(skill),input=$('#skill-tool-target'),button=$('#skill-tool-launch');
  if(!launcher)return;
  const target=input.value.trim(),profile=$('#skill-tool-agent').value;
  if(!target&&launcher.target!=='none'){input.focus();return;}
  button.disabled=true;$('#skill-tool-error').textContent='';
  try{
    rememberToolAgent(profile);
    const ui=await terminalRequest('/api/tools/launch',{skill:launcher.id,...(launcher.target==='none'?{}:{target})});
    // Its owner is named below; until then the registry poll must not open it on its own.
    knownToolIds.add(ui.id);
    const cwd=launcher.target==='none'?current().find(a=>a.id===selectedId)?.cwd||terminalDefaultCwd:launcher.target==='directory'?ui.context:ui.context.replace(/\/[^/]+$/,'')||'/';
    const session=await launchAgentSession({cwd,profile,name:ui.title,prompt:toolSessionPrompt(skill,launcher,ui)});
    const owned=await terminalRequest('/api/tools/launch',{id:ui.id,skill:launcher.id,...(ui.context?{target:ui.context}:{}),agent_id:session.id});
    paneDocks.set(session.id,{side:'right',size:.5,tool:owned.id,open:true});savePaneDocks();
    await refreshSkillUIs();showSessionPane(session.id);
  }catch(error){$('#skill-tool-error').textContent=error.message;}
  finally{button.disabled=false;}
};

function skillLibraryRoot(){
  const path=installedSkills.map(skill=>skill.path).find(path=>path.includes('/.agents/skills/'));
  return path?path.slice(0,path.indexOf('/.agents/skills/')+'/.agents/skills'.length):terminalDefaultCwd;
}
function toolBuildPrompt(name,purpose,root){
  const example=installedSkills.find(skill=>toolLaunchers.some(launcher=>launcher.id===skill.id));
  return [`Build a new Agent Desk tool named "${name}": a skill whose UI opens beside an agent in Agent Desk.`,
    `What it should let me do: ${purpose}`,
    `Decide from that what the tool opens on: a file, a folder or repository, or nothing at all. Set "target" to "file", "directory" or "none" accordingly.`,
    `Create it in ${root}/${name}/ with:`,
    `- SKILL.md: frontmatter with name and description, then when to use the tool and how notes from its UI get back to the agent.`,
    `- A stdlib-only Python HTTP server that serves the UI. Agent Desk runs it as \`<script> {target} --port {port} --no-browser\`, leaving out {target} when the target is "none". Serve on the port it is given.`,
    `- agent-desk-ui.json: {"runtime":"python-http","entrypoint":"<script>.py","title":"…","description":"…","target":"file|directory|none"}.`,
    example?`Follow the conventions of an existing tool, such as the ${example.name} skill at ${example.path.replace(/\/SKILL\.md$/,'')}, including how its notes reach the agent.`:'',
    `Before you finish, run the server the way Agent Desk will and check the UI loads. Once it works, it appears on the Agent Desk Skills page with a Launch button.`].filter(Boolean).join('\n\n');
}
$('#skills-build-tool').onclick=()=>{fillToolAgents($('#tool-build-agent'));$('#tool-build-error').textContent='';$('#tool-builder').showModal();$('#tool-build-name').focus();};
$('#tool-builder-form').onsubmit=async event=>{
  event.preventDefault();const submit=event.submitter;submit.disabled=true;$('#tool-build-error').textContent='';
  try{
    const name=$('#tool-build-name').value.trim(),profile=$('#tool-build-agent').value,root=skillLibraryRoot();
    rememberToolAgent(profile);
    const session=await launchAgentSession({cwd:root,profile,name:'Build tool · '+name,prompt:toolBuildPrompt(name,$('#tool-build-purpose').value.trim(),root)});
    rememberBuiltTool(name);
    $('#tool-builder').close();$('#tool-builder-form').reset();showSessionPane(session.id);
  }catch(error){$('#tool-build-error').textContent=error.message;}
  finally{submit.disabled=false;}
};

// A skill made by Build a skill is shared with every agent as it is created. A tool is written by an
// agent instead, so Agent Desk remembers what it asked for and shares it once the skill appears.
function builtTools(){try{return JSON.parse(localStorage.getItem('agent-desk-built-tools')||'[]');}catch{return [];}}
function rememberBuiltTool(name){try{localStorage.setItem('agent-desk-built-tools',JSON.stringify([...new Set([...builtTools(),name])].slice(-50)));}catch{}}
async function shareBuiltTools(){
  const pending=builtTools(),ready=installedSkills.filter(skill=>pending.includes(skill.id));
  if(!ready.length)return;
  if(ready.some(skill=>skillHarnesses.some(harness=>!skill.availability?.[harness.id]))){
    const result=await terminalRequest('/api/skills/sync',{});
    installedSkills=result.skills;skillHarnesses=result.harnesses||[];renderSkillStatus();renderSkillList();
    toast('Shared '+ready.map(skill=>skill.name).join(', ')+' with every agent.');
  }
  try{localStorage.setItem('agent-desk-built-tools',JSON.stringify(pending.filter(name=>!ready.some(skill=>skill.id===name))));}catch{}
}
