const test = require('node:test');
const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const {mount, quotePath} = require('../agent_desk/static/terminal-files.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const document = new EventTarget(), target = new EventTarget(), classes = new Set(), status = {textContent: ''};
  target.ownerDocument = document;target.contains = node => node === target;
  const pane = {classList: {add: value => classes.add(value), remove: value => classes.delete(value)}};
  let connected = true, remote = false, subscriber;
  const output = [], saved = [], paths = new Map();
  const bridge = {
    droppedFilePath: file => paths.get(file) || '',
    saveImage: async bytes => {saved.push(bytes);return '/profile/screenshot.png';},
    subscribe: callback => {subscriber = callback;return () => {subscriber = null;};},
    snapshot: async () => ({revision: 1, connection: 'connected'}),
  };
  let input;
  const term = {paste: text => input.input(() => output.push(text))};
  input = mount({bridge, target, pane, term, status, available: () => connected, remote: () => remote});
  function event(type, files = [], text = '') {
    const event = new Event(type, {cancelable: true});
    const data = {files, types: files.length ? ['Files'] : ['text/plain'], getData: () => text};
    Object.assign(event, {clipboardData: data, dataTransfer: data});target.dispatchEvent(event);return event;
  }
  const image = () => ({type: 'image/png', size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer});
  return {target, classes, status, output, saved, paths, bridge, input, image, event,
    unavailable: () => {connected = false;input.cancel();}, remote: () => {remote = true;},
    disconnect: () => {subscriber({revision: 2, connection: 'disconnected'});subscriber({revision: 3, connection: 'connected'});}};
}
test('POSIX paths round trip literally; unsafe and relative paths are rejected', () => {
  const paths = ['/tmp/a b.png', "/tmp/a'b\"c.png", '/tmp/猫🐈.png', '/tmp/$(false);`false`\\file'];
  const result = spawnSync('/bin/sh', ['-c', "printf '%s\\n' " + paths.map(quotePath).join(' ')], {encoding: 'utf8'});
  assert.equal(result.status, 0);assert.deepEqual(result.stdout.trim().split('\n'), paths);
  for (const value of ['relative', '', '/a\nb', '/a\0b', '/a\x1bb', '/a\x7fb', '/a\x85b', '/a\u2028b']) assert.throws(() => quotePath(value), /absolute.*control/);
});
test('separate drops and screenshot pastes remain separate shell arguments', async () => {
  const f = fixture();await tick();
  const one = {}, two = {}, paths = ["/tmp/a'b", '/tmp/猫 file'];
  f.paths.set(one, paths[0]);f.paths.set(two, paths[1]);
  f.event('drop', [one]);f.event('drop', [two]);
  f.event('paste', [f.image()]);f.event('paste', [f.image()]);await tick();
  const result = spawnSync('/bin/sh', ['-c', "printf '%s\\n' " + f.output.join('')], {encoding: 'utf8'});
  assert.equal(result.status, 0);
  assert.deepEqual(result.stdout.trim().split('\n'), [...paths, '/profile/screenshot.png', '/profile/screenshot.png']);
  f.input.dispose();
});
test('browser has no attachment handlers; all nonempty text stays on the normal paste path', async () => {
  assert.equal(mount({bridge: undefined}), null);
  const f = fixture();await tick();
  for (const text of ['ordinary', ' ', 'long\n'.repeat(10000)]) assert.equal(f.event('paste', [f.image()], text).defaultPrevented, false);
  assert.equal(f.event('paste').defaultPrevented, false);
  assert.deepEqual(f.saved, []);f.input.dispose();
});
test('image paste, later text and successive drops keep their capture order', async () => {
  const f = fixture();await tick();
  let finish;
  f.bridge.saveImage = bytes => {f.saved.push(bytes);return new Promise(resolve => finish = resolve);};
  assert.equal(f.event('paste', [f.image()]).defaultPrevented, true);
  f.input.input(() => f.output.push('later text'));
  const one = {}, two = {};f.paths.set(one, "/tmp/a'b");f.paths.set(two, '/tmp/猫 file');
  f.event('drop', [one, two]);await tick();
  assert.equal(f.status.textContent, 'Saving screenshot…');assert.deepEqual(f.output, []);
  finish('/profile/screenshot.png');await tick();
  assert.deepEqual(f.output, ["'/profile/screenshot.png' ", 'later text', "'/tmp/a'\\''b' '/tmp/猫 file' "]);
  assert.equal(f.status.textContent, '');assert.equal(f.saved.length, 1);f.input.dispose();
});
test('target closure, terminal unavailability and a recovered connection cancel pending insertion', async () => {
  for (const cancel of ['dispose', 'unavailable', 'disconnect']) {
    const f = fixture();await tick();let finish;
    f.bridge.saveImage = () => new Promise(resolve => finish = resolve);
    f.event('paste', [f.image()]);f.input.input(() => f.output.push('must not replay'));await tick();
    if (cancel === 'dispose') f.input.dispose();else f[cancel]();
    finish('/saved/retained.png');await tick();
    assert.deepEqual(f.output, []);
    if (cancel !== 'dispose') {assert.match(f.status.textContent, /cancelled/);f.input.dispose();}
  }
});
test('reconnection releases typing before a cancelled save settles; late results leave the new queue alone', async () => {
  for (const failed of [false, true]) {
    const f = fixture();await tick();let finishOld, finishNew;
    f.bridge.saveImage = () => new Promise((resolve, reject) => {finishOld = () => failed ? reject(Error('Old save failed')) : resolve('/saved/old.png');});
    f.event('paste', [f.image()]);f.input.input(() => f.output.push('cancelled typing'));await tick();
    f.disconnect();
    f.input.input(() => f.output.push('fresh typing'));
    assert.deepEqual(f.output, ['fresh typing']);
    f.bridge.saveImage = () => new Promise(resolve => finishNew = resolve);
    f.event('paste', [f.image()]);await tick();
    finishOld();await tick();
    assert.equal(f.status.textContent, 'Saving screenshot…');
    f.input.input(() => f.output.push('after new image'));
    assert.deepEqual(f.output, ['fresh typing']);
    finishNew('/saved/new.png');await tick();
    assert.deepEqual(f.output, ['fresh typing', "'/saved/new.png' ", 'after new image']);
    assert.equal(f.status.textContent, '');f.input.dispose();
  }
});
test('pathless images use PNG saving; unsupported, oversized, remote and unavailable drops insert nothing', async () => {
  const f = fixture();await tick();
  f.event('dragenter', [f.image()]);assert.ok(f.classes.has('terminal-file-target'));
  f.event('drop', [f.image()]);await tick();assert.equal(f.classes.size, 0);assert.equal(f.saved.length, 1);
  f.output.length = 0;
  for (const [files, message] of [
    [[{type: 'application/pdf'}], /no usable filesystem path/],
    [[{type: 'image/png', size: 20 * 1024 * 1024 + 1}], /20 MiB/],
    [[], /filesystem path/],
  ]) {assert.equal(f.event('drop', files).defaultPrevented, true);await tick();assert.match(f.status.textContent, message);assert.deepEqual(f.output, []);}
  const bad = {};f.paths.set(bad, '/tmp/bad\nname');f.event('drop', [bad]);await tick();assert.match(f.status.textContent, /control/);
  f.remote();const rejected = f.event('dragenter', [f.image()]);assert.equal(rejected.dataTransfer.dropEffect, 'none');assert.match(f.status.textContent, /Remote transfers/);
  f.event('drop', [f.image()]);assert.match(f.status.textContent, /Remote transfers/);f.input.dispose();
  const g = fixture();await tick();g.unavailable();g.event('paste', [g.image()]);await tick();assert.match(g.status.textContent, /unavailable/);assert.deepEqual(g.saved, []);g.input.dispose();
});
test('save failure reports in place, never inserts or retries, and permits a later explicit paste', async () => {
  const f = fixture();await tick();let calls = 0;
  f.bridge.saveImage = async () => {calls++;throw Error('Fixture disk full');};
  f.event('paste', [f.image()]);await tick();assert.match(f.status.textContent, /disk full/);assert.deepEqual(f.output, []);assert.equal(calls, 1);
  f.bridge.saveImage = async () => '/saved/next.png';f.event('paste', [f.image()]);await tick();assert.deepEqual(f.output, ["'/saved/next.png' "]);f.input.dispose();
});
