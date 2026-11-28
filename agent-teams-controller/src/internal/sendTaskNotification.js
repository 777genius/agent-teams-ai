const messages = require('./messages.js');
const { buildTaskRef, mergeTaskRefs } = require('./taskReferences.js');

// The canonical task is always primary; optional context references follow it.
function sendTaskNotification(context, task, flags, trustedUser = false) {
  const send = trustedUser ? messages.sendTrustedMessage : messages.sendMessage;
  return send(context, {
    ...flags,
    taskRefs: mergeTaskRefs(buildTaskRef(context, task), flags.taskRefs),
  });
}

module.exports = { sendTaskNotification };
