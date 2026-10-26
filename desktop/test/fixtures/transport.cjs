const {app, BrowserWindow, protocol, session} = require('electron');
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const {applicationAuthority, applicationRoute, forward} = require('../../src/http.cjs');
protocol.registerSchemesAsPrivileged(['agent-desk','agent-tool'].map(scheme=>({scheme,privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}})));
app.setPath('userData', path.join(process.env.AGENT_DESK_TRANSPORT_FIXTURE, 'browser'));
const socket = path.join(process.env.AGENT_DESK_TRANSPORT_FIXTURE, 'echo.sock');
const cancelled = new Set();
const backend = {socket, record:{user_token:'main-process-secret'}};
global.transportRequests = [];
const server = http.createServer((req,res)=>{
  global.transportRequests.push({method:req.method,path:req.url});
  const url = new URL(req.url, 'http://fixture');
  if(url.pathname==='/api/cancelled'){res.end(JSON.stringify([...cancelled]));return;}
  if(url.pathname==='/api/slow') {req.on('close',()=>cancelled.add(url.searchParams.get('id')));return;}
  if(url.pathname==='/api/stream') {
    res.writeHead(200,{'content-type':'text/plain'});res.write('first\n');
    const timer=setTimeout(()=>res.end('last\n'),1500);
    res.on('close',()=>{clearTimeout(timer);cancelled.add(url.searchParams.get('id'));});return;
  }
  if(url.pathname==='/api/redirect'){res.writeHead(302,{location:url.searchParams.get('to')});res.end();return;}
  if(url.pathname==='/config.js'){res.end('window.AGENT_DESK_CONFIG={development:false,accounts:[{id:"fixture"}]};');return;}
  const chunks=[];req.on('data',chunk=>chunks.push(chunk));req.on('end',()=>{
    res.writeHead(Number(url.searchParams.get('status')||200),{'content-type':'application/json','x-fixture':'response'});
    res.end(JSON.stringify({method:req.method,url:req.url,headers:req.headers,body:Buffer.concat(chunks).toString('base64')}));
  });
});
app.whenReady().then(async()=>{
  await new Promise(resolve=>server.listen(socket,resolve));
  const windows=new Set(),authority=applicationAuthority(windows);
  session.defaultSession.webRequest.onBeforeSendHeaders((details,callback)=>{
    const headers=authority.authorize(details,details.requestHeaders);
    callback(headers?{requestHeaders:headers}:{cancel:true});
  });
  protocol.handle('agent-desk',request=>{
    if(applicationRoute(new URL(request.url)))return authority.accepts(request)?forward(request,backend):new Response('Forbidden',{status:403});
    return new Response('<!doctype html><title>Transport fixture</title><script src="/config.js"></script><iframe src="agent-tool://t'+ 'a'.repeat(32) +'/"></iframe>',{headers:{'content-type':'text/html'}});
  });
  protocol.handle('agent-tool',()=>new Response('<!doctype html><title>Untrusted tool</title>',{headers:{'content-type':'text/html'}}));
  const win=new BrowserWindow({show:false,webPreferences:{preload:path.resolve(__dirname,'../../src/preload.cjs'),sandbox:true,contextIsolation:true,nodeIntegration:false}});
  windows.add(win.webContents.id);
  await win.loadURL('agent-desk://app/');win.show();
});
app.on('will-quit',()=>server.close());
