import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllMemberSpawnUiEqualLastWarns,
  clearMemberSpawnUiEqualLastWarn,
  getMemberSpawnUiEqualLastWarnAt,
  hasMemberSpawnUiEqualLastWarn,
  shouldLogMemberSpawnUiEqualSuppressed,
} from '../../../src/renderer/store/team/teamMemberSpawnUiEqualWarningThrottle';

afterEach(() => {
  vi.useRealTimers();
  clearAllMemberSpawnUiEqualLastWarns();
});

describe('teamMemberSpawnUiEqualWarningThrottle', () => {
  it('preserves the existing zero fallback boundary for unknown teams', () => {
    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 1_999)).toBe(false);
    expect(hasMemberSpawnUiEqualLastWarn('my-team')).toBe(false);

    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 2_000)).toBe(true);
    expect(getMemberSpawnUiEqualLastWarnAt('my-team')).toBe(2_000);
  });

  it('throttles repeated warnings until the boundary is reached', () => {
    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 10_000)).toBe(true);
    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 11_999)).toBe(false);
    expect(getMemberSpawnUiEqualLastWarnAt('my-team')).toBe(10_000);

    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 12_000)).toBe(true);
    expect(getMemberSpawnUiEqualLastWarnAt('my-team')).toBe(12_000);
  });

  it('tracks teams independently', () => {
    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 10_000)).toBe(true);
    expect(shouldLogMemberSpawnUiEqualSuppressed('other-team', 2_000, 10_500)).toBe(true);

    expect(getMemberSpawnUiEqualLastWarnAt('my-team')).toBe(10_000);
    expect(getMemberSpawnUiEqualLastWarnAt('other-team')).toBe(10_500);
  });

  it('uses Date.now by default for production callers', () => {
    vi.setSystemTime(new Date('2026-05-22T07:30:00.000Z'));

    expect(shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000)).toBe(true);

    expect(getMemberSpawnUiEqualLastWarnAt('my-team')).toBe(
      new Date('2026-05-22T07:30:00.000Z').getTime()
    );
  });

  it('clears one team without touching other teams', () => {
    shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 10_000);
    shouldLogMemberSpawnUiEqualSuppressed('other-team', 2_000, 10_500);

    clearMemberSpawnUiEqualLastWarn('my-team');

    expect(hasMemberSpawnUiEqualLastWarn('my-team')).toBe(false);
    expect(getMemberSpawnUiEqualLastWarnAt('other-team')).toBe(10_500);
  });

  it('clears all tracked warnings', () => {
    shouldLogMemberSpawnUiEqualSuppressed('my-team', 2_000, 10_000);
    shouldLogMemberSpawnUiEqualSuppressed('other-team', 2_000, 10_500);

    clearAllMemberSpawnUiEqualLastWarns();

    expect(hasMemberSpawnUiEqualLastWarn('my-team')).toBe(false);
    expect(hasMemberSpawnUiEqualLastWarn('other-team')).toBe(false);
  });
});
