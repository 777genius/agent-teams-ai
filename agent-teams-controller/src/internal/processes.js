const processStore = require('./processStore.js');

function registerProcess(context, flags) {
  return processStore.registerProcess(context.paths, flags);
}

function unregisterProcess(context, flags) {
  processStore.unregisterProcess(context.paths, flags);
  return listProcesses(context);
}

function listProcesses(context) {
  return processStore.listProcesses(context.paths);
}

function stopProcess(context, flags) {
  return processStore.stopProcess(context.paths, flags);
}

module.exports = {
  registerProcess,
  stopProcess,
  unregisterProcess,
  listProcesses,
};
