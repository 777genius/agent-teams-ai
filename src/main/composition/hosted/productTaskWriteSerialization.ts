import * as fs from 'node:fs';
import * as path from 'node:path';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import { parseTeamId, type TeamId } from '@shared/contracts/hosted';

import type { ProductTaskWriteSerialization } from './productHumanTaskAssignmentAuthority';

const ASYNC_ACQUIRE_TIMEOUT_MS = 30_000;
// A synchronous wait would prevent an async holder in this process from releasing.
// Fail closed and let the caller retry its complete transaction instead.
const SYNC_ACQUIRE_TIMEOUT_MS = 0;
const LOCK_FILE_OPTIONS = { preventLiveOwnerTakeover: true } as const;

type DirectoryIdentity = Readonly<{ canonicalPath: string; device: number; inode: number }>;

function inspectPrivateDirectory(directory: string): DirectoryIdentity {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('product-task-write-lock-directory-unsafe');
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('product-task-write-lock-directory-not-private');
    }
  }
  return {
    canonicalPath: fs.realpathSync.native(directory),
    device: stat.dev,
    inode: stat.ino,
  };
}

/**
 * Product-owned lock shared by human assignment and canonical agent effects.
 *
 * The caller supplies an existing Product-private directory outside agent-writable
 * team/task trees. Both writer paths must receive this same instance or the same
 * directory. The canonical writer's withProductWriterLock must call
 * withCanonicalTaskWrite with its trusted team ID, covering the v35 decision,
 * task-file write, and SQLite receipt transaction. The human authority's
 * withTaskWrite covers the complete HostedTaskBoardMutationFileAuthority call.
 * Hosted's own WAL fence remains responsible for its recovery protocol.
 *
 * This adapter deliberately does not activate either production route.
 */
export class ProductTaskWriteFileSerialization implements ProductTaskWriteSerialization {
  private readonly directoryIdentity: DirectoryIdentity;

  constructor(private readonly lockDirectory: string) {
    if (!path.isAbsolute(lockDirectory)) {
      throw new Error('product-task-write-lock-directory-invalid');
    }
    this.directoryIdentity = inspectPrivateDirectory(lockDirectory);
  }

  private resource(teamId: string): string {
    const parsedTeamId = parseTeamId(teamId);
    const current = inspectPrivateDirectory(this.lockDirectory);
    if (
      current.canonicalPath !== this.directoryIdentity.canonicalPath ||
      current.device !== this.directoryIdentity.device ||
      current.inode !== this.directoryIdentity.inode
    ) {
      throw new Error('product-task-write-lock-directory-changed');
    }
    return path.join(current.canonicalPath, `${parsedTeamId}.product-task-write`);
  }

  withTaskWrite<T>(teamId: TeamId, work: () => Promise<T>): Promise<T> {
    return withFileLock(this.resource(teamId), work, {
      ...LOCK_FILE_OPTIONS,
      acquireTimeoutMs: ASYNC_ACQUIRE_TIMEOUT_MS,
    });
  }

  withCanonicalTaskWrite<T>(teamId: string, work: () => T): T {
    return withFileLockSync(this.resource(teamId), work, {
      ...LOCK_FILE_OPTIONS,
      acquireTimeoutMs: SYNC_ACQUIRE_TIMEOUT_MS,
    });
  }
}
