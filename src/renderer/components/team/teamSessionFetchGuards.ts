import type { Session } from '@renderer/types/data';

export function isLeadSessionMissing(params: {
  leadSessionId: string | null;
  projectId: string | null;
  sessionsLoading: boolean;
  knownSessions: readonly Pick<Session, 'id'>[];
}): boolean {
  const { leadSessionId, projectId, sessionsLoading, knownSessions } = params;
  if (!leadSessionId || !projectId || sessionsLoading || knownSessions.length === 0) {
    return false;
  }
  return !knownSessions.some((session) => session.id === leadSessionId);
}

export function shouldSuppressMissingLeadSessionFetch(params: {
  leadSessionId: string | null;
  projectId: string | null;
  sessionsLoading: boolean;
  knownSessions: readonly Pick<Session, 'id'>[];
  suppressionKey: string | null;
  currentKey: string;
}): boolean {
  const { suppressionKey, currentKey } = params;
  return suppressionKey === currentKey && isLeadSessionMissing(params);
}
