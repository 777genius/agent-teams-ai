import { TeamRuntimeFreshnessCoordinator } from '@features/team-provisioning/renderer';
import { describe, expect, it } from 'vitest';

import type { TeamAgentRuntimeSnapshot } from '@shared/types';

function runtimeSnapshot(
  teamName: string,
  runId: string,
  updatedAt: string
): TeamAgentRuntimeSnapshot {
  return {
    teamName,
    runId,
    updatedAt,
    members: {},
  };
}

describe('TeamRuntimeFreshnessCoordinator', () => {
  it('never seeds a reset visible scope from remembered freshness', () => {
    const coordinator = new TeamRuntimeFreshnessCoordinator(() => true);
    const cached = runtimeSnapshot('sandbox-team', 'run-1', '2026-07-24T10:00:01.000Z');
    coordinator.remember('sandbox-team', cached);

    expect(coordinator.getSnapshot('sandbox-team', undefined, cached)).toBeUndefined();
  });

  it('returns only a newer same-team same-run snapshot', () => {
    const coordinator = new TeamRuntimeFreshnessCoordinator(() => true);
    const visible = runtimeSnapshot('sandbox-team', 'run-1', '2026-07-24T10:00:00.000Z');
    const cached = runtimeSnapshot('sandbox-team', 'run-1', '2026-07-24T10:00:01.000Z');
    coordinator.remember('sandbox-team', cached);

    expect(coordinator.getSnapshot('sandbox-team', visible, cached)).toBe(cached);
    expect(
      coordinator.getSnapshot(
        'sandbox-team',
        visible,
        runtimeSnapshot('sandbox-team', 'run-2', '2026-07-24T10:00:02.000Z')
      )
    ).toBe(visible);
  });

  it('isolates colliding run ids by team name', () => {
    const coordinator = new TeamRuntimeFreshnessCoordinator(() => true);
    const cached = runtimeSnapshot('team-a', 'shared-run', '2026-07-24T10:00:01.000Z');
    const visible = runtimeSnapshot('team-b', 'shared-run', '2026-07-24T10:00:00.000Z');
    coordinator.remember('team-a', cached);

    expect(coordinator.getSnapshot('team-b', visible, visible)).toBe(visible);
  });

  it('clears one team independently and supports a full reset', () => {
    const coordinator = new TeamRuntimeFreshnessCoordinator(() => true);
    const visibleA = runtimeSnapshot('team-a', 'run-1', '2026-07-24T10:00:00.000Z');
    const cachedA = runtimeSnapshot('team-a', 'run-1', '2026-07-24T10:00:01.000Z');
    const visibleB = runtimeSnapshot('team-b', 'run-1', '2026-07-24T10:00:00.000Z');
    const cachedB = runtimeSnapshot('team-b', 'run-1', '2026-07-24T10:00:01.000Z');
    coordinator.remember('team-a', cachedA);
    coordinator.remember('team-b', cachedB);

    coordinator.clearTeam('team-a');
    expect(coordinator.getSnapshot('team-a', visibleA, cachedA)).toBe(visibleA);
    expect(coordinator.getSnapshot('team-b', visibleB, cachedB)).toBe(cachedB);

    coordinator.reset();
    expect(coordinator.getSnapshot('team-b', visibleB, cachedB)).toBe(visibleB);
  });
});
