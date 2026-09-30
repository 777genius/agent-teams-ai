import { createTeamTaskDetailTransport } from '@renderer/composition/team/createTeamTaskDetailTransport';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTask: vi.fn(),
  processSend: vi.fn(),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getTask: mocks.getTask,
      processSend: mocks.processSend,
    },
  },
}));

describe('createTeamTaskDetailTransport', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getTask.mockResolvedValue(null);
    mocks.processSend.mockResolvedValue(undefined);
  });

  it('maps task reads and lead notifications to the exact legacy calls', async () => {
    const task = {
      id: 'task-7',
      subject: 'Keep renderer behavior',
      status: 'in_progress' as const,
    };
    mocks.getTask.mockResolvedValueOnce(task);
    const transport = createTeamTaskDetailTransport();

    await expect(transport.readTask('sandbox-team', 'task-7')).resolves.toBe(task);
    await transport.notifyTaskLead('sandbox-team', 'Task #task-7 started');

    expect(mocks.getTask).toHaveBeenCalledWith('sandbox-team', 'task-7');
    expect(mocks.processSend).toHaveBeenCalledWith('sandbox-team', 'Task #task-7 started');
  });

  it('preserves transport rejections for the existing caller-owned error behavior', async () => {
    const readFailure = new Error('task unavailable');
    const notificationFailure = new Error('lead unavailable');
    mocks.getTask.mockRejectedValueOnce(readFailure);
    mocks.processSend.mockRejectedValueOnce(notificationFailure);
    const transport = createTeamTaskDetailTransport();

    await expect(transport.readTask('sandbox-team', 'task-7')).rejects.toBe(readFailure);
    await expect(transport.notifyTaskLead('sandbox-team', 'Task #task-7 started')).rejects.toBe(
      notificationFailure
    );
  });
});
