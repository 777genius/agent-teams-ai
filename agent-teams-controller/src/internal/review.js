const kanban = require('./kanban.js');
const kanbanStore = require('./kanbanStore.js');
const messages = require('./messages.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const reviewStateHelpers = require('./reviewState.js');
const tasks = require('./tasks.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { wrapAgentBlock } = require('./agentBlocks.js');

function warnNonCritical(message, error) {
  if (typeof console === 'undefined' || typeof console.warn !== 'function') {
    return;
  }
  console.warn(`${message}: ${error instanceof Error ? error.message : String(error)}`);
}

function getReviewer(context, flags) {
  if (typeof flags.reviewer === 'string' && flags.reviewer.trim()) {
    return flags.reviewer.trim();
  }
  const state = kanban.getKanbanState(context);
  return typeof state.reviewers[0] === 'string' && state.reviewers[0].trim()
    ? state.reviewers[0].trim()
    : null;
}

function resolveLeadSessionId(context, flags) {
  return runtimeHelpers.resolveCanonicalLeadSessionId(context.paths, flags.leadSessionId);
}

function getReviewStateFromHistory(task) {
  const result = reviewStateHelpers.getReviewStateFromHistory(task);
  return result ? result.state : null;
}

function getCurrentReviewState(task) {
  return getReviewStateFromHistory(task) || 'none';
}

function getEffectiveReviewState(context, task) {
  const state = kanban.getKanbanState(context);
  const kanbanEntry = state.tasks ? state.tasks[task.id] : undefined;
  return reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry).state;
}

function getLatestReviewRequestEvent(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event.type === 'review_requested') return event;
    if (
      event.type === 'task_created' ||
      (event.type === 'status_changed' &&
        (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted'))
    ) return null;
  }
  return null;
}

function getLatestReviewRequestedReviewer(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'review_requested') {
      return typeof e.reviewer === 'string' && e.reviewer.trim() ? e.reviewer.trim() : null;
    }
    if (
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      e.type === 'review_completed' ||
      e.type === 'human_approved' ||
      (e.type === 'status_changed' &&
        (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')) ||
      e.type === 'task_created'
    ) {
      return null;
    }
  }
  return null;
}

function normalizeActorKey(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function closeTimestampForInterval(interval, timestamp) {
  const startedAtMs = Date.parse(interval.startedAt);
  const timestampMs = Date.parse(timestamp);
  if (Number.isFinite(startedAtMs) && Number.isFinite(timestampMs) && timestampMs < startedAtMs) {
    return interval.startedAt;
  }
  return timestamp;
}

function isOpenReviewInterval(interval) {
  return interval && interval.completedAt === undefined;
}

function openReviewInterval(task, reviewer, timestamp = new Date().toISOString()) {
  const reviewerName = typeof reviewer === 'string' && reviewer.trim() ? reviewer.trim() : '';
  if (!reviewerName) return false;
  const reviewerKey = normalizeActorKey(reviewerName);
  const intervals = Array.isArray(task.reviewIntervals) ? [...task.reviewIntervals] : [];
  let changed = false;
  let hasOpenForReviewer = false;
  const nextIntervals = intervals.map((interval) => {
    if (!isOpenReviewInterval(interval)) return interval;
    if (normalizeActorKey(interval.reviewer) === reviewerKey) {
      hasOpenForReviewer = true;
      return interval;
    }
    changed = true;
    return { ...interval, completedAt: closeTimestampForInterval(interval, timestamp) };
  });
  if (hasOpenForReviewer) {
    task.reviewIntervals = nextIntervals;
    return changed;
  }
  task.reviewIntervals = [...nextIntervals, { reviewer: reviewerName, startedAt: timestamp }];
  return true;
}

function closeReviewIntervals(task, timestamp = new Date().toISOString()) {
  if (!Array.isArray(task.reviewIntervals)) return false;
  let changed = false;
  task.reviewIntervals = task.reviewIntervals.map((interval) => {
    if (!isOpenReviewInterval(interval)) return interval;
    changed = true;
    return { ...interval, completedAt: closeTimestampForInterval(interval, timestamp) };
  });
  return changed;
}

function resolveKnownActorName(context, value, label) {
  const actor = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!actor) return null;
  return runtimeHelpers.assertExplicitTeamMemberName(context.paths, actor, label, {
    allowLeadAliases: true,
  });
}

function tryResolveKnownActorName(context, value, label) {
  try {
    return resolveKnownActorName(context, value, label);
  } catch {
    return null;
  }
}

function resolveActorIdentityKey(context, value) {
  const actor = typeof value === 'string' && value.trim() ? value.trim() : '';
  if (!actor) return '';
  const resolved = runtimeHelpers.resolveExplicitTeamMemberName(context.paths, actor, {
    allowLeadAliases: true,
  });
  return normalizeActorKey(resolved || actor);
}

function isLeadActor(context, value) {
  const key = normalizeActorKey(value);
  const resolvedKey = resolveActorIdentityKey(context, value);
  const leadKey = normalizeActorKey(runtimeHelpers.inferLeadName(context.paths));
  return key === 'lead' || key === 'team-lead' || (leadKey && resolvedKey === leadKey);
}

function assertMatchesAssignedReviewer(context, task, actor, actionName) {
  const assignedReviewer = getLatestReviewRequestedReviewer(task);
  if (!assignedReviewer || isLeadActor(context, actor)) {
    return;
  }
  const assignedKey = resolveActorIdentityKey(context, assignedReviewer);
  const actorKey = resolveActorIdentityKey(context, actor);
  if (assignedKey && actorKey && assignedKey !== actorKey) {
    throw new Error(
      `Task #${task.displayId || task.id} is assigned to reviewer ${assignedReviewer}; ${actor} cannot ${actionName}`
    );
  }
}

function getReviewStartActor(context, task, flags) {
  if (typeof flags.from === 'string' && flags.from.trim()) {
    const actor = resolveKnownActorName(context, flags.from, 'review actor');
    assertMatchesAssignedReviewer(context, task, actor, 'start review');
    return actor;
  }

  const requestedReviewer = getLatestReviewRequestedReviewer(task);
  if (requestedReviewer) {
    return resolveKnownActorName(context, requestedReviewer, 'reviewer');
  }

  const state = kanban.getKanbanState(context);
  const kanbanEntry = state.tasks ? state.tasks[task.id] : undefined;
  if (kanbanEntry && typeof kanbanEntry.reviewer === 'string' && kanbanEntry.reviewer.trim()) {
    return resolveKnownActorName(context, kanbanEntry.reviewer, 'reviewer');
  }

  throw new Error(
    `review_start requires from when task #${task.displayId || task.id} has no assigned reviewer`
  );
}

function getLatestReviewStartedActor(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'review_started') {
      return typeof e.actor === 'string' && e.actor.trim() ? e.actor.trim() : null;
    }
    if (
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      e.type === 'review_completed' ||
      e.type === 'human_approved' ||
      (e.type === 'status_changed' &&
        (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')) ||
      e.type === 'task_created'
    ) {
      return null;
    }
  }
  return null;
}

function getReviewDecisionActor(context, task, flags, actionName) {
  const explicit = resolveKnownActorName(context, flags.from, 'review actor');
  const startedActor = tryResolveKnownActorName(
    context,
    getLatestReviewStartedActor(task),
    'review actor'
  );
  const assignedReviewer = tryResolveKnownActorName(
    context,
    getLatestReviewRequestedReviewer(task),
    'reviewer'
  );
  const inferredActor =
    startedActor &&
    (!assignedReviewer ||
      resolveActorIdentityKey(context, startedActor) ===
        resolveActorIdentityKey(context, assignedReviewer))
      ? startedActor
      : assignedReviewer;
  const actor =
    explicit || inferredActor || resolveKnownActorName(context, 'team-lead', 'review actor');
  assertMatchesAssignedReviewer(context, task, actor, actionName);
  return actor;
}

function assertReviewTransitionAllowed(context, task, transitionName) {
  if (task.status === 'deleted') {
    throw new Error(`Task #${task.displayId || task.id} is deleted`);
  }
  if (task.status !== 'completed') {
    throw new Error(
      `Task #${task.displayId || task.id} must be completed before ${transitionName}`
    );
  }

  const reviewState = getEffectiveReviewState(context, task);
  if (reviewState !== 'review') {
    throw new Error(
      `Task #${task.displayId || task.id} must be in review before ${transitionName}`
    );
  }
  return reviewState;
}

function getLatestReviewLifecycleEvent(task) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (
      e.type === 'review_requested' ||
      e.type === 'review_changes_requested' ||
      e.type === 'review_approved' ||
      e.type === 'review_completed' ||
      e.type === 'human_approved' ||
      e.type === 'review_started'
    ) {
      return e;
    }
    if (
      e.type === 'status_changed' &&
      (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')
    ) {
      return e;
    }
    if (e.type === 'task_created') {
      return e;
    }
  }
  return null;
}

