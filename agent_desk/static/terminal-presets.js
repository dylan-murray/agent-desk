// Named executable presets share the launcher's existing browser-local settings storage.
const terminalPresetKey='agent-desk-terminal-presets';
let terminalPresets=[];
function validateTerminalPreset(preset){
  if(!preset||typeof preset.id!=='string'||!/^preset-[a-f0-9-]+$/.test(preset.id))throw Error('Invalid preset ID');
  if(typeof preset.label!=='string'||!preset.label.trim()||preset.label.length>100)throw Error('Enter a preset name (up to 100 characters)');
  if(!['direct','/bin/zsh','/bin/bash'].includes(preset.mode))throw Error('Choose how to run the command');
  if(typeof preset.command!=='string'||preset.command.length>2000)throw Error('Enter a command');
  if(!Array.isArray(preset.args)||preset.args.length>100||preset.args.some(arg=>typeof arg!=='string'||arg.length>10000||arg.includes('\0')))throw Error('Invalid preset arguments');
  buildTerminalCommand(preset.command,preset.mode,preset.args);
  return {...preset,harness:'custom',label:preset.label.trim()};
}
try{const saved=JSON.parse(localStorage.getItem(terminalPresetKey)||'[]');if(Array.isArray(saved))terminalPresets=saved.slice(0,100).flatMap(p=>{try{return [validateTerminalPreset(p)];}catch{return [];}});}catch{}
function populateTerminalPresets(selected){
  const picker=document.getElementById('terminal-harness');
  picker.querySelector('[data-custom-presets]')?.remove();
  for(const key of Object.keys(launchChoices))if(key.startsWith('preset-'))delete launchChoices[key];
  if(terminalPresets.length){const group=document.createElement('optgroup');group.label='Saved executables';group.dataset.customPresets='true';
    for(const preset of terminalPresets){launchChoices[preset.id]=preset;const option=document.createElement('option');option.value=preset.id;option.textContent=preset.label;group.append(option);}picker.append(group);}
  if(selected&&launchChoices[selected])picker.value=selected;
}
let restoredTerminalPreset=null;
try{restoredTerminalPreset=localStorage.getItem('agent-desk-selected-launch-preset');}catch{}
populateTerminalPresets(restoredTerminalPreset);
function updateTerminalPresetControls(){
  const key=document.getElementById('terminal-harness').value,preset=terminalPresets.find(p=>p.id===key);
  document.getElementById('terminal-preset-controls').classList.toggle('hidden',key!=='custom'&&!preset);
  document.getElementById('terminal-preset-name').value=preset?.label||'';
  document.getElementById('update-terminal-preset').classList.toggle('hidden',!preset);
  document.getElementById('remove-terminal-preset').classList.toggle('hidden',!preset);
  document.getElementById('terminal-preset-error').textContent='';
  try{if(preset)localStorage.setItem('agent-desk-selected-launch-preset',key);else localStorage.removeItem('agent-desk-selected-launch-preset');}catch{}
}
function saveTerminalPreset(update){
  try{
    const selected=document.getElementById('terminal-harness').value;
    if(update&&!terminalPresets.some(p=>p.id===selected))throw Error('Choose a saved executable to update');
    const preset=validateTerminalPreset({id:update?selected:'preset-'+crypto.randomUUID(),label:document.getElementById('terminal-preset-name').value,
      command:document.getElementById('terminal-executable').value.trim(),mode:document.getElementById('terminal-command-mode').value,
      args:document.getElementById('terminal-args').value.split('\n').map(arg=>arg.trim()).filter(Boolean)});
    if(terminalPresets.some(p=>p.id!==preset.id&&p.label.toLowerCase()===preset.label.toLowerCase()))throw Error('That name is already saved. Choose it and use Update, or enter another name.');
    const next=update?terminalPresets.map(p=>p.id===preset.id?preset:p):[...terminalPresets,preset];
    if(next.length>100)throw Error('Remove a preset before adding more (100 maximum)');
    localStorage.setItem(terminalPresetKey,JSON.stringify(next));terminalPresets=next;populateTerminalPresets(preset.id);loadLaunchChoice();toast(update?'Executable preset updated.':'Executable saved. It is now in the agent menu.');
  }catch(error){document.getElementById('terminal-preset-error').textContent=error.message;}
}
document.addEventListener('DOMContentLoaded',()=>{
  document.getElementById('save-terminal-preset').onclick=()=>saveTerminalPreset(false);
  document.getElementById('update-terminal-preset').onclick=()=>saveTerminalPreset(true);
  document.getElementById('remove-terminal-preset').onclick=()=>{
    const key=document.getElementById('terminal-harness').value,preset=terminalPresets.find(p=>p.id===key);if(!preset)return;
    if(!confirm(`Remove “${preset.label}” from saved executables? Running sessions will keep running.`))return;
    try{const next=terminalPresets.filter(p=>p.id!==key);localStorage.setItem(terminalPresetKey,JSON.stringify(next));terminalPresets=next;populateTerminalPresets('custom');loadLaunchChoice();toast('Executable preset removed.');}catch(error){document.getElementById('terminal-preset-error').textContent=error.message;}
  };
});
