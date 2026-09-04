/**
 * The board's single definition of "this task is still open work".
 *
 * Two independent places decide whether a board is finished: the board's own
 * completion notice to the lead (`notifyLeadWhenBoardCompleted` in `tasks.js`)
 * and the post-completion guard that stops a memoryless turn from restating its
 * final message to the user (`readBoardCompletionEpoch` in `messageStore.js`).
 * They must agree, or the same board is "done" for one of them and "open" for
 * the other, which either lets a restated final message through or suppresses a
 * message while review work is still on the board.
 *
 * A completed task that is in review or waiting for a fix is NOT finished: the
 * reviewer can still send it back, so work remains. A deleted task is not live
 * work and is therefore never open; `taskStore.listTasks` already drops deleted
 * rows unless the caller asks for them, so that arm only matters to a caller
 * that passes `includeDeleted`.
 *
 * Callers keep their own guard against a malformed row; this predicate answers
 * only for the task object it was given.
 */
function isTaskOpen(task) {
  if (task.status === 'deleted') return false;
  if (task.status !== 'completed') return true;
  return task.reviewState === 'review' || task.reviewState === 'needsFix';
}

module.exports = {
  isTaskOpen,
};
