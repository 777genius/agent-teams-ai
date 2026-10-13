import {
  isTaskDetailReadTokenForResource,
  taskDetailFullResourceKey,
  type TaskDetailReadToken,
} from './taskDetailReadProvenance';

import type { TaskDetailIdentity, TaskDetailReadPhase } from '../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

export interface TaskDetailReadEntry {
  identity: TaskDetailIdentity;
  phase: TaskDetailReadPhase;
  full: TeamTaskWithKanban | null;
  compact: TeamTaskWithKanban | null;
  error: string | null;
  loading: boolean;
  refreshPending: boolean;
  fullToken: TaskDetailReadToken | null;
  compactToken: TaskDetailReadToken | null;
}

export type TaskReadCommitToken = TaskDetailReadToken;

export function createTaskDetailReadEntry(identity: TaskDetailIdentity): TaskDetailReadEntry {
  return {
    identity,
    phase: 'hydrating',
    full: null,
    compact: null,
    error: null,
    loading: true,
    refreshPending: false,
    fullToken: null,
    compactToken: null,
  };
}

export function applyTaskDetailReadStart(
  entry: TaskDetailReadEntry,
  token: TaskReadCommitToken
): TaskDetailReadEntry {
  return {
    ...entry,
    loading: true,
    refreshPending: false,
    fullToken: token,
  };
}

export function canCommitTaskDetailFullRead(
  entry: TaskDetailReadEntry,
  token: TaskReadCommitToken
): boolean {
  return (
    token.resource === 'full' &&
    token.key === taskDetailFullResourceKey(entry.identity) &&
    (entry.fullToken === null ||
      (entry.fullToken.key === token.key &&
        entry.fullToken.sourceEpoch === token.sourceEpoch &&
        entry.fullToken.serial === token.serial)) &&
    entry.identity.contextId === token.scope.contextId &&
    entry.identity.teamName === token.scope.teamName &&
    isTaskDetailReadTokenForResource(token, entry.identity)
  );
}

export function invalidateTaskDetailFull(entry: TaskDetailReadEntry): TaskDetailReadEntry {
  return {
    ...entry,
    refreshPending: true,
    loading: entry.loading,
  };
}

function classifyMissingMessage(message: string, taskId: string): boolean {
  const normalized = message.trim();
  return (
    normalized === 'TASK_NOT_FOUND' ||
    normalized === `Task not found: ${taskId}` ||
    normalized.startsWith(`Task not found: ${taskId}`) ||
    normalized.includes(`Task not found: ${taskId}`)
  );
}

export function classifyTaskDetailResult(
  taskId: string,
  result: TeamTaskWithKanban | null,
  error?: unknown
): { phase: TaskDetailReadPhase; error: string | null } {
  if (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'TEAM_PROVISIONING' || message.includes('TEAM_PROVISIONING')) {
      return { phase: 'provisioning', error: null };
    }
    if (message === 'TEAM_DRAFT' || message.includes('TEAM_DRAFT')) {
      return { phase: 'unavailable', error: message };
    }
    if (classifyMissingMessage(message, taskId)) {
      return { phase: 'missing', error: null };
    }
    return { phase: 'unavailable', error: message };
  }
  if (result === null) return { phase: 'missing', error: null };
  if (result.status === 'deleted') return { phase: 'deleted', error: null };
  return { phase: 'ready', error: null };
}

export function commitTaskDetailFull(
  entry: TaskDetailReadEntry,
  token: TaskReadCommitToken,
  result: TeamTaskWithKanban | null,
  error?: unknown
): TaskDetailReadEntry {
  if (!canCommitTaskDetailFullRead(entry, token)) return entry;
  const classified = classifyTaskDetailResult(entry.identity.taskId, result, error);
  const keepFull =
    classified.phase === 'provisioning' || (classified.phase === 'unavailable' && entry.full);
  return {
    ...entry,
    phase: classified.phase,
    full: keepFull ? entry.full : result,
    fullToken: token,
    compact: entry.compact,
    error: classified.error,
    loading: false,
    refreshPending: false,
  };
}

/** Compact snapshots are previews and limited derived state, never full-task authority. */
export function applyTaskDetailCompact(
  entry: TaskDetailReadEntry,
  compact: TeamTaskWithKanban | undefined,
  token: TaskDetailReadToken
): TaskDetailReadEntry {
  if (!compact) return entry;
  if (token.resource !== 'snapshot') return entry;
  if (entry.compactToken && token.physicalStartOrder < entry.compactToken.physicalStartOrder) {
    return entry;
  }
  if (
    entry.fullToken &&
    token.physicalStartOrder > 0 &&
    entry.fullToken.physicalStartOrder > 0 &&
    token.physicalStartOrder < entry.fullToken.physicalStartOrder
  ) {
    return entry;
  }
  const nextCompact = compact;
  if (!entry.full) {
    return entry.compact === nextCompact && entry.compactToken?.serial === token.serial
      ? entry
      : { ...entry, compact: nextCompact, compactToken: token };
  }
  const full = entry.full;
  const derived: TeamTaskWithKanban = { ...full };
  let changed = false;
  if (derived.kanbanColumn !== compact.kanbanColumn) {
    derived.kanbanColumn = compact.kanbanColumn;
    changed = true;
  }
  if (derived.reviewer !== compact.reviewer) {
    derived.reviewer = compact.reviewer;
    changed = true;
  }
  if (derived.changePresence !== compact.changePresence) {
    derived.changePresence = compact.changePresence;
    changed = true;
  }
  return {
    ...entry,
    compact: nextCompact,
    compactToken: token,
    full: changed ? derived : full,
  };
}

export function shouldReadFullFromCompactChange(
  previous: TeamTaskWithKanban | undefined,
  next: TeamTaskWithKanban | undefined
): boolean {
  return previous !== next;
}
