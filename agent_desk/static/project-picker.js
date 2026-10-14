let localProjects=[], projectSearchVersion=0, projectOptionIndex=-1;
// The <select> stays the single source of truth so every caller keeps reading
// $('#terminal-project').value; the combobox above it only searches and sets it.
function projectEntries(){
  return [{value:'manual',label:'Use a directory path',hint:'Type the path below'},
    {value:'new',label:'＋ New directory',hint:'Create an empty folder on launch'},
    ...localProjects.map(project=>({value:project.path,label:project.name,hint:shortPath(project.path.slice(0,project.path.lastIndexOf('/'))||'/')}))];
}
function projectLabel(value){const entry=projectEntries().find(item=>item.value===value);return !entry||entry.value==='manual'?'':entry.label;}
function syncProjectSearch(){
  const search=$('#terminal-project-search');
  if(document.activeElement!==search||!projectListOpen())search.value=projectLabel($('#terminal-project').value);
  search.title=$('#terminal-project').value==='new'||$('#terminal-project').value==='manual'?'':$('#terminal-project').value;
}
function setProjectValue(value){
  $('#terminal-project').value=value;syncProjectSearch();updateProjectChoice();
}
function projectListOpen(){return !$('#terminal-project-list').hidden;}
function matchesProject(entry,terms){
  const haystack=(entry.label+' '+entry.value+' '+entry.hint).toLowerCase();
  return terms.every(term=>haystack.includes(term));
}
function renderProjectList(){
  const list=$('#terminal-project-list'),query=$('#terminal-project-search').value.trim().toLowerCase();
  const selected=$('#terminal-project').value;
  const terms=query&&query!==projectLabel(selected).toLowerCase()?query.split(/\s+/):[];
  const entries=projectEntries().filter(entry=>matchesProject(entry,terms));
  list.replaceChildren();
  if(!entries.length){
    const empty=document.createElement('li');empty.className='project-combobox-empty';
    empty.textContent=localProjects.length?'No project matches “'+query+'”':'No projects found yet · scan a folder under Launch settings';
    list.append(empty);projectOptionIndex=-1;return;
  }
  if(projectOptionIndex>=entries.length)projectOptionIndex=entries.length-1;
  entries.forEach((entry,index)=>{
    const option=document.createElement('li');
    option.id='project-option-'+index;option.className='project-combobox-option';option.setAttribute('role','option');option.setAttribute('aria-selected',String(entry.value===selected));
    option.dataset.value=entry.value;option.title=entry.value==='manual'||entry.value==='new'?entry.hint:entry.value;
    const name=document.createElement('strong');name.textContent=entry.label;
    const hint=document.createElement('span');hint.textContent=entry.hint;
    option.append(name,hint);
    if(index===projectOptionIndex)option.classList.add('active');
    option.onmousedown=event=>{event.preventDefault();chooseProject(entry.value);};
    list.append(option);
  });
  const active=list.children[projectOptionIndex];
  $('#terminal-project-search').setAttribute('aria-activedescendant',active?active.id:'');
  active?.scrollIntoView({block:'nearest'});
}
function openProjectList(){
  const list=$('#terminal-project-list');
  if(list.hidden){list.hidden=false;$('#terminal-project-search').setAttribute('aria-expanded','true');}
  renderProjectList();
}
function closeProjectList(){
  const list=$('#terminal-project-list');list.hidden=true;projectOptionIndex=-1;
  $('#terminal-project-search').setAttribute('aria-expanded','false');
  $('#terminal-project-search').removeAttribute('aria-activedescendant');
  syncProjectSearch();
}
function chooseProject(value){closeProjectList();setProjectValue(value);$('#terminal-project-search').focus();}
function projectKeydown(event){
  const visible=[...$('#terminal-project-list').querySelectorAll('.project-combobox-option')];
  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
    event.preventDefault();
    if(!projectListOpen()){openProjectList();return;}
    const count=visible.length;if(!count)return;
    projectOptionIndex=event.key==='ArrowDown'?(projectOptionIndex>=count-1?0:projectOptionIndex+1):(projectOptionIndex<=0?count-1:projectOptionIndex-1);
    renderProjectList();return;
  }
  if(event.key==='Enter'&&projectListOpen()){
    const option=visible[projectOptionIndex]||(visible.length===1?visible[0]:null);
    if(option){event.preventDefault();chooseProject(option.dataset.value);}
    return;
  }
  if(event.key==='Escape'&&projectListOpen()){event.preventDefault();event.stopPropagation();closeProjectList();}
}
function renderProjectOptions(){
  const select=$('#terminal-project'),cwd=$('#terminal-cwd').value,previous=select.value;
  const groups=new Map();
  for(const project of localProjects){
    const parent=project.path.slice(0,project.path.lastIndexOf('/'))||'/';
    if(!groups.has(parent))groups.set(parent,[]);
    groups.get(parent).push(project);
  }
  const grouped=[...groups].sort(([a],[b])=>a.localeCompare(b)).map(([parent,projects])=>`<optgroup label="${escapeHTML(shortPath(parent))}">${projects.sort((a,b)=>a.name.localeCompare(b.name)).map(project=>`<option value="${escapeHTML(project.path)}">${escapeHTML(project.name)}</option>`).join('')}</optgroup>`).join('');
  select.innerHTML='<option value="manual">Use a directory path</option><option value="new">＋ New directory</option>'+grouped;
  select.value=previous==='new'?'new':localProjects.some(p=>p.path===cwd)?cwd:'manual';
  updateProjectChoice(false);syncProjectSearch();if(projectListOpen())renderProjectList();
}
function updateProjectChoice(changeDirectory=true){
  const value=$('#terminal-project').value,isNew=value==='new';
  $('#terminal-new-directory').classList.toggle('hidden',!isNew);
  $('#terminal-directory-name').required=isNew;
  $('#terminal-cwd-label').textContent=isNew?'Parent directory':'Working directory';
  if(changeDirectory&&value!=='manual'&&!isNew)$('#terminal-cwd').value=value;
}
async function scanLocalProjects(root=''){
  const version=++projectSearchVersion;
  $('#terminal-project-status').textContent='Looking for local Git projects…';$('#scan-projects').disabled=true;
  try{
    const data=await terminalRequest('/api/projects'+(root?'?root='+encodeURIComponent(root):''));
    if(version!==projectSearchVersion)return;
    localProjects=data.projects;renderProjectOptions();
    $('#terminal-project-status').textContent=`${localProjects.length} Git projects found${data.limited?' · scan limit reached; try a narrower folder':''}.`;
    $('#terminal-project-status').title='Searched up to four levels in '+data.roots.map(shortPath).join(', ');
  }catch(error){
    if(version!==projectSearchVersion)return;
    $('#terminal-project-status').textContent=error.message==='Not found'?'Project discovery needs the updated server. You can still enter a directory path.':error.message;
  }finally{if(version===projectSearchVersion)$('#scan-projects').disabled=false;}
}
function prepareProjectPicker(){
  $('#terminal-project').value='manual';$('#terminal-directory-name').value='';updateProjectChoice(false);closeProjectList();
  renderProjectOptions();scanLocalProjects($('#terminal-project-root').value.trim());
}
async function resolveProjectDirectory(){
  if($('#terminal-project').value!=='new')return $('#terminal-cwd').value.trim();
  const result=await terminalRequest('/api/projects/create',{parent:$('#terminal-cwd').value.trim(),name:$('#terminal-directory-name').value.trim()});
  // Keep the created path if launching fails, so Retry cannot create another folder.
  $('#terminal-cwd').value=result.path;$('#terminal-project').value='manual';updateProjectChoice(false);syncProjectSearch();
  return result.path;
}
document.addEventListener('DOMContentLoaded',()=>{
  $('#terminal-project').onchange=()=>updateProjectChoice();
  $('#terminal-cwd').oninput=()=>{if($('#terminal-project').value!=='new'){$('#terminal-project').value='manual';syncProjectSearch();}};
  const search=$('#terminal-project-search');
  search.oninput=()=>{projectOptionIndex=-1;openProjectList();};
  search.onfocus=()=>openProjectList();
  search.onclick=()=>openProjectList();
  search.onkeydown=projectKeydown;
  search.onblur=()=>closeProjectList();
  $('#terminal-project-toggle').onclick=()=>{if(projectListOpen())closeProjectList();else{search.focus();search.select();openProjectList();}};
  $('#scan-projects').onclick=()=>scanLocalProjects($('#terminal-project-root').value.trim());
});
