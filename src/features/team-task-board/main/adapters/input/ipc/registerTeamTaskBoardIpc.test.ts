import {
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_CREATE_TASK,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE_TASK,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
} from '@features/team-task-board/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { registerTeamTaskBoardIpc, removeTeamTaskBoardIpc } from './registerTeamTaskBoardIpc';

import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcResult, TaskAttachmentMeta, TaskComment, TeamTask } from '@shared/types';

const CHANNELS = [
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_CREATE_TASK,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE_TASK,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
] as const;

type RegisteredHandler = (...args: unknown[]) => Promise<IpcResult<unknown>>;

function createDependencies(): TeamTaskBoardIpcDependencies {
  return {
    queries: {
      getTask: vi.fn(async () => null),
      getDeletedTasks: vi.fn(async () => []),
    },
    commands: {
      createTask: vi.fn(async () => ({ id: 'task-1', subject: 'Task' }) as TeamTask),
      requestReview: vi.fn(async () => undefined),
      updateKanban: vi.fn(async () => undefined),
      updateKanbanColumnOrder: vi.fn(async () => undefined),
      updateTaskStatus: vi.fn(async () => undefined),
      updateTaskOwner: vi.fn(async () => undefined),
      startTask: vi.fn(async () => ({ notifiedOwner: true })),
      startTaskByUser: vi.fn(async () => ({ notifiedOwner: true })),
      softDeleteTask: vi.fn(async () => undefined),
      restoreTask: vi.fn(async () => undefined),
      setTaskNeedsClarification: vi.fn(async () => undefined),
      addTaskRelationship: vi.fn(async () => undefined),
      removeTaskRelationship: vi.fn(async () => undefined),
    },
    changePresence: {
      getTaskChangePresence: vi.fn(async () => ({ 'task-1': 'has_changes' as const })),
      setTaskChangePresenceTracking: vi.fn(),
    },
    globalTasks: {
      getAllTasks: vi.fn(async () => []),
    },
    comments: {
      addTaskComment: vi.fn(
        async () =>
          ({
            id: 'comment-1',
            author: 'user',
            text: 'Comment',
            createdAt: '2026-07-22T00:00:00.000Z',
            type: 'regular',
          }) as TaskComment
      ),
    },
    commentAttachments: {
      saveAttachment: vi.fn(
        async (_teamName, _taskId, attachmentId, filename, mimeType) =>
          ({
            id: attachmentId,
            filename,
            mimeType,
            size: 4,
            addedAt: '2026-07-22T00:00:00.000Z',
            filePath: `/tmp/${attachmentId}`,
          }) as TaskAttachmentMeta
      ),
    },
    updateTaskFields: {
      execute: vi.fn(async () => undefined),
    },
    operationTracker: {
      setCurrent: vi.fn(),
    },
    clock: {
      now: vi.fn(() => 100),
    },
    logger: {
      error: vi.fn(),
      warn: vi.fn(),
    },
  };
}

