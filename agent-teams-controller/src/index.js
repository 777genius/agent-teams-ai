const controller = require('./controller.js');
const mcpToolCatalog = require('./mcpToolCatalog.js');

module.exports = {
  ...controller,
  buildTaskCommentForwardNotificationText: require('./internal/taskCommentNotification.js').buildTaskCommentForwardNotificationText,
  validateKanbanSafetyState: require('./internal/kanbanStore.js').validateSafetyState,
  ...mcpToolCatalog,
};
