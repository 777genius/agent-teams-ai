import { promises as fs, readFileSync } from 'node:fs';
import os from 'node:os';
import path, { resolve } from 'node:path';

import { getAppDataPath, setClaudeBasePathOverride } from '@main/utils/pathDecoder';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTeamTaskBoardFeature } from './createTeamTaskBoardFeature';

import type {
  TaskAttachmentStoragePort,
  TaskAttachmentStorageTransactionPort,
} from '../../core/application/ports/TeamTaskBoardPorts';

function createAttachmentFeature(
  metadata: {
    addTaskAttachment: ReturnType<typeof vi.fn>;
    removeTaskAttachment: ReturnType<typeof vi.fn>;
  },
  options: {
    taskAttachmentStorage?: TaskAttachmentStoragePort;
    taskAttachmentLogger?: { error(message: string): void; warn(message: string): void };
  } = {}
) {
  return createTeamTaskBoardFeature({
    taskBoardApi: {
      getAllTasks: vi.fn(async () => []),
      addTaskComment: vi.fn(),
      ...metadata,
    } as never,
    runtimeApi: { isTeamAlive: vi.fn(() => false) },
    notificationApi: { sendMessageToTeam: vi.fn(async () => undefined) },
    logger: { error: vi.fn(), warn: vi.fn() },
    ...options,
  });
}

