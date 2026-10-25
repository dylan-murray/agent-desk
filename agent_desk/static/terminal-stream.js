// One WebSocket per tab carries every local pane's output, input and resizes (agent_desk/terminal_stream.py).
// Remote panes, and backends without the endpoint, keep polling /api/terminals/output.
const terminalStream=(()=>{
  let supported=null,probing=null,socket=null,open=false,attempts=0,retryTimer=null,serial=0;
  const subscriptions=new Map();  // sub -> {id,cursor,deliver}
  // A plain GET answers 426 where the endpoint exists. Anything else, including a test
  // fixture that answers every API route, means this backend only offers polling.
  function probe(){
    if(supported!==null||probing)return probing;
    probing=(async()=>{
      try{await terminalAuthToken();const response=await fetch('/api/terminals/stream',{headers:{'X-Agent-Desk-Terminal':terminalAuth}});supported=response.status===426;}
      catch{setTimeout(()=>{probing=null;},3000);return;}
      probing=null;
    })();
    return probing;
  }
  function usable(id){if(new URLSearchParams(location.search).has('poll'))return false;if(supported===null)probe();return supported===true&&!String(id).startsWith('remote:');}
  function post(message){if(!open)return false;socket.send(JSON.stringify(message));return true;}
  function request(entry){
    // A fresh key per request, so a late reply to an abandoned subscription is ignored.
    for(const [key,value] of subscriptions)if(value===entry)subscriptions.delete(key);
    const sub=String(++serial);subscriptions.set(sub,entry);
    post({type:'subscribe',sub,id:entry.id,cursor:entry.cursor});
  }
  function connect(){
    if(socket||!subscriptions.size)return;
    clearTimeout(retryTimer);retryTimer=null;
    const ws=(globalThis.deskTransport?.socket || (url => new WebSocket(url)))(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/api/terminals/stream`);socket=ws;
    ws.onopen=async()=>{
      try{await terminalAuthToken();}catch{ws.close();return;}
      if(socket!==ws)return;
      ws.send(JSON.stringify({type:'auth',token:terminalAuth}));open=true;
      for(const entry of new Set(subscriptions.values()))request(entry);
    };
    ws.onmessage=event=>{
      let message;try{message=JSON.parse(event.data);}catch{return;}
      attempts=0;
      const entry=message.sub?subscriptions.get(message.sub):null;
      if(entry){
        if(message.type==='output'||message.type==='exit')entry.cursor=message.cursor;
        if(message.type==='exit')subscriptions.delete(message.sub);
        if(message.type==='error'){subscriptions.delete(message.sub);setTimeout(()=>{if(!entry.closed){subscriptions.set('retry-'+(++serial),entry);if(open)request(entry);else connect();}},Math.min(3000,500*(entry.errors=(entry.errors||0)+1)));}
        else entry.errors=0;
        entry.deliver({...message,attempts:entry.errors});
      }else if(message.type==='error'&&message.id&&!message.sub){
        for(const value of subscriptions.values())if(value.id===message.id)value.deliver({type:'input-error',message:message.message});
      }
    };
    ws.onclose=event=>{
      if(socket!==ws)return;
      socket=null;open=false;attempts++;
      // The backend issues a new token each run; fetch it again before reconnecting.
      if(event.code===1008)terminalAuth=null;
      for(const entry of new Set(subscriptions.values()))entry.deliver({type:'disconnected',attempts});
      if(subscriptions.size)retryTimer=setTimeout(connect,Math.min(3000,500*attempts));
    };
  }
  function subscribe(id,cursor,deliver){
    const entry={id,cursor,deliver,closed:false};
    subscriptions.set('pending-'+(++serial),entry);
    if(open)request(entry);else connect();
    return {
      close(){
        entry.closed=true;
        for(const [sub,value] of subscriptions)if(value===entry){subscriptions.delete(sub);post({type:'unsubscribe',sub});}
      },
    };
  }
  // Settles once the backend has said whether it streams, or could not be reached.
  const ready=()=>probe()||Promise.resolve();
  return {ready,usable,subscribe,send:post};
})();
