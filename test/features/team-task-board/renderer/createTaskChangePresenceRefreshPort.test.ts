import { describe, expect, it, vi } from 'vitest';

import { createTaskChangePresenceRefreshPort } from '../../../../src/features/team-task-board/renderer/adapters/createTaskChangePresenceRefreshPort';

import type { TeamViewSnapshot } from '../../../../src/shared/types';

function createSelectedTeamData(): TeamViewSnapshot {
  return {
    teamName: 'team-a',
    config: { name: 'Team A' },
    tasks: [
      {
        id: 'task-1',
        subject: 'Task',
        status: 'in_progress',
        owner: 'alice',
        createdAt: '2026-07-23T10:00:00.000Z',
        updatedAt: '2026-07-23T10:00:05.000Z',
        comments: [],
        attachments: [],
        historyEvents: [],
      },
    ],
    members: [],
    messages: [],
    processes: [],
    kanbanState: { teamName: 'team-a', reviewers: [], tasks: {} },
  } as unknown as TeamViewSnapshot;
}

describe('createTaskChangePresenceRefreshPort', () => {
  it('invalidates the exact cache key before checking task changes', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(() => Promise.resolve(false));
    const port = createTaskChangePresenceRefreshPort(() => ({
      selectedTeamName: 'team-a',
      selectedTeamData: createSelectedTeamData(),
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    }));

    await port.refreshAfterTaskTransition('team-a', 'task-1');

    expect(invalidateTaskChangePresence).toHaveBeenCalledWith([expect.stringContaining('team-a')]);
    expect(checkTaskHasChanges).toHaveBeenCalledWith('team-a', 'task-1', expect.any(Object));
    expect(invalidateTaskChangePresence.mock.invocationCallOrder[0]).toBeLessThan(
      checkTaskHasChanges.mock.invocationCallOrder[0]
    );
  });

  it('does nothing when the transitioned task is not on the selected team surface', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(() => Promise.resolve(false));
    const port = createTaskChangePresenceRefreshPort(() => ({
      selectedTeamName: 'team-b',
      selectedTeamData: createSelectedTeamData(),
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    }));

    await port.refreshAfterTaskTransition('team-a', 'task-1');

    expect(invalidateTaskChangePresence).not.toHaveBeenCalled();
    expect(checkTaskHasChanges).not.toHaveBeenCalled();
  });

  it('contains best-effort check failures after invalidation', async () => {
    const invalidateTaskChangePresence = vi.fn();
    const checkTaskHasChanges = vi.fn(() => Promise.reject(new Error('check failed')));
    const port = createTaskChangePresenceRefreshPort(() => ({
      selectedTeamName: 'team-a',
      selectedTeamData: createSelectedTeamData(),
      invalidateTaskChangePresence,
      checkTaskHasChanges,
    }));

    await expect(port.refreshAfterTaskTransition('team-a', 'task-1')).resolves.toBeUndefined();
    expect(invalidateTaskChangePresence).toHaveBeenCalledOnce();
  });
});
