import { createTeamMessageDeliveryTransport } from '@renderer/composition/team/createTeamMessageDeliveryTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getRuntimeDeliveryStatus: vi.fn(),
  listTargets: vi.fn(),
  sendCrossTeam: vi.fn(),
  sendTeam: vi.fn(),
  unwrapIpc: vi.fn(async <T>(_operation: string, action: () => Promise<T>): Promise<T> => action()),
}));

vi.mock('@renderer/api', () => ({
  api: {
    crossTeam: {
      listTargets: mocks.listTargets,
      send: mocks.sendCrossTeam,
    },
    teams: {
      getOpenCodeRuntimeDeliveryStatus: mocks.getRuntimeDeliveryStatus,
      sendMessage: mocks.sendTeam,
    },
  },
}));

vi.mock('@renderer/utils/unwrapIpc', () => ({ unwrapIpc: mocks.unwrapIpc }));

describe('createTeamMessageDeliveryTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeDeliveryStatus.mockResolvedValue(null);
    mocks.listTargets.mockResolvedValue([{ teamName: 'peer', displayName: 'Peer' }]);
    mocks.sendCrossTeam.mockResolvedValue({ deliveredToInbox: true, messageId: 'cross-1' });
    mocks.sendTeam.mockResolvedValue({ deliveredToInbox: true, messageId: 'message-1' });
  });

  it('isolates both message transports while preserving their exact payloads', async () => {
    const transport = createTeamMessageDeliveryTransport();
    const teamRequest = { member: 'alice', text: 'hello' };
    const crossTeamRequest = {
      fromTeam: 'sandbox-team',
      fromMember: 'user',
      toTeam: 'peer',
      toMember: 'team-lead',
      text: 'hello peer',
    };

    await expect(transport.crossTeam.listTargets()).resolves.toEqual([
      { teamName: 'peer', displayName: 'Peer' },
    ]);
    await transport.crossTeam.send(crossTeamRequest);
    await transport.team.send('sandbox-team', teamRequest);
    await transport.team.getRuntimeDeliveryStatus('sandbox-team', 'message-1');

    expect(mocks.sendCrossTeam).toHaveBeenCalledWith(crossTeamRequest);
    expect(mocks.sendTeam).toHaveBeenCalledWith('sandbox-team', teamRequest);
    expect(mocks.getRuntimeDeliveryStatus).toHaveBeenCalledWith('sandbox-team', 'message-1');
    expect(mocks.unwrapIpc.mock.calls.map(([operation]) => operation)).toEqual([
      'team:sendMessage',
      'team:getOpenCodeRuntimeDeliveryStatus',
    ]);
  });

  it('does not wrap cross-team failures in a team IPC error', async () => {
    const failure = new Error('cross-team failed');
    mocks.sendCrossTeam.mockRejectedValueOnce(failure);

    await expect(
      createTeamMessageDeliveryTransport().crossTeam.send({
        fromTeam: 'sandbox-team',
        fromMember: 'user',
        toTeam: 'peer',
        toMember: 'team-lead',
        text: 'hello peer',
      })
    ).rejects.toBe(failure);
    expect(mocks.unwrapIpc).not.toHaveBeenCalled();
  });
});
