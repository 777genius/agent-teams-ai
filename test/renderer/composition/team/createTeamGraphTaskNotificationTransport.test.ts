import { createTeamGraphTaskNotificationTransport } from '@renderer/composition/team/createTeamGraphTaskNotificationTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  processSend: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      processSend: mocks.processSend,
    },
  },
}));

describe('createTeamGraphTaskNotificationTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delivers graph task notifications with the original team and message', async () => {
    mocks.processSend.mockResolvedValueOnce(undefined);

    await expect(
      createTeamGraphTaskNotificationTransport().notifyTeam('sandbox-team', 'Task started')
    ).resolves.toBeUndefined();
    expect(mocks.processSend).toHaveBeenCalledWith('sandbox-team', 'Task started');
  });

  it('preserves delivery failures for the graph best-effort policy', async () => {
    const failure = new Error('team offline');
    mocks.processSend.mockRejectedValueOnce(failure);

    await expect(
      createTeamGraphTaskNotificationTransport().notifyTeam('sandbox-team', 'Task started')
    ).rejects.toBe(failure);
  });
});
