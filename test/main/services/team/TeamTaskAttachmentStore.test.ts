import { link, mkdir, mkdtemp, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddTaskCommentUseCase } from '../../../../src/features/team-task-board/core/application/use-cases/AddTaskCommentUseCase';
import { TeamTaskCommentAttachmentWriter } from '../../../../src/features/team-task-board/main/adapters/output/TeamTaskCommentAttachmentWriter';
import {
  type TaskAttachmentAtomicCreatorPort,
  TeamTaskAttachmentStore,
} from '../../../../src/main/services/team/TeamTaskAttachmentStore';

import type { TaskAttachmentMeta, TaskComment } from '@shared/types';

const mocks = vi.hoisted(() => ({
  getAppDataPath: vi.fn(() => '/workspace/app-data'),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: mocks.getAppDataPath,
}));

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const ATTACHMENT_FILE = `${ATTACHMENT_ID}--attachment`;
const LEGACY_ATTACHMENT_FILE = `${ATTACHMENT_ID}--proof.png`;

function createAtomicCreator(): TaskAttachmentAtomicCreatorPort {
  return {
    createFileAtomically: vi.fn(async () => ({ dev: 1, ino: 2 })),
  };
}

function createComment(): TaskComment {
  return {
    id: 'comment-1',
    author: 'user',
    text: 'Comment',
    createdAt: '2026-07-22T00:00:00.000Z',
    type: 'regular',
  };
}

