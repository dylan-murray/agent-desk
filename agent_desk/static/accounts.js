// Account choices in every picker, and the dialog that adds or removes a login by its config folder or, for Cortex Code, its Snowflake connection.
(function(){
  const el=id=>document.getElementById(id);
  const folders={claude:['CLAUDE_CONFIG_DIR','~/.claude-'],codex:['CODEX_HOME','~/.codex-'],grok:['GROK_HOME','~/.grok-'],opencode:['XDG_DATA_HOME','~/.opencode-'],pi:['PI_CODING_AGENT_DIR','~/.pi-']};
  // An added Grok, OpenCode or Pi account sits after that CLI's own choice; the rest go before the first of those.
  function fill(picker,before,only){
    const selected=picker.value;
    picker.querySelectorAll('[data-account]').forEach(option=>option.remove());
    for(const account of launchAccounts.filter(account=>!only||only.includes(account.harness))){
      const option=new Option(account.label,account.id);option.dataset.account='true';
      const own=picker.querySelector('option[value="'+account.harness+'"]:not([data-account])');
      if(own&&own!==picker.querySelector('option[value="'+account.id+'"]')){let last=own;while(last.nextElementSibling?.dataset.account&&launchChoices[last.nextElementSibling.value]?.harness===account.harness)last=last.nextElementSibling;last.after(option);}
      else picker.insertBefore(option,before);
    }
    if([...picker.options].some(option=>option.value===selected))picker.value=selected;
  }
  function populate(){
    fill(el('terminal-harness'),el('terminal-harness').querySelector('option[value="grok"]'));
    fill(el('special-choice'),el('special-choice').querySelector('option[value="custom"]'),['claude','codex']);
    if(!el('special-choice').dataset.chosen){el('special-choice').value='claude';el('special-choice').dataset.chosen='true';}
    el('skill-tool-agent')?.replaceChildren();
    document.dispatchEvent(new Event('agent-desk-accounts'));
  }
  function update(accounts){applyAccounts(accounts.map(({id,harness,name,label})=>({id,harness,name,label})));populate();}
  function status(text,error){el('accounts-status').textContent=text;el('accounts-status').classList.toggle('error',!!error);}
  function render(accounts){
    el('accounts-list').replaceChildren(...accounts.map(account=>{
      const item=document.createElement('li'),name=document.createElement('strong'),folder=document.createElement('code');
      name.textContent=account.label;folder.textContent=account.harness==='cortex'?'Connection '+account.connection:account.config_dir||'Default login';item.append(name,folder);
      if(!account.default){
        const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+account.label);
        remove.onclick=async()=>{try{const result=await terminalRequest('/api/accounts/delete',{id:account.id});update(result.accounts);render(result.accounts);status('Removed '+account.label+'. Its config folder was not touched.');}catch(error){status(error.message,true);}};
        item.append(remove);
      }
      return item;
    }));
  }
  function help(){
    const harness=el('account-harness').value;
    el('account-folder-label').textContent=harness==='cortex'?'Snowflake connection':'Config folder';
    if(harness==='cortex'){
      el('account-folder').placeholder='my_connection';
      el('account-help').textContent='Agent Desk starts cortex with --connection '+(el('account-folder').value.trim()||'my_connection')+'. To see your connection names, run: cortex connections list';
      return;
    }
    const [variable,prefix]=folders[harness],folder=el('account-folder').value.trim()||prefix+'personal';
    el('account-folder').placeholder=prefix+'personal';
    el('account-help').textContent='Agent Desk starts '+harness+' with '+variable+' set to this folder. To sign in, run: '+variable+'='+folder+' '+harness+(harness==='opencode'?'. OpenCode keeps its login in its data folder, so commands it runs in that terminal also see this folder as XDG_DATA_HOME.':'');
  }
  el('open-accounts').onclick=async()=>{
    status('');help();el('accounts-dialog').showModal();
    try{render((await terminalRequest('/api/accounts/list',{})).accounts);}catch(error){status(error.message,true);}
  };
  el('accounts-close').onclick=()=>el('accounts-dialog').close();
  el('account-harness').onchange=help;el('account-folder').oninput=help;
  el('accounts-form').onsubmit=async event=>{
    event.preventDefault();
    try{
      const harness=el('account-harness').value,value=el('account-folder').value;
      const result=await terminalRequest('/api/accounts/save',{harness,name:el('account-name').value,...(harness==='cortex'?{connection:value}:{config_dir:value})});
      update(result.accounts);render(result.accounts);el('account-name').value='';el('account-folder').value='';help();
      status('Added '+result.saved.label+'.'+(result.saved.exists?'':harness==='cortex'?' That connection is not in your Snowflake config yet; cortex connections list shows the ones it has.':' That folder does not exist yet; sign in with the command above to create it.'));
    }catch(error){status(error.message,true);}
  };
  populate();
})();
