const { withTeamBoardLock } = require('./boardLock.js');
const kanbanStore = require('./kanbanStore.js');
const taskStore = require('./taskStore.js');
const tasks = require('./tasks.js');
const { getEffectiveReviewState, normalizeTaskSemanticSnapshot } = require('./reviewState.js');
const taskSemantics = require('../task-semantics.js');
const STATUS_BY_COLUMN = Object.freeze({ todo: 'pending', in_progress: 'in_progress', done: 'completed' });

function latestReviewResetId(task) {
    const history = Array.isArray(task.historyEvents) ? task.historyEvents : [];
    return [...history].reverse().find((event) => event && event.type === 'review_reset')?.id;
}

/** Clear a completed review cycle before a status-column move, under the board lock. */
function resetTaskReviewForDone(context, taskId) {
    return withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        const kanbanState = kanbanStore.readKanbanState(context.paths, context.teamName);
        const placement = kanbanState.tasks && kanbanState.tasks[before.id];
        const review = getEffectiveReviewState(before, placement);
        const completedReview = getEffectiveReviewState({ ...before, status: 'completed' }, placement);
        const needsReset = review.state !== 'none' || completedReview.state !== 'none' || before.reviewState !== 'none';
        const hasPlacement = tasks.hasKanbanReference(kanbanState, before.id);
        if (!needsReset && !hasPlacement) return before;

        if (hasPlacement) {
            kanbanStore.clearKanban(context.paths, context.teamName, before.id, { nextReviewState: 'none' });
        }
        if (!needsReset) {
            return taskStore.readTask(context.paths, before.id, { includeDeleted: true });
        }
        return taskStore.updateTask(context.paths, before.id, (task) => {
            const timestamp = new Date().toISOString();
            task.reviewState = 'none';
            if (Array.isArray(task.reviewIntervals)) {
                task.reviewIntervals = task.reviewIntervals.map((interval) =>
                    interval.completedAt === undefined
                        ? { ...interval, completedAt: Date.parse(interval.startedAt) > Date.parse(timestamp) ? interval.startedAt : timestamp }
                        : interval
                );
            }
            task.historyEvents = taskStore.appendHistoryEvent(task.historyEvents, {
                type: 'review_reset',
                from: review.state === 'none' ? completedReview.state : review.state,
                to: 'none',
                reason: 'move_back_to_done',
                timestamp,
            });
            return task;
        });
    });
}

/** Prevalidate and apply a status-column move under one synchronous board lock. */
function moveTaskToStatusColumn(context, taskId, column, actor, options = {}) {
    if (!Object.hasOwn(STATUS_BY_COLUMN, column)) {
        throw new Error(`Invalid task status column: ${String(column)}`);
    }
    const targetStatus = STATUS_BY_COLUMN[column];

    const outcome = withTeamBoardLock(context.paths, () => {
        const before = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
        if (before.status === 'deleted') {
            throw new Error(`Task #${before.displayId || before.id} is deleted; use task_restore before changing status`);
        }
        const board = kanbanStore.readKanbanState(context.paths, context.teamName);
        const placement = board.tasks && board.tasks[before.id];
        const blockers = (Array.isArray(before.blockedBy) ? before.blockedBy : []).map((key) => {
            try {
                const blocker = taskStore.readTask(context.paths, key, { includeDeleted: true });
                return { kind: 'known_task', key, task: normalizeTaskSemanticSnapshot(blocker, null) };
            } catch (error) {
                if (error && error.code === 'TASK_NOT_FOUND') return { kind: 'known_absent', key };
                throw error;
            }
        });
        const decision = taskSemantics.planColumnTransition({
            task: normalizeTaskSemanticSnapshot(before, placement),
            targetColumn: column,
            blockers,
        });
        if (!decision.allowed) {
            const error = new Error(`Cannot move task #${before.displayId || before.id} to ${column}: ${decision.reason}`);
            error.code = 'TASK_COLUMN_TRANSITION_CONFLICT';
            error.reason = decision.reason;
            throw error;
        }
        if (decision.transition.kind === 'none') {
            return { task: before, needsFollowUp: column === 'done', reviewCycleId: latestReviewResetId(before) };
        }

        // Validate ownership before clearKanban or review_reset writes the first file.
        const actorForWrite = tasks.assertTaskOwnerMutation(context, before, actor, `set its status to ${targetStatus}`, {
            allowLeadOverride: targetStatus !== 'in_progress' && targetStatus !== 'completed',
        });
        let reviewCycleId;
        if (decision.transition.resetReview) {
            reviewCycleId = latestReviewResetId(resetTaskReviewForDone(context, before.id));
        } else if (tasks.hasKanbanReference(board, before.id)) {
            kanbanStore.clearKanban(context.paths, context.teamName, before.id, { nextReviewState: 'none' });
        }
        const task = before.status !== targetStatus
            ? taskStore.setTaskStatus(context.paths, before.id, targetStatus, actorForWrite)
            : taskStore.readTask(context.paths, before.id, { includeDeleted: true });
        return { task, needsFollowUp: targetStatus === 'completed', reviewCycleId };
    });
    if (options.deferFollowUps === true) return outcome;
    if (outcome.needsFollowUp) tasks.runCompletedTaskFollowUps(context, outcome.task, { reviewCycleId: outcome.reviewCycleId });
    return outcome.task;
}

function reconcileCompletedTaskFollowUps(context, taskId) {
    const task = taskStore.readTask(context.paths, taskId, { includeDeleted: true });
    if (task.status !== 'completed' || getEffectiveReviewState(task, null).state !== 'none') return;
    tasks.runCompletedTaskFollowUps(context, task, { reviewCycleId: latestReviewResetId(task) });
}

module.exports = { moveTaskToStatusColumn, reconcileCompletedTaskFollowUps };
