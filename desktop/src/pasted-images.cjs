'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const {privateDirectory} = require('./backend.cjs');
const {trustedFrame} = require('./security.cjs');
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

function imageStore(dataDirectory, nativeImage, files = fs.promises) {
  return async bytes => {
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength) throw Error('Invalid screenshot image.');
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw Error('Screenshot exceeds the 20 MiB limit.');
    const image = nativeImage.createFromBuffer(Buffer.from(bytes));
    if (image.isEmpty()) throw Error('Invalid screenshot image.');
    const png = image.toPNG();
    if (!png.length) throw Error('Invalid screenshot image.');
    if (png.length > MAX_IMAGE_BYTES) throw Error('Screenshot exceeds the 20 MiB limit after PNG conversion.');
    const folder = path.join(dataDirectory, 'pasted-images');
    const completed = path.join(folder, 'screenshot-' + randomUUID() + '.png');
    const temporary = completed + '.tmp';
    let file, created = false;
    try {
      privateDirectory(folder);
      file = await files.open(temporary, 'wx', 0o600);
      created = true;
      await file.writeFile(png);
      await file.sync();
      await file.close();file = null;
      await files.rename(temporary, completed);
      return completed;
    } catch {
      if (file) await file.close().catch(() => {});
      if (created) await files.unlink(temporary).catch(() => {});
      throw Error('Could not save screenshot. Check disk space and desktop profile permissions.');
    }
  };
}

function registerImageIPC(ipcMain, windows, dataDirectory, nativeImage) {
  const save = imageStore(dataDirectory, nativeImage);
  ipcMain.handle('desk:save-image', (event, bytes) => {
    if (!trustedFrame(event, windows)) throw Error('Untrusted desktop caller');
    return save(bytes);
  });
}
module.exports = {MAX_IMAGE_BYTES, imageStore, registerImageIPC};
