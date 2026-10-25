'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {createProfile} = require('../src/profile.cjs');
const {stageRuntime, requireStopped, runtime} = require('../src/runtime.cjs');
const {atomicJSON} = require('../src/backend.cjs');

test('stable runtime replacement preserves data and legacy hashed runtimes and refuses a live owner', t => {
  const root = fs.mkdtempSync('/private/tmp/ad-runtime-update-');
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const profile = createProfile(root, {AGENT_DESK_PROFILE_DIR:path.join(root,'profile')}, true);
  const bundled = path.join(root,'bundle');fs.mkdirSync(bundled);
  const saved = path.join(profile.data,'saved.txt');fs.writeFileSync(saved,'preserve');
  const legacy = path.join(profile.root,'runtimes/old-hash');fs.mkdirSync(legacy,{recursive:true});fs.writeFileSync(path.join(legacy,'old'),'preserve');
  const manifest = text => ({files:{code:crypto.createHash('sha256').update(text).digest('hex')}});
  fs.writeFileSync(path.join(bundled,'code'),'first');
  assert.equal(stageRuntime(bundled,profile,manifest('first')),profile.runtime);
  const owner = path.join(profile.data,'.terminal-owner-fixture.json');atomicJSON(owner,{pid:process.pid});
  assert.throws(()=>requireStopped(profile),/Stop Work and Quit/);
  // An unchanged build remains usable for crash recovery with a live supervisor.
  assert.equal(stageRuntime(bundled,profile,manifest('first')),profile.runtime);
  fs.writeFileSync(path.join(bundled,'code'),'second');
  assert.throws(()=>stageRuntime(bundled,profile,manifest('second')),/Stop Work and Quit/);
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'first');
  fs.unlinkSync(owner);
  stageRuntime(bundled,profile,manifest('second'));
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'second');
  assert.equal(fs.readFileSync(saved,'utf8'),'preserve');
  assert.equal(fs.readFileSync(path.join(legacy,'old'),'utf8'),'preserve');
  fs.writeFileSync(path.join(bundled,'code'),'corrupt');
  assert.throws(()=>stageRuntime(bundled,profile,manifest('third')),/integrity/);
  assert.equal(fs.readFileSync(path.join(profile.runtime,'code'),'utf8'),'second');
});

test('changed source requires shutdown while same-build source recovery can retain owners', async t => {
  const root = fs.mkdtempSync('/private/tmp/ad-source-update-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  // A temporary appData namespace exercises the actual default development path.
  const profile = createProfile(root, {});
  const app = {isPackaged:false,getPath:()=>root};
  const original = process.env.AGENT_DESK_PROFILE_DIR;delete process.env.AGENT_DESK_PROFILE_DIR;
  t.after(()=>{if(original===undefined)delete process.env.AGENT_DESK_PROFILE_DIR;else process.env.AGENT_DESK_PROFILE_DIR=original;});
  const first = await runtime(app);
  const owner = path.join(profile.data,'.terminal-owner-fixture.json');atomicJSON(owner,{pid:process.pid});
  assert.equal((await runtime(app)).sourceIdentity,first.sourceIdentity);
  atomicJSON(path.join(profile.data,'desktop-runtime.json'),{identity:'previous-source'});
  await assert.rejects(()=>runtime(app),/Stop Work and Quit/);
  fs.unlinkSync(owner);
  assert.equal((await runtime(app)).sourceIdentity,first.sourceIdentity);
});
