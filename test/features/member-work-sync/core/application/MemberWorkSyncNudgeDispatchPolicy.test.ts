import {
  isUnauthorizedManualContinue,
  memberNudgeRateLimitRetryAt,
} from '@features/member-work-sync/core/application/MemberWorkSyncNudgeDispatchPolicy';
import { describe, expect, it } from 'vitest';

import type {
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '@features/member-work-sync/contracts';

describe('memberNudgeRateLimitRetryAt', () => {
  it('retries when the oldest counted delivery leaves the hour window', () => {
    expect(memberNudgeRateLimitRetryAt('2026-04-29T00:59:00.000Z', '2026-04-29T00:00:00.000Z')).toBe(
      '2026-04-29T01:00:00.000Z'
    );
  });

  it('waits a full hour from now when the oldest delivery timestamp is missing', () => {
    expect(memberNudgeRateLimitRetryAt('2026-04-29T00:00:00.000Z')).toBe('2026-04-29T01:00:00.000Z');
  });

  it('advances one millisecond when the window expires exactly now', () => {
    expect(memberNudgeRateLimitRetryAt('2026-04-29T01:00:00.000Z', '2026-04-29T00:00:00.000Z')).toBe(
      '2026-04-29T01:00:00.001Z'
    );
  });
});

describe('isUnauthorizedManualContinue', () => {
  const item = {
    id: 'continue-b',
    payload: { workSyncIntentKey: 'manual-continue:default' },
  } as MemberWorkSyncOutboxItem;

  it('allows a Continue before the recovery slot is reserved', () => {
    expect(isUnauthorizedManualContinue({ status: null, item })).toBe(false);
    expect(
      isUnauthorizedManualContinue({
        status: { recoveryHealth: { unresolvedIntentId: undefined } } as MemberWorkSyncStatus,
        item,
      })
    ).toBe(false);
  });

  it('allows the Continue that currently owns the recovery slot', () => {
    expect(
      isUnauthorizedManualContinue({
        status: { recoveryHealth: { unresolvedIntentId: 'continue-b' } } as MemberWorkSyncStatus,
        item,
      })
    ).toBe(false);
  });

  it('rejects a Continue that does not own the reserved slot', () => {
    expect(
      isUnauthorizedManualContinue({
        status: { recoveryHealth: { unresolvedIntentId: 'continue-a' } } as MemberWorkSyncStatus,
        item,
      })
    ).toBe(true);
  });
});
