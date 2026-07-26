import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddTaskCommentUseCase } from '../../../../src/features/team-task-board/core/application/use-cases/AddTaskCommentUseCase';
import { TeamTaskCommentAttachmentWriter } from '../../../../src/features/team-task-board/main/adapters/output/TeamTaskCommentAttachmentWriter';
import {
  NodeTaskAttachmentMutationCoordinator,
  type TaskAttachmentMutationCoordinatorPort,
} from '../../../../src/main/services/team/TaskAttachmentMutationCoordinator';
import {
  type TaskAttachmentAtomicCreatorPort,
  TeamTaskAttachmentStore,
} from '../../../../src/main/services/team/TeamTaskAttachmentStore';
import {
  atomicCreateAsync,
  cleanupAtomicCreateTempLinks,
} from '../../../../src/main/utils/atomicWrite';

import type { TaskAttachmentMeta, TaskComment } from '@shared/types';

const mocks = vi.hoisted(() => ({
  getAppDataPath: vi.fn(() => '/workspace/app-data'),
}));

vi.mock('@main/utils/pathDecoder', () => ({
  getAppDataPath: mocks.getAppDataPath,
}));

const ATTACHMENT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ATTACHMENT_ID = '22222222-2222-4222-8222-222222222222';
const ATTACHMENT_FILE = `${ATTACHMENT_ID}--attachment`;
const LEGACY_ATTACHMENT_FILE = `${ATTACHMENT_ID}--proof.png`;
const execFileAsync = promisify(execFile);
const PROCESS_WORKER_PATH = join(
  process.cwd(),
  'test/main/services/team/fixtures/teamTaskAttachmentStoreProcessWorker.ts'
);

interface AttachmentRaceWorkerResult {
  filePath?: string;
  errorCode?: string;
  errorMessage?: string;
}

async function readAttachmentDataFiles(directory: string): Promise<string[]> {
  return (await readdir(directory)).filter((entry) => entry.startsWith(`${ATTACHMENT_ID}--`));
}

async function runAttachmentRaceWorker(
  root: string,
  participant: string
): Promise<AttachmentRaceWorkerResult> {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--import', 'tsx', PROCESS_WORKER_PATH],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TASK_ATTACHMENT_STORE_RACE_ROOT: root,
        TASK_ATTACHMENT_STORE_RACE_PARTICIPANT: participant,
      },
      timeout: 20_000,
    }
  );
  const resultLine = stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith('TASK_ATTACHMENT_RACE_RESULT:'));
  if (!resultLine) {
    throw new Error(`Attachment race worker did not report a result: ${stdout}`);
  }
  return JSON.parse(
    resultLine.slice('TASK_ATTACHMENT_RACE_RESULT:'.length)
  ) as AttachmentRaceWorkerResult;
}

function createAtomicCreator(): TaskAttachmentAtomicCreatorPort {
  return {
    createFileAtomically: vi.fn(async () => ({ dev: 1, ino: 2 })),
    cleanupPublishedTempLinks: vi.fn(() => Promise.resolve()),
  };
}

function createUnitStore(atomicCreator: TaskAttachmentAtomicCreatorPort): TeamTaskAttachmentStore {
  return new TeamTaskAttachmentStore(atomicCreator, {
    run: (_mutationKey, operation) =>
      operation({
        assertHealthy: () => undefined,
        markCommitted: () => undefined,
        registerCompensation: () => ({ dismiss: () => undefined }),
      }),
  });
}

