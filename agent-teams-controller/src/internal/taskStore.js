const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonFileSync } = require('./atomicFile.js');
const { getTeamBoardLockContext } = require('./boardLock.js');
const reviewStateHelpers = require('./reviewState.js');

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TASK_STORAGE_IDENTITY = Symbol('taskStorageIdentity');
const TASK_SCAN_SNAPSHOTS = Symbol('taskScanSnapshots');
const DEFAULT_TASK_SCAN_SNAPSHOT_TTL_MS = 250;
const DEFAULT_TASK_SCAN_SNAPSHOT_LIMIT = 32;
const unlockedTaskScanSnapshots = new Map();

function monotonicNowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

let taskScanSnapshotCacheConfig = Object.freeze({
  clock: monotonicNowMs,
  ttlMs: DEFAULT_TASK_SCAN_SNAPSHOT_TTL_MS,
  maxEntries: DEFAULT_TASK_SCAN_SNAPSHOT_LIMIT,
});

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallbackValue;
  }
}

function writeJson(filePath, value) {
  writeJsonFileSync(filePath, value);
}

function getTaskPath(paths, taskId) {
  return path.join(paths.tasksDir, `${String(taskId)}.json`);
}

function looksLikeCanonicalTaskId(taskId) {
  return UUID_TASK_ID_PATTERN.test(String(taskId || '').trim());
}

function deriveDisplayId(taskId) {
  const normalized = String(taskId || '').trim();
  if (!normalized) return normalized;
  return looksLikeCanonicalTaskId(normalized) ? normalized.slice(0, 8).toLowerCase() : normalized;
}

function getPersistedTaskId(rawTask) {
  return typeof rawTask?.id === 'string' || typeof rawTask?.id === 'number'
    ? String(rawTask.id)
    : '';
}

function attachTaskStorageIdentity(task, identity) {
  Object.defineProperty(task, TASK_STORAGE_IDENTITY, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({ ...identity }),
    writable: false,
  });
  return task;
}

function cloneTaskValue(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);

  const clone = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value) || Object.prototype);
  seen.set(value, clone);

  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      descriptor.value = cloneTaskValue(descriptor.value, seen);
    }
    Object.defineProperty(clone, key, descriptor);
  }

  return clone;
}

function cloneTaskForCaller(task) {
  const clonedTask = cloneTaskValue(task);
  const storageIdentity = clonedTask[TASK_STORAGE_IDENTITY];
  if (storageIdentity && !Object.isFrozen(storageIdentity)) {
    Object.freeze(storageIdentity);
  }
  return clonedTask;
}

function normalizeTask(rawTask, filePath) {
  if (!rawTask || typeof rawTask !== 'object') {
    throw new Error(`Invalid task payload${filePath ? `: ${filePath}` : ''}`);
  }

  const persistedTaskId = getPersistedTaskId(rawTask);
  if (!persistedTaskId) {
    throw new Error(`Task is missing id${filePath ? `: ${filePath}` : ''}`);
  }
  const id = filePath ? path.basename(filePath, '.json') : persistedTaskId;

  const task = {
    ...rawTask,
    id,
    displayId:
      typeof rawTask.displayId === 'string' && rawTask.displayId.trim()
        ? rawTask.displayId.trim()
        : deriveDisplayId(id),
    reviewState: normalizeTaskReviewState(rawTask.reviewState),
  };

  if (!TASK_STATUSES.has(String(task.status || '').trim())) {
    throw new Error(
      `Invalid task status "${String(task.status || '')}"${filePath ? `: ${filePath}` : ''}`
    );
  }
  task.status = String(task.status).trim();

  return filePath
    ? attachTaskStorageIdentity(task, {
        canonicalTaskId: id,
        persistedTaskId,
        filePath,
      })
    : task;
}

function normalizeTaskReviewState(value) {
  return reviewStateHelpers.normalizeReviewState(value);
}

