import {
  type TeamTaskStartBoardPort,
  TeamTaskStartCoordinator,
  type TeamTaskStartCoordinatorPorts,
} from '@features/team-task-board/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateTaskRequest,
  SendMessageRequest,
  TaskHistoryEvent,
  TeamTask,
} from '../../../../src/shared/types/team';

function createTask(overrides: Partial<TeamTask> = {}): TeamTask {
  return {
    id: 'task-1',
    displayId: 'task0001',
    subject: 'Build the task-start lane',
    status: 'pending',
    ...overrides,
  };
}

function startedEvent(timestamp: string, actor = 'alice'): TaskHistoryEvent {
  return {
    id: `status-started-${timestamp}-${actor}`,
    type: 'status_changed',
    from: 'pending',
    to: 'in_progress',
    timestamp,
    actor,
  };
}

function createHarness(
  options: {
    tasks?: TeamTask[];
    createdTask?: TeamTask;
    projectPath?: string;
    leadName?: string;
    runCreateTaskCommand?: TeamTaskStartCoordinatorPorts['runCreateTaskCommand'];
    sendMessage?: TeamTaskStartCoordinatorPorts['sendMessage'];
    sendRuntimeRecipientMessage?: TeamTaskStartCoordinatorPorts['sendRuntimeRecipientMessage'];
  } = {}
) {
  const tasks = options.tasks ?? [createTask()];
  const createTaskMutation = vi.fn((input: Record<string, unknown>) => ({
    ...input,
    id: options.createdTask?.id ?? 'created-task',
    displayId: options.createdTask?.displayId,
    status: options.createdTask?.status ?? 'pending',
    ...(options.createdTask ?? {}),
  }));
  const startTaskMutation = vi.fn();
  const board: TeamTaskStartBoardPort = {
    getTask: vi.fn((taskId: string) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return task;
    }),
    listTasks: vi.fn(() => tasks),
    listDeletedTasks: vi.fn(() => []),
    createTask: createTaskMutation,
    reconcileTaskCreation: vi.fn((input: Record<string, unknown>) => input),
    startTask: startTaskMutation,
  };
  const invalidateTaskProjection = vi.fn();
  const sendMessage =
    options.sendMessage ?? vi.fn(async (_teamName: string, _request: SendMessageRequest) => ({}));
  const sendRuntimeRecipientMessage =
    options.sendRuntimeRecipientMessage ??
    vi.fn(async (_teamName: string, _request: SendMessageRequest) => ({}));
  const warn = vi.fn();
  const runCreateTaskCommand =
    options.runCreateTaskCommand ??
    vi.fn(async (command) => {
      const task = await command.destination.create({
        ...command.payload,
        id: command.identity.commandId,
      });
      return {
        task,
        outcome: 'executed',
        createdInAttempt: true,
      } as never;
    });
  const ports: TeamTaskStartCoordinatorPorts = {
    getTaskBoard: vi.fn(() => board),
    readTasks: vi.fn(async () => tasks),
    readTaskCreateProjectPath: vi.fn(async () => options.projectPath),
    runCreateTaskCommand,
    invalidateTaskProjection,
    resolveLeadName: vi.fn(async () => options.leadName ?? 'team-lead'),
    sendMessage,
    sendRuntimeRecipientMessage,
    warn,
  };

  return {
    coordinator: new TeamTaskStartCoordinator(ports),
    ports,
    board,
    createTaskMutation,
    startTaskMutation,
    invalidateTaskProjection,
    sendMessage,
    sendRuntimeRecipientMessage,
    warn,
    runCreateTaskCommand,
  };
}

