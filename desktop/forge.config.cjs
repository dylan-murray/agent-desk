'use strict';
const path = require('node:path');
const {FusesPlugin} = require('@electron-forge/plugin-fuses');
const {FuseVersion, FuseV1Options} = require('@electron/fuses');
const {DevelopmentAppPlugin} = require('./scripts/dev-app.cjs');
const {writeBuildInfo} = require('./scripts/build-info.cjs');
const {projectVersion} = require('./scripts/version.cjs');
const buildInfoPath = path.join(__dirname, '.build/build-info.json');
const appleSigning = process.env.AGENT_DESK_APPLE_SIGNING === '1';
if (appleSigning && !process.env.APPLE_SIGNING_IDENTITY) throw Error('Apple signing requires APPLE_SIGNING_IDENTITY');
module.exports = {
  packagerConfig: {
    name: 'Agent Desk', executableName: 'Agent Desk', appBundleId: 'io.agentdesk.desktop',
    appVersion: projectVersion(),
    icon: path.join(__dirname, 'resources/agent-desk.icns'),
    appCategoryType: 'public.app-category.developer-tools', asar: true, prune: true,
    darwinDarkModeSupport: true, appCopyright: 'Agent Desk contributors',
    extendInfo: {LSMinimumSystemVersion: '14.0'},
    extraResource: [path.join(__dirname, '.build/runtime'), path.join(__dirname, '.build/shell'), buildInfoPath],
    ignore: file => !!file && !/^\/(?:package\.json|src(?:\/|$)|resources(?:\/|$)|node_modules(?:\/|$))/.test(file),

  },
  hooks: {
    readPackageJson: async (config, json) => ({...json, version:config.packagerConfig.appVersion}),
    prePackage: async config => {
      const info = writeBuildInfo(path.resolve(__dirname, '..'), buildInfoPath);
      config.packagerConfig.appVersion = info.version;
      require('node:fs').cpSync(path.join(__dirname, '../agent_desk/static'), path.join(__dirname, '.build/shell/agent_desk/static'), {recursive:true});
    },
    postPackage: async (_config, result) => {for (const output of result.outputPaths) await require('./scripts/sign-app.cjs').signApp(path.join(output, 'Agent Desk.app'), appleSigning);},
  },
  makers: [{name: '@electron-forge/maker-zip', platforms: ['darwin']}],
  plugins: [new DevelopmentAppPlugin(), new FusesPlugin({version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false, [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false, [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true, [FuseV1Options.OnlyLoadAppFromAsar]: true})],
};
