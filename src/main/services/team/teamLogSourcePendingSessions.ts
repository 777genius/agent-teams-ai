import {
  MAX_PENDING_UNKNOWN_ROOT_REFRESH_ATTEMPTS,
  MAX_PENDING_UNKNOWN_ROOT_SESSIONS,
  normalizeLogSourceSessionId,
  PENDING_UNKNOWN_ROOT_SESSION_TTL_MS,
} from './teamLogSourceWatchScope';

export interface PendingUnknownSessionCandidate {
  sessionId: string;
  expiresAt: number;
  refreshAttempts: number;
}

interface PendingUnknownSessionState {
  readonly scopedSessionIds: ReadonlySet<string>;
  readonly pendingUnknownSessionIds: Map<string, PendingUnknownSessionCandidate>;
}

export function getPendingUnknownSessionIds(state: PendingUnknownSessionState): string[] {
  prunePendingUnknownSessions(state);
  return [...state.pendingUnknownSessionIds.keys()];
}

export function rememberPendingUnknownSession(
  state: PendingUnknownSessionState,
  rawSessionId: string | undefined
): void {
  const sessionId = normalizeLogSourceSessionId(rawSessionId);
  if (!sessionId || state.scopedSessionIds.has(sessionId)) {
    return;
  }

  const now = Date.now();
  state.pendingUnknownSessionIds.set(sessionId, {
    sessionId,
    expiresAt: now + PENDING_UNKNOWN_ROOT_SESSION_TTL_MS,
    refreshAttempts: state.pendingUnknownSessionIds.get(sessionId)?.refreshAttempts ?? 0,
  });

  while (state.pendingUnknownSessionIds.size > MAX_PENDING_UNKNOWN_ROOT_SESSIONS) {
    const oldest = [...state.pendingUnknownSessionIds.values()].sort(
      (left, right) => left.expiresAt - right.expiresAt
    )[0];
    if (!oldest) break;
    state.pendingUnknownSessionIds.delete(oldest.sessionId);
  }
}

function prunePendingUnknownSessions(state: PendingUnknownSessionState): void {
  const now = Date.now();
  for (const [sessionId, candidate] of state.pendingUnknownSessionIds.entries()) {
    if (
      candidate.expiresAt <= now ||
      candidate.refreshAttempts >= MAX_PENDING_UNKNOWN_ROOT_REFRESH_ATTEMPTS
    ) {
      state.pendingUnknownSessionIds.delete(sessionId);
    }
  }
}

export function markPendingRefreshAttempt(state: PendingUnknownSessionState): void {
  for (const candidate of state.pendingUnknownSessionIds.values()) {
    candidate.refreshAttempts += 1;
  }
  prunePendingUnknownSessions(state);
}

export function removeConfirmedPendingSessions(
  state: PendingUnknownSessionState,
  confirmedSessionIds: readonly string[]
): void {
  for (const rawSessionId of confirmedSessionIds) {
    const sessionId = normalizeLogSourceSessionId(rawSessionId);
    if (sessionId) {
      state.pendingUnknownSessionIds.delete(sessionId);
    }
  }
}
