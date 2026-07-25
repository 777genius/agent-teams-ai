import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

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
const ATTACHMENT_FILE_PATTERN = new RegExp(
  `^${ATTACHMENT_ID}--[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.attachment$`
);
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

    const [filePath, bytes] = vi.mocked(atomicCreator.createFileAtomically).mock.calls[0] ?? [];
    expect(basename(String(filePath))).toMatch(ATTACHMENT_FILE_PATTERN);
    expect(bytes).toEqual(Buffer.from('test'));
    expect(metadata).toEqual(
      expect.objectContaining({
        id: ATTACHMENT_ID,
        filename: 'proof.png',
        mimeType: 'image/png',
        size: 4,
        filePath,
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
    const attachmentFiles = await readdir(taskDirectory);
    expect(attachmentFiles).toHaveLength(1);
    const attachmentFile = attachmentFiles[0];
    if (!attachmentFile) throw new Error('Expected one stored attachment');
    expect(attachmentFile).toMatch(ATTACHMENT_FILE_PATTERN);
    expect(['one', 'two']).toContain(
      (await readFile(join(taskDirectory, attachmentFile))).toString()
    );
  });

  it('does not roll back a pre-existing attachment when its ID collides', async () => {
    const { store, taskDirectory } = await createRealStore();
    const oldAttachment = await store.saveAttachment(
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
    const oldPath = oldAttachment.filePath;
    if (typeof oldPath !== 'string') throw new Error('Expected stored attachment path');
    expect(await readFile(oldPath)).toEqual(Buffer.from('old bytes'));
    expect(await readdir(taskDirectory)).toEqual([basename(oldPath)]);
  });

  it('preserves a later generation when stale comment rollback runs after delete and recreate', async () => {
    const { store, taskDirectory } = await createRealStore();
    const attachmentWriter = new TeamTaskCommentAttachmentWriter(store);
    const failure = new Error('comment write failed');
    let originalPath: string | null = null;
    let replacementPath: string | null = null;
    const addTaskComment = vi.fn(async (...args: unknown[]) => {
      const attachments = args[3] as TaskAttachmentMeta[] | undefined;
      originalPath = attachments?.[0]?.filePath ?? null;
      await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
      const replacement = await store.saveAttachment(
        'my-team',
        'task-1',
        ATTACHMENT_ID,
        'replacement.png',
        'image/png',
        'cmVwbGFjZW1lbnQgYnl0ZXM='
      );
      replacementPath = replacement.filePath ?? null;
      throw failure;
    });
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

    await expect(
      store.getAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png')
    ).resolves.toBe('cmVwbGFjZW1lbnQgYnl0ZXM=');
    expect(originalPath).not.toBeNull();
    expect(replacementPath).not.toBe(originalPath);
    const [attachmentFile] = await readdir(taskDirectory);
    expect(attachmentFile).toMatch(ATTACHMENT_FILE_PATTERN);
  });

  it('removes the exact saved generation when comment persistence fails', async () => {
    const { store } = await createRealStore();
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

    await expect(
      store.getAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png')
    ).resolves.toBeNull();
  });
});
