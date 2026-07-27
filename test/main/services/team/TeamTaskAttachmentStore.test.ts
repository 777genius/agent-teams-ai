import { execFile } from 'node:child_process';
import { promises as fsPromises } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AddTaskCommentUseCase } from '../../../../src/features/team-task-board/core/application/use-cases/AddTaskCommentUseCase';
import { TeamTaskCommentAttachmentWriter } from '../../../../src/features/team-task-board/main/adapters/output/TeamTaskCommentAttachmentWriter';
import { TaskAttachmentDeletionJournal } from '../../../../src/main/services/team/TaskAttachmentDeletionJournal';
import { removeTaskAttachmentGenerationPin } from '../../../../src/main/services/team/TaskAttachmentGenerationLifecycle';
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
    createPinnedFileAtomically: vi.fn(async (filePath) => ({
      identity: { dev: 1, ino: 2, birthtimeMs: 3, size: 4 },
      generationGuardPath: join(
        dirname(filePath),
        '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp'
      ),
    })),
    cleanupPublishedTempLinks: vi.fn(() => Promise.resolve()),
  };
}

async function createPinnedFileAtomically(
  filePath: string,
  data: Buffer
): Promise<{
  identity: { dev: number; ino: number; birthtimeMs: number; size: number };
  generationGuardPath: string;
}> {
  const created = await atomicCreateAsync(filePath, data, { retainPin: true });
  return {
    identity: {
      dev: created.dev,
      ino: created.ino,
      birthtimeMs: created.birthtimeMs,
      size: created.size,
    },
    generationGuardPath: created.pinPath!,
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

  async function createRealStore(deletionJournal?: TaskAttachmentDeletionJournal): Promise<{
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
      store: new TeamTaskAttachmentStore(undefined, undefined, deletionJournal),
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

    const [filePath, bytes] =
      vi.mocked(atomicCreator.createPinnedFileAtomically).mock.calls[0] ?? [];
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
    vi.mocked(atomicCreator.createPinnedFileAtomically).mockRejectedValueOnce(failure);
    const store = createUnitStore(atomicCreator);

    await expect(
      store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'proof.png', 'image/png', 'dGVzdA==')
    ).rejects.toBe(failure);
  });

  it('does not publish an attachment when pinned creation fails', async () => {
    const { taskDirectory } = await createRealStore();
    const failure = new Error('pinned create failed');
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createPinnedFileAtomically: vi.fn(async () => Promise.reject(failure)),
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

  it('never deletes a replacement generation while rolling back a stale receipt', async () => {
    const { store, taskDirectory } = await createRealStore();
    const receipt = await store.saveAttachmentWithReceipt(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'old.png',
      'image/png',
      'b2xk'
    );
    await fsPromises.unlink(receipt.filePath);
    await writeFile(receipt.filePath, 'replacement');

    await store.rollbackAttachment(receipt);

    await expect(readFile(receipt.filePath, 'utf8')).resolves.toBe('replacement');
    expect(await readdir(taskDirectory)).toEqual([ATTACHMENT_FILE]);
  });

  it('removes the identity-matched target even when temp-link cleanup fails', async () => {
    const { taskDirectory } = await createRealStore();
    const cleanupFailure = new Error('temp cleanup failed');
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createPinnedFileAtomically,
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

    await expect(store.rollbackAttachment(receipt)).resolves.toBeUndefined();

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

  it('retains its zero-inode pin and fails closed without deleting the public generation', async () => {
    const { taskDirectory } = await createRealStore();
    const generationGuardPath = join(
      taskDirectory,
      '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp'
    );
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      async createPinnedFileAtomically(filePath, data) {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, data, { flag: 'wx' });
        await fsPromises.link(filePath, generationGuardPath);
        const stats = await fsPromises.lstat(generationGuardPath);
        return {
          identity: {
            dev: stats.dev,
            ino: 0,
            birthtimeMs: stats.birthtimeMs,
            size: stats.size,
          },
          generationGuardPath,
        };
      },
      cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
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
    await store.finalizeAttachment(receipt);
    expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain(
      'Task attachment generation pin identity is not trustworthy'
    );
    vi.mocked(console.warn).mockClear();
    expect((await readdir(taskDirectory)).sort()).toEqual(
      [basename(generationGuardPath), ATTACHMENT_FILE].sort()
    );

    await expect(store.rollbackAttachment(receipt)).rejects.toThrow(
      'Task attachment generation pin identity is not trustworthy'
    );
    expect((await readdir(taskDirectory)).sort()).toEqual(
      [basename(generationGuardPath), ATTACHMENT_FILE].sort()
    );
    await expect(readFile(receipt.filePath, 'utf8')).resolves.toBe('test');
  });

  it('never treats a transaction-owned pin name as proof for a zero-inode replacement', async () => {
    const { taskDirectory } = await createRealStore();
    await mkdir(taskDirectory, { recursive: true });
    const pinPath = join(taskDirectory, '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp');
    await writeFile(pinPath, 'old generation', 'utf8');
    const original = await fsPromises.lstat(pinPath);
    const untrustedIdentity = {
      dev: original.dev,
      ino: 0,
      birthtimeMs: original.birthtimeMs,
      size: original.size,
    };
    await fsPromises.unlink(pinPath);
    await writeFile(pinPath, 'replacement!!', 'utf8');

    await expect(removeTaskAttachmentGenerationPin(pinPath, untrustedIdentity)).rejects.toThrow(
      'Task attachment generation pin identity is not trustworthy'
    );
    await expect(readFile(pinPath, 'utf8')).resolves.toBe('replacement!!');
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
        const receipt = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
        metadataDeleted = true;
        compromise(lockFailure);
        transaction.markCommitted();
        if (receipt) await transaction.finalizeAttachmentDeletion(receipt);
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
    expect(atomicCreator.createPinnedFileAtomically).not.toHaveBeenCalled();
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
      expect(atomicCreator.createPinnedFileAtomically).not.toHaveBeenCalled();
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

  it('recovers a committed deletion after transient generation cleanup failure', async () => {
    const { root, taskDirectory } = await createRealStore();
    const atomicCreator: TaskAttachmentAtomicCreatorPort = {
      createPinnedFileAtomically,
      cleanupPublishedTempLinks: cleanupAtomicCreateTempLinks,
    };
    const store = new TeamTaskAttachmentStore(atomicCreator);
    const originalUnlink = fsPromises.unlink.bind(fsPromises);
    let injectCleanupFailure = false;
    let tempUnlinkFailures = 0;
    const unlink = vi.spyOn(fsPromises, 'unlink').mockImplementation(async (filePath) => {
      if (
        injectCleanupFailure &&
        basename(String(filePath)).startsWith('.review-create.') &&
        tempUnlinkFailures < 1
      ) {
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
      injectCleanupFailure = true;

      await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');

      expect(await readFile(join(taskDirectory, ATTACHMENT_FILE), 'utf8')).toBe('test');
      expect(vi.mocked(console.warn).mock.calls.flat().join(' ')).toContain(
        'Deferred task attachment deletion'
      );
      vi.mocked(console.warn).mockClear();
      const journalDirectory = join(root, 'task-attachment-deletion-intents');
      expect(await readdir(journalDirectory)).toHaveLength(1);
      expect(await store.getTaskAttachmentBackupExclusions('my-team', async () => false)).toContain(
        join(taskDirectory, ATTACHMENT_FILE)
      );

      const recoveryStore = new TeamTaskAttachmentStore();
      await recoveryStore.reconcilePendingAttachmentDeletions(async () => false);

      await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readdir(journalDirectory)).toHaveLength(1);
      await recoveryStore.completePendingTaskAttachmentDeletions('my-team');
      expect(await readdir(journalDirectory)).toEqual([]);
    } finally {
      unlink.mockRestore();
    }
  });

  it('recovers a prepared intent after metadata committed before file finalization', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const receipt = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      expect(receipt).not.toBeNull();
      transaction.markCommitted();
      // Simulates termination after durable metadata deletion and before finalize().
    });

    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    expect(await readdir(journalDirectory)).toHaveLength(1);
    expect(await readdir(taskDirectory)).toHaveLength(2);

    const recoveryStore = new TeamTaskAttachmentStore();
    await recoveryStore.reconcilePendingAttachmentDeletions(async () => false);
    await recoveryStore.reconcilePendingAttachmentDeletions(async () => false);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(journalDirectory)).toHaveLength(1);
    await recoveryStore.completePendingTaskAttachmentDeletions('my-team');
    await recoveryStore.completePendingTaskAttachmentDeletions('my-team');
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it('does not let stale compensation abort an intent another owner committed', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      return prepared;
    });
    const committingOwner = new TaskAttachmentDeletionJournal();
    const staleOwner = new TaskAttachmentDeletionJournal();
    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (
        String(source) === receipt.intent.originalPath &&
        String(target) === receipt.intent.detachedPath
      ) {
        throw Object.assign(new Error('injected detach pause'), { code: 'EBUSY' });
      }
      await originalRename(source, target);
    });
    try {
      await expect(committingOwner.finalize(receipt.intent)).rejects.toMatchObject({
        code: 'EBUSY',
      });
    } finally {
      rename.mockRestore();
    }

    const journalPath = join(
      root,
      'task-attachment-deletion-intents',
      `${receipt.intent.transactionId}.json`
    );
    await expect(staleOwner.abort(receipt.intent)).rejects.toThrow(
      'Cannot abort task attachment deletion in committed phase'
    );
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "committed"');
    await expect(fsPromises.stat(receipt.generation.pinPath)).resolves.toBeDefined();
    await expect(readFile(receipt.generation.originalPath, 'utf8')).resolves.toBe('test');
  });

  it('replays a committed intent persisted before attachment detachment', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      transaction.markCommitted();
    });
    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    const [journalName] = await readdir(journalDirectory);
    if (!journalName) throw new Error('Expected a deletion intent');
    const journalPath = join(journalDirectory, journalName);
    const intent = JSON.parse(await readFile(journalPath, 'utf8')) as {
      phase: string;
      updatedAt: string;
    };
    intent.phase = 'committed';
    intent.updatedAt = new Date().toISOString();
    await writeFile(journalPath, JSON.stringify(intent, null, 2), 'utf8');

    const recoveryStore = new TeamTaskAttachmentStore();
    await recoveryStore.reconcilePendingAttachmentDeletions(async () => false);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(journalDirectory)).toHaveLength(1);
    await recoveryStore.completePendingTaskAttachmentDeletions('my-team');
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it('retains the journal and generation pin when no durable removal proof remains', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      transaction.markCommitted();
      return prepared;
    });
    const journalPath = join(
      root,
      'task-attachment-deletion-intents',
      `${receipt.intent.transactionId}.json`
    );
    const persisted = JSON.parse(await readFile(journalPath, 'utf8')) as {
      phase: string;
      updatedAt: string;
    };
    persisted.phase = 'committed';
    persisted.updatedAt = new Date().toISOString();
    await writeFile(journalPath, JSON.stringify(persisted, null, 2), 'utf8');
    await fsPromises.unlink(receipt.generation.originalPath);

    await expect(new TaskAttachmentDeletionJournal().finalize(receipt.intent)).rejects.toThrow(
      'Task attachment deletion has no durable removal proof'
    );
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "committed"');
    await expect(fsPromises.lstat(receipt.generation.pinPath)).resolves.toBeDefined();
  });

  it('recovers after a crash immediately after durable removal receipt publication', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      transaction.markCommitted();
      return prepared;
    });
    const crash = new Error('simulated crash after durable removal receipt');
    const crashingJournal = new TaskAttachmentDeletionJournal(
      async () => undefined,
      async () => {
        throw crash;
      }
    );

    await expect(crashingJournal.finalize(receipt.intent)).rejects.toBe(crash);
    const journalPath = join(
      root,
      'task-attachment-deletion-intents',
      `${receipt.intent.transactionId}.json`
    );
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "removed"');
    await expect(fsPromises.lstat(receipt.generation.originalPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fsPromises.lstat(receipt.intent.detachedPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fsPromises.lstat(receipt.generation.pinPath)).resolves.toBeDefined();
    await writeFile(receipt.generation.originalPath, 'replacement', 'utf8');

    await expect(
      new TeamTaskAttachmentStore().reconcilePendingAttachmentDeletions(async () => false)
    ).resolves.toBeUndefined();

    await expect(readFile(receipt.generation.originalPath, 'utf8')).resolves.toBe('replacement');
    await expect(fsPromises.lstat(receipt.generation.pinPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "removed"');
  });

  it('retains a tombstone when its completion generation expires inside the task lock', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    expect(await readdir(journalDirectory)).toHaveLength(1);
    let generationCurrent = true;
    let releaseReferenceRead!: () => void;
    let reportReferenceRead!: () => void;
    const referenceRead = new Promise<void>((resolve) => {
      reportReferenceRead = resolve;
    });
    const referenceReadRelease = new Promise<void>((resolve) => {
      releaseReferenceRead = resolve;
    });

    const completion = store.completePendingTaskAttachmentDeletions(
      'my-team',
      async () => {
        reportReferenceRead();
        await referenceReadRelease;
        return false;
      },
      new Map(),
      undefined,
      () => generationCurrent
    );
    await referenceRead;
    generationCurrent = false;
    releaseReferenceRead();
    await completion;

    expect(await readdir(journalDirectory)).toHaveLength(1);
  });

  it('rechecks the generation synchronously after journal validation before unlink', async () => {
    let generationCurrent = true;
    let validationBoundaries = 0;
    const journal = new TaskAttachmentDeletionJournal(undefined, undefined, () => {
      validationBoundaries += 1;
      generationCurrent = false;
    });
    const { root, store } = await createRealStore(journal);
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');

    await store.completePendingTaskAttachmentDeletions(
      'my-team',
      async () => false,
      new Map(),
      undefined,
      () => generationCurrent
    );

    expect(validationBoundaries).toBe(1);
    expect(await readdir(join(root, 'task-attachment-deletion-intents'))).toEqual([
      expect.stringMatching(/^[0-9a-f-]+\.json$/),
    ]);
  });

  it('recovers a deterministic journal completion detach after a crash', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
    const [intent] = await new TaskAttachmentDeletionJournal().loadAll();
    const crash = new Error('simulated crash at journal completion boundary');
    const crashingJournal = new TaskAttachmentDeletionJournal(undefined, undefined, () => {
      throw crash;
    });

    await expect(crashingJournal.complete(intent!)).rejects.toBe(crash);
    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    expect(await readdir(journalDirectory)).toEqual([`${intent!.transactionId}.completion.json`]);
    const recoveryJournal = new TaskAttachmentDeletionJournal();
    const recovered = await recoveryJournal.loadAll();
    expect(recovered).toHaveLength(1);
    await recoveryJournal.complete(recovered[0]!);
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it('deduplicates an exact canonical and detached journal generation', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
    const journal = new TaskAttachmentDeletionJournal();
    const [intent] = await journal.loadAll();
    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    const canonicalPath = join(journalDirectory, `${intent!.transactionId}.json`);
    const detachedPath = join(journalDirectory, `${intent!.transactionId}.completion.json`);
    await fsPromises.link(canonicalPath, detachedPath);

    expect(await journal.loadAll()).toHaveLength(1);
    await journal.complete(intent!);
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it('resumes removal when rename detached the target but reported ENOENT', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      transaction.markCommitted();
      return prepared;
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (
        String(source) === receipt.intent.originalPath &&
        String(target) === receipt.intent.detachedPath
      ) {
        await originalRename(source, target);
        throw Object.assign(new Error('simulated detached rename ambiguity'), {
          code: 'ENOENT',
        });
      }
      await originalRename(source, target);
    });
    try {
      await new TaskAttachmentDeletionJournal().finalize(receipt.intent);
    } finally {
      rename.mockRestore();
    }

    expect(await readdir(taskDirectory)).toEqual([]);
    const [journalName] = await readdir(join(root, 'task-attachment-deletion-intents'));
    await expect(
      readFile(join(root, 'task-attachment-deletion-intents', journalName!), 'utf8')
    ).resolves.toContain('"phase": "removed"');
  });

  it('lets one of two concurrent finalizers prove durable removal without losing recovery state', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      transaction.markCommitted();
      return prepared;
    });
    let releaseFirstRename!: () => void;
    let reportFirstDetach!: () => void;
    const firstDetach = new Promise<void>((resolve) => {
      reportFirstDetach = resolve;
    });
    const firstRenameRelease = new Promise<void>((resolve) => {
      releaseFirstRename = resolve;
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    let attachmentRenameCount = 0;
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      await originalRename(source, target);
      if (
        String(source) === receipt.intent.originalPath &&
        String(target) === receipt.intent.detachedPath &&
        attachmentRenameCount++ === 0
      ) {
        reportFirstDetach();
        await firstRenameRelease;
      }
    });
    try {
      const first = new TaskAttachmentDeletionJournal().finalize(receipt.intent);
      await firstDetach;
      const second = new TaskAttachmentDeletionJournal().finalize(receipt.intent);
      await second;
      releaseFirstRename();
      const outcomes = await Promise.allSettled([first, second]);
      expect(outcomes.some((outcome) => outcome.status === 'fulfilled')).toBe(true);
    } finally {
      releaseFirstRename();
      rename.mockRestore();
    }

    const [journalName] = await readdir(join(root, 'task-attachment-deletion-intents'));
    await expect(
      readFile(join(root, 'task-attachment-deletion-intents', journalName!), 'utf8')
    ).resolves.toContain('"phase": "removed"');
    await expect(fsPromises.lstat(receipt.generation.pinPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('keeps the canonical prepared intent when phase publication fails before rename', async () => {
    const { root, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    const receipt = await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      const prepared = await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      if (!prepared) throw new Error('Expected a prepared deletion');
      transaction.markCommitted();
      return prepared;
    });
    const journalPath = join(
      root,
      'task-attachment-deletion-intents',
      `${receipt.intent.transactionId}.json`
    );
    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (String(target) === journalPath && basename(String(source)).startsWith('.tmp.')) {
        throw Object.assign(new Error('simulated phase publication crash'), {
          code: 'ENOSPC',
        });
      }
      await originalRename(source, target);
    });
    try {
      await expect(new TaskAttachmentDeletionJournal().finalize(receipt.intent)).rejects.toThrow(
        'simulated phase publication crash'
      );
    } finally {
      rename.mockRestore();
    }

    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "prepared"');
    const [recovered] = await new TaskAttachmentDeletionJournal().loadAll();
    expect(recovered?.transactionId).toBe(receipt.intent.transactionId);
    await expect(new TaskAttachmentDeletionJournal().finalize(recovered!)).resolves.toBeUndefined();
    await expect(readFile(journalPath, 'utf8')).resolves.toContain('"phase": "removed"');
  });

  it('resumes an exact generation already detached before process termination', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );
    await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      transaction.markCommitted();
    });

    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    const [journalName] = await readdir(journalDirectory);
    if (!journalName) throw new Error('Expected a deletion intent');
    const journalPath = join(journalDirectory, journalName);
    const intent = JSON.parse(await readFile(journalPath, 'utf8')) as {
      detachedPath: string;
      phase: string;
      updatedAt: string;
    };
    intent.phase = 'detached';
    intent.updatedAt = new Date().toISOString();
    await writeFile(journalPath, JSON.stringify(intent, null, 2), 'utf8');
    await fsPromises.rename(join(taskDirectory, ATTACHMENT_FILE), intent.detachedPath);

    const recoveryStore = new TeamTaskAttachmentStore();
    await recoveryStore.reconcilePendingAttachmentDeletions(async () => false);

    await expect(readdir(taskDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(journalDirectory)).toHaveLength(1);
    await recoveryStore.completePendingTaskAttachmentDeletions('my-team');
    expect(await readdir(journalDirectory)).toEqual([]);
  });

  it('rolls back a prepared intent when metadata still references the attachment', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'proof.png',
      'image/png',
      'dGVzdA=='
    );

    await store.runTaskTransaction('my-team', 'task-1', async (transaction) => {
      await transaction.prepareAttachmentDeletion(ATTACHMENT_ID, 'image/png');
      transaction.markCommitted();
    });
    await new TeamTaskAttachmentStore().reconcilePendingAttachmentDeletions(async () => true);

    expect(await readFile(join(taskDirectory, ATTACHMENT_FILE), 'utf8')).toBe('test');
    expect(await readdir(taskDirectory)).toEqual([ATTACHMENT_FILE]);
    expect(await readdir(join(root, 'task-attachment-deletion-intents'))).toEqual([]);
  });

  it('keeps a tombstone until a referenced replacement generation is backed up', async () => {
    const { root, taskDirectory, store } = await createRealStore();
    await store.saveAttachment('my-team', 'task-1', ATTACHMENT_ID, 'old.png', 'image/png', 'b2xk');
    await store.deleteAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png');
    await store.saveAttachment(
      'my-team',
      'task-1',
      ATTACHMENT_ID,
      'replacement.png',
      'image/png',
      'cmVwbGFjZW1lbnQ='
    );
    const journalDirectory = join(root, 'task-attachment-deletion-intents');

    await expect(
      store.getTaskAttachmentBackupExclusions('my-team', async () => true)
    ).resolves.toEqual(new Set());
    await store.completePendingTaskAttachmentDeletions('my-team', async () => true);
    expect(await readdir(journalDirectory)).toHaveLength(1);

    const replacementPath = join(taskDirectory, ATTACHMENT_FILE);
    const replacement = await fsPromises.lstat(replacementPath);
    await store.completePendingTaskAttachmentDeletions(
      'my-team',
      async () => true,
      new Map([
        [
          replacementPath,
          {
            dev: replacement.dev,
            ino: replacement.ino,
            birthtimeMs: replacement.birthtimeMs,
            size: replacement.size,
          },
        ],
      ])
    );
    expect(await readdir(journalDirectory)).toEqual([]);
    expect(await readFile(join(taskDirectory, ATTACHMENT_FILE), 'utf8')).toBe('replacement');
  });

  it('fails closed on a truncated deletion journal', async () => {
    const { root, store } = await createRealStore();
    const journalDirectory = join(root, 'task-attachment-deletion-intents');
    await mkdir(journalDirectory, { recursive: true });
    await writeFile(
      join(journalDirectory, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.json'),
      '{"version":1,"transactionId":',
      'utf8'
    );

    await expect(store.reconcilePendingAttachmentDeletions(async () => false)).rejects.toThrow(
      'Corrupt task attachment deletion intent'
    );
    await expect(
      store.getTaskAttachmentBackupExclusions('my-team', async () => false)
    ).rejects.toThrow('Corrupt task attachment deletion intent');
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
    const { store: firstStore, taskDirectory } = await createRealStore();
    let notifyDetachStarted!: () => void;
    let resumeDetach!: () => void;
    const detachStarted = new Promise<void>((resolve) => {
      notifyDetachStarted = resolve;
    });
    const detachResume = new Promise<void>((resolve) => {
      resumeDetach = resolve;
    });
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

    const originalRename = fsPromises.rename.bind(fsPromises);
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (
        String(source) === receipt.filePath &&
        basename(String(target)).startsWith('.attachment-delete.')
      ) {
        notifyDetachStarted();
        await detachResume;
      }
      await originalRename(source, target);
    });
    try {
      const rollback = firstStore.rollbackAttachment(receipt);
      await detachStarted;
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

      resumeDetach();
      await rollback;
      await replace;
    } finally {
      rename.mockRestore();
    }

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

  it('retries a failed comment rollback through the transaction guard compensation', async () => {
    const { store, taskDirectory } = await createRealStore();
    const failure = new Error('comment write failed');
    const logger = { warn: vi.fn() };
    const useCase = new AddTaskCommentUseCase({
      comments: {
        addTaskComment: vi.fn(async () => {
          throw failure;
        }),
      },
      attachments: new TeamTaskCommentAttachmentWriter(store),
      logger,
    });
    const originalRename = fsPromises.rename.bind(fsPromises);
    let rollbackFailuresRemaining = 1;
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (
        rollbackFailuresRemaining > 0 &&
        String(source) === join(taskDirectory, ATTACHMENT_FILE) &&
        basename(String(target)).startsWith('.attachment-delete.')
      ) {
        rollbackFailuresRemaining -= 1;
        throw Object.assign(new Error('transient rollback failure'), { code: 'EBUSY' });
      }
      await originalRename(source, target);
    });
    try {
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
    } finally {
      rename.mockRestore();
    }

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('transient rollback failure'));
    await expect(
      store.getAttachment('my-team', 'task-1', ATTACHMENT_ID, 'image/png')
    ).resolves.toBeNull();
  });

  it('aggregates an ordinary comment failure when guard compensation also fails', async () => {
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
    const originalRename = fsPromises.rename.bind(fsPromises);
    const cleanupFailure = Object.assign(new Error('persistent rollback failure'), {
      code: 'EBUSY',
    });
    const rename = vi.spyOn(fsPromises, 'rename').mockImplementation(async (source, target) => {
      if (
        String(source) === join(taskDirectory, ATTACHMENT_FILE) &&
        basename(String(target)).startsWith('.attachment-delete.')
      ) {
        throw cleanupFailure;
      }
      await originalRename(source, target);
    });
    let result: unknown;
    try {
      result = await useCase
        .execute('my-team', 'task-1', {
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
        .catch((error: unknown) => error);
    } finally {
      rename.mockRestore();
    }

    expect(result).toBeInstanceOf(AggregateError);
    expect((result as AggregateError).errors).toEqual([failure, cleanupFailure]);
    expect((await readdir(taskDirectory)).some((entry) => entry === ATTACHMENT_FILE)).toBe(true);
    expect(
      (await readdir(taskDirectory)).some((entry) => entry.startsWith('.review-create.'))
    ).toBe(true);
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
