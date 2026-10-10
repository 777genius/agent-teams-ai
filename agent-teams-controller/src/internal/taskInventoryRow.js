const INVENTORY_KANBAN_COLUMNS = new Set(['review', 'approved']);

function buildTaskInventoryRow(task, reviewState, kanbanEntry, subject) {
  return {
    id: task.id,
    displayId: task.displayId,
    subject,
    status: task.status,
    ...(typeof task.owner === 'string' && task.owner.trim() ? { owner: task.owner } : {}),
    reviewState,
    ...(task.groupChatId ? { groupChatId: task.groupChatId } : {}),
    ...(kanbanEntry && INVENTORY_KANBAN_COLUMNS.has(kanbanEntry.column)
      ? { kanbanColumn: kanbanEntry.column }
      : {}),
    ...(task.needsClarification ? { needsClarification: task.needsClarification } : {}),
    ...(Array.isArray(task.blockedBy) && task.blockedBy.length > 0
      ? { blockedBy: task.blockedBy }
      : {}),
    ...(Array.isArray(task.blocks) && task.blocks.length > 0 ? { blocks: task.blocks } : {}),
    ...(Array.isArray(task.related) && task.related.length > 0 ? { related: task.related } : {}),
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    ...(typeof task.createdAt === 'string' && task.createdAt.trim()
      ? { createdAt: task.createdAt }
      : {}),
    ...(typeof task.updatedAt === 'string' && task.updatedAt.trim()
      ? { updatedAt: task.updatedAt }
      : {}),
  };
}

module.exports = { buildTaskInventoryRow, INVENTORY_KANBAN_COLUMNS };
