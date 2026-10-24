// Keep harness identity separate from the executable, alias, or wrapper used to launch it.
const launchChoices={
  shell:{harness:'shell',label:'Shell'},
  grok:{harness:'grok',label:'Grok',command:'grok',mode:'direct'},
  opencode:{harness:'opencode',label:'OpenCode',command:'opencode',mode:'direct'},
  pi:{harness:'pi',label:'Pi',command:'pi',mode:'direct'},
  cortex:{harness:'cortex',label:'Cortex Code',command:'cortex',mode:'direct'},
  custom:{harness:'custom',label:'Custom',command:'',mode:'direct'}
};
// Claude and Codex logins. The command names the account; Agent Desk runs its CLI with that account's config folder.
let launchAccounts=[];
function applyAccounts(accounts){
  for(const key of Object.keys(launchChoices))if(launchChoices[key].account)delete launchChoices[key];
  launchAccounts=accounts;
  for(const account of accounts)launchChoices[account.id]={harness:account.harness,label:account.label,command:account.id,mode:'/bin/zsh',account:true};
}
applyAccounts((typeof window!=='undefined'&&window.AGENT_DESK_CONFIG?.accounts)||[{id:'codex',harness:'codex',name:'',label:'Codex'},{id:'claude',harness:'claude',name:'',label:'Claude'}]);
const accountLabels=()=>({...Object.fromEntries(launchAccounts.map(account=>[account.id,account.label])),grok:'Grok',opencode:'OpenCode',pi:'Pi',cortex:'Cortex Code'});
function buildTerminalCommand(command,mode,args){
  if(!command||/[\x00-\x1f\x7f]/.test(command))throw Error('Enter an executable path or a command name');
  if(mode==='direct')return [command,...args];
  if(!['/bin/zsh','/bin/bash'].includes(mode))throw Error('Choose a supported shell');
  // A bare word is necessary for shell alias expansion. Paths are quoted literally.
  let word;
  if(/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(command))word=command;
  else if(command.startsWith('/'))word="'"+command.replace(/'/g,"'\\''")+"'";
  else throw Error('Use a single command name, such as codex, or an absolute path. Put arguments below.');
  // Positional parameters preserve spaces, quotes, and shell syntax inside arguments.
  return [mode,'-lic',word+' "$@"','agent-desk',...args];
}
if(typeof module!=='undefined')module.exports={launchChoices,buildTerminalCommand,applyAccounts};
