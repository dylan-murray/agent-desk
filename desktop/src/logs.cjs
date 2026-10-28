'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

// Called only when starting a new backend, after ruling out a live owner.
function openBootstrapLog(directory, now = Date.now()) {
  const file = path.join(directory, 'desktop-bootstrap.log');
  if (fs.existsSync(file)) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw Error('Unsafe diagnostic log');
    if (info.size >= MAX_FILE_BYTES || new Date(info.mtimeMs).toISOString().slice(0,10) !== new Date(now).toISOString().slice(0,10)) {
      fs.renameSync(file, path.join(directory, `desktop-bootstrap.${now}.${crypto.randomUUID()}.log`));
    }
  }
  const files = fs.readdirSync(directory).filter(name => /^desktop-(backend|bootstrap)(\.[\w.-]+)?\.log$/.test(name)).map(name => {
    const file = path.join(directory, name), info = fs.lstatSync(file);return {file, info, size:info.size, mtimeMs:info.mtimeMs};
  }).filter(item => item.info.isFile() && !item.info.isSymbolicLink()).sort((a,b) => a.mtimeMs-b.mtimeMs);
  let total = files.reduce((sum, info) => sum+info.size, 0);
  for (const info of files) {
    if (info.mtimeMs < now-RETENTION_MS || total > MAX_TOTAL_BYTES-MAX_FILE_BYTES-1024) {
      fs.unlinkSync(info.file);total -= info.size;
    }
  }
  const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_APPEND | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  const info = fs.fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077) {fs.closeSync(fd);throw Error('Unsafe diagnostic log');}
  return fd;
}

module.exports = {openBootstrapLog, MAX_FILE_BYTES, MAX_TOTAL_BYTES, RETENTION_MS};