function normalizeCreationCommand(value) {
  if (value == null) return undefined;
  if (!value || typeof value !== 'object') {
    throw new Error('Task creation command conflict: invalid provenance');
  }
  const namespace = typeof value.namespace === 'string' ? value.namespace.trim() : '';
  const scopeKey = typeof value.scopeKey === 'string' ? value.scopeKey.trim() : '';
  const operation = typeof value.operation === 'string' ? value.operation.trim() : '';
  const commandId = typeof value.commandId === 'string' ? value.commandId.trim() : '';
  const payloadHash = typeof value.payloadHash === 'string' ? value.payloadHash.trim() : '';
  const idempotencyKey =
    typeof value.idempotencyKey === 'string' ? value.idempotencyKey.trim() : '';
  if (!namespace || !scopeKey || !operation || !commandId || !payloadHash) {
    throw new Error('Task creation command conflict: incomplete provenance');
  }
  return {
    namespace,
    scopeKey,
    operation,
    commandId,
    payloadHash,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

function buildTaskScanSnapshot(paths) {
  ensureDir(paths.tasksDir);
  const entries = fs.readdirSync(paths.tasksDir);
  const rows = [];
  const identityRows = [];
  const anomalies = [];

  for (const fileName of entries) {
    if (!fileName.endsWith('.json') || fileName.startsWith('.')) continue;
    const filePath = path.join(paths.tasksDir, fileName);
    let rawTask;
    try {
      rawTask = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      anomalies.push({
        code: 'unreadable_task',
        taskId: path.basename(fileName, '.json'),
        filePath,
        detail: error instanceof Error ? error.message : 'Unreadable task row',
      });
      continue;
    }
    if (!rawTask) continue;
    if (rawTask.metadata && rawTask.metadata._internal === true) continue;
    const canonicalTaskId = path.basename(fileName, '.json');
    const persistedTaskId = getPersistedTaskId(rawTask);
    if (persistedTaskId) {
      identityRows.push({ canonicalTaskId, persistedTaskId, filePath });
      if (persistedTaskId !== canonicalTaskId) {
        anomalies.push({
          code: 'task_id_mismatch',
          taskId: canonicalTaskId,
          filePath,
          detail: `Task file "${canonicalTaskId}.json" contains id "${persistedTaskId}"; use canonical task id "${canonicalTaskId}" for lookup and mutation.`,
        });
      }
    }
    try {
      const task = normalizeTask(rawTask, filePath);
      rows.push({
        canonicalTaskId: task.id,
        persistedTaskId,
        filePath,
        task,
      });
    } catch (error) {
      const taskId = getPersistedTaskId(rawTask) || path.basename(fileName, '.json');
      anomalies.push({
        code: 'unreadable_task',
        taskId,
        filePath,
        detail: error instanceof Error ? error.message : 'Unreadable task row',
      });
    }
  }

  const identityClaims = new Map();
  for (const row of identityRows) {
    for (const claimedId of new Set([row.canonicalTaskId, row.persistedTaskId])) {
      const claimants = identityClaims.get(claimedId) || [];
      claimants.push(row);
      identityClaims.set(claimedId, claimants);
    }
  }

  const collidingTaskIds = new Set();
  for (const [claimedId, claimants] of identityClaims) {
    if (claimants.length < 2) continue;
    const canonicalTaskIds = claimants.map((row) => row.canonicalTaskId).sort();
    for (const taskId of canonicalTaskIds) {
      collidingTaskIds.add(taskId);
    }
    anomalies.push({
      code: 'task_id_collision',
      taskId: claimedId,
      detail: `Task identity "${claimedId}" is claimed by multiple files: ${canonicalTaskIds
        .map((taskId) => `"${taskId}.json"`)
        .join(', ')}.`,
    });
  }

  const rowsByCanonicalId = new Map(rows.map((row) => [row.canonicalTaskId, row]));
  const identityRowsByPersistedId = new Map();
  for (const row of identityRows) {
    const persistedRows = identityRowsByPersistedId.get(row.persistedTaskId) || [];
    persistedRows.push(row);
    identityRowsByPersistedId.set(row.persistedTaskId, persistedRows);
  }
  const rowsByDisplayId = new Map();
  for (const row of rows) {
    const displayRows = rowsByDisplayId.get(row.task.displayId) || [];
    displayRows.push(row);
    rowsByDisplayId.set(row.task.displayId, displayRows);
  }

  return {
    rows,
    rowsByCanonicalId,
    rowsByDisplayId,
    identityRows,
    identityRowsByPersistedId,
    identityClaims,
    anomalies,
    collidingTaskIds,
  };
}

function readUnlockedTaskScanSnapshot(snapshotKey) {
  const cached = unlockedTaskScanSnapshots.get(snapshotKey);
  if (!cached) return null;

  const ageMs = readTaskScanSnapshotCacheClock() - cached.cachedAtMs;
  if (ageMs < 0 || ageMs >= taskScanSnapshotCacheConfig.ttlMs) {
    unlockedTaskScanSnapshots.delete(snapshotKey);
    return null;
  }

  unlockedTaskScanSnapshots.delete(snapshotKey);
  unlockedTaskScanSnapshots.set(snapshotKey, cached);
  return cached.snapshot;
}

function cacheUnlockedTaskScanSnapshot(snapshotKey, snapshot) {
  unlockedTaskScanSnapshots.delete(snapshotKey);
  unlockedTaskScanSnapshots.set(snapshotKey, {
    cachedAtMs: readTaskScanSnapshotCacheClock(),
    snapshot,
  });

  while (unlockedTaskScanSnapshots.size > taskScanSnapshotCacheConfig.maxEntries) {
    const oldestSnapshotKey = unlockedTaskScanSnapshots.keys().next().value;
    unlockedTaskScanSnapshots.delete(oldestSnapshotKey);
  }
}

function scanUnlockedTaskRows(paths, snapshotKey) {
  const cachedSnapshot = readUnlockedTaskScanSnapshot(snapshotKey);
  if (cachedSnapshot) return cachedSnapshot;

  const snapshot = buildTaskScanSnapshot(paths);
  cacheUnlockedTaskScanSnapshot(snapshotKey, snapshot);
  return snapshot;
}

function readTaskScanSnapshotCacheClock() {
  const clockMs = taskScanSnapshotCacheConfig.clock();
  if (!Number.isFinite(clockMs)) {
    throw new Error('Task scan snapshot cache clock must return a finite number');
  }
  return clockMs;
}

function scanTaskRows(paths) {
  const lockContext = getTeamBoardLockContext(paths);
  const snapshotKey = path.resolve(paths.tasksDir);
  if (!lockContext) {
    return scanUnlockedTaskRows(paths, snapshotKey);
  }

  const lockSnapshots = lockContext.get(TASK_SCAN_SNAPSHOTS);
  const existingSnapshot = lockSnapshots?.get(snapshotKey);
  if (existingSnapshot) {
    return existingSnapshot;
  }

  const snapshot = buildTaskScanSnapshot(paths);
  const snapshots = lockSnapshots || new Map();
  snapshots.set(snapshotKey, snapshot);
  lockContext.set(TASK_SCAN_SNAPSHOTS, snapshots);
  return snapshot;
}

function invalidateTaskScanSnapshot(paths) {
  const snapshotKey = path.resolve(paths.tasksDir);
  unlockedTaskScanSnapshots.delete(snapshotKey);
  const lockContext = getTeamBoardLockContext(paths);
  lockContext?.get(TASK_SCAN_SNAPSHOTS)?.delete(snapshotKey);
}

// Standalone reads may share a full directory scan for at most 250 ms by default. The hard
// TTL intentionally does not depend on filesystem metadata, so every external change becomes
// observable on the first read after expiry even if an atomic replacement preserves metadata.
function configureTaskScanSnapshotCache(options = {}) {
  const clock = options.clock ?? monotonicNowMs;
  const ttlMs = options.ttlMs ?? DEFAULT_TASK_SCAN_SNAPSHOT_TTL_MS;
  const maxEntries = options.maxEntries ?? DEFAULT_TASK_SCAN_SNAPSHOT_LIMIT;
  if (typeof clock !== 'function') {
    throw new Error('Task scan snapshot cache clock must be a function');
  }
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Task scan snapshot cache ttlMs must be a positive finite number');
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) {
    throw new Error('Task scan snapshot cache maxEntries must be a positive safe integer');
  }

  const previousConfig = taskScanSnapshotCacheConfig;
  taskScanSnapshotCacheConfig = Object.freeze({ clock, ttlMs, maxEntries });
  unlockedTaskScanSnapshots.clear();

  let restored = false;
  return function restoreTaskScanSnapshotCacheConfig() {
    if (restored) return;
    restored = true;
    unlockedTaskScanSnapshots.clear();
    taskScanSnapshotCacheConfig = previousConfig;
  };
}

function sortTasks(tasks) {
  tasks.sort((a, b) => {
    const byDisplay = String(a.displayId || a.id).localeCompare(
      String(b.displayId || b.id),
      undefined,
      {
        numeric: true,
        sensitivity: 'base',
      }
    );
    if (byDisplay !== 0) return byDisplay;
    return String(a.id).localeCompare(String(b.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });
}

function listTaskRows(paths, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  const { rows, anomalies } = scanTaskRows(paths);
  const tasks = rows
    .map((row) => cloneTaskForCaller(row.task))
    .filter((task) => includeDeleted || task.status !== 'deleted');
  sortTasks(tasks);
  return { tasks, anomalies: anomalies.map((anomaly) => cloneTaskValue(anomaly)) };
}

function listRawTasks(paths) {
  return listTaskRows(paths, { includeDeleted: true }).tasks;
}

function listTasks(paths, options = {}) {
  return listTaskRows(paths, options).tasks;
}

function assertTaskRowHasUnambiguousIdentity(scan, row, taskRef) {
  if (!scan.collidingTaskIds.has(row.canonicalTaskId)) return;
  throw new Error(
    `Task identity collision for "${String(taskRef)}": canonical task file "${row.canonicalTaskId}.json" shares an identity with another task file`
  );
}

function resolveTaskRow(paths, taskRef, options = {}) {
  const normalizedRef = String(taskRef || '')
    .trim()
    .replace(/^#/, '');
  if (!normalizedRef) {
    throw new Error('Missing taskId');
  }

  const includeDeleted = options.includeDeleted === true;
  const scan = scanTaskRows(paths);
  const exact = scan.rowsByCanonicalId.get(normalizedRef);

  if (exact) {
    if (!includeDeleted && exact.task.status === 'deleted') {
      throw new Error(`Task not found: ${normalizedRef}`);
    }
    assertTaskRowHasUnambiguousIdentity(scan, exact, normalizedRef);
    return exact;
  }

  const nonCanonicalIdentityClaims = (
    scan.identityRowsByPersistedId.get(normalizedRef) || []
  ).filter(
    (row) => row.persistedTaskId !== row.canonicalTaskId && row.persistedTaskId === normalizedRef
  );
  if (nonCanonicalIdentityClaims.length > 0) {
    throw new Error(
      `Non-canonical task reference "${normalizedRef}" is persisted in ${nonCanonicalIdentityClaims
        .map((row) => `"${row.canonicalTaskId}.json"`)
        .sort()
        .join(', ')}; use the canonical file task id instead`
    );
  }

  const byDisplay = (scan.rowsByDisplayId.get(normalizedRef) || []).filter(
    (row) => includeDeleted || row.task.status !== 'deleted'
  );
  if (byDisplay.length > 1) {
    throw new Error(
      `Ambiguous task reference "${normalizedRef}" matches task files: ${byDisplay
        .map((row) => `"${row.canonicalTaskId}.json"`)
        .sort()
        .join(', ')}`
    );
  }
  if (byDisplay.length === 1) {
    assertTaskRowHasUnambiguousIdentity(scan, byDisplay[0], normalizedRef);
    return byDisplay[0];
  }

  throw new Error(`Task not found: ${normalizedRef}`);
}

function resolveTaskRef(paths, taskRef, options = {}) {
  return resolveTaskRow(paths, taskRef, options).canonicalTaskId;
}

function readTask(paths, taskRef, options = {}) {
  return cloneTaskForCaller(resolveTaskRow(paths, taskRef, options).task);
}

function appendHistoryEvent(events, event) {
  const list = Array.isArray(events) ? [...events] : [];
  list.push({ id: crypto.randomUUID(), timestamp: nowIso(), ...event });
  return list;
}

function isOpenReviewInterval(interval) {
  return interval && interval.completedAt === undefined;
}

function closeOpenReviewIntervals(task, timestamp) {
  if (!Array.isArray(task.reviewIntervals)) return false;
  let changed = false;
  task.reviewIntervals = task.reviewIntervals.map((interval) => {
    if (!isOpenReviewInterval(interval)) return interval;
    changed = true;
    const startedAtMs = Date.parse(interval.startedAt);
    const timestampMs = Date.parse(timestamp);
    const completedAt =
      Number.isFinite(startedAtMs) && Number.isFinite(timestampMs) && timestampMs < startedAtMs
        ? interval.startedAt
        : timestamp;
    return { ...interval, completedAt };
  });
  return changed;
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim();
  return TASK_STATUSES.has(normalized) ? normalized : null;
}

function parseRelationshipList(paths, value, options = {}) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean)
      : [];

  return rawValues.map((entry) => resolveTaskRef(paths, entry, options));
}

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

function computeInitialStatus(paths, input, owner, blockedByIds) {
  const explicit = normalizeStatus(input.status);
  if (explicit) return explicit;
  if (blockedByIds.length > 0) return 'pending';
  if (owner && input.startImmediately === true) return 'in_progress';
  return 'pending';
}

function pickTaskId(input) {
  if (typeof input.id === 'string' && input.id.trim()) {
    return input.id.trim();
  }
  return crypto.randomUUID();
}

function pickUniqueDisplayId(paths, canonicalId, explicitDisplayId) {
  const preferred =
    typeof explicitDisplayId === 'string' && explicitDisplayId.trim()
      ? explicitDisplayId.trim()
      : deriveDisplayId(canonicalId);

  const existing = new Set(
    listRawTasks(paths).map((task) => task.displayId || deriveDisplayId(task.id))
  );
  if (!existing.has(preferred)) {
    return preferred;
  }

  let length = Math.max(preferred.length, 8);
  while (length < canonicalId.length) {
    const candidate = canonicalId.slice(0, length).toLowerCase();
    if (!existing.has(candidate)) {
      return candidate;
    }
    length += 1;
  }

  return canonicalId.toLowerCase();
}

function wouldCreateBlockCycle(paths, sourceId, targetId) {
  const visited = new Set();
  const stack = [targetId];

  while (stack.length > 0) {
    const currentId = stack.pop();
    if (!currentId || visited.has(currentId)) continue;
    if (currentId === sourceId) return true;
    visited.add(currentId);
    try {
      const currentTask = readTask(paths, currentId, { includeDeleted: true });
      for (const depId of currentTask.blockedBy || []) {
        stack.push(depId);
      }
    } catch {
      // Ignore unreadable dependency rows during cycle probe.
    }
  }

  return false;
}

function writeTask(paths, task) {
  const storageIdentity = task[TASK_STORAGE_IDENTITY];
  const canonicalTaskId = storageIdentity?.canonicalTaskId || String(task.id);
  const persistedTaskId = storageIdentity?.persistedTaskId || canonicalTaskId;
  if (String(task.id) !== canonicalTaskId) {
    throw new Error(
      `Task id is immutable: canonical task file "${canonicalTaskId}.json" cannot be written as "${String(task.id)}.json"`
    );
  }
  const persistedTask =
    persistedTaskId === canonicalTaskId ? task : { ...task, id: persistedTaskId };
  try {
    writeJson(getTaskPath(paths, canonicalTaskId), persistedTask);
  } finally {
    invalidateTaskScanSnapshot(paths);
  }
}

function assertTaskIdIsAvailable(paths, canonicalTaskId) {
  const claimedRows = scanTaskRows(paths).identityClaims.get(canonicalTaskId) || [];
  if (claimedRows.length === 0) return;
  throw new Error(
    `Task id collision: "${canonicalTaskId}" is already claimed by ${claimedRows
      .map((row) => `"${row.canonicalTaskId}.json"`)
      .sort()
      .join(', ')}`
  );
}

function createTask(paths, input = {}) {
  ensureDir(paths.tasksDir);

  const canonicalId = pickTaskId(input);
  if (fs.existsSync(getTaskPath(paths, canonicalId))) {
    throw new Error(`Task already exists: ${canonicalId}`);
  }
  assertTaskIdIsAvailable(paths, canonicalId);
  const creationCommand = input.creationCommand
    ? normalizeCreationCommand(input.creationCommand)
    : undefined;
  if (creationCommand && creationCommand.commandId !== canonicalId) {
    throw new Error('Task creation command conflict: command id does not match task id');
  }

  const blockedByIds = parseRelationshipList(paths, input['blocked-by'] ?? input.blockedBy);
  const relatedIds = parseRelationshipList(paths, input.related);
  const owner =
    typeof input.owner === 'string' && input.owner.trim() ? input.owner.trim() : undefined;
  const createdBy =
    typeof input.from === 'string' && input.from.trim()
      ? input.from.trim()
      : typeof input.createdBy === 'string' && input.createdBy.trim()
        ? input.createdBy.trim()
        : undefined;
  const createdAt =
    typeof input.createdAt === 'string' && input.createdAt.trim()
      ? input.createdAt.trim()
      : nowIso();
  const status = computeInitialStatus(paths, input, owner, blockedByIds);
  const displayId = pickUniqueDisplayId(paths, canonicalId, input.displayId);

  for (const depId of blockedByIds) {
    if (wouldCreateBlockCycle(paths, canonicalId, depId)) {
      throw new Error(`Circular dependency: ${depId} already depends on ${canonicalId}`);
    }
  }

  const task = normalizeTask({
    id: canonicalId,
    displayId,
    subject:
      typeof input.subject === 'string' && input.subject.trim()
        ? input.subject.trim()
        : String(input.subject || '').trim(),
    description:
      typeof input.description === 'string' && input.description.length > 0
        ? input.description
        : String(input.subject || '').trim(),
    descriptionTaskRefs: normalizeTaskRefs(input.descriptionTaskRefs),
    activeForm:
      typeof input.activeForm === 'string'
        ? input.activeForm
        : typeof input['active-form'] === 'string'
          ? input['active-form']
          : undefined,
    owner,
    createdBy,
    status,
    createdAt,
    updatedAt: createdAt,
    workIntervals:
      status === 'in_progress'
        ? [{ startedAt: createdAt }]
        : Array.isArray(input.workIntervals)
          ? input.workIntervals
          : undefined,
    historyEvents: appendHistoryEvent(undefined, {
      type: 'task_created',
      status,
      ...(createdBy ? { actor: createdBy } : {}),
      timestamp: createdAt,
    }),
    blocks: Array.isArray(input.blocks) ? [...input.blocks] : [],
    blockedBy: blockedByIds,
    related: relatedIds.length > 0 ? relatedIds : undefined,
    projectPath:
      typeof input.projectPath === 'string' && input.projectPath.trim()
        ? input.projectPath.trim()
        : undefined,
    comments: Array.isArray(input.comments) ? input.comments : undefined,
    prompt:
      typeof input.prompt === 'string' && input.prompt.trim() ? input.prompt.trim() : undefined,
    promptTaskRefs: normalizeTaskRefs(input.promptTaskRefs),
    needsClarification:
      input.needsClarification === 'lead' || input.needsClarification === 'user'
        ? input.needsClarification
        : undefined,
    reviewState: normalizeTaskReviewState(input.reviewState),
    deletedAt:
      status === 'deleted' && typeof input.deletedAt === 'string' ? input.deletedAt : undefined,
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
    ...(typeof input.sourceMessageId === 'string' && input.sourceMessageId.trim()
      ? { sourceMessageId: input.sourceMessageId.trim() }
      : {}),
    ...(input.sourceMessage && typeof input.sourceMessage === 'object'
      ? { sourceMessage: input.sourceMessage }
      : {}),
    ...(creationCommand ? { creationCommand } : {}),
  });

  if (!task.subject) {
    throw new Error('Missing subject');
  }

  writeTask(paths, task);

  for (const depId of blockedByIds) {
    const dependencyTask = readTask(paths, depId, { includeDeleted: true });
    const dependencyBlocks = Array.isArray(dependencyTask.blocks) ? dependencyTask.blocks : [];
    if (!dependencyBlocks.includes(task.id)) {
      dependencyTask.blocks = dependencyBlocks.concat([task.id]);
      dependencyTask.updatedAt = nowIso();
      writeTask(paths, dependencyTask);
    }
  }

  for (const relatedId of relatedIds) {
    const relatedTask = readTask(paths, relatedId, { includeDeleted: true });
    const existingRelated = Array.isArray(relatedTask.related) ? relatedTask.related : [];
    if (!existingRelated.includes(task.id)) {
      relatedTask.related = existingRelated.concat([task.id]);
      relatedTask.updatedAt = nowIso();
      writeTask(paths, relatedTask);
    }
  }

  return task;
}

function reconcileTaskCreation(paths, input = {}) {
  const taskId = String(input.id || '').trim();
  if (!taskId) {
    throw new Error('Task creation command conflict: missing task id');
  }
  const expectedCommand = normalizeCreationCommand(input.creationCommand);
  if (!expectedCommand || expectedCommand.commandId !== taskId) {
    throw new Error('Task creation command conflict: command id does not match task id');
  }

  const task = readTask(paths, taskId, { includeDeleted: true });
  const existingCommand = normalizeCreationCommand(task.creationCommand);
  const blockedByIds = Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [];
  const relatedIds = Array.isArray(task.related) ? task.related.map(String) : [];
  let shouldPersistExpectedCommand = !existingCommand;

  if (existingCommand) {
    if (
      existingCommand.namespace !== expectedCommand.namespace ||
      existingCommand.scopeKey !== expectedCommand.scopeKey ||
      existingCommand.operation !== expectedCommand.operation ||
      existingCommand.commandId !== expectedCommand.commandId ||
      existingCommand.payloadHash !== expectedCommand.payloadHash ||
      (existingCommand.idempotencyKey !== undefined &&
        expectedCommand.idempotencyKey !== undefined &&
        existingCommand.idempotencyKey !== expectedCommand.idempotencyKey)
    ) {
      throw new Error(`Task creation command conflict: ${taskId}`);
    }
    shouldPersistExpectedCommand = Boolean(
      !existingCommand.idempotencyKey && expectedCommand.idempotencyKey
    );
  } else if (input.allowLegacyAdoption === false) {
    throw new Error(`Task creation command conflict: ${taskId} is not owned by this command`);
  } else {
    assertLegacyTaskMatchesCreationInput(task, input);
  }

  ensureTaskCreationBacklinks(paths, taskId, blockedByIds, relatedIds);

  const reconciled = readTask(paths, taskId, { includeDeleted: true });
  if (shouldPersistExpectedCommand) {
    reconciled.creationCommand = expectedCommand;
    writeTask(paths, reconciled);
  }
  return readTask(paths, taskId, { includeDeleted: true });
}

function ensureTaskCreationBacklinks(paths, taskId, blockedByIds, relatedIds) {
  for (const dependencyId of blockedByIds) {
    const dependency = readTask(paths, dependencyId, { includeDeleted: true });
    const blocks = Array.isArray(dependency.blocks) ? dependency.blocks : [];
    if (!blocks.includes(taskId)) {
      dependency.blocks = [...blocks, taskId];
      dependency.updatedAt = nowIso();
      writeTask(paths, dependency);
    }
  }
  for (const relatedId of relatedIds) {
    const related = readTask(paths, relatedId, { includeDeleted: true });
    const existingRelatedIds = Array.isArray(related.related) ? related.related : [];
    if (!existingRelatedIds.includes(taskId)) {
      related.related = [...existingRelatedIds, taskId];
      related.updatedAt = nowIso();
      writeTask(paths, related);
    }
  }
}

function assertLegacyTaskMatchesCreationInput(task, input) {
  const expectedCreatedBy =
    typeof input.from === 'string' && input.from.trim()
      ? input.from.trim()
      : typeof input.createdBy === 'string' && input.createdBy.trim()
        ? input.createdBy.trim()
        : undefined;
  if (task.createdBy !== expectedCreatedBy) {
    throw new Error(
      `Task creation command conflict: legacy task ${task.id} does not match payload`
    );
  }
}

function updateTask(paths, taskRef, updater, options = {}) {
  const existingTask = readTask(paths, taskRef, { includeDeleted: true });
  const updatedTask = updater({ ...existingTask }) || existingTask;
  if (String(updatedTask.id) !== existingTask.id) {
    throw new Error(
      `Task id is immutable: canonical task file "${existingTask.id}.json" cannot be changed to "${String(updatedTask.id)}"`
    );
  }
  const nextTask = normalizeTask(updatedTask);
  const storageIdentity = existingTask[TASK_STORAGE_IDENTITY];
  if (storageIdentity) {
    attachTaskStorageIdentity(nextTask, storageIdentity);
  }
  nextTask.updatedAt = nowIso();
  writeTask(paths, nextTask);
  return nextTask;
}

function setTaskStatus(paths, taskRef, nextStatus, actor) {
  const status = normalizeStatus(nextStatus);
  if (!status) {
    throw new Error(`Invalid status: ${String(nextStatus)}`);
  }

  return updateTask(paths, taskRef, (task) => {
    if (task.status === status) {
      if (status === 'deleted' || status === 'in_progress') {
        task.reviewState = 'none';
      } else if (
        status === 'pending' &&
        normalizeTaskReviewState(task.reviewState) !== 'needsFix'
      ) {
        task.reviewState = 'none';
      }
      return task;
    }
    const timestamp = nowIso();
    const workIntervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
    const lastInterval = workIntervals.length > 0 ? workIntervals[workIntervals.length - 1] : null;

    if (task.status !== 'in_progress' && status === 'in_progress') {
      if (!lastInterval || lastInterval.completedAt !== undefined) {
        workIntervals.push({ startedAt: timestamp });
      }
    } else if (task.status === 'in_progress' && status !== 'in_progress') {
      if (lastInterval && lastInterval.completedAt === undefined) {
        lastInterval.completedAt = timestamp;
      }
    }
    if (status === 'pending' || status === 'in_progress' || status === 'deleted') {
      closeOpenReviewIntervals(task, timestamp);
    }

    task.workIntervals = workIntervals.length > 0 ? workIntervals : undefined;
    task.historyEvents = appendHistoryEvent(task.historyEvents, {
      type: 'status_changed',
      from: task.status,
      to: status,
      ...(actor ? { actor } : {}),
      timestamp,
    });
    task.status = status;

    if (status === 'deleted') {
      task.deletedAt = timestamp;
      task.reviewState = 'none';
    } else if (task.deletedAt) {
      delete task.deletedAt;
    }

    if (status === 'in_progress') {
      task.reviewState = 'none';
    } else if (status === 'pending' && normalizeTaskReviewState(task.reviewState) !== 'needsFix') {
      task.reviewState = 'none';
    }

    return task;
  });
}

function normalizeOwnerValue(owner) {
  if (owner == null || owner === 'clear' || owner === 'none') {
    return undefined;
  }
  const normalized = String(owner).trim();
  return normalized ? normalized : undefined;
}

function setTaskOwner(paths, taskRef, owner, actor) {
  return updateTask(paths, taskRef, (task) => {
    const previousOwner = normalizeOwnerValue(task.owner);
    const nextOwner = normalizeOwnerValue(owner);

    if (nextOwner) {
      task.owner = nextOwner;
    } else {
      delete task.owner;
    }

    if (previousOwner !== nextOwner) {
      task.historyEvents = appendHistoryEvent(task.historyEvents, {
        type: 'owner_changed',
        ...(previousOwner ? { from: previousOwner } : {}),
        ...(nextOwner ? { to: nextOwner } : {}),
        ...(actor ? { actor } : {}),
      });
    }

    return task;
  });
}

function updateTaskFields(paths, taskRef, fields) {
  return updateTask(paths, taskRef, (task) => {
    if (fields.subject !== undefined) {
      task.subject = fields.subject;
    }
    if (fields.description !== undefined) {
      task.description = fields.description;
    }
    return task;
  });
}

function normalizeMemberName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

function addTaskComment(paths, taskRef, text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Missing comment text');
  }

  const comment = {
    id: options.id || crypto.randomUUID(),
    author:
      typeof options.author === 'string' && options.author.trim() ? options.author.trim() : 'user',
    text,
    createdAt:
      typeof options.createdAt === 'string' && options.createdAt.trim()
        ? options.createdAt.trim()
        : nowIso(),
    type: options.type || 'regular',
    ...(normalizeTaskRefs(options.taskRefs)
      ? { taskRefs: normalizeTaskRefs(options.taskRefs) }
      : {}),
    ...(Array.isArray(options.attachments) && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };

  let inserted = false;
  const task = updateTask(paths, taskRef, (currentTask) => {
    const comments = Array.isArray(currentTask.comments) ? currentTask.comments : [];
    if (comments.some((entry) => entry.id === comment.id)) {
      return currentTask;
    }

    currentTask.comments = comments.concat([comment]);
    inserted = true;
    return currentTask;
  });

  return { comment, task, inserted, clarificationCleared: false };
}

function setNeedsClarification(paths, taskRef, value) {
  return updateTask(paths, taskRef, (task) => {
    if (value === null || value === 'clear') {
      delete task.needsClarification;
    } else if (value === 'lead' || value === 'user') {
      task.needsClarification = value;
    } else {
      throw new Error(`Invalid clarification value: ${String(value)}`);
    }
    return task;
  });
}

function addTaskAttachmentMeta(paths, taskRef, meta) {
  return updateTask(paths, taskRef, (task) => {
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    if (!attachments.some((entry) => entry.id === meta.id)) {
      task.attachments = attachments.concat([meta]);
    }
    return task;
  });
}

function removeTaskAttachment(paths, taskRef, attachmentId) {
  return updateTask(paths, taskRef, (task) => {
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    const filtered = attachments.filter((entry) => entry.id !== attachmentId);
    if (filtered.length > 0) task.attachments = filtered;
    else delete task.attachments;
    return task;
  });
}

function addCommentAttachmentMeta(paths, taskRef, commentRef, meta) {
  return updateTask(paths, taskRef, (task) => {
    const comments = Array.isArray(task.comments) ? [...task.comments] : [];
    const commentIndex = comments.findIndex((entry) => String(entry.id) === String(commentRef));
    if (commentIndex < 0) {
      throw new Error(`Comment not found: ${String(commentRef)}`);
    }
    const comment = { ...comments[commentIndex] };
    const attachments = Array.isArray(comment.attachments) ? comment.attachments : [];
    if (!attachments.some((entry) => entry.id === meta.id)) {
      comment.attachments = attachments.concat([meta]);
    }
    comments[commentIndex] = comment;
    task.comments = comments;
    return task;
  });
}

function linkTask(paths, taskRef, targetRef, relationship) {
  const sourceId = resolveTaskRef(paths, taskRef);
  const targetId = resolveTaskRef(paths, targetRef);
  if (sourceId === targetId) {
    throw new Error('Cannot link a task to itself');
  }

  if (relationship === 'blocks') {
    return linkTask(paths, targetId, sourceId, 'blocked-by');
  }

  if (relationship === 'blocked-by') {
    if (wouldCreateBlockCycle(paths, sourceId, targetId)) {
      throw new Error(`Circular dependency: ${targetId} already depends on ${sourceId}`);
    }

    const sourceTask = readTask(paths, sourceId, { includeDeleted: true });
    const targetTask = readTask(paths, targetId, { includeDeleted: true });
    if (!(sourceTask.blockedBy || []).includes(targetId)) {
      sourceTask.blockedBy = [...(sourceTask.blockedBy || []), targetId];
      writeTask(paths, sourceTask);
    }
    if (!(targetTask.blocks || []).includes(sourceId)) {
      targetTask.blocks = [...(targetTask.blocks || []), sourceId];
      writeTask(paths, targetTask);
    }
    return readTask(paths, sourceId, { includeDeleted: true });
  }

  if (relationship !== 'related') {
    throw new Error(`Unsupported relationship: ${String(relationship)}`);
  }

  const sourceTask = readTask(paths, sourceId, { includeDeleted: true });
  const targetTask = readTask(paths, targetId, { includeDeleted: true });
  if (!(sourceTask.related || []).includes(targetId)) {
    sourceTask.related = [...(sourceTask.related || []), targetId];
    writeTask(paths, sourceTask);
  }
  if (!(targetTask.related || []).includes(sourceId)) {
    targetTask.related = [...(targetTask.related || []), sourceId];
    writeTask(paths, targetTask);
  }
  return readTask(paths, sourceId, { includeDeleted: true });
}

function unlinkTask(paths, taskRef, targetRef, relationship) {
  const sourceId = resolveTaskRef(paths, taskRef, { includeDeleted: true });
  const targetId = resolveTaskRef(paths, targetRef, { includeDeleted: true });

  if (relationship === 'blocks') {
    return unlinkTask(paths, targetId, sourceId, 'blocked-by');
  }

  const sourceTask = readTask(paths, sourceId, { includeDeleted: true });
  if (relationship === 'blocked-by') {
    sourceTask.blockedBy = (sourceTask.blockedBy || []).filter((entry) => entry !== targetId);
    writeTask(paths, sourceTask);
    try {
      const targetTask = readTask(paths, targetId, { includeDeleted: true });
      targetTask.blocks = (targetTask.blocks || []).filter((entry) => entry !== sourceId);
      writeTask(paths, targetTask);
    } catch {
      // Ignore missing reverse link target.
    }
    return readTask(paths, sourceId, { includeDeleted: true });
  }

  if (relationship !== 'related') {
    throw new Error(`Unsupported relationship: ${String(relationship)}`);
  }

  sourceTask.related = (sourceTask.related || []).filter((entry) => entry !== targetId);
  writeTask(paths, sourceTask);
  try {
    const targetTask = readTask(paths, targetId, { includeDeleted: true });
    targetTask.related = (targetTask.related || []).filter((entry) => entry !== sourceId);
    writeTask(paths, targetTask);
  } catch {
    // Ignore missing reverse link target.
  }
  return readTask(paths, sourceId, { includeDeleted: true });
}

function buildTaskReference(task) {
  return `#${task.displayId || deriveDisplayId(task.id)} (taskId: ${task.id})`;
}

function getTaskFreshness(task) {
  const updated = Date.parse(String(task.updatedAt || ''));
  if (Number.isFinite(updated) && updated > 0) return updated;
  const created = Date.parse(String(task.createdAt || ''));
  if (Number.isFinite(created) && created > 0) return created;
  return 0;
}

function compareTasksByFreshness(a, b) {
  const freshnessDiff = getTaskFreshness(b) - getTaskFreshness(a);
  if (freshnessDiff !== 0) return freshnessDiff;
  const byDisplay = String(a.displayId || a.id).localeCompare(
    String(b.displayId || b.id),
    undefined,
    {
      numeric: true,
      sensitivity: 'base',
    }
  );
  if (byDisplay !== 0) return byDisplay;
  return String(a.id).localeCompare(String(b.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getEffectiveReviewState(kanbanEntry, task) {
  return reviewStateHelpers.getEffectiveReviewState(task, kanbanEntry).state;
}

function formatBriefTaskLine(task, reviewState) {
  const reviewSuffix = reviewState !== 'none' ? `, review=${reviewState}` : '';
  return `- #${task.displayId || deriveDisplayId(task.id)} [status=${task.status}${reviewSuffix}] ${task.subject}`;
}

function formatCommentLine(comment) {
  const author =
    typeof comment.author === 'string' && comment.author.trim() ? comment.author.trim() : 'unknown';
  const text = typeof comment.text === 'string' ? comment.text.trim() : '';
  return `  - ${author}: ${text || '(empty comment)'}`;
}

function formatTaskBriefing(paths, teamName, memberName) {
  const kanbanState = readJson(path.join(paths.teamDir, 'kanban-state.json'), {
    teamName,
    reviewers: [],
    tasks: {},
  });
  const activeTasks = listTasks(paths)
    .filter((task) => task.owner === memberName && task.status !== 'deleted')
    .sort(compareTasksByFreshness);

  if (activeTasks.length === 0) {
    return `No assigned tasks for ${memberName}.`;
  }

  const groups = {
    in_progress: activeTasks.filter((task) => task.status === 'in_progress'),
    needs_fix: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return (
        task.status !== 'in_progress' && getEffectiveReviewState(kanbanEntry, task) === 'needsFix'
      );
    }),
    pending: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return task.status === 'pending' && getEffectiveReviewState(kanbanEntry, task) === 'none';
    }),
    review: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return getEffectiveReviewState(kanbanEntry, task) === 'review';
    }),
    completed: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return task.status === 'completed' && getEffectiveReviewState(kanbanEntry, task) === 'none';
    }),
    approved: activeTasks.filter((task) => {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      return getEffectiveReviewState(kanbanEntry, task) === 'approved';
    }),
  };

  const lines = [`Task briefing for ${memberName}:`];

  if (groups.in_progress.length > 0) {
    lines.push('', 'In progress:');
    for (const task of groups.in_progress) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      const reviewState = getEffectiveReviewState(kanbanEntry, task);
      lines.push(formatBriefTaskLine(task, reviewState));
      if (task.description) {
        lines.push(`  Description: ${task.description}`);
      }
      if (Array.isArray(task.comments) && task.comments.length > 0) {
        lines.push('  Comments:');
        for (const comment of task.comments) {
          lines.push(formatCommentLine(comment));
        }
      }
    }
  }

  if (groups.needs_fix.length > 0) {
    lines.push('', 'Needs fixes after review:');
    for (const task of groups.needs_fix) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.pending.length > 0) {
    lines.push('', 'Pending:');
    for (const task of groups.pending) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.review.length > 0) {
    lines.push('', 'Review:');
    for (const task of groups.review) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.completed.length > 0) {
    lines.push('', 'Completed:');
    for (const task of groups.completed) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  if (groups.approved.length > 0) {
    lines.push('', 'Approved (last 10):');
    for (const task of groups.approved.slice(0, 10)) {
      const kanbanEntry = kanbanState.tasks ? kanbanState.tasks[task.id] : undefined;
      lines.push(formatBriefTaskLine(task, getEffectiveReviewState(kanbanEntry, task)));
    }
  }

  return lines.join('\n');
}

module.exports = {
  addCommentAttachmentMeta,
  addTaskAttachmentMeta,
  addTaskComment,
  appendHistoryEvent,
  buildTaskReference,
  configureTaskScanSnapshotCache,
  createTask,
  deriveDisplayId,
  formatTaskBriefing,
  linkTask,
  listTaskRows,
  listTasks,
  readTask,
  reconcileTaskCreation,
  removeTaskAttachment,
  resolveTaskRef,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  unlinkTask,
  updateTask,
  updateTaskFields,
};
