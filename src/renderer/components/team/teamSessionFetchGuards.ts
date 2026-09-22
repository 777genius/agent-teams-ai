import type { Session } from '@renderer/types/data';

export interface TeamSessionConfigLike {
  leadSessionId?: string | null;
  sessionHistory?: readonly unknown[] | null;
}

export interface TeamSessionMetadataApi {
  getSessionsByIds: (
    projectId: string,
    sessionIds: string[],
    options?: { metadataLevel?: 'light' | 'deep' }
  ) => Promise<Session[]>;
  getSessionsPaginated: (
    projectId: string,
    cursor: string | null,
    limit?: number,
    options?: {
      includeTotalCount?: boolean;
      prefilterAll?: boolean;
      metadataLevel?: 'light' | 'deep';
    }
  ) => Promise<{
    sessions: Session[];
    nextCursor: string | null;
    hasMore: boolean;
    totalCount: number;
  }>;
}

const DEFAULT_TEAM_SESSION_METADATA_LIMIT = 20;

export function buildTeamSessionIds(
  config: TeamSessionConfigLike,
  limit: number = DEFAULT_TEAM_SESSION_METADATA_LIMIT
): string[] {
  const max = Math.max(0, Math.floor(limit));
  if (max === 0) return [];

  const sessionIds: string[] = [];
  const seen = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value !== 'string') return;
    const sessionId = value.trim();
    if (!sessionId || seen.has(sessionId) || sessionIds.length >= max) return;
    seen.add(sessionId);
    sessionIds.push(sessionId);
  };

  push(config.leadSessionId);
  if (Array.isArray(config.sessionHistory)) {
    for (let index = config.sessionHistory.length - 1; index >= 0; index -= 1) {
      push(config.sessionHistory[index]);
      if (sessionIds.length >= max) break;
    }
  }

  return sessionIds;
}

export async function loadTeamSessionMetadata(
  api: TeamSessionMetadataApi,
  projectId: string,
  config: TeamSessionConfigLike,
  limit: number = DEFAULT_TEAM_SESSION_METADATA_LIMIT
): Promise<Session[]> {
  const sessionIds = buildTeamSessionIds(config, limit);
  const leadSessionId = typeof config.leadSessionId === 'string' ? config.leadSessionId.trim() : '';

  if (sessionIds.length === 0) {
    const page = await api.getSessionsPaginated(projectId, null, limit, {
      includeTotalCount: false,
      prefilterAll: false,
      metadataLevel: 'light',
    });
    return [...page.sessions].sort((a, b) => b.createdAt - a.createdAt);
  }

  const requestedOrder = new Map(sessionIds.map((sessionId, index) => [sessionId, index]));
  const sessions = await api.getSessionsByIds(projectId, sessionIds, { metadataLevel: 'light' });

  return [...sessions].sort((a, b) => {
    if (leadSessionId) {
      if (a.id === leadSessionId && b.id !== leadSessionId) return -1;
      if (b.id === leadSessionId && a.id !== leadSessionId) return 1;
    }
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return (
      (requestedOrder.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
      (requestedOrder.get(b.id) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

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
