const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const identity = require('./hostedBoardIdentity.js');
const projection = require('./hostedBoardProjection.js');
const { withTeamBoardLock } = require('./boardLock.js');
const { createControllerContext } = require('./context.js');
const { FILE_LOCK_TIMEOUT_CODE } = require('./fileLock.js');
const kanban = require('./kanban.js');
const review = require('./review.js');
const reviewStateHelpers = require('./reviewState.js');
const { isTaskOpen } = require('./taskLifecycle.js');
const tasks = require('./tasks.js');
const taskStore = require('./taskStore.js');

// One hosted task-board mutation, applied with desktop semantics under the board lock.
// Contract: docs/hosted-task-command-golden.json (agent-teams.hosted-task-command/v1).

const RETRY_AFTER_MS = 1000;
const MAX_SELF_WRITE_EFFECTS = 512;
const STATUS_BY_COLUMN = { todo: 'pending', in_progress: 'in_progress', done: 'completed' };
const ID = {
  team: /^team_[0-9a-f]{32}$/,
  member: /^member_[0-9a-f]{32}$/,
  task: /^task_[0-9a-f]{32}$/,
  command: /^command_[A-Za-z0-9][A-Za-z0-9._-]{0,118}$/,
  idempotency: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,
  generation: /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/,
  revision: /^revision_[A-Za-z0-9][A-Za-z0-9._-]{0,246}$/,
  fingerprint: /^[A-Za-z0-9_-]{43}$/,
  teamName: /^[A-Za-z0-9_-]{1,128}$/,
};
const COMMON_KEYS = ['schemaVersion', 'kind', 'commandId', 'idempotencyKey', 'teamId', 'expectedSourceGeneration', 'expectedRevision'];
const COMMAND_KEYS = {
  create_task: ['subject', 'description', 'status', 'ownerId', 'column', 'order'],
  update_owner: ['taskId', 'ownerId'],
  update_status: ['taskId', 'status'],
  move_task: ['taskId', 'column', 'order'],
  reorder_column: ['column', 'orderedTaskIds'],
};

class HostedTaskCommandInputError extends Error {}

function fail(field) {
  throw new HostedTaskCommandInputError(`Invalid ${field}`);
}
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function exact(value, keys, field) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) fail(`${field} keys`);
}
function string(value, field, pattern) {
  if (typeof value !== 'string' || (pattern ? !pattern.test(value) : value.length === 0)) fail(field);
  return value;
}
function integer(value, field, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(field);
  return value;
}
function oneOf(value, field, values) {
  if (!values.includes(value)) fail(field);
  return value;
}
function subject(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) fail('subject');
  return value;
}
function description(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 20_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail('description');
  return value;
}

/** Same rules as the Owner's decodeHostedTaskMutationCommand; the child never trusts its caller. */
function parseCommand(v) {
  if (!isRecord(v) || v.schemaVersion !== 1) fail('command');
  const extra = v.kind === 'update_details' ? ['taskId', ...['subject', 'description'].filter((key) => Object.hasOwn(v, key))] : COMMAND_KEYS[v.kind];
  if (!extra) fail('command.kind');
  exact(v, [...COMMON_KEYS, ...extra], `command ${v.kind}`);
  for (const [key, pattern] of [['commandId', ID.command], ['idempotencyKey', ID.idempotency], ['teamId', ID.team], ['expectedSourceGeneration', ID.generation], ['expectedRevision', ID.revision]]) string(v[key], `command.${key}`, pattern);
  if ('taskId' in v) string(v.taskId, 'command.taskId', ID.task);
  if ('ownerId' in v && v.ownerId !== null) string(v.ownerId, 'command.ownerId', ID.member);
  if ('status' in v) oneOf(v.status, 'command.status', ['pending', 'in_progress', 'completed']);
  if ('column' in v) oneOf(v.column, 'command.column', projection.HOSTED_BOARD_COLUMNS);
  if ('order' in v) integer(v.order, 'command.order', 0, 1_000_000);
  if ('subject' in v) subject(v.subject);
  if ('description' in v) description(v.description);
  if (v.kind === 'update_details' && extra.length === 1) fail('command update_details');
  if (v.kind === 'reorder_column') {
    if (!Array.isArray(v.orderedTaskIds) || v.orderedTaskIds.length === 0 || v.orderedTaskIds.length > 100) fail('command.orderedTaskIds');
    v.orderedTaskIds.forEach((id) => string(id, 'command.orderedTaskId', ID.task));
    if (new Set(v.orderedTaskIds).size !== v.orderedTaskIds.length) fail('command.orderedTaskIds');
  }
  return v;
}

