const fs = require('fs');
const path = require('path');
const { atomicWriteFileSync } = require('./atomicFile.js');
const kanbanStore = require('./kanbanStore.js');
const tasks = require('./tasks.js');
const { withTeamBoardLock } = require('./boardLock.js');

function createReviewDisapproval({ getEffectiveReviewState, closeReviewIntervals }) {
// Explicit human removal of approval; status/work intervals remain completed.
function disapproveReview(context, taskId, flags = {}) {
  if (flags.from !== 'user' || context.allowUserMessageSender !== true) {
    throw new Error('Only the trusted user can remove task approval');
  }
  return withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    if (task.status !== 'completed' || getEffectiveReviewState(context, task) !== 'approved') {
      throw new Error(`Task #${task.displayId || task.id} must be completed and approved`);
    }
    // This is synchronous rollback under the board lock, not a crash journal.
    kanbanStore.readKanbanState(context.paths, context.teamName, { strict: true });
    const taskPath = path.join(context.paths.tasksDir, `${task.id}.json`);
    const originalTask = fs.readFileSync(taskPath);
    let originalBoard;
    try {
      originalBoard = fs.readFileSync(context.paths.kanbanPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const timestamp = new Date().toISOString();
    try {
      kanbanStore.clearKanban(context.paths, context.teamName, task.id, { nextReviewState: 'none' });
      return tasks.updateTask(context, task.id, (current) => {
        closeReviewIntervals(current, timestamp);
        current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
          type: 'review_disapproved', from: 'approved', to: 'none', actor: 'user', timestamp,
        });
        current.reviewState = 'none';
        return current;
      });
    } catch (error) {
      const rollbackErrors = [];
      for (const [file, bytes] of [[taskPath, originalTask], [context.paths.kanbanPath, originalBoard]]) {
        try {
          if (bytes === undefined) fs.rmSync(file, { force: true });
          else atomicWriteFileSync(file, bytes);
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([error, ...rollbackErrors], 'Disapprove failed; approval rollback incomplete');
      }
      throw error;
    }
  });
}
  return disapproveReview;
}

module.exports = { createReviewDisapproval };
