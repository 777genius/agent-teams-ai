const messageStore = require('./messageStore.js');

function sendMessage(context, flags) {
  return messageStore.sendInboxMessage(context.paths, flags);
}

function appendSentMessage(context, flags) {
  return messageStore.appendSentMessage(context.paths, flags);
}

module.exports = {
  appendSentMessage,
  sendMessage,
};
