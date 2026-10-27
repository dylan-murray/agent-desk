const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {MAX_IMAGE_BYTES, imageStore, registerImageIPC} = require('../src/pasted-images.cjs');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAAJklEQVR4nOzMQQ0AAAgDsYXgXwGKMAUm9ttVQHv25FAyISIiSo0eAAD//+x4VW8AAAAGSURBVAMAQ4gCiAGwvxUAAAAASUVORK5CYII=', 'base64');
// Real Electron decoding/normalization is covered by paste-drop.cjs.
const codec = {createFromBuffer: bytes => ({isEmpty: () => !bytes.equals(png), toPNG: () => png})};
function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-images-'));
  t.after(() => fs.rmSync(data, {recursive: true, force: true}));return data;
}
test('completed PNGs have unique absolute names, private modes and no lifetime cleanup', async t => {
  const data = fixture(t), save = imageStore(data, codec);
  const paths = await Promise.all([save(png), save(png)]);
  assert.notEqual(...paths);
  for (const file of paths) {
    assert.match(file, /\/pasted-images\/screenshot-[\da-f-]{36}\.png$/);
    assert.ok(path.isAbsolute(file));assert.deepEqual(fs.readFileSync(file), png);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(fs.statSync(path.dirname(paths[0])).mode & 0o777, 0o700);
  await imageStore(data, codec)(png); // A fresh store leaves existing images alone.
  assert.equal(fs.readdirSync(path.dirname(paths[0])).length, 3);
});
test('rejects invalid, empty, non-byte and oversized images before writing', async t => {
  const data = fixture(t), save = imageStore(data, codec);
  for (const bytes of [undefined, [], 'png', new Uint8Array(), Buffer.from('not an image')]) await assert.rejects(save(bytes), /Invalid screenshot/);
  await assert.rejects(save(new Uint8Array(MAX_IMAGE_BYTES + 1)), /20 MiB/);
  await assert.rejects(imageStore(data, {createFromBuffer: () => ({isEmpty: () => false, toPNG: () => Buffer.alloc(MAX_IMAGE_BYTES + 1)})})(png), /after PNG conversion/);
  assert.deepEqual(fs.readdirSync(data), []);
});
test('atomic completion and cleanup of partial writes, sync and rename failures', async t => {
  const data = fixture(t), folder = path.join(data, 'pasted-images');
  const kept = await imageStore(data, codec)(png);
  for (const operation of ['writeFile', 'sync', 'rename', 'open']) {
    const files = {...fs.promises};
    if (['rename', 'open'].includes(operation)) files[operation] = async () => {throw Error('fixture failure');};
    else files.open = async (...args) => {
      const handle = await fs.promises.open(...args);
      return {
        close: () => handle.close(),
        writeFile: async bytes => {await handle.writeFile(bytes);if (operation === 'writeFile') throw Error('disk full');},
        sync: async () => {if (operation === 'sync') throw Error('sync failed');await handle.sync();},
      };
    };
    await assert.rejects(imageStore(data, codec, files)(png), /Could not save screenshot/);
    assert.deepEqual(fs.readdirSync(folder), [path.basename(kept)]);
  }
  let release, started;
  const writing = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  const save = imageStore(data, codec, {...fs.promises, open: async (...args) => {
    const handle = await fs.promises.open(...args);
    return {writeFile: async bytes => {await handle.writeFile(bytes);started();await gate;}, sync: () => handle.sync(), close: () => handle.close()};
  }});
  const pending = save(png);await writing;
  assert.equal(fs.readdirSync(folder).filter(file => file.endsWith('.png')).length, 1);
  assert.equal(fs.readdirSync(folder).filter(file => file.endsWith('.tmp')).length, 1);
  release();const completed = await pending;
  assert.deepEqual(fs.readFileSync(completed), png);
  assert.equal(fs.readdirSync(folder).some(file => file.endsWith('.tmp')), false);
});
test('rejects a non-private or symlink image directory', async t => {
  const data = fixture(t), folder = path.join(data, 'pasted-images');
  fs.mkdirSync(folder, {mode: 0o755});fs.chmodSync(folder, 0o755);
  await assert.rejects(imageStore(data, codec)(png), /profile permissions/);
  fs.rmdirSync(folder);fs.symlinkSync(fixture(t), folder);
  await assert.rejects(imageStore(data, codec)(png), /profile permissions/);
});
test('image IPC authorizes registered main frames before decoding or writing', async t => {
  let handler, decoded = 0;
  const data = fixture(t), mainFrame = {url: 'agent-desk://app/index.html'};
  const sender = {id: 7, mainFrame};
  registerImageIPC({handle: (channel, callback) => {assert.equal(channel, 'desk:save-image');handler = callback;}}, new Set([7]), data,
    {createFromBuffer: bytes => {decoded++;return codec.createFromBuffer(bytes);}});
  for (const event of [
    {}, {sender, senderFrame: {url: mainFrame.url}},
    {sender: {id: 8, mainFrame}, senderFrame: mainFrame},
    {sender: {id: 7, mainFrame: {url: 'agent-tool://fixture/'}}, senderFrame: mainFrame},
  ]) assert.throws(() => handler(event, png), /Untrusted desktop caller/);
  assert.equal(decoded, 0);assert.deepEqual(fs.readdirSync(data), []);
  assert.ok(fs.existsSync(await handler({sender, senderFrame: mainFrame}, png)));
});