describe('registerTeamTaskBoardIpc', () => {
  const handlers = new Map<string, RegisteredHandler>();
  const ipcMain = {
    handle: vi.fn((channel: string, handler: RegisteredHandler) => handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
  };
  let dependencies: TeamTaskBoardIpcDependencies;

  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    dependencies = createDependencies();
    registerTeamTaskBoardIpc(ipcMain as never, dependencies);
  });

  it('owns exactly the task-board channel set and removes it symmetrically', () => {
    expect(ipcMain.handle).toHaveBeenCalledTimes(CHANNELS.length);
    expect(new Set(handlers.keys())).toEqual(new Set(CHANNELS));

    removeTeamTaskBoardIpc(ipcMain as never);

    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(CHANNELS.length);
    expect(new Set(ipcMain.removeHandler.mock.calls.map(([channel]) => channel))).toEqual(
      new Set(CHANNELS)
    );
    expect(handlers.size).toBe(0);
  });

  it('routes task queries, presence, lifecycle, and relationship commands through narrow ports', async () => {
    await handlers.get(TEAM_GET_TASK)!({} as never, ' my-team ', ' task-1 ');
    await handlers.get(TEAM_GET_TASK_CHANGE_PRESENCE)!({} as never, ' my-team ');
    await handlers.get(TEAM_SET_CHANGE_PRESENCE_TRACKING)!({} as never, ' my-team ', true);
    await handlers.get(TEAM_GET_DELETED_TASKS)!({} as never, ' my-team ');
    await handlers.get(TEAM_SOFT_DELETE_TASK)!({} as never, ' my-team ', ' task-1 ');
    await handlers.get(TEAM_RESTORE_TASK)!({} as never, ' my-team ', ' task-1 ');
    await handlers.get(TEAM_SET_TASK_CLARIFICATION)!({} as never, ' my-team ', ' task-1 ', 'lead');
    await handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      ' task-2 ',
      'blockedBy'
    );
    await handlers.get(TEAM_REMOVE_TASK_RELATIONSHIP)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      ' task-2 ',
      'related'
    );

    expect(dependencies.queries.getTask).toHaveBeenCalledWith('my-team', 'task-1');
    expect(dependencies.changePresence.getTaskChangePresence).toHaveBeenCalledWith('my-team');
    expect(dependencies.changePresence.setTaskChangePresenceTracking).toHaveBeenCalledWith(
      'my-team',
      true
    );
    expect(dependencies.queries.getDeletedTasks).toHaveBeenCalledWith('my-team');
    expect(dependencies.commands.softDeleteTask).toHaveBeenCalledWith('my-team', 'task-1');
    expect(dependencies.commands.restoreTask).toHaveBeenCalledWith('my-team', 'task-1');
    expect(dependencies.commands.setTaskNeedsClarification).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'lead'
    );
    expect(dependencies.commands.addTaskRelationship).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'task-2',
      'blockedBy'
    );
    expect(dependencies.commands.removeTaskRelationship).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'task-2',
      'related'
    );
  });

  it('normalizes create and mutation payloads without changing channel argument order', async () => {
    await handlers.get(TEAM_CREATE_TASK)!({} as never, ' my-team ', {
      subject: ' Task subject ',
      description: ' Description ',
      owner: ' alice ',
      related: ['task-2'],
      descriptionTaskRefs: [{ taskId: ' task-2 ', displayId: ' #2 ', teamName: ' my-team ' }],
      startImmediately: true,
    });
    await handlers.get(TEAM_REQUEST_REVIEW)!({} as never, ' my-team ', ' task-1 ');
    await handlers.get(TEAM_UPDATE_KANBAN)!({} as never, ' my-team ', ' task-1 ', {
      op: 'set_column',
      column: 'approved',
    });
    await handlers.get(TEAM_UPDATE_KANBAN_COLUMN_ORDER)!({} as never, ' my-team ', 'review', [
      'task-2',
      7,
      'task-1',
    ]);
    await handlers.get(TEAM_UPDATE_TASK_STATUS)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      'in_progress'
    );
    await handlers.get(TEAM_UPDATE_TASK_OWNER)!({} as never, ' my-team ', ' task-1 ', ' alice ');
    await handlers.get(TEAM_UPDATE_TASK_FIELDS)!({} as never, ' my-team ', ' task-1 ', {
      subject: ' New title ',
      description: 'New description',
    });
    await handlers.get(TEAM_START_TASK)!({} as never, ' my-team ', ' task-1 ');
    await handlers.get(TEAM_START_TASK_BY_USER)!({} as never, ' my-team ', ' task-1 ');

    expect(dependencies.commands.createTask).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({
        subject: 'Task subject',
        description: 'Description',
        owner: 'alice',
        related: ['task-2'],
        descriptionTaskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }],
        startImmediately: true,
      })
    );
    expect(dependencies.commands.requestReview).toHaveBeenCalledWith('my-team', 'task-1');
    expect(dependencies.commands.updateKanban).toHaveBeenCalledWith('my-team', 'task-1', {
      op: 'set_column',
      column: 'approved',
    });
    expect(dependencies.commands.updateKanbanColumnOrder).toHaveBeenCalledWith(
      'my-team',
      'review',
      ['task-2', 'task-1']
    );
    expect(dependencies.commands.updateTaskStatus).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'in_progress'
    );
    expect(dependencies.commands.updateTaskOwner).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'alice'
    );
    expect(dependencies.updateTaskFields.execute).toHaveBeenCalledWith('my-team', 'task-1', {
      subject: 'New title',
      description: 'New description',
    });
    expect(dependencies.commands.startTask).toHaveBeenCalledWith('my-team', 'task-1');
    expect(dependencies.commands.startTaskByUser).toHaveBeenCalledWith('my-team', 'task-1');
  });

  it('persists comment attachments before writing their task comment metadata', async () => {
    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: ' Comment ',
      attachments: [
        {
          id: ' attachment-1 ',
          filename: 'proof.png',
          mimeType: ' image/png ',
          base64Data: 'dGVzdA==',
        },
      ],
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }],
    });

    expect(result.success).toBe(true);
    expect(dependencies.commentAttachments.saveAttachment).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'attachment-1',
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    expect(dependencies.comments.addTaskComment).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'Comment',
      [expect.objectContaining({ id: 'attachment-1' })],
      [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }]
    );
    expect(
      vi.mocked(dependencies.commentAttachments.saveAttachment).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.comments.addTaskComment).mock.invocationCallOrder[0]);
  });

  it('always clears global task telemetry and preserves failure envelopes', async () => {
    vi.mocked(dependencies.clock.now).mockReturnValueOnce(100).mockReturnValueOnce(1_700);
    vi.mocked(dependencies.globalTasks.getAllTasks).mockRejectedValueOnce(new Error('scan failed'));

    const result = await handlers.get(TEAM_GET_ALL_TASKS)!({} as never);

    expect(result).toEqual({ success: false, error: 'scan failed' });
    expect(dependencies.operationTracker.setCurrent).toHaveBeenNthCalledWith(1, 'team:getAllTasks');
    expect(dependencies.operationTracker.setCurrent).toHaveBeenLastCalledWith(null);
    expect(dependencies.logger.warn).toHaveBeenCalledWith('[teams:getAllTasks] slow ms=1600');
    expect(dependencies.logger.error).toHaveBeenCalledWith('[teams:getAllTasks] scan failed');
  });

  it('rejects malformed boundary payloads before invoking application ports', async () => {
    const results = await Promise.all([
      handlers.get(TEAM_CREATE_TASK)!({} as never, 'my-team', { subject: '' }),
      handlers.get(TEAM_UPDATE_TASK_STATUS)!({} as never, 'my-team', 'task-1', 'deleted'),
      handlers.get(TEAM_UPDATE_TASK_FIELDS)!({} as never, 'my-team', 'task-1', {}),
      handlers.get(TEAM_SET_CHANGE_PRESENCE_TRACKING)!({} as never, 'my-team', 'true'),
      handlers.get(TEAM_ADD_TASK_RELATIONSHIP)!(
        {} as never,
        'my-team',
        'task-1',
        'task-2',
        'dependsOn'
      ),
      handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', { text: ' ' }),
    ]);

    expect(results.every((result) => result.success === false)).toBe(true);
    expect(dependencies.commands.createTask).not.toHaveBeenCalled();
    expect(dependencies.commands.updateTaskStatus).not.toHaveBeenCalled();
    expect(dependencies.updateTaskFields.execute).not.toHaveBeenCalled();
    expect(dependencies.changePresence.setTaskChangePresenceTracking).not.toHaveBeenCalled();
    expect(dependencies.commands.addTaskRelationship).not.toHaveBeenCalled();
    expect(dependencies.comments.addTaskComment).not.toHaveBeenCalled();
  });

  it('preserves the exact invalid team-name envelope on every team-scoped channel', async () => {
    const invalidTeamCases: ReadonlyArray<readonly [string, ...unknown[]]> = [
      [TEAM_ADD_TASK_COMMENT, '../bad', 'task-1', { text: 'Comment' }],
      [TEAM_ADD_TASK_RELATIONSHIP, '../bad', 'task-1', 'task-2', 'related'],
      [TEAM_CREATE_TASK, '../bad', { subject: 'Task' }],
      [TEAM_GET_DELETED_TASKS, '../bad'],
      [TEAM_GET_TASK, '../bad', 'task-1'],
      [TEAM_GET_TASK_CHANGE_PRESENCE, '../bad'],
      [TEAM_REMOVE_TASK_RELATIONSHIP, '../bad', 'task-1', 'task-2', 'related'],
      [TEAM_REQUEST_REVIEW, '../bad', 'task-1'],
      [TEAM_RESTORE_TASK, '../bad', 'task-1'],
      [TEAM_SET_CHANGE_PRESENCE_TRACKING, '../bad', true],
      [TEAM_SET_TASK_CLARIFICATION, '../bad', 'task-1', 'lead'],
      [TEAM_SOFT_DELETE_TASK, '../bad', 'task-1'],
      [TEAM_START_TASK, '../bad', 'task-1'],
      [TEAM_START_TASK_BY_USER, '../bad', 'task-1'],
      [TEAM_UPDATE_KANBAN, '../bad', 'task-1', { op: 'remove' }],
      [TEAM_UPDATE_KANBAN_COLUMN_ORDER, '../bad', 'review', []],
      [TEAM_UPDATE_TASK_FIELDS, '../bad', 'task-1', { subject: 'Title' }],
      [TEAM_UPDATE_TASK_OWNER, '../bad', 'task-1', 'alice'],
      [TEAM_UPDATE_TASK_STATUS, '../bad', 'task-1', 'pending'],
    ];

    const results = await Promise.all(
      invalidTeamCases.map(([channel, ...args]) => handlers.get(channel)!({} as never, ...args))
    );

    for (const result of results) {
      expect(result).toEqual({
        success: false,
        error: 'teamName contains invalid characters',
      });
    }
    expect(dependencies.queries.getTask).not.toHaveBeenCalled();
    expect(dependencies.queries.getDeletedTasks).not.toHaveBeenCalled();
    expect(dependencies.commands.createTask).not.toHaveBeenCalled();
    expect(dependencies.commands.requestReview).not.toHaveBeenCalled();
    expect(dependencies.commands.updateKanban).not.toHaveBeenCalled();
    expect(dependencies.commands.updateKanbanColumnOrder).not.toHaveBeenCalled();
    expect(dependencies.commands.updateTaskStatus).not.toHaveBeenCalled();
    expect(dependencies.commands.updateTaskOwner).not.toHaveBeenCalled();
    expect(dependencies.commands.startTask).not.toHaveBeenCalled();
    expect(dependencies.commands.startTaskByUser).not.toHaveBeenCalled();
    expect(dependencies.commands.softDeleteTask).not.toHaveBeenCalled();
    expect(dependencies.commands.restoreTask).not.toHaveBeenCalled();
    expect(dependencies.commands.setTaskNeedsClarification).not.toHaveBeenCalled();
    expect(dependencies.commands.addTaskRelationship).not.toHaveBeenCalled();
    expect(dependencies.commands.removeTaskRelationship).not.toHaveBeenCalled();
    expect(dependencies.changePresence.getTaskChangePresence).not.toHaveBeenCalled();
    expect(dependencies.changePresence.setTaskChangePresenceTracking).not.toHaveBeenCalled();
    expect(dependencies.comments.addTaskComment).not.toHaveBeenCalled();
    expect(dependencies.commentAttachments.saveAttachment).not.toHaveBeenCalled();
    expect(dependencies.updateTaskFields.execute).not.toHaveBeenCalled();
  });
});
