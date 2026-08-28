import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getSqliteTransactionLockDatabasePath,
  isSqliteTransactionLockArtifactName,
  setSqliteTransactionLockTestHooksForTests,
  tryRetainSqliteTransactionLock,
  withSqliteTransactionLock,
} from '@main/services/infrastructure/SqliteTransactionLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });

const LOCK_OPTIONS = {
  acquireTimeoutMs: 1_000,
  retryIntervalMs: 1,
  timeoutMessage: 'lock timeout',
  ownershipLostMessage: 'lock ownership lost',
};

describe('SqliteTransactionLock artifact lifecycle', () => {
  let temporaryRoot: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-transaction-lock-'));
  });

  afterEach(() => {
    setSqliteTransactionLockTestHooksForTests(undefined);
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('keeps its own and a concurrent live owner database out of bounded cleanup', async () => {
    const liveTarget = path.join(temporaryRoot, 'live-owner.json');
    const cleanupTarget = path.join(temporaryRoot, 'cleanup.json');
    const liveDatabase = getSqliteTransactionLockDatabasePath(liveTarget);
    const cleanupDatabase = getSqliteTransactionLockDatabasePath(cleanupTarget);
    fs.writeFileSync(liveTarget, 'live');
    fs.writeFileSync(cleanupTarget, 'cleanup');
    fs.writeFileSync(path.join(temporaryRoot, 'per-run-evidence.json'), 'transient');

    let releaseLiveOwner!: () => void;
    let markLiveOwnerStarted!: () => void;
    const liveOwnerStarted = new Promise<void>((resolve) => {
      markLiveOwnerStarted = resolve;
    });
    const liveOwner = withSqliteTransactionLock(
      liveDatabase,
      async () => {
        markLiveOwnerStarted();
        await new Promise<void>((resolve) => {
          releaseLiveOwner = resolve;
        });
      },
      LOCK_OPTIONS
    );
    await liveOwnerStarted;

    try {
      await withSqliteTransactionLock(
        cleanupDatabase,
        async () => {
          for (const entry of fs.readdirSync(temporaryRoot)) {
            if (!isSqliteTransactionLockArtifactName(entry)) {
              fs.rmSync(path.join(temporaryRoot, entry), { recursive: true, force: true });
            }
          }
        },
        LOCK_OPTIONS
      );

      expect(fs.existsSync(path.join(temporaryRoot, 'per-run-evidence.json'))).toBe(false);
      expect(fs.statSync(cleanupDatabase).isFile()).toBe(true);
      expect(fs.statSync(liveDatabase).isFile()).toBe(true);
    } finally {
      releaseLiveOwner();
    }

    await expect(liveOwner).resolves.toBeUndefined();
  });

  it('recognizes only the explicit database and SQLite sidecar namespace', () => {
    expect(getSqliteTransactionLockDatabasePath('/tmp/state.json')).toBe(
      '/tmp/state.json.lock.sqlite3'
    );
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3')).toBe(true);
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3-journal')).toBe(true);
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3-shm')).toBe(true);
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3-wal')).toBe(true);
    expect(
      isSqliteTransactionLockArtifactName(
        'state.json.lock.sqlite3.custody-0123456789abcdef0123456789abcdef'
      )
    ).toBe(true);
    expect(
      isSqliteTransactionLockArtifactName(
        'state.json.lock.sqlite3.custody-0123456789abcdef0123456789abcdef-journal'
      )
    ).toBe(true);
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3.custody-short')).toBe(
      false
    );
    expect(isSqliteTransactionLockArtifactName('state.json.lock.sqlite3-backup')).toBe(false);
    expect(isSqliteTransactionLockArtifactName('state.sqlite3')).toBe(false);
    expect(isSqliteTransactionLockArtifactName('../state.json.lock.sqlite3')).toBe(false);
  });

  it('fails closed when the retained root path is replaced and never releases a successor', () => {
    const root = path.join(temporaryRoot, 'owned-root');
    const moved = path.join(temporaryRoot, 'moved-root');
    fs.mkdirSync(root);
    const databasePath = path.join(root, 'leadership.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'leadership replaced');
    expect(owner).not.toBeNull();

    fs.renameSync(root, moved);
    fs.mkdirSync(root);
    expect(() => owner!.assertOwned()).toThrow('leadership replaced');
    expect(() => owner!.release()).toThrow('leadership replaced');

    const successor = tryRetainSqliteTransactionLock(databasePath, 'successor replaced');
    expect(successor).not.toBeNull();
    owner!.release();
    expect(() => successor!.assertOwned()).not.toThrow();
    successor!.release();
  });

  it('rejects a symlinked leadership root', () => {
    const realRoot = path.join(temporaryRoot, 'real-root');
    const aliasRoot = path.join(temporaryRoot, 'alias-root');
    fs.mkdirSync(realRoot);
    fs.symlinkSync(realRoot, aliasRoot, 'dir');
    expect(() =>
      tryRetainSqliteTransactionLock(
        path.join(aliasRoot, 'leadership.sqlite3'),
        'leadership replaced'
      )
    ).toThrow('Unsafe lock directory');
  });

  it('exclusively precreates an absent canonical database before opening SQLite', () => {
    const databasePath = path.join(temporaryRoot, 'absent.sqlite3');
    let precreatedIdentity: [bigint, bigint] | undefined;
    const failpoint = new Error('stop after absent-file precreation');
    setSqliteTransactionLockTestHooksForTests({
      afterAbsentFilePrecreated: (openedPath) => {
        const stats = fs.lstatSync(openedPath, { bigint: true });
        precreatedIdentity = [stats.dev, stats.ino];
        throw failpoint;
      },
    });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'ownership lost')).toThrow(failpoint);
    expect(precreatedIdentity).toEqual(expect.any(Array));
    expect([
      fs.lstatSync(databasePath, { bigint: true }).dev,
      fs.lstatSync(databasePath, { bigint: true }).ino,
    ]).toEqual(precreatedIdentity);

    setSqliteTransactionLockTestHooksForTests(undefined);
    const owner = tryRetainSqliteTransactionLock(databasePath, 'ownership lost');
    expect(owner).not.toBeNull();
    owner!.release();
  });

  it('fails closed when the precreated inode is swapped immediately before DatabaseSync opens', () => {
    const databasePath = path.join(temporaryRoot, 'before-open.sqlite3');
    const displacedPath = `${databasePath}.displaced`;
    let successor: ReturnType<typeof tryRetainSqliteTransactionLock> | undefined;
    let successorIdentity: [bigint, bigint] | undefined;
    setSqliteTransactionLockTestHooksForTests({
      beforeDatabaseOpen: (openedPath) => {
        setSqliteTransactionLockTestHooksForTests(undefined);
        fs.renameSync(openedPath, displacedPath);
        fs.writeFileSync(openedPath, '');
        successorIdentity = inode(openedPath);
        successor = tryRetainSqliteTransactionLock(openedPath, 'successor lost');
      },
    });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'outer ownership lost')).toThrow(
      'Lock database identity changed while opening'
    );
    expect(successor).toBeDefined();
    expect(successor).not.toBeNull();
    expect(inode(databasePath)).toEqual(successorIdentity);
    expect(() => successor!.assertOwned()).not.toThrow();
    successor!.release();
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.existsSync(displacedPath)).toBe(true);
  });

  it('closes without claiming ownership when the inode is swapped after DatabaseSync opens', () => {
    const databasePath = path.join(temporaryRoot, 'after-open.sqlite3');
    const displacedPath = `${databasePath}.displaced`;
    let successor: ReturnType<typeof tryRetainSqliteTransactionLock> | undefined;
    let firstReturned = false;
    setSqliteTransactionLockTestHooksForTests({
      afterDatabaseOpen: (openedPath) => {
        setSqliteTransactionLockTestHooksForTests(undefined);
        fs.renameSync(openedPath, displacedPath);
        fs.writeFileSync(openedPath, '');
        successor = tryRetainSqliteTransactionLock(openedPath, 'successor lost');
        expect(firstReturned).toBe(false);
      },
    });

    expect(() => {
      const owner = tryRetainSqliteTransactionLock(databasePath, 'outer ownership lost');
      firstReturned = owner !== null;
    }).toThrow('Lock database identity changed while opening');
    expect(firstReturned).toBe(false);
    expect(successor).toBeDefined();
    expect(successor).not.toBeNull();
    expect(() => successor!.assertOwned()).not.toThrow();
    successor!.release();
    expect(fs.existsSync(databasePath)).toBe(true);
    expect(fs.existsSync(displacedPath)).toBe(true);
  });

  it('detects replacement of an existing database before open and preserves the successor', () => {
    const databasePath = path.join(temporaryRoot, 'existing.sqlite3');
    const initialOwner = tryRetainSqliteTransactionLock(databasePath, 'initial lost');
    initialOwner!.release();
    const originalIdentity = inode(databasePath);
    const displacedPath = `${databasePath}.displaced`;
    let successor: ReturnType<typeof tryRetainSqliteTransactionLock>;
    setSqliteTransactionLockTestHooksForTests({
      beforeDatabaseOpen: (openedPath) => {
        setSqliteTransactionLockTestHooksForTests(undefined);
        fs.renameSync(openedPath, displacedPath);
        fs.writeFileSync(openedPath, '');
        successor = tryRetainSqliteTransactionLock(openedPath, 'successor lost');
      },
    });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'outer ownership lost')).toThrow(
      'Lock database identity changed while opening'
    );
    expect(inode(displacedPath)).toEqual(originalIdentity);
    expect(inode(databasePath)).not.toEqual(originalIdentity);
    expect(() => successor!.assertOwned()).not.toThrow();
    successor!.release();
  });

  it('opens and locks the guarded inode while the canonical path is replaced and restored', () => {
    const databasePath = path.join(temporaryRoot, 'guarded-a.sqlite3');
    const replacementPath = path.join(temporaryRoot, 'replacement-b.sqlite3');
    const displacedPath = `${databasePath}.displaced`;
    const initialOwner = tryRetainSqliteTransactionLock(databasePath, 'initial A lost');
    const replacementOwner = tryRetainSqliteTransactionLock(replacementPath, 'initial B lost');
    initialOwner!.release();
    replacementOwner!.release();
    const guardedIdentity = inode(databasePath);
    const replacementIdentity = inode(replacementPath);
    let contender: ReturnType<typeof tryRetainSqliteTransactionLock> | undefined;

    setSqliteTransactionLockTestHooksForTests({
      beforeDatabaseOpen: (openedPath) => {
        fs.renameSync(openedPath, displacedPath);
        fs.renameSync(replacementPath, openedPath);
        expect(inode(openedPath)).toEqual(replacementIdentity);
      },
      afterDatabaseOpen: (openedPath) => {
        fs.renameSync(openedPath, replacementPath);
        fs.renameSync(displacedPath, openedPath);
        expect(inode(openedPath)).toEqual(guardedIdentity);
        setSqliteTransactionLockTestHooksForTests(undefined);
        contender = tryRetainSqliteTransactionLock(openedPath, 'contender lost');
      },
    });

    const owner = tryRetainSqliteTransactionLock(databasePath, 'outer ownership lost');
    expect(owner).not.toBeNull();
    expect(contender).toBeNull();
    expect(inode(databasePath)).toEqual(guardedIdentity);
    expect(inode(replacementPath)).toEqual(replacementIdentity);
    expect(custodyArtifacts(databasePath)).toHaveLength(1);
    expect(() => owner!.assertOwned()).not.toThrow();

    owner!.release();
    expect(transientArtifacts(databasePath)).toEqual([]);
  });

  it('removes custody links and SQLite sidecars after success and open failure', () => {
    const successfulPath = path.join(temporaryRoot, 'successful-cleanup.sqlite3');
    const owner = tryRetainSqliteTransactionLock(successfulPath, 'success owner lost');
    expect(owner).not.toBeNull();
    expect(custodyArtifacts(successfulPath)).toHaveLength(1);
    owner!.release();
    expect(transientArtifacts(successfulPath)).toEqual([]);
    expect(() => fs.renameSync(successfulPath, `${successfulPath}.closed`)).not.toThrow();

    const failingPath = path.join(temporaryRoot, 'failed-cleanup.sqlite3');
    const failpoint = new Error('fail after database open');
    setSqliteTransactionLockTestHooksForTests({
      afterDatabaseOpen: () => {
        throw failpoint;
      },
    });

    expect(() => tryRetainSqliteTransactionLock(failingPath, 'failed owner lost')).toThrow(
      failpoint
    );
    expect(transientArtifacts(failingPath)).toEqual([]);
    expect(() => fs.renameSync(failingPath, `${failingPath}.closed`)).not.toThrow();
  });

  it('fails closed and closes its identity guard when a custody hard link cannot be created', () => {
    const databasePath = path.join(temporaryRoot, 'unsupported-hard-link.sqlite3');
    const hardLinkError = Object.assign(new Error('hard links unavailable'), {
      code: 'EOPNOTSUPP',
    });
    const beforeDatabaseOpen = vi.fn();
    vi.spyOn(fs, 'linkSync').mockImplementationOnce(() => {
      throw hardLinkError;
    });
    setSqliteTransactionLockTestHooksForTests({ beforeDatabaseOpen });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'ownership lost')).toThrow(
      hardLinkError
    );
    expect(beforeDatabaseOpen).not.toHaveBeenCalled();
    expect(transientArtifacts(databasePath)).toEqual([]);
    expect(() => fs.renameSync(databasePath, `${databasePath}.closed`)).not.toThrow();
  });

  it('preserves undefined pre-open failure causally when descriptor cleanup also fails', () => {
    const databasePath = path.join(temporaryRoot, 'cleanup.sqlite3');
    const cleanupError = new Error('identity descriptor close failed');
    const originalClose = fs.closeSync;
    let leakedDescriptor: number | undefined;
    vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (leakedDescriptor === undefined && fs.fstatSync(descriptor).isFile()) {
        leakedDescriptor = descriptor;
        throw cleanupError;
      }
      originalClose(descriptor);
    });
    setSqliteTransactionLockTestHooksForTests({
      afterAbsentFilePrecreated: () => {
        throw undefined;
      },
    });

    let caught: unknown;
    try {
      tryRetainSqliteTransactionLock(databasePath, 'ownership lost');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect(caught).toMatchObject({
      message: 'SQLite lock open and cleanup failed',
      errors: [{ message: 'SQLite lock open failed by throwing undefined' }, cleanupError],
    });
    expect((caught as AggregateError).cause).toBe((caught as AggregateError).errors[0]);

    vi.restoreAllMocks();
    if (leakedDescriptor !== undefined) originalClose(leakedDescriptor);
  });
});

function inode(filePath: string): [bigint, bigint] {
  const stats = fs.lstatSync(filePath, { bigint: true });
  return [stats.dev, stats.ino];
}

function custodyArtifacts(databasePath: string): string[] {
  const custodyPattern = new RegExp(`^${path.basename(databasePath)}\\.custody-[0-9a-f]{32}$`);
  return fs.readdirSync(path.dirname(databasePath)).filter((entry) => custodyPattern.test(entry));
}

function transientArtifacts(databasePath: string): string[] {
  const databaseName = path.basename(databasePath);
  return fs
    .readdirSync(path.dirname(databasePath))
    .filter(
      (entry) =>
        entry.startsWith(`${databaseName}.custody-`) ||
        entry === `${databaseName}-journal` ||
        entry === `${databaseName}-shm` ||
        entry === `${databaseName}-wal`
    );
}
