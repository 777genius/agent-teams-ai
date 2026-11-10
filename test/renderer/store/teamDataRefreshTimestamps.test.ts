import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearAllLastResolvedTeamDataRefreshes,
  clearLastResolvedTeamDataRefreshAt,
  getLastResolvedTeamDataRefreshAt,
  hasLastResolvedTeamDataRefreshAt,
  recordLastResolvedTeamDataRefresh,
} from '../../../src/renderer/store/team/teamDataRefreshTimestamps';

afterEach(() => {
  vi.useRealTimers();
  clearAllLastResolvedTeamDataRefreshes();
});

describe('teamDataRefreshTimestamps', () => {
  it('returns undefined for teams without a recorded refresh', () => {
    expect(getLastResolvedTeamDataRefreshAt('my-team')).toBeUndefined();
    expect(hasLastResolvedTeamDataRefreshAt('my-team')).toBe(false);
  });

  it('records explicit refresh timestamps by team', () => {
    recordLastResolvedTeamDataRefresh('my-team', 100);
    recordLastResolvedTeamDataRefresh('other-team', 200);

    expect(getLastResolvedTeamDataRefreshAt('my-team')).toBe(100);
    expect(getLastResolvedTeamDataRefreshAt('other-team')).toBe(200);
    expect(hasLastResolvedTeamDataRefreshAt('my-team')).toBe(true);
  });

  it('uses Date.now by default to preserve current call-site behavior', () => {
    vi.setSystemTime(new Date('2026-05-22T06:30:00.000Z'));

    recordLastResolvedTeamDataRefresh('my-team');

    expect(getLastResolvedTeamDataRefreshAt('my-team')).toBe(
      new Date('2026-05-22T06:30:00.000Z').getTime()
    );
  });

  it('clears one team timestamp without touching other teams', () => {
    recordLastResolvedTeamDataRefresh('my-team', 100);
    recordLastResolvedTeamDataRefresh('other-team', 200);

    clearLastResolvedTeamDataRefreshAt('my-team');

    expect(getLastResolvedTeamDataRefreshAt('my-team')).toBeUndefined();
    expect(getLastResolvedTeamDataRefreshAt('other-team')).toBe(200);
  });

  it('clears all recorded timestamps', () => {
    recordLastResolvedTeamDataRefresh('my-team', 100);
    recordLastResolvedTeamDataRefresh('other-team', 200);

    clearAllLastResolvedTeamDataRefreshes();

    expect(hasLastResolvedTeamDataRefreshAt('my-team')).toBe(false);
    expect(hasLastResolvedTeamDataRefreshAt('other-team')).toBe(false);
  });
});
