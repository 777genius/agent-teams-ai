import { describe, expect, it } from 'vitest';

import { rankRunningTeamFacts } from '../policies/rankRunningTeamFacts';

import type { RunningTeamFacts } from '../policies/rankRunningTeamFacts';

function fact(overrides: Partial<RunningTeamFacts>): RunningTeamFacts {
  return {
    targetKey: 'team-a',
    displayName: 'Team A',
    activity: 'running_unknown',
    taskCounts: { kind: 'unknown' },
    lastActivity: { kind: 'unknown' },
    ...overrides,
  };
}

describe('rankRunningTeamFacts', () => {
  it('keeps Desktop priority and work/activity ordering without mutating source facts', () => {
    const input = [
      fact({ targetKey: 'idle', activity: 'idle' }),
      fact({
        targetKey: 'active-low',
        activity: 'active',
        taskCounts: { kind: 'known', counts: { inProgress: 1, pending: 0, completed: 0 } },
      }),
      fact({
        targetKey: 'active-high',
        activity: 'active',
        taskCounts: { kind: 'known', counts: { inProgress: 2, pending: 0, completed: 0 } },
      }),
      fact({ targetKey: 'provisioning', activity: 'provisioning' }),
      fact({ targetKey: 'offline', activity: 'not_running' }),
    ];

    expect(rankRunningTeamFacts(input).map((row) => row.targetKey)).toEqual([
      'active-high',
      'active-low',
      'provisioning',
      'idle',
    ]);
    expect(input.map((row) => row.targetKey)).toEqual([
      'idle',
      'active-low',
      'active-high',
      'provisioning',
      'offline',
    ]);
  });

  it('keeps unknown Hosted facts unknown and orders same-name rows by opaque key', () => {
    const input = [
      fact({ targetKey: 'z', displayName: 'Same' }),
      fact({ targetKey: 'a', displayName: 'Same' }),
      fact({ targetKey: 'b', displayName: 'Before' }),
    ];

    const result = rankRunningTeamFacts(input);
    expect(result.map((row) => row.targetKey)).toEqual(['b', 'a', 'z']);
    expect(result.every((row) => row.taskCounts.kind === 'unknown')).toBe(true);
    expect(result.every((row) => row.lastActivity.kind === 'unknown')).toBe(true);
  });
});
