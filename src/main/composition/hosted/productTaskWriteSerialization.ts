import * as path from 'node:path';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import {
  inspectProductTaskWritePrivateDirectory,
  PRODUCT_TASK_WRITE_LOCK_OPTIONS,
  productTaskWriteAuthorityResource,
  type ProductTaskWriteDirectoryIdentity,
  withProductTaskWriteAuthorityLockSync,
} from '@main/utils/productTaskWriteAuthorityLock';
import { parseTeamId, type TeamId } from '@shared/contracts/hosted';

import type { ProductTaskWriteSerialization } from './productTaskMutationAuthority';

const ASYNC_ACQUIRE_TIMEOUT_MS = 30_000;
// A synchronous wait would prevent an async holder in this process from releasing.
// Fail closed and let the caller retry its complete transaction instead.
const SYNC_ACQUIRE_TIMEOUT_MS = 0;

/**
 * Product-owned lock shared by v35 authority mutations, human assignment, and
 * canonical agent effects. The deployment-global authority lock is always outer
 * to the per-team lock; authority mutations acquire only the global lock.
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
  private readonly directoryIdentity: ProductTaskWriteDirectoryIdentity;

  constructor(private readonly lockDirectory: string) {
    this.directoryIdentity = inspectProductTaskWritePrivateDirectory(lockDirectory);
  }

  private assertDirectory(): string {
    const current = inspectProductTaskWritePrivateDirectory(this.lockDirectory);
    if (
      current.canonicalPath !== this.directoryIdentity.canonicalPath ||
      current.device !== this.directoryIdentity.device ||
      current.inode !== this.directoryIdentity.inode
    ) {
      throw new Error('product-task-write-lock-directory-changed');
    }
    return current.canonicalPath;
  }

  private resource(teamId: string): string {
    return path.join(this.assertDirectory(), `${parseTeamId(teamId)}.product-task-write`);
  }

  async withTaskWrite<T>(teamId: TeamId, work: () => Promise<T>): Promise<T> {
    const teamResource = this.resource(teamId);
    const authorityResource = productTaskWriteAuthorityResource(this.assertDirectory());
    let authorityEntered = false;
    let teamEntered = false;
    try {
      return await withFileLock(
        authorityResource,
        () => {
          authorityEntered = true;
          return withFileLock(
            teamResource,
            () => {
              teamEntered = true;
              return work();
            },
            { ...PRODUCT_TASK_WRITE_LOCK_OPTIONS, acquireTimeoutMs: ASYNC_ACQUIRE_TIMEOUT_MS }
          );
        },
        { ...PRODUCT_TASK_WRITE_LOCK_OPTIONS, acquireTimeoutMs: ASYNC_ACQUIRE_TIMEOUT_MS }
      );
    } catch (error) {
      const acquiredResource = authorityEntered ? teamResource : authorityResource;
      if (
        !teamEntered &&
        error instanceof Error &&
        error.message === `File lock timeout: ${acquiredResource}`
      ) {
        throw new Error('product-authority-lock-transient-busy');
      }
      throw error;
    }
  }

  withCanonicalTaskWrite<T>(teamId: string, work: () => T): T {
    const teamResource = this.resource(teamId);
    return withProductTaskWriteAuthorityLockSync(this.assertDirectory(), () => {
      let entered = false;
      try {
        return withFileLockSync(
          teamResource,
          () => {
            entered = true;
            return work();
          },
          { ...PRODUCT_TASK_WRITE_LOCK_OPTIONS, acquireTimeoutMs: SYNC_ACQUIRE_TIMEOUT_MS }
        );
      } catch (error) {
        if (
          !entered &&
          error instanceof Error &&
          error.message === `File lock timeout: ${teamResource}`
        ) {
          throw new Error('product-authority-lock-transient-busy');
        }
        throw error;
      }
    });
  }
}
