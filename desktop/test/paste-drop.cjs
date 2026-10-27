'use strict';
// Real Electron bridge, native Paste, xterm and raw fixture PTYs; no agent services.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {Backend} = require('../src/backend.cjs');
const {quotePath} = require('../../agent_desk/static/terminal-files.js');
const root = path.resolve(__dirname, '../..'), base = fs.mkdtempSync('/private/tmp/ad-paste-');
const profile = path.join(base, 'profile'), imageFolder = path.join(profile, 'data/pasted-images');
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENT_DESK_')));
const evidence = process.env.AGENT_DESK_EVIDENCE_DIR || os.tmpdir();fs.mkdirSync(evidence, {recursive: true});
const python = process.env.AGENT_DESK_PYTHON || execFileSync('which', ['python3'], {encoding: 'utf8'}).trim();
const env = {...cleanEnv, AGENT_DESK_PYTHON: python, AGENT_DESK_DESKTOP_TEST: '1', AGENT_DESK_PROFILE_DIR: profile, AGENT_DESK_SOCKET_ROOT: path.join(base, 's')};
let electron, page, manager;
const errors = [];
const sleep = () => new Promise(resolve => setTimeout(resolve, 25));
async function until(check, message) {for (let i = 0; i < 200; i++) {if (await check()) return;await sleep();}throw Error(message);}
const images = () => fs.existsSync(imageFolder) ? fs.readdirSync(imageFolder).filter(name => name.endsWith('.png')).sort() : [];
const input = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
const wrapped = value => '\x1b[200~' + value + '\x1b[201~';
async function open() {
  electron = await _electron.launch({executablePath: require('../node_modules/electron'), args: [path.join(root, 'desktop')], env});
  await electron.evaluate(({app}) => process.prependListener('uncaughtException', error => {console.error(error.stack);app.exit(1);}));
  page = await electron.firstWindow();page.setDefaultTimeout(10000);page.on('pageerror', error => errors.push(error.message));
  await page.waitForFunction(() => document.querySelector('#sync-status')?.textContent.includes('Connected'));
  await page.waitForLoadState('load');
  manager = new Backend({dataDir: path.join(profile, 'data'), source: root, python, node: process.execPath, env});manager.loadRecord();
}
async function quit() {
  await electron.evaluate(({dialog}) => {
    dialog.showMessageBox = async () => ({response: 1});
    dialog.showErrorBox = (title, detail) => {console.error(title + ': ' + detail);};
  });
  const stopped = new Promise(resolve => electron.process().once('exit', resolve));
  await electron.evaluate(({Menu}) => Menu.getApplicationMenu().items[0].submenu.items.find(item => item.label === 'Quit Agent Desk').click());
  let timeout;
  try {await Promise.race([stopped, new Promise((_, reject) => {timeout = setTimeout(() => reject(Error('Fixture app did not quit')), 30000);})]);}
  finally {clearTimeout(timeout);}
}
async function launch(name) {
  const capture = path.join(base, name + '.input');
  const terminal = await page.evaluate(({cwd, argv, name}) => terminalRequest('/api/terminals/launch', {cwd, argv, name}),
    {cwd: base, argv: [python, path.join(root, 'tests/fixtures/desktop/input.py'), capture], name});
  await page.evaluate(async id => {await refresh();selectPane(id, true);}, terminal.id);
  await page.waitForFunction(id => {const v = paneViews.get(id);return v?.term?.modes.bracketedPasteMode && !v.restoring;}, terminal.id);
  return {id: terminal.id, capture};
}
async function focus(id) {
  await page.bringToFront();
  await electron.evaluate(({app, BrowserWindow}) => {app.focus({steal: true});BrowserWindow.getAllWindows()[0].focus();});
  await page.evaluate(id => paneViews.get(id).term.focus(), id);
}
async function paste(id, {bytes, text = '', type = 'image/png'} = {}) {
  return page.evaluate(({id, bytes, text, type}) => {
    const dt = new DataTransfer();if (text) dt.setData('text/plain', text);
    if (bytes) dt.items.add(new File([new Uint8Array(bytes)], 'clipboard.png', {type}));
    const event = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true});
    paneViews.get(id).term.textarea.dispatchEvent(event);return event.defaultPrevented;
  }, {id, bytes, text, type});
}
async function drag(id, type = 'drop', pathless = null) {
  return page.evaluate(({id, type, pathless}) => {
    const dt = new DataTransfer();
    if (pathless) dt.items.add(new File([new Uint8Array(pathless)], 'capture.png', {type: 'image/png'}));
    else for (const file of document.getElementById('drop-fixture')?.files || []) dt.items.add(file);
    const event = new DragEvent(type, {dataTransfer: dt, bubbles: true, cancelable: true});
    paneViews.get(id).term.textarea.dispatchEvent(event);return event.defaultPrevented;
  }, {id, type, pathless});
}
async function files(paths) {
  await page.evaluate(() => {if (!document.getElementById('drop-fixture')) {const input = document.createElement('input');input.type = 'file';input.multiple = true;input.id = 'drop-fixture';input.hidden = true;document.body.append(input);}});
  await page.locator('#drop-fixture').setInputFiles(paths);
}
async function delayImage() {
  await page.evaluate(() => {
    window.readImageNormally = File.prototype.arrayBuffer;
    File.prototype.arrayBuffer = async function() {await new Promise(resolve => window.releaseImage = resolve);return window.readImageNormally.call(this);};
  });
}
async function releaseImage() {await page.evaluate(() => {File.prototype.arrayBuffer = window.readImageNormally;window.releaseImage();});}
// Keep output streaming, but hold the first HTTP input response to block later sends.
async function holdInput(id) {
  await page.evaluate(id => {
    const view = paneViews.get(id), request = terminalRequest, send = terminalStream.send;
    const paste = view.term.paste.bind(view.term);let first = true;
    view.term.paste = text => {view.observedFilePaste = text;return paste(text);};
    terminalStream.send = message => message.type === 'input' && message.id === id ? false : send(message);
    window.releasePaste = null;
    terminalRequest = async (url, body) => {
      const response = await request(url, body);
      if (url === '/api/terminals/input' && body.id === id && first) {
        first = false;
        await new Promise(resolve => {window.releasePaste = async () => {
          resolve();await view.queue;terminalRequest = request;terminalStream.send = send;
        };});
      }
      return response;
    };
  }, id);
}
(async () => {
  await open();
  const a = await launch('Prompt A'), b = await launch('Prompt B');
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');canvas.width = 24;canvas.height = 16;
    const context = canvas.getContext('2d');context.fillStyle = '#9ccaff';context.fillRect(0, 0, 24, 16);
    return Array.from(new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))).arrayBuffer()));
  });
  assert.deepEqual(await electron.evaluate(({nativeImage}, png) => nativeImage.createFromBuffer(Buffer.from(png)).getSize(), png), {width: 24, height: 16});
  const status = id => page.locator(`[data-pane-id="${id}"] .pane-connection`);
  // Normal and long text still use xterm's native paste path and bracket framing.
  let expected = '';
  for (const text of ['unsent draft ', 'long text\n'.repeat(6000), ' ']) {
    await paste(a.id, {text});expected += wrapped(text.replace(/\n/g, '\r'));
    await until(() => input(a.capture) === expected, 'Text paste changed or lost bytes');
  }
  // Hold the first HTTP input response so hiding the pane happens mid-paste.
  for (const width of [1280, 480]) {
    await electron.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width);
    const hidden = await launch('Hidden paste ' + width), text = 'hidden long text\n'.repeat(3000);
    await page.evaluate(id => {
      const view = paneViews.get(id);view.subscription?.close();view.subscription = null;
      const original = terminalRequest;let first = true;
      window.releasePaste = null;
      terminalRequest = async (url, body) => {
        const response = await original(url, body);
        if (url === '/api/terminals/input' && body.id === id && first) {
          first = false;
          await new Promise(resolve => {window.releasePaste = () => {terminalRequest = original;resolve();};});
        }
        return response;
      };
    }, hidden.id);
    await paste(hidden.id, {text});
    await page.waitForFunction(() => typeof window.releasePaste === 'function');
    assert.equal(input(hidden.capture).length, 16384);
    await page.evaluate(id => {closePane(id);window.releasePaste();}, hidden.id);
    await until(() => input(hidden.capture) === wrapped(text.replace(/\n/g, '\r')), 'Hiding a pane truncated its long paste');
    assert.equal(input(b.capture), '');
    await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), hidden.id);
  }
  await electron.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].setSize(1280, 800));
  console.log('PASS: hiding a pane during a long HTTP paste preserves all bytes and the closing paste marker at 1280/480px');
  await focus(a.id);await page.keyboard.press('Control+v');expected += '\x16';
  await page.keyboard.press('Shift+Enter');expected += '\x1b\r';
  await until(() => input(a.capture) === expected, 'Ctrl+V or Shift+Enter changed');
  // A File from Chromium's actual filesystem chooser resolves via sandboxed webUtils.
  const originals = [path.join(base, 'a file.png'), path.join(base, "quote'猫.txt")];
  originals.forEach(file => fs.writeFileSync(file, 'original fixture contents'));
  await files(originals);await focus(b.id);await drag(a.id);
  expected += wrapped(originals.map(quotePath).join(' ') + ' ');
  await until(() => input(a.capture) === expected, 'Dropped files went to the wrong pane or changed paths');
  assert.equal(input(b.capture), '');assert.deepEqual(images(), []);
  originals.forEach(file => assert.equal(fs.readFileSync(file, 'utf8'), 'original fixture contents'));
  const order = await page.evaluate(() => [...openPaneIds]);
  const grip = await page.locator(`[data-pane-id="${a.id}"] .pane-grip`).boundingBox();
  const destination = await page.locator(`[data-pane-id="${b.id}"]`).boundingBox();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);await page.mouse.down();
  await page.mouse.move(grip.x + 35, grip.y + grip.height / 2, {steps: 5});
  await page.mouse.move(destination.x + destination.width / 2, destination.y + destination.height / 2, {steps: 12});await page.mouse.up();
  await until(async () => JSON.stringify(await page.evaluate(() => [...openPaneIds])) === JSON.stringify(order.slice().reverse()), 'File handlers interfered with pane-header dragging');
  console.log('PASS: real filesystem paths, quotes/Unicode, original draft, bracketed paste, long text, Ctrl+V, Shift+Enter and original target');
  // Nonempty text beats an accompanying screenshot.
  await paste(a.id, {text: 'text wins', bytes: png});expected += wrapped('text wins');
  await until(() => input(a.capture) === expected, 'Mixed text/image paste was intercepted');assert.deepEqual(images(), []);
  // Native system Paste: use it when the host pasteboard supports round trips.
  const nativeClipboard = await electron.evaluate(async ({clipboard, ClipboardItem}, png) => {
    await clipboard.write([new ClipboardItem({'image/png': new Blob([new Uint8Array(png)], {type: 'image/png'})})]);
    return clipboard.has('image/png');
  }, png);
  if (nativeClipboard) {
    await focus(a.id);await page.keyboard.press('Meta+v');
    await until(() => images().length === 1, 'Cmd+V did not save the screenshot');
    expected += wrapped(quotePath(path.join(imageFolder, images()[0])) + ' ');
    await until(() => input(a.capture) === expected, 'Cmd+V did not insert exactly one quoted path');
    const before = images();
    await electron.evaluate(({Menu}) => {
      const assertPaste = Menu.getApplicationMenu().items.find(item => item.label === 'Edit').submenu.items.some(item => item.role === 'paste');
      if (!assertPaste) throw Error('Edit → Paste role missing');
      Menu.sendActionToFirstResponder('paste:');
    });
    await until(() => images().length === 2, 'Edit → Paste did not save the screenshot');
    expected += wrapped(quotePath(path.join(imageFolder, images().find(name => !before.includes(name)))) + ' ');
    await until(() => input(a.capture) === expected, 'Edit → Paste did not insert exactly one path');
    console.log('PASS: actual Cmd+V and Edit → Paste from native image clipboard');
  } else {
    console.log('UNVERIFIED: host system pasteboard cannot round-trip images; exercising DOM paste events through the real bridge instead');
    await paste(a.id, {bytes: png});await until(() => images().length === 1, 'Image paste did not save');
    expected += wrapped(quotePath(path.join(imageFolder, images()[0])) + ' ');
    await until(() => input(a.capture) === expected, 'Image paste did not insert exactly one path');
  }
  // Decode and normalize in the real Electron process, including a JPEG input.
  const jpeg = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');canvas.width = 24;canvas.height = 16;
    const context = canvas.getContext('2d');context.fillStyle = '#9ccaff';context.fillRect(0, 0, 24, 16);
    return Array.from(new Uint8Array(await (await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg'))).arrayBuffer()));
  });
  assert.deepEqual(await electron.evaluate(({nativeImage}, jpeg) => nativeImage.createFromBuffer(Buffer.from(jpeg)).getSize(), jpeg), {width: 24, height: 16}, 'Native JPEG fixture must decode before dropping it');
  const previous = images();await drag(a.id, 'drop', jpeg);
  await until(() => images().length === previous.length + 1, 'Pathless image was not saved');
  const normalized = path.join(imageFolder, images().find(name => !previous.includes(name)));
  assert.deepEqual(fs.readFileSync(normalized).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.deepEqual(await electron.evaluate(({nativeImage}, file) => nativeImage.createFromPath(file).getSize(), normalized), {width: 24, height: 16});
  expected += wrapped(quotePath(normalized) + ' ');await until(() => input(a.capture) === expected, 'Pathless image inserted incorrectly');
  for (const file of images()) assert.equal(fs.statSync(path.join(imageFolder, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(imageFolder).mode & 0o777, 0o700);
  // Delay a screenshot, then select another pane and type: preserve target and order.
  await delayImage();await paste(a.id, {bytes: png});
  await until(() => status(a.id).textContent().then(text => text.includes('Saving')), 'No saving status');
  const beforeDelay = images();await focus(a.id);await page.keyboard.type('after image');await focus(b.id);
  await releaseImage();await until(() => images().length === beforeDelay.length + 1, 'Delayed image not saved');
  expected += wrapped(quotePath(path.join(imageFolder, images().find(name => !beforeDelay.includes(name)))) + ' ') + 'after image';
  await until(() => input(a.capture) === expected, 'Async screenshot and later keyboard input reordered');assert.equal(input(b.capture), '');
  // Known remote and disconnected/exited panes reject before persisting anything.
  const count = images().length;
  await page.evaluate(id => {agents.find(agent => agent.id === id).remote_node = 'fixture-remote';}, a.id);
  await drag(a.id, 'dragenter');assert.match(await status(a.id).textContent(), /Remote transfers/);
  await drag(a.id);await until(() => status(a.id).textContent().then(text => text.includes('Remote transfers')), 'Remote drop was not rejected');
  await page.evaluate(id => {delete agents.find(agent => agent.id === id).remote_node;paneViews.get(id).exited = true;}, a.id);
  await paste(a.id, {bytes: png});assert.match(await status(a.id).textContent(), /unavailable/);
  await page.evaluate(id => {paneViews.get(id).exited = false;}, a.id);assert.equal(images().length, count);
  // Invalid/oversized payloads and write errors leave input and completed images alone.
  await paste(a.id, {bytes: [1, 2, 3]});await until(() => status(a.id).textContent().then(text => text.includes('Invalid screenshot')), 'Invalid PNG accepted');
  assert.match(await page.evaluate(async () => {try {await agentDeskDesktop.saveImage(new Uint8Array(20 * 1024 * 1024 + 1));} catch (error) {return error.message;}}), /20 MiB/);
  fs.renameSync(imageFolder, imageFolder + '-kept');fs.writeFileSync(imageFolder, 'blocked fixture');
  try {await paste(a.id, {bytes: png});await until(() => status(a.id).textContent().then(text => text.includes('Could not save')), 'No write error');}
  finally {fs.unlinkSync(imageFolder);fs.renameSync(imageFolder + '-kept', imageFolder);}
  assert.equal(images().length, count);assert.equal(input(a.capture), expected);
  // Inspect desktop/narrow target outline and errors with fixture data only.
  for (const width of [1280, 480]) {
    await electron.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width);
    await page.waitForFunction(width => innerWidth === width, width);
    await page.locator(`[data-pane-id="${a.id}"]`).scrollIntoViewIfNeeded();
    await drag(a.id);expected += wrapped(originals.map(quotePath).join(' ') + ' ');
    await until(() => input(a.capture) === expected, 'Explicit drop after a failed save did not recover');
    await drag(a.id, 'dragenter');assert.equal(await page.locator(`[data-pane-id="${a.id}"]`).evaluate(node => node.classList.contains('terminal-file-target')), true);
    await page.screenshot({path: path.join(evidence, `agent-desk-file-drag-${width}.png`)});
    await drag(a.id, 'dragleave');await paste(a.id, {bytes: [0]});await until(() => status(a.id).textContent().then(text => text.includes('Invalid screenshot')), 'No image error');
    await page.screenshot({path: path.join(evidence, `agent-desk-file-error-${width}.png`)});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  // Closing the captured pane never redirects its delayed paste into the selected pane.
  await delayImage();await paste(a.id, {bytes: png});await until(() => status(a.id).textContent().then(text => text.includes('Saving')), 'No delayed close status');
  await page.evaluate(id => closePane(id), a.id);await focus(b.id);await releaseImage();
  await page.waitForTimeout(100);assert.equal(input(a.capture), expected);assert.equal(input(b.capture), '');assert.equal(images().length, count);
  // An unregistered window with the real preload still has no image-save authority.
  const rejected = await electron.evaluate(async ({BrowserWindow}, preload) => {
    const session = BrowserWindow.getAllWindows()[0].webContents.session;
    const win = new BrowserWindow({show: false, webPreferences: {session, preload, sandbox: true, contextIsolation: true}});
    try {await win.loadURL('agent-desk://app/startup.html');return await win.webContents.executeJavaScript('agentDeskDesktop.saveImage(new Uint8Array([1])).then(()=>"allowed",error=>error.message)');}
    finally {win.destroy();}
  }, path.join(root, 'desktop/src/preload.cjs'));
  assert.match(rejected, /Untrusted desktop caller/);
  // A completed image can still be waiting behind an earlier input request.
  for (const width of [1280, 480]) {
    await electron.evaluate(({BrowserWindow}, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800), width);
    for (const transition of ['close', 'reconnect', 'exit']) {
      const queued = await launch(`Queued file ${transition} ${width}`), earlier = wrapped('earlier text '), before = images().length;
      await holdInput(queued.id);await paste(queued.id, {text: 'earlier text '});
      await page.waitForFunction(() => typeof window.releasePaste === 'function');
      await paste(queued.id, {bytes: png});
      await page.waitForFunction(id => !!paneViews.get(id).observedFilePaste, queued.id);
      assert.equal(images().length, before + 1);assert.equal(input(queued.capture), earlier);
      if (transition === 'close') await page.evaluate(id => closePane(id), queued.id);
      else if (transition === 'reconnect') await page.evaluate(() => agentDeskDesktop.recover('retry'));
      else {
        await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), queued.id);
        await page.waitForFunction(id => paneViews.get(id).exited, queued.id);
      }
      await page.evaluate(() => window.releasePaste());
      assert.equal(input(queued.capture), earlier, `${transition} did not cancel the unsent file path at ${width}px`);
      assert.equal(input(b.capture), '');
      if (transition !== 'exit') await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), queued.id);
      await page.evaluate(id => closePane(id), queued.id);
    }
    // Once a large file paste starts, finish its closing marker even if the pane closes.
    const large = await launch(`Started file paste ${width}`);
    const paths = Array.from({length: 32}, (_,i) => path.join(base, `file-${i}-` + "'".repeat(160)));
    paths.forEach(file => fs.writeFileSync(file, 'large file-drop fixture'));
    const expected = wrapped(paths.map(quotePath).join(' ') + ' ');
    assert.ok(Buffer.byteLength(expected) > 16384);
    await files(paths);await holdInput(large.id);await drag(large.id);
    await page.waitForFunction(() => typeof window.releasePaste === 'function');
    assert.equal(input(large.capture).length, 16384);
    await page.evaluate(async id => {closePane(id);await window.releasePaste();}, large.id);
    await until(() => input(large.capture) === expected, 'Closing a pane truncated a file paste that had already started');
    await page.evaluate(id => terminalRequest('/api/terminals/stop', {id}), large.id);
  }
  console.log('PASS: completed image paths waiting in the send queue cancel on close, reconnection and exit; started file pastes finish their closing marker at 1280/480px');
  const retained = new Map(images().map(name => [name, fs.readFileSync(path.join(imageFolder, name))]));
  await page.evaluate(async ids => {for (const id of ids) await terminalRequest('/api/terminals/stop', {id});}, [a.id, b.id]);
  await quit();await open();
  assert.deepEqual(images(), [...retained.keys()]);for (const [name, bytes] of retained) assert.deepEqual(fs.readFileSync(path.join(imageFolder, name)), bytes);
  assert.equal(fs.readdirSync(imageFolder).some(name => name.endsWith('.tmp')), false);
  await quit();assert.deepEqual(errors, []);
  console.log('PASS: PNG normalization/modes, failures, target changes/closure, pane dragging, unauthorized IPC, desktop/narrow drag/error states and persistence across full app restart');
  console.log('UNVERIFIED: real Claude/Codex image-chip conversion (fixture validates quoted paths only)');
})().catch(async error => {
  console.error(error);
  if (page && !page.isClosed()) console.error('Fixture pane notices:', await page.locator('.pane-connection').allTextContents().catch(() => []));
  process.exitCode = 1;
}).finally(async () => {
  if (manager && fs.existsSync(manager.recordPath)) await manager.shutdown().catch(() => {});
  if (electron?.process().exitCode === null) {
    await electron.evaluate(({app}) => app.exit(0)).catch(() => {});
  }
  console.log('Fixture:', base);
});
