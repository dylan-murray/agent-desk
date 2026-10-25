'use strict';
const {contextBridge, ipcRenderer} = require('electron');
let serial = 0;
const streams = new Map();
ipcRenderer.on('desk:stream-denied', (_event, id) => {streams.get(id)?.callback({type: 'close', code: 1006});streams.delete(id);});
ipcRenderer.on('desk:stream-port', (event, id) => {
  const stream = streams.get(id);const port = event.ports[0];
  if (!stream || !port) {port?.close();return;}
  stream.port = port;
  port.onmessage = event => {
    stream.callback(event.data);
    if (event.data.seq) port.postMessage({ack: event.data.seq});
  };
  port.start();
});
contextBridge.exposeInMainWorld('agentDeskDesktop', {
  platform: process.platform,
  workspaceReady: () => ipcRenderer.send('desk:workspace-ready'),
  snapshot: () => ipcRenderer.invoke('desk:state'),
  toggleFullscreen: () => ipcRenderer.invoke('desk:fullscreen'),
  copyText: text => ipcRenderer.invoke('desk:copy-text', text),
  subscribe: callback => {const listener = (_event, state) => callback(state);ipcRenderer.on('desk:state', listener);return () => ipcRenderer.removeListener('desk:state', listener);},
  recover: action => ipcRenderer.invoke('desk:recover', action),
  stream: callback => {
    const id = String(++serial);const stream = {callback, port: null};streams.set(id, stream);
    ipcRenderer.send('desk:stream-open', id);
    return {
      send: message => stream.port?.postMessage({message}),
      close: () => {stream.port?.close();streams.delete(id);ipcRenderer.send('desk:stream-close', id);},
    };
  },
});

// Only real clicks in the workspace main document may open the system browser.
document.addEventListener('click', event => {
  const link = event.target.closest?.('a[href]');
  if (!event.isTrusted || event.button !== 0 || !link || !/^https?:/.test(link.href)) return;
  event.preventDefault();ipcRenderer.send('desk:external-link', link.href);
}, true);
