import { createTeamNotificationTransport } from '@features/team-task-board/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamMessageNotificationData } from '@shared/types';

const showMessageNotification = vi.hoisted(() => vi.fn());

vi.mock('@renderer/api', () => ({
  api: { teams: { showMessageNotification } },
}));

const notification: TeamMessageNotificationData = {
  teamName: 'sandbox-team',
  teamDisplayName: 'Sandbox Team',
  from: 'alice',
  to: 'user',
  summary: 'Task complete',
  body: 'Done',
};

describe('createTeamNotificationTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    showMessageNotification.mockResolvedValue(undefined);
  });

  it('forwards the complete notification projection', async () => {
    await createTeamNotificationTransport().show(notification);

    expect(showMessageNotification).toHaveBeenCalledWith(notification);
  });

  it('leaves best-effort failure handling to the notification caller', async () => {
    const failure = new Error('notifications unavailable');
    showMessageNotification.mockRejectedValueOnce(failure);

    await expect(createTeamNotificationTransport().show(notification)).rejects.toBe(failure);
  });
});
