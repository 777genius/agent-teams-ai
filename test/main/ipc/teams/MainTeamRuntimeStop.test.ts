import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamForceStopFlowPorts } from '@main/services/team/lifecycle/teamForceStopFlow';

const stopFlowMocks = vi.hoisted(() => ({
  runTeamForceStopFlow: vi.fn((_teamName: string, _ports: TeamForceStopFlowPorts) =>
    Promise.resolve({
      stopOutcome: 'stopped' as const,
      cleanupOutcome: 'completed' as const,
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    })
  ),
  stopTeamWithEscalation: vi.fn((_teamName: string, _ports: TeamForceStopFlowPorts) =>
    Promise.resolve({
      stopOutcome: 'stopped' as const,
      cleanupOutcome: 'completed' as const,
      killedRuntimePids: [],
      clearedPendingDeliveries: 0,
      diagnostics: [],
    })
  ),
}));

vi.mock('@main/services/team/lifecycle/teamForceStopFlow', () => stopFlowMocks);
vi.mock('@main/sentry', () => ({ addMainBreadcrumb: vi.fn() }));
vi.mock('@main/utils/pathDecoder', () => ({ getTeamsBasePath: () => '/tmp/teams' }));

import { MainTeamRuntimeStop } from '@main/ipc/teams/MainTeamRuntimeStop';

describe('MainTeamRuntimeStop timeout contracts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('keeps regular stop at 90 seconds and explicit force stop at 15 seconds', async () => {
    const runtimeStop = new MainTeamRuntimeStop(
      {
        getAliveTeams: () => ['sandbox-team'],
        stopTeam: vi.fn(() => Promise.resolve()),
      },
      { info: vi.fn(), warn: vi.fn() }
    );

    await runtimeStop.stopTeam('sandbox-team');
    await runtimeStop.forceStopTeam('sandbox-team');

    const regularPorts = stopFlowMocks.stopTeamWithEscalation.mock.lastCall?.[1] as
      | TeamForceStopFlowPorts
      | undefined;
    const forcePorts = stopFlowMocks.runTeamForceStopFlow.mock.lastCall?.[1] as
      | TeamForceStopFlowPorts
      | undefined;
    expect(regularPorts?.stopTimeoutMs).toBe(90_000);
    expect(forcePorts?.stopTimeoutMs).toBe(15_000);
  });
});
