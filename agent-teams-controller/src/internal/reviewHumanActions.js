const kanban = require('./kanban.js');
const kanbanStore = require('./kanbanStore.js');
const messages = require('./messages.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const tasks = require('./tasks.js');
const { withTeamBoardLock } = require('./boardLock.js');
function createReviewHumanActions({
  getLatestReviewRequestEvent,
  getEffectiveReviewState,
  assertReviewTransitionAllowed,
  getReviewDecisionActor,
  closeReviewIntervals,
  resolveLeadSessionId,
  warnNonCritical,
  leadSignoff,
}) {
  /** Finish a particular AI review cycle without granting human acceptance. */
  function completeReview(context, taskId, flags = {}) {
    const result = withTeamBoardLock(context.paths, () => {
      const task = tasks.getTask(context, taskId);
      const expectedId = typeof flags.expectedReviewRequestId === 'string'
        ? flags.expectedReviewRequestId.trim() : '';
      if (!expectedId) throw new Error('review_complete requires expectedReviewRequestId');
      leadSignoff.assertExplicitActor(context, task, flags, 'review_complete');
      // A retry by the reviewer who handed off reports the sign-off request, not "stale".
      const handedOff = leadSignoff.findHandoff(context, task, expectedId, flags.from);
      if (handedOff) {
        const state = getEffectiveReviewState(context, task);
        return {
          handoff: { event: handedOff, replay: state === 'review' },
          payload: leadSignoff.buildPayload(task, handedOff, true, state),
          task, leadSessionId: resolveLeadSessionId(context, flags),
        };
      }
      const request = getLatestReviewRequestEvent(task);
      if (!request || request.id !== expectedId) {
        throw new Error(`Stale review request for task #${task.displayId || task.id}; review_complete rejected`);
      }
      if (task.status !== 'completed') {
        throw new Error(`Task #${task.displayId || task.id} must be completed before review completion`);
      }
      const state = getEffectiveReviewState(context, task);
      // A human may accept the completed cycle before its reviewer retries.
      // Return the actual state, without moving an Approved card back to Done.
      const completedCycle = [...(task.historyEvents || [])].reverse().find(
        (event) => event.type === 'review_completed' && event.reviewRequestId === expectedId
      );
      if (completedCycle && (state === 'reviewed' || state === 'approved')) {
        const placement = kanban.getKanbanState(context).tasks?.[task.id]?.column;
        if (state === 'reviewed' && placement === 'review') {
          // The task event committed but clearing the overlay failed. Repair the
          // placement and dispatch the original event's previously skipped notices.
          kanban.clearKanban(context, task.id, {
            transition: 'review_complete', nextReviewState: 'reviewed',
          });
        } else if (state === 'reviewed' && placement === 'approved') {
          throw new Error('Human approval placement awaits a recorded human decision');
        }
        return {
          duplicate: true,
          payload: {
            ok: true, taskId: task.id, displayId: task.displayId,
            column: state === 'approved' ? 'approved' : 'done',
            reviewState: state, reviewRequestId: expectedId, alreadyCompleted: true,
          },
          task: tasks.getTask(context, task.id),
          actor: completedCycle.actor,
          note: completedCycle.note || 'AI review completed',
          leadSessionId: resolveLeadSessionId(context, flags),
          humanApproval: kanban.isHumanApprovalFlow(context),
        };
      }
      assertReviewTransitionAllowed(context, task, 'completing review');
      const actor = getReviewDecisionActor(context, task, flags, 'complete review');
      const note = typeof flags.note === 'string' && flags.note.trim()
        ? flags.note.trim() : 'AI review completed';
      const plan = leadSignoff.planCompletion(context, task, actor, request);
      if (plan.leadName) {
        const event = leadSignoff.recordHandoff(context, task, {
          leadName: plan.leadName, actor, note: flags.note && String(flags.note).trim(), expectedReviewRequestId: expectedId,
        });
        const current = tasks.getTask(context, task.id);
        return {
          handoff: { event, replay: true },
          payload: leadSignoff.buildPayload(current, event, false, 'review'),
          task: current, leadSessionId: resolveLeadSessionId(context, flags),
        };
      }
      const timestamp = new Date().toISOString();
      tasks.updateTask(context, task.id, (current) => {
        closeReviewIntervals(current, timestamp);
        current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
          type: 'review_completed', from: 'review', to: 'reviewed',
          reviewRequestId: expectedId, note, actor, timestamp,
          ...(plan.skipped ? { leadSignoffSkipped: plan.skipped } : {}),
        });
        current.reviewState = 'reviewed';
        return current;
      });
      kanban.clearKanban(context, task.id, {
        transition: 'review_complete', nextReviewState: 'reviewed',
      });
      return { duplicate: false, payload: {
        ok: true, taskId: task.id, displayId: task.displayId, column: 'done',
        reviewState: 'reviewed', reviewRequestId: expectedId, alreadyCompleted: false,
        ...(plan.skipped ? { leadSignoffSkipped: plan.skipped } : {}),
      }, task: tasks.getTask(context, task.id), actor, note,
      leadSessionId: resolveLeadSessionId(context, flags),
      humanApproval: kanban.isHumanApprovalFlow(context) };
    });
    if (result.handoff) {
      if (result.handoff.replay) {
        leadSignoff.notifyLead(context, {
          task: result.task, event: result.handoff.event, leadSessionId: result.leadSessionId,
        });
      }
      return result.payload;
    }
    // Retry post-commit notices with the same event ID. Inbox rows and dependency
    // comments deduplicate it, even if a prior overlay write already succeeded.
    const event = [...(result.task.historyEvents || [])].reverse()
      .find((item) => item.type === 'review_completed' &&
        item.reviewRequestId === result.payload.reviewRequestId);
    try {
      tasks.notifyUnblockedOwners(context, result.task, { reviewCycleId: event?.id });
    } catch (error) {
      warnNonCritical('[review] dependency review completion notification failed', error);
    }
    if (!leadSignoff.isSelfNotice(context, result.actor)) {
      try {
        messages.sendMessage(context, {
          to: runtimeHelpers.inferLeadName(context.paths),
          from: result.actor,
          text: `AI review completed for task #${result.task.displayId || result.task.id}. The task is in Done${result.humanApproval ? ' awaiting human acceptance' : ''}.\n\n${result.note}`,
          summary: `AI review completed #${result.task.displayId || result.task.id}`,
          ...(event?.id ? { messageId: event.id } : {}),
          source: 'system_notification',
          ...(result.leadSessionId ? { leadSessionId: result.leadSessionId } : {}),
        });
      } catch (error) {
        warnNonCritical(`[review] lead notification failed for task ${result.task.id}`, error);
      }
    }
    return result.payload;
  }

  /**
   * Main-process user action only. Never expose through agent MCP/CLI or HTTP.
   * No caller-supplied "human" or actor flag can grant this authority.
   */
  function approveAsHuman(context, taskId) {
    const result = withTeamBoardLock(context.paths, () => {
      const policyEnabled = kanban.isHumanApprovalFlow(context);
      const task = tasks.getTask(context, taskId);
      if (task.status !== 'completed') {
        throw new Error(`Task #${task.displayId || task.id} must be completed before human approval`);
      }
      const prevReviewState = getEffectiveReviewState(context, task);
      const recordedApproval = Array.isArray(task.historyEvents) &&
        task.historyEvents.some((event) =>
          event.type === 'human_approved' || event.type === 'review_approved'
        );
      // Finish a recorded approval whose overlay write failed, even if the user
      // disabled the policy before retrying this trusted UI action.
      if (!policyEnabled && prevReviewState !== 'reviewed' &&
          !(prevReviewState === 'approved' && recordedApproval)) {
        throw new Error('Human-only approval policy is not enabled');
      }
      if (prevReviewState === 'approved' && recordedApproval) {
        // Recreate missing placement after an interrupted file write, if needed.
        const recovered =
          kanban.getKanbanState(context).tasks?.[task.id]?.column !== 'approved';
        if (recovered) {
          kanbanStore.setKanbanColumn(context.paths, context.teamName, task.id, 'approved');
        }
        const humanEvent = [...(task.historyEvents || [])].reverse()
          .find((event) => event.type === 'human_approved');
        return {
          task: tasks.getTask(context, task.id),
          alreadyApproved: true,
          recovered,
          // Replay original dependency release even if the placement write succeeded
          // before a later failure; the human event ID deduplicates notices.
          releasesDependencies:
            humanEvent?.from === 'review' || humanEvent?.from === 'needsFix',
        };
      }
      const timestamp = new Date().toISOString();
      // History is committed first: if the overlay write fails, the same human
      // action retries the missing placement without duplicating acceptance.
      tasks.updateTask(context, task.id, (current) => {
        closeReviewIntervals(current, timestamp);
        current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
          type: 'human_approved', from: prevReviewState, to: 'approved',
          actor: 'user', timestamp,
        });
        current.reviewState = 'approved';
        return current;
      });
      kanbanStore.setKanbanColumn(context.paths, context.teamName, task.id, 'approved');
      return {
        task: tasks.getTask(context, task.id),
        alreadyApproved: false,
        // A reviewed Done task already released and notified dependents during
        // review_complete. Final human acceptance does not unblock them twice.
        releasesDependencies: prevReviewState === 'review' || prevReviewState === 'needsFix',
      };
    });
    if (result.releasesDependencies) {
      try {
        tasks.notifyUnblockedOwners(context, result.task, {
          reviewCycleId: [...(result.task.historyEvents || [])].reverse()
            .find((event) => event.type === 'human_approved')?.id,
        });
      } catch (error) {
        warnNonCritical('[review] dependency human approval notification failed', error);
      }
    }
    return result.task;
  }

  return { completeReview, approveAsHuman };
}

module.exports = { createReviewHumanActions };
