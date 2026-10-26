'use strict';
const {app, BrowserWindow, Menu, ipcMain, protocol, net, shell, dialog, session, screen, powerMonitor, clipboard} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const toolBridgeProof = require('node:crypto').randomBytes(32).toString('hex');
const {Backend, privateJSON, atomicJSON} = require('./backend.cjs');
const {trustedFrame, assetPath, externalURL, toolCSP, CSP, ORIGIN, MAX_BODY} = require('./security.cjs');
const {applicationRoute, applicationAuthority, forward} = require('./http.cjs');
const {openStream} = require('./streams.cjs');
const {prepareRuntime, managedProcesses} = require('./runtime.cjs');
const {restoreBounds} = require('./window-state.cjs');
const {createProfile, browserWorkspacePort, workspaceChoice, saveWorkspaceChoice} = require('./profile.cjs');
const {configureAbout} = require('./about.cjs');
const {reconnect, retryable} = require('./reconnect.cjs');
protocol.registerSchemesAsPrivileged([
  {scheme: 'agent-desk', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}},
  {scheme: 'agent-tool', privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}},
]);
const windows = new Set(), streams = new Map();
// Popped-out tool windows: webContents ID -> the one agent-tool origin each may load.
const toolWindows = new Map();
let backend, mainWindow, quitting = false, quitPending = false, recovering = null;
let workspaceLoaded = false, fixtureFailed = false;
let paneFullscreen = false;
let retryAllowed = true, quitRequested = false;
let initialConfiguration = null;
const authority = applicationAuthority(windows);
const timings = {launchedAt: Date.now() - Math.round(process.uptime() * 1000)};
function markTiming(key) {if (!timings[key]) {timings[key] = Date.now();atomicJSON(path.join(profile.logs, 'startup-times.json'), timings);}}
let state = {revision: 0, connection: 'preparing', stage: 'preparing', since: Date.now(), paused: false, error: null, fullscreen: false};
const retries = reconnect({attempt: connect, allowed: () => retryAllowed && !quitting && !quitPending && !quitRequested && ['failed', 'disconnected'].includes(state.connection)});
function publish(patch) {state = {...state, ...patch, revision: state.revision + 1};for (const id of windows) {const wc = require('electron').webContents.fromId(id);wc?.send('desk:state', state);} }
app.setName(app.isPackaged ? 'Agent Desk' : 'Agent Desk Dev');
const fixture = !app.isPackaged && process.env.AGENT_DESK_DESKTOP_TEST === '1';
const profile = createProfile(app.getPath('appData'), process.env, app.isPackaged);
const dataRoot = profile.data;
const workspace = workspaceChoice(profile);
app.setPath('userData',profile.browser);
if (!app.requestSingleInstanceLock()) {app.quit();} else {
  app.on('second-instance', () => show());
  app.on('activate', () => show());
  app.on('window-all-closed', () => {});
  app.on('before-quit', event => {if (!quitting) {event.preventDefault();void requestQuit();}});
  app.on('will-quit', () => retries.clear());
  app.whenReady().then(boot).catch(error => {
    dialog.showErrorBox('Agent Desk could not start', error.message);quitting = true;app.quit();
  });
}
function show() {if (!mainWindow) return;if (mainWindow.isMinimized()) mainWindow.restore();mainWindow.show();mainWindow.focus();retries.now();}
function requireFrame(event) {if (!trustedFrame(event, windows)) throw Error('Untrusted desktop caller');}
function updateWindowButtons() {
  if (process.platform === 'darwin' && mainWindow && !mainWindow.isDestroyed()) mainWindow.setWindowButtonVisibility(!paneFullscreen || mainWindow.isFullScreen());
}
async function boot() {
  powerMonitor.on('resume', () => retries.now());
  configureAbout(app, process.resourcesPath, path.join(profile.logs, 'build-info.json'));
  const appSession = session.fromPartition('persist:agent-desk');
  appSession.setPermissionCheckHandler(() => false);
  appSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ipcMain.handle('desk:copy-text', (event, value) => {
    requireFrame(event);
    if (typeof value !== 'string' || value.length > MAX_BODY) throw Error('Invalid clipboard text');
    clipboard.writeText(value);
  });
  appSession.webRequest.onBeforeSendHeaders({urls:['<all_urls>']}, (details, callback) => {
    if (!details.url.startsWith('agent-tool:')) {
      const headers = authority.authorize(details, details.requestHeaders);
      return callback(headers ? {requestHeaders: headers} : {cancel: true});
    }
    const target=new URL(details.url);const origin=target.protocol+'//'+target.host;
    const frame=details.frame;
    const sameTool=details.initiatorOrigin===origin || frame?.url.startsWith(origin+'/');
    const navigation=details.method==='GET' && details.resourceType==='subFrame' && windows.has(details.webContentsId) && (details.initiatorOrigin===ORIGIN || frame?.parent?.url.startsWith(ORIGIN+'/'));
    const popout=details.method==='GET' && details.resourceType==='mainFrame' && toolWindows.get(details.webContentsId)===origin;
    if (!sameTool && !navigation && !popout) return callback({cancel:true});
    callback({requestHeaders:{...details.requestHeaders,'X-Agent-Desk-Tool-Bridge':toolBridgeProof}});
  });
  protocolFor(appSession, app.isPackaged ? path.join(process.resourcesPath, 'shell') : path.resolve(__dirname, '../..'));
  let saved = {};
  try {saved = privateJSON(path.join(dataRoot, 'window.json'));} catch { /* first launch */ }
  mainWindow = new BrowserWindow({...restoreBounds(saved, screen.getAllDisplays()), minWidth: 480, minHeight: 400, show: false,
    // AppKit button frames are 14x16px; y=22 centers them in the 60px header.
    ...(process.platform === 'darwin' ? {titleBarStyle: 'hidden', trafficLightPosition: {x: 14, y: 22}} : {}),
    acceptFirstMouse: true, title: 'Agent Desk', backgroundColor: '#101113',
    webPreferences: {session: appSession, preload: path.join(__dirname, 'preload.cjs'), sandbox: true,
      contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true}});
  registerWindow(mainWindow, true);
  mainWindow.on('focus', () => retries.now());
  mainWindow.on('close', event => {if (!quitting) {event.preventDefault();mainWindow.hide();}});
  const saveBounds = () => {if (!mainWindow.isMinimized() && !mainWindow.isFullScreen()) atomicJSON(path.join(dataRoot, 'window.json'), mainWindow.getNormalBounds());};
  mainWindow.on('resize', saveBounds);mainWindow.on('move', saveBounds);
  screen.on('display-removed', () => mainWindow.setBounds(restoreBounds(mainWindow.getNormalBounds(), screen.getAllDisplays())));
  for (const event of ['enter-full-screen', 'leave-full-screen']) mainWindow.on(event, () => {updateWindowButtons();publish({fullscreen: mainWindow.isFullScreen()});});
  mainWindow.once('ready-to-show', () => {show();markTiming('shellVisibleAt');});
  ipcMain.on('desk:workspace-ready', event => {requireFrame(event);if (state.connection === 'connected') markTiming('workspaceReadyAt');});
  ipcMain.handle('desk:state', event => {requireFrame(event);return state;});
  ipcMain.handle('desk:open-tool', (event, value) => {requireFrame(event);return openTool(value);});
  ipcMain.handle('desk:fullscreen', event => {requireFrame(event);const win = BrowserWindow.fromWebContents(event.sender);win.setFullScreen(!win.isFullScreen());});
  ipcMain.on('desk:pane-fullscreen', (event, active) => {
    requireFrame(event);
    if (event.sender !== mainWindow.webContents || typeof active !== 'boolean') return;
    paneFullscreen = active;updateWindowButtons();
  });
  const menu = Menu.buildFromTemplate([
    {label: 'Agent Desk', submenu: [{role: 'about'}, {label: 'Show Agent Desk', click: show}, {type: 'separator'},
      {label: 'Retry Connection', click: () => void connect()},
      {label: 'Resume Scheduling and Launches', click: () => void resume()},
      {label: 'Finish Previous Shutdown', click: () => void finishShutdown()},
      {label: 'Force Stop Backend…', click: () => void forceBackend()},
      // Source runs load Python changes only in a new backend; terminals stay with the supervisor.
      ...app.isPackaged ? [] : [{label: 'Restart Backend', click: () => void restartBackend()}],
      {label: 'Open Local Diagnostics', click: () => shell.openPath(profile.logs)},
      {type: 'separator'},
      {label: 'Open Browser Workspace…', click: () => void openBrowserWorkspace()},
      {label: 'Use Desktop Workspace', enabled: !!workspace.port, click: () => void switchWorkspace(null, 'Agent Desk will reopen on its own desktop workspace. Terminals in the browser workspace keep running; start the browser app again to use them there.')},
      {label: 'Releases…', click: () => shell.openExternal('https://github.com/dylan-murray/agent-desk/releases')},
      {type: 'separator'}, {label: 'Quit Agent Desk', accelerator: 'CmdOrCtrl+Q', click: () => void requestQuit()}]},
    {label: 'Edit', submenu: [{role: 'undo'}, {role: 'redo'}, {type: 'separator'}, {role: 'cut'}, {role: 'copy'}, {role: 'paste'}, {role: 'selectAll'}]},
    {label: 'View', submenu: [{role: 'reload'}, {role: 'resetZoom'}, {role: 'zoomIn'}, {role: 'zoomOut'}, {role: 'togglefullscreen'}]},
    {role: 'windowMenu'},
  ]);
  Menu.setApplicationMenu(menu);
  if (!app.isPackaged) app.dock?.setIcon(path.join(__dirname, '../resources/agent-desk.png'));
  ipcMain.on('desk:external-link', (event, value) => {if (trustedFrame(event, windows)) {const url=externalURL(value);if (url) void shell.openExternal(url);}});
  ipcMain.on('desk:stream-open', (event, id) => {
    try {
      requireFrame(event);if (typeof id !== 'string' || !/^\d{1,12}$/.test(id)) return;
      if (state.connection !== 'connected') {event.sender.send('desk:stream-denied', id);return;}
      streams.get(event.sender.id)?.close();
      streams.set(event.sender.id, {id, close: openStream(backend, event.senderFrame, id, disconnected)});
    } catch { /* never grant a channel to an untrusted frame */ }
  });
  ipcMain.on('desk:stream-close', (event, id) => {if (trustedFrame(event, windows) && streams.get(event.sender.id)?.id === id) {streams.get(event.sender.id).close();streams.delete(event.sender.id);}});
  ipcMain.handle('desk:recover', async (event, action) => {
    requireFrame(event);
    if (action === 'retry') return connect();
    if (action === 'shutdown') return finishShutdown();
    if (action === 'diagnostics') return shell.openPath(profile.logs);
    if (action === 'force') return forceBackend();
    throw Error('Unknown recovery action');
  });
  await mainWindow.loadURL(ORIGIN + '/startup.html');
  void connect();
}
function jsonResponse(value, status = 200) {return new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});}
function registerWindow(win, workspace) {
  const wc = win.webContents;if (workspace) windows.add(wc.id);
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('will-navigate', event => {if (!event.url.startsWith(ORIGIN + '/')) event.preventDefault();});
  wc.on('will-frame-navigate', event => {if (!event.isMainFrame && event.url.startsWith('agent-desk:')) event.preventDefault();});
  wc.on('will-redirect', event => {if (event.isMainFrame ? !event.url.startsWith(ORIGIN + '/') : event.url.startsWith('agent-desk:')) event.preventDefault();});
  wc.on('did-start-navigation', event => {if (event.isMainFrame && !event.isSameDocument) {
    streams.get(wc.id)?.close();streams.delete(wc.id);
    if (wc === mainWindow?.webContents) {paneFullscreen = false;updateWindowButtons();}
  }});
  wc.on('destroyed', () => {windows.delete(wc.id);streams.get(wc.id)?.close();streams.delete(wc.id);});
  wc.setWindowOpenHandler(({url}) => {
    if (url.startsWith(ORIGIN + '/inbox-document.html?')) {
      const child = new BrowserWindow({width: 1000, height: 800, webPreferences: {session: wc.session, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true}});
      registerWindow(child, true);void child.loadURL(url);
    }

    return {action: 'deny'};
  });
}
async function openTool(value) {
  const url = new URL(typeof value === 'string' ? value : '');
  if (url.protocol !== 'agent-tool:' || !/^t[a-f0-9]{32}$/.test(url.hostname) || url.username || url.password || url.port) throw Error('Not a desktop tool address');
  const origin = 'agent-tool://' + url.hostname;
  if (state.connection !== 'connected') throw Error('Workspace is not connected.');
  const registry = await backend.request({path: '/api/desktop/tools'});
  if (registry.status !== 200 || !JSON.parse(Buffer.from(registry.body, 'base64')).tools.some(tool => tool.url === origin)) throw Error('This tool is no longer running.');
  for (const [id, allowed] of toolWindows) {
    const existing = BrowserWindow.fromWebContents(require('electron').webContents.fromId(id));
    if (allowed === origin && existing) {existing.show();existing.focus();return;}
  }
  // No preload: the tool gets no desk bridge, application authority or native IPC.
  const win = new BrowserWindow({width: 1100, height: 800, minWidth: 480, minHeight: 400, title: 'Agent Desk tool',
    webPreferences: {session: mainWindow.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false, webSecurity: true}});
  const wc = win.webContents;toolWindows.set(wc.id, origin);
  const own = target => target.startsWith(origin + '/');
  wc.on('will-attach-webview', event => event.preventDefault());
  wc.on('will-navigate', event => {if (!own(event.url)) event.preventDefault();});
  wc.on('will-redirect', event => {if (event.isMainFrame ? !own(event.url) : event.url.startsWith('agent-desk:')) event.preventDefault();});
  wc.on('will-frame-navigate', event => {if (!event.isMainFrame && event.url.startsWith('agent-desk:')) event.preventDefault();});
  wc.on('destroyed', () => toolWindows.delete(wc.id));
  wc.setWindowOpenHandler(() => ({action: 'deny'}));
  try {await win.loadURL(url.href);} catch {if (!win.isDestroyed()) win.destroy();throw Error('Could not open the tool.');}
}
function protocolFor(appSession, source) {
  appSession.protocol.handle('agent-desk', async request => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'app' || url.username || url.password || url.port) return new Response('Forbidden', {status: 403});
      if (applicationRoute(url)) {
        if (!authority.accepts(request) || url.pathname.startsWith('/api/desktop/')) return new Response('Forbidden', {status: 403});
        if (state.connection !== 'connected') return jsonResponse({error: 'Workspace is not connected. No action was queued.', code: 'workspace_not_ready'}, 503);
        if (url.pathname === '/config.js' && request.method === 'GET' && initialConfiguration !== null) return new Response(initialConfiguration, {headers: {'content-type': 'application/javascript', 'cache-control': 'no-store'}});
        if (url.pathname === '/api/terminal-auth' && request.method === 'GET') return jsonResponse({token: 'desktop-user', cwd: os.homedir()});
        const revision = state.revision;
        try {return await forward(request, backend);} catch {
          if (request.signal.aborted) return new Response(null, {status: 499});
          if (revision === state.revision) disconnected();
          return jsonResponse({error: 'Backend unavailable. No action was queued or retried.', code: 'backend_unavailable'}, 503);
        }
      }
      if (request.method !== 'GET') return new Response('Forbidden', {status: 403});
      const file = ['startup.html', 'startup.js', 'startup.css'].includes(url.pathname.slice(1)) ? assetPath(path.join(__dirname, '../resources'), request.url) : assetPath(path.join(source, 'agent_desk/static'), request.url);
      const response = await net.fetch(require('node:url').pathToFileURL(file).href);
      const headers = new Headers(response.headers);headers.set('Content-Security-Policy', CSP);headers.set('X-Content-Type-Options', 'nosniff');headers.set('Cache-Control', 'no-store');headers.set('Cross-Origin-Resource-Policy','same-origin');
      return new Response(response.body, {status: response.status, headers});
    } catch {return new Response('Resource unavailable', {status: 404});}
  });
  appSession.protocol.handle('agent-tool', request => toolRequest(request));
}
async function toolRequest(request) {
  try {
    const url = new URL(request.url);
    if (!/^t[a-f0-9]{32}$/.test(url.hostname) || !['GET', 'POST', 'HEAD'].includes(request.method) || url.username || url.password || url.port) throw Error('Invalid tool request');
    if(request.headers.get('X-Agent-Desk-Tool-Bridge')!==toolBridgeProof) throw Error('Untrusted tool initiator');
    const origin = 'agent-tool://' + url.hostname;
    const registry = await backend.request({path: '/api/desktop/tools'});
    if (registry.status !== 200) throw Error('Tool registry unavailable');
    const tools = JSON.parse(Buffer.from(registry.body, 'base64')).tools;
    const tool = tools.find(tool => tool.url === origin);
    if (!tool || path.dirname(tool.socket) !== backend.folder || !fs.lstatSync(tool.socket).isSocket()) throw Error('Unknown tool instance');
    const body = request.method === 'POST' ? Buffer.from(await request.arrayBuffer()) : null;
    if (body?.length > MAX_BODY) throw Error('Tool request too large');
    return await new Promise((resolve, reject) => {
      const headers = {Host: '127.0.0.1:0', Origin: 'http://127.0.0.1:0', Referer: 'http://127.0.0.1:0/', 'Sec-Fetch-Site': 'same-origin'};
      for (const [key, value] of request.headers) if (key !== 'x-agent-desk-tool-bridge' && (key === 'content-type' || key === 'authorization' || key.startsWith('x-'))) headers[key] = value;
      if (body) headers['Content-Length'] = body.length;
      const req = http.request({socketPath: tool.socket, path: url.pathname + url.search, method: request.method, headers, timeout: 30000}, response => {
        const chunks = [];let count = 0;
        response.on('data', chunk => {count += chunk.length;if (count > 16 * MAX_BODY) req.destroy(Error('Tool response too large'));else chunks.push(chunk);});
        response.on('error', reject);
        response.on('end', () => {
          const resultHeaders = new Headers();
          for (const [key, value] of Object.entries(response.headers)) if (value && !['connection', 'transfer-encoding', 'x-frame-options', 'content-security-policy', 'set-cookie', 'location'].includes(key)) resultHeaders.set(key, String(value));
          resultHeaders.set('Content-Security-Policy', toolCSP(response.headers['content-security-policy']));
          if (response.headers.location) {
            const target = new URL(response.headers.location, origin);
            if (target.protocol !== 'agent-tool:' || target.host !== url.host) {resolve(new Response('External redirects are not allowed', {status: 403}));return;}
            resultHeaders.set('Location', target.href);
          }
          resolve(new Response(request.method === 'HEAD' || [204, 304].includes(response.statusCode) ? null : Buffer.concat(chunks), {status: response.statusCode, headers: resultHeaders}));
        });
      });
      req.on('timeout', () => req.destroy(Error('Tool request timed out')));req.on('error', reject);req.end(body);
    });
  } catch {return new Response('Tool unavailable or request refused', {status: 403});}
}
function disconnected() {
  if (state.connection !== 'connected' || quitting || quitPending || quitRequested) return;
  retryAllowed = true;
  publish({connection: 'disconnected', stage: 'opening', since: Date.now(), error: 'Reconnecting to your workspace…'});
  retries.schedule();
}
function connect() {
  if (quitting || quitPending || quitRequested) return Promise.resolve({connected: false});
  if (recovering) return recovering;
  retries.clear();retryAllowed = true;
  recovering = (async () => {
    try {
      publish({connection: 'preparing', stage: backend ? 'opening' : 'preparing', since: Date.now(), error: null});
      if (!backend) {
        const resolved = await prepareRuntime(app, stage => publish({stage, since: Date.now()}));
        if (quitting) return;
        markTiming('runtimeReadyAt');
        if (workspace.port && !fs.existsSync(workspace.data)) {
          const message = `The browser workspace folder ${workspace.data} no longer exists. Choose another with Agent Desk → Open Browser Workspace…, or return to Use Desktop Workspace.`;
          throw Object.assign(Error(message), {retryable: false, userMessage: message});
        }
        backend = new Backend({dataDir: workspace.data, browserPort: workspace.port, logDir: profile.logs, ...resolved});
      }
      if (quitting) return;
      publish({stage: 'opening', since: Date.now()});
      if (fixture && process.env.AGENT_DESK_TEST_DELAY) await new Promise(resolve => setTimeout(resolve, Number(process.env.AGENT_DESK_TEST_DELAY)));
      if (quitting) return;
      const status = await backend.start(() => quitting);
      if (quitting) return;
      markTiming('backendReadyAt');
      // Obtain real configuration before leaving the retryable loading document.
      // Serve that exact snapshot to its blocking script, even if the backend
      // disconnects between readiness and navigation. Later loads proxy normally.
      if (!workspaceLoaded) {
        const response = await backend.request({path: '/config.js'});
        if (response.status !== 200) throw Object.assign(Error('Workspace configuration unavailable'), {retryable: response.status >= 500});
        initialConfiguration = Buffer.from(response.body, 'base64');
        if (fixture && process.env.AGENT_DESK_TEST_FAIL_ONCE === '1' && !fixtureFailed) {fixtureFailed = true;throw Object.assign(Error('Injected configuration failure'), {retryable: true});}
      }
      publish({connection: 'connected', stage: 'restoring', since: Date.now(), paused: !!status.paused, error: null});
      if (!workspaceLoaded && !quitting) {await mainWindow.loadURL(ORIGIN + '/');workspaceLoaded = true;initialConfiguration = null;}
      retries.reset();
      return {connected: true};
    } catch (cause) {
      retryAllowed = !!backend && retryable(cause);
      const error = cause.userMessage || (state.stage === 'setup' || state.stage === 'preparing' ? 'Could not set up Agent Desk. Please try again.' : retryAllowed ? 'Could not connect to your workspace. Retrying automatically…' : 'Could not open your workspace. Please try again.');
      publish({connection: 'failed', error});return {connected: false, error};
    } finally {recovering = null;retries.schedule();}
  })();
  return recovering;
}
async function resume() {
  try {await backend.resume();publish({paused: false});} catch (error) {dialog.showErrorBox('Could not resume', error.message);}
}
// Status from a reachable backend, or null when nothing managed is running.
// A dead backend under surviving owners is restarted so they can be stopped;
// it attaches to them, as crash recovery does. Unknown states never quit.
async function managedBackend() {
  try {return await backend.status();} catch (error) {
    const running = managedProcesses({...profile, data: backend.dataDir});
    if (running.some(item => item.backend)) throw error;
    if (!running.length) return null;
    return backend.start(() => quitting);
  }
}
async function finishShutdown() {
  if (quitPending) return;quitPending = true;
  retryAllowed = false;retries.clear();
  try {if (backend && await managedBackend()) await backend.shutdown();quitting = true;app.quit();}
  catch (error) {dialog.showErrorBox('Previous shutdown is incomplete', error.message);show();}
  finally {quitPending = false;}
}
async function requestQuit() {
  if (quitPending || quitRequested) return;
  quitRequested = true;retries.clear();
  try {
    if (recovering) {quitting = true;await recovering;quitting = false;}
    if (!backend) {quitting = true;app.quit();return;}
    const status = await managedBackend();
    if (status?.active) {
      const activity = status.coordinators;
      const answer = await dialog.showMessageBox(mainWindow, {type: 'question', message: 'Work is still running', detail: `${status.sessions.length} local terminals, ${status.tools.length} tools, ${status.executions.length} jobs, ${status.schedules} enabled schedules. ${activity.planning} coordinators planning, ${activity.queued_turns} queued coordinator turns, ${activity.queued_deliveries} queued deliveries, ${activity.monitors} active PR monitors. Remote work and unrelated processes will remain running.`, buttons: ['Keep Running', 'Stop Work and Quit', 'Cancel'], defaultId: 0, cancelId: 2});
      if (answer.response === 0) {mainWindow.hide();return;}
      if (answer.response !== 1) return;
    }
    await finishShutdown();
  } catch (error) {retryAllowed = false;publish({connection: 'failed', error: 'Could not confirm shutdown. Use the Agent Desk menu to recover.'});show();}
  finally {quitRequested = false;retries.schedule();}
}
// A running browser Agent Desk's data folder, where the folder picker starts.
function runningBrowserData() {
  try {
    const processes = require('node:child_process').execFileSync('/bin/ps', ['-axo', 'command='], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
    const found = [...processes.matchAll(/agent_desk\.terminal_supervisor --data-dir (\S+) --port (\d+)$/gm)].filter(match => fs.existsSync(match[1]));
    return (found.find(match => match[2] === '4310') || found[0])?.[1];
  } catch {return undefined;}
}
async function openBrowserWorkspace() {
  const result = await dialog.showOpenDialog(mainWindow, {title: 'Open Browser Workspace', message: 'Choose the data folder of the browser Agent Desk', buttonLabel: 'Open', defaultPath: runningBrowserData() || os.homedir(), properties: ['openDirectory']});
  if (result.canceled || !result.filePaths[0]) return;
  try {
    const folder = fs.realpathSync(result.filePaths[0]);
    if (folder === fs.realpathSync(profile.data)) return switchWorkspace(null, 'Agent Desk will reopen on its own desktop workspace.');
    const port = browserWorkspacePort(folder);
    const info = fs.statSync(folder);
    if (info.uid !== process.getuid()) throw Error('This folder belongs to another user.');
    if (info.mode & 0o077) {
      const answer = await dialog.showMessageBox(mainWindow, {type: 'question', message: 'Make this folder private?', detail: `The desktop app only opens workspaces that other users cannot read, so ${folder} will become readable by you alone (chmod 700). The browser app keeps working.`, buttons: ['Make Private', 'Cancel'], defaultId: 0, cancelId: 1});
      if (answer.response !== 0) return;
      fs.chmodSync(folder, 0o700);
    }
    return switchWorkspace({data: folder, port}, `Agent Desk will reopen on the browser workspace in ${folder}, with its sessions, desks and coordinators. Its running terminals carry over. If the browser app is still running on port ${port}, stop it and the window connects on its own.`);
  } catch (error) {dialog.showErrorBox('Could not open this workspace', error.message);}
}
// Switching stops only this backend, as Restart Backend does; terminals stay with their supervisor.
async function switchWorkspace(choice, detail) {
  try {
    if (quitting || quitPending || quitRequested) return;
    const answer = await dialog.showMessageBox(mainWindow, {type: 'question', message: 'Reopen Agent Desk?', detail, buttons: ['Reopen', 'Cancel'], defaultId: 0, cancelId: 1});
    if (answer.response !== 0) return;
    retryAllowed = false;retries.clear();
    if (recovering) await recovering;
    if (backend) await stopBackendProcess();
    saveWorkspaceChoice(profile, choice);
    quitting = true;app.relaunch();app.quit();
  } catch (error) {retryAllowed = true;retries.schedule();dialog.showErrorBox('Could not switch workspaces', error.message);}
}
async function stopBackendProcess() {
  let pid;
  try {pid = verifiedBackendPid();} catch (error) {if (error.code === 'ENOENT') return;throw error;}
  process.kill(pid, 'SIGTERM');
  const deadline = Date.now() + 15000;
  for (;;) {
    try {process.kill(pid, 0);} catch (error) {if (error.code === 'ESRCH') return;throw error;}
    if (Date.now() > deadline) throw Error('The backend has not exited. Use Force Stop Backend… if it is unresponsive.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}
function verifiedBackendPid() {
  backend.loadRecord();
  const {execFileSync} = require('node:child_process');
  const record = backend.record;
  const command = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'command='], {encoding: 'utf8'}).trim();
  const birth = execFileSync('/bin/ps', ['-p', String(record.pid), '-o', 'lstart='], {encoding: 'utf8'}).trim();
  if (!record.process_start || birth !== record.process_start || !command.includes('-m agent_desk.desktop_backend --workspace-id ' + backend.workspace)) throw Error('Process identity could not be verified. No process was signalled.');
  return record.pid;
}
async function restartBackend() {
  try {
    if (!backend || quitting || quitPending || quitRequested) return;
    await stopBackendProcess();
    disconnected();return connect();
  } catch (error) {dialog.showErrorBox('Could not restart the backend', error.message);}
}
async function forceBackend() {
  try {
    const pid = verifiedBackendPid();
    const answer = await dialog.showMessageBox(mainWindow, {type: 'warning', message: 'Force stop the unresponsive backend?', detail: 'Its terminal supervisor and agents will remain running. In-flight backend operations may be interrupted. Reconnect afterward to recover the workspace.', buttons: ['Cancel', 'Force Stop Backend'], defaultId: 0, cancelId: 0});
    if (answer.response === 1) {process.kill(pid, 'SIGKILL');disconnected();return {stopped: true};}
  } catch (error) {dialog.showErrorBox('Could not force stop', error.message);}
}
