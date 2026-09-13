import { memberNudgeRateLimitRetryAt } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeDispatchPolicy';
import { describe, expect, it } from 'vitest';

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
