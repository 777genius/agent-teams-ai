function buildTaskRef(context, task) {
  return {
    taskId: task.id,
    displayId: task.displayId || task.id,
    teamName: context.teamName,
  };
}

// Notification references may be partial; keep their first occurrence in order.
function mergeTaskRefs(primaryTaskRef, extraTaskRefs) {
  const refs = [primaryTaskRef, ...(Array.isArray(extraTaskRefs) ? extraTaskRefs : [])]
    .filter((ref) => ref && typeof ref === 'object');
  const seen = new Set();
  const merged = [];
  for (const ref of refs) {
    const taskId = typeof ref.taskId === 'string' ? ref.taskId.trim() : '';
    const displayId = typeof ref.displayId === 'string' ? ref.displayId.trim() : '';
    const teamName = typeof ref.teamName === 'string' ? ref.teamName.trim() : '';
    const key = `${teamName || ''}:${taskId || displayId}`;
    if ((!taskId && !displayId) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    merged.push({
      ...(taskId ? { taskId } : {}),
      ...(displayId ? { displayId } : {}),
      ...(teamName ? { teamName } : {}),
    });
  }
  return merged.length > 0 ? merged : undefined;
}

// Persisted task/comment references require all three identity fields.
function normalizeTaskRefs(taskRefs) {
  if (!Array.isArray(taskRefs) || taskRefs.length === 0) {
    return undefined;
  }

  const normalized = taskRefs
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      taskId: String(item.taskId || '').trim(),
      displayId: String(item.displayId || '').trim(),
      teamName: String(item.teamName || '').trim(),
    }))
    .filter((item) => item.taskId && item.displayId && item.teamName);

  return normalized.length > 0 ? normalized : undefined;
}

module.exports = {
  buildTaskRef,
  mergeTaskRefs,
  normalizeTaskRefs,
};
