// Account choices in every picker, and the dialog that adds or removes a login by its config folder.
(function(){
  const el=id=>document.getElementById(id);
  const folders={claude:['CLAUDE_CONFIG_DIR','~/.claude-'],codex:['CODEX_HOME','~/.codex-']};
  function fill(picker,before){
    const selected=picker.value;
    picker.querySelectorAll('[data-account]').forEach(option=>option.remove());
    for(const account of launchAccounts){const option=new Option(account.label,account.id);option.dataset.account='true';picker.insertBefore(option,before);}
    if([...picker.options].some(option=>option.value===selected))picker.value=selected;
  }
  function populate(){
    fill(el('terminal-harness'),el('terminal-harness').querySelector('option[value="grok"]'));
    fill(el('special-choice'),el('special-choice').querySelector('option[value="custom"]'));
    if(!el('special-choice').dataset.chosen){el('special-choice').value='claude';el('special-choice').dataset.chosen='true';}
    el('skill-tool-agent')?.replaceChildren();
    document.dispatchEvent(new Event('agent-desk-accounts'));
  }
  function update(accounts){applyAccounts(accounts.map(({id,harness,name,label})=>({id,harness,name,label})));populate();}
  function status(text,error){el('accounts-status').textContent=text;el('accounts-status').classList.toggle('error',!!error);}
  function render(accounts){
    el('accounts-list').replaceChildren(...accounts.map(account=>{
      const item=document.createElement('li'),name=document.createElement('strong'),folder=document.createElement('code');
      name.textContent=account.label;folder.textContent=account.config_dir||'Default login';item.append(name,folder);
      if(!account.default){
        const remove=document.createElement('button');remove.type='button';remove.className='text-button';remove.textContent='Remove';remove.setAttribute('aria-label','Remove '+account.label);
        remove.onclick=async()=>{try{const result=await terminalRequest('/api/accounts/delete',{id:account.id});update(result.accounts);render(result.accounts);status('Removed '+account.label+'. Its config folder was not touched.');}catch(error){status(error.message,true);}};
        item.append(remove);
      }
      return item;
    }));
  }
  function help(){
    const harness=el('account-harness').value,[variable,prefix]=folders[harness],folder=el('account-folder').value.trim()||prefix+'personal';
    el('account-folder').placeholder=prefix+'personal';
    el('account-help').textContent='Agent Desk starts '+harness+' with '+variable+' set to this folder. To sign in, run: '+variable+'='+folder+' '+harness;
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
      const result=await terminalRequest('/api/accounts/save',{harness:el('account-harness').value,name:el('account-name').value,config_dir:el('account-folder').value});
      update(result.accounts);render(result.accounts);el('account-name').value='';el('account-folder').value='';help();
      status('Added '+result.saved.label+'.'+(result.saved.exists?'':' That folder does not exist yet; sign in with the command above to create it.'));
    }catch(error){status(error.message,true);}
  };
  populate();
})();
