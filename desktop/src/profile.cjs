'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {privateDirectory, privateJSON, atomicJSON} = require('./backend.cjs');
const BROWSER_PORT = 4310;

function profilePaths(appData, env = process.env, packaged = false) {
  const root = path.resolve(env.AGENT_DESK_PROFILE_DIR || path.join(appData, packaged ? 'Agent Desk' : 'Agent Desk Dev'));
  return {root, data: path.join(root, 'data'), browser: path.join(root, 'browser'),
    runtime: path.join(root, 'runtime'), logs: path.join(root, 'logs')};
}

function createProfile(appData, env = process.env, packaged = false) {
  const profile = profilePaths(appData, env, packaged);
  for (const directory of Object.values(profile)) privateDirectory(directory);
  return profile;
}

// The port a browser Agent Desk data folder belongs to, named by its per-port state files.
function browserWorkspacePort(folder) {
  const names = fs.readdirSync(folder);
  const ports = new Set();
  for (const name of names) {
    const match = name.match(/^(?:terminal-sessions-(\d{1,5})\.json|\.terminal-owner-(\d{1,5})\.json|\.supervisor-(\d{1,5}))$/);
    if (match) ports.add(Number(match[1] || match[2] || match[3]));
  }
  if (ports.has(BROWSER_PORT) || !ports.size && names.includes('desks.json')) return BROWSER_PORT;
  if (ports.size === 1) return [...ports][0];
  throw Error(ports.size ? 'This folder holds several browser workspaces (ports ' + [...ports].join(', ') + ').' : 'This folder has no browser Agent Desk sessions. Choose the data folder of the browser app, such as agent-desk/data.');
}

// The desktop opens its own data unless the user chose a browser workspace to own instead.
function workspaceChoice(profile) {
  let saved;
  try {saved = privateJSON(path.join(profile.root, 'workspace.json'));} catch (error) {if (error.code !== 'ENOENT') throw error;}
  if (saved && typeof saved.data === 'string' && path.isAbsolute(saved.data) && Number.isSafeInteger(saved.port) && saved.port > 0 && saved.port < 65536) return {data: saved.data, port: saved.port};
  return {data: profile.data, port: null};
}

function saveWorkspaceChoice(profile, choice) {
  const file = path.join(profile.root, 'workspace.json');
  if (choice) atomicJSON(file, {data: choice.data, port: choice.port});
  else fs.rmSync(file, {force: true});
}

module.exports = {profilePaths, createProfile, browserWorkspacePort, workspaceChoice, saveWorkspaceChoice};
