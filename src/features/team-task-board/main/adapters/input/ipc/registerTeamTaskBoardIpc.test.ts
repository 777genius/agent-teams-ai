import {
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE_TASK,
  TEAM_SAVE_TASK_ATTACHMENT,
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

import {
  TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH,
  TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES,
} from '../../../../core/domain/taskAttachmentPayloadPolicy';

import { registerTeamTaskBoardIpc, removeTeamTaskBoardIpc } from './registerTeamTaskBoardIpc';

import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcResult, TaskComment, TeamTask } from '@shared/types';

const CHANNELS = [
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_CREATE_TASK,
  TEAM_DELETE_TASK_ATTACHMENT,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK,
  TEAM_GET_TASK_ATTACHMENT,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE_TASK,
  TEAM_SAVE_TASK_ATTACHMENT,
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

const ATTACHMENT_ID_1 = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_ID_2 = '22222222-2222-4222-8222-222222222222';

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
    addTaskComment: {
      execute: vi.fn(
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
    taskAttachments: {
      save: vi.fn(async (_teamName, _taskId, attachmentId, filename, mimeType) => ({
        id: attachmentId,
        filename,
        mimeType,
        size: 4,
        addedAt: '2026-07-22T00:00:00.000Z',
      })),
      get: vi.fn(async () => 'dGVzdA=='),
      delete: vi.fn(async () => undefined),
    },
    taskAttachmentLogger: {
      error: vi.fn(),
      warn: vi.fn(),
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

  it('preserves task attachment channel arguments, normalization, and result shapes', async () => {
    const saveResult = await handlers.get(TEAM_SAVE_TASK_ATTACHMENT)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      ' attachment-1 ',
      ' proof.png ',
      ' image/png ',
      'dGVzdA=='
    );
    const getResult = await handlers.get(TEAM_GET_TASK_ATTACHMENT)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      ' attachment-1 ',
      ' text/javascript '
    );
    const deleteResult = await handlers.get(TEAM_DELETE_TASK_ATTACHMENT)!(
      {} as never,
      ' my-team ',
      ' task-1 ',
      ' attachment-1 ',
      ' image/png '
    );

    expect(dependencies.taskAttachments.save).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'attachment-1',
      ' proof.png ',
      'image/png',
      'dGVzdA=='
    );
    expect(dependencies.taskAttachments.get).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'attachment-1',
      'text/javascript'
    );
    expect(dependencies.taskAttachments.delete).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'attachment-1',
      'image/png'
    );
    expect(saveResult).toEqual({
      success: true,
      data: {
        id: 'attachment-1',
        filename: ' proof.png ',
        mimeType: 'image/png',
        size: 4,
        addedAt: '2026-07-22T00:00:00.000Z',
      },
    });
    expect(getResult).toEqual({ success: true, data: 'dGVzdA==' });
    expect(deleteResult).toEqual({ success: true, data: undefined });
  });

  it.each([
    {
      label: 'team name',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: [42, 'task-1', 'attachment-1', 'proof.png', 'image/png', 'dGVzdA=='],
      error: 'teamName must be a string',
    },
    {
      label: 'task ID',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'bad/id', 'attachment-1', 'proof.png', 'image/png', 'dGVzdA=='],
      error: 'taskId contains invalid characters',
    },
    {
      label: 'empty attachment ID',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', ' ', 'proof.png', 'image/png', 'dGVzdA=='],
      error: 'attachmentId must be a non-empty string',
    },
    {
      label: 'empty filename',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', 'attachment-1', ' ', 'image/png', 'dGVzdA=='],
      error: 'filename must be a non-empty string',
    },
    {
      label: 'invalid save MIME type',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', 'attachment-1', 'proof.png', 'image', 'dGVzdA=='],
      error: 'Invalid mimeType',
    },
    {
      label: 'empty base64 payload',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', 'attachment-1', 'proof.png', 'image/png', ''],
      error: 'base64Data must be a non-empty string',
    },
    {
      label: 'save path traversal',
      channel: TEAM_SAVE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', '../attachment', 'proof.png', 'image/png', 'dGVzdA=='],
      error: 'Invalid attachmentId',
    },
    {
      label: 'get path traversal',
      channel: TEAM_GET_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', 'attachment\\child', 'image/png'],
      error: 'Invalid attachmentId',
    },
    {
      label: 'delete MIME control characters',
      channel: TEAM_DELETE_TASK_ATTACHMENT,
      args: ['my-team', 'task-1', 'attachment-1', 'image/png\r\ntext/plain'],
      error: 'Invalid mimeType',
    },
  ])(
    'rejects invalid task attachment $label without invoking the use case',
    async ({ channel, args, error }) => {
      const result = await handlers.get(channel)!({} as never, ...args);

      expect(result).toEqual({ success: false, error });
      expect(dependencies.taskAttachments.save).not.toHaveBeenCalled();
      expect(dependencies.taskAttachments.get).not.toHaveBeenCalled();
      expect(dependencies.taskAttachments.delete).not.toHaveBeenCalled();
    }
  );

  it('maps task attachment failures without optimistic success and keeps the legacy log message', async () => {
    vi.mocked(dependencies.taskAttachments.save).mockRejectedValueOnce(
      new Error('metadata persistence failed')
    );

    const result = await handlers.get(TEAM_SAVE_TASK_ATTACHMENT)!(
      {} as never,
      'my-team',
      'task-1',
      'attachment-1',
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    expect(result).toEqual({ success: false, error: 'metadata persistence failed' });
    expect(dependencies.taskAttachmentLogger.error).toHaveBeenCalledWith(
      '[teams:saveTaskAttachment] metadata persistence failed'
    );
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
      blockedBy: [' task-3 '],
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
      ' task-2 ',
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
        blockedBy: ['task-3'],
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

  it('rejects invalid blockedBy IDs before task creation', async () => {
    const result = await handlers.get(TEAM_CREATE_TASK)!({} as never, 'my-team', {
      subject: 'Task subject',
      blockedBy: ['task-1', '../bad-id'],
    });

    expect(result).toEqual({ success: false, error: 'taskId contains invalid characters' });
    expect(dependencies.commands.createTask).not.toHaveBeenCalled();
  });

  it('normalizes related task IDs before task creation', async () => {
    await handlers.get(TEAM_CREATE_TASK)!({} as never, 'my-team', {
      subject: 'Task subject',
      related: [' task-2 '],
    });

    expect(dependencies.commands.createTask).toHaveBeenCalledWith(
      'my-team',
      expect.objectContaining({ related: ['task-2'] })
    );
  });

  it.each([
    {
      label: 'non-string entries',
      orderedTaskIds: ['task-2', 7, 'task-1'],
      error: 'orderedTaskIds must contain only task ID strings',
    },
    {
      label: 'invalid task IDs',
      orderedTaskIds: ['task-2', '../bad-id', 'task-1'],
      error: 'taskId contains invalid characters',
    },
  ])('rejects $label without partially reordering a column', async ({ orderedTaskIds, error }) => {
    const result = await handlers.get(TEAM_UPDATE_KANBAN_COLUMN_ORDER)!(
      {} as never,
      'my-team',
      'review',
      orderedTaskIds
    );

    expect(result).toEqual({ success: false, error });
    expect(dependencies.commands.updateKanbanColumnOrder).not.toHaveBeenCalled();
  });

  it('normalizes a comment request before invoking its application use case', async () => {
    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: ' Comment ',
      attachments: [
        {
          id: ` ${ATTACHMENT_ID_1} `,
          filename: 'proof.png',
          mimeType: ' image/png ',
          base64Data: 'dGVzdA==',
        },
      ],
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }],
    });

    expect(result.success).toBe(true);
    expect(dependencies.addTaskComment.execute).toHaveBeenCalledWith('my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: ATTACHMENT_ID_1,
          filename: 'proof.png',
          mimeType: 'image/png',
          base64Data: 'dGVzdA==',
        },
      ],
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }],
    });
  });

  it('rejects oversized encoded attachment payloads before persistence', async () => {
    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: ATTACHMENT_ID_1,
          filename: 'proof.png',
          mimeType: 'image/png',
          base64Data: 'A'.repeat(TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH + 1),
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Attachment payload exceeds the 20 MiB decoded size limit',
    });
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
  });

  it('rejects a decoded payload one byte over the limit even at the encoded length boundary', async () => {
    const oneByteOver = Buffer.alloc(TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES + 1).toString('base64');
    expect(oneByteOver).toHaveLength(TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH);

    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: ATTACHMENT_ID_1,
          filename: 'proof.png',
          mimeType: 'image/png',
          base64Data: oneByteOver,
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Attachment payload exceeds the 20 MiB decoded size limit',
    });
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
  });

  it('rejects duplicate attachment IDs before invoking the application use case', async () => {
    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: ATTACHMENT_ID_1,
          filename: 'one.png',
          mimeType: 'image/png',
          base64Data: 'b25l',
        },
        {
          id: ATTACHMENT_ID_1,
          filename: 'two.png',
          mimeType: 'image/png',
          base64Data: 'dHdv',
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Attachment IDs must be unique',
    });
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
  });

  it.each(['attachment-1', '../bad-id'])(
    'rejects non-canonical attachment ID %s before invoking the application use case',
    async (attachmentId) => {
      const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: attachmentId,
            filename: 'proof.png',
            mimeType: 'image/png',
            base64Data: 'dGVzdA==',
          },
        ],
      });

      expect(result).toEqual({
        success: false,
        error: 'Attachment ID must be a canonical UUID',
      });
      expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
    }
  );

  it.each(['!!!!', 'YQ==junk', 'AA=A', 'YR==', 'YQ== '])(
    'rejects malformed or non-canonical base64 %s before invoking the application use case',
    async (base64Data) => {
      const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: ATTACHMENT_ID_2,
            filename: 'proof.png',
            mimeType: 'image/png',
            base64Data,
          },
        ],
      });

      expect(result).toEqual({
        success: false,
        error: 'Attachment data must be canonical base64',
      });
      expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
    }
  );

  it('validates every attachment before invoking the application use case', async () => {
    const result = await handlers.get(TEAM_ADD_TASK_COMMENT)!({} as never, 'my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: ATTACHMENT_ID_1,
          filename: 'one.png',
          mimeType: 'image/png',
          base64Data: 'b25l',
        },
        {
          id: 'attachment-2',
          filename: 'two.png',
          mimeType: 'image/png',
          base64Data: 'dHdv',
        },
      ],
    });

    expect(result).toEqual({
      success: false,
      error: 'Attachment ID must be a canonical UUID',
    });
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
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
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
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
    expect(dependencies.addTaskComment.execute).not.toHaveBeenCalled();
    expect(dependencies.updateTaskFields.execute).not.toHaveBeenCalled();
  });
});
