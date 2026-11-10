const path = require('path');

function unreadableTaskAnomaly(filePath, error) {
  return {
    code: 'unreadable_task',
    taskId: path.basename(filePath, '.json'),
    filePath,
    detail: error instanceof Error ? error.message : 'Unreadable task row',
  };
}

function taskNotFound(taskRef) {
  return Object.assign(new Error(`Task not found: ${taskRef}`), { code: 'TASK_NOT_FOUND' });
}

function assertReadableTaskRef(scan, taskRef) {
  const anomaly = scan.anomalies.find((row) => row.code === 'unreadable_task' && row.taskId === taskRef);
  if (anomaly) {
    throw Object.assign(new Error(`Cannot read task ${taskRef}: ${anomaly.detail}`), {
      code: 'TASK_UNREADABLE',
    });
  }
}

module.exports = { unreadableTaskAnomaly, taskNotFound, assertReadableTaskRef };
