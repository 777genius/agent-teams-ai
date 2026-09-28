import {
  executeReviewFileTransaction,
  finalizeReviewFileTransaction,
  inspectReviewFileTransaction,
  isOwnedReviewFileTransactionHardlink,
  prepareReviewFileTransaction,
  resumePreparedReviewFileTransaction,
} from '@main/utils/atomicWrite';
import * as fs from 'fs';
import { link, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('review file transaction safe E2E', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'review-file-transaction-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function transactionArtifacts(targetPath: string): Promise<string[]> {
    const entries = await readdir(dirname(targetPath), { withFileTypes: true });
    const transactionDir = entries.find(
      (entry) => entry.isDirectory() && entry.name.startsWith('.review-txn-')
    );
    if (!transactionDir) return [];
    return readdir(join(dirname(targetPath), transactionDir.name));
  }

  it('retains inode evidence until the durable checkpoint finalizes a replacement', async () => {
    const filePath = join(root, 'replace.ts');
    await writeFile(filePath, 'before\n', 'utf8');
    const identity = await lstat(filePath);
    const transaction = await prepareReviewFileTransaction(
      {
        kind: 'replace',
        sourcePath: filePath,
        targetPath: filePath,
        expectedContent: 'before\n',
        nextContent: 'after\n',
      },
      { mode: 0o644 }
    );

    await executeReviewFileTransaction(transaction, { expectedIdentity: identity });

    await expect(readFile(filePath, 'utf8')).resolves.toBe('after\n');
    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('published');
    await expect(isOwnedReviewFileTransactionHardlink(filePath)).resolves.toBe(true);
    expect(await transactionArtifacts(filePath)).toEqual(
      expect.arrayContaining(['after.tmp', 'before.link', 'detached', 'manifest.json'])
    );

    await finalizeReviewFileTransaction(transaction);

    await expect(isOwnedReviewFileTransactionHardlink(filePath)).resolves.toBe(false);
    expect((await lstat(filePath)).nlink).toBe(1);
    expect(await transactionArtifacts(filePath)).toEqual([]);
  });

  it('treats a swapped published target as conflicted transaction evidence', async () => {
    const filePath = join(root, 'published-swap.ts');
    const externalPath = join(root, 'published-external.tmp');
    await writeFile(filePath, 'before\n', 'utf8');
    await writeFile(externalPath, 'external\n', 'utf8');
    const transaction = await prepareReviewFileTransaction({
      kind: 'replace',
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    });
    await executeReviewFileTransaction(transaction);

    await rm(filePath);
    await rename(externalPath, filePath);

    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('conflict');
    await expect(finalizeReviewFileTransaction(transaction)).rejects.toThrow(
      'not durably published'
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe('external\n');
  });

  it('preserves an external replacement that lands after the before-link capture', async () => {
    const filePath = join(root, 'replace-race.ts');
    const externalPath = join(root, 'external.tmp');
    await writeFile(filePath, 'before\n', 'utf8');
    await writeFile(externalPath, 'external\n', 'utf8');
    const identity = await lstat(filePath);
    const transaction = await prepareReviewFileTransaction({
      kind: 'replace',
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        expectedIdentity: identity,
        beforeDetach: () => rename(externalPath, filePath),
      })
    ).rejects.toThrow('changed during review update');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('external\n');
    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('conflict');
  });

  it('preserves a concurrently-created target and the detached reviewed version', async () => {
    const filePath = join(root, 'publish-race.ts');
    await writeFile(filePath, 'before\n', 'utf8');
    const transaction = await prepareReviewFileTransaction({
      kind: 'replace',
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        beforePublish: () => writeFile(filePath, 'external\n', { flag: 'wx' }),
      })
    ).rejects.toThrow('target appeared during publish');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('external\n');
    const transactionDir = (await readdir(root, { withFileTypes: true })).find(
      (entry) => entry.isDirectory() && entry.name.startsWith('.review-txn-')
    );
    expect(transactionDir).toBeDefined();
    await expect(readFile(join(root, transactionDir!.name, 'detached'), 'utf8')).resolves.toBe(
      'before\n'
    );
  });

  it('does not delete an external file swapped in immediately before detach', async () => {
    const filePath = join(root, 'delete-race.ts');
    const externalPath = join(root, 'delete-external.tmp');
    await writeFile(filePath, 'before\n', 'utf8');
    await writeFile(externalPath, 'external\n', 'utf8');
    const transaction = await prepareReviewFileTransaction({
      kind: 'delete',
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: null,
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        beforeDetach: () => rename(externalPath, filePath),
      })
    ).rejects.toThrow('changed during review update');

    await expect(readFile(filePath, 'utf8')).resolves.toBe('external\n');
  });

  it('resumes after a crash boundary between detach and no-clobber publish', async () => {
    const filePath = join(root, 'resume.ts');
    await writeFile(filePath, 'before\n', 'utf8');
    const input = {
      kind: 'replace' as const,
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    };
    const transaction = await prepareReviewFileTransaction(input);

    await expect(
      executeReviewFileTransaction(transaction, {
        beforePublish: async () => {
          throw new Error('simulated process stop');
        },
      })
    ).rejects.toThrow('simulated process stop');
    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('detached');

    const resumed = await resumePreparedReviewFileTransaction(input);

    expect(resumed?.id).toBe(transaction.id);
    await expect(readFile(filePath, 'utf8')).resolves.toBe('after\n');
    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('published');
  });

  it('does not overwrite a rename destination created after the source was detached', async () => {
    const sourcePath = join(root, 'new-name.ts');
    const targetPath = join(root, 'old-name.ts');
    await mkdir(dirname(sourcePath), { recursive: true });
    await writeFile(sourcePath, 'agent version\n', 'utf8');
    const transaction = await prepareReviewFileTransaction({
      kind: 'move',
      sourcePath,
      targetPath,
      expectedContent: 'agent version\n',
      nextContent: 'original version\n',
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        beforePublish: () => writeFile(targetPath, 'external\n', { flag: 'wx' }),
      })
    ).rejects.toThrow('target appeared during publish');

    await expect(readFile(targetPath, 'utf8')).resolves.toBe('external\n');
    const transactionDir = (await readdir(root, { withFileTypes: true })).find(
      (entry) => entry.isDirectory() && entry.name.startsWith('.review-txn-')
    );
    expect(transactionDir).toBeDefined();
    await expect(readFile(join(root, transactionDir!.name, 'detached'), 'utf8')).resolves.toBe(
      'agent version\n'
    );
  });

  it('publishes and finalizes a case-only move on a case-insensitive filesystem', async () => {
    const sourcePath = join(root, 'Source.ts');
    const targetPath = join(root, 'source.ts');
    await writeFile(sourcePath, 'before\n', 'utf8');
    const hasNativeAlias = Boolean(await lstat(targetPath).catch(() => null));
    const actualLstat = fs.promises.lstat.bind(fs.promises);
    // Linux CI uses a case-sensitive volume. Simulate its lookup alias while
    // keeping every transaction artifact and directory entry on real disk.
    const aliasLookup = hasNativeAlias
      ? null
      : vi.spyOn(fs.promises, 'lstat').mockImplementation(async (filePath) => {
          if (filePath !== sourcePath) return actualLstat(filePath);
          try {
            return await actualLstat(sourcePath);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return actualLstat(targetPath);
          }
        });
    const input = {
      kind: 'move' as const,
      sourcePath,
      targetPath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    };
    try {
      const transaction = await prepareReviewFileTransaction(input);
      await executeReviewFileTransaction(transaction);

      expect(await readdir(root)).toContain('source.ts');
      expect(await readdir(root)).not.toContain('Source.ts');
      await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('published');
      await finalizeReviewFileTransaction(transaction);
      await expect(readFile(targetPath, 'utf8')).resolves.toBe('after\n');
      expect(await transactionArtifacts(targetPath)).toEqual([]);
    } finally {
      aliasLookup?.mockRestore();
    }
  });

  it('still refuses a recreated source during a move publish', async () => {
    const sourcePath = join(root, 'moved.ts');
    const targetPath = join(root, 'restored.ts');
    await writeFile(sourcePath, 'before\n');
    const transaction = await prepareReviewFileTransaction({
      kind: 'move',
      sourcePath,
      targetPath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        beforePublish: () => writeFile(sourcePath, 'external\n'),
      })
    ).rejects.toThrow('source reappeared');
    await expect(readFile(sourcePath, 'utf8')).resolves.toBe('external\n');
    await expect(inspectReviewFileTransaction(transaction)).resolves.toBe('detached');
  });

  it('does not mistake a second hardlink for a case alias', async () => {
    const sourcePath = join(root, 'Hardlink.ts');
    const targetPath = join(root, 'restored.ts');
    await writeFile(sourcePath, 'before\n');
    const transaction = await prepareReviewFileTransaction({
      kind: 'move',
      sourcePath,
      targetPath,
      expectedContent: 'before\n',
      nextContent: 'after\n',
    });

    await expect(
      executeReviewFileTransaction(transaction, {
        beforePublish: async () => {
          const transactionDir = (await readdir(root)).find((entry) =>
            entry.startsWith('.review-txn-')
          );
          expect(transactionDir).toBeDefined();
          await link(join(root, transactionDir!, 'after.tmp'), sourcePath);
        },
      })
    ).rejects.toThrow('source reappeared');
    expect((await lstat(sourcePath)).ino).toBe((await lstat(targetPath)).ino);
  });

  it('fails closed for pre-existing hardlinked sources', async () => {
    const filePath = join(root, 'hardlink.ts');
    const linkedPath = join(root, 'hardlink-copy.ts');
    await writeFile(filePath, 'before\n', 'utf8');
    await link(filePath, linkedPath);
    const transaction = await prepareReviewFileTransaction({
      kind: 'delete',
      sourcePath: filePath,
      targetPath: filePath,
      expectedContent: 'before\n',
      nextContent: null,
    });

    await expect(executeReviewFileTransaction(transaction)).rejects.toThrow(
      'multiply-linked files'
    );
    await expect(readFile(filePath, 'utf8')).resolves.toBe('before\n');
    await expect(readFile(linkedPath, 'utf8')).resolves.toBe('before\n');
  });
});
