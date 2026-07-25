import { describe, expect, it, vi } from 'vitest';

import { AddTaskCommentUseCase } from './AddTaskCommentUseCase';

import type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskComment } from '@shared/types';

function createDependencies(): {
  comments: TaskCommentWriterPort;
  attachments: TaskCommentAttachmentWriterPort;
  logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
} {
  return {
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
    attachments: {
      saveAttachment: vi.fn(
        async (_teamName, _taskId, attachmentId, filename, mimeType) =>
          ({
            metadata: {
              id: attachmentId,
              filename,
              mimeType,
              size: 4,
              addedAt: '2026-07-22T00:00:00.000Z',
              filePath: `/workspace/attachments/${attachmentId}`,
            },
            rollback: vi.fn(async () => undefined),
          }) satisfies SavedTaskCommentAttachment
      ),
    },
    logger: {
      warn: vi.fn(),
    },
  };
}

describe('AddTaskCommentUseCase', () => {
  it('saves attachments before persisting their comment metadata', async () => {
    const dependencies = createDependencies();
    const useCase = new AddTaskCommentUseCase(dependencies);

    await useCase.execute('my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: 'attachment-1',
          filename: 'proof.png',
          mimeType: 'image/png',
          base64Data: 'dGVzdA==',
        },
      ],
      taskRefs: [{ taskId: 'task-2', displayId: '#2', teamName: 'my-team' }],
    });

    expect(dependencies.attachments.saveAttachment).toHaveBeenCalledWith(
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
      vi.mocked(dependencies.attachments.saveAttachment).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.comments.addTaskComment).mock.invocationCallOrder[0]);
  });

  it('rolls back earlier files when a later attachment save fails', async () => {
    const dependencies = createDependencies();
    const failure = new Error('second save failed');
    const rollback = vi.fn(async () => undefined);
    vi.mocked(dependencies.attachments.saveAttachment)
      .mockResolvedValueOnce({
        metadata: {
          id: 'attachment-1',
          filename: 'one.png',
          mimeType: 'image/png',
          size: 4,
          addedAt: '2026-07-22T00:00:00.000Z',
          filePath: '/workspace/attachments/attachment-1',
        },
        rollback,
      })
      .mockRejectedValueOnce(failure);
    const useCase = new AddTaskCommentUseCase(dependencies);

    await expect(
      useCase.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: 'attachment-1',
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
      })
    ).rejects.toBe(failure);

    expect(rollback).toHaveBeenCalledOnce();
    expect(dependencies.comments.addTaskComment).not.toHaveBeenCalled();
  });

  it('best-effort rolls back every file in reverse order and preserves the original error', async () => {
    const dependencies = createDependencies();
    const failure = new Error('comment write failed');
    const rollbackFirst = vi.fn(async () => undefined);
    const rollbackSecond = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    vi.mocked(dependencies.attachments.saveAttachment)
      .mockResolvedValueOnce(
        createSavedAttachment('attachment-1', 'one.png', 'image/png', rollbackFirst)
      )
      .mockResolvedValueOnce(
        createSavedAttachment('attachment-2', 'two.png', 'image/png', rollbackSecond)
      );
    vi.mocked(dependencies.comments.addTaskComment).mockRejectedValueOnce(failure);
    const useCase = new AddTaskCommentUseCase(dependencies);

    await expect(
      useCase.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: 'attachment-1',
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
      })
    ).rejects.toBe(failure);

    expect(rollbackSecond.mock.invocationCallOrder[0]).toBeLessThan(
      rollbackFirst.mock.invocationCallOrder[0]
    );
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      '[teams:addTaskComment] Failed to roll back attachment attachment-2: cleanup failed'
    );
  });
});

function createSavedAttachment(
  id: string,
  filename: string,
  mimeType: AttachmentMediaType,
  rollback: () => Promise<void>
): SavedTaskCommentAttachment {
  return {
    metadata: {
      id,
      filename,
      mimeType,
      size: 4,
      addedAt: '2026-07-22T00:00:00.000Z',
      filePath: `/workspace/attachments/${id}`,
    },
    rollback,
  };
}
