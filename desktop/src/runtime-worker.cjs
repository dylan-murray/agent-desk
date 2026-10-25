const {parentPort, workerData: data} = require('node:worker_threads');
require('./runtime.cjs').runtime({isPackaged: data.packaged, resourcesPath: data.resourcesPath,
  getAppPath: () => data.appPath, getPath: () => data.appData}, stage => parentPort.postMessage({stage}))
  .then(result => parentPort.postMessage({result}), error => parentPort.postMessage({error: error.message}));
