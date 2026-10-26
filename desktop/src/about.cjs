'use strict';
const fs = require('node:fs');
const path = require('node:path');
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function aboutOptions(info) {
  if (!versionPattern.test(info.version) ||
      !(info.releaseTag === null || info.releaseTag === `desktop-${info.version}` && !info.dirty) ||
      !/^[a-f0-9]{7,40}$/.test(info.commit) || typeof info.dirty !== 'boolean' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(info.packagedAt) ||
      !Number.isFinite(Date.parse(info.packagedAt))) throw Error('Invalid desktop build metadata');
  return {applicationName: 'Agent Desk',
    applicationVersion: info.version,
    version: '', copyright: `${info.releaseTag ? 'Release' : 'Development'} build · ${info.commit}`};
}

function configureAbout(app, resourcesPath = process.resourcesPath, diagnosticsFile) {
  const info = app.isPackaged
    ? JSON.parse(fs.readFileSync(path.join(resourcesPath, 'build-info.json'), 'utf8'))
    : require('../scripts/build-info.cjs').buildInfo(path.resolve(__dirname, '../..'));
  const options = aboutOptions(info);
  if (diagnosticsFile) require('./backend.cjs').atomicJSON(diagnosticsFile, info);
  app.setAboutPanelOptions(options);
  return options;
}

module.exports = {aboutOptions, configureAbout};
