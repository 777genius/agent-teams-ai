import * as fs from 'fs';
import * as path from 'path';

import { acquireGenerationBoundCleanupLock } from './atomicCreateCleanupGenerationLock';
import {
  type AtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryBudget,
} from './atomicCreateCleanupRecoveryIo';
import { lstatOrNull } from './atomicWriteRecovery';
import {
  type DurableFileIdentity,
  type DurablePathIdentity,
  getDurableFileIdentity,
  getDurablePathIdentity,
  isSameDurableFileIdentity,
} from './durablePathIdentity';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

/**
 * Reclaim only a stale, dead lease while the supplied admission fence holds.
 * On stock Node it retires the lease namespace instead of deleting an
 * unproven generation; exact hosts bind every destructive operation to the
 * descriptor identity observed at that boundary.
 */
export async function reclaimExpiredAtomicCreateLeases(
  directory: string,
  leases: () => Promise<string[]>,
  isLiveLease: (lease: string) => Promise<boolean>,
  ownerPath: (lease: string) => string,
  leaseMaxAgeMs: number,
  retireLease: (lease: string) => Promise<void>,
  assertOwnership: () => Promise<void>,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  if (!safeLeaseReclamationAvailable()) {
    throw new Error('Atomic-create lease reclamation requires operator reconciliation');
  }
  for (const lease of await leases()) {
    const leasePath = path.join(directory, lease);
    try {
      const stats = budget
        ? await withinAtomicCreateRecoveryBudget(budget, 'stale-lease-lstat', () =>
            fs.promises.lstat(leasePath)
          )
        : await fs.promises.lstat(leasePath);
      if (Date.now() - stats.mtimeMs <= leaseMaxAgeMs || (await isLiveLease(lease))) continue;
      await assertOwnership();
      const exact = exactGenerationOperations();
      if (!exact.unlinkExactGeneration || !exact.rmdirExactGeneration) {
        await retireLease(lease);
        continue;
      }
      const owner = ownerPath(lease);
      const ownerStats = budget
        ? await withinAtomicCreateRecoveryBudget(budget, 'stale-lease-owner-lstat', () =>
            lstatOrNull(owner)
          )
        : await lstatOrNull(owner);
      if (!ownerStats) {
        // An empty/crash-prefix directory has no authenticated dead owner.
        // Its age is only a scan hint, never authority to erase a pathname an
        // attacker may have populated after the crash. Keep this bounded by
        // capacity until an exact, authenticated recovery mechanism exists.
        continue;
      }
      if (!ownerStats.isFile() || ownerStats.isSymbolicLink()) continue;
      const candidateOwnerIdentity = getDurableFileIdentity(ownerStats);
      let releaseOwnerLock: (() => Promise<void>) | null = null;
      try {
        const acquire = () =>
          acquireGenerationBoundCleanupLock(owner, {
            realpath: false,
            stale: leaseMaxAgeMs,
            update: Math.floor(leaseMaxAgeMs / 6),
            retries: 0,
          });
        releaseOwnerLock = budget
          ? await withinAtomicCreateRecoveryBudget(
              budget,
              'stale-lease-owner-lock',
              acquire,
              (pending) => {
                void pending.then(
                  (lateRelease) => lateRelease().catch(() => undefined),
                  () => undefined
                );
              }
            )
          : await acquire();
      } catch {
        continue;
      }
      let primaryError: unknown = null;
      let reclaimedOwner = false;
      try {
        await assertOwnership();
        const lockedOwner = budget
          ? await withinAtomicCreateRecoveryBudget(budget, 'locked-lease-owner-lstat', () =>
              lstatOrNull(owner)
            )
          : await lstatOrNull(owner);
        const lockedGenerationMatches = Boolean(
          lockedOwner &&
          lockedOwner.isFile() &&
          !lockedOwner.isSymbolicLink() &&
          isSameDurableFileIdentity(getDurableFileIdentity(lockedOwner), candidateOwnerIdentity)
        );
        // Recheck liveness after acquiring this generation's owner lock. The
        // initial scan is only a candidate filter; it is never deletion
        // authority for a lease that may have heartbeated meanwhile.
        if (lockedGenerationMatches && !(await isLiveLease(lease))) {
          try {
            await retryOnTransientFsError(
              () => exact.unlinkExactGeneration!(owner, candidateOwnerIdentity),
              RENAME_PUBLISH_RETRY
            );
            reclaimedOwner = true;
          } catch (error) {
            // A replacement B won after the locked recheck. It is not A's
            // deletion authority, so do not continue to remove its lock/lease.
            if (!isMissing(error)) throw error;
          }
        }
      } catch (error) {
        primaryError = error;
      }
      try {
        await releaseOwnerLock();
      } catch (releaseError) {
        if (primaryError) {
          throw new AggregateError(
            [primaryError, releaseError],
            'Atomic-create stale lease release failed after reclamation failed'
          );
        }
        throw releaseError;
      }
      if (primaryError) throw primaryError;
      if (!reclaimedOwner) continue;
      // releaseOwnerLock is the only owner of its lock-directory generation.
      // Never re-read that pathname after removing owner A: it may now name B.
      await assertOwnership();
      await retryOnTransientFsError(
        // Retire exactly the lease generation seen by this scan, not a final
        // pathname observation after owner removal.
        () => exact.rmdirExactGeneration!(leasePath, getDurablePathIdentity(stats)),
        RENAME_PUBLISH_RETRY
      );
    } catch (error) {
      if (!isMissing(error) && codeOf(error) !== 'ENOTEMPTY') throw error;
    }
  }
}

function safeLeaseReclamationAvailable(): boolean {
  return false;
}
