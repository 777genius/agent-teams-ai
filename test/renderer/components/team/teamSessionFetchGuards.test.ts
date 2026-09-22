import { describe, expect, it, vi } from 'vitest';

import {
  buildTeamSessionIds,
  loadTeamSessionMetadata,
  shouldSuppressMissingLeadSessionFetch,
} from '@renderer/components/team/teamSessionFetchGuards';

import type { Session } from '@renderer/types/data';

function createSession(id: string, createdAt: number): Session {
  return {
    id,
    projectId: 'project-1',
    projectPath: '/tmp/project',
    createdAt,
    hasSubagents: false,
    messageCount: 0,
  };
}

describe('teamSessionFetchGuards', () => {
  it('builds bounded team session ids with lead first and newest history first', () => {
    expect(
      buildTeamSessionIds({
        leadSessionId: ' lead-session ',
        sessionHistory: ['old-session', 'lead-session', '', 42, 'new-session'],
      })
    ).toEqual(['lead-session', 'new-session', 'old-session']);
  });

  it('limits team session ids to avoid loading deep project history', () => {
    const sessionHistory = Array.from({ length: 25 }, (_, index) => `session-${index}`);
    const ids = buildTeamSessionIds({ leadSessionId: 'lead-session', sessionHistory }, 20);

    expect(ids).toHaveLength(20);
    expect(ids[0]).toBe('lead-session');
    expect(ids[1]).toBe('session-24');
    expect(ids).not.toContain('session-5');
  });

  it('loads targeted team session metadata without calling legacy getSessions', async () => {
    const api = {
      getSessions: vi.fn(),
      getSessionsByIds: vi.fn().mockResolvedValue([
        createSession('older-session', 100),
        createSession('lead-session', 1),
        createSession('newer-session', 200),
      ]),
      getSessionsPaginated: vi.fn(),
    };

    const sessions = await loadTeamSessionMetadata(api, 'project-1', {
      leadSessionId: 'lead-session',
      sessionHistory: ['older-session', 'newer-session'],
    });

    expect(api.getSessionsByIds).toHaveBeenCalledWith(
      'project-1',
      ['lead-session', 'newer-session', 'older-session'],
      { metadataLevel: 'light' }
    );
    expect(api.getSessionsPaginated).not.toHaveBeenCalled();
    expect(api.getSessions).not.toHaveBeenCalled();
    expect(sessions.map((session) => session.id)).toEqual([
      'lead-session',
      'newer-session',
      'older-session',
    ]);
  });

  it('falls back to light paginated sessions for legacy teams without known session ids', async () => {
    const api = {
      getSessions: vi.fn(),
      getSessionsByIds: vi.fn(),
      getSessionsPaginated: vi.fn().mockResolvedValue({
        sessions: [createSession('old-session', 10), createSession('new-session', 20)],
        nextCursor: null,
        hasMore: false,
        totalCount: 2,
      }),
    };

    const sessions = await loadTeamSessionMetadata(api, 'project-1', {
      leadSessionId: null,
      sessionHistory: [],
    });

    expect(api.getSessionsPaginated).toHaveBeenCalledWith('project-1', null, 20, {
      includeTotalCount: false,
      prefilterAll: false,
      metadataLevel: 'light',
    });
    expect(api.getSessionsByIds).not.toHaveBeenCalled();
    expect(api.getSessions).not.toHaveBeenCalled();
    expect(sessions.map((session) => session.id)).toEqual(['new-session', 'old-session']);
  });

  it('suppresses repeated silent fetches for the same missing lead session id', () => {
    expect(
      shouldSuppressMissingLeadSessionFetch({
        leadSessionId: 'missing-session',
        projectId: 'project-1',
        sessionsLoading: false,
        knownSessions: [{ id: 'other-session' }],
        suppressionKey: 'team:project-1:missing-session:history-a',
        currentKey: 'team:project-1:missing-session:history-a',
      })
    ).toBe(true);
  });

  it('allows a fresh fetch when the lead session id changes', () => {
    expect(
      shouldSuppressMissingLeadSessionFetch({
        leadSessionId: 'new-session',
        projectId: 'project-1',
        sessionsLoading: false,
        knownSessions: [{ id: 'other-session' }],
        suppressionKey: 'team:project-1:missing-session:history-a',
        currentKey: 'team:project-1:new-session:history-a',
      })
    ).toBe(false);
  });

  it('does not suppress while session inventory is still loading', () => {
    expect(
      shouldSuppressMissingLeadSessionFetch({
        leadSessionId: 'missing-session',
        projectId: 'project-1',
        sessionsLoading: true,
        knownSessions: [{ id: 'other-session' }],
        suppressionKey: 'team:project-1:missing-session:history-a',
        currentKey: 'team:project-1:missing-session:history-a',
      })
    ).toBe(false);
  });
});
