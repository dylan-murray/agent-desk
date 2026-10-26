'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {trustedFrame, assetPath, externalURL} = require('../src/security.cjs');
const {cleanEnvironment} = require('../src/backend.cjs');
const {verifyRuntime} = require('../src/runtime.cjs');
test('native authority is bound to an exact registered main frame', () => {
  const frame = {url: 'agent-desk://app/'};const sender = {id: 1, mainFrame: frame};const windows = new Set([1]);
  assert.equal(trustedFrame({sender, senderFrame: frame}, windows), true);
  assert.equal(trustedFrame({sender, senderFrame: {url: frame.url}}, windows), false);
  assert.equal(trustedFrame({sender, senderFrame: frame}, new Set()), false);
  frame.url = 'agent-tool://t' + 'a'.repeat(32) + '/';assert.equal(trustedFrame({sender, senderFrame: frame}, windows), false);
});
test('HTTP authority requires registered frame metadata and overwrites forged proofs', () => {
  const {applicationAuthority}=require('../src/http.cjs');
  const frame={url:'agent-desk://app/'},webContents={id:1,mainFrame:null};webContents.mainFrame=frame;
  const authority=applicationAuthority(new Set([1]));
  const details={url:'agent-desk://app/api/agents',webContents,frame,initiatorOrigin:'agent-desk://app'};
  const headers=authority.authorize(details,{'x-agent-desk-app-bridge':'forged'});
  assert.notEqual(headers['X-Agent-Desk-App-Bridge'],'forged');
  assert.equal(authority.accepts(new Request(details.url,{headers})),true);
  for(const patch of [{frame:{url:frame.url}},{webContents:{id:2,mainFrame:frame}},{initiatorOrigin:'agent-tool://tool'},{frame:null}])assert.equal(authority.authorize({...details,...patch},{}),null);
});
test('asset paths cannot escape the packaged root, including symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-assets-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(path.join(root, 'assets'));fs.writeFileSync(path.join(root, 'assets/index.html'), 'fixture');fs.writeFileSync(path.join(root, 'secret'), 'private');
  fs.symlinkSync(path.join(root, 'secret'), path.join(root, 'assets/link'));
  assert.equal(assetPath(path.join(root, 'assets'), 'agent-desk://app/'), fs.realpathSync(path.join(root, 'assets/index.html')));
  for (const url of ['agent-desk://other/', 'agent-desk://app/link', 'agent-desk://app/%2f..%2fsecret', 'agent-desk://app/%5csecret']) assert.throws(() => assetPath(path.join(root, 'assets'), url));
});
test('external links and internal runtime environment have restricted inputs', () => {
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'ssh://host', 'https://user:secret@example.com']) assert.equal(externalURL(url), null);
  assert.equal(externalURL('https://example.com'), 'https://example.com/');
  assert.deepEqual(cleanEnvironment({PATH: '/bin', PYTHONPATH: '/evil', PYTHONHOME: '/evil', NODE_OPTIONS: '--inspect', DYLD_INSERT_LIBRARIES: '/evil', AGENT_DESK_TOKEN: 'secret', OPENAI_API_KEY: 'native-login'}), {PATH: '/bin', OPENAI_API_KEY: 'native-login'});
});
test('runtime integrity rejects changed and injected files', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ad-runtime-'));t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'known'), 'fixture');const hash = require('node:crypto').createHash('sha256').update('fixture').digest('hex');
  const manifest = {files: {known: hash}};verifyRuntime(root, manifest);
  fs.writeFileSync(path.join(root, 'injected.py'), 'bad');assert.throws(() => verifyRuntime(root, manifest), /Unexpected/);
});

test('tool proxy preserves script policies while restricting embedding to the workspace', () => {
  const {toolCSP}=require('../src/security.cjs');
  assert.equal(toolCSP("default-src 'self'; script-src 'none'; frame-ancestors 'self'"), "default-src 'self'; script-src 'none'; frame-ancestors agent-desk://app");
});
test('a rejected resume does not look like success to the desktop shell', async () => {
  const {Backend}=require('../src/backend.cjs');
  await assert.rejects(()=>Backend.prototype.resume.call({request:async()=>({status:409,body:Buffer.from(JSON.stringify({error:'Still stopping'})).toString('base64')})}), /Still stopping/);
});