describe('createTeamTaskBoardFeature', () => {
  afterEach(() => {
    setClaudeBasePathOverride(null);
    vi.restoreAllMocks();
  });

  it('keeps the compatibility service receiver and launch governor behavior', async () => {
    const task = { id: 'task-1', teamName: 'my-team', subject: 'Task' };
    const addTaskComment = vi.fn(async () => ({
      id: 'comment-1',
      author: 'user',
      text: 'Comment',
      createdAt: '2026-07-22T00:00:00.000Z',
      type: 'regular' as const,
    }));
    const taskBoardApi = {
      getAllTasks(): Promise<(typeof task)[]> {
        if (this !== taskBoardApi) {
          throw new Error('task board receiver lost');
        }
        return Promise.resolve([task]);
      },
      addTaskComment,
    };
    const runSummaryOperation = vi.fn(
      async (_key: string, loadFresh: () => Promise<(typeof task)[]>): Promise<(typeof task)[]> =>
        loadFresh()
    );
    const commentAttachments = {
      runTransaction: vi.fn(),
    };
    const logger = { error: vi.fn(), warn: vi.fn() };

    const feature = createTeamTaskBoardFeature({
      taskBoardApi: taskBoardApi as never,
      runtimeApi: { isTeamAlive: vi.fn(() => false) },
      notificationApi: { sendMessageToTeam: vi.fn(async () => undefined) },
      launchIoGovernor: { runSummaryOperation } as never,
      commentAttachments,
      logger,
    });

    await expect(feature.globalTasks.getAllTasks()).resolves.toEqual([task]);
    expect(feature.queries).toBe(taskBoardApi);
    expect(feature.commands).toBe(taskBoardApi);
    expect(feature.changePresence).toBe(taskBoardApi);
    expect(feature.logger).toBe(logger);
    await expect(
      feature.addTaskComment.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [],
      })
    ).resolves.toEqual(expect.objectContaining({ id: 'comment-1' }));
    expect(addTaskComment).toHaveBeenCalledWith(
      'my-team',
      'task-1',
      'Comment',
      undefined,
      undefined
    );
    expect(runSummaryOperation).toHaveBeenCalledWith(
      'teams:getAllTasks',
      expect.any(Function),
      expect.objectContaining({ clone: expect.any(Function) })
    );
  });

  it('preserves attachment save, get, and delete transaction ordering', async () => {
    const events: string[] = [];
    const metadata = {
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'proof.png',
      mimeType: 'image/png',
      size: 4,
      addedAt: '2026-07-22T00:00:00.000Z',
    };
    const transaction: TaskAttachmentStorageTransactionPort = {
      saveAttachment: vi.fn(async () => {
        events.push('save-bytes');
        return {
          metadata,
          finalize: async () => {
            events.push('finalize-save');
          },
          rollback: async () => {
            events.push('rollback-save');
          },
        };
      }),
      prepareAttachmentDeletion: vi.fn(async () => {
        events.push('prepare-delete');
        return {
          finalize: async () => {
            events.push('finalize-delete');
          },
          rollback: async () => {
            events.push('rollback-delete');
          },
        };
      }),
      markCommitted: vi.fn(() => events.push('commit')),
    };
    const storage: TaskAttachmentStoragePort = {
      runTransaction: vi.fn(async (_teamName, _taskId, operation) => operation(transaction)),
      getAttachment: vi.fn(async () => {
        events.push('get-bytes');
        return 'dGVzdA==';
      }),
    };
    const metadataPort = {
      addTaskAttachment: vi.fn(async () => {
        events.push('add-metadata');
      }),
      removeTaskAttachment: vi.fn(async () => {
        events.push('remove-metadata');
      }),
    };
    const feature = createAttachmentFeature(metadataPort, {
      taskAttachmentStorage: storage,
      taskAttachmentLogger: { error: vi.fn(), warn: vi.fn() },
    });

    await expect(
      feature.taskAttachments.save(
        'my-team',
        'task-1',
        metadata.id,
        metadata.filename,
        metadata.mimeType,
        'dGVzdA=='
      )
    ).resolves.toBe(metadata);
    expect(events).toEqual(['save-bytes', 'add-metadata', 'commit', 'finalize-save']);

    events.length = 0;
    await expect(
      feature.taskAttachments.get('my-team', 'task-1', metadata.id, 'text/javascript')
    ).resolves.toBe('dGVzdA==');
    expect(events).toEqual(['get-bytes']);

    events.length = 0;
    await expect(
      feature.taskAttachments.delete('my-team', 'task-1', metadata.id, metadata.mimeType)
    ).resolves.toBeUndefined();
    expect(events).toEqual(['prepare-delete', 'remove-metadata', 'commit', 'finalize-delete']);
  });

  it('rolls attachment bytes back on metadata failure and preserves rollback warnings', async () => {
    const metadataFailure = new Error('metadata persistence failed');
    const rollbackFailure = new Error('rollback failed');
    const logger = { error: vi.fn(), warn: vi.fn() };
    const transaction: TaskAttachmentStorageTransactionPort = {
      saveAttachment: vi.fn(async () => ({
        metadata: {
          id: '11111111-1111-4111-8111-111111111111',
          filename: 'proof.png',
          mimeType: 'image/png',
          size: 4,
          addedAt: '2026-07-22T00:00:00.000Z',
        },
        finalize: vi.fn(),
        rollback: vi.fn(async () => {
          throw rollbackFailure;
        }),
      })),
      prepareAttachmentDeletion: vi.fn(),
      markCommitted: vi.fn(),
    };
    const feature = createAttachmentFeature(
      {
        addTaskAttachment: vi.fn(async () => {
          throw metadataFailure;
        }),
        removeTaskAttachment: vi.fn(),
      },
      {
        taskAttachmentStorage: {
          runTransaction: async (_teamName, _taskId, operation) => operation(transaction),
          getAttachment: vi.fn(),
        },
        taskAttachmentLogger: logger,
      }
    );

    await expect(
      feature.taskAttachments.save(
        'my-team',
        'task-1',
        '11111111-1111-4111-8111-111111111111',
        'proof.png',
        'image/png',
        'dGVzdA=='
      )
    ).rejects.toBe(metadataFailure);
    expect(transaction.markCommitted).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[teams:saveTaskAttachment] Failed to roll back attachment 11111111-1111-4111-8111-111111111111: rollback failed'
    );
  });

  it('keeps committed attachment metadata when finalization fails', async () => {
    const metadata = {
      id: '11111111-1111-4111-8111-111111111111',
      filename: 'proof.png',
      mimeType: 'image/png' as const,
      size: 4,
      addedAt: '2026-07-22T00:00:00.000Z',
    };
    const finalize = vi.fn(async () => {
      throw new Error('finalize failed');
    });
    const rollback = vi.fn(async () => undefined);
    const markCommitted = vi.fn();
    const logger = { error: vi.fn(), warn: vi.fn() };
    const transaction: TaskAttachmentStorageTransactionPort = {
      saveAttachment: vi.fn(async () => ({ metadata, finalize, rollback })),
      prepareAttachmentDeletion: vi.fn(),
      markCommitted,
    };
    const feature = createAttachmentFeature(
      { addTaskAttachment: vi.fn(async () => undefined), removeTaskAttachment: vi.fn() },
      {
        taskAttachmentStorage: {
          runTransaction: async (_teamName, _taskId, operation) => operation(transaction),
          getAttachment: vi.fn(),
        },
        taskAttachmentLogger: logger,
      }
    );

    await expect(
      feature.taskAttachments.save(
        'my-team',
        'task-1',
        metadata.id,
        metadata.filename,
        metadata.mimeType,
        'dGVzdA=='
      )
    ).resolves.toBe(metadata);
    expect(markCommitted).toHaveBeenCalledOnce();
    expect(finalize).toHaveBeenCalledOnce();
    expect(rollback).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      `[teams:saveTaskAttachment] Failed to finalize attachment ${metadata.id}: finalize failed`
    );
  });

  it('restores prepared attachment deletion when metadata removal fails', async () => {
    const events: string[] = [];
    const metadataFailure = new Error('metadata deletion failed');
    const transaction: TaskAttachmentStorageTransactionPort = {
      saveAttachment: vi.fn(),
      prepareAttachmentDeletion: vi.fn(async () => {
        events.push('prepare-delete');
        return {
          finalize: async () => {
            events.push('finalize-delete');
          },
          rollback: async () => {
            events.push('rollback-delete');
          },
        };
      }),
      markCommitted: vi.fn(() => events.push('commit')),
    };
    const feature = createAttachmentFeature(
      {
        addTaskAttachment: vi.fn(),
        removeTaskAttachment: vi.fn(async () => {
          events.push('remove-metadata');
          throw metadataFailure;
        }),
      },
      {
        taskAttachmentStorage: {
          runTransaction: async (_teamName, _taskId, operation) => operation(transaction),
          getAttachment: vi.fn(),
        },
        taskAttachmentLogger: { error: vi.fn(), warn: vi.fn() },
      }
    );

    await expect(
      feature.taskAttachments.delete(
        'my-team',
        'task-1',
        '11111111-1111-4111-8111-111111111111',
        'image/png'
      )
    ).rejects.toBe(metadataFailure);
    expect(events).toEqual(['prepare-delete', 'remove-metadata', 'rollback-delete']);
  });

  it('uses the legacy IPC teams namespace for attachment handler logging', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const feature = createAttachmentFeature({
      addTaskAttachment: vi.fn(),
      removeTaskAttachment: vi.fn(),
    });

    feature.taskAttachmentLogger.error('[teams:getTaskAttachment] storage failed');

    expect(consoleError).toHaveBeenCalledWith(
      '[IPC:teams]',
      '[teams:getTaskAttachment] storage failed'
    );
  });

  it('returns stored task attachments with source-code MIME types through the main adapter', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-attachment-'));
    setClaudeBasePathOverride(claudeRoot);
    const taskId = 'task-js';
    const attachmentId = 'att-js';
    const attachmentDir = path.join(getAppDataPath(), 'task-attachments', 'my-team', taskId);
    const feature = createAttachmentFeature({
      addTaskAttachment: vi.fn(),
      removeTaskAttachment: vi.fn(),
    });

    try {
      await fs.mkdir(attachmentDir, { recursive: true });
      await fs.writeFile(
        path.join(attachmentDir, `${attachmentId}--script.js`),
        'const calculator = 1;\n'
      );

      const result = await feature.taskAttachments.get(
        'my-team',
        taskId,
        attachmentId,
        'text/javascript'
      );

      expect(Buffer.from(result ?? '', 'base64').toString('utf8')).toBe('const calculator = 1;\n');
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(claudeRoot, { recursive: true, force: true });
    }
  });

  it('rolls back attachment bytes through the main adapter when metadata persistence fails', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-attachment-'));
    setClaudeBasePathOverride(claudeRoot);
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const metadataFailure = new Error('metadata persistence failed');
    const feature = createAttachmentFeature({
      addTaskAttachment: vi.fn(async () => {
        throw metadataFailure;
      }),
      removeTaskAttachment: vi.fn(),
    });

    try {
      await expect(
        feature.taskAttachments.save(
          'my-team',
          'task-1',
          attachmentId,
          'proof.png',
          'image/png',
          'dGVzdA=='
        )
      ).rejects.toBe(metadataFailure);
      await expect(
        fs.readdir(path.join(getAppDataPath(), 'task-attachments', 'my-team', 'task-1'))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(claudeRoot, { recursive: true, force: true });
    }
  });

  it('preserves attachment generation identity when metadata deletion fails', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-attachment-'));
    setClaudeBasePathOverride(claudeRoot);
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const attachmentDirectory = path.join(
      getAppDataPath(),
      'task-attachments',
      'my-team',
      'task-1'
    );
    const attachmentPath = path.join(attachmentDirectory, `${attachmentId}--proof.png`);
    const metadataFailure = new Error('metadata deletion failed');
    const feature = createAttachmentFeature({
      addTaskAttachment: vi.fn(),
      removeTaskAttachment: vi.fn(async () => {
        throw metadataFailure;
      }),
    });

    try {
      await fs.mkdir(attachmentDirectory, { recursive: true });
      await fs.writeFile(attachmentPath, 'test');
      const originalIdentity = await fs.lstat(attachmentPath);

      await expect(
        feature.taskAttachments.delete('my-team', 'task-1', attachmentId, 'image/png')
      ).rejects.toBe(metadataFailure);
      await expect(fs.readFile(attachmentPath, 'utf8')).resolves.toBe('test');
      const restoredIdentity = await fs.lstat(attachmentPath);
      expect({ dev: restoredIdentity.dev, ino: restoredIdentity.ino }).toEqual({
        dev: originalIdentity.dev,
        ino: originalIdentity.ino,
      });
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(claudeRoot, { recursive: true, force: true });
    }
  });

  it('keeps attachment bytes visible until metadata deletion commits', async () => {
    const claudeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'task-board-attachment-'));
    setClaudeBasePathOverride(claudeRoot);
    const attachmentId = '11111111-1111-4111-8111-111111111111';
    const attachmentDirectory = path.join(
      getAppDataPath(),
      'task-attachments',
      'my-team',
      'task-1'
    );
    const attachmentPath = path.join(attachmentDirectory, `${attachmentId}--proof.png`);
    const feature = createAttachmentFeature({
      addTaskAttachment: vi.fn(),
      removeTaskAttachment: vi.fn(async () => {
        await expect(fs.readFile(attachmentPath, 'utf8')).resolves.toBe('test');
        const publicIdentity = await fs.lstat(attachmentPath);
        const entries = await fs.readdir(attachmentDirectory);
        const pinName = entries.find((entry) => /^\.review-create\.[a-f0-9-]+\.tmp$/i.test(entry));
        expect(pinName).toBeDefined();
        const pinIdentity = await fs.lstat(path.join(attachmentDirectory, pinName!));
        expect({ dev: pinIdentity.dev, ino: pinIdentity.ino }).toEqual({
          dev: publicIdentity.dev,
          ino: publicIdentity.ino,
        });
      }),
    });

    try {
      await fs.mkdir(attachmentDirectory, { recursive: true });
      await fs.writeFile(attachmentPath, 'test');

      await expect(
        feature.taskAttachments.delete('my-team', 'task-1', attachmentId, 'image/png')
      ).resolves.toBeUndefined();
      await expect(fs.readdir(attachmentDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      setClaudeBasePathOverride(null);
      await fs.rm(claudeRoot, { recursive: true, force: true });
    }
  });

  it('is created by the legacy adapter composition and wired unconditionally', () => {
    const teamLegacyAdaptersSource = readFileSync(
      resolve(process.cwd(), 'src/main/ipc/teamLegacyAdapters.ts'),
      'utf8'
    );
    const teamCompositionSource = readFileSync(
      resolve(process.cwd(), 'src/main/ipc/teamFeatureComposition.ts'),
      'utf8'
    );

    expect(teamLegacyAdaptersSource).toContain('const taskBoard = createTaskBoardFeature({');
    expect(teamCompositionSource).toContain(
      'registerTeamTaskBoardIpc(ipcMain, adapters.taskBoard);'
    );
    expect(teamCompositionSource).toContain('removeTeamTaskBoardIpc(ipcMain);');
  });
});
