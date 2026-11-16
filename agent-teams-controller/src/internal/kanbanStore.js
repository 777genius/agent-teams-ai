const fs = require('fs');
const taskStore = require('./taskStore.js');
const { writeJsonFileSync } = require('./atomicFile.js');

function nowIso() {
  return new Date().toISOString();
}

function readJson(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallbackValue;
    throw error; // An unreadable policy must never silently turn approval restrictions off.
  }
}

function writeJson(filePath, value) {
  writeJsonFileSync(filePath, value);
}

const REVIEW_FLOW_AGENT_APPROVAL = 'agent_approval';
const REVIEW_FLOW_HUMAN_APPROVAL = 'human_approval';
const REVIEW_FLOWS = Object.freeze([REVIEW_FLOW_AGENT_APPROVAL, REVIEW_FLOW_HUMAN_APPROVAL]);
const DEFAULT_REVIEW_FLOW = REVIEW_FLOW_AGENT_APPROVAL;
const MAX_REVIEW_FLOW_PROMPT_LENGTH = 1000;

function isReviewFlow(value) {
  return REVIEW_FLOWS.includes(value);
}

function isHumanApprovalFlow(state) {
  return Boolean(state) && state.reviewFlow === REVIEW_FLOW_HUMAN_APPROVAL;
}

/** Trims user-written flow instructions; empty text clears them. */
function normalizeReviewFlowPrompt(value) {
  if (typeof value !== 'string') throw new Error('reviewFlowPrompt must be a string');
  const prompt = value.trim();
  if (prompt.length > MAX_REVIEW_FLOW_PROMPT_LENGTH) {
    throw new Error(`reviewFlowPrompt must be at most ${MAX_REVIEW_FLOW_PROMPT_LENGTH} characters`);
  }
  return prompt;
}

function getDefaultState(teamName) {
  return {
    teamName,
    reviewers: [],
    tasks: {},
    reviewFlow: DEFAULT_REVIEW_FLOW,
  };
}

function sanitizeState(teamName, rawState) {
  if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState) ||
      (rawState.reviewFlow !== undefined && !isReviewFlow(rawState.reviewFlow))) {
    throw new Error('Kanban review flow is corrupt');
  }
  let reviewFlowPrompt = '';
  if (rawState.reviewFlowPrompt !== undefined) {
    try {
      reviewFlowPrompt = normalizeReviewFlowPrompt(rawState.reviewFlowPrompt);
    } catch {
      throw new Error('Kanban review flow is corrupt');
    }
  }
  const state = rawState;
  const tasks = {};
  if (state.tasks && typeof state.tasks === 'object') {
    for (const [taskId, entry] of Object.entries(state.tasks)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.column !== 'review' && entry.column !== 'approved') continue;
      if (typeof entry.movedAt !== 'string') continue;
      tasks[String(taskId)] = {
        column: entry.column,
        movedAt: entry.movedAt,
        ...(entry.reviewer === null || typeof entry.reviewer === 'string'
          ? { reviewer: entry.reviewer }
          : {}),
        ...(typeof entry.errorDescription === 'string'
          ? { errorDescription: entry.errorDescription }
          : {}),
      };
    }
  }

  return {
    teamName,
    reviewers: Array.isArray(state.reviewers)
      ? state.reviewers.filter((entry) => typeof entry === 'string' && entry.trim())
      : [],
    tasks,
    reviewFlow: isReviewFlow(state.reviewFlow) ? state.reviewFlow : DEFAULT_REVIEW_FLOW,
    ...(reviewFlowPrompt ? { reviewFlowPrompt } : {}),
    ...(state.columnOrder && typeof state.columnOrder === 'object'
      ? { columnOrder: state.columnOrder }
      : {}),
  };
}

function readKanbanState(paths, teamName) {
  return sanitizeState(teamName, readJson(paths.kanbanPath, getDefaultState(teamName)));
}

function writeKanbanState(paths, teamName, state) {
  writeJson(paths.kanbanPath, sanitizeState(teamName, state));
}

function removeTaskFromColumnOrder(state, taskId) {
  if (!state.columnOrder || typeof state.columnOrder !== 'object') {
    return 0;
  }

  const cleaned = {};
  let removed = 0;
  for (const [columnId, orderedTaskIds] of Object.entries(state.columnOrder)) {
    if (!Array.isArray(orderedTaskIds)) continue;
    const nextIds = orderedTaskIds.filter((entry) => String(entry) !== String(taskId));
    removed += orderedTaskIds.length - nextIds.length;
    if (nextIds.length > 0) {
      cleaned[columnId] = nextIds.map((entry) => String(entry));
    }
  }

  state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  return removed;
}

