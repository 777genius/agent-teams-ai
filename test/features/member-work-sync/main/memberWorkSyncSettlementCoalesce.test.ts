import { describe, expect, it } from 'vitest';

import { preferLaterMemberWorkSyncSettlement } from '@features/member-work-sync/main/infrastructure/memberWorkSyncSettlementCoalesce';

describe('preferLaterMemberWorkSyncSettlement', () => {
  it('keeps the later settlement when runtime instances differ', () => {
    const older = {
      sourceId: 'old',
      recordedAt: '2026-05-06T00:05:00.000Z',
      runtimeInstanceId: 'runtime-old',
      completedGeneration: 1,
      outcome: 'success' as const,
    };
    const newer = {
      sourceId: 'new',
      recordedAt: '2026-05-06T00:05:02.000Z',
      runtimeInstanceId: 'runtime-new',
      completedGeneration: 1,
      outcome: 'success' as const,
    };
    expect(preferLaterMemberWorkSyncSettlement(older, newer)).toEqual(newer);
    expect(preferLaterMemberWorkSyncSettlement(newer, older)).toEqual(newer);
  });
});
