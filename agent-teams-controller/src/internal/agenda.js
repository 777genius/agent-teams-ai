const kanbanStore = require('./kanbanStore.js');
const taskStore = require('./taskStore.js');
const runtimeHelpers = require('./runtimeHelpers.js');
const reviewStateHelpers = require('./reviewState.js');
const { withTeamBoardLock } = require('./boardLock.js');

const INVENTORY_KANBAN_COLUMNS = new Set(['review', 'approved']);
const MAX_MEMBER_ACTIONABLE_ITEMS = 50;
const MAX_MEMBER_AWARENESS_ITEMS = 30;
const MAX_LEAD_SECTION_ITEMS = 50;
const MAX_EXPANDED_CONTEXT_ITEMS = 8;
const MAX_DESCRIPTION_CHARS = 1200;
const MAX_COMMENT_CHARS = 500;
const MAX_SUBJECT_CHARS = 240;
const MAX_ANOMALY_ITEMS = 25;
const MAX_ANOMALY_DETAIL_CHARS = 500;

function normalizeName(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeKey(value) {
  return normalizeName(value).toLowerCase();
}

function formatTaskLabel(task) {
  return `#${task.displayId || task.id}`;
}

function isLeadCandidate(member) {
  return runtimeHelpers.isCanonicalLeadMember(member);
}

function buildQueueRoster(paths) {
  const resolved = runtimeHelpers.resolveTeamMembers(paths);
  const explicit = runtimeHelpers.collectExplicitTeamMembers(paths);
  const membersByKey = new Map();

  for (const member of resolved.members || []) {
    const key = normalizeKey(member && member.name);
    if (!key) continue;
    membersByKey.set(key, member);
  }

  const leadCandidates = (resolved.members || []).filter(isLeadCandidate);
  const uniqueLeadName = leadCandidates.length === 1 ? normalizeName(leadCandidates[0].name) : '';
  const inferredLeadName = normalizeName(runtimeHelpers.inferLeadName(paths));
  const canonicalLeadName =
    uniqueLeadName ||
    (membersByKey.get(normalizeKey(inferredLeadName)) &&
    normalizeName(membersByKey.get(normalizeKey(inferredLeadName)).name)) ||
    '';
  const leadAliases = new Set(['team-lead']);
  if (canonicalLeadName) {
    leadAliases.add(normalizeKey(canonicalLeadName));
    leadAliases.add('lead');
  }

  return {
    membersByKey,
    explicitMemberKeys: new Set(explicit.membersByKey.keys()),
    removedNames: resolved.removedNames || new Set(),
    leadAliases,
    leadCandidates: leadCandidates.map((member) => normalizeName(member.name)).filter(Boolean),
    canonicalLeadName,
    leadHeaderName: uniqueLeadName || '',
  };
}

function collectExplicitMemberKeys(paths) {
  return new Set(runtimeHelpers.collectExplicitTeamMembers(paths).membersByKey.keys());
}

function isCurrentRuntimeMember(teamName, memberName) {
  const requestedKey = normalizeKey(memberName);
  if (!requestedKey) return false;

  const runtimeIdentity = runtimeHelpers.getCurrentRuntimeMemberIdentity();
  if (!runtimeIdentity) return false;

  const runtimeAgentName = normalizeKey(runtimeIdentity.agentName);
  const runtimeAgentId = normalizeKey(runtimeIdentity.agentId);
  const runtimeTeamName = normalizeKey(runtimeIdentity.teamName);
  const requestedAgentId = `${requestedKey}@${normalizeKey(teamName)}`;
  return (
    (runtimeAgentName === requestedKey || runtimeAgentId === requestedAgentId) &&
    (!runtimeTeamName || runtimeTeamName === normalizeKey(teamName))
  );
}

function validateBriefingMember(paths, teamName, memberName) {
  const normalized = normalizeName(memberName);
  const key = normalizeKey(normalized);
  if (!key) {
    throw new Error('Missing member name');
  }

  const roster = buildQueueRoster(paths);
  if (roster.removedNames.has(key)) {
    throw new Error(`Member is removed from the team: ${normalized}`);
  }
  const explicitMemberKeys = collectExplicitMemberKeys(paths);
  if (explicitMemberKeys.has(key) || isCurrentRuntimeMember(teamName, normalized)) {
    return { warnings: [] };
  }
  if (roster.membersByKey.has(key)) {
    return {
      warnings: [
        `Member identity warning: ${normalized} is known only from inbox state, not team config/member metadata. Verify the member name before acting.`,
      ],
    };
  }
  throw new Error(`Member not found in team metadata or inboxes: ${normalized}`);
}

function resolveQueueActor(value, roster) {
  const normalized = normalizeName(value);
  if (!normalized) return null;

  const key = normalizeKey(normalized);
  if (roster.removedNames.has(key)) {
    return null;
  }

  if (roster.leadAliases.has(key) && roster.canonicalLeadName) {
    return { kind: 'lead', memberName: roster.canonicalLeadName };
  }

  const member = roster.membersByKey.get(key);
  if (!member) return null;
  if (!roster.explicitMemberKeys || !roster.explicitMemberKeys.has(key)) return null;

  if (roster.canonicalLeadName && normalizeKey(member.name) === normalizeKey(roster.canonicalLeadName)) {
    return { kind: 'lead', memberName: roster.canonicalLeadName };
  }

  return { kind: 'member', memberName: normalizeName(member.name) };
}

function areSameActors(left, right) {
  if (!left || !right || left.kind !== right.kind) return false;
  if (left.kind === 'lead') return true;
  return normalizeKey(left.memberName) === normalizeKey(right.memberName);
}

function resolveEffectiveReviewState(task, kanbanEntry) {
  return reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry);
}

