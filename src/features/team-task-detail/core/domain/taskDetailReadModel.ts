import type { TaskDetailIdentity, TaskDetailReadPhase } from '../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

export interface TaskDetailReadEntry {
  identity: TaskDetailIdentity;
  phase: TaskDetailReadPhase;
  full: TeamTaskWithKanban | null;
  error: string | null;
  loading: boolean;
  refreshPending: boolean;
  sourceEpoch: number;
  latestStartedFullSerial: number;
}

export interface TaskReadCommitToken {
  identity: TaskDetailIdentity;
  sourceEpoch: number;
  serial: number;
}

export function createTaskDetailReadEntry(identity: TaskDetailIdentity): TaskDetailReadEntry {
  return {
    identity,
    phase: 'hydrating',
    full: null,
    error: null,
    loading: true,
    refreshPending: false,
    sourceEpoch: 1,
    latestStartedFullSerial: 0,
  };
}

export function beginTaskDetailFullRead(entry: TaskDetailReadEntry): TaskReadCommitToken {
  const serial = entry.latestStartedFullSerial + 1;
  return {
    identity: entry.identity,
    sourceEpoch: entry.sourceEpoch,
    serial,
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
    latestStartedFullSerial: Math.max(entry.latestStartedFullSerial, token.serial),
  };
}

export function canCommitTaskDetailFullRead(
  entry: TaskDetailReadEntry,
  token: TaskReadCommitToken
): boolean {
  return (
    entry.identity.contextId === token.identity.contextId &&
    entry.identity.teamName === token.identity.teamName &&
    entry.identity.taskId === token.identity.taskId &&
    entry.sourceEpoch === token.sourceEpoch &&
    entry.latestStartedFullSerial === token.serial
  );
}

export function invalidateTaskDetailFull(entry: TaskDetailReadEntry): TaskDetailReadEntry {
  return {
    ...entry,
    sourceEpoch: entry.sourceEpoch + 1,
    refreshPending: true,
    loading: false,
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
    error: classified.error,
    loading: false,
    refreshPending: false,
  };
}

export function shouldReadFullFromCompactChange(
  previous: TeamTaskWithKanban | undefined,
  next: TeamTaskWithKanban | undefined
): boolean {
  return previous !== next;
}
