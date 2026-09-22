import { lstat, mkdtemp, mkdir, readFile, rename, rm, stat, utimes, writeFile } from 'fs/promises';
import * as fs from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { withAtomicCreateDirectoryAuthority } from '../../../src/main/utils/atomicCreateDirectoryAuthority';
import { withAtomicCreateCleanupCapacity } from '../../../src/main/utils/atomicCreateCleanupCapacity';
import {
  atomicCreateAsync,
  cleanupAtomicCreateTempLinks,
} from '../../../src/main/utils/atomicWrite';

const sandboxes: string[] = [];

async function sandbox(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'atomic-write-real-'));
  sandboxes.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('atomic-create cleanup real filesystem contracts', () => {
  it.runIf(process.platform === 'linux')(
    'fails closed before consuming a malformed admission publication without exact primitives',
    async () => {
      const directory = await sandbox();
      const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
      await writeFile(owner, '{torn-publication', { mode: 0o600 });
      const stale = new Date(Date.now() - 60_000);
      await utimes(owner, stale, stale);

      await expect(withAtomicCreateCleanupCapacity(directory, async () => undefined)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      await expect(readFile(owner, 'utf8')).resolves.toBe('{torn-publication');
    }
  );

  it.runIf(process.platform === 'linux')(
    'fails before mutating a live admission owner when exact primitives are unavailable',
    async () => {
      const directory = await sandbox();
      const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
      await writeFile(
        owner,
        JSON.stringify({
          version: 1,
          fence: '12345678-1234-1234-1234-123456789abc',
          pid: process.pid,
          incarnation: null,
        }),
        { mode: 0o600 }
      );

      await expect(
        withAtomicCreateCleanupCapacity(directory, async () => undefined)
      ).rejects.toThrow('lease admission requires exact-generation primitives');
      await expect(readFile(owner, 'utf8')).resolves.toContain('12345678-1234-1234-1234-123456789abc');
    },
    10_000
  );

  it.runIf(process.platform === 'linux')(
    'leaves the public pin untouched when Node lacks exact cleanup primitives',
    async () => {
      const directory = await sandbox();
      const target = path.join(directory, 'record.json');
      const published = await atomicCreateAsync(target, 'owned', {
        retainPin: true,
        requireTrustworthyIdentity: true,
      });
      expect(published.pinPath).toBeDefined();
      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      await expect(readFile(target, 'utf8')).resolves.toBe('owned');
      await expect(stat(published.pinPath!)).resolves.toBeDefined();
      expect(
        (await fs.promises.readdir(directory)).filter(
          (name) =>
            name.startsWith('.review-create-cleanup-') || name.startsWith('.atomic-create-retired-')
        )
      ).toEqual([]);
    }
  );

  it.runIf(process.platform === 'linux')(
    'retains a real crash-left attachment when no exact release primitive exists',
    async () => {
      const directory = await sandbox();
      const target = path.join(directory, 'record.json');
      const published = await atomicCreateAsync(target, 'owned', {
        retainPin: true,
        requireTrustworthyIdentity: true,
      });
      const nonce = '12345678-1234-1234-1234-123456789abc';
      const authority = '87654321-4321-4321-4321-cba987654321';
      const cleanupName = `.review-create-cleanup-${nonce}-${authority}-crash`;
      const cleanupDirectory = path.join(directory, cleanupName);
      await mkdir(cleanupDirectory, { mode: 0o700 });
      const attachmentName = path.basename(published.pinPath!);
      await rename(published.pinPath!, path.join(cleanupDirectory, attachmentName));
      const [directoryStats, attachmentStats] = await Promise.all([
        lstat(cleanupDirectory),
        lstat(path.join(cleanupDirectory, attachmentName)),
      ]);
      await writeFile(
        path.join(cleanupDirectory, '.atomic-create-recovery.json'),
        JSON.stringify({
          version: 1,
          nonce,
          cleanupAuthority: authority,
          directoryName: cleanupName,
          directoryIdentity: {
            dev: directoryStats.dev,
            ino: directoryStats.ino,
            birthtimeMs: directoryStats.birthtimeMs,
          },
          attachment: {
            name: attachmentName,
            identity: {
              dev: attachmentStats.dev,
              ino: attachmentStats.ino,
              birthtimeMs: attachmentStats.birthtimeMs,
              size: attachmentStats.size,
            },
          },
        }),
        { mode: 0o600 }
      );

      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );

      await expect(readFile(target, 'utf8')).resolves.toBe('owned');
      // Node cannot unlink an inode-bound generation. The detached attachment
      // remains behind scanner-visible recovery state instead of risking a
      // pathname delete of a successor.
      expect(
        (await fs.promises.readdir(directory)).some((name) =>
          name.startsWith('.review-create-cleanup-')
        )
      ).toBe(true);
    }
  );

  it.runIf(process.platform === 'linux')(
    'retains recordless and retired-journal crash state without exact directory release',
    async () => {
      const directory = await sandbox();
      const recordless = path.join(directory, '.review-create-cleanup-allocation-crash');
      const retired = path.join(
        directory,
        '.review-create-cleanup-retired-12345678-1234-1234-1234-123456789abc'
      );
      await mkdir(recordless, { mode: 0o700 });
      await mkdir(retired, { mode: 0o700 });
      const retiredStats = await lstat(retired);
      await writeFile(
        path.join(retired, '.atomic-create-directory-retirement.json'),
        JSON.stringify({
          version: 1,
          directoryIdentity: {
            dev: retiredStats.dev,
            ino: retiredStats.ino,
            birthtimeMs: retiredStats.birthtimeMs,
          },
        }),
        { mode: 0o600 }
      );
      const target = path.join(directory, 'record.json');
      const published = await atomicCreateAsync(target, 'owned', {
        retainPin: true,
        requireTrustworthyIdentity: true,
      });

      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );

      await expect(readFile(target, 'utf8')).resolves.toBe('owned');
      await expect(stat(published.pinPath!)).resolves.toBeDefined();
      expect(
        (await fs.promises.readdir(directory)).some((name) =>
          name.startsWith('.review-create-cleanup-retired-')
        )
      ).toBe(true);
    }
  );

  it.runIf(process.platform === 'linux')(
    'retains an authenticated retired journal when exact unlink is unavailable',
    async () => {
      const directory = await sandbox();
      const target = path.join(directory, 'record.json');
      const cleanupName = '.review-create-cleanup-retired-12345678-1234-1234-1234-123456789abc';
      const cleanupDirectory = path.join(directory, cleanupName);
      const journalName = '.atomic-create-directory-retirement.json';
      const retiredJournalName =
        '.atomic-create-directory-retirement-retired-87654321-4321-4321-4321-cba987654321';
      await writeFile(target, 'owned');
      await mkdir(cleanupDirectory, { mode: 0o700 });
      const cleanupStats = await lstat(cleanupDirectory);
      await writeFile(
        path.join(cleanupDirectory, journalName),
        JSON.stringify({
          version: 1,
          directoryIdentity: {
            dev: cleanupStats.dev,
            ino: cleanupStats.ino,
            birthtimeMs: cleanupStats.birthtimeMs,
          },
        }),
        { mode: 0o600 }
      );
      // This is the durable state left by a crash after journal retirement
      // succeeded but before its unlink reached the filesystem.
      await rename(
        path.join(cleanupDirectory, journalName),
        path.join(cleanupDirectory, retiredJournalName)
      );

      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );

      await expect(stat(cleanupDirectory)).resolves.toBeDefined();
      await expect(readFile(target, 'utf8')).resolves.toBe('owned');
    }
  );

  it.runIf(process.platform === 'linux')(
    'does not leak retained directory descriptors across repeated fail-closed cleanup',
    async () => {
      const directory = await sandbox();
      const before = (await fs.promises.readdir('/proc/self/fd')).length;
      for (let index = 0; index < 12; index++) {
        const target = path.join(directory, `record-${index}.json`);
        await atomicCreateAsync(target, 'owned', {
          retainPin: true,
          requireTrustworthyIdentity: true,
        });
        await expect(cleanupAtomicCreateTempLinks(target)).rejects.toBeDefined();
      }
      const after = (await fs.promises.readdir('/proc/self/fd')).length;
      expect(after).toBeLessThanOrEqual(before + 2);
    }
  );

  it.runIf(process.platform === 'linux')(
    'leaves a swapped private directory untouched when exact cleanup is unavailable',
    async () => {
      const directory = await sandbox();
      const target = path.join(directory, 'record.json');
      const published = await atomicCreateAsync(target, 'owned', {
        retainPin: true,
        requireTrustworthyIdentity: true,
      });
      const nonce = '12345678-1234-1234-1234-123456789abc';
      const authority = '87654321-4321-4321-4321-cba987654321';
      const cleanupName = `.review-create-cleanup-${nonce}-${authority}-swap`;
      const cleanupDirectory = path.join(directory, cleanupName);
      const movedDirectory = path.join(directory, 'moved-private-directory');
      await mkdir(cleanupDirectory, { mode: 0o700 });
      await rename(
        published.pinPath!,
        path.join(cleanupDirectory, path.basename(published.pinPath!))
      );
      await rename(cleanupDirectory, movedDirectory);
      await mkdir(cleanupDirectory, { mode: 0o700 });
      await writeFile(path.join(cleanupDirectory, 'foreign'), 'preserve');

      await expect(cleanupAtomicCreateTempLinks(target)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );

      await expect(readFile(target, 'utf8')).resolves.toBe('owned');
      await expect(readFile(path.join(cleanupDirectory, 'foreign'), 'utf8')).resolves.toBe('preserve');
    }
  );

  it.runIf(process.platform === 'linux')(
    'keeps an already-open directory authority when its parent name is replaced',
    async () => {
      const root = await sandbox();
      const original = path.join(root, 'original');
      const replacement = path.join(root, 'replacement');
      await mkdir(original);

      await withAtomicCreateDirectoryAuthority(original, async ({ stablePath }) => {
        expect(stablePath).toMatch(/^\/proc\/self\/fd\/\d+\/\.$/);
        await rename(original, replacement);
        await mkdir(original);
        await writeFile(path.join(stablePath, 'only-in-retained-directory'), 'retained');
      });

      await expect(
        readFile(path.join(replacement, 'only-in-retained-directory'), 'utf8')
      ).resolves.toBe('retained');
      await expect(stat(path.join(original, 'only-in-retained-directory'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  );

  it.runIf(process.platform === 'linux')(
    'does not create a lease when exact primitives are unavailable',
    async () => {
      const directory = await sandbox();
      await expect(withAtomicCreateCleanupCapacity(directory, async () => undefined)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      expect(
        (await fs.promises.readdir(directory)).filter((name) =>
          name.startsWith('.atomic-create-cleanup-lease-')
        )
      ).toEqual([]);
    }
  );

  it.runIf(process.platform === 'linux')(
    'does not reclaim a crashed predecessor through a pathname-only delete',
    async () => {
      const directory = await sandbox();
      const lease = path.join(directory, '.atomic-create-cleanup-lease-crashed');
      await mkdir(lease);
      const stale = new Date(Date.now() - 60_000);
      await utimes(lease, stale, stale);
      await expect(withAtomicCreateCleanupCapacity(directory, async () => undefined)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      await expect(stat(lease)).resolves.toBeDefined();
    }
  );

  it.runIf(process.platform === 'linux')(
    'retains a stale pre-owner lease and owner lock without exact primitives',
    async () => {
      const directory = await sandbox();
      const lease = path.join(directory, '.atomic-create-cleanup-lease-pre-owner-crash');
      await mkdir(lease);
      await mkdir(path.join(lease, 'owner.json.lock'));
      const stale = new Date(Date.now() - 60_000);
      await utimes(lease, stale, stale);

      await expect(withAtomicCreateCleanupCapacity(directory, async () => undefined)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      await expect(stat(lease)).resolves.toBeDefined();
    }
  );

  it.runIf(process.platform === 'linux')(
    'does not consume an aged torn owner record without exact primitives',
    async () => {
      const directory = await sandbox();
      const lease = path.join(directory, '.atomic-create-cleanup-lease-torn-owner');
      await mkdir(lease);
      await writeFile(path.join(lease, 'owner.json'), '{"version":1,"pid":');
      const stale = new Date(Date.now() - 60_000);
      await utimes(lease, stale, stale);

      await expect(withAtomicCreateCleanupCapacity(directory, async () => undefined)).rejects.toThrow(
        'lease admission requires exact-generation primitives'
      );
      await expect(stat(lease)).resolves.toBeDefined();
    }
  );
});
