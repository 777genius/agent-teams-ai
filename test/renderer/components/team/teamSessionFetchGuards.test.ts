import { describe, expect, it } from 'vitest';

import { shouldSuppressMissingLeadSessionFetch } from '@renderer/components/team/teamSessionFetchGuards';

describe('teamSessionFetchGuards', () => {
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