describe('TeamTaskStartCoordinator task creation', () => {
  it('normalizes durable intent while preserving task context and derived project path', async () => {
    const descriptionTaskRefs = [
      { teamName: 'my-team', taskId: 'context-task', displayId: 'context1' },
    ];
    const promptTaskRefs = [{ teamName: 'my-team', taskId: 'prompt-task', displayId: 'prompt01' }];
    const harness = createHarness({
      projectPath: '/sandbox/project',
      createdTask: createTask({
        id: '11111111-1111-4111-8111-111111111111',
        status: 'in_progress',
        owner: 'alice',
      }),
    });
    const request: CreateTaskRequest = {
      command: {
        commandId: '11111111-1111-4111-8111-111111111111',
        idempotencyKey: 'task-create-intent',
      },
      subject: 'Durable task',
      description: '  Full description.  ',
      descriptionTaskRefs,
      owner: 'alice',
      blockedBy: ['task-b', '', 'task-a', 'task-b'],
      related: ['task-d', 'task-c', 'task-d', ''],
      prompt: '  Follow the prompt.  ',
      promptTaskRefs,
      startImmediately: true,
    };

    const outcome = await harness.coordinator.createTaskWithOutcome('my-team', request);

    expect(outcome).toMatchObject({
      task: { id: request.command?.commandId, status: 'in_progress' },
      createdInAttempt: true,
    });
    expect(harness.runCreateTaskCommand).toHaveBeenCalledOnce();
    const command = vi.mocked(harness.runCreateTaskCommand).mock.calls[0]?.[0];
    expect(command).toMatchObject({
      teamName: 'my-team',
      identity: request.command,
      payload: {
        subject: request.subject,
        description: 'Full description.',
        descriptionTaskRefs,
        owner: 'alice',
        blockedBy: ['task-a', 'task-b'],
        related: ['task-c', 'task-d'],
        createdBy: 'user',
        prompt: 'Follow the prompt.',
        promptTaskRefs,
        startImmediately: true,
      },
    });
    expect(command?.payload).not.toHaveProperty('projectPath');
    expect(harness.createTaskMutation).toHaveBeenCalledOnce();
    expect(harness.createTaskMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        projectPath: '/sandbox/project',
        descriptionTaskRefs,
        promptTaskRefs,
      })
    );
    expect(harness.invalidateTaskProjection).toHaveBeenCalledOnce();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.sendRuntimeRecipientMessage).not.toHaveBeenCalled();
  });

  it('returns replay createdInAttempt and repairs lead delivery without another board mutation', async () => {
    const replayedTask = createTask({
      id: '22222222-2222-4222-8222-222222222222',
      displayId: '22222222',
      owner: 'lead-agent',
      status: 'in_progress',
      description: 'Resolved description.',
      prompt: 'Resolved prompt.',
      descriptionTaskRefs: [{ teamName: 'my-team', taskId: 'context-task', displayId: 'context1' }],
    });
    const runCreateTaskCommand = vi.fn(async () => ({
      task: replayedTask,
      outcome: 'replayed',
      createdInAttempt: false,
    })) as never;
    const harness = createHarness({
      leadName: 'lead-agent',
      runCreateTaskCommand,
    });
    const request: CreateTaskRequest = {
      command: {
        commandId: replayedTask.id,
        idempotencyKey: 'replayed-task',
      },
      subject: replayedTask.subject,
      owner: replayedTask.owner,
      startImmediately: true,
    };

    const first = await harness.coordinator.createTaskWithOutcome('my-team', request);
    const second = await harness.coordinator.createTaskWithOutcome('my-team', request);

    expect(first).toEqual({ task: replayedTask, createdInAttempt: false });
    expect(second).toEqual(first);
    expect(harness.createTaskMutation).not.toHaveBeenCalled();
    expect(harness.invalidateTaskProjection).toHaveBeenCalledTimes(2);
    expect(harness.sendRuntimeRecipientMessage).toHaveBeenCalledTimes(2);
    for (const [, notification] of vi.mocked(harness.sendRuntimeRecipientMessage).mock.calls) {
      expect(notification).toMatchObject({
        member: 'lead-agent',
        from: 'user',
        messageId: `task-start:my-team:${replayedTask.id}`,
        taskRefs: replayedTask.descriptionTaskRefs,
        summary: 'Start working on #22222222',
        source: 'system_notification',
      });
      expect(notification.text).toContain('Details:\nResolved description.');
      expect(notification.text).toContain('Instructions:\nResolved prompt.');
      expect(notification.text).toContain(
        'This start notification can become stale after reassignment or completion.'
      );
      expect(notification.text).toContain(
        `task_get { teamName: "my-team", taskId: "${replayedTask.id}" }`
      );
      expect(notification.text).toContain(
        `task_complete { teamName: "my-team", taskId: "${replayedTask.id}", actor: "lead-agent" }`
      );
    }
  });

  it('does not invalidate or notify when durable persistence fails before commit', async () => {
    const persistenceFailure = new Error('persistence failed');
    const harness = createHarness({
      runCreateTaskCommand: vi.fn(async () => {
        throw persistenceFailure;
      }),
    });

    await expect(
      harness.coordinator.createTask('my-team', {
        command: {
          commandId: '33333333-3333-4333-8333-333333333333',
          idempotencyKey: 'failed-task',
        },
        subject: 'Failed task',
      })
    ).rejects.toBe(persistenceFailure);

    expect(harness.createTaskMutation).not.toHaveBeenCalled();
    expect(harness.invalidateTaskProjection).not.toHaveBeenCalled();
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.sendRuntimeRecipientMessage).not.toHaveBeenCalled();
  });

  it('preserves the durable-command availability error before invoking the command facade', async () => {
    const harness = createHarness();
    delete harness.board.getTask;

    await expect(
      harness.coordinator.createTask('my-team', {
        command: {
          commandId: '33333333-3333-4333-8333-333333333334',
          idempotencyKey: 'unavailable-task-board',
        },
        subject: 'Unavailable durable task',
      })
    ).rejects.toThrow('Durable task-board commands are unavailable');

    expect(harness.runCreateTaskCommand).not.toHaveBeenCalled();
    expect(harness.createTaskMutation).not.toHaveBeenCalled();
    expect(harness.invalidateTaskProjection).not.toHaveBeenCalled();
  });

  it('keeps a durable post-commit delivery failure nonfatal and logs only safe identifiers', async () => {
    const startedTask = createTask({
      id: '44444444-4444-4444-8444-444444444444',
      owner: 'lead-agent',
      status: 'in_progress',
    });
    const sendRuntimeRecipientMessage = vi.fn(async () => {
      throw new Error('/private/sensitive-delivery-payload');
    });
    const harness = createHarness({
      createdTask: startedTask,
      leadName: 'lead-agent',
      sendRuntimeRecipientMessage,
    });

    await expect(
      harness.coordinator.createTask('my-team', {
        command: {
          commandId: startedTask.id,
          idempotencyKey: 'post-commit-failure',
        },
        subject: startedTask.subject,
        owner: startedTask.owner,
        startImmediately: true,
      })
    ).resolves.toEqual(expect.objectContaining({ id: startedTask.id }));

    expect(harness.invalidateTaskProjection).toHaveBeenCalledOnce();
    expect(harness.warn).toHaveBeenCalledWith(
      `[TeamDataService] category=post_commit_notification code=task_start_notification_failed team=my-team task=${startedTask.id}`
    );
    expect(harness.warn.mock.calls.flat().join('\n')).not.toContain('sensitive-delivery-payload');
  });

  it('uses one direct board create and keeps a non-durable lead notification best-effort', async () => {
    const startedTask = createTask({
      id: 'legacy-task',
      owner: 'team-lead',
      status: 'in_progress',
    });
    const sendMessage = vi.fn(async () => {
      throw new Error('inbox unavailable');
    });
    const harness = createHarness({ createdTask: startedTask, sendMessage });

    await expect(
      harness.coordinator.createTask('my-team', {
        subject: startedTask.subject,
        owner: startedTask.owner,
        startImmediately: true,
      })
    ).resolves.toEqual(expect.objectContaining({ id: startedTask.id }));

    expect(harness.runCreateTaskCommand).not.toHaveBeenCalled();
    expect(harness.createTaskMutation).toHaveBeenCalledOnce();
    expect(harness.invalidateTaskProjection).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.sendRuntimeRecipientMessage).not.toHaveBeenCalled();
  });
});