function parseInput(raw) {
  const v = isRecord(raw) ? raw : fail('input');
  exact(v, ['schemaVersion', 'kind', 'teamName', 'board', 'lead', 'lockTimeoutMs', 'payloadFingerprint', 'command'], 'input');
  if (v.schemaVersion !== 1 || v.kind !== 'hosted_task_command') fail('input');
  string(v.teamName, 'teamName', ID.teamName);
  const board = isRecord(v.board) ? v.board : fail('board');
  exact(board, ['deploymentId', 'bootId', 'workspaceId', 'mountGeneration', 'teamId'], 'board');
  ['deploymentId', 'bootId', 'workspaceId'].forEach((key) => string(board[key], `board.${key}`));
  integer(board.mountGeneration, 'board.mountGeneration', 1, Number.MAX_SAFE_INTEGER);
  string(board.teamId, 'board.teamId', ID.team);
  const lead = isRecord(v.lead) ? v.lead : fail('lead');
  exact(lead, ['name', 'sessionId'], 'lead');
  string(lead.name, 'lead.name');
  if (lead.sessionId !== null) string(lead.sessionId, 'lead.sessionId');
  integer(v.lockTimeoutMs, 'lockTimeoutMs', 100, 4000);
  string(v.payloadFingerprint, 'payloadFingerprint', ID.fingerprint);
  const command = parseCommand(v.command);
  if (command.teamId !== board.teamId) fail('command.teamId');
  return v;
}

