import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllMemberSpawnStatusesIpcBackoffs,
  clearMemberSpawnStatusesIpcBackoff,
  getMemberSpawnStatusesIpcBackoffUntil,
  hasMemberSpawnStatusesIpcBackoff,
  isMemberSpawnStatusesIpcBackoffActive,
  recordMemberSpawnStatusesIpcBackoffUntil,
  recordMemberSpawnStatusesIpcRetryBackoff,
} from '../../../src/renderer/store/team/teamMemberSpawnStatusBackoff';

afterEach(() => {
  vi.useRealTimers();
  clearAllMemberSpawnStatusesIpcBackoffs();
});

describe('teamMemberSpawnStatusBackoff', () => {
  it('defaults to no backoff for unknown teams', () => {
    expect(getMemberSpawnStatusesIpcBackoffUntil('my-team')).toBe(0);
    expect(hasMemberSpawnStatusesIpcBackoff('my-team')).toBe(false);
    expect(isMemberSpawnStatusesIpcBackoffActive('my-team', 100)).toBe(false);
  });

  it('tracks active backoff deadlines by team', () => {
    recordMemberSpawnStatusesIpcBackoffUntil('my-team', 150);
    recordMemberSpawnStatusesIpcBackoffUntil('other-team', 250);

    expect(getMemberSpawnStatusesIpcBackoffUntil('my-team')).toBe(150);
    expect(isMemberSpawnStatusesIpcBackoffActive('my-team', 149)).toBe(true);
    expect(isMemberSpawnStatusesIpcBackoffActive('my-team', 150)).toBe(false);
    expect(isMemberSpawnStatusesIpcBackoffActive('other-team', 249)).toBe(true);
  });

  it('records retry backoff from Date.now by default', () => {
    vi.setSystemTime(new Date('2026-05-22T07:00:00.000Z'));

    recordMemberSpawnStatusesIpcRetryBackoff('my-team', 5_000);

    expect(getMemberSpawnStatusesIpcBackoffUntil('my-team')).toBe(
      new Date('2026-05-22T07:00:05.000Z').getTime()
    );
  });

  it('records retry backoff from an explicit clock for deterministic callers', () => {
    recordMemberSpawnStatusesIpcRetryBackoff('my-team', 5_000, 100);

    expect(getMemberSpawnStatusesIpcBackoffUntil('my-team')).toBe(5_100);
  });

  it('clears one team backoff without touching others', () => {
    recordMemberSpawnStatusesIpcBackoffUntil('my-team', 150);
    recordMemberSpawnStatusesIpcBackoffUntil('other-team', 250);

    clearMemberSpawnStatusesIpcBackoff('my-team');

    expect(hasMemberSpawnStatusesIpcBackoff('my-team')).toBe(false);
    expect(getMemberSpawnStatusesIpcBackoffUntil('other-team')).toBe(250);
  });

  it('clears all recorded backoffs', () => {
    recordMemberSpawnStatusesIpcBackoffUntil('my-team', 150);
    recordMemberSpawnStatusesIpcBackoffUntil('other-team', 250);

    clearAllMemberSpawnStatusesIpcBackoffs();

    expect(hasMemberSpawnStatusesIpcBackoff('my-team')).toBe(false);
    expect(hasMemberSpawnStatusesIpcBackoff('other-team')).toBe(false);
  });
});
