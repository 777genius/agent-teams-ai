import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
  removePathWithIdentityFenceAsync,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';
import { getBackupsBasePath } from '@main/utils/pathDecoder';

interface PermanentDeletionLockOwner {
  version: 2;
  token: string;
  pid: number;
  processInstanceId: string;
  createdAt: string;
  targetPath: string;
}

export interface PermanentDeletionLock {
  lockPath: string;
  owner: PermanentDeletionLockOwner;
  identity: DurablePathIdentity;
  ownerEntryName: string;
}

interface PermanentDeletionLockObservation {
  owner: PermanentDeletionLockOwner | null;
  stats: fs.Stats;
  lockStats: fs.Stats;
  representation: 'directory' | 'legacy-file';
  ownerEntryName: string | null;
}

const PERMANENT_DELETION_LOCK_RETRY_MS = 10;
const PERMANENT_DELETION_LOCK_ACQUIRE_TIMEOUT_MS = 60_000;
const PERMANENT_DELETION_LOCK_LEASE_MS = 30_000;
const PERMANENT_DELETION_LOCK_HEARTBEAT_MS = 5_000;
const PERMANENT_DELETION_LOCK_OWNER_PREFIX = 'owner-';
const PERMANENT_DELETION_LOCK_DETACHED_PREFIX = 'detached-';
const PERMANENT_DELETION_LOCK_ENTRY_SUFFIX = '.json';
const PROCESS_INSTANCE_ID = crypto.randomUUID();

function isEnoent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso(): string {
  return new Date().toISOString();
}

function isPermanentDeletionLockOwner(value: unknown): value is PermanentDeletionLockOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<PermanentDeletionLockOwner>;
  return (
    owner.version === 2 &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    typeof owner.pid === 'number' &&
    Number.isSafeInteger(owner.pid) &&
    owner.pid > 0 &&
    typeof owner.processInstanceId === 'string' &&
    owner.processInstanceId.length > 0 &&
    typeof owner.createdAt === 'string' &&
    Number.isFinite(Date.parse(owner.createdAt)) &&
    typeof owner.targetPath === 'string' &&
    path.isAbsolute(owner.targetPath)
  );
}

export class TeamPermanentDeletionLock {
  private getPermanentDeletionLockPath(scope: string): string {
    const targetPath = path.resolve(getBackupsBasePath());
    const lockKey = crypto.createHash('sha256').update(`${targetPath}\0${scope}`).digest('hex');
    // The coordination file must not live below the hierarchy it protects. os.tmpdir()
    // is an existing, host-local rendezvous point shared by independently loaded
    // modules and processes, even while the app-data hierarchy is being created.
    return path.join(os.tmpdir(), `.agent-teams-permanent-deletion-${lockKey}.lock`);
  }

  private getPermanentDeletionLockOwnerEntryName(token: string): string {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    return `${PERMANENT_DELETION_LOCK_OWNER_PREFIX}${tokenHash}${PERMANENT_DELETION_LOCK_ENTRY_SUFFIX}`;
  }

