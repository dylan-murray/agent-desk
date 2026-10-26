// Remote connections require a successful, selection-bound backend test.
document.addEventListener('DOMContentLoaded',()=>{
  const el=id=>document.getElementById(id),dialog=el('ssh-dialog');
  let ticket=null,busy=false,sshReady=false,expires=0;
  const selection=()=>({transport:'ssh',host:el('ssh-host').value.trim(),user:el('ssh-user').value.trim(),port:Number(el('ssh-port').value),identity_file:el('ssh-identity').value.trim()});
  const name=c=>c.host;
  function invalidate(){ticket=null;clearTimeout(expires);el('ssh-connect').disabled=true;}
  function status(message){el('ssh-status').textContent=message;}
  function controls(value){
    busy=value;
    for(const id of ['ssh-test','ssh-saved','ssh-mode','ssh-host','ssh-user','ssh-port','ssh-identity'])el(id).disabled=value;
    el('ssh-test').disabled=value||!sshReady||!el('ssh-host').value.trim();
    el('ssh-connect').disabled=value||!ticket;
  }
  let connections=[];
  function savedOptions(){const chosen=el('ssh-saved').value;el('ssh-saved').replaceChildren(new Option(connections.length?'Choose a saved connection':'No saved connections yet',''));
    for(const c of connections)el('ssh-saved').add(new Option(c.label+' · '+c.host,c.id));
    el('ssh-saved').value=connections.some(c=>c.id===chosen)?chosen:'';el('ssh-forget').hidden=!el('ssh-saved').value;}
  async function loadConnections(){
    try{connections=(await terminalRequest('/api/remote/connections',{})).connections||[];}catch{connections=[];}
    savedOptions();}
  async function save(config,label){connections=(await terminalRequest('/api/remote/connections/save',{...config,label:label||name(config)})).connections;savedOptions();}
  async function prerequisites(){
    controls(true);status('Checking for OpenSSH…');
    try{const result=await terminalRequest('/api/remote/prerequisites',{});sshReady=!!result.tools.ssh;status(sshReady?'SSH ready. Enter a host or choose a saved connection.':'OpenSSH is missing.');}
    catch(e){sshReady=false;status(e.message);}finally{controls(false);}
  }
  function modeHelp(){
    const runtime=el('ssh-mode').value==='environment';
    el('ssh-mode-help').textContent=runtime?'Run the coordinator and workers on this machine using the harnesses and credentials configured there.':'Open an interactive SSH shell.';
    el('ssh-test-help').textContent=runtime?'Requires SSH keys, Python 3.11+, Node and an agent CLI. Installs a small runtime remotely; credentials stay there.':'Test uses your SSH keys and checks the remote shell. New host keys are saved; changed keys are rejected.';
  }
  function open(mode){el('launch-terminal-dialog').close();el('ssh-mode').value=mode;modeHelp();invalidate();loadConnections();dialog.showModal();dialog.scrollTop=0;prerequisites();}
  el('open-ssh').onclick=()=>open('shell');
  window.connectRemoteEnvironment=()=>open('environment');
  el('ssh-mode').onchange=()=>{invalidate();modeHelp();status('Test this connection before continuing.');controls(false);};
  el('ssh-close').onclick=()=>dialog.close();
  for(const id of ['ssh-host','ssh-user','ssh-port','ssh-identity'])el(id).addEventListener('input',()=>{invalidate();status('Selection changed. Test this connection before continuing.');controls(false);});
  el('ssh-saved').onchange=()=>{el('ssh-forget').hidden=!el('ssh-saved').value;if(!el('ssh-saved').value)return;const c=connections.find(x=>x.id===el('ssh-saved').value);if(!c)return;el('ssh-label').value=c.label;invalidate();el('ssh-host').value=c.host;el('ssh-user').value=c.user||'';el('ssh-port').value=c.port||22;el('ssh-identity').value=c.identity_file||'';status('Saved connection selected. Test before reconnecting.');controls(false);};
  el('ssh-test').onclick=async()=>{invalidate();controls(true);status('Testing SSH…');try{const result=await terminalRequest(el('ssh-mode').value==='environment'?'/api/remote/test-environment':'/api/remote/test',selection());ticket=result.ticket;status(result.message);expires=setTimeout(()=>{invalidate();status('Connection test expired. Test again before connecting.');},result.expires_in*1000);}catch(e){status(e.message);}finally{controls(false);}};
  el('ssh-connect').onclick=async()=>{if(!ticket||busy)return;const config=selection(),tested=ticket;invalidate();controls(true);status(el('ssh-mode').value==='environment'?'Preparing the remote coordinator environment…':'Opening remote terminal…');try{
    if(el('ssh-mode').value==='environment'){
      const node=await terminalRequest('/api/remote/attach',{...config,ticket:tested});
      dialog.close();save(config,el('ssh-label').value.trim()).catch(e=>toast('Connected, but saving failed: '+e.message));await refresh();await window.openRemoteCoordinator(node);return;
    }
    const session=await terminalRequest('/api/remote/connect',{...config,ticket:tested,desk:activeDesk().id});save(config,el('ssh-label').value.trim()).catch(e=>toast('Connected, but saving failed: '+e.message));freshTerminalIds.add(session.id);demo=false;paneMode=paneStoreKey();agents.unshift({...session,project:'Remote SSH'});openPaneBeside(session.id);selectedId=session.id;savePanes();dialog.close();switchPage('agents');render();paneViews.get(session.id)?.node.scrollIntoView({block:'nearest'});}catch(e){status(e.message+' Test again before retrying.');}finally{controls(false);}};

  el('ssh-save').onclick=async()=>{
    const label=el('ssh-label').value.trim();
    try{await save(selection(),label||undefined);status('Saved. It is in Saved connections for next time.');}
    catch(error){status(error.message);}
  };
  el('ssh-forget').onclick=async()=>{
    const chosen=el('ssh-saved').value;if(!chosen)return;
    try{connections=(await terminalRequest('/api/remote/connections/delete',{id:chosen})).connections;el('ssh-saved').value='';savedOptions();status('Removed that saved connection.');}
    catch(error){status(error.message);}
  };
});
