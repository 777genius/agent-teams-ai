import * as path from 'path';

import type { PersistedTeamLaunchMemberState, PersistedTeamLaunchSnapshot } from '@shared/types';

export const BOARD_TASK_LOG_FRESHNESS_DIRNAME = '.board-task-log-freshness';
export const TEAM_TASK_LOG_FRESHNESS_DIRNAME = 'task-log-freshness';
export const BOARD_TASK_CHANGE_FRESHNESS_DIRNAME = '.board-task-change-freshness';
export const BOARD_TASK_CHANGES_DIRNAME = '.board-task-changes';
export const BOARD_TASK_LOG_FRESHNESS_FILE_SUFFIX = '.json';
export const MAX_LOG_SOURCE_WATCH_SESSION_IDS = 24;
export const MAX_PENDING_UNKNOWN_ROOT_SESSIONS = 16;
export const PENDING_UNKNOWN_ROOT_SESSION_TTL_MS = 15_000;
export const MAX_PENDING_UNKNOWN_ROOT_REFRESH_ATTEMPTS = 4;

const SAFE_SESSION_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;
const AGENT_TRANSCRIPT_RE = /^agent-(?!acompact).*\.jsonl$/;

export type WatcherEventName = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export type LogSourceWatcherAction =
  | { kind: 'ignore' }
  | { kind: 'task-freshness' }
  | { kind: 'scoped-recompute' }
  | { kind: 'context-refresh'; candidateSessionId?: string };

export interface TeamLogWatchSessionInput {
  configLeadSessionId?: unknown;
  launchLeadSessionId?: unknown;
  sessionHistory?: unknown[];
  launchRuntimeSessionIds?: unknown[];
  bootstrapRuntimeSessionIds?: unknown[];
}

export interface ClassifyLogSourceWatcherEventInput {
  projectDir: string;
  changedPath: string;
  eventName: WatcherEventName;
  scopedSessionIds: ReadonlySet<string>;
  pendingUnknownSessionIds: ReadonlySet<string>;
}

export function normalizeLogSourceSessionId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !SAFE_SESSION_ID_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

function pushSessionId(ids: string[], seen: Set<string>, value: unknown, limit: number): void {
  if (ids.length >= limit) {
    return;
  }
  const normalized = normalizeLogSourceSessionId(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  ids.push(normalized);
}

function shouldIncludeRuntimeMember(member: PersistedTeamLaunchMemberState): boolean {
  return Boolean(
    member.runtimeSessionId &&
    !member.hardFailure &&
    member.launchState !== 'skipped_for_launch' &&
    member.launchState !== 'failed_to_start'
  );
}

export function extractRuntimeSessionIds(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined
): string[] {
  if (!snapshot?.members) {
    return [];
  }

  const ids: string[] = [];
  const seen = new Set<string>();
  for (const member of Object.values(snapshot.members)) {
    if (!shouldIncludeRuntimeMember(member)) {
      continue;
    }
    pushSessionId(ids, seen, member.runtimeSessionId, MAX_LOG_SOURCE_WATCH_SESSION_IDS);
  }
  return ids;
}

export function buildTeamLogWatchSessionIds(
  input: TeamLogWatchSessionInput,
  limit = MAX_LOG_SOURCE_WATCH_SESSION_IDS
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  pushSessionId(ids, seen, input.configLeadSessionId, limit);
  pushSessionId(ids, seen, input.launchLeadSessionId, limit);

  for (const sessionId of input.launchRuntimeSessionIds ?? []) {
    pushSessionId(ids, seen, sessionId, limit);
  }
  for (const sessionId of input.bootstrapRuntimeSessionIds ?? []) {
    pushSessionId(ids, seen, sessionId, limit);
  }

  const history = Array.isArray(input.sessionHistory) ? input.sessionHistory : [];
  for (let index = history.length - 1; index >= 0; index -= 1) {
    pushSessionId(ids, seen, history[index], limit);
  }

  return ids;
}

export function isAgentTranscriptFileName(fileName: string): boolean {
  return AGENT_TRANSCRIPT_RE.test(fileName);
}

export function getRelativeLogSourceParts(projectDir: string, targetPath: string): string[] | null {
  const relativePath = path.relative(projectDir, targetPath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return relativePath.split(/[/\\]+/).filter(Boolean);
}

export function classifyLogSourceWatcherEvent(
  input: ClassifyLogSourceWatcherEventInput
): LogSourceWatcherAction {
  const parts = getRelativeLogSourceParts(input.projectDir, input.changedPath);
  if (!parts) {
    return { kind: 'ignore' };
  }

  const first = parts[0];
  if (first === BOARD_TASK_LOG_FRESHNESS_DIRNAME || first === BOARD_TASK_CHANGE_FRESHNESS_DIRNAME) {
    return { kind: 'task-freshness' };
  }

  if (
    first === BOARD_TASK_CHANGES_DIRNAME ||
    parts.includes('tool-results') ||
    parts.includes('memory')
  ) {
    return { kind: 'ignore' };
  }

  if (parts.length === 1 && first.endsWith('.jsonl')) {
    const sessionId = normalizeLogSourceSessionId(first.slice(0, -'.jsonl'.length));
    if (!sessionId) {
      return { kind: 'ignore' };
    }
    if (input.scopedSessionIds.has(sessionId)) {
      return { kind: 'scoped-recompute' };
    }
    if (input.eventName === 'add' || input.pendingUnknownSessionIds.has(sessionId)) {
      return { kind: 'context-refresh', candidateSessionId: sessionId };
    }
    return { kind: 'ignore' };
  }

  if (input.scopedSessionIds.has(first)) {
    if (parts.length === 1) {
      return { kind: 'scoped-recompute' };
    }
    if (parts[1] === 'subagents') {
      if (parts.length === 2) {
        return { kind: 'context-refresh' };
      }
      if (parts.length === 3 && isAgentTranscriptFileName(parts[2])) {
        return { kind: 'scoped-recompute' };
      }
    }
  }

  return { kind: 'ignore' };
}