function startReview(context, taskId, flags = {}) {
  return withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    if (task.status === 'deleted') {
      throw new Error(`Task #${task.displayId || task.id} is deleted`);
    }

    const latestReviewEvent = getLatestReviewLifecycleEvent(task);
    const prevReviewState = getEffectiveReviewState(context, task);

    if (latestReviewEvent && latestReviewEvent.type === 'review_started') {
      assertReviewTransitionAllowed(context, task, 'starting review');
      const existingActor =
        typeof latestReviewEvent.actor === 'string' ? latestReviewEvent.actor.trim() : '';
      const existingActorValid = existingActor
        ? Boolean(
            runtimeHelpers.resolveExplicitTeamMemberName(context.paths, existingActor, {
              allowLeadAliases: true,
            })
          )
        : false;
      const assignedReviewer = tryResolveKnownActorName(
        context,
        getLatestReviewRequestedReviewer(task),
        'reviewer'
      );
      const existingMatchesAssigned =
        !assignedReviewer ||
        (existingActorValid &&
          resolveActorIdentityKey(context, existingActor) ===
            resolveActorIdentityKey(context, assignedReviewer));
      const requestedActor =
        typeof flags.from === 'string' && flags.from.trim()
          ? getReviewStartActor(context, task, flags)
          : null;
      if (
        existingActorValid &&
        existingMatchesAssigned &&
        requestedActor &&
        resolveActorIdentityKey(context, existingActor) !==
          resolveActorIdentityKey(context, requestedActor)
      ) {
        throw new Error(
          `Task #${task.displayId || task.id} review is already started by ${existingActor}`
        );
      }
      kanban.setKanbanColumn(context, task.id, 'review', { transition: 'start_review' });
      if (!existingActorValid || !existingMatchesAssigned) {
        const repairedActor = requestedActor || getReviewStartActor(context, task, flags);
        const timestamp = new Date().toISOString();
        tasks.updateTask(context, task.id, (t) => {
          openReviewInterval(t, repairedActor, timestamp);
          t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
            type: 'review_started',
            from: prevReviewState,
            to: 'review',
            actor: repairedActor,
            timestamp,
          });
          t.reviewState = 'review';
          return t;
        });
      } else {
        tasks.updateTask(context, task.id, (t) => {
          openReviewInterval(t, existingActor, latestReviewEvent.timestamp);
          return t;
        });
      }
      return { ok: true, taskId: task.id, displayId: task.displayId, column: 'review',
        reviewRequestId: getLatestReviewRequestEvent(task)?.id ?? null };
    }

    assertReviewTransitionAllowed(context, task, 'starting review');
    const from = getReviewStartActor(context, task, flags);
    const timestamp = new Date().toISOString();

    try {
      kanban.setKanbanColumn(context, task.id, 'review', { transition: 'start_review' });
      tasks.updateTask(context, task.id, (t) => {
        openReviewInterval(t, from, timestamp);
        t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
          type: 'review_started',
          from: prevReviewState,
          to: 'review',
          actor: from,
          timestamp,
        });
        t.reviewState = 'review';
        return t;
      });
      return { ok: true, taskId: task.id, displayId: task.displayId, column: 'review',
        reviewRequestId: getLatestReviewRequestEvent(task)?.id ?? null };
    } catch (error) {
      try {
        kanban.clearKanban(context, task.id, { transition: 'rollback' });
      } catch (rollbackError) {
        warnNonCritical(
          `[review] rollback failed while starting review for ${task.id}`,
          rollbackError
        );
      }
      throw error;
    }
  });
}

