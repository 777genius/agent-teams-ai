import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  getSqliteTransactionLockDatabasePath,
  isSqliteTransactionLockArtifactName,
  tryRetainSqliteTransactionLock,
  withSqliteTransactionLock,
} from '@main/services/infrastructure/SqliteTransactionLock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
});
