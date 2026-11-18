// The page side of a dock plugin. The page runs sandboxed with no network, so everything it does in
// the pane goes through this channel, and the desk answers only what the plugin's manifest allows.
//   AgentDesk.call('files.list').then(({files})=>...)
//   AgentDesk.on('button',({id,pressed})=>...)
(()=>{
  let port=null,next=1;
  const waiting=new Map(),handlers=new Map();
  const ready=new Promise(resolve=>addEventListener('message',event=>{
    // The desk hands over one end of a channel when the page loads; nothing else is listened to.
    if(event.source!==parent||event.data?.agentDesk!=='connect'||!event.ports?.[0]||port)return;
    port=event.ports[0];
    port.onmessage=({data})=>{
      if(data?.event){(handlers.get(data.event)||[]).forEach(handler=>handler(data.detail||{}));return;}
      const call=waiting.get(data?.id);if(!call)return;
      waiting.delete(data.id);data.error?call.reject(Error(data.error)):call.resolve(data.result);
    };
    resolve();
  }));
  window.AgentDesk=Object.freeze({
    ready,
    call:async(method,params={})=>{await ready;return new Promise((resolve,reject)=>{const id=next++;waiting.set(id,{resolve,reject});port.postMessage({id,method,params});});},
    on:(name,handler)=>{handlers.set(name,[...(handlers.get(name)||[]),handler]);}
  });
})();