function requestReview(context, taskId, flags = {}) {
  const { task, reviewer, from, leadSessionId, reviewRequestId, humanOnlyApproval } = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    if (currentTask.status !== 'completed') {
      throw new Error(
        `Task #${currentTask.displayId || currentTask.id} must be completed before review`
      );
    }

    const nextFrom =
      resolveKnownActorName(context, flags.from, 'review requester') ||
      resolveKnownActorName(context, 'team-lead', 'review requester');
    const rawReviewer = getReviewer(context, flags);
    const nextReviewer = rawReviewer
      ? resolveKnownActorName(context, rawReviewer, 'reviewer')
      : null;
    const prevReviewState = getEffectiveReviewState(context, currentTask);
    if (prevReviewState === 'approved') {
      throw new Error(
        `Task #${currentTask.displayId || currentTask.id} is already approved; reopen work before requesting another review`
      );
    }

    try {
      kanban.setKanbanColumn(context, currentTask.id, 'review', { transition: 'request_review' });
      tasks.updateTask(context, currentTask.id, (t) => {
        t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
          type: 'review_requested',
          from: prevReviewState,
          to: 'review',
          ...(nextReviewer ? { reviewer: nextReviewer } : {}),
          actor: nextFrom,
        });
        t.reviewState = 'review';
        return t;
      });
    } catch (error) {
      try {
        kanban.clearKanban(context, currentTask.id, { transition: 'rollback' });
      } catch (rollbackError) {
        warnNonCritical(
          `[review] rollback failed while requesting review for ${currentTask.id}`,
          rollbackError
        );
      }
      throw error;
    }

    return {
      task: tasks.getTask(context, currentTask.id),
      reviewer: nextReviewer,
      from: nextFrom,
      leadSessionId: resolveLeadSessionId(context, flags),
      reviewRequestId: getLatestReviewRequestEvent(tasks.getTask(context, currentTask.id))?.id,
      humanOnlyApproval: kanban.getKanbanState(context).humanOnlyApproval === true,
    };
  });

  if (!reviewer) {
    return task;
  }

  try {
    messages.sendMessage(context, {
      to: reviewer,
      from,
      text:
        `**Please review** task #${task.displayId || task.id}\n\n` +
        wrapAgentBlock(
          `This request is for the CURRENT review cycle (reviewRequestId: ${reviewRequestId}). Save the ID and pass it unchanged to review_complete as expectedReviewRequestId; do not fetch the latest ID at completion time.\n\nIf you reviewed this task earlier, do not treat this message as a duplicate while the task is still in review; prior approvals become stale after later work.\n\n` +
            `Before declaring it duplicate, call task_get and check the current reviewState/status. If it is still in review for you, continue with the review tools below.\n\n` +
            `FIRST call review_start to signal you are beginning the review:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>" }\n\n` +
            (humanOnlyApproval
              ? `When review is complete, use MCP tool review_complete (not review_approve):\n` +
                `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>", expectedReviewRequestId: "${reviewRequestId}", note?: "<optional note>" }\n\n`
              : `When approved, use MCP tool review_approve:\n` +
                `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>", note?: "<optional note>", notifyOwner: true }\n\n`) +
            `If changes are needed, use MCP tool review_request_changes:\n` +
            `{ teamName: "${context.teamName}", taskId: "${task.id}", from: "<your-name>", comment: "..."` +
            (humanOnlyApproval ? `, expectedReviewRequestId: "${reviewRequestId}"` : '') + ` }`
        ),
      summary: `Review request for #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  } catch (error) {
    warnNonCritical(`[review] reviewer notification failed for task ${task.id}`, error);
  }

  return task;
}


/** Finish a particular AI review cycle without granting human acceptance. */
function completeReview(context, taskId, flags = {}) {
  const result = withTeamBoardLock(context.paths, () => {
    const task = tasks.getTask(context, taskId);
    const expectedId = typeof flags.expectedReviewRequestId === 'string'
      ? flags.expectedReviewRequestId.trim() : '';
    if (!expectedId) throw new Error('review_complete requires expectedReviewRequestId');
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
      return { duplicate: true, payload: {
        ok: true, taskId: task.id, displayId: task.displayId,
        column: state === 'approved' ? 'approved' : 'done',
        reviewState: state, reviewRequestId: expectedId, alreadyCompleted: true,
      } };
    }
    assertReviewTransitionAllowed(context, task, 'completing review');
    const actor = getReviewDecisionActor(context, task, flags, 'complete review');
    const note = typeof flags.note === 'string' && flags.note.trim()
      ? flags.note.trim() : 'AI review completed';
    const timestamp = new Date().toISOString();
    tasks.updateTask(context, task.id, (current) => {
      closeReviewIntervals(current, timestamp);
      current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
        type: 'review_completed', from: 'review', to: 'reviewed',
        reviewRequestId: expectedId, note, actor, timestamp,
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
    }, task: tasks.getTask(context, task.id), actor, note,
    leadSessionId: resolveLeadSessionId(context, flags),
    humanOnlyApproval: kanban.getKanbanState(context).humanOnlyApproval === true };
  });
  if (result.duplicate) return result.payload;
  try {
    const event = [...(result.task.historyEvents || [])].reverse()
      .find((item) => item.type === 'review_completed' &&
        item.reviewRequestId === result.payload.reviewRequestId);
    tasks.notifyUnblockedOwners(context, result.task, { reviewCycleId: event?.id });
  } catch (error) {
    warnNonCritical('[review] dependency review completion notification failed', error);
  }
  try {
    messages.sendMessage(context, {
      to: runtimeHelpers.inferLeadName(context.paths),
      from: result.actor,
      text: `AI review completed for task #${result.task.displayId || result.task.id}. The task is in Done${result.humanOnlyApproval ? ' awaiting human acceptance' : ''}.\n\n${result.note}`,
      summary: `AI review completed #${result.task.displayId || result.task.id}`,
      source: 'system_notification',
      ...(result.leadSessionId ? { leadSessionId: result.leadSessionId } : {}),
    });
  } catch (error) {
    warnNonCritical(`[review] lead notification failed for task ${result.task.id}`, error);
  }
  return result.payload;
}

