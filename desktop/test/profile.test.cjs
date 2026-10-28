'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {createProfile, profilePaths, browserWorkspacePort, workspaceChoice, saveWorkspaceChoice} = require('../src/profile.cjs');
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

test('a chosen browser workspace replaces the desktop data until the choice is cleared', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ad-choice-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const profile = createProfile(root, {AGENT_DESK_PROFILE_DIR:path.join(root,'desktop')});
  assert.deepEqual(workspaceChoice(profile),{data:profile.data,port:null});
  saveWorkspaceChoice(profile,{data:path.join(root,'web-data'),port:4310});
  assert.equal(fs.statSync(path.join(profile.root,'workspace.json')).mode & 0o777,0o600);
  assert.deepEqual(workspaceChoice(profile),{data:path.join(root,'web-data'),port:4310});
  saveWorkspaceChoice(profile,null);
  assert.deepEqual(workspaceChoice(profile),{data:profile.data,port:null});
  fs.writeFileSync(path.join(profile.root,'workspace.json'),JSON.stringify({data:'relative',port:4310}),{mode:0o600});
  assert.deepEqual(workspaceChoice(profile),{data:profile.data,port:null});
});

test('browser workspace folders are recognized by their port-keyed state', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'ad-browser-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const folder = name => {const dir=path.join(root,name);fs.mkdirSync(dir);return dir;};
  const main = folder('main');fs.writeFileSync(path.join(main,'terminal-sessions-4310.json'),'{}');fs.writeFileSync(path.join(main,'terminal-sessions-4391.json'),'{}');
  assert.equal(browserWorkspacePort(main),4310);
  const side = folder('side');fs.mkdirSync(path.join(side,'.supervisor-4400'));
  assert.equal(browserWorkspacePort(side),4400);
  const fresh = folder('fresh');fs.writeFileSync(path.join(fresh,'desks.json'),'{}');
  assert.equal(browserWorkspacePort(fresh),4310);
  const desktop = folder('desktop');fs.writeFileSync(path.join(desktop,'terminal-sessions-'+'ab'.repeat(16)+'.json'),'{}');
  assert.throws(()=>browserWorkspacePort(desktop),/no browser Agent Desk sessions/);
  const several = folder('several');fs.writeFileSync(path.join(several,'.terminal-owner-4400.json'),'{}');fs.writeFileSync(path.join(several,'.terminal-owner-4401.json'),'{}');
  assert.throws(()=>browserWorkspacePort(several),/several browser workspaces/);
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