function resolveLegacyKanbanReviewer(task, roster, options = {}) {
  const reviewState = normalizeName(options.reviewState);
  const kanbanEntry = options.kanbanEntry;
  if (reviewState !== 'review' || !kanbanEntry || kanbanEntry.column !== 'review') {
    return null;
  }

  const legacyReviewer = normalizeName(kanbanEntry.reviewer);
  if (!legacyReviewer) {
    return null;
  }

  const actor = resolveQueueActor(legacyReviewer, roster);
  if (actor) {
    return { actor, source: 'legacy_kanban_reviewer', invalidValue: null };
  }

  return {
    actor: null,
    source: 'legacy_kanban_reviewer_invalid',
    invalidValue: legacyReviewer,
  };
}

function resolveCurrentCycleReviewer(task, roster, options = {}) {
  const events = Array.isArray(task.historyEvents) ? task.historyEvents : [];

  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];

    if (event.type === 'review_started') {
      const actor = resolveQueueActor(event.actor, roster);
      if (actor) {
        return { actor, source: 'history_review_started_actor', invalidValue: null };
      }
      return {
        actor: null,
        source: 'history_review_started_invalid',
        invalidValue: normalizeName(event.actor) || null,
      };
    }

    if (event.type === 'review_requested') {
      const reviewer = resolveQueueActor(event.reviewer, roster);
      if (reviewer) {
        return { actor: reviewer, source: 'history_review_requested_reviewer', invalidValue: null };
      }
      return {
        actor: null,
        source: 'history_review_requested_invalid',
        invalidValue: normalizeName(event.reviewer) || null,
      };
    }

    if (event.type === 'review_approved' || event.type === 'review_changes_requested') {
      break;
    }

    if (
      event.type === 'status_changed' &&
      (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted')
    ) {
      break;
    }

    if (event.type === 'task_created') {
      break;
    }
  }

  const legacyFallback = resolveLegacyKanbanReviewer(task, roster, options);
  if (legacyFallback) {
    return legacyFallback;
  }

  return { actor: null, source: 'none', invalidValue: null };
}

