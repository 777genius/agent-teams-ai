const fs = require('fs');
const taskStore = require('./taskStore.js');
const { writeJsonFileSync } = require('./atomicFile.js');

function nowIso() {
  return new Date().toISOString();
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

function getDefaultState(teamName) {
  return {
    teamName,
    reviewers: [],
    tasks: {},
  };
}

function sanitizeState(teamName, rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : {};
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
  clearKanban,
  garbageCollect,
  readKanbanState,
  setKanbanColumn,
  updateColumnOrder,
  writeKanbanState,
};