/** Decimal [device, inode] of a real directory, or null when it is missing or not one. */
function directoryIdentity(directory) {
  let stat;
  try {
    stat = fs.lstatSync(directory, { bigint: true });
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  return [stat.dev.toString(), stat.ino.toString()];
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function readSnapshot(paths) {
  const taskFiles = fs
    .readdirSync(paths.tasksDir)
    .filter((name) => identity.HOSTED_TASK_FILE_PATTERN.test(name))
    .sort()
    .map((name) => ({ name, text: readText(path.join(paths.tasksDir, name)) }))
    .filter((file) => file.text !== null);
  const kanbanText = readText(paths.kanbanPath);
  const rosterFiles = identity.HOSTED_REVISION_ROSTER_FILES.map((name) => ({ name, text: readText(path.join(paths.teamDir, name)) }));
  return { taskFiles, kanbanText, rosterFiles };
}

function boardView(teamId, snapshot) {
  const kanbanState = snapshot.kanbanText === null ? {} : JSON.parse(snapshot.kanbanText);
  return { kanban: isRecord(kanbanState) ? kanbanState : {}, tasks: projection.hostedBoardTasks(teamId, snapshot.taskFiles) };
}

function selfWriteEffects(before, after) {
  const previous = new Map(before.taskFiles.map((file) => [file.name, file.text]));
  const effects = after.taskFiles
    .filter((file) => previous.get(file.name) !== file.text)
    .map((file) => ({ fileKey: file.name.slice(0, -'.json'.length), expectedChecksum: crypto.createHash('sha256').update(file.text, 'utf8').digest('hex') }))
    .sort((a, b) => a.fileKey.localeCompare(b.fileKey));
  if (effects.length > MAX_SELF_WRITE_EFFECTS) throw new Error('Hosted task command changed too many task files');
  return effects;
}

function creationCommandFor(input, rawId) {
  return {
    namespace: 'agent-teams.hosted',
    scopeKey: input.teamName,
    operation: 'create_task',
    commandId: rawId,
    payloadHash: input.payloadFingerprint,
    idempotencyKey: input.command.idempotencyKey,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameCreationCommand(stored, expected) {
  return isRecord(stored) && Object.keys(stored).length === Object.keys(expected).length &&
    Object.entries(expected).every(([key, value]) => stored[key] === value);
}

function targetPosition(view, rawId, column, order) {
  const others = projection.hostedBoardColumnOrder(view.kanban, column, view.tasks.values()).filter((id) => id !== rawId);
  return Math.min(order, others.length);
}

/** A set-shaped command that already holds commits nothing and needs no CAS. */
function isNoop(command, view, target, members) {
  switch (command.kind) {
    case 'update_details':
      return (!Object.hasOwn(command, 'subject') || target.subject === command.subject) &&
        (!Object.hasOwn(command, 'description') || (target.description ?? '') === (command.description ?? ''));
    case 'update_owner':
      return (target.owner || null) === (command.ownerId === null ? null : members.get(command.ownerId) ?? '\0');
    case 'update_status':
      return target.status === command.status;
    case 'move_task': {
      const current = projection.hostedBoardColumnFor(view.kanban, target.rawId, target.status);
      const order = projection.hostedBoardColumnOrder(view.kanban, current, view.tasks.values());
      return current === command.column && order.indexOf(target.rawId) === targetPosition(view, target.rawId, command.column, command.order);
    }
    case 'reorder_column':
      return sameJson(projection.hostedBoardColumnOrder(view.kanban, command.column, view.tasks.values()), command.orderedTaskIds.map((id) => view.tasks.get(id)?.rawId));
    default:
      return false;
  }
}

function placeTask(context, teamId, rawId, column, order) {
  const snapshot = readSnapshot(context.paths);
  const view = boardView(teamId, snapshot);
  // The controller resolves every id it stores; ids whose task file is gone are dropped first so
  // a stale order entry can never fail the placement after the move itself was written.
  const onDisk = new Set(snapshot.taskFiles.map((file) => file.name.slice(0, -'.json'.length)));
  const ordered = projection.hostedBoardColumnOrder(view.kanban, column, view.tasks.values()).filter((id) => id !== rawId);
  ordered.splice(Math.min(order, ordered.length), 0, rawId);
  const columnOrder = isRecord(view.kanban.columnOrder) ? view.kanban.columnOrder : {};
  for (const other of projection.HOSTED_BOARD_COLUMNS) {
    if (other !== column && Array.isArray(columnOrder[other]) && columnOrder[other].includes(rawId)) {
      kanban.updateColumnOrder(context, other, columnOrder[other].filter((id) => id !== rawId && onDisk.has(id)));
    }
  }
  kanban.updateColumnOrder(context, column, ordered);
}

/** Desktop TeamDetailView and TeamTaskMutationCoordinator semantics for one column move. */
function moveToColumn(context, input, view, task, currentColumn, column) {
  const leadFlags = { from: input.lead.name, ...(input.lead.sessionId ? { leadSessionId: input.lead.sessionId } : {}) };
  if (STATUS_BY_COLUMN[column]) {
    // A status column is the task's status; any kanban placement (review, approved, or an
    // older column entry) would override it, as handleMoveBackToDone clears it on desktop.
    // Every refusal (open blockers, review rules) is checked before the first write. Clearing
    // the placement first keeps a failed status write consistent: the task then simply shows in
    // its unchanged status column, as desktop shows a task without a kanban placement.
    if (isRecord(view.kanban.tasks) && view.kanban.tasks[task.rawId]) {
      kanban.clearKanban(context, task.rawId, { transition: 'status_reset' });
    }
    if (task.status !== STATUS_BY_COLUMN[column]) tasks.setTaskStatus(context, task.rawId, STATUS_BY_COLUMN[column], 'user');
    return;
  }
  if (column === 'review') return review.requestReview(context, task.rawId, leadFlags);
  // The desktop Approve button: a task already in the review workflow is approved as a
  // review, any other completed task is approved directly (resolveTaskMutationWorkflowColumn).
  const kanbanEntry = isRecord(view.kanban.tasks) ? view.kanban.tasks[task.rawId] : undefined;
  const reviewState = reviewStateHelpers.getEffectiveReviewState(task.value, kanbanEntry).state;
  const inReviewWorkflow =
    task.status !== 'pending' &&
    (currentColumn === 'review' || currentColumn === 'approved' || reviewState === 'review' || reviewState === 'approved');
  if (inReviewWorkflow) {
    return review.approveReview(context, task.rawId, { ...leadFlags, suppressTaskComment: true, 'notify-owner': true });
  }
  kanban.setKanbanColumn(context, task.rawId, 'approved', { transition: 'manual_approve' });
}

/** Desktop refuses in_progress and completed while a blocker is open (assertDependenciesResolved). */
function hasOpenBlockers(context, rawId) {
  const task = taskStore.readTask(context.paths, rawId, { includeDeleted: true });
  return (Array.isArray(task.blockedBy) ? task.blockedBy : []).some((blockerId) => {
    try {
      return isTaskOpen(taskStore.readTask(context.paths, blockerId, { includeDeleted: true }));
    } catch (error) {
      if (error && error.code === 'TASK_NOT_FOUND') return false;
      throw error;
    }
  });
}

function needsResolvedDependencies(status) {
  return status === 'in_progress' || status === 'completed';
}

/** Returns null when the move is allowed, else the conflict reason. */
function moveConflict(currentColumn, task, column) {
  if (column === 'review') return task.status === 'completed' && currentColumn !== 'approved' ? null : 'state_conflict';
  if (column === 'approved') return task.status === 'completed' ? null : 'state_conflict';
  return null;
}

function apply(context, input, view, target, members) {
  const { command } = input;
  const teamId = input.board.teamId;
  switch (command.kind) {
    case 'create_task': {
      if (STATUS_BY_COLUMN[command.column] !== command.status) return { conflict: 'state_conflict' };
      const owner = command.ownerId === null ? undefined : members.get(command.ownerId);
      if (command.ownerId !== null && owner === undefined) return { conflict: 'state_conflict' };
      const rawId = identity.hostedTaskIdForCommand(teamId, command.commandId);
      tasks.createTask(context, {
        id: rawId,
        subject: command.subject,
        ...(command.description === null ? {} : { description: command.description }),
        ...(owner ? { owner } : {}),
        status: command.status,
        from: 'user',
        creationCommand: creationCommandFor(input, rawId),
      });
      // The task exists now and a retry only replays it, so a failed placement must not turn the
      // committed create into an error: the task then shows at the end of its status column.
      try {
        placeTask(context, teamId, rawId, command.column, command.order);
      } catch {
        process.stderr.write('[hosted-task-command] create placement failed\n');
      }
      return { affected: [identity.hostedTaskBoardTaskId(teamId, rawId)] };
    }
    case 'update_details':
      tasks.updateTaskFields(context, target.rawId, {
        ...(Object.hasOwn(command, 'subject') ? { subject: command.subject } : {}),
        ...(Object.hasOwn(command, 'description') ? { description: command.description ?? '' } : {}),
      });
      return { affected: [command.taskId] };
    case 'update_owner': {
      const owner = command.ownerId === null ? null : members.get(command.ownerId);
      if (owner === undefined) return { conflict: 'state_conflict' };
      tasks.setTaskOwner(context, target.rawId, owner, 'user');
      return { affected: [command.taskId] };
    }
    case 'update_status':
      if (needsResolvedDependencies(command.status) && hasOpenBlockers(context, target.rawId)) {
        return { conflict: 'relationship_conflict' };
      }
      tasks.setTaskStatus(context, target.rawId, command.status, 'user');
      return { affected: [command.taskId] };
    case 'move_task': {
      const currentColumn = projection.hostedBoardColumnFor(view.kanban, target.rawId, target.status);
      const conflict = moveConflict(currentColumn, target, command.column);
      if (conflict) return { conflict };
      const nextStatus = STATUS_BY_COLUMN[command.column];
      if (nextStatus !== target.status && needsResolvedDependencies(nextStatus) && hasOpenBlockers(context, target.rawId)) {
        return { conflict: 'relationship_conflict' };
      }
      if (currentColumn !== command.column) moveToColumn(context, input, view, target, currentColumn, command.column);
      placeTask(context, teamId, target.rawId, command.column, command.order);
      return { affected: [command.taskId] };
    }
    case 'reorder_column': {
      const rawIds = command.orderedTaskIds.map((id) => view.tasks.get(id)?.rawId);
      const current = projection.hostedBoardColumnOrder(view.kanban, command.column, view.tasks.values());
      if (rawIds.some((id) => !id) || current.length !== rawIds.length || current.some((id) => !rawIds.includes(id))) {
        return { conflict: 'state_conflict' };
      }
      kanban.updateColumnOrder(context, command.column, rawIds);
      return { affected: [...command.orderedTaskIds] };
    }
    default:
      throw new Error('Unsupported hosted task command');
  }
}

function runLocked(context, input) {
  const { command } = input;
  const teamId = input.board.teamId;
  const directories = [directoryIdentity(context.paths.teamDir), directoryIdentity(context.paths.tasksDir)];
  if (directories.includes(null)) return { result: { kind: 'unsafe_active' } };
  const sourceGeneration = identity.hostedTaskBoardSourceGeneration({ ...input.board, teamDirectory: directories[0], tasksDirectory: directories[1] });
  if (sourceGeneration !== command.expectedSourceGeneration) {
    return { result: { kind: 'stale_generation', currentSourceGeneration: sourceGeneration } };
  }
  const revisionOf = (snapshot) => identity.hostedTaskBoardRevision({ sourceGeneration, ...snapshot });
  const before = readSnapshot(context.paths);
  const revision = revisionOf(before);
  const view = boardView(teamId, before);
  const receiptResult = (outcome, rev, affected) => ({
    kind: outcome,
    currentSourceGeneration: sourceGeneration,
    payloadFingerprint: input.payloadFingerprint,
    receipt: { schemaVersion: 1, outcome, commandId: command.commandId, teamId, sourceGeneration, revision: rev, affectedTaskIds: [...new Set(affected)].sort() },
  });
  const conflict = (reason, currentRevision) => ({ kind: 'conflict', reason, currentSourceGeneration: sourceGeneration, ...(currentRevision ? { currentRevision } : {}) });

  if (command.kind === 'create_task') {
    const rawId = identity.hostedTaskIdForCommand(teamId, command.commandId);
    const existing = before.taskFiles.find((file) => file.name === `${rawId}.json`);
    if (existing) {
      const stored = JSON.parse(existing.text).creationCommand;
      return sameCreationCommand(stored, creationCommandFor(input, rawId))
        ? { result: receiptResult('idempotent_replay', revision, [identity.hostedTaskBoardTaskId(teamId, rawId)]) }
        : { result: conflict('idempotency_mismatch') };
    }
  }
  const target = 'taskId' in command ? view.tasks.get(command.taskId) : undefined;
  if ('taskId' in command && !target) return { result: { kind: 'not_found' } };
  const members = projection.hostedActiveRosterMembers(teamId, {
    config: before.rosterFiles.find((file) => file.name === 'config.json').text,
    meta: before.rosterFiles.find((file) => file.name === 'members.meta.json').text,
  });
  if (isNoop(command, view, target, members)) {
    return { result: receiptResult('committed', revision, command.kind === 'reorder_column' ? command.orderedTaskIds : [command.taskId]) };
  }
  if (command.expectedRevision !== revision) {
    return { result: { kind: 'stale_revision', currentSourceGeneration: sourceGeneration, currentRevision: revision } };
  }
  const applied = apply(context, input, view, target, members);
  const after = readSnapshot(context.paths);
  if (applied.conflict) return { result: conflict(applied.conflict, revisionOf(after)) };
  return { result: receiptResult('committed', revisionOf(after), applied.affected), selfWriteEffects: selfWriteEffects(before, after) };
}

/**
 * Parses `rawInput`, takes the board lock within `lockTimeoutMs` and returns the wire output
 * `{schemaVersion: 1, result, selfWriteEffects}`. Invalid input throws HostedTaskCommandInputError.
 */
function executeHostedTaskCommand(rawInput, { claudeDir }) {
  const input = parseInput(rawInput);
  const context = createControllerContext({ teamName: input.teamName, claudeDir });
  let outcome;
  if (directoryIdentity(context.paths.teamDir) === null) {
    outcome = { result: { kind: 'unsafe_active' } };
  } else {
    try {
      outcome = withTeamBoardLock(context.paths, () => runLocked(context, input), { acquireTimeoutMs: input.lockTimeoutMs });
    } catch (error) {
      if (!error || error.code !== FILE_LOCK_TIMEOUT_CODE) throw error;
      outcome = { result: { kind: 'unavailable', retryAfterMs: RETRY_AFTER_MS } };
    }
  }
  return { schemaVersion: 1, result: outcome.result, selfWriteEffects: outcome.selfWriteEffects || [] };
}

module.exports = { HostedTaskCommandInputError, executeHostedTaskCommand };