describe('TeamTaskStartCoordinator explicit starts', () => {
  it('keeps legacy start lead-skip behavior after exactly one validated mutation', async () => {
    const harness = createHarness({
      tasks: [createTask({ owner: 'team-lead' })],
    });

    await expect(harness.coordinator.startTask('my-team', 'task-1')).resolves.toEqual({
      notifiedOwner: true,
    });

    expect(harness.startTaskMutation).toHaveBeenCalledOnce();
    expect(harness.startTaskMutation).toHaveBeenCalledWith('task-1', 'user');
    expect(harness.invalidateTaskProjection).toHaveBeenCalledOnce();
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the legacy non-lead notification text, source, summary, and refs', async () => {
    const task = createTask({
      owner: 'alice',
      description: 'Implementation details.',
      prompt: 'Prompt reserved for the user-start path.',
      descriptionTaskRefs: [{ teamName: 'my-team', taskId: 'related-task', displayId: 'related1' }],
    });
    const harness = createHarness({ tasks: [task], leadName: 'lead-agent' });

    await harness.coordinator.startTask('my-team', task.id);

    expect(harness.sendMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        member: 'alice',
        from: 'lead-agent',
        taskRefs: task.descriptionTaskRefs,
        summary: 'Start working on #task0001',
        source: 'system_notification',
      })
    );
    const notification = vi.mocked(harness.sendMessage).mock.calls[0]?.[1];
    expect(notification?.text).toContain('Details:\nImplementation details.');
    expect(notification?.text).toContain(
      'task_complete { teamName: "my-team", taskId: "task-1", actor: "alice" }'
    );
    expect(notification?.text).toContain(
      '\n\n<info_for_agent>\nBegin work on this task immediately.'
    );
    expect(notification?.text).toMatch(/<\/info_for_agent>$/);
    expect(notification?.text).not.toContain('Prompt reserved for the user-start path.');
    expect(notification?.text).not.toContain('task_get');
  });

  it('always notifies a lead owner on the user-start path with stale-owner guards', async () => {
    const task = createTask({
      owner: 'lead-agent',
      description: 'Full description.',
      prompt: 'Full prompt.',
      descriptionTaskRefs: [{ teamName: 'my-team', taskId: 'related-task', displayId: 'related1' }],
    });
    const harness = createHarness({ tasks: [task], leadName: 'lead-agent' });

    await expect(harness.coordinator.startTaskByUser('my-team', task.id)).resolves.toEqual({
      notifiedOwner: true,
    });

    expect(harness.startTaskMutation).toHaveBeenCalledOnce();
    expect(harness.invalidateTaskProjection).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        member: 'lead-agent',
        from: 'user',
        taskRefs: task.descriptionTaskRefs,
        summary: 'Start working on #task0001',
        source: 'system_notification',
      })
    );
    const notification = vi.mocked(harness.sendMessage).mock.calls[0]?.[1];
    expect(notification?.text).toContain('Details:\nFull description.');
    expect(notification?.text).toContain('Instructions:\nFull prompt.');
    expect(notification?.text).toContain(
      'verify that task.owner is your configured teammate name and task.status is pending or in_progress'
    );
    expect(notification?.text).toContain(
      'If the owner changed or the task is completed/deleted, do not start or reopen it'
    );
    expect(notification?.text).toContain('task_get { teamName: "my-team", taskId: "task-1" }');
    expect(notification?.text).toContain(
      'task_complete { teamName: "my-team", taskId: "task-1", actor: "lead-agent" }'
    );
    expect(notification?.text).toContain(
      '\n\n<info_for_agent>\nThis start notification can become stale'
    );
    expect(notification?.text).toMatch(/<\/info_for_agent>$/);
  });

  it('starts and invalidates the board before sending the user-start notification', async () => {
    const harness = createHarness({
      tasks: [createTask({ owner: 'alice' })],
      leadName: 'lead-agent',
    });

    await harness.coordinator.startTaskByUser('my-team', 'task-1');

    const startOrder = harness.startTaskMutation.mock.invocationCallOrder[0];
    const invalidationOrder = harness.invalidateTaskProjection.mock.invocationCallOrder[0];
    const notificationOrder = vi.mocked(harness.sendMessage).mock.invocationCallOrder[0];
    expect(startOrder).toBeLessThan(invalidationOrder!);
    expect(invalidationOrder).toBeLessThan(notificationOrder!);
  });

  it.each(['startTask', 'startTaskByUser'] as const)(
    'propagates the board error from %s without invalidating or notifying',
    async (methodName) => {
      const boardFailure = new Error('task start failed');
      const harness = createHarness({
        tasks: [createTask({ owner: 'alice' })],
      });
      harness.startTaskMutation.mockImplementationOnce(() => {
        throw boardFailure;
      });

      await expect(harness.coordinator[methodName]('my-team', 'task-1')).rejects.toBe(boardFailure);

      expect(harness.invalidateTaskProjection).not.toHaveBeenCalled();
      expect(harness.sendMessage).not.toHaveBeenCalled();
    }
  );

  it.each([
    {
      name: 'missing',
      tasks: [] as TeamTask[],
      error: 'Task #task-1 not found',
    },
    {
      name: 'not pending',
      tasks: [createTask({ status: 'completed' })],
      error: 'Task #task-1 is not pending (current: completed)',
    },
  ])(
    'rejects a $name task before either start path mutates the board',
    async ({ tasks, error }) => {
      const harness = createHarness({ tasks });

      await expect(harness.coordinator.startTask('my-team', 'task-1')).rejects.toThrow(error);
      await expect(harness.coordinator.startTaskByUser('my-team', 'task-1')).rejects.toThrow(error);
      expect(harness.startTaskMutation).not.toHaveBeenCalled();
      expect(harness.invalidateTaskProjection).not.toHaveBeenCalled();
      expect(harness.sendMessage).not.toHaveBeenCalled();
    }
  );
});

