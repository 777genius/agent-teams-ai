import {
  getStatusStalenessDiagnostics,
  statusNeedsBackgroundRefresh,
} from '@features/member-work-sync/main/composition/memberWorkSyncFeatureStatusRefresh';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

function makeStatus(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'caught_up',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      fingerprint: 'agenda:v1:test',
      items: [],
      diagnostics: [],
    },
    evaluatedAt: '2026-04-29T00:00:00.000Z',
    diagnostics: [],
    reportToken: 'token',
    reportTokenExpiresAt: '2026-04-29T00:15:00.000Z',
    ...overrides,
  };
}

describe('member work sync status refresh staleness', () => {
  it('treats a future evaluatedAt as stale after clock rollback', () => {
    const nowMs = Date.parse('2026-04-29T00:00:00.000Z');
    const status = makeStatus({
      evaluatedAt: '2026-04-29T00:10:00.000Z',
      reportTokenExpiresAt: '2026-04-29T00:25:00.000Z',
    });

    expect(statusNeedsBackgroundRefresh(status, nowMs)).toBe(true);
    expect(getStatusStalenessDiagnostics(status, nowMs)).toContain('status_evaluated_at_in_future');
  });
});
