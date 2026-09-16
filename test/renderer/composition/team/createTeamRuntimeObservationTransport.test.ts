import { createTeamRuntimeObservationTransport } from '@renderer/composition/team/createTeamRuntimeObservationTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

const mocks = vi.hoisted(() => {
  const getMemberSpawnStatuses = vi.fn();
  const getTeamAgentRuntime = vi.fn();
  return {
    getMemberSpawnStatuses,
    getTeamAgentRuntime,
    teams: {
      getMemberSpawnStatuses,
      getTeamAgentRuntime,
    },
  };
});

vi.mock('@renderer/api', () => ({
  api: {
    teams: mocks.teams,
  },
}));

describe('createTeamRuntimeObservationTransport', () => {
  beforeEach(() => {
    mocks.teams.getMemberSpawnStatuses = mocks.getMemberSpawnStatuses;
    mocks.teams.getTeamAgentRuntime = mocks.getTeamAgentRuntime;
    vi.clearAllMocks();
  });

  it('forwards runtime observation queries without changing their snapshots', async () => {
    const memberSpawnSnapshot: MemberSpawnStatusesSnapshot = {
      runId: 'run-1',
      statuses: {},
      updatedAt: '2026-07-30T10:00:00.000Z',
    };
    const runtimeSnapshot: TeamAgentRuntimeSnapshot = {
      teamName: 'sandbox-team',
      runId: 'run-1',
      members: {},
      updatedAt: '2026-07-30T10:00:01.000Z',
    };
    mocks.getMemberSpawnStatuses.mockResolvedValueOnce(memberSpawnSnapshot);
    mocks.getTeamAgentRuntime.mockResolvedValueOnce(runtimeSnapshot);
    const transport = createTeamRuntimeObservationTransport();

    await expect(transport.getMemberSpawnStatuses('sandbox-team')).resolves.toBe(
      memberSpawnSnapshot
    );
    await expect(transport.getTeamAgentRuntime('sandbox-team')).resolves.toBe(runtimeSnapshot);
    expect(mocks.getMemberSpawnStatuses).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.getTeamAgentRuntime).toHaveBeenCalledWith('sandbox-team');
  });

  it('returns null when runtime observation handlers are unavailable', async () => {
    Reflect.deleteProperty(mocks.teams, 'getMemberSpawnStatuses');
    Reflect.deleteProperty(mocks.teams, 'getTeamAgentRuntime');
    const transport = createTeamRuntimeObservationTransport();

    await expect(transport.getMemberSpawnStatuses('sandbox-team')).resolves.toBeNull();
    await expect(transport.getTeamAgentRuntime('sandbox-team')).resolves.toBeNull();
  });

  it('preserves transport failures for the observation slice error policies', async () => {
    const memberSpawnFailure = new Error('member spawn unavailable');
    const runtimeFailure = new Error('runtime unavailable');
    mocks.getMemberSpawnStatuses.mockRejectedValueOnce(memberSpawnFailure);
    mocks.getTeamAgentRuntime.mockRejectedValueOnce(runtimeFailure);
    const transport = createTeamRuntimeObservationTransport();

    await expect(transport.getMemberSpawnStatuses('sandbox-team')).rejects.toBe(memberSpawnFailure);
    await expect(transport.getTeamAgentRuntime('sandbox-team')).rejects.toBe(runtimeFailure);
  });
});