describe('TeamTaskStartCoordinator watcher notifications', () => {
  it('uses only the newest non-user in-progress transition and skips the lead', async () => {
    const olderStart = startedEvent('2026-07-29T10:00:00.000Z');
    const followedByOwnerChange: TaskHistoryEvent = {
      id: 'owner-change-1',
      type: 'owner_changed',
      from: 'alice',
      to: 'bob',
      timestamp: '2026-07-29T10:01:00.000Z',
      actor: 'team-lead',
    };
    const ignored = createHarness({
      tasks: [createTask({ historyEvents: [olderStart, followedByOwnerChange] })],
    });
    await ignored.coordinator.notifyLeadOnTeammateTaskStart('my-team', 'task-1');
    expect(ignored.sendMessage).not.toHaveBeenCalled();

    const leadStart = createHarness({
      tasks: [
        createTask({
          historyEvents: [startedEvent('2026-07-29T10:02:00.000Z', 'team-lead')],
        }),
      ],
    });
    await leadStart.coordinator.notifyLeadOnTeammateTaskStart('my-team', 'task-1');
    expect(leadStart.sendMessage).not.toHaveBeenCalled();
  });

  it('deduplicates by team, task, and transition timestamp', async () => {
    const timestamp = '2026-07-29T11:00:00.000Z';
    const tasksByTeam = new Map<string, TeamTask[]>([
      [
        'team-a',
        [
          createTask({
            id: 'task-a',
            displayId: undefined,
            historyEvents: [startedEvent(timestamp)],
          }),
          createTask({
            id: 'task-b',
            displayId: undefined,
            historyEvents: [startedEvent(timestamp)],
          }),
        ],
      ],
      [
        'team-b',
        [
          createTask({
            id: 'task-a',
            displayId: undefined,
            historyEvents: [startedEvent(timestamp)],
          }),
        ],
      ],
    ]);
    const sendMessage = vi.fn(async () => ({}));
    const coordinator = new TeamTaskStartCoordinator({
      getTaskBoard: vi.fn() as never,
      readTasks: vi.fn(async (teamName) => tasksByTeam.get(teamName) ?? []),
      readTaskCreateProjectPath: vi.fn(),
      runCreateTaskCommand: vi.fn(),
      invalidateTaskProjection: vi.fn(),
      resolveLeadName: vi.fn(async () => 'team-lead'),
      sendMessage,
      sendRuntimeRecipientMessage: vi.fn(),
      warn: vi.fn(),
    });

    await coordinator.notifyLeadOnTeammateTaskStart('team-a', 'task-a');
    await coordinator.notifyLeadOnTeammateTaskStart('team-a', 'task-a');
    await coordinator.notifyLeadOnTeammateTaskStart('team-a', 'task-b');
    await coordinator.notifyLeadOnTeammateTaskStart('team-b', 'task-a');

    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage).toHaveBeenCalledWith(
      'team-a',
      expect.objectContaining({
        member: 'team-lead',
        from: 'alice',
        text: '@alice **started task** #task-a "Build the task-start lane"',
        summary: 'Task #task-a started',
        source: 'system_notification',
      })
    );
  });

  it('caps watcher transition dedupe state at 500 insertion-ordered keys', async () => {
    let timestampIndex = 0;
    const task = createTask({ historyEvents: [startedEvent('transition-0')] });
    const sendMessage = vi.fn(async () => ({}));
    const coordinator = new TeamTaskStartCoordinator({
      getTaskBoard: vi.fn() as never,
      readTasks: vi.fn(async () => {
        task.historyEvents = [startedEvent(`transition-${timestampIndex}`)];
        return [task];
      }),
      readTaskCreateProjectPath: vi.fn(),
      runCreateTaskCommand: vi.fn(),
      invalidateTaskProjection: vi.fn(),
      resolveLeadName: vi.fn(async () => 'team-lead'),
      sendMessage,
      sendRuntimeRecipientMessage: vi.fn(),
      warn: vi.fn(),
    });

    for (timestampIndex = 0; timestampIndex <= 500; timestampIndex += 1) {
      await coordinator.notifyLeadOnTeammateTaskStart('my-team', task.id);
    }
    timestampIndex = 0;
    await coordinator.notifyLeadOnTeammateTaskStart('my-team', task.id);

    expect(sendMessage).toHaveBeenCalledTimes(502);
  });
});
