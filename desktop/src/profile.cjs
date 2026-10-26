'use strict';
const path = require('node:path');
const {privateDirectory} = require('./backend.cjs');

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

module.exports = {profilePaths, createProfile};