describe('TeamTaskAttachmentStore', () => {
  const tempRoots: string[] = [];

  beforeEach(() => {
    mocks.getAppDataPath.mockReset();
    mocks.getAppDataPath.mockReturnValue('/workspace/app-data');
  });

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
    );
  });

  async function createRealStore(): Promise<{
    root: string;
    taskDirectory: string;
    store: TeamTaskAttachmentStore;
  }> {
    const root = await mkdtemp(join(tmpdir(), 'team-task-attachment-store-'));
    tempRoots.push(root);
    mocks.getAppDataPath.mockReturnValue(root);
    return {
      root,
      taskDirectory: join(root, 'task-attachments', 'my-team', 'task-1'),
      store: new TeamTaskAttachmentStore(),
    };
  }

  it('publishes decoded attachment bytes through the no-clobber atomic creator port', async () => {
    const atomicCreator = createAtomicCreator();
    const store = new TeamTaskAttachmentStore(atomicCreator);

    const metadata = await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    expect(atomicCreator.createFileAtomically).toHaveBeenCalledWith(
      `/workspace/app-data/task-attachments/my-team/task-1/${ATTACHMENT_FILE}`,
      Buffer.from('test')
    );
    expect(metadata).toEqual(
      expect.objectContaining({
        id: ATTACHMENT_ID,
        filename: 'proof.png',
        mimeType: 'image/png',
        size: 4,
        filePath: `/workspace/app-data/task-attachments/my-team/task-1/${ATTACHMENT_FILE}`,
      })
    );
  });

  it('preserves an atomic publication failure without returning attachment metadata', async () => {
    const failure = new Error('atomic create failed');
    const atomicCreator = createAtomicCreator();
    vi.mocked(atomicCreator.createFileAtomically).mockRejectedValueOnce(failure);
    const store = new TeamTaskAttachmentStore(atomicCreator);

    await expect(
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'proof.png', 'image/png', 'dGVzdA==')
    ).rejects.toBe(failure);
  });

  it.each(['attachment-1', '../bad-id'])('rejects non-canonical attachment ID %s', async (id) => {
    const atomicCreator = createAtomicCreator();
    const store = new TeamTaskAttachmentStore(atomicCreator);

    await expect(
      store.saveAttachment('my-team', 'task-1', id, 'proof.png', 'image/png', 'dGVzdA==')
    ).rejects.toThrow('Attachment ID must be a canonical UUID');
    expect(atomicCreator.createFileAtomically).not.toHaveBeenCalled();
  });

  it.each(['!!!!', 'YQ==junk', 'AA=A', 'YR==', 'YQ== '])(
    'rejects malformed or non-canonical base64 %s',
    async (base64Data) => {
      const atomicCreator = createAtomicCreator();
      const store = new TeamTaskAttachmentStore(atomicCreator);

      await expect(
        store.saveAttachment(
          'my-team',
          'task-1',
          ATTACHMENT_ID,
          'proof.png',
          'image/png',
          base64Data
        )
      ).rejects.toThrow('Invalid attachment base64 data');
      expect(atomicCreator.createFileAtomically).not.toHaveBeenCalled();
    }
  );

  it('preserves an existing legacy attachment collision and its bytes', async () => {
    const { store, taskDirectory } = await createRealStore();
    const legacyPath = join(taskDirectory, LEGACY_ATTACHMENT_FILE);
    await mkdir(taskDirectory, { recursive: true });
    await writeFile(legacyPath, Buffer.from('old bytes'));

    await expect(
      store.saveAttachment(
        'my-team',
        'task-1',
        ATTACHMENT_ID,
        'replacement.png',
        'image/png',
        'bmV3IGJ5dGVz'
      )
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(await readFile(legacyPath)).toEqual(Buffer.from('old bytes'));
    expect(await readdir(taskDirectory)).toEqual([LEGACY_ATTACHMENT_FILE]);
  });

  it('allows exactly one winner when concurrent requests create the same attachment ID', async () => {
    const { store, taskDirectory } = await createRealStore();

    const results = await Promise.allSettled([
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'one.png', 'image/png', 'b25l'),
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'two.png', 'image/png', 'dHdv'),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({
      status: 'rejected',
      reason: expect.objectContaining({ code: 'EEXIST' }),
    });
    expect(await readdir(taskDirectory)).toEqual([ATTACHMENT_FILE]);
    expect(['one', 'two']).toContain(
      (await readFile(join(taskDirectory, ATTACHMENT_FILE))).toString()
    );
  });

  it('does not roll back a pre-existing attachment when its ID collides', async () => {
    const { store, taskDirectory } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'old.png',
      'image/png',
      'b2xkIGJ5dGVz'
    );
    const addTaskComment = vi.fn(async () => createComment());
    const attachmentWriter = new TeamTaskCommentAttachmentWriter(store);
    const useCase = new AddTaskCommentUseCase({
      comments: { addTaskComment },
      attachments: attachmentWriter,
      logger: { warn: vi.fn() },
    });

    await expect(
      useCase.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: 'new.png',
            mimeType: 'image/png',
            base64Data: 'bmV3IGJ5dGVz',
          },
        ],
      })
    ).rejects.toMatchObject({ code: 'EEXIST' });

    expect(addTaskComment).not.toHaveBeenCalled();
    expect(await readFile(join(taskDirectory, ATTACHMENT_FILE))).toEqual(Buffer.from('old bytes'));
    expect(await readdir(taskDirectory)).toEqual([ATTACHMENT_FILE]);
  });

  it('preserves a replacement file when comment rollback no longer owns the saved inode', async () => {
    const { store, taskDirectory } = await createRealStore();
    const attachmentWriter = new TeamTaskCommentAttachmentWriter(store);
    const failure = new Error('comment write failed');
    const addTaskComment = vi.fn(
      async (
        _teamName: string,
        _taskId: string,
        _text: string,
        attachments?: TaskAttachmentMeta[]
      ) => {
        const metadata = attachments?.[0];
        if (!metadata || typeof metadata.filePath !== 'string') {
          throw new Error('Expected saved attachment metadata');
        }
        await link(metadata.filePath, join(taskDirectory, 'original-backup'));
        await unlink(metadata.filePath);
        await writeFile(metadata.filePath, Buffer.from('replacement bytes'));
        throw failure;
      }
    );
    const useCase = new AddTaskCommentUseCase({
      comments: { addTaskComment },
      attachments: attachmentWriter,
      logger: { warn: vi.fn() },
    });

    await expect(
      useCase.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: 'new.png',
            mimeType: 'image/png',
            base64Data: 'bmV3IGJ5dGVz',
          },
        ],
      })
    ).rejects.toBe(failure);

    expect(await readFile(join(taskDirectory, ATTACHMENT_FILE))).toEqual(
      Buffer.from('replacement bytes')
    );
  });

  it('removes the exact saved inode when comment persistence fails', async () => {
    const { store, taskDirectory } = await createRealStore();
    const failure = new Error('comment write failed');
    const useCase = new AddTaskCommentUseCase({
      comments: {
        addTaskComment: vi.fn(async () => {
          throw failure;
        }),
      },
      attachments: new TeamTaskCommentAttachmentWriter(store),
      logger: { warn: vi.fn() },
    });

    await expect(
      useCase.execute('my-team', 'task-1', {
        text: 'Comment',
        attachments: [
          {
            id: ATTACHMENT_ID,
            filename: 'new.png',
            mimeType: 'image/png',
            base64Data: 'bmV3IGJ5dGVz',
          },
        ],
      })
    ).rejects.toBe(failure);

    await expect(readFile(join(taskDirectory, ATTACHMENT_FILE))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
