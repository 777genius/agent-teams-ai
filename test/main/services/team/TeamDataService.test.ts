import { describe, expect, it, vi } from 'vitest';

import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

import type { TeamTask } from '../../../../src/shared/types/team';

describe('TeamDataService', () => {
  it('keeps getTeamData read-only and skips kanban garbage-collect', async () => {
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
    expect(order).toEqual(['tasks']);
  });

  it('delegates explicit reconcile to controller maintenance API', async () => {
    const reconcileArtifacts = vi.fn();
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [{ name: 'team-lead', role: 'Lead' }] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {
        readMembers: vi.fn(async () => []),
      } as never,
      {
        readMessages: vi.fn(async () => []),
      } as never,
      () =>
        ({
          maintenance: {
            reconcileArtifacts,
          },
        }) as never
    );

    await service.reconcileTeamArtifacts('my-team');
    expect(reconcileArtifacts).toHaveBeenCalledWith({ reason: 'file-watch' });
  });

  it('surfaces controller reconcile failures', async () => {
    const reconcileArtifacts = vi.fn(() => {
      throw new Error('reconcile failed');
    });
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          maintenance: {
            reconcileArtifacts,
          },
        }) as never
    );

    await expect(service.reconcileTeamArtifacts('my-team')).rejects.toThrow('reconcile failed');
  });

  it('writes UI task comments with author user', async () => {
    const addTaskComment = vi.fn(() => ({
      comment: {
        id: 'comment-1',
        author: 'user',
        text: 'Need clarification',
        createdAt: '2026-03-07T20:00:00.000Z',
        type: 'regular',
      },
      task: {
        id: 'task-1',
        subject: 'Investigate',
        status: 'pending',
        owner: 'team-lead',
      },
    }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [{ name: 'team-lead', role: 'Lead' }] })),
      } as never,
      {
        getTasks: vi.fn(async () => []),
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
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          tasks: {
            addTaskComment,
            setNeedsClarification: vi.fn(),
          },
        }) as never
    );

    await service.addTaskComment('my-team', 'task-1', 'Need clarification');

    expect(addTaskComment).toHaveBeenCalledWith('task-1', {
      from: 'user',
      text: 'Need clarification',
      attachments: undefined,
    });
  });

  it('includes projectPath from config when creating a task', async () => {
    const createTaskMock = vi.fn((task) => task);

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [],
          projectPath: '/Users/dev/my-project',
        })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '1'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', { subject: 'Test' });

    expect(result.projectPath).toBe('/Users/dev/my-project');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ projectPath: '/Users/dev/my-project' })
    );
  });

  it('creates task with status pending when startImmediately is false', async () => {
    const createTaskMock = vi.fn((task) => ({ ...task, status: 'pending' }));
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '2'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Review main file',
      owner: 'alice',
      startImmediately: false,
    });

    expect(result.status).toBe('pending');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'alice', createdBy: 'user' })
    );
    expect(createTaskMock).not.toHaveBeenCalledWith(expect.objectContaining({ startImmediately: true }));
  });

  it('creates task with explicit immediate start only when startImmediately is true', async () => {
    const createTaskMock = vi.fn((task) => ({ ...task, status: 'in_progress' }));
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '2'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (_teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Start now',
      owner: 'alice',
      startImmediately: true,
      prompt: 'Begin immediately.',
    });

    expect(result.status).toBe('in_progress');
    expect(createTaskMock).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'alice',
        createdBy: 'user',
        startImmediately: true,
        prompt: 'Begin immediately.',
      })
    );
    expect(createTaskMock).not.toHaveBeenCalledWith(expect.objectContaining({ status: 'in_progress' }));
  });

  it('persists explicit related task links when creating a task', async () => {
    const createTaskMock = vi.fn((task) => task);
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [] })),
      } as never,
      {
        getNextTaskId: vi.fn(async () => '3'),
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => []),
      } as never,
      {} as never,
      {
        createTask: createTaskMock,
        addBlocksEntry: vi.fn(async () => undefined),
      } as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
        garbageCollect: vi.fn(async () => undefined),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      (teamName: string) =>
        ({
          tasks: {
            createTask: createTaskMock,
          },
        }) as never
    );

    const result = await service.createTask('my-team', {
      subject: 'Review work task',
      related: ['1', '2'],
    });

    expect(result.related).toEqual(['1', '2']);
    expect(createTaskMock).toHaveBeenCalledWith(expect.objectContaining({ related: ['1', '2'] }));
  });

  it('routes durable inbox writes through controller message API', async () => {
    const sendMessageMock = vi.fn(() => ({ deliveredToInbox: true, messageId: 'm-1' }));

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], leadSessionId: 'lead-1' })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          messages: {
            sendMessage: sendMessageMock,
          },
        }) as never
    );

    const result = await service.sendMessage('my-team', {
      member: 'alice',
      text: 'hello',
      summary: 'ping',
    });

    expect(result).toEqual({ deliveredToInbox: true, messageId: 'm-1' });
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        member: 'alice',
        text: 'hello',
        summary: 'ping',
        leadSessionId: 'lead-1',
      })
    );
  });

  it('delegates review entry to controller review API', async () => {
    const requestReviewMock = vi.fn();

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'lead', role: 'team lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          review: {
            requestReview: requestReviewMock,
          },
        }) as never
    );

    await service.requestReview('my-team', 'task-1');

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      leadSessionId: 'lead-1',
    });
  });

  it('propagates leadSessionId for kanban-driven review transitions', async () => {
    const requestReviewMock = vi.fn();
    const approveReviewMock = vi.fn();
    const requestChangesMock = vi.fn();

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'lead', role: 'team lead' }],
          leadSessionId: 'lead-2',
        })),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      () =>
        ({
          review: {
            requestReview: requestReviewMock,
            approveReview: approveReviewMock,
            requestChanges: requestChangesMock,
          },
        }) as never
    );

    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'review' });
    await service.updateKanban('my-team', 'task-1', { op: 'set_column', column: 'approved' });
    await service.updateKanban('my-team', 'task-1', { op: 'request_changes', comment: 'Needs fixes' });

    expect(requestReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      leadSessionId: 'lead-2',
    });
    expect(approveReviewMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      note: 'Approved from kanban',
      'notify-owner': true,
      leadSessionId: 'lead-2',
    });
    expect(requestChangesMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      comment: 'Needs fixes',
      leadSessionId: 'lead-2',
    });
  });
});