function compareTasksByFreshness(left, right) {
  const leftTs = Date.parse(normalizeName(left.updatedAt) || normalizeName(left.createdAt) || '') || 0;
  const rightTs = Date.parse(normalizeName(right.updatedAt) || normalizeName(right.createdAt) || '') || 0;
  if (leftTs !== rightTs) return rightTs - leftTs;

  const byDisplay = String(left.displayId || left.id).localeCompare(String(right.displayId || right.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (byDisplay !== 0) return byDisplay;

  return String(left.id).localeCompare(String(right.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function buildBoardState(paths, teamName) {
  const taskRows = taskStore.listTaskRows(paths);
  const kanbanState = kanbanStore.readKanbanState(paths, teamName);
  const roster = buildQueueRoster(paths);
  const tasksById = new Map(taskRows.tasks.map((task) => [task.id, task]));
  const anomalies = [];

  if (kanbanState.tasks && typeof kanbanState.tasks === 'object') {
    for (const [taskId, entry] of Object.entries(kanbanState.tasks)) {
      if (!tasksById.has(taskId)) {
        anomalies.push({
          code: 'stale_kanban_task',
          taskId,
          detail: `Kanban ${entry && entry.column ? entry.column : 'entry'} references a missing or deleted task row.`,
        });
      }
    }
  }

  if (kanbanState.columnOrder && typeof kanbanState.columnOrder === 'object') {
    for (const [columnId, orderedTaskIds] of Object.entries(kanbanState.columnOrder)) {
      if (!Array.isArray(orderedTaskIds)) continue;
      for (const taskId of orderedTaskIds) {
        const id = String(taskId);
        const entry = kanbanState.tasks ? kanbanState.tasks[id] : undefined;
        if (!tasksById.has(id) || !entry || entry.column !== columnId) {
          anomalies.push({
            code: 'stale_kanban_order',
            taskId: id,
            detail: `Kanban columnOrder.${columnId} references a task that is not in that column overlay.`,
          });
        }
      }
    }
  }

  for (const anomaly of taskRows.anomalies) {
    anomalies.push({
      code: anomaly.code,
      detail: anomaly.detail,
      ...(anomaly.taskId ? { taskId: anomaly.taskId } : {}),
    });
  }

  return {
    tasks: [...taskRows.tasks].sort(compareTasksByFreshness),
    tasksById,
    kanbanState,
    roster,
    anomalies,
  };
}

function buildWatchers(ownerActor, reviewerActor, actionOwner) {
  const watchers = new Set();

  if (ownerActor && ownerActor.kind === 'member') {
    watchers.add(ownerActor.memberName);
  }
  if (reviewerActor && reviewerActor.kind === 'member') {
    watchers.add(reviewerActor.memberName);
  }
  if (actionOwner && actionOwner.kind === 'member') {
    watchers.delete(actionOwner.memberName);
  }

  return [...watchers];
}

function getLastMeaningfulEventAt(task) {
  const timestamps = [];
  if (normalizeName(task.updatedAt)) timestamps.push(task.updatedAt);
  if (normalizeName(task.createdAt)) timestamps.push(task.createdAt);

  const comments = Array.isArray(task.comments) ? task.comments : [];
  for (const comment of comments) {
    if (normalizeName(comment && comment.createdAt)) {
      timestamps.push(comment.createdAt);
    }
  }

  timestamps.sort((left, right) => {
    const leftTs = Date.parse(left) || 0;
    const rightTs = Date.parse(right) || 0;
    return rightTs - leftTs;
  });

  return timestamps[0] || undefined;
}

function truncateText(value, maxChars) {
  const text = normalizeName(value);
  if (!text || text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}... [truncated]`;
}

function buildAgendaItem(task, boardState) {
  const kanbanEntry = boardState.kanbanState.tasks ? boardState.kanbanState.tasks[task.id] : undefined;
  const reviewStateResult = resolveEffectiveReviewState(task, kanbanEntry);
  const reviewerResult = resolveCurrentCycleReviewer(task, boardState.roster, {
    reviewState: reviewStateResult.state,
    kanbanEntry,
  });
  const ownerActor = resolveQueueActor(task.owner, boardState.roster);
  const hasOwnerField = normalizeName(task.owner).length > 0;
  const hasMissingOwner = !hasOwnerField;
  const hasInvalidOwner = hasOwnerField && !ownerActor;
  const reviewActor = reviewerResult.actor;
  const reviewActorIsInvalid = reviewStateResult.state === 'review' && !reviewActor;
  const hasSelfReview = Boolean(ownerActor && reviewActor && areSameActors(ownerActor, reviewActor));

  const brokenDependencyIds = [];
  const waitingDependencyIds = [];
  const blockedByIds = Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [];
  for (const dependencyId of blockedByIds) {
    const dependency = boardState.tasksById.get(dependencyId);
    if (!dependency || dependency.status === 'deleted') {
      brokenDependencyIds.push(dependencyId);
      continue;
    }
    if (dependency.status !== 'completed') {
      waitingDependencyIds.push(dependencyId);
    }
  }

  let actionOwner = { kind: 'none' };
  let nextAction = 'none';
  let queueCategory = 'done';
  let reasonCode = 'completed_no_followup';
  const derivedFrom = [reviewStateResult.source, reviewerResult.source].filter(
    (value) => value && value !== 'none'
  );

  if (task.status === 'deleted') {
    reasonCode = 'terminal_deleted';
  } else if (reviewStateResult.state === 'approved') {
    reasonCode = 'terminal_approved';
  } else if (task.needsClarification === 'user') {
    actionOwner = { kind: 'user' };
    nextAction = 'clarify_with_user';
    queueCategory = 'waiting';
    reasonCode = 'waiting_user_clarification';
    derivedFrom.push('clarification_flag');
  } else if (task.needsClarification === 'lead') {
    actionOwner = { kind: 'lead' };
    nextAction = 'clarify_with_lead';
    queueCategory = 'oversight';
    reasonCode = 'waiting_lead_clarification';
    derivedFrom.push('clarification_flag');
  } else if (hasMissingOwner) {
    actionOwner = { kind: 'lead' };
    nextAction = 'assign_owner';
    queueCategory = 'oversight';
    reasonCode = 'owner_missing';
    derivedFrom.push('owner_status');
  } else if (hasInvalidOwner) {
    actionOwner = { kind: 'lead' };
    nextAction = 'assign_owner';
    queueCategory = 'oversight';
    reasonCode = 'owner_invalid';
    derivedFrom.push('owner_status');
  } else if (reviewStateResult.state === 'review') {
    if (hasSelfReview) {
      actionOwner = { kind: 'lead' };
      nextAction = 'assign_reviewer';
      queueCategory = 'oversight';
      reasonCode = 'self_review_invalid';
      derivedFrom.push('self_review_invalid');
    } else if (reviewActorIsInvalid) {
      actionOwner = { kind: 'lead' };
      nextAction = 'assign_reviewer';
      queueCategory = 'oversight';
      reasonCode = 'review_reviewer_missing';
      derivedFrom.push('history_reviewer_invalid');
    } else if (reviewActor) {
      actionOwner = reviewActor.kind === 'lead'
        ? { kind: 'lead' }
        : { kind: 'member', memberName: reviewActor.memberName };
      nextAction = 'review';
      queueCategory = actionOwner.kind === 'lead' ? 'oversight' : 'actionable';
      reasonCode =
        reviewerResult.source === 'history_review_started_actor'
          ? 'review_in_progress'
          : 'review_requested_waiting_pickup';
    }
  } else if (brokenDependencyIds.length > 0) {
    actionOwner = { kind: 'lead' };
    nextAction = 'repair_dependencies';
    queueCategory = 'oversight';
    reasonCode = 'dependency_broken';
    derivedFrom.push('dependency_graph');
  } else if (waitingDependencyIds.length > 0) {
    actionOwner = { kind: 'none' };
    nextAction = 'wait_dependency';
    queueCategory = 'waiting';
    reasonCode = 'dependency_waiting';
    derivedFrom.push('dependency_graph');
  } else if (reviewStateResult.state === 'needsFix') {
    actionOwner =
      ownerActor.kind === 'lead'
        ? { kind: 'lead' }
        : { kind: 'member', memberName: ownerActor.memberName };
    nextAction = 'apply_changes';
    queueCategory = actionOwner.kind === 'lead' ? 'oversight' : 'actionable';
    reasonCode = 'needs_fix';
  } else if (task.status === 'in_progress') {
    actionOwner =
      ownerActor.kind === 'lead'
        ? { kind: 'lead' }
        : { kind: 'member', memberName: ownerActor.memberName };
    nextAction = 'execute';
    queueCategory = actionOwner.kind === 'lead' ? 'oversight' : 'actionable';
    reasonCode = 'owner_executing';
  } else if (task.status === 'pending') {
    actionOwner =
      ownerActor.kind === 'lead'
        ? { kind: 'lead' }
        : { kind: 'member', memberName: ownerActor.memberName };
    nextAction = 'execute';
    queueCategory = actionOwner.kind === 'lead' ? 'oversight' : 'actionable';
    reasonCode = 'owner_ready';
  }

  const watchers = buildWatchers(ownerActor, reviewActor, actionOwner);

  const lastMeaningfulEventAt = getLastMeaningfulEventAt(task);

  return {
    taskId: task.id,
    displayId: task.displayId,
    subject: task.subject,
    status: task.status,
    reviewState: reviewStateResult.state,
    actionOwner,
    nextAction,
    queueCategory,
    reasonCode,
    ...(normalizeName(task.owner) ? { owner: task.owner } : {}),
    reviewer:
      reviewActor && reviewActor.kind === 'member'
        ? reviewActor.memberName
        : reviewActor && reviewActor.kind === 'lead'
          ? reviewActor.memberName
          : null,
    ...(blockedByIds.length > 0 ? { blockedBy: blockedByIds } : {}),
    ...(watchers.length > 0 ? { watchers } : {}),
    ...(task.needsClarification ? { needsClarification: task.needsClarification } : {}),
    ...(lastMeaningfulEventAt ? { lastMeaningfulEventAt } : {}),
    derivedFrom,
    _fullTask: task,
  };
}

function compareAgendaItems(left, right) {
  const leftTs = Date.parse(normalizeName(left.lastMeaningfulEventAt)) || 0;
  const rightTs = Date.parse(normalizeName(right.lastMeaningfulEventAt)) || 0;
  if (leftTs !== rightTs) return rightTs - leftTs;

  const byDisplay = String(left.displayId || left.taskId).localeCompare(String(right.displayId || right.taskId), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (byDisplay !== 0) return byDisplay;

  return String(left.taskId).localeCompare(String(right.taskId), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function buildAgendaSnapshot(paths, teamName, actor) {
  return withTeamBoardLock(paths, () => {
    const boardState = buildBoardState(paths, teamName);
    const items = boardState.tasks.map((task) => buildAgendaItem(task, boardState));
    const actionable = [];
    const awareness = [];

    for (const item of items) {
      if (actor.kind === 'member') {
        const memberKey = normalizeKey(actor.memberName);
        const isActionable =
          item.actionOwner.kind === 'member' &&
          normalizeKey(item.actionOwner.memberName) === memberKey;
        const isRelevant =
          isActionable ||
          normalizeKey(item.owner) === memberKey ||
          normalizeKey(item.reviewer) === memberKey ||
          (Array.isArray(item.watchers) && item.watchers.some((entry) => normalizeKey(entry) === memberKey));

        if (isActionable) {
          actionable.push(item);
        } else if (isRelevant) {
          awareness.push(item);
        }
        continue;
      }

      if (item.actionOwner.kind === 'lead') {
        actionable.push(item);
      } else if (
        item.actionOwner.kind === 'user' ||
        item.reasonCode === 'dependency_waiting' ||
        item.reasonCode === 'review_in_progress' ||
        item.reasonCode === 'review_requested_waiting_pickup'
      ) {
        awareness.push(item);
      }
    }

    actionable.sort(compareAgendaItems);
    awareness.sort(compareAgendaItems);

    return {
      actor,
      actionable,
      awareness,
      anomalies: boardState.anomalies,
      counters: {
        actionable: actionable.length,
        awareness: awareness.length,
        blocked: items.filter(
          (item) =>
            item.reasonCode === 'dependency_waiting' || item.reasonCode === 'dependency_broken'
        ).length,
        waitingOnUser: items.filter((item) => item.reasonCode === 'waiting_user_clarification').length,
        waitingOnLead: items.filter((item) => item.reasonCode === 'waiting_lead_clarification').length,
        reviewNeeded: items.filter(
          (item) =>
            item.reasonCode === 'review_reviewer_missing' ||
            item.reasonCode === 'review_requested_waiting_pickup' ||
            item.reasonCode === 'review_in_progress' ||
            item.reasonCode === 'self_review_invalid'
        ).length,
        anomalies: boardState.anomalies.length,
      },
    };
  });
}

function buildInventoryRow(task, reviewState, kanbanEntry) {
  return {
    id: task.id,
    displayId: task.displayId,
    subject: truncateText(task.subject, MAX_SUBJECT_CHARS),
    status: task.status,
    ...(normalizeName(task.owner) ? { owner: task.owner } : {}),
    reviewState,
    ...(kanbanEntry && INVENTORY_KANBAN_COLUMNS.has(kanbanEntry.column)
      ? { kanbanColumn: kanbanEntry.column }
      : {}),
    ...(task.needsClarification ? { needsClarification: task.needsClarification } : {}),
    ...(Array.isArray(task.blockedBy) && task.blockedBy.length > 0 ? { blockedBy: task.blockedBy } : {}),
    ...(Array.isArray(task.blocks) && task.blocks.length > 0 ? { blocks: task.blocks } : {}),
    ...(Array.isArray(task.related) && task.related.length > 0 ? { related: task.related } : {}),
    commentCount: Array.isArray(task.comments) ? task.comments.length : 0,
    ...(normalizeName(task.createdAt) ? { createdAt: task.createdAt } : {}),
    ...(normalizeName(task.updatedAt) ? { updatedAt: task.updatedAt } : {}),
  };
}

function matchesInventoryFilters(row, filters) {
  if (normalizeName(filters.owner) && normalizeKey(row.owner) !== normalizeKey(filters.owner)) {
    return false;
  }
  if (normalizeName(filters.status) && row.status !== filters.status) {
    return false;
  }
  if (normalizeName(filters.reviewState) && row.reviewState !== filters.reviewState) {
    return false;
  }
  if (normalizeName(filters.kanbanColumn)) {
    const kanbanColumn = filters.kanbanColumn;
    if (!INVENTORY_KANBAN_COLUMNS.has(kanbanColumn) || row.kanbanColumn !== kanbanColumn) {
      return false;
    }
  }
  if (normalizeName(filters.relatedTo)) {
    const related = Array.isArray(row.related) ? row.related : [];
    if (!related.includes(filters.relatedTo)) {
      return false;
    }
  }
  if (normalizeName(filters.blockedBy)) {
    const blockedBy = Array.isArray(row.blockedBy) ? row.blockedBy : [];
    if (!blockedBy.includes(filters.blockedBy)) {
      return false;
    }
  }
  return true;
}

function listTaskInventory(paths, teamName, filters = {}) {
  return withTeamBoardLock(paths, () => {
    const taskRows = taskStore.listTaskRows(paths);
    const kanbanState = kanbanStore.readKanbanState(paths, teamName);
    const resolvedRelatedTo = normalizeName(filters.relatedTo)
      ? taskStore.resolveTaskRef(paths, filters.relatedTo)
      : '';
    const resolvedBlockedBy = normalizeName(filters.blockedBy)
      ? taskStore.resolveTaskRef(paths, filters.blockedBy)
      : '';
    const limit =
      typeof filters.limit === 'number' && Number.isFinite(filters.limit)
        ? Math.max(1, Math.floor(filters.limit))
        : null;

    const resolvedFilters = {
      ...filters,
      ...(resolvedRelatedTo ? { relatedTo: resolvedRelatedTo } : {}),
      ...(resolvedBlockedBy ? { blockedBy: resolvedBlockedBy } : {}),
    };
    const candidates = [];

    const addCandidate = (candidate) => {
      if (limit == null || candidates.length < limit) {
        candidates.push(candidate);
        return;
      }

      let oldestIndex = 0;
      for (let index = 1; index < candidates.length; index += 1) {
        if (compareTasksByFreshness(candidates[index].task, candidates[oldestIndex].task) > 0) {
          oldestIndex = index;
        }
      }

      if (compareTasksByFreshness(candidate.task, candidates[oldestIndex].task) < 0) {
        candidates[oldestIndex] = candidate;
      }
    };

    for (const task of taskRows.tasks) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      const reviewState = resolveEffectiveReviewState(task, kanbanEntry).state;
      const row = buildInventoryRow(task, reviewState, kanbanEntry);
      if (!matchesInventoryFilters(row, resolvedFilters)) {
        continue;
      }
      addCandidate({ task, row });
    }

    return candidates.sort((left, right) => compareTasksByFreshness(left.task, right.task)).map((entry) => entry.row);
  });
}

function formatActionOwner(actionOwner) {
  if (actionOwner.kind === 'member') return `@${actionOwner.memberName}`;
  if (actionOwner.kind === 'lead') return 'lead';
  if (actionOwner.kind === 'user') return 'user';
  return 'none';
}

function formatAgendaLine(item) {
  const reviewSuffix = item.reviewState !== 'none' ? `, review=${item.reviewState}` : '';
  const meta = [
    `next=${item.nextAction}`,
    `owner=${normalizeName(item.owner) || 'none'}`,
    `actionOwner=${formatActionOwner(item.actionOwner)}`,
    `reason=${item.reasonCode}`,
  ];
  if (normalizeName(item.reviewer)) {
    meta.push(`reviewer=${item.reviewer}`);
  }
  if (item.needsClarification) {
    meta.push(`clarification=${item.needsClarification}`);
  }
  return `- ${formatTaskLabel(item)} [status=${item.status}${reviewSuffix}] ${truncateText(item.subject, MAX_SUBJECT_CHARS)} (${meta.join(', ')})`;
}

function appendExpandedTaskContext(lines, item) {
  const task = item._fullTask;
  if (!task || typeof task !== 'object') return;

  if (normalizeName(task.description)) {
    lines.push(`  Description: ${truncateText(task.description, MAX_DESCRIPTION_CHARS)}`);
  }

  const comments = Array.isArray(task.comments) ? task.comments : [];
  if (comments.length === 0) return;

  lines.push('  Comments:');
  for (const comment of comments.slice(-5)) {
    const author = normalizeName(comment && comment.author) || 'unknown';
    const text = truncateText(comment && comment.text, MAX_COMMENT_CHARS) || '(empty comment)';
    lines.push(`  - ${author}: ${text}`);
  }
}

function appendOmittedLine(lines, sectionLabel, shownCount, totalCount) {
  if (totalCount <= shownCount) return;
  lines.push(
    `... ${totalCount - shownCount} more ${sectionLabel} item(s) omitted. Use task_list filters and task_get for drill-down.`
  );
}

function formatAnomalyLine(anomaly) {
  const ref = normalizeName(anomaly.taskId) ? ` (${anomaly.taskId})` : '';
  return `- ${anomaly.code}${ref}: ${truncateText(anomaly.detail, MAX_ANOMALY_DETAIL_CHARS)}`;
}

function appendAnomalies(lines, anomalies) {
  const shown = anomalies.slice(0, MAX_ANOMALY_ITEMS);
  for (const anomaly of shown) {
    lines.push(formatAnomalyLine(anomaly));
  }
  if (anomalies.length > shown.length) {
    lines.push(
      `... ${anomalies.length - shown.length} more board anomaly item(s) omitted. Run maintenance/reconcile or inspect board files for full details.`
    );
  }
}

function formatTaskBriefing(paths, teamName, memberName) {
  const memberValidation = validateBriefingMember(paths, teamName, memberName);
  const snapshot = buildAgendaSnapshot(paths, teamName, {
    kind: 'member',
    memberName: normalizeName(memberName),
  });
  const lines = [
    `Task briefing for ${memberName}:`,
    `Primary queue for ${memberName}. Act only on Actionable items. Awareness items are watch-only context unless the lead reroutes the task or you become the actionOwner.`,
    `Use task_list only to search/browse inventory rows, not as your working queue.`,
  ];

  if (memberValidation.warnings.length > 0 || snapshot.anomalies.length > 0) {
    lines.push('', 'Board warnings:');
    for (const warning of memberValidation.warnings) {
      lines.push(`- ${warning}`);
    }
    appendAnomalies(lines, snapshot.anomalies);
  }

  if (snapshot.actionable.length === 0 && snapshot.awareness.length === 0) {
    lines.push('', `No actionable or awareness tasks for ${memberName}.`);
    return lines.join('\n');
  }

  if (snapshot.actionable.length > 0) {
    lines.push('', 'Actionable:');
    let expandedCount = 0;
    const actionableItems = snapshot.actionable.slice(0, MAX_MEMBER_ACTIONABLE_ITEMS);
    for (const item of actionableItems) {
      lines.push(formatAgendaLine(item));
      if (item.status === 'in_progress' || item.reasonCode === 'needs_fix') {
        if (expandedCount < MAX_EXPANDED_CONTEXT_ITEMS) {
          appendExpandedTaskContext(lines, item);
          expandedCount += 1;
        } else {
          lines.push('  Context omitted: use task_get for full task details.');
        }
      }
    }
    appendOmittedLine(lines, 'Actionable', actionableItems.length, snapshot.actionable.length);
  }

  if (snapshot.awareness.length > 0) {
    lines.push('', 'Awareness:');
    const awarenessItems = snapshot.awareness.slice(0, MAX_MEMBER_AWARENESS_ITEMS);
    for (const item of awarenessItems) {
      lines.push(formatAgendaLine(item));
    }
    appendOmittedLine(lines, 'Awareness', awarenessItems.length, snapshot.awareness.length);
  }

  lines.push(
    '',
    `Counters: actionable=${snapshot.counters.actionable}, awareness=${snapshot.counters.awareness}, blocked=${snapshot.counters.blocked}, waitingOnUser=${snapshot.counters.waitingOnUser}, waitingOnLead=${snapshot.counters.waitingOnLead}, reviewNeeded=${snapshot.counters.reviewNeeded}, anomalies=${snapshot.counters.anomalies}`
  );

  return lines.join('\n');
}

function bucketLeadItems(items) {
  const buckets = {
    assign_owner: [],
    assign_reviewer: [],
    clarify_with_lead: [],
    repair_dependencies: [],
    lead_owned: [],
  };

  for (const item of items) {
    if (item.nextAction === 'assign_owner') {
      buckets.assign_owner.push(item);
      continue;
    }
    if (item.nextAction === 'assign_reviewer') {
      buckets.assign_reviewer.push(item);
      continue;
    }
    if (item.nextAction === 'clarify_with_lead') {
      buckets.clarify_with_lead.push(item);
      continue;
    }
    if (item.nextAction === 'repair_dependencies') {
      buckets.repair_dependencies.push(item);
      continue;
    }
    buckets.lead_owned.push(item);
  }

  return buckets;
}

function formatLeadBriefing(paths, teamName) {
  const roster = buildQueueRoster(paths);
  const leadHeaderName = roster.leadHeaderName ? ` for ${roster.leadHeaderName}` : '';
  const snapshot = buildAgendaSnapshot(paths, teamName, { kind: 'lead' });
  const buckets = bucketLeadItems(snapshot.actionable);
  const lines = [
    `Lead queue${leadHeaderName} on team "${teamName}":`,
    `Primary lead queue. Sections below already represent lead-owned actions or watch-only context.`,
    `Use task_list only for search, filtering, and drill-down inventory lookups.`,
  ];

  if (snapshot.anomalies.length > 0) {
    lines.push('', 'Board anomalies:');
    appendAnomalies(lines, snapshot.anomalies);
  }

  const sections = [
    ['Needs owner assignment:', buckets.assign_owner],
    ['Needs reviewer assignment:', buckets.assign_reviewer],
    ['Needs clarification from lead:', buckets.clarify_with_lead],
    ['Dependency repair:', buckets.repair_dependencies],
    ['Lead-owned follow-up:', buckets.lead_owned],
    [
      'Waiting on user:',
      snapshot.awareness.filter((item) => item.reasonCode === 'waiting_user_clarification'),
    ],
    [
      'Watching:',
      snapshot.awareness.filter((item) => item.reasonCode !== 'waiting_user_clarification'),
    ],
  ];

  let renderedAnySection = false;
  for (const [title, items] of sections) {
    if (!items || items.length === 0) continue;
    renderedAnySection = true;
    lines.push('', title);
    const sectionItems = items.slice(0, MAX_LEAD_SECTION_ITEMS);
    for (const item of sectionItems) {
      lines.push(formatAgendaLine(item));
    }
    appendOmittedLine(lines, title.replace(/:$/, ''), sectionItems.length, items.length);
  }

  if (!renderedAnySection && snapshot.anomalies.length === 0) {
    lines.push('', 'No lead action items.');
  }

  lines.push(
    '',
    `Counters: actionable=${snapshot.counters.actionable}, awareness=${snapshot.counters.awareness}, blocked=${snapshot.counters.blocked}, waitingOnUser=${snapshot.counters.waitingOnUser}, waitingOnLead=${snapshot.counters.waitingOnLead}, reviewNeeded=${snapshot.counters.reviewNeeded}, anomalies=${snapshot.counters.anomalies}`
  );

  return lines.join('\n');
}

module.exports = {
  buildAgendaSnapshot,
  formatLeadBriefing,
  formatTaskBriefing,
  listTaskInventory,
  resolveCurrentCycleReviewer,
  resolveEffectiveReviewState,
};
