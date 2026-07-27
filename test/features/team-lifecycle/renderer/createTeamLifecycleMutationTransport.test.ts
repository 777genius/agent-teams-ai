import {
  createTeamLifecycleMutationTransport,
  type TeamLifecycleMutationTransportPort,
} from '@features/team-lifecycle/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteTeam: vi.fn(),
  permanentlyDeleteTeam: vi.fn(),
  restoreTeam: vi.fn(),
  unwrapIpc: vi.fn(async <T>(_operation: string, action: () => Promise<T>): Promise<T> => action()),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      deleteTeam: mocks.deleteTeam,
      permanentlyDeleteTeam: mocks.permanentlyDeleteTeam,
      restoreTeam: mocks.restoreTeam,
    },
  },
}));

vi.mock('@renderer/utils/unwrapIpc', () => ({ unwrapIpc: mocks.unwrapIpc }));

describe('createTeamLifecycleMutationTransport', () => {
  let transport: TeamLifecycleMutationTransportPort;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteTeam.mockResolvedValue(undefined);
    mocks.permanentlyDeleteTeam.mockResolvedValue(undefined);
    mocks.restoreTeam.mockResolvedValue(undefined);
    transport = createTeamLifecycleMutationTransport();
  });

  it('maps lifecycle commands to the exact legacy operations', async () => {
    await transport.softDelete('sandbox-team');
    await transport.restore('sandbox-team');
    await transport.permanentlyDelete('sandbox-team');

    expect(mocks.deleteTeam).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.restoreTeam).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.permanentlyDeleteTeam).toHaveBeenCalledWith('sandbox-team');
    expect(mocks.unwrapIpc.mock.calls.map(([operation]) => operation)).toEqual([
      'team:deleteTeam',
      'team:restoreTeam',
      'team:permanentlyDeleteTeam',
    ]);
  });

  it('preserves rejection through the IPC error boundary', async () => {
    const failure = new Error('delete failed');
    mocks.deleteTeam.mockRejectedValueOnce(failure);

    await expect(transport.softDelete('sandbox-team')).rejects.toBe(failure);
  });
});
