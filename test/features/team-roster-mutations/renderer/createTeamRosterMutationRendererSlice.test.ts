import {
  createTeamRosterMutationRendererSlice,
  createTeamRosterMutationTransport,
  type TeamRosterMutationRefreshActions,
} from '@features/team-roster-mutations/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  addMember: vi.fn(),
  removeMember: vi.fn(),
  restoreMember: vi.fn(),
  updateMemberRole: vi.fn(),
  unwrapIpc: vi.fn(async <T>(_operation: string, action: () => Promise<T>): Promise<T> => action()),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      addMember: apiMocks.addMember,
      removeMember: apiMocks.removeMember,
      restoreMember: apiMocks.restoreMember,
      updateMemberRole: apiMocks.updateMemberRole,
    },
  },
}));

vi.mock('@renderer/utils/unwrapIpc', () => ({ unwrapIpc: apiMocks.unwrapIpc }));

function createHarness() {
  const trace: string[] = [];
  const actions: TeamRosterMutationRefreshActions = {
    fetchMemberSpawnStatuses: vi.fn(async () => {
      trace.push('refresh:spawn');
    }),
    fetchTeamAgentRuntime: vi.fn(async () => {
      trace.push('refresh:runtime');
    }),
    refreshTeamData: vi.fn(async () => {
      trace.push('refresh:data');
    }),
  };
  const transport = {
    add: vi.fn(async () => {
      trace.push('transport:add');
    }),
    remove: vi.fn(async () => {
      trace.push('transport:remove');
    }),
    restore: vi.fn(async () => {
      trace.push('transport:restore');
    }),
    updateRole: vi.fn(async () => {
      trace.push('transport:update-role');
    }),
  };
  const slice = createTeamRosterMutationRendererSlice({
    actions: { getActions: () => actions },
    transport,
  });
  return { actions, slice, trace, transport };
}

describe('createTeamRosterMutationRendererSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('refreshes canonical team data after add, remove, and role changes', async () => {
    const harness = createHarness();

    await harness.slice.addMember('sandbox-team', { name: 'alice' });
    await harness.slice.removeMember('sandbox-team', 'alice');
    await harness.slice.updateMemberRole('sandbox-team', 'alice', 'reviewer');

    expect(harness.trace).toEqual([
      'transport:add',
      'refresh:data',
      'transport:remove',
      'refresh:data',
      'transport:update-role',
      'refresh:data',
    ]);
  });

  it('refreshes restored roster data before best-effort runtime projections', async () => {
    const harness = createHarness();

    await harness.slice.restoreMember('sandbox-team', 'alice');

    expect(harness.trace).toEqual([
      'transport:restore',
      'refresh:data',
      'refresh:spawn',
      'refresh:runtime',
    ]);
  });

  it('does not refresh after a failed roster mutation', async () => {
    const harness = createHarness();
    const failure = new Error('remove failed');
    harness.transport.remove.mockRejectedValueOnce(failure);

    await expect(harness.slice.removeMember('sandbox-team', 'alice')).rejects.toBe(failure);
    expect(harness.actions.refreshTeamData).not.toHaveBeenCalled();
  });

  it('maps renderer roster commands to the exact legacy transport methods', async () => {
    apiMocks.addMember.mockResolvedValueOnce(undefined);
    apiMocks.removeMember.mockResolvedValueOnce(undefined);
    apiMocks.restoreMember.mockResolvedValueOnce(undefined);
    apiMocks.updateMemberRole.mockResolvedValueOnce(undefined);
    const transport = createTeamRosterMutationTransport();
    const request = { name: 'alice' };

    await transport.add('sandbox-team', request);
    await transport.remove('sandbox-team', 'alice');
    await transport.restore('sandbox-team', 'alice');
    await transport.updateRole('sandbox-team', 'alice', 'reviewer');

    expect(apiMocks.addMember).toHaveBeenCalledWith('sandbox-team', request);
    expect(apiMocks.removeMember).toHaveBeenCalledWith('sandbox-team', 'alice');
    expect(apiMocks.restoreMember).toHaveBeenCalledWith('sandbox-team', 'alice');
    expect(apiMocks.updateMemberRole).toHaveBeenCalledWith('sandbox-team', 'alice', 'reviewer');
  });
});