/**
 * Main-process user action only. Never expose through agent MCP/CLI or HTTP.
 * No caller-supplied "human" or actor flag can grant this authority.
 */
function approveAsHuman(context, taskId) {
  const result = withTeamBoardLock(context.paths, () => {
    if (kanban.getKanbanState(context).humanOnlyApproval !== true) {
      throw new Error('Human-only approval policy is not enabled');
    }
    const task = tasks.getTask(context, taskId);
    if (task.status !== 'completed') {
      throw new Error(`Task #${task.displayId || task.id} must be completed before human approval`);
    }
    const prevReviewState = getEffectiveReviewState(context, task);
    if (prevReviewState === 'approved') {
      return { task: task, alreadyApproved: true };
    }
    const timestamp = new Date().toISOString();
    // Placement and review history share the same board lock.
    kanbanStore.setKanbanColumn(context.paths, context.teamName, task.id, 'approved');
    tasks.updateTask(context, task.id, (current) => {
      closeReviewIntervals(current, timestamp);
      current.historyEvents = tasks.appendHistoryEvent(current.historyEvents, {
        type: 'human_approved', from: prevReviewState, to: 'approved',
        actor: 'user', timestamp,
      });
      current.reviewState = 'approved';
      return current;
    });
    return { task: tasks.getTask(context, task.id), alreadyApproved: false };
  });
  if (!result.alreadyApproved) {
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

function approveReview(context, taskId, flags = {}) {
  const result = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    if (kanban.getKanbanState(context).humanOnlyApproval === true) {
      throw new Error('Human approval required: reviewer must use review_complete');
    }
    const nextFrom = getReviewDecisionActor(context, currentTask, flags, 'approve review');
    const nextNote =
      typeof flags.note === 'string' && flags.note.trim() ? flags.note.trim() : 'Approved';
    const suppressTaskComment = flags.suppressTaskComment === true;
    const prevReviewState = getEffectiveReviewState(context, currentTask);

    if (currentTask.status === 'deleted') {
      throw new Error(`Task #${currentTask.displayId || currentTask.id} is deleted`);
    }

    if (prevReviewState === 'approved') {
      if (currentTask.status !== 'completed') {
        throw new Error(
          `Task #${currentTask.displayId || currentTask.id} must be completed before approval`
        );
      }
      kanban.setKanbanColumn(context, currentTask.id, 'approved', { transition: 'approve_review' });
      return {
        alreadyApproved: true,
        payload: {
          ok: true,
          taskId: currentTask.id,
          displayId: currentTask.displayId,
          column: 'approved',
          alreadyApproved: true,
        },
      };
    }

    assertReviewTransitionAllowed(context, currentTask, 'approval');
    const timestamp = new Date().toISOString();

    kanban.setKanbanColumn(context, currentTask.id, 'approved', { transition: 'approve_review' });
    tasks.updateTask(context, currentTask.id, (t) => {
      closeReviewIntervals(t, timestamp);
      t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
        type: 'review_approved',
        from: prevReviewState,
        to: 'approved',
        ...(nextNote ? { note: nextNote } : {}),
        actor: nextFrom,
        timestamp,
      });
      t.reviewState = 'approved';
      return t;
    });

    if (!suppressTaskComment) {
      tasks.addTaskComment(context, currentTask.id, {
        text: nextNote,
        from: nextFrom,
        type: 'review_approved',
        notifyOwner: false,
      });
    }

    return {
      alreadyApproved: false,
      payload: tasks.getTask(context, currentTask.id),
      from: nextFrom,
      note: nextNote,
      leadSessionId: resolveLeadSessionId(context, flags),
      shouldNotifyOwner:
        (flags.notify === true || flags['notify-owner'] === true) && Boolean(currentTask.owner),
    };
  });

  try {
    const approvedTask = tasks.getTask(context, taskId);
    const history = Array.isArray(approvedTask.historyEvents) ? approvedTask.historyEvents : [];
    const approval = [...history].reverse().find((event) => event && event.type === 'review_approved');
    tasks.notifyUnblockedOwners(context, approvedTask, { reviewCycleId: approval && approval.id });
  } catch (error) {
    warnNonCritical('[review] dependency approval notification failed', error);
  }

  if (result.alreadyApproved) {
    return result.payload;
  }

  const { payload: task, from, note, leadSessionId, shouldNotifyOwner } = result;

  if (shouldNotifyOwner && task.owner) {
    try {
      messages.sendMessage(context, {
        to: task.owner,
        from,
        text:
          note && note !== 'Approved'
            ? `@${from} **approved** task #${task.displayId || task.id}\n\n${note}`
            : `@${from} **approved** task #${task.displayId || task.id}`,
        summary: `Approved #${task.displayId || task.id}`,
        source: 'system_notification',
        ...(leadSessionId ? { leadSessionId } : {}),
      });
    } catch (error) {
      warnNonCritical(`[review] owner approval notification failed for task ${task.id}`, error);
    }
  }

  return task;
}

