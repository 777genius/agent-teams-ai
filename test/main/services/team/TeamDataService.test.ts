import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

import type { TeamTask } from '../../../../src/shared/types/team';

describe('TeamDataService', () => {
  it('runs kanban garbage-collect only after tasks are loaded', async () => {
    const order: string[] = [];
    const tasks: TeamTask[] = [
      {
        id: '12',
        subject: 'Task',
        status: 'pending',
      },
    ];

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getTasks: vi.fn(async () => {
          order.push('tasks');
          return tasks;
        }),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => {
          order.push('gc');
        }),
      } as never
    );

    await service.getTeamData('my-team');
    expect(order).toEqual(['tasks', 'gc']);
  });

  it('skips kanban garbage-collect when tasks fail to load', async () => {
    const garbageCollect = vi.fn(async () => undefined);
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getTasks: vi.fn(async () => {
          throw new Error('tasks failed');
        }),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect,
      } as never
    );

    const result = await service.getTeamData('my-team');
    expect(garbageCollect).not.toHaveBeenCalled();
    expect(result.warnings).toContain('Tasks failed to load');
  });
});
