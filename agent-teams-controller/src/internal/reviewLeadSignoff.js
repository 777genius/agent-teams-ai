const kanban = require('./kanban.js');
const messages = require('./messages.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const tasks = require('./tasks.js');
const reviewStateHelpers = require('./reviewState.js');
const { buildReviewRequestMessage } = require('./reviewRequestMessage.js');

/**
 * Lead sign-off stage of the `lead_then_human` review flow.
 *
 * The stage is not a new lifecycle: when the first reviewer completes the review, the controller
 * records ONE review_requested event addressed to the Lead (`stage: 'lead_signoff'`). The task
 * stays in Review, so every existing rule for an open review cycle applies to it: only the
 * assigned reviewer (the Lead) can decide it, a stale request id is rejected, and a human may
 * still accept or reject at any time. A Lead rejection starts a full cycle again.
 */
function createLeadSignoff({
  isLeadActor, resolveActorIdentityKey, getLatestReviewRequestEvent, closeReviewIntervals, warnNonCritical,
}) {
  /** Canonical Lead member name, or null when the team has no resolvable Lead. */
  function resolveLeadName(context) {
    return runtimeHelpers.resolveExplicitTeamMemberName(
      context.paths, runtimeHelpers.inferLeadName(context.paths), { allowLeadAliases: true }
    );
  }

  /**
   * Review decisions of this flow are attributed to a named actor. Inferring one (the assigned
   * reviewer, or the Lead as a last resort) would let a reviewer or an owner act as the Lead. The
   * rule also holds for an open sign-off cycle after the team switched to another flow.
   */
  function assertExplicitActor(context, task, flags, toolName) {
    const signoffOpen = reviewStateHelpers.getCurrentReviewStage(task) === 'lead_signoff';
    if (!signoffOpen && !kanban.isLeadSignoffFlow(context)) return;
    if (typeof flags.from !== 'string' || !flags.from.trim()) {
      throw new Error(`${toolName} requires an explicit "from" (the acting member) for a Lead sign-off or when reviewFlow is lead_then_human`);
    }
  }

  /**
   * Who submitted the work for this review: the actor of the latest completion before the request.
   * Owners can be reassigned by anyone, so ownership says nothing about who did the work.
   */
  function submittedBy(task, request) {
    const history = Array.isArray(task.historyEvents) ? task.historyEvents : [];
    const found = history.findIndex((event) => event && event.id === request.id);
    for (let i = (found >= 0 ? found : history.length) - 1; i >= 0; i -= 1) {
      const event = history[i];
      // The latest status change decides: a later reopen without a new completion means the
      // work was not submitted in this cycle, so an older completion must not count.
      if (event && event.type === 'status_changed') {
        if (event.to !== 'completed') return null;
        return typeof event.actor === 'string' && event.actor.trim() ? event.actor.trim() : null;
      }
    }
    return null;
  }

  /**
   * How a completed review continues in `lead_then_human`: `{ leadName }` hands off to the Lead,
   * `{ skipped }` closes the cycle as in `human_approval` (the Lead's own review, or review of work
   * the Lead submitted, already is the sign-off; without a Lead nobody can be asked), and
   * `{ skipped: null }` means the flow does not apply (other flows, or this IS the sign-off).
   * An unknown submitter never skips the step.
   */
  function planCompletion(context, task, actor, request) {
    if (!kanban.isLeadSignoffFlow(context) || request.stage === 'lead_signoff') return { skipped: null };
    if (isLeadActor(context, actor)) return { skipped: 'actor_is_lead' };
    const submitter = submittedBy(task, request);
    if (submitter && isLeadActor(context, submitter)) return { skipped: 'work_by_lead' };
    const leadName = resolveLeadName(context);
    return leadName ? { leadName } : { skipped: 'no_lead' };
  }

  /** The Lead does not need a "review completed" notice about its own decision. */
  function isSelfNotice(context, actor) {
    return kanban.isLeadSignoffFlow(context) && isLeadActor(context, actor);
  }

  /**
   * The sign-off request that followed the given first-stage request, for the SAME caller that
   * handed it off and only while it is still the latest request. Anyone else, or a later cycle,
   * gets the normal stale-request error.
   */
  function findHandoff(context, task, reviewRequestId, from) {
    const event = [...(task.historyEvents || [])].reverse().find(
      (entry) => entry.type === 'review_requested' &&
        entry.stage === 'lead_signoff' && entry.afterReviewRequestId === reviewRequestId
    );
    if (!event || typeof from !== 'string' || !from.trim()) return null;
    if (getLatestReviewRequestEvent(task)?.id !== event.id) return null;
    const caller = resolveActorIdentityKey(context, from);
    return caller && caller === resolveActorIdentityKey(context, event.actor) ? event : null;
  }

  /** Records the hand-off. Call inside the board lock; returns the new sign-off request event. */
  function recordHandoff(context, task, { leadName, actor, note, expectedReviewRequestId }) {
    const timestamp = new Date().toISOString();
    tasks.updateTask(context, task.id, (current) => {
      closeReviewIntervals(current, timestamp);
      current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
        type: 'review_requested', from: 'review', to: 'review', reviewer: leadName,
        stage: 'lead_signoff', afterReviewRequestId: expectedReviewRequestId,
        ...(note ? { note } : {}), actor, timestamp,
      });
      current.reviewState = 'review';
      return current;
    });
    return [...(tasks.getTask(context, task.id).historyEvents || [])].reverse().find(
      (event) => event.type === 'review_requested' && event.afterReviewRequestId === expectedReviewRequestId
    );
  }

  function buildPayload(task, event, alreadyCompleted, state) {
    const column = { review: 'review', reviewed: 'done', approved: 'approved' }[state] || 'none';
    return {
      ok: true, taskId: task.id, displayId: task.displayId, column, reviewState: state,
      stage: 'lead_signoff', handedOffTo: event.reviewer,
      reviewRequestId: event.afterReviewRequestId, leadSignoffRequestId: event.id, alreadyCompleted,
    };
  }

  /** Asks the Lead to sign off. The event id is the message id, so retries never duplicate it. */
  function notifyLead(context, { task, event, leadSessionId }) {
    try {
      const reviewPolicy = kanban.getReviewFlowPolicy(context);
      messages.sendMessage(context, {
        to: event.reviewer,
        from: event.actor,
        text: buildReviewRequestMessage({
          teamName: context.teamName, task, reviewRequestId: event.id, humanApproval: true,
          boundTaskTools: context.boundTaskTools,
          reviewFlowPrompt: reviewPolicy.reviewFlowPrompt, stage: 'lead_signoff',
          note: event.note, reviewerName: event.actor,
        }),
        summary: `Lead sign-off requested for #${task.displayId || task.id}`,
        messageId: event.id,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
      });
    } catch (error) {
      warnNonCritical(`[review] lead sign-off notification failed for task ${task.id}`, error);
    }
  }

  return {
    assertExplicitActor, buildPayload, findHandoff, isSelfNotice, notifyLead, planCompletion, recordHandoff,
  };
}

module.exports = { createLeadSignoff };
