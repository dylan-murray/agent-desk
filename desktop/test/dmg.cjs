'use strict';
const fs=require('node:fs'),path=require('node:path');
const {execFileSync,spawnSync}=require('node:child_process');
const image=path.resolve(process.argv[2] || path.join(__dirname,'../out/make/Agent-Desk-arm64.dmg'));
const mount=fs.mkdtempSync('/private/tmp/ad-volume-');let mounted=false;
try{
  execFileSync('/usr/bin/hdiutil',['verify',image],{stdio:'pipe'});
  execFileSync('/usr/bin/hdiutil',['attach','-readonly','-nobrowse','-mountpoint',mount,image],{stdio:'pipe'});mounted=true;
  const bundle=path.join(mount,'Agent Desk.app');
  execFileSync('/usr/bin/codesign',['--verify','--deep','--strict',bundle],{stdio:'pipe'});
  const result=spawnSync(process.execPath,[path.join(__dirname,'packaged.cjs'),bundle],{stdio:'inherit',timeout:90000});
  if(result.status!==0)throw Error('Mounted app check failed');
  console.log('PASS: verified DMG, read-only mount, signed app relocation, bundled runtime and terminal checks.');
}catch(error){console.error(error.message);process.exitCode=1;}
finally{if(mounted)execFileSync('/usr/bin/hdiutil',['detach',mount],{stdio:'pipe'});}
