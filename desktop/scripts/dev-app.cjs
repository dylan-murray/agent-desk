'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
const {PluginBase} = require('@electron-forge/plugin-base');
const run = promisify(execFile);

// macOS reads the Dock label from the bundle, not app.setName(). Keep the
// development bundle separate from both the installed app and node_modules.
async function developmentExecutable() {
  const electron = require('electron');
  if (process.platform !== 'darwin') return electron;
  const source = path.resolve(electron, '../../..');
  const icon = path.resolve(__dirname, '../resources/agent-desk.icns');
  const identity = crypto.createHash('sha256');
  for (const file of [__filename, path.join(source, 'Contents/Info.plist'), icon]) identity.update(await fs.promises.readFile(file));
  const stat = await fs.promises.stat(electron);identity.update(`${stat.size}:${stat.mtimeMs}`);
  const folder = path.resolve(__dirname, '../.build/development', identity.digest('hex').slice(0, 24));
  const bundle = path.join(folder, 'Agent Desk Dev.app');
  const executable = path.join(bundle, 'Contents/MacOS/Electron');
  const complete = path.join(folder, 'complete');
  try {await fs.promises.access(complete);await fs.promises.access(executable);return executable;} catch { /* prepare once */ }
  await fs.promises.mkdir(path.dirname(folder), {recursive: true});
  const temporary = await fs.promises.mkdtemp(path.join(path.dirname(folder), '.stage-'));
  const pending = path.join(temporary, 'Agent Desk Dev.app');
  await fs.promises.cp(source, pending, {recursive: true, verbatimSymlinks: true, mode: fs.constants.COPYFILE_FICLONE});
  const plist = path.join(pending, 'Contents/Info.plist');
  for (const [key, value] of Object.entries({CFBundleName: 'Agent Desk Dev', CFBundleDisplayName: 'Agent Desk Dev', CFBundleIdentifier: 'io.agentdesk.desktop.development'})) {
    await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
  }
  await fs.promises.copyFile(icon, path.join(pending, 'Contents/Resources/electron.icns'));
  await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', pending], {timeout: 60000});
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', pending], {timeout: 30000});
  await fs.promises.writeFile(path.join(temporary, 'complete'), 'Agent Desk development bundle\n');
  try {await fs.promises.rename(temporary, folder);} catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error;
    // Another launcher finished the same bundle while this one was preparing.
    await fs.promises.access(complete);
    await fs.promises.rm(temporary, {recursive: true, force: true});
  }
  return executable;
}

class DevelopmentAppPlugin extends PluginBase {
  constructor() {super({});this.name = 'agent-desk-development';}
  async startLogic() {return developmentExecutable();}
}
module.exports = {DevelopmentAppPlugin, developmentExecutable};
