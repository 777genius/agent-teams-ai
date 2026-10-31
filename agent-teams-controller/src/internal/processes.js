const processStore = require('./processStore.js');

function registerProcess(context, flags) {
  return processStore.registerProcess(context.paths, flags);
}

function unregisterProcess(context, flags) {
  processStore.unregisterProcess(context.paths, flags);
  return listProcesses(context);
}

function listProcesses(context, flags) {
  return processStore.listProcesses(context.paths, { readOnly: flags?.readOnly === true });
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
