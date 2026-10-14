let installedSkills = [], skillHarnesses = [], selectedSkill = null;
const skillDrafts = new Map();
function skillPrompt(){
  const task=$('#skill-task').value.trim();
  const agent=current().find(a=>a.id===selectedId);
  return `Use the ${selectedSkill.name} skill for this task. Read its complete instructions at ${selectedSkill.path} and resolve supporting files relative to that skill directory. Apply the workflow using your available tools. If a step relies on a harness-specific feature or unavailable integration, identify that dependency before attempting the step.\n\n${agent?.cwd?'Working directory: '+agent.cwd+'\n\n':''}Task: ${task}`;
}
function chooseSkill(skill){
  if(selectedSkill)skillDrafts.set(selectedSkill.path,$('#skill-task').value);
  selectedSkill=skill;
  $('#skill-title').textContent=skill.name;
  $('#skill-description').textContent=skill.description;
  $('#skill-location').textContent='Local source: '+skill.path;
  $('#skill-availability').innerHTML=skillHarnesses.map(h=>`<span class="skill-harness ${skill.availability?.[h.id]?'on':'off'}" title="${escapeHTML(h.label)}${skill.availability?.[h.id]?' can use this skill':' cannot see this skill yet'}">${skill.availability?.[h.id]?'✓':'—'} ${escapeHTML(h.label)}</span>`).join('');
  $('#skill-explicit').hidden=!skill.explicit_only;
  const notes=skill.portability||[];
  $('#skill-portability').hidden=!notes.length;
  $('#skill-portability ul').innerHTML=notes.map(note=>`<li>${escapeHTML(note)}</li>`).join('');
  $('#skill-content').textContent=skill.content;
  $('#skill-task').value=skillDrafts.get(skill.path)||'';
  $('#skill-task-panel').classList.remove('hidden');
  renderSkillTool(skill);
  const agent=current().find(a=>a.id===selectedId);
  $('#skill-session-context').textContent=agent?`${agent.harness} · ${agent.project}`:'Choose a session from the sidebar';
  renderSkillList();
}
function renderSkillList(){
  const query=$('#skill-search').value.trim().toLowerCase();
  const visible=installedSkills.filter(s=>(s.name+' '+s.description).toLowerCase().includes(query));
  $('#skill-list').innerHTML=visible.length?visible.map(s=>`<button class="skill-item ${s.path===selectedSkill?.path?'selected':''}" data-skill-index="${installedSkills.indexOf(s)}" aria-pressed="${s.path===selectedSkill?.path}"><strong>${escapeHTML(s.name)}</strong><small>${escapeHTML(s.description||'Local workflow')}</small><span class="skill-sources">${skillHarnesses.map(h=>`<span class="skill-source ${s.availability?.[h.id]?'on':'off'}" title="${escapeHTML(h.label)}${s.availability?.[h.id]?'':' cannot see this skill yet'}">${escapeHTML(accountLabels()[h.id]||h.label)}</span>`).join('')}${launcherFor(s)?'<span class="skill-source tool" title="Has a tool you can launch beside an agent">Tool</span>':''}${s.explicit_only?'<span class="skill-source tag" title="Runs only when you name it">Explicit</span>':''}${(s.portability||[]).length?`<span class="skill-source warn" title="${escapeHTML(s.portability.join(' '))}">${s.portability.length} caveat${s.portability.length===1?'':'s'}</span>`:''}</span></button>`).join(''):'<p class="empty">No matching skills.</p>';
  document.querySelectorAll('[data-skill-index]').forEach(b=>b.onclick=()=>chooseSkill(installedSkills[+b.dataset.skillIndex]));
}
function skillGaps(){return installedSkills.reduce((count,skill)=>count+skillHarnesses.filter(h=>!skill.availability?.[h.id]).length,0);}
function renderSkillStatus(){
  const gaps=skillGaps(),agents=skillHarnesses.length;
  $('#skills-status').textContent=!agents?`${installedSkills.length} skills on this machine`:gaps?`${installedSkills.length} skills on this machine · ${gaps} ${gaps===1?'gap':'gaps'} across ${agents} agents`:`${installedSkills.length} skills on this machine · every one available to all ${agents} agents`;
  $('#skills-sync').hidden=!gaps;
}
async function loadSkills(){
  const response=await fetch('/api/skills');if(!response.ok)throw Error();
  const data=await response.json();
  await loadToolLaunchers();
  installedSkills=data.skills;skillHarnesses=data.harnesses||[];
  if(selectedSkill)selectedSkill=installedSkills.find(skill=>skill.path===selectedSkill.path)||null;
  renderSkillStatus();renderSkillList();
  if(selectedSkill)chooseSkill(selectedSkill);else if(installedSkills.length)chooseSkill(installedSkills[0]);
  shareBuiltTools().catch(error=>toast('Could not share a new tool with every agent: '+error.message));
}
$('#open-skills').onclick=async()=>{
  switchPage('skills');
  try{await loadSkills();}catch{$('#skills-status').textContent='Could not load skills. Reopen Skills to retry.';}
};
const localSkillDialog=$('#skills-find-dialog');
let localSkills=[];
function renderLocalSkills(){
  const list=$('#skills-find-results');list.replaceChildren();
  for(const skill of localSkills){
    const row=document.createElement('div'),info=document.createElement('div'),name=document.createElement('strong'),path=document.createElement('small'),add=document.createElement('button');
    row.className='skills-find-result';name.textContent=skill.name;path.textContent=skill.path;info.append(name,path);
    add.type='button';add.className='button';add.textContent=skill.installed?'Added':'Add';add.disabled=skill.installed;
    add.onclick=()=>addLocalSkill(skill.path,add);row.append(info,add);list.append(row);
  }
  if(!localSkills.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No skill folders found here. Choose a narrower folder or enter a skill path below.';list.append(empty);}
}
async function scanLocalSkills(){
  const button=$('#skills-find-scan');button.disabled=true;$('#skills-find-error').textContent='';$('#skills-find-status').textContent='Searching local folders…';
  try{
    const root=$('#skills-find-root').value.trim();
    const result=await terminalRequest('/api/skills/discover'+(root?'?root='+encodeURIComponent(root):''));
    localSkills=result.skills;renderLocalSkills();
    $('#skills-find-status').textContent=`${localSkills.length} skill folder${localSkills.length===1?'':'s'} found in ${result.root}`+(result.truncated?' · search limit reached; choose a narrower folder':'');
  }catch(error){$('#skills-find-error').textContent=error.message;$('#skills-find-status').textContent='Search failed.';}
  finally{button.disabled=false;}
}
async function addLocalSkill(path,button){
  button.disabled=true;$('#skills-find-error').textContent='';
  try{
    await terminalRequest('/api/skills/add',{path});await loadSkills();
    localSkills=localSkills.map(skill=>skill.path===path?{...skill,installed:true}:skill);renderLocalSkills();
    $('#skills-find-status').textContent='Skill added to the shared library and made available to your agents.';
    $('#skills-add-path').value='';
  }catch(error){$('#skills-find-error').textContent=error.message;button.disabled=false;}
}
$('#skills-find-local').onclick=()=>{localSkillDialog.showModal();$('#skills-find-root').focus();};
$('#skills-find-form').onsubmit=event=>{event.preventDefault();scanLocalSkills();};
$('#skills-add-direct').onclick=()=>{const path=$('#skills-add-path').value.trim();if(path)addLocalSkill(path,$('#skills-add-direct'));else $('#skills-find-error').textContent='Enter a skill folder path.';};
$('#skills-find-close').onclick=()=>localSkillDialog.close();
// Links each skill into the folders the other agents read. Nothing is copied or replaced.
$('#skills-sync').onclick=async()=>{
  const button=$('#skills-sync');button.disabled=true;
  try{
    const result=await terminalRequest('/api/skills/sync',{});
    installedSkills=result.skills;skillHarnesses=result.harnesses||[];
    renderSkillStatus();renderSkillList();if(selectedSkill)chooseSkill(installedSkills.find(skill=>skill.path===selectedSkill.path)||installedSkills[0]);
    const linked=result.linked.length,conflicts=result.conflicts.length;
    toast(`Linked ${linked} ${linked===1?'skill':'skills'}`+(conflicts?` · ${conflicts} name ${conflicts===1?'clash':'clashes'} left untouched`:'')+'.');
  }catch(error){toast(error.message==='Not found'?'Restart Agent Desk to enable skill syncing.':error.message);}
  finally{button.disabled=false;}
};
$('#skills-back').onclick=()=>switchPage('agents');
$('#skill-search').oninput=renderSkillList;
$('#skill-task').oninput=()=>{if(selectedSkill)skillDrafts.set(selectedSkill.path,$('#skill-task').value);};
$('#copy-skill-task').onclick=async()=>{
  if(!selectedSkill)return;
  if(!$('#skill-task').value.trim()){$('#skill-task').focus();return;}
  const prompt=skillPrompt();
  try{await navigator.clipboard.writeText(prompt);toast('Task copied. Paste it into your harness.');}
  catch{const url=URL.createObjectURL(new Blob([prompt],{type:'text/plain'}));const link=document.createElement('a');link.href=url;link.download='agent-task.txt';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast('Clipboard unavailable. Task downloaded.');}
};

const skillBuilder=$('#skill-builder');
const skillBuilderFields=['name','purpose','trigger','steps','examples'];
let skillBuilderPreview=null;
const skillBuilderPayload=()=>Object.fromEntries(skillBuilderFields.map(key=>[key,$('#skill-build-'+key).value.trim()]));
$('#skills-build').onclick=()=>{skillBuilder.showModal();$('#skill-build-name').focus();};
$('#skill-build-close').onclick=()=>skillBuilder.close();
$('#skill-builder-form').oninput=()=>{skillBuilderPreview=null;$('#skill-build-install').hidden=true;$('#skill-build-review').hidden=true;};
$('#skill-builder-form').onsubmit=async event=>{
 event.preventDefault();$('#skill-build-error').textContent='';
 const payload=skillBuilderPayload();
 try{const draft=await terminalRequest('/api/skills/preview',payload);if(JSON.stringify(payload)!==JSON.stringify(skillBuilderPayload()))return;
  skillBuilderPreview=JSON.stringify(payload);$('#skill-build-preview').textContent=draft.content;$('#skill-build-review').hidden=false;$('#skill-build-install').hidden=false;$('#skill-build-review').scrollIntoView({block:'nearest'});
 }catch(e){$('#skill-build-error').textContent=e.message;}
};
$('#skill-build-install').onclick=async()=>{
 const payload=skillBuilderPayload();if(JSON.stringify(payload)!==skillBuilderPreview)return;
 const button=$('#skill-build-install');button.disabled=true;
 try{const result=await terminalRequest('/api/skills/create',payload);await loadSkills();const skill=installedSkills.find(s=>s.path===result.created);if(skill)chooseSkill(skill);skillBuilder.close();$('#skill-builder-form').reset();skillBuilderPreview=null;$('#skill-build-review').hidden=true;button.hidden=true;toast('Skill created'+(result.conflicts?.length?' · some agent folders have name conflicts; check availability.':'.'));}
 catch(e){$('#skill-build-error').textContent=e.message;}finally{button.disabled=false;}
};
