import { describe, expect, it, vi } from 'vitest';

import { AddTaskCommentUseCase } from './AddTaskCommentUseCase';

import type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentTransactionPort,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskComment } from '@shared/types';

function createDependencies(): {
  comments: TaskCommentWriterPort;
  attachments: TaskCommentAttachmentWriterPort;
  attachmentTransaction: TaskCommentAttachmentTransactionPort;
  logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
} {
  const attachmentTransaction: TaskCommentAttachmentTransactionPort = {
    markCommitted: vi.fn(),
    saveAttachment: vi.fn(
      async (_attachmentId, filename, mimeType) =>
        ({
          metadata: {
            id: _attachmentId,
            filename,
            mimeType,
            size: 4,
            addedAt: '2026-07-22T00:00:00.000Z',
            filePath: `/workspace/attachments/${_attachmentId}`,
          },
          finalize: vi.fn(async () => undefined),
          rollback: vi.fn(async () => undefined),
        }) satisfies SavedTaskCommentAttachment
    ),
  };
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
      runTransaction: vi.fn((_teamName, _taskId, operation) => operation(attachmentTransaction)),
    },
    attachmentTransaction,
    logger: {
      warn: vi.fn(),
    },
  };
}

describe('AddTaskCommentUseCase', () => {
  it('does not acquire an attachment transaction for a text-only comment', async () => {
    const dependencies = createDependencies();
    const useCase = new AddTaskCommentUseCase(dependencies);

    await useCase.execute('my-team', 'task-1', {
      text: 'Comment',
      attachments: [],
    });

    expect(dependencies.attachments.runTransaction).not.toHaveBeenCalled();
    expect(dependencies.comments.addTaskComment).toHaveBeenCalledOnce();
  });

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

    expect(dependencies.attachmentTransaction.saveAttachment).toHaveBeenCalledWith(
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
      vi.mocked(dependencies.attachmentTransaction.saveAttachment).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(dependencies.comments.addTaskComment).mock.invocationCallOrder[0]);
  });

  it('rolls back earlier files when a later attachment save fails', async () => {
    const dependencies = createDependencies();
    const failure = new Error('second save failed');
    const rollback = vi.fn(async () => undefined);
    vi.mocked(dependencies.attachmentTransaction.saveAttachment)
      .mockResolvedValueOnce({
        metadata: {
          id: 'attachment-1',
          filename: 'one.png',
          mimeType: 'image/png',
          size: 4,
          addedAt: '2026-07-22T00:00:00.000Z',
          filePath: '/workspace/attachments/attachment-1',
        },
        finalize: vi.fn(async () => undefined),
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
    vi.mocked(dependencies.attachmentTransaction.saveAttachment)
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

  it('finalizes saved generations only after comment persistence succeeds', async () => {
    const dependencies = createDependencies();
    const finalize = vi.fn(async () => undefined);
    vi.mocked(dependencies.attachmentTransaction.saveAttachment).mockResolvedValueOnce(
      createSavedAttachment(
        'attachment-1',
        'one.png',
        'image/png',
        vi.fn(async () => undefined),
        finalize
      )
    );
    const useCase = new AddTaskCommentUseCase(dependencies);

    await useCase.execute('my-team', 'task-1', {
      text: 'Comment',
      attachments: [
        {
          id: 'attachment-1',
          filename: 'one.png',
          mimeType: 'image/png',
          base64Data: 'b25l',
        },
      ],
    });

    expect(finalize).toHaveBeenCalledOnce();
    expect(
      vi.mocked(dependencies.comments.addTaskComment).mock.invocationCallOrder[0]
    ).toBeLessThan(finalize.mock.invocationCallOrder[0]);
    expect(
      vi.mocked(dependencies.comments.addTaskComment).mock.invocationCallOrder[0]
    ).toBeLessThan(
      vi.mocked(dependencies.attachmentTransaction.markCommitted).mock.invocationCallOrder[0]
    );
    expect(
      vi.mocked(dependencies.attachmentTransaction.markCommitted).mock.invocationCallOrder[0]
    ).toBeLessThan(finalize.mock.invocationCallOrder[0]);
  });

  it('records a durable comment commit before a previously observed lock compromise can fail', async () => {
    const dependencies = createDependencies();
    const lockFailure = new Error('lock compromised');
    let compromised = false;
    let committed = false;
    const finalize = vi.fn(async () => undefined);
    vi.mocked(dependencies.attachmentTransaction.saveAttachment).mockResolvedValueOnce(
      createSavedAttachment(
        'attachment-1',
        'one.png',
        'image/png',
        vi.fn(async () => undefined),
        finalize
      )
    );
    vi.mocked(dependencies.comments.addTaskComment).mockImplementationOnce(async () => {
      compromised = true;
      return {
        id: 'comment-1',
        author: 'user',
        text: 'Comment',
        createdAt: '2026-07-22T00:00:00.000Z',
        type: 'regular',
      };
    });
    vi.mocked(dependencies.attachmentTransaction.markCommitted).mockImplementationOnce(() => {
      committed = true;
    });
    vi.mocked(dependencies.attachments.runTransaction).mockImplementationOnce(
      async (_teamName, _taskId, operation) => {
        const result = await operation(dependencies.attachmentTransaction);
        if (compromised && !committed) throw lockFailure;
        return result;
      }
    );
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
        ],
      })
    ).resolves.toMatchObject({ id: 'comment-1' });

    expect(dependencies.attachmentTransaction.markCommitted).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it('keeps a persisted comment when generation finalization fails', async () => {
    const dependencies = createDependencies();
    const finalizeFailure = new Error('finalize failed');
    const rollback = vi.fn(async () => undefined);
    vi.mocked(dependencies.attachmentTransaction.saveAttachment).mockResolvedValueOnce(
      createSavedAttachment('attachment-1', 'one.png', 'image/png', rollback, async () => {
        throw finalizeFailure;
      })
    );
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
        ],
      })
    ).resolves.toMatchObject({ id: 'comment-1' });

    expect(rollback).not.toHaveBeenCalled();
    expect(dependencies.logger.warn).toHaveBeenCalledWith(
      '[teams:addTaskComment] Failed to finalize attachment attachment-1: finalize failed'
    );
  });
});

function createSavedAttachment(
  id: string,
  filename: string,
  mimeType: AttachmentMediaType,
  rollback: () => Promise<void>,
  finalize: () => Promise<void> = async () => undefined
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
    finalize,
    rollback,
  };
}
