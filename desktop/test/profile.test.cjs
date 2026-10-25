'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createProfile, profilePaths} = require('../src/profile.cjs');
const {openBootstrapLog, RETENTION_MS, MAX_FILE_BYTES, MAX_TOTAL_BYTES} = require('../src/logs.cjs');

test('desktop profile separates data, diagnostics, browser storage and runtimes from web data', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ad-profile-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile = createProfile(root, {AGENT_DESK_PROFILE_DIR:path.join(root,'desktop'), AGENT_DESK_DATA_DIR:path.join(root,'web-data')});
  for (const name of ['data','logs','browser','runtime']) {
    assert.equal(profile[name],path.join(profile.root,name));
    assert.equal(fs.statSync(profile[name]).mode & 0o777,0o700);
  }
  assert.equal(fs.existsSync(path.join(root,'web-data')),false);
  assert.equal(profilePaths(root,{}).root,path.join(root,'Agent Desk Dev'));
  assert.equal(profilePaths(root,{},true).root,path.join(root,'Agent Desk'));
  assert.equal(profilePaths(root,{AGENT_DESK_PROFILE_DIR:root},true).root,root);
});

test('bootstrap diagnostics rotate, expire and stay within the shared size budget', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ad-logs-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const expired=path.join(root,'desktop-backend.expired.log'), unrelated=path.join(root,'notes.txt');
  fs.writeFileSync(expired,'old');fs.utimesSync(expired,new Date(0),new Date(0));
  fs.writeFileSync(unrelated,'keep');
  const active=path.join(root,'desktop-bootstrap.log');fs.writeFileSync(active,Buffer.alloc(MAX_FILE_BYTES),{mode:0o600});
  for(let i=0;i<11;i++) fs.writeFileSync(path.join(root,`desktop-backend.fixture-${i}.log`),Buffer.alloc(MAX_FILE_BYTES),{mode:0o600});
  const fd=openBootstrapLog(root,Date.now());fs.closeSync(fd);
  assert.equal(fs.existsSync(expired),false);
  assert.equal(fs.readFileSync(unrelated,'utf8'),'keep');
  assert.equal(fs.statSync(active).size,0);
  assert.equal(fs.statSync(active).mode & 0o777,0o600);
  const total=fs.readdirSync(root).filter(name=>name.endsWith('.log')).reduce((sum,name)=>sum+fs.statSync(path.join(root,name)).size,0);
  assert.ok(total<=MAX_TOTAL_BYTES-MAX_FILE_BYTES);
  assert.equal(RETENTION_MS,14*24*60*60*1000);
});

test('bootstrap diagnostics refuse symlinks', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ad-log-link-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const target=path.join(root,'target');fs.writeFileSync(target,'keep');
  fs.symlinkSync(target,path.join(root,'desktop-bootstrap.log'));
  assert.throws(()=>openBootstrapLog(root),/Unsafe diagnostic log/);
  assert.equal(fs.readFileSync(target,'utf8'),'keep');
});