function requestChanges(context, taskId, flags = {}) {
  return requestChangesWithAuthority(context, taskId, flags, false);
}

// Trusted desktop user path. No MCP/CLI/public HTTP tool exposes this method.
function requestChangesAsHuman(context, taskId, flags = {}) {
  return requestChangesWithAuthority(context, taskId, flags, true);
}

function requestChangesWithAuthority(context, taskId, flags, fromHuman) {
  const { task, from, comment, leadSessionId } = withTeamBoardLock(context.paths, () => {
    const currentTask = tasks.getTask(context, taskId);
    if (!currentTask.owner) {
      throw new Error(`No owner found for task ${String(taskId)}`);
    }

    const currentReviewState = getEffectiveReviewState(context, currentTask);
    if (fromHuman) {
      if (currentTask.status !== 'completed' ||
          (currentReviewState !== 'review' && currentReviewState !== 'reviewed')) {
        throw new Error('Human rejection requires active Review or reviewed Done');
      }
    } else if (kanban.getKanbanState(context).humanOnlyApproval === true) {
      const expectedId = typeof flags.expectedReviewRequestId === 'string'
        ? flags.expectedReviewRequestId.trim() : '';
      const currentId = getLatestReviewRequestEvent(currentTask)?.id;
      if (!expectedId || expectedId !== currentId) {
        throw new Error('Stale review request: review_request_changes requires current expectedReviewRequestId');
      }
    }
    const nextFrom = fromHuman
      ? 'user'
      : getReviewDecisionActor(context, currentTask, flags, 'request changes');
    const nextComment =
      typeof flags.comment === 'string' && flags.comment.trim()
        ? flags.comment.trim()
        : 'Reviewer requested changes.';
    const prevReviewState = fromHuman
      ? currentReviewState
      : assertReviewTransitionAllowed(context, currentTask, 'requesting changes');
    const timestamp = new Date().toISOString();

    tasks.updateTask(context, currentTask.id, (t) => {
      closeReviewIntervals(t, timestamp);
      t.historyEvents = tasks.appendHistoryEvent(t.historyEvents, {
        type: 'review_changes_requested',
        from: prevReviewState,
        to: 'needsFix',
        ...(nextComment ? { note: nextComment } : {}),
        actor: nextFrom,
        timestamp,
      });
      t.reviewState = 'needsFix';
      return t;
    });

    kanban.clearKanban(context, currentTask.id, {
      nextReviewState: 'needsFix',
      transition: 'request_changes',
    });
    tasks.setTaskStatus(context, currentTask.id, 'pending', nextFrom, {
      trustedInternalWrite: true,
    });
    tasks.addTaskComment(context, currentTask.id, {
      text: nextComment,
      from: fromHuman ? runtimeHelpers.inferLeadName(context.paths) : nextFrom,
      type: 'review_request',
      ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
      notifyOwner: false,
    });

    return {
      task: tasks.getTask(context, currentTask.id),
      from: nextFrom,
      comment: nextComment,
      leadSessionId: resolveLeadSessionId(context, flags),
    };
  });

  try {
    (fromHuman ? messages.sendTrustedMessage : messages.sendMessage)(context, {
      to: task.owner,
      from,
      text:
        `@${from} **requested changes** for task #${task.displayId || task.id}\n\n${comment}\n\n` +
        'The task has been moved back to pending. When you are ready to resume, review the task context, start it explicitly, implement the fixes, mark it completed, and request review again.',
      ...(Array.isArray(flags.taskRefs) ? { taskRefs: flags.taskRefs } : {}),
      summary: `Fix request for #${task.displayId || task.id}`,
      source: 'system_notification',
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  } catch (error) {
    warnNonCritical(`[review] owner fix-request notification failed for task ${task.id}`, error);
  }

  return task;
}

module.exports = {
  approveReview,
  approveAsHuman,
  completeReview,
  requestReview,
  requestChanges,
  requestChangesAsHuman,
  startReview,
};
