import { afterEach, describe, expect, it } from 'vitest';

import {
  clearAllTeamRefreshBurstDiagnostics,
  clearTeamRefreshBurstDiagnostics,
  getTeamRefreshBurstDiagnosticForTests,
  hasTeamRefreshBurstDiagnostics,
  noteTeamRefreshBurst,
} from '../../../src/renderer/store/team/teamRefreshBurstDiagnostics';

afterEach(() => {
  clearAllTeamRefreshBurstDiagnostics();
});

describe('teamRefreshBurstDiagnostics store', () => {
  it('creates a window on the first refresh note', () => {
    expect(noteTeamRefreshBurst('my-team', 4_000, 10_000)).toBe(1);

    expect(getTeamRefreshBurstDiagnosticForTests('my-team')).toEqual({
      windowStartedAt: 10_000,
      count: 1,
      lastWarnAt: 0,
    });
    expect(hasTeamRefreshBurstDiagnostics('my-team')).toBe(true);
  });

  it('increments inside the active burst window', () => {
    expect(noteTeamRefreshBurst('my-team', 4_000, 10_000)).toBe(1);
    expect(noteTeamRefreshBurst('my-team', 4_000, 13_999)).toBe(2);
    expect(noteTeamRefreshBurst('my-team', 4_000, 14_000)).toBe(3);

    expect(getTeamRefreshBurstDiagnosticForTests('my-team')).toEqual({
      windowStartedAt: 10_000,
      count: 3,
      lastWarnAt: 0,
    });
  });

  it('resets only after now is strictly beyond the burst window', () => {
    expect(noteTeamRefreshBurst('my-team', 4_000, 10_000)).toBe(1);
    expect(noteTeamRefreshBurst('my-team', 4_000, 14_001)).toBe(1);

    expect(getTeamRefreshBurstDiagnosticForTests('my-team')).toEqual({
      windowStartedAt: 14_001,
      count: 1,
      lastWarnAt: 0,
    });
  });

  it('tracks each team independently', () => {
    noteTeamRefreshBurst('my-team', 4_000, 10_000);
    noteTeamRefreshBurst('my-team', 4_000, 10_500);
    noteTeamRefreshBurst('other-team', 4_000, 11_000);

    expect(getTeamRefreshBurstDiagnosticForTests('my-team')?.count).toBe(2);
    expect(getTeamRefreshBurstDiagnosticForTests('other-team')?.count).toBe(1);
  });

  it('clears one team or all diagnostics', () => {
    noteTeamRefreshBurst('my-team', 4_000, 10_000);
    noteTeamRefreshBurst('other-team', 4_000, 11_000);

    clearTeamRefreshBurstDiagnostics('my-team');

    expect(hasTeamRefreshBurstDiagnostics('my-team')).toBe(false);
    expect(hasTeamRefreshBurstDiagnostics('other-team')).toBe(true);

    clearAllTeamRefreshBurstDiagnostics();

    expect(hasTeamRefreshBurstDiagnostics('other-team')).toBe(false);
  });

  it('returns defensive diagnostic snapshots for tests', () => {
    noteTeamRefreshBurst('my-team', 4_000, 10_000);

    const snapshot = getTeamRefreshBurstDiagnosticForTests('my-team');
    if (snapshot) {
      snapshot.count = 99;
    }

    expect(getTeamRefreshBurstDiagnosticForTests('my-team')?.count).toBe(1);
  });
});
