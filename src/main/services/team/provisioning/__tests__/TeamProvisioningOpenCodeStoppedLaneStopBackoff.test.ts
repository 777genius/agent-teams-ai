import { describe, expect, it } from 'vitest';

import { createOpenCodeStoppedLaneStopBackoff } from '../TeamProvisioningOpenCodeStoppedLaneStopBackoff';

describe('OpenCodeStoppedLaneStopBackoff', () => {
  it('backs off exactly the recorded runs until the backoff ends or the team or lane is cleared', () => {
    let nowMs = 0;
    const backoff = createOpenCodeStoppedLaneStopBackoff({ nowMs: () => nowMs, backoffMs: 100 });
    const run1 = { teamName: 'team', laneId: 'primary', runId: 'run-1' };

    backoff.recordUnconfirmedStop({ teamName: 'team', laneId: 'primary', runIds: ['run-1'] });
    expect(backoff.isBackedOff(run1)).toBe(true);
    expect(backoff.isBackedOff({ ...run1, teamName: ' Team ' })).toBe(true);
    expect(backoff.isBackedOff({ ...run1, runId: 'run-2' })).toBe(false);
    expect(backoff.isBackedOff({ ...run1, laneId: 'secondary:opencode:bob' })).toBe(false);

    nowMs = 99;
    expect(backoff.hasBackedOffRuns('team')).toBe(true);
    nowMs = 100;
    expect(backoff.isBackedOff(run1)).toBe(false);
    expect(backoff.hasBackedOffRuns('team')).toBe(false);

    backoff.recordUnconfirmedStop({ teamName: 'team', laneId: 'primary', runIds: ['run-1'] });
    backoff.clearLane('team', 'primary');
    expect(backoff.isBackedOff(run1)).toBe(false);

    backoff.recordUnconfirmedStop({ teamName: 'team', laneId: 'primary', runIds: ['run-1'] });
    backoff.clearTeam('TEAM');
    expect(backoff.isBackedOff(run1)).toBe(false);
    expect(backoff.hasBackedOffRuns('team')).toBe(false);
  });
});