function createCommitAwareCoordinator(): {
  coordinator: TaskAttachmentMutationCoordinatorPort;
  compromise(error: Error): void;
} {
  let compromisedError: Error | null = null;
  return {
    compromise(error) {
      compromisedError = error;
    },
    coordinator: {
      async run(_mutationKey, operation) {
        let committed = false;
        const result = await operation({
          assertHealthy() {
            if (!committed && compromisedError) throw compromisedError;
          },
          markCommitted() {
            committed = true;
          },
          registerCompensation: () => ({ dismiss: () => undefined }),
        });
        if (!committed && compromisedError) throw compromisedError;
        return result;
      },
    },
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
    const store = createUnitStore(atomicCreator);

    const metadata = await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    const [filePath, bytes] = vi.mocked(atomicCreator.createFileAtomically).mock.calls[0] ?? [];
    expect(basename(String(filePath))).toBe(ATTACHMENT_FILE);
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
    const store = createUnitStore(atomicCreator);

    await expect(
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'proof.png', 'image/png', 'dGVzdA==')
    ).rejects.toBe(failure);
  });

  it('removes the published attachment when its generation guard cannot be established', async () => {
    const { taskDirectory } = await createRealStore();
    const failure = new Error('generation guard failed');
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createFileAtomically: atomicCreateAsync,
      createGenerationGuard: vi.fn(async () => {
        throw failure;
      }),
      cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
    };
    const store = new TeamTaskAttachmentStore(atomicCreator);

    await expect(
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'proof.png', 'image/png', 'dGVzdA==')
    ).rejects.toBe(failure);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('registers identity-safe compensation for a post-publication lock compromise', async () => {
    const { taskDirectory } = await createRealStore();
    const compromisedFailure = new Error('lock compromised');
    const coordinator: TaskAttachmentMutationCoordinatorPort = {
      async run(_mutationKey, operation) {
        const compensations: Array<{ active: boolean; run: () => Promise<void> }> = [];
        await operation({
          assertHealthy: () => undefined,
          markCommitted: () => undefined,
          registerCompensation(compensate) {
            const entry = { active: true, run: compensate };
            compensations.push(entry);
            return {
              dismiss() {
                entry.active = false;
              },
            };
          },
        });
        for (const compensation of [...compensations].reverse()) {
          if (compensation.active) await compensation.run();
        }
        throw compromisedFailure;
      },
    };
    const store = new TeamTaskAttachmentStore(undefined, coordinator);

    await expect(
      store.saveAttachmentWithReceipt(
        'my-team',
        'task-1',
        ATTACHMENT_ID,
        'proof.png',
        'image/png',
        'dGVzdA=='
      )
    ).rejects.toBe(compromisedFailure);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('pins the saved generation until its rollback receipt is consumed', async () => {
    const { store, taskDirectory } = await createRealStore();

    const receipt = await store.saveAttachmentWithReceipt(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    expect(receipt.generationGuardPath).toMatch(/\.review-create\.[a-f0-9-]+\.tmp$/i);
    const [attachmentIdentity, guardIdentity] = await Promise.all([
      fsPromises.lstat(receipt.filePath),
      fsPromises.lstat(receipt.generationGuardPath ?? ''),
    ]);
    expect({ dev: guardIdentity.dev, ino: guardIdentity.ino }).toEqual({
      dev: attachmentIdentity.dev,
      ino: attachmentIdentity.ino,
    });

    await store.rollbackAttachment(receipt);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the identity-matched target even when temp-link cleanup fails', async () => {
    const { taskDirectory } = await createRealStore();
    const cleanupFailure = new Error('temp cleanup failed');
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createFileAtomically: atomicCreateAsync,
      async createGenerationGuard(filePath) {
        const guardPath = join(
          taskDirectory,
          '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp'
        );
        await fsPromises.link(filePath, guardPath);
        return guardPath;
      },
      cleanupPublishedTempLinks: vi.fn(async () => {
        throw cleanupFailure;
      }),
    };
    const store = new TeamTaskAttachmentStore(atomicCreator);
    const receipt = await store.saveAttachmentWithReceipt(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    await expect(store.rollbackAttachment(receipt)).rejects.toBe(cleanupFailure);

    await expect(fsPromises.lstat(receipt.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes the generation guard after a direct save succeeds', async () => {
    const { store, taskDirectory } = await createRealStore();

    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    expect(await readdir(taskDirectory)).toEqual([ATTACHMENT_FILE]);
  });

  it('preserves a durable metadata save when compromise is observed before its commit marker', async () => {
    const { taskDirectory } = await createRealStore();
    const lockFailure = new Error('lock compromised');
    const { coordinator, compromise } = createCommitAwareCoordinator();
    const store = new TeamTaskAttachmentStore(undefined, coordinator);
    let metadataCommitted = false;

    await expect(
      store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
        const receipt = await transaction.saveAttachmentWithReceipt(
          ATTACHMENT_ID,
          'proof.png',
          'image/png',
          'dGVzdA=='
        );
        metadataCommitted = true;
        compromise(lockFailure);
        transaction.markCommitted();
        await transaction.finalizeAttachment(receipt);
        return receipt.metadata;
      })
    ).resolves.toMatchObject({ id: ATTACHMENT_ID });

    expect(metadataCommitted).toBe(true);
    expect(await readAttachmentDataFiles(taskDirectory)).toEqual([ATTACHMENT_FILE]);
  });

  it('preserves a durable metadata delete when compromise is observed before its commit marker', async () => {
    const { taskDirectory } = await createRealStore();
    const lockFailure = new Error('lock compromised');
    const { coordinator, compromise } = createCommitAwareCoordinator();
    const store = new TeamTaskAttachmentStore(undefined, coordinator);
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    let metadataDeleted = false;

    await expect(
      store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
        await transaction.deleteAttachment(ATTACHMENT_ID, 'image/png');
        metadataDeleted = true;
        compromise(lockFailure);
        transaction.markCommitted();
      })
    ).resolves.toBeUndefined();

    expect(metadataDeleted).toBe(true);
    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
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
    const attachmentFiles = await readAttachmentDataFiles(taskDirectory);
    expect(attachmentFiles).toHaveLength(1);
    const attachmentFile = attachmentFiles[0];
    if (!attachmentFile) throw new Error('Expected one stored attachment');
    expect(attachmentFile).toBe(ATTACHMENT_FILE);
    expect(['one', 'two']).toContain(
      (await readFile(join(taskDirectory, attachmentFile))).toString()
    );
  });

  it('removes a crash-left temp hardlink before deleting its published attachment', async () => {
    const { taskDirectory } = await createRealStore();
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createFileAtomically: atomicCreateAsync,
      cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
    };
    const store = new TeamTaskAttachmentStore(atomicCreator);
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    let tempUnlinkFailures = 0;
    const unlink = vi.spyOn(fsPromises, 'unlink').mockImplementation(async (filePath) => {
      if (basename(String(filePath)).startsWith('.review-create.') && tempUnlinkFailures < 2) {
        tempUnlinkFailures += 1;
        const error = new Error('injected busy temp hardlink') as NodeJS.ErrnoException;
        error.code = 'EBUSY';
        throw error;
      }
      await originalUnlink(filePath);
    });

    try {
      await store.saveAttachment(
        'my-team',
        'task-1',
        ATTACHMENT_ID,
        'proof.png',
        'image/png',
        'dGVzdA=='
      );
      expect(await readdir(taskDirectory)).toHaveLength(2);
      expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain(
        'Failed to clean published attachment temp links'
      );
      vi.mocked(console.warn).mockClear();

      await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');

      await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      unlink.mockRestore();
    }
  });

  it('allows exactly one winner across independent processes saving the same attachment ID', async () => {
    const root = await mkdtemp(join(tmpdir(), 'team-task-attachment-process-race-'));
    tempRoots.push(root);

    const results = await Promise.all([
      runAttachmentRaceWorker(root, 'first'),
      runAttachmentRaceWorker(root, 'second'),
    ]);

    expect(results.filter((result) => result.filePath)).toHaveLength(1);
    expect(results.filter((result) => result.errorCode === 'EEXIST')).toHaveLength(1);
    const attachmentDirectory = join(root, 'data', 'task-attachments', 'my-team', 'task-1');
    expect(await readAttachmentDataFiles(attachmentDirectory)).toEqual([ATTACHMENT_FILE]);
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
    expect(await readAttachmentDataFiles(taskDirectory)).toEqual([basename(oldPath)]);
  });

  it('holds the task transaction through comment rollback before delete and recreate', async () => {
    const { store, taskDirectory } = await createRealStore();
    const attachmentWriter = new TeamTaskCommentAttachmentWriter(store);
    const secondCoordinator = new NodeTaskAttachmentMutationCoordinator();
    let notifyReplacementAttempted!: () => void;
    const replacementAttempted = new Promise<void>((resolve) => {
      notifyReplacementAttempted = resolve;
    });
    const replacementStore = new TeamTaskAttachmentStore(undefined, {
      run(mutationKey, operation) {
        notifyReplacementAttempted();
        return secondCoordinator.run(mutationKey, operation);
      },
    });
    const failure = new Error('comment write failed');
    let originalPath: string | null = null;
    let replacementPath: string | null = null;
    let replacementSettled = false;
    let replace: Promise<TaskAttachmentMeta> | null = null;
    const addTaskComment = vi.fn(async (...args: unknown[]) => {
      const attachments = args[3] as TaskAttachmentMeta[] | undefined;
      originalPath = attachments?.[0]?.filePath ?? null;
      replace = (async () => {
        await replacementStore.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
        const replacement = await replacementStore.saveAttachment(
          'my-team',
          'task-1',
          ATTACHMENT_ID,
          'replacement.png',
          'image/png',
          'cmVwbGFjZW1lbnQgYnl0ZXM='
        );
        replacementPath = replacement.filePath ?? null;
        return replacement;
      })().finally(() => {
        replacementSettled = true;
      });
      await replacementAttempted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(replacementSettled).toBe(false);
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
    await replace;

    await expect(
      replacementStore.getAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png')
    ).resolves.toBe('cmVwbGFjZW1lbnQgYnl0ZXM=');
    expect(originalPath).not.toBeNull();
    expect(replacementPath).toBe(originalPath);
    const [attachmentFile] = await readAttachmentDataFiles(taskDirectory);
    expect(attachmentFile).toBe(ATTACHMENT_FILE);
  });

  it('serializes rollback identity checks against delete and recreate in another coordinator', async () => {
    const { taskDirectory } = await createRealStore();
    let pauseRollbackCleanup = false;
    let notifyCleanupStarted!: () => void;
    let resumeCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });
    const cleanupResume = new Promise<void>((resolve) => {
      resumeCleanup = resolve;
    });
    const firstCreator: TaskAttachmentAtomicCreatorPort = {
      createFileAtomically: atomicCreateAsync,
      async cleanupPublishedTempLinks(filePath) {
        if (pauseRollbackCleanup) {
          notifyCleanupStarted();
          await cleanupResume;
        }
        await cleanupAtomicCreateTempLinks(filePath);
      },
    };
    const firstStore = new TeamTaskAttachmentStore(
      firstCreator,
      new NodeTaskAttachmentMutationCoordinator()
    );
    const secondCoordinator = new NodeTaskAttachmentMutationCoordinator();
    let notifySecondAttempted!: () => void;
    const secondAttempted = new Promise<void>((resolve) => {
      notifySecondAttempted = resolve;
    });
    const observedSecondCoordinator: TaskAttachmentMutationCoordinatorPort = {
      run(mutationKey, operation) {
        notifySecondAttempted();
        return secondCoordinator.run(mutationKey, operation);
      },
    };
    const secondStore = new TeamTaskAttachmentStore(undefined, observedSecondCoordinator);
    const receipt = await firstStore.saveAttachmentWithReceipt(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'old.png',
      'image/png',
      'b2xk'
    );

    pauseRollbackCleanup = true;
    const rollback = firstStore.rollbackAttachment(receipt);
    await cleanupStarted;
    let replacementSettled = false;
    const replace = (async () => {
      await secondStore.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
      return secondStore.saveAttachment(
        'my-team',
        'task-1',
        ATTACHMENT_ID,
        'replacement.png',
        'image/png',
        'bmV3'
      );
    })().finally(() => {
      replacementSettled = true;
    });
    await secondAttempted;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(replacementSettled).toBe(false);

    resumeCleanup();
    await rollback;
    await replace;

    await expect(
      secondStore.getAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png')
    ).resolves.toBe('bmV3');
    expect(await readAttachmentDataFiles(taskDirectory)).toEqual([ATTACHMENT_FILE]);
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

  it('serializes task directory cleanup against a different attachment save', async () => {
    await createRealStore();
    const firstStore = new TeamTaskAttachmentStore(
      undefined,
      new NodeTaskAttachmentMutationCoordinator()
    );
    const secondCoordinator = new NodeTaskAttachmentMutationCoordinator();
    let notifySecondAttempted!: () => void;
    const secondAttempted = new Promise<void>((resolve) => {
      notifySecondAttempted = resolve;
    });
    const secondStore = new TeamTaskAttachmentStore(undefined, {
      run(mutationKey, operation) {
        notifySecondAttempted();
        return secondCoordinator.run(mutationKey, operation);
      },
    });
    const receipt = await firstStore.saveAttachmentWithReceipt(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'old.png',
      'image/png',
      'b2xk'
    );
    const originalRmdir = fsPromises.rmdir.bind(fsPromises);
    let notifyCleanupStarted!: () => void;
    let resumeCleanup!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => {
      notifyCleanupStarted = resolve;
    });
    const cleanupResume = new Promise<void>((resolve) => {
      resumeCleanup = resolve;
    });
    const rmdir = vi.spyOn(fsPromises, 'rmdir').mockImplementationOnce(async (directory) => {
      notifyCleanupStarted();
      await cleanupResume;
      await originalRmdir(directory);
    });

    try {
      const rollback = firstStore.rollbackAttachment(receipt);
      await cleanupStarted;
      let saveSettled = false;
      const save = secondStore
        .saveAttachment(
          'my-team',
          'task-1',
          OTHER_ATTACHMENT_ID,
          'other.png',
          'image/png',
          'b3RoZXI='
        )
        .finally(() => {
          saveSettled = true;
        });
      await secondAttempted;
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(saveSettled).toBe(false);

      resumeCleanup();
      await rollback;
      await save;
    } finally {
      resumeCleanup();
      rmdir.mockRestore();
    }

    await expect(
      secondStore.getAttachment('my-team', 'task-1', OTHER_ATTACHMENT_ID, 'image/png')
    ).resolves.toBe('b3RoZXI=');
  });
});
