'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const {buildInfo, writeBuildInfo} = require('../scripts/build-info.cjs');
const {projectVersion} = require('../scripts/version.cjs');
const {aboutOptions, configureAbout} = require('../src/about.cjs');
const {releaseRepository: repository} = require('./fixtures/release.cjs');

test('generated artifacts and metadata do not make a clean build dirty', t => {
  const {root,git} = repository(t);
  for(const directory of ['desktop/.build','desktop/out','desktop/node_modules','data']) {
    fs.mkdirSync(path.join(root,directory),{recursive:true});fs.writeFileSync(path.join(root,directory,'generated.txt'),'generated');
  }
  const now = new Date('2026-01-02T23:30:00-05:00');
  const file = path.join(root,'desktop/.build/build-info.json');
  const info = writeBuildInfo(root,file,now,{});
  assert.deepEqual(info,{version:'0.1.0',commit:git('rev-parse','--short','HEAD'),dirty:false,releaseTag:null,packagedAt:'2026-01-03T04:30:00.000Z'});
  assert.equal(buildInfo(root,now).dirty,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')),info);
  assert.equal(projectVersion(root),'0.1.0');
});

test('unstaged, staged and untracked source changes mark a build dirty', t => {
  const {root,git} = repository(t);
  fs.writeFileSync(path.join(root,'source.txt'),'modified');
  assert.equal(buildInfo(root).dirty,true);
  git('add','source.txt');assert.equal(buildInfo(root).dirty,true);
  git('commit','-qm','Changed source');assert.equal(buildInfo(root).dirty,false);
  fs.writeFileSync(path.join(root,'new-source.cjs'),'source');assert.equal(buildInfo(root).dirty,true);
});

test('packaged About keeps the version short and retains full metadata in diagnostics', t => {
  const resources = fs.mkdtempSync(path.join(os.tmpdir(),'ad-about-'));
  t.after(()=>fs.rmSync(resources,{recursive:true,force:true}));
  const info = {version:'0.1.0',commit:'abcdef1',dirty:true,releaseTag:null,packagedAt:'2026-01-03T04:30:00.000Z'};
  fs.writeFileSync(path.join(resources,'build-info.json'),JSON.stringify(info));
  let actual;
  const app = {isPackaged:true,setAboutPanelOptions:options=>{actual=options;}};
  const oldPath=process.env.PATH;process.env.PATH='';
  const diagnosticsFile=path.join(resources,'diagnostics.json');
  try {configureAbout(app,resources,diagnosticsFile);} finally {process.env.PATH=oldPath;}
  assert.equal(actual.applicationVersion,'0.1.0');
  assert.equal(actual.copyright,'Development build · abcdef1');
  assert.deepEqual(JSON.parse(fs.readFileSync(diagnosticsFile,'utf8')),info);
  assert.equal(aboutOptions({...info,dirty:false}).copyright,'Development build · abcdef1');
  const release=aboutOptions({...info,dirty:false,releaseTag:'0.1.0'});
  assert.equal(release.applicationVersion,'0.1.0');
  assert.equal(release.copyright,'Release build · abcdef1');
  assert.throws(()=>aboutOptions({...info,commit:'unknown'}),/Invalid desktop build metadata/);
  assert.throws(()=>aboutOptions({...info,packagedAt:'yesterday'}),/Invalid desktop build metadata/);
  assert.throws(()=>aboutOptions({...info,version:'0.01.0'}),/Invalid desktop build metadata/);
  assert.throws(()=>aboutOptions({...info,releaseTag:'0.1.0'}),/Invalid desktop build metadata/);
  assert.throws(()=>aboutOptions({...info,dirty:false,releaseTag:'0.2.0'}),/Invalid desktop build metadata/);
  assert.throws(()=>aboutOptions({...info,dirty:false,releaseTag:'desktop-0.1.0'}),/Invalid desktop build metadata/);
});

test('desktop source manifests do not duplicate the shared project version', () => {
  for(const name of ['package.json','package-lock.json']) {
    const json=JSON.parse(fs.readFileSync(path.resolve(__dirname,'..',name),'utf8'));
    assert.equal(Object.hasOwn(json,'version'),false);
    if(json.packages) assert.equal(Object.hasOwn(json.packages[''],'version'),false);
  }
});

test('many commits and local release tags keep the version and remain development builds', t => {
  const {root,git} = repository(t);
  git('tag','0.1.0');
  assert.equal(buildInfo(root).releaseTag,null);
  const original=buildInfo(root).commit;
  fs.writeFileSync(path.join(root,'source.txt'),'next change');
  git('add','.');git('commit','-qm','Another change without version bump');
  assert.equal(buildInfo(root).version,'0.1.0');
  assert.notEqual(buildInfo(root).commit,original);
  assert.equal(buildInfo(root).releaseTag,null);
});

test('only a clean version bump pushed to main produces a release build, before its tag exists', t => {
  const {root,git,push} = repository(t);
  const env=push('0.2.0');
  assert.equal(git('tag','--list'), '');
  assert.equal(buildInfo(root,new Date(),env).releaseTag,'0.2.0');
  for (const event of ['pull_request','workflow_dispatch']) {
    assert.equal(buildInfo(root,new Date(),{...env,GITHUB_EVENT_NAME:event}).releaseTag,null);
  }
  assert.equal(buildInfo(root,new Date(),{...env,GITHUB_REF:'refs/tags/0.2.0'}).releaseTag,null);
  fs.writeFileSync(path.join(root,'source.txt'),'modified');
  assert.throws(()=>buildInfo(root,new Date(),env),/clean checkout/);
  git('add','.');git('commit','-qm','New commit');
  assert.throws(()=>buildInfo(root,new Date(),env),/pushed commit/);
});

test('existing lightweight and annotated version tags must resolve to the release commit', t => {
  for (const annotated of [false,true]) {
    const {root,git,push} = repository(t);
    const env=push('0.2.0');
    git('tag',...(annotated ? ['-a','0.2.0','-m','Fixture release'] : ['0.2.0']));
    assert.equal(buildInfo(root,new Date(),env).releaseTag,'0.2.0');
    git('tag','-f','0.2.0','HEAD^');
    assert.throws(()=>buildInfo(root,new Date(),env),/checked-out commit/);
  }
});