  private isPermanentDeletionLockEntryName(entryName: string): boolean {
    return (
      (entryName.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX) ||
        entryName.startsWith(PERMANENT_DELETION_LOCK_DETACHED_PREFIX)) &&
      entryName.endsWith(PERMANENT_DELETION_LOCK_ENTRY_SUFFIX)
    );
  }

  private async readPermanentDeletionLockEntry(
    entryPath: string
  ): Promise<{ owner: PermanentDeletionLockOwner | null; stats: fs.Stats } | null> {
    let handle: fs.promises.FileHandle | null = null;
    try {
      handle = await fs.promises.open(entryPath, 'r');
      const stats = await handle.stat();
      if (!stats.isFile()) return { owner: null, stats };
      const raw = await handle.readFile('utf8');
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        // Published owner entries are synced before their lock directory is
        // published. Invalid JSON therefore belongs to a crashed/corrupt owner.
      }
      return { owner: isPermanentDeletionLockOwner(parsed) ? parsed : null, stats };
    } catch (error) {
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async readPermanentDeletionLockOwner(
    lockPath: string
  ): Promise<PermanentDeletionLockObservation | null> {
    try {
      const lockStats = await fs.promises.lstat(lockPath);
      if (!lockStats.isDirectory() || lockStats.isSymbolicLink()) {
        const legacy = await this.readPermanentDeletionLockEntry(lockPath);
        if (!legacy) return null;
        return {
          ...legacy,
          lockStats,
          representation: 'legacy-file',
          ownerEntryName: null,
        };
      }

      const entryNames = (await fs.promises.readdir(lockPath))
        .filter((entryName) => this.isPermanentDeletionLockEntryName(entryName))
        .sort((left, right) => {
          const leftIsOwner = left.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX);
          const rightIsOwner = right.startsWith(PERMANENT_DELETION_LOCK_OWNER_PREFIX);
          if (leftIsOwner !== rightIsOwner) return leftIsOwner ? -1 : 1;
          return left.localeCompare(right);
        });
      const ownerEntryName = entryNames[0] ?? null;
      if (!ownerEntryName) {
        return {
          owner: null,
          stats: lockStats,
          lockStats,
          representation: 'directory',
          ownerEntryName: null,
        };
      }

      const entry = await this.readPermanentDeletionLockEntry(path.join(lockPath, ownerEntryName));
      if (!entry) return null;
      return {
        ...entry,
        lockStats,
        representation: 'directory',
        ownerEntryName,
      };
    } catch (error) {
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
      throw error;
    }
  }

  private isSamePermanentDeletionLockObservation(
    current: { owner: PermanentDeletionLockOwner | null; stats: fs.Stats },
    expected: PermanentDeletionLockObservation
  ): boolean {
    const identity = getDurablePathIdentity(current.stats);
    const expectedIdentity = getDurablePathIdentity(expected.stats);
    return (
      isSameDurablePathIdentity(identity, expectedIdentity) &&
      identity.birthtimeMs === expectedIdentity.birthtimeMs &&
      current.stats.mtimeMs === expected.stats.mtimeMs &&
      current.stats.size === expected.stats.size &&
      current.owner?.token === expected.owner?.token
    );
  }

  private async restoreDetachedLockEntryNoClobber(
    detachedPath: string,
    ownerPath: string
  ): Promise<boolean> {
    try {
      await fs.promises.link(detachedPath, ownerPath);
      await fs.promises.unlink(detachedPath);
      await syncDirectoryDurably(path.dirname(ownerPath));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      if (isEnoent(error) || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return true;
      throw error;
    }
  }

  private async detachPermanentDeletionLockOwner(
    lockPath: string,
    expected: Pick<PermanentDeletionLockObservation, 'representation' | 'ownerEntryName'>,
    validateDetached: (detached: {
      owner: PermanentDeletionLockOwner | null;
      stats: fs.Stats;
    }) => boolean
  ): Promise<'removed' | 'missing' | 'changed'> {
    if (expected.representation === 'legacy-file') {
      const removal = await removePathWithIdentityFenceAsync(lockPath, {
        force: true,
        durability: 'strict',
        validateDetached: async (detachedPath) => {
          const detached = await this.readPermanentDeletionLockEntry(detachedPath);
          return detached !== null && validateDetached(detached);
        },
      });
      return removal === 'deleted' ? 'removed' : removal === 'missing' ? 'missing' : 'changed';
    }

    if (!expected.ownerEntryName) {
      try {
        await fs.promises.rmdir(lockPath);
        await syncDirectoryDurably(path.dirname(lockPath));
        return 'removed';
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return 'missing';
        if (code === 'ENOTEMPTY' || code === 'EEXIST' || code === 'ENOTDIR') return 'changed';
        throw error;
      }
    }

    const ownerPath = path.join(lockPath, expected.ownerEntryName);
    const detachedEntryName = `${PERMANENT_DELETION_LOCK_DETACHED_PREFIX}${crypto.randomUUID()}-${
      expected.ownerEntryName
    }`;
    const detachedPath = path.join(lockPath, detachedEntryName);
    try {
      // The token-derived owner pathname is the ownership check and mutation
      // target in one operation. A replacement lock directory has a different
      // entry name, so it cannot be detached after replacing the observation.
      await fs.promises.rename(ownerPath, detachedPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'changed';
      throw error;
    }
    await syncDirectoryDurably(lockPath);

    try {
      const detached = await this.readPermanentDeletionLockEntry(detachedPath);
      if (!detached || !validateDetached(detached)) {
        await this.restoreDetachedLockEntryNoClobber(detachedPath, ownerPath);
        return 'changed';
      }

      await fs.promises.unlink(detachedPath);
      try {
        await fs.promises.rmdir(lockPath);
        await syncDirectoryDurably(path.dirname(lockPath));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
      }
      return 'removed';
    } catch (error) {
      await this.restoreDetachedLockEntryNoClobber(detachedPath, ownerPath).catch(() => undefined);
      throw error;
    }
  }

  async removeStalePermanentDeletionLock(lockPath: string): Promise<boolean> {
    const observed = await this.readPermanentDeletionLockOwner(lockPath);
    if (!observed) return true;
    // Version-2 owners renew the lock inode itself. PID liveness is deliberately
    // not an ownership signal: a recycled PID must not retain a dead owner's lock.
    if (observed.owner && Date.now() - observed.stats.mtimeMs <= PERMANENT_DELETION_LOCK_LEASE_MS) {
      return false;
    }

    const removal = await this.detachPermanentDeletionLockOwner(lockPath, observed, (detached) =>
      this.isSamePermanentDeletionLockObservation(detached, observed)
    );
    return removal === 'removed' || removal === 'missing';
  }

  async acquirePermanentDeletionLock(scope: string): Promise<PermanentDeletionLock> {
    const lockPath = this.getPermanentDeletionLockPath(scope);
    const targetPath = path.resolve(getBackupsBasePath());
    const owner: PermanentDeletionLockOwner = {
      version: 2,
      token: crypto.randomUUID(),
      pid: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      createdAt: nowIso(),
      targetPath,
    };
    const candidatePath = `${lockPath}.${owner.token}.candidate`;
    const ownerEntryName = this.getPermanentDeletionLockOwnerEntryName(owner.token);
    const candidateOwnerPath = path.join(candidatePath, ownerEntryName);
    let candidateHandle: fs.promises.FileHandle | null = null;
    let lockPublished = false;
    try {
      await fs.promises.mkdir(candidatePath, { mode: 0o700 });
      candidateHandle = await fs.promises.open(candidateOwnerPath, 'wx', 0o600);
      await candidateHandle.writeFile(`${JSON.stringify(owner)}\n`, 'utf8');
      await candidateHandle.sync();
      await candidateHandle.close();
      candidateHandle = null;
      await syncDirectoryDurably(candidatePath);

      const deadline = Date.now() + PERMANENT_DELETION_LOCK_ACQUIRE_TIMEOUT_MS;
      while (true) {
        try {
          // A complete, synced non-empty directory is the indivisible ownership
          // unit. Renaming it publishes the owner atomically, and an existing
          // non-empty lock directory cannot be displaced by another contender.
          await fs.promises.rename(candidatePath, lockPath);
          lockPublished = true;
          await syncDirectoryDurably(path.dirname(lockPath));
          const stats = await fs.promises.lstat(path.join(lockPath, ownerEntryName));
          return {
            lockPath,
            owner,
            identity: getDurablePathIdentity(stats),
            ownerEntryName,
          };
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            code !== 'EEXIST' &&
            code !== 'ENOTEMPTY' &&
            code !== 'ENOTDIR' &&
            code !== 'EISDIR'
          ) {
            throw error;
          }
          await this.removeStalePermanentDeletionLock(lockPath);
          if (Date.now() >= deadline) {
            throw new Error(`Permanent deletion lock timeout: ${targetPath}`);
          }
          await sleep(PERMANENT_DELETION_LOCK_RETRY_MS);
        }
      }
    } catch (error) {
      await candidateHandle?.close().catch(() => undefined);
      await fs.promises.rm(candidatePath, { recursive: true, force: true }).catch(() => undefined);
      if (lockPublished) {
        const stats = await fs.promises
          .lstat(path.join(lockPath, ownerEntryName))
          .catch(() => null);
        if (stats) {
          await this.releasePermanentDeletionLock({
            lockPath,
            owner,
            identity: getDurablePathIdentity(stats),
            ownerEntryName,
          }).catch(() => undefined);
        }
      }
      throw error;
    }
  }

  private async heartbeatPermanentDeletionLock(lock: PermanentDeletionLock): Promise<void> {
    const ownerPath = path.join(lock.lockPath, lock.ownerEntryName);
    const handle = await fs.promises.open(ownerPath, 'r+');
    try {
      const stats = await handle.stat();
      const owner = JSON.parse(await handle.readFile('utf8')) as unknown;
      if (
        !isSameDurablePathIdentity(getDurablePathIdentity(stats), lock.identity) ||
        !isPermanentDeletionLockOwner(owner) ||
        owner.token !== lock.owner.token
      ) {
        throw new Error('Permanent deletion lock ownership changed');
      }
      const now = new Date();
      await handle.utimes(now, now);
    } finally {
      await handle.close();
    }
  }

  async releasePermanentDeletionLock(lock: PermanentDeletionLock): Promise<void> {
    await this.detachPermanentDeletionLockOwner(
      lock.lockPath,
      {
        representation: 'directory',
        ownerEntryName: lock.ownerEntryName,
      },
      (detached) => {
        const identity = getDurablePathIdentity(detached.stats);
        return (
          detached.owner?.token === lock.owner.token &&
          isSameDurablePathIdentity(identity, lock.identity) &&
          identity.birthtimeMs === lock.identity.birthtimeMs
        );
      }
    );
  }

  async withLock<T>(scope: string, operation: () => Promise<T>): Promise<T> {
    const lock = await this.acquirePermanentDeletionLock(scope);
    let heartbeatError: unknown;
    let heartbeatRunning = false;
    const heartbeatTasks = new Set<Promise<void>>();
    const heartbeatTimer = setInterval(() => {
      if (heartbeatRunning || heartbeatError) return;
      heartbeatRunning = true;
      const heartbeatTask = this.heartbeatPermanentDeletionLock(lock)
        .catch((error: unknown) => {
          heartbeatError = error;
        })
        .finally(() => {
          heartbeatRunning = false;
          heartbeatTasks.delete(heartbeatTask);
        });
      heartbeatTasks.add(heartbeatTask);
    }, PERMANENT_DELETION_LOCK_HEARTBEAT_MS);
    heartbeatTimer.unref();
    try {
      const result = await operation();
      if (heartbeatError) {
        throw heartbeatError instanceof Error
          ? heartbeatError
          : new Error(
              `Permanent deletion lock heartbeat failed: ${
                typeof heartbeatError === 'string' ? heartbeatError : 'unknown failure'
              }`
            );
      }
      await this.heartbeatPermanentDeletionLock(lock);
      return result;
    } finally {
      clearInterval(heartbeatTimer);
      await Promise.all(heartbeatTasks);
      await this.releasePermanentDeletionLock(lock);
    }
  }
}