function appendTaskToColumnOrder(state, column, taskId) {
  if (!state.columnOrder || typeof state.columnOrder !== 'object') {
    return;
  }

  const nextColumnOrder = { ...state.columnOrder };
  const existing = Array.isArray(nextColumnOrder[column]) ? nextColumnOrder[column] : [];
  nextColumnOrder[column] = existing
    .map((entry) => String(entry))
    .filter((entry) => entry !== String(taskId))
    .concat([String(taskId)]);
  state.columnOrder = nextColumnOrder;
}

function setKanbanColumn(paths, teamName, taskId, column) {
  if (column !== 'review' && column !== 'approved') {
    throw new Error(`Invalid kanban column: ${String(column)}`);
  }

  const state = readKanbanState(paths, teamName);
  const hadColumnOrder = Boolean(state.columnOrder && Object.keys(state.columnOrder).length > 0);
  removeTaskFromColumnOrder(state, taskId);
  if (hadColumnOrder && !state.columnOrder) {
    state.columnOrder = {};
  }
  state.tasks[String(taskId)] =
    column === 'review'
      ? { column: 'review', reviewer: null, movedAt: nowIso() }
      : { column: 'approved', movedAt: nowIso() };
  appendTaskToColumnOrder(state, column, taskId);
  writeKanbanState(paths, teamName, state);
  taskStore.updateTask(paths, String(taskId), (task) => ({
    ...task,
    reviewState: column,
  }));
  return state;
}

function clearKanban(paths, teamName, taskId, options = {}) {
  const state = readKanbanState(paths, teamName);
  delete state.tasks[String(taskId)];
  removeTaskFromColumnOrder(state, taskId);
  writeKanbanState(paths, teamName, state);
  const nextReviewState =
    typeof options.nextReviewState === 'string' ? options.nextReviewState : 'none';
  taskStore.updateTask(paths, String(taskId), (task) => ({
    ...task,
    reviewState: nextReviewState,
  }));
  return state;
}

function updateColumnOrder(paths, teamName, columnId, orderedTaskIds) {
  const state = readKanbanState(paths, teamName);
  const nextColumnOrder = { ...(state.columnOrder || {}) };
  if (Array.isArray(orderedTaskIds) && orderedTaskIds.length > 0) {
    nextColumnOrder[columnId] = orderedTaskIds.map((entry) => String(entry));
  } else {
    delete nextColumnOrder[columnId];
  }
  state.columnOrder = Object.keys(nextColumnOrder).length > 0 ? nextColumnOrder : undefined;
  writeKanbanState(paths, teamName, state);
  return state;
}

function garbageCollect(paths, teamName, validTaskIds) {
  const state = readKanbanState(paths, teamName);
  let staleKanbanEntriesRemoved = 0;
  let staleColumnOrderRefsRemoved = 0;

  for (const taskId of Object.keys(state.tasks)) {
    if (!validTaskIds.has(taskId)) {
      delete state.tasks[taskId];
      staleKanbanEntriesRemoved += 1;
    }
  }

  if (state.columnOrder && typeof state.columnOrder === 'object') {
    const cleaned = {};
    for (const [columnId, orderedTaskIds] of Object.entries(state.columnOrder)) {
      if (!Array.isArray(orderedTaskIds)) {
        continue;
      }

      const validIds = orderedTaskIds.filter((taskId) => {
        const id = String(taskId);
        return validTaskIds.has(id) && state.tasks[id] && state.tasks[id].column === columnId;
      });
      staleColumnOrderRefsRemoved += orderedTaskIds.length - validIds.length;
      if (validIds.length > 0) {
        cleaned[columnId] = validIds;
      }
    }

    state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
  }

  if (staleKanbanEntriesRemoved > 0 || staleColumnOrderRefsRemoved > 0) {
    writeKanbanState(paths, teamName, state);
  }

  return {
    state,
    staleKanbanEntriesRemoved,
    staleColumnOrderRefsRemoved,
  };
}

module.exports = {
  DEFAULT_REVIEW_FLOW,
  MAX_REVIEW_FLOW_PROMPT_LENGTH,
  REVIEW_FLOWS,
  REVIEW_FLOW_AGENT_APPROVAL,
  REVIEW_FLOW_HUMAN_APPROVAL,
  clearKanban,
  garbageCollect,
  isHumanApprovalFlow,
  isReviewFlow,
  normalizeReviewFlowPrompt,
  readKanbanState,
  setKanbanColumn,
  updateColumnOrder,
  writeKanbanState,
};
