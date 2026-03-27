import { describe, expect, it, vi } from 'vitest';

import { buildTaskChangePresenceDescriptor } from '../../../../src/main/services/team/taskChangePresenceUtils';
import { TeamDataService } from '../../../../src/main/services/team/TeamDataService';

import type { TeamTask } from '../../../../src/shared/types/team';

const TASK_COMMENT_FORWARDING_ENV = 'CLAUDE_TEAM_TASK_COMMENT_FORWARDING';

function createForwardingJournalStore(initialEntries: Array<Record<string, unknown>> = []) {
  const journalEntries = initialEntries;
  const journal = {
    exists: vi.fn(async () => true),
    ensureFile: vi.fn(async () => undefined),
    withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
      const outcome = await fn(journalEntries);
      return outcome.result;
    }),
  };

  return { journalEntries, journal };
}

function createTaskCommentForwardingService(options: {
  tasks: TeamTask[];
  inboxWriter?: { sendMessage: ReturnType<typeof vi.fn> };
  inboxMessagesForLead?: Array<Record<string, unknown>>;
  journal?: {
    exists: ReturnType<typeof vi.fn>;
    ensureFile: ReturnType<typeof vi.fn>;
    withEntries: ReturnType<typeof vi.fn>;
  };
  members?: Array<{ name: string; role?: string }>;
}) {
  const inboxWriter = options.inboxWriter ?? { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })) };
  const journal = options.journal ?? createForwardingJournalStore().journal;

  const service = new TeamDataService(
    {
      listTeams: vi.fn(),
      getConfig: vi.fn(async () => ({
        name: 'My team',
        members: options.members ?? [{ name: 'team-lead', role: 'Lead' }],
        leadSessionId: 'lead-1',
      })),
    } as never,
    {
      getTasks: vi.fn(async () => options.tasks),
    } as never,
    {
      listInboxNames: vi.fn(async () => []),
      getMessages: vi.fn(async () => []),
      getMessagesFor: vi.fn(async () => options.inboxMessagesForLead ?? []),
    } as never,
    inboxWriter as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    (() => ({}) as never) as never,
    journal as never
  );

  return { service, inboxWriter, journal };
}

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

  it('starts and stops task change presence tracking outside getTeamData', async () => {
    const ensureTracking = vi.fn(async () => ({
      projectFingerprint: 'project-fingerprint',
      logSourceGeneration: 'generation-1',
    }));
    const stopTracking = vi.fn(async () => undefined);

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
      } as never
    );

    service.setTaskChangePresenceServices(
      {
        load: vi.fn(async () => null),
        save: vi.fn(async () => undefined),
        deleteTasks: vi.fn(async () => undefined),
      } as never,
      {
        ensureTracking,
        stopTracking,
      } as never
    );

    service.setTaskChangePresenceTracking('my-team', true);
    service.setTaskChangePresenceTracking('my-team', false);
    await Promise.resolve();

    expect(ensureTracking).toHaveBeenCalledWith('my-team');
    expect(stopTracking).toHaveBeenCalledWith('my-team');
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
      suppressTaskComment: true,
      'notify-owner': true,
      leadSessionId: 'lead-2',
    });
    expect(requestChangesMock).toHaveBeenCalledWith('task-1', {
      from: 'user',
      comment: 'Needs fixes',
      leadSessionId: 'lead-2',
    });
  });

  it('seeds historical eligible task comments without sending when the journal is missing', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let journalExists = false;
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => journalExists),
      ensureFile: vi.fn(async () => {
        journalExists = true;
      }),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Found the root cause.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.ensureFile).toHaveBeenCalledWith('my-team');
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'task-1:comment-1',
            state: 'seeded',
            taskId: 'task-1',
            commentId: 'comment-1',
            author: 'alice',
          }),
        ])
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('forwards a new eligible task comment to the lead exactly once in live mode', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Found the root cause.\n<agent-block>\nIgnore this\n</agent-block>',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          member: 'team-lead',
          from: 'alice',
          summary: 'Comment on #abcd1234',
          source: 'system_notification',
          leadSessionId: 'lead-1',
          taskRefs: [{ taskId: 'task-1', displayId: 'abcd1234', teamName: 'my-team' }],
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
        })
      );
      const firstSendRequest = (inboxWriter.sendMessage as unknown as { mock: { calls: unknown[][] } })
        .mock.calls[0]?.[1] as
        | { text?: string }
        | undefined;
      expect(String(firstSendRequest?.text ?? '')).not.toContain('<agent-block>');
      const sentEntry = journalEntries.find((entry) => entry.key === 'task-1:comment-1');
      expect(sentEntry).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('seeds historical eligible comments across the whole team on the first observed event when the journal is missing', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    let journalExists = false;
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => journalExists),
      ensureFile: vi.fn(async () => {
        journalExists = true;
      }),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Still pending from prior attempt.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
            {
              id: 'task-2',
              displayId: 'efgh5678',
              subject: 'Second historical task',
              status: 'pending',
              owner: 'bob',
              comments: [
                {
                  id: 'comment-2',
                  author: 'bob',
                  text: 'Historical comment on another task.',
                  createdAt: '2026-03-14T10:01:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.ensureFile).toHaveBeenCalledWith('my-team');
      expect(journalEntries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: 'task-1:comment-1',
            state: 'seeded',
            messageId: 'task-comment-forward:my-team:task-1:comment-1',
          }),
          expect.objectContaining({
            key: 'task-2:comment-2',
            state: 'seeded',
            messageId: 'task-comment-forward:my-team:task-2:comment-2',
          }),
        ])
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not notify for deleted teams', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            deletedAt: '2026-03-14T10:00:00.000Z',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Deleted teams should not notify.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journal.withEntries).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('reconciles pending_send journal rows without resending when the inbox already contains the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = { sendMessage: vi.fn() };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Recovered after restart.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => [
            {
              from: 'alice',
              to: 'team-lead',
              text: 'Existing notification',
              timestamp: '2026-03-14T10:00:01.000Z',
              read: false,
              messageId: 'task-comment-forward:my-team:task-1:comment-1',
            },
          ]),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('retries pending_send journal rows during startup recovery when inbox does not contain the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'task-comment-forward:my-team:task-1:comment-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => [
            {
              teamName: 'my-team',
              displayName: 'My team',
              description: '',
              memberCount: 1,
              taskCount: 1,
              lastActivity: null,
            },
          ]),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Recovered after restart and resend.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.initializeTaskCommentNotificationState();

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('retries pending_send rows on later task changes when the inbox does not contain the message', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({
        deliveredToInbox: true,
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Retry on later task change.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not duplicate later-task-change recovery while a send is already in flight', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [
      {
        key: 'task-1:comment-1',
        taskId: 'task-1',
        commentId: 'comment-1',
        author: 'alice',
        messageId: 'task-comment-forward:my-team:task-1:comment-1',
        state: 'pending_send',
        createdAt: '2026-03-14T10:00:00.000Z',
        updatedAt: '2026-03-14T10:00:00.000Z',
      },
    ];
    let releaseSend: (() => void) | undefined;
    let resolveSendStarted: (() => void) | undefined;
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendStarted = new Promise<void>((resolve) => {
      resolveSendStarted = resolve;
    });
    const inboxWriter = {
      sendMessage: vi.fn(async () => {
        resolveSendStarted?.();
        await sendGate;
        return {
          deliveredToInbox: true,
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
        };
      }),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'Concurrent retry protection.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      const first = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');
      const second = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      await sendStarted;
      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);

      if (!releaseSend) {
        throw new Error('Expected send release');
      }
      releaseSend();

      await first;
      await second;

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(journalEntries[0]).toMatchObject({
        state: 'sent',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('forwards eligible teammate comments even when the commenter is not the current task owner', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    const journalEntries: Array<Record<string, unknown>> = [];
    const inboxWriter = {
      sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })),
    };
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
            leadSessionId: 'lead-1',
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-2',
                  author: 'bob',
                  text: 'Independent research result from another teammate.',
                  createdAt: '2026-03-14T10:05:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
      expect(inboxWriter.sendMessage).toHaveBeenCalledWith(
        'my-team',
        expect.objectContaining({
          from: 'bob',
          summary: 'Comment on #abcd1234',
          messageId: 'task-comment-forward:my-team:task-1:comment-2',
        })
      );
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not forward user-authored, lead-authored, mirrored, or non-regular comments', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore();
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Investigate',
            status: 'pending',
            owner: 'alice',
            comments: [
              {
                id: 'comment-user',
                author: 'user',
                text: 'User comment should not notify.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
              {
                id: 'comment-lead',
                author: 'team-lead',
                text: 'Lead already knows this.',
                createdAt: '2026-03-14T10:01:00.000Z',
                type: 'regular',
              },
              {
                id: 'msg-legacy',
                author: 'alice',
                text: 'Mirrored inbox artifact.',
                createdAt: '2026-03-14T10:02:00.000Z',
                type: 'regular',
              },
              {
                id: 'comment-review-request',
                author: 'alice',
                text: 'Please review.',
                createdAt: '2026-03-14T10:03:00.000Z',
                type: 'review_request',
              },
              {
                id: 'comment-review-approved',
                author: 'alice',
                text: 'Approved.',
                createdAt: '2026-03-14T10:04:00.000Z',
                type: 'review_approved',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not forward comments for lead-owned tasks', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore();
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Lead-owned task',
            status: 'pending',
            owner: 'team-lead',
            comments: [
              {
                id: 'comment-1',
                author: 'alice',
                text: 'Should not create a second lead notification.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('does not replay historical comment notifications after lead rename because the journal key is team-level', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';

    try {
      const { journalEntries, journal } = createForwardingJournalStore([
        {
          key: 'task-1:comment-1',
          taskId: 'task-1',
          commentId: 'comment-1',
          author: 'alice',
          messageId: 'task-comment-forward:my-team:task-1:comment-1',
          state: 'sent',
          createdAt: '2026-03-14T10:00:00.000Z',
          updatedAt: '2026-03-14T10:00:00.000Z',
          sentAt: '2026-03-14T10:00:00.000Z',
        },
      ]);
      const { service, inboxWriter } = createTaskCommentForwardingService({
        journal,
        members: [{ name: 'new-lead', role: 'Lead' }],
        tasks: [
          {
            id: 'task-1',
            displayId: 'abcd1234',
            subject: 'Investigate',
            status: 'pending',
            owner: 'alice',
            comments: [
              {
                id: 'comment-1',
                author: 'alice',
                text: 'Already forwarded before lead rename.',
                createdAt: '2026-03-14T10:00:00.000Z',
                type: 'regular',
              },
            ],
          },
        ],
      });

      await service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();
      expect(journalEntries).toHaveLength(1);
      expect(journalEntries[0]).toMatchObject({
        key: 'task-1:comment-1',
        state: 'sent',
      });
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('waits for startup initialization before processing watcher-driven comment notifications', async () => {
    const previous = process.env[TASK_COMMENT_FORWARDING_ENV];
    process.env[TASK_COMMENT_FORWARDING_ENV] = 'on';
    let releaseInit: (() => void) | undefined;
    const initGate = new Promise<void>((resolve) => {
      releaseInit = () => resolve();
    });
    const inboxWriter = { sendMessage: vi.fn(async () => ({ deliveredToInbox: true, messageId: 'msg-1' })) };
    const journalEntries: Array<Record<string, unknown>> = [];
    const journal = {
      exists: vi.fn(async () => true),
      ensureFile: vi.fn(async () => undefined),
      withEntries: vi.fn(async (_teamName: string, fn: (entries: unknown[]) => Promise<{ result: unknown }>) => {
        const outcome = await fn(journalEntries);
        return outcome.result;
      }),
    };

    try {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(async () => {
            await initGate;
            return [
              {
                teamName: 'my-team',
                displayName: 'My team',
                description: '',
                memberCount: 1,
                taskCount: 1,
                lastActivity: null,
              },
            ];
          }),
          getConfig: vi.fn(async () => ({
            name: 'My team',
            members: [{ name: 'team-lead', role: 'Lead' }],
          })),
        } as never,
        {
          getTasks: vi.fn(async () => [
            {
              id: 'task-1',
              displayId: 'abcd1234',
              subject: 'Investigate',
              status: 'pending',
              owner: 'alice',
              comments: [
                {
                  id: 'comment-1',
                  author: 'alice',
                  text: 'New comment after startup barrier.',
                  createdAt: '2026-03-14T10:00:00.000Z',
                  type: 'regular',
                },
              ],
            },
          ]),
        } as never,
        {
          listInboxNames: vi.fn(async () => []),
          getMessages: vi.fn(async () => []),
          getMessagesFor: vi.fn(async () => []),
        } as never,
        inboxWriter as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        (() => ({}) as never) as never,
        journal as never
      );

      const initPromise = service.initializeTaskCommentNotificationState();
      const notifyPromise = service.notifyLeadOnTeammateTaskComment('my-team', 'task-1');

      await Promise.resolve();
      expect(inboxWriter.sendMessage).not.toHaveBeenCalled();

      if (!releaseInit) {
        throw new Error('Expected initialization gate release');
      }
      releaseInit();
      await initPromise;
      await notifyPromise;

      expect(inboxWriter.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      if (previous === undefined) delete process.env[TASK_COMMENT_FORWARDING_ENV];
      else process.env[TASK_COMMENT_FORWARDING_ENV] = previous;
    }
  });

  it('returns unknown changePresence when no cached presence entry exists', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
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
      } as never
    );

    const load = vi.fn(async () => null);

    service.setTaskChangePresenceServices(
      {
        load,
        upsertEntry: vi.fn(async () => undefined),
      } as never,
      {
        ensureTracking: vi.fn(async () => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const data = await service.getTeamData('my-team');

    expect(data.tasks[0]?.changePresence).toBe('unknown');
    expect(load).not.toHaveBeenCalled();
  });

  it('returns cached changePresence only when signature and generation still match', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };
    const descriptor = buildTaskChangePresenceDescriptor({
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      historyEvents: task.historyEvents,
      reviewState: 'none',
    });

    const createServiceWithPresence = (
      load: ReturnType<typeof vi.fn>,
      trackerSnapshot: { projectFingerprint: string; logSourceGeneration: string } | null
    ) => {
      const service = new TeamDataService(
        {
          listTeams: vi.fn(),
          getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
        } as never,
        {
          getTasks: vi.fn(async () => [task]),
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
        } as never
      );

      service.setTaskChangePresenceServices(
        {
          load,
          upsertEntry: vi.fn(async () => undefined),
        } as never,
        {
          getSnapshot: vi.fn(() => trackerSnapshot),
          ensureTracking: vi.fn(async () => trackerSnapshot),
        } as never
      );

      return service;
    };

    const matched = await createServiceWithPresence(
      vi.fn(async () => ({
        version: 1,
        teamName: 'my-team',
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
        writtenAt: '2026-03-01T12:00:00.000Z',
        entries: {
          'task-1': {
            taskId: 'task-1',
            taskSignature: descriptor.taskSignature,
            presence: 'has_changes',
            writtenAt: '2026-03-01T12:00:00.000Z',
            logSourceGeneration: 'log-generation',
          },
        },
      })),
      {
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }
    ).getTeamData('my-team');
    expect(matched.tasks[0]?.changePresence).toBe('has_changes');

    const mismatched = await createServiceWithPresence(
      vi.fn(async () => ({
        version: 1,
        teamName: 'my-team',
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'stale-generation',
        writtenAt: '2026-03-01T12:00:00.000Z',
        entries: {
          'task-1': {
            taskId: 'task-1',
            taskSignature: descriptor.taskSignature,
            presence: 'has_changes',
            writtenAt: '2026-03-01T12:00:00.000Z',
            logSourceGeneration: 'stale-generation',
          },
        },
      })),
      {
        projectFingerprint: 'project-fingerprint',
        logSourceGeneration: 'log-generation',
      }
    ).getTeamData('my-team');
    expect(mismatched.tasks[0]?.changePresence).toBe('unknown');
  });

  it('returns lightweight task change presence without loading full team data', async () => {
    const task: TeamTask = {
      id: 'task-1',
      subject: 'Review API',
      status: 'completed',
      owner: 'alice',
      workIntervals: [{ startedAt: '2026-03-01T10:05:00.000Z' }],
      historyEvents: [],
    };
    const descriptor = buildTaskChangePresenceDescriptor({
      owner: task.owner,
      status: task.status,
      intervals: task.workIntervals,
      historyEvents: task.historyEvents,
      reviewState: 'none',
    });
    const getMessages = vi.fn(async () => []);

    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({ name: 'My team', members: [], projectPath: '/repo' })),
      } as never,
      {
        getTasks: vi.fn(async () => [task]),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages,
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never
    );

    service.setTaskChangePresenceServices(
      {
        load: vi.fn(async () => ({
          version: 1,
          teamName: 'my-team',
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
          writtenAt: '2026-03-01T12:00:00.000Z',
          entries: {
            'task-1': {
              taskId: 'task-1',
              taskSignature: descriptor.taskSignature,
              presence: 'has_changes',
              writtenAt: '2026-03-01T12:00:00.000Z',
              logSourceGeneration: 'log-generation',
            },
          },
        })),
        upsertEntry: vi.fn(async () => undefined),
      } as never,
      {
        getSnapshot: vi.fn(() => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
        ensureTracking: vi.fn(async () => ({
          projectFingerprint: 'project-fingerprint',
          logSourceGeneration: 'log-generation',
        })),
      } as never
    );

    const data = await service.getTaskChangePresence('my-team');

    expect(data).toEqual({ 'task-1': 'has_changes' });
    expect(getMessages).not.toHaveBeenCalled();
  });

  it('persists standalone slash metadata when sending directly to the live lead', async () => {
    const appendSentMessage = vi.fn((payload) => payload);
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
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
          messages: {
            appendSentMessage,
          },
        }) as never
    );

    const result = await service.sendDirectToLead(
      'my-team',
      'team-lead',
      '/compact keep only kanban context'
    );

    expect(result.deliveredViaStdin).toBe(true);
    expect(appendSentMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: '/compact keep only kanban context',
        messageKind: 'slash_command',
        slashCommand: expect.objectContaining({
          name: 'compact',
          command: '/compact',
          args: 'keep only kanban context',
        }),
      })
    );
  });

  it('annotates immediate lead replies after slash commands as command results', async () => {
    const service = new TeamDataService(
      {
        listTeams: vi.fn(),
        getConfig: vi.fn(async () => ({
          name: 'My team',
          members: [{ name: 'team-lead', role: 'Lead' }],
          leadSessionId: 'lead-1',
        })),
      } as never,
      {
        getTasks: vi.fn(async () => []),
      } as never,
      {
        listInboxNames: vi.fn(async () => []),
        getMessages: vi.fn(async () => [
          {
            from: 'team-lead',
            text: 'Total cost: $1.05',
            timestamp: '2026-03-27T22:17:01.000Z',
            read: true,
            source: 'lead_process',
            leadSessionId: 'lead-1',
            messageId: 'lead-thought-1',
          },
        ]),
      } as never,
      {} as never,
      {} as never,
      {
        resolveMembers: vi.fn(() => []),
      } as never,
      {
        getState: vi.fn(async () => ({ teamName: 'my-team', reviewers: [], tasks: {} })),
      } as never,
      {} as never,
      {} as never,
      {
        readMessages: vi.fn(async () => [
          {
            from: 'user',
            to: 'team-lead',
            text: '/cost',
            timestamp: '2026-03-27T22:17:00.000Z',
            read: true,
            source: 'user_sent',
            leadSessionId: 'lead-1',
            messageId: 'user-cost-1',
          },
        ]),
      } as never
    );

    const data = await service.getTeamData('my-team');
    const costResult = data.messages.find((message) => message.messageId === 'lead-thought-1');

    expect(costResult).toMatchObject({
      messageKind: 'slash_command_result',
      commandOutput: {
        stream: 'stdout',
        commandLabel: '/cost',
      },
    });
  });
});
