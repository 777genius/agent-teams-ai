import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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

const workerPath = path.resolve('test/fixtures/fileLockProcessWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/loader.mjs');

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
    expect(
      isSqliteTransactionLockArtifactName(
        'state.json.lock.sqlite3.custody-0123456789abcdef0123456789abcdef-journal.witness'
      )
    ).toBe(true);
    expect(
      isSqliteTransactionLockArtifactName(
        'state.json.lock.sqlite3.custody-0123456789abcdef0123456789abcdef.provenance'
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

  it('recovers a SIGKILLed hot journal before reaping every predecessor artifact', async () => {
    const databasePath = path.join(temporaryRoot, 'sigkill-recovery.sqlite3');
    const setup = new DatabaseSync(databasePath);
    setup.exec(
      "CREATE TABLE recovery_state(value TEXT NOT NULL); INSERT INTO recovery_state VALUES ('stable')"
    );
    setup.close();

    const child = spawn(
      process.execPath,
      ['--import', tsxPath, workerPath, 'sqlite-crash-holder', databasePath, databasePath],
      {
        cwd: process.cwd(),
        env: { ...process.env, NODE_ENV: 'test' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let output = '';
    child.stdout!.on('data', (chunk) => {
      output += String(chunk);
    });
    child.stderr!.on('data', (chunk) => {
      output += String(chunk);
    });
    await waitForOutput(() => output, 'acquired\n');
    expect(custodyArtifacts(databasePath)).toHaveLength(1);
    expect(
      transientArtifacts(databasePath).some((entry) => entry.endsWith('-journal.witness'))
    ).toBe(true);

    expect(child.kill('SIGKILL')).toBe(true);
    const [code, signal] = (await once(child, 'close')) as [number | null, NodeJS.Signals | null];
    expect(signal === 'SIGKILL' || (code !== null && code !== 0), output).toBe(true);

    const successor = tryRetainSqliteTransactionLock(databasePath, 'successor lost ownership');
    expect(successor).not.toBeNull();
    successor!.release();

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    const row = verification.prepare('SELECT value FROM recovery_state').get() as {
      value: string;
    };
    verification.close();
    expect(row.value).toBe('stable');
    expect(transientArtifacts(databasePath)).toEqual([]);
  });

  it('does not reap a custody link owned by a live transaction', () => {
    const databasePath = path.join(temporaryRoot, 'live-custody.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'owner lost');
    expect(owner).not.toBeNull();
    const liveArtifacts = transientArtifacts(databasePath);
    expect(liveArtifacts).toHaveLength(4);
    expect(tryRetainSqliteTransactionLock(databasePath, 'contender lost')).toBeNull();
    expect(transientArtifacts(databasePath)).toEqual(liveArtifacts);
    owner!.release();
    expect(transientArtifacts(databasePath)).toEqual([]);
  });

  it.each([
    ['before the provenance file', 'sqlite-before-provenance-holder'],
    ['with a partial provenance file', 'sqlite-partial-provenance-holder'],
  ] as const)('treats an exact live writer as contention %s', async (_label, mode) => {
    const databasePath = path.join(temporaryRoot, `${mode}.sqlite3`);
    const child = spawnPausedPublicationOwner(databasePath, mode);
    let output = '';
    child.stdout!.on('data', (chunk) => (output += String(chunk)));
    child.stderr!.on('data', (chunk) => (output += String(chunk)));
    await waitForOutput(() => output, 'acquired\n');

    try {
      const [custodyName] = custodyArtifacts(databasePath);
      expect(custodyName, output).toBeDefined();
      const custodyPath = path.join(temporaryRoot, custodyName!);
      expect(fs.existsSync(`${custodyPath}-journal.witness`)).toBe(true);
      if (mode === 'sqlite-partial-provenance-holder') {
        const partial = fs.readFileSync(`${custodyPath}.provenance`, 'utf8');
        expect(partial.length).toBeGreaterThan(0);
        expect(() => JSON.parse(partial)).toThrow();
      } else {
        expect(fs.existsSync(`${custodyPath}.provenance`)).toBe(false);
      }

      expect(tryRetainSqliteTransactionLock(databasePath, 'contender lost')).toBeNull();
      await expect(
        withSqliteTransactionLock(databasePath, async () => undefined, {
          ...LOCK_OPTIONS,
          acquireTimeoutMs: 40,
        })
      ).rejects.toThrow('lock timeout');

      child.stdin!.write('c');
      await waitForOutput(() => output, 'published\n');
      expect(tryRetainSqliteTransactionLock(databasePath, 'contender lost')).toBeNull();
      child.send!('release');
      await waitForOutput(() => output, 'released\n');
      await once(child, 'close');

      const successor = tryRetainSqliteTransactionLock(databasePath, 'successor lost');
      expect(successor).not.toBeNull();
      successor!.release();
      expect(transientArtifacts(databasePath)).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  it('ignores unrelated custody inodes and leaves them untouched', () => {
    const databasePath = path.join(temporaryRoot, 'unrelated-custody.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'initial owner lost');
    owner!.release();
    const unrelatedPath = path.join(temporaryRoot, 'unrelated.sqlite3');
    fs.writeFileSync(unrelatedPath, 'unrelated');
    const custodyPath = `${databasePath}.custody-11111111111111111111111111111111`;
    fs.linkSync(unrelatedPath, custodyPath);

    const successor = tryRetainSqliteTransactionLock(databasePath, 'successor lost');
    expect(successor).not.toBeNull();
    successor!.release();
    expect(inode(custodyPath)).toEqual(inode(unrelatedPath));
    expect(fs.existsSync(custodyPath)).toBe(true);
  });

  it('rejects a foreign ordinary orphan journal without opening or deleting it', () => {
    const databasePath = path.join(temporaryRoot, 'foreign-ordinary-sidecar.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'initial owner lost');
    owner!.release();
    const custodyPath = `${databasePath}.custody-21212121212121212121212121212121`;
    const sidecarPath = `${custodyPath}-journal`;
    fs.linkSync(databasePath, custodyPath);
    fs.writeFileSync(sidecarPath, 'foreign ordinary file');
    const foreignIdentity = inode(sidecarPath);

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'Missing SQLite lock custody provenance'
    );
    expect(inode(sidecarPath)).toEqual(foreignIdentity);
    expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('foreign ordinary file');
  });

  it('revalidates a foreign replacement between orphan scan and SQLite open', async () => {
    const databasePath = path.join(temporaryRoot, 'scan-open-replacement.sqlite3');
    const custodyPath = await crashSqliteOwner(databasePath);
    const journalPath = `${custodyPath}-journal`;
    setSqliteTransactionLockTestHooksForTests({
      beforeOrphanDatabaseOpen: () => {
        fs.rmSync(journalPath, { force: true });
        fs.writeFileSync(journalPath, 'foreign replacement');
      },
    });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'changed before recovery open'
    );
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('foreign replacement');
  });

  it('revalidates a foreign replacement between recovery and artifact unlink', async () => {
    const databasePath = path.join(temporaryRoot, 'scan-unlink-replacement.sqlite3');
    const custodyPath = await crashSqliteOwner(databasePath);
    const journalPath = `${custodyPath}-journal`;
    let replaced = false;
    setSqliteTransactionLockTestHooksForTests({
      beforeOrphanArtifactUnlink: (artifactPath) => {
        if (artifactPath === journalPath && !replaced) {
          replaced = true;
          fs.rmSync(journalPath, { force: true });
          fs.writeFileSync(journalPath, 'foreign replacement');
        }
      },
    });

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'artifact changed before cleanup'
    );
    expect(fs.readFileSync(journalPath, 'utf8')).toBe('foreign replacement');
  });

  it('rejects a symlinked proven journal witness without opening or deleting it', async () => {
    if (process.platform === 'win32') return;
    const databasePath = path.join(temporaryRoot, 'tampered-sidecar.sqlite3');
    const custodyPath = await crashSqliteOwner(databasePath);
    const sidecarPath = `${custodyPath}-journal.witness`;
    fs.unlinkSync(sidecarPath);
    fs.symlinkSync(databasePath, sidecarPath);

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'Unsafe orphan SQLite lock sidecar'
    );
    expect(fs.lstatSync(sidecarPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(custodyPath)).toBe(true);
  });

  it.each([
    ['non-regular', (sidecarPath: string) => fs.mkdirSync(sidecarPath)],
    [
      'multiply-linked',
      (sidecarPath: string) => {
        fs.writeFileSync(sidecarPath, 'tampered journal');
        fs.linkSync(sidecarPath, `${sidecarPath}.foreign-link`);
      },
    ],
  ])('rejects a %s proven sidecar without deleting custody', async (_label, createSidecar) => {
    const databasePath = path.join(temporaryRoot, `${_label}-sidecar.sqlite3`);
    const custodyPath = await crashSqliteOwner(databasePath);
    const sidecarPath = `${custodyPath}-journal.witness`;
    fs.unlinkSync(sidecarPath);
    createSidecar(sidecarPath);

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'Unsafe orphan SQLite lock sidecar'
    );
    expect(fs.existsSync(custodyPath)).toBe(true);
    expect(fs.existsSync(sidecarPath)).toBe(true);
  });

  it.each([
    ['before the provenance file', 'sqlite-before-provenance-holder'],
    ['with a partial provenance file', 'sqlite-partial-provenance-holder'],
  ] as const)('fails closed after an owner crash %s', async (_label, mode) => {
    const databasePath = path.join(temporaryRoot, `${mode}-crash.sqlite3`);
    await crashSqliteOwner(databasePath, mode);
    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      mode === 'sqlite-before-provenance-holder'
        ? 'Missing SQLite lock custody provenance'
        : 'Corrupted SQLite lock custody provenance'
    );
    expect(custodyArtifacts(databasePath)).toHaveLength(1);
  });

  it.each(['missing', 'corrupted'] as const)(
    'fails closed for %s custody provenance',
    async (mode) => {
      const databasePath = path.join(temporaryRoot, `${mode}-provenance.sqlite3`);
      const custodyPath = await crashSqliteOwner(databasePath);
      const provenancePath = `${custodyPath}.provenance`;
      if (mode === 'missing') fs.unlinkSync(provenancePath);
      else fs.writeFileSync(provenancePath, '{not-json');

      expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow();
      expect(fs.existsSync(custodyPath)).toBe(true);
    }
  );

  it('rejects database inode substitution during a live-publication probe', async () => {
    if (process.platform === 'win32') return;
    const databasePath = path.join(temporaryRoot, 'probe-inode-substitution.sqlite3');
    const displacedPath = `${databasePath}.displaced`;
    const child = spawnPausedPublicationOwner(databasePath, 'sqlite-before-provenance-holder');
    let output = '';
    child.stdout!.on('data', (chunk) => (output += String(chunk)));
    child.stderr!.on('data', (chunk) => (output += String(chunk)));
    await waitForOutput(() => output, 'acquired\n', 30_000);
    setSqliteTransactionLockTestHooksForTests({
      beforeIncompleteCustodyProbeOpen: () => {
        fs.renameSync(databasePath, displacedPath);
        const replacement = new DatabaseSync(databasePath);
        replacement.close();
      },
    });

    try {
      expect(() => tryRetainSqliteTransactionLock(databasePath, 'contender lost')).toThrow(
        'identity changed during custody publication probe'
      );
      expect(inode(databasePath)).not.toEqual(inode(displacedPath));
    } finally {
      child.kill('SIGKILL');
      await once(child, 'close');
      fs.rmSync(databasePath, { force: true });
      fs.renameSync(displacedPath, databasePath);
    }
  });

  it('fails closed when the lock root is substituted during a live-publication probe', async () => {
    if (process.platform === 'win32') return;
    const databasePath = path.join(temporaryRoot, 'probe-root-substitution.sqlite3');
    const displacedRoot = `${temporaryRoot}.displaced`;
    const child = spawnPausedPublicationOwner(databasePath, 'sqlite-before-provenance-holder');
    let output = '';
    child.stdout!.on('data', (chunk) => (output += String(chunk)));
    child.stderr!.on('data', (chunk) => (output += String(chunk)));
    await waitForOutput(() => output, 'acquired\n', 30_000);
    setSqliteTransactionLockTestHooksForTests({
      beforeIncompleteCustodyProbeOpen: () => {
        fs.renameSync(temporaryRoot, displacedRoot);
        fs.mkdirSync(temporaryRoot);
      },
    });

    try {
      expect(() => tryRetainSqliteTransactionLock(databasePath, 'contender lost')).toThrow();
      expect(fs.existsSync(displacedRoot)).toBe(true);
    } finally {
      child.kill('SIGKILL');
      await once(child, 'close');
      fs.rmSync(temporaryRoot, { recursive: true, force: true });
      fs.renameSync(displacedRoot, temporaryRoot);
    }
  });

  it.each(['-wal', '-shm'] as const)(
    'fails closed without deleting an unproven %s sidecar',
    async (suffix) => {
      const databasePath = path.join(temporaryRoot, `${suffix.slice(1)}-sidecar.sqlite3`);
      const custodyPath = await crashSqliteOwner(databasePath);
      const sidecarPath = `${custodyPath}${suffix}`;
      fs.writeFileSync(sidecarPath, 'foreign WAL-family data');

      expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
        'Unrecoverable SQLite lock WAL/SHM custody'
      );
      expect(fs.readFileSync(sidecarPath, 'utf8')).toBe('foreign WAL-family data');
    }
  );

  it('rejects unexpected external hard links to the guarded database', () => {
    const databasePath = path.join(temporaryRoot, 'extra-hard-link.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'initial owner lost');
    owner!.release();
    const externalPath = path.join(temporaryRoot, 'external-hard-link.sqlite3');
    fs.linkSync(databasePath, externalPath);

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'Unexpected SQLite lock database hard-link count'
    );
    expect(inode(externalPath)).toEqual(inode(databasePath));
  });

  it('fails closed when orphan custody retention exceeds the bounded scan', () => {
    const databasePath = path.join(temporaryRoot, 'bounded-orphans.sqlite3');
    const owner = tryRetainSqliteTransactionLock(databasePath, 'initial owner lost');
    owner!.release();
    for (let index = 0; index < 65; index += 1) {
      fs.linkSync(databasePath, `${databasePath}.custody-${index.toString(16).padStart(32, '0')}`);
    }

    expect(() => tryRetainSqliteTransactionLock(databasePath, 'successor lost')).toThrow(
      'SQLite lock orphan custody scan exceeded its bound'
    );
    expect(custodyArtifacts(databasePath)).toHaveLength(65);
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

async function crashSqliteOwner(
  databasePath: string,
  mode:
    | 'sqlite-crash-holder'
    | 'sqlite-before-provenance-holder'
    | 'sqlite-partial-provenance-holder' = 'sqlite-crash-holder'
): Promise<string> {
  const setup = new DatabaseSync(databasePath);
  setup.exec(
    "CREATE TABLE IF NOT EXISTS recovery_state(value TEXT NOT NULL); DELETE FROM recovery_state; INSERT INTO recovery_state VALUES ('stable')"
  );
  setup.close();
  const child = spawn(
    process.execPath,
    ['--import', tsxPath, workerPath, mode, databasePath, databasePath],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: [mode === 'sqlite-crash-holder' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    }
  );
  let output = '';
  child.stdout!.on('data', (chunk) => (output += String(chunk)));
  child.stderr!.on('data', (chunk) => (output += String(chunk)));
  await waitForOutput(() => output, 'acquired\n');
  const [custodyName] = custodyArtifacts(databasePath);
  expect(custodyName, output).toBeDefined();
  expect(child.kill('SIGKILL')).toBe(true);
  await once(child, 'close');
  return path.join(path.dirname(databasePath), custodyName!);
}

function spawnPausedPublicationOwner(
  databasePath: string,
  mode: 'sqlite-before-provenance-holder' | 'sqlite-partial-provenance-holder'
) {
  return spawn(
    process.execPath,
    ['--import', tsxPath, workerPath, mode, databasePath, databasePath],
    {
      cwd: process.cwd(),
      env: { ...process.env, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    }
  );
}

async function waitForOutput(
  readOutput: () => string,
  expected: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!readOutput().includes(expected)) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for child output ${JSON.stringify(expected)}: ${readOutput()}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
