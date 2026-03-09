const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TASK_STATUSES = new Set(['pending', 'in_progress', 'completed', 'deleted']);
const REVIEW_STATES = new Set(['none', 'review', 'approved']);
const UUID_TASK_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2));
  fs.renameSync(tempPath, filePath);
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

function normalizeTask(rawTask, filePath) {
  if (!rawTask || typeof rawTask !== 'object') {
    throw new Error(`Invalid task payload${filePath ? `: ${filePath}` : ''}`);
  }

  const id =
    typeof rawTask.id === 'string' || typeof rawTask.id === 'number' ? String(rawTask.id) : '';
  if (!id) {
    throw new Error(`Task is missing id${filePath ? `: ${filePath}` : ''}`);
  }

  const task = {
    ...rawTask,
    id,
    displayId:
      typeof rawTask.displayId === 'string' && rawTask.displayId.trim()
        ? rawTask.displayId.trim()
        : deriveDisplayId(id),
    reviewState: normalizeTaskReviewState(rawTask.reviewState),
  };

  return task;
}

function normalizeTaskReviewState(value) {
  return REVIEW_STATES.has(String(value || '').trim()) ? String(value).trim() : 'none';
}

function listRawTasks(paths) {
  ensureDir(paths.tasksDir);
  const entries = fs.readdirSync(paths.tasksDir);
  const out = [];

  for (const fileName of entries) {
    if (!fileName.endsWith('.json') || fileName.startsWith('.')) continue;
    const filePath = path.join(paths.tasksDir, fileName);
    const rawTask = readJson(filePath, null);
    if (!rawTask) continue;
    if (rawTask.metadata && rawTask.metadata._internal === true) continue;
    try {
      out.push(normalizeTask(rawTask, filePath));
    } catch {
      // Skip unreadable task rows.
    }
  }

  out.sort((a, b) => {
    const byDisplay = String(a.displayId || a.id).localeCompare(String(b.displayId || b.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
    if (byDisplay !== 0) return byDisplay;
    return String(a.id).localeCompare(String(b.id), undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });

  return out;
}

function listTasks(paths, options = {}) {
  const includeDeleted = options.includeDeleted === true;
  return listRawTasks(paths).filter((task) => includeDeleted || task.status !== 'deleted');
}

function resolveTaskRef(paths, taskRef, options = {}) {
  const normalizedRef = String(taskRef || '').trim().replace(/^#/, '');
  if (!normalizedRef) {
    throw new Error('Missing taskId');
  }

  const includeDeleted = options.includeDeleted === true;
  const tasks = listRawTasks(paths);
  const exact = tasks.find((task) => task.id === normalizedRef);
  if (exact && (includeDeleted || exact.status !== 'deleted')) {
    return exact.id;
  }

  const byDisplay = tasks.find(
    (task) =>
      task.displayId === normalizedRef &&
      (includeDeleted || task.status !== 'deleted')
  );
  if (byDisplay) {
    return byDisplay.id;
  }

  throw new Error(`Task not found: ${normalizedRef}`);
}

function readTask(paths, taskRef, options = {}) {
  const taskId = resolveTaskRef(paths, taskRef, options);
  const taskPath = getTaskPath(paths, taskId);
  const rawTask = readJson(taskPath, null);
  if (!rawTask) {
    throw new Error(`Task not found: ${String(taskRef)}`);
  }
  return normalizeTask(rawTask, taskPath);
}

function createStatusTransition(history, from, to, actor, timestamp) {
  return [...(Array.isArray(history) ? history : []), { from, to, timestamp, ...(actor ? { actor } : {}) }];
}

function normalizeStatus(status) {
  const normalized = String(status || '').trim();
  return TASK_STATUSES.has(normalized) ? normalized : null;
}

function parseRelationshipList(paths, value) {
  const rawValues = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
      : [];

  return rawValues.map((entry) => resolveTaskRef(paths, entry));
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

  const existing = new Set(listRawTasks(paths).map((task) => task.displayId || deriveDisplayId(task.id)));
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
  writeJson(getTaskPath(paths, task.id), task);
}

function createTask(paths, input = {}) {
  ensureDir(paths.tasksDir);

  const canonicalId = pickTaskId(input);
  if (fs.existsSync(getTaskPath(paths, canonicalId))) {
    throw new Error(`Task already exists: ${canonicalId}`);
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
    typeof input.createdAt === 'string' && input.createdAt.trim() ? input.createdAt.trim() : nowIso();
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
    statusHistory: createStatusTransition(input.statusHistory, null, status, createdBy, createdAt),
    blocks: Array.isArray(input.blocks) ? [...input.blocks] : [],
    blockedBy: blockedByIds,
    related: relatedIds.length > 0 ? relatedIds : undefined,
    projectPath:
      typeof input.projectPath === 'string' && input.projectPath.trim()
        ? input.projectPath.trim()
        : undefined,
    comments: Array.isArray(input.comments) ? input.comments : undefined,
    needsClarification:
      input.needsClarification === 'lead' || input.needsClarification === 'user'
        ? input.needsClarification
        : undefined,
    reviewState: normalizeTaskReviewState(input.reviewState),
    deletedAt:
      status === 'deleted' && typeof input.deletedAt === 'string' ? input.deletedAt : undefined,
    attachments: Array.isArray(input.attachments) ? input.attachments : undefined,
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

function updateTask(paths, taskRef, updater, options = {}) {
  const existingTask = readTask(paths, taskRef, { includeDeleted: true });
  const nextTask = normalizeTask(updater({ ...existingTask }) || existingTask);
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
    if (task.status === status) return task;
    const timestamp = nowIso();
    const workIntervals = Array.isArray(task.workIntervals) ? [...task.workIntervals] : [];
    const lastInterval = workIntervals.length > 0 ? workIntervals[workIntervals.length - 1] : null;

    if (task.status !== 'in_progress' && status === 'in_progress') {
      if (!lastInterval || typeof lastInterval.completedAt === 'string') {
        workIntervals.push({ startedAt: timestamp });
      }
    } else if (task.status === 'in_progress' && status !== 'in_progress') {
      if (lastInterval && lastInterval.completedAt === undefined) {
        lastInterval.completedAt = timestamp;
      }
    }

    task.workIntervals = workIntervals.length > 0 ? workIntervals : undefined;
    task.statusHistory = createStatusTransition(task.statusHistory, task.status, status, actor, timestamp);
    task.status = status;

    if (status === 'deleted') {
      task.deletedAt = timestamp;
    } else if (task.deletedAt) {
      delete task.deletedAt;
    }

    return task;
  });
}

function setTaskOwner(paths, taskRef, owner) {
  return updateTask(paths, taskRef, (task) => {
    if (owner == null || owner === 'clear' || owner === 'none') {
      delete task.owner;
    } else {
      task.owner = String(owner).trim();
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

function addTaskComment(paths, taskRef, text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('Missing comment text');
  }

  const comment = {
    id: options.id || crypto.randomUUID(),
    author:
      typeof options.author === 'string' && options.author.trim()
        ? options.author.trim()
        : 'user',
    text,
    createdAt:
      typeof options.createdAt === 'string' && options.createdAt.trim()
        ? options.createdAt.trim()
        : nowIso(),
    type: options.type || 'regular',
    ...(Array.isArray(options.attachments) && options.attachments.length > 0
      ? { attachments: options.attachments }
      : {}),
  };

  const task = updateTask(paths, taskRef, (currentTask) => {
    const comments = Array.isArray(currentTask.comments) ? currentTask.comments : [];
    if (comments.some((entry) => entry.id === comment.id)) {
      return currentTask;
    }

    if (currentTask.needsClarification === 'lead' && comment.author !== currentTask.owner) {
      delete currentTask.needsClarification;
    }

    currentTask.comments = comments.concat([comment]);
    return currentTask;
  });

  return { comment, task };
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

function compareTasksForBriefing(a, b) {
  const order = {
    in_progress: 0,
    pending: 1,
    completed: 2,
    deleted: 3,
  };
  const byStatus = (order[a.status] ?? 99) - (order[b.status] ?? 99);
  if (byStatus !== 0) return byStatus;
  const byDisplay = String(a.displayId || a.id).localeCompare(String(b.displayId || b.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
  if (byDisplay !== 0) return byDisplay;
  return String(a.id).localeCompare(String(b.id), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getEffectiveReviewState(kanbanEntry, task) {
  if (normalizeTaskReviewState(task.reviewState) !== 'none') {
    return normalizeTaskReviewState(task.reviewState);
  }
  return kanbanEntry && kanbanEntry.column ? String(kanbanEntry.column) : 'none';
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
    .sort(compareTasksForBriefing);

  if (activeTasks.length === 0) {
    return `No assigned tasks for ${memberName}.`;
  }

  const groups = {
    in_progress: activeTasks.filter((task) => task.status === 'in_progress'),
    pending: activeTasks.filter((task) => task.status === 'pending'),
    completed: activeTasks.filter((task) => task.status === 'completed'),
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

  if (groups.pending.length > 0) {
    lines.push('', 'Pending:');
    for (const task of groups.pending) {
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

  return lines.join('\n');
}

module.exports = {
  addCommentAttachmentMeta,
  addTaskAttachmentMeta,
  addTaskComment,
  buildTaskReference,
  createTask,
  deriveDisplayId,
  formatTaskBriefing,
  linkTask,
  listTasks,
  readTask,
  removeTaskAttachment,
  resolveTaskRef,
  setNeedsClarification,
  setTaskOwner,
  setTaskStatus,
  unlinkTask,
  updateTask,
  updateTaskFields,
};
