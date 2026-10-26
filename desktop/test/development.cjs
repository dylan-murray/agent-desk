'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {_electron} = require('../../node_modules/playwright');
const {DevelopmentAppPlugin} = require('../scripts/dev-app.cjs');
const base = fs.mkdtempSync('/private/tmp/ad-dev-name-');
let electron;
(async () => {
  const executable = await new DevelopmentAppPlugin().startLogic();
  assert.ok(executable.includes('/Agent Desk Dev.app/'));
  electron = await _electron.launch({executablePath: executable, args: [path.resolve(__dirname, '..')], env: {
    ...process.env, AGENT_DESK_DESKTOP_TEST: '1', AGENT_DESK_PROFILE_DIR: path.join(base, 'profile'),
    AGENT_DESK_SOCKET_ROOT: path.join(base, 's'), AGENT_DESK_TEST_DELAY: '5000',
  }});
  const page = await electron.firstWindow();await page.locator('#status').waitFor();
  assert.equal(await electron.evaluate(({app}) => app.isPackaged), false);
  assert.equal(await electron.evaluate(({app}) => app.getName()), 'Agent Desk Dev');
  const pid = electron.process().pid;
  const nativeName = execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');ObjC.unwrap($.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}).localizedName);`], {encoding: 'utf8'}).trim();
  assert.equal(nativeName, 'Agent Desk Dev');
  console.log('PASS: development launch loads current source and macOS names the running app Agent Desk Dev.');
})().catch(error => {console.error(error);process.exitCode = 1;}).finally(async () => {
  if (electron) try {await electron.evaluate(({app}) => app.exit(0));} catch {}
});
