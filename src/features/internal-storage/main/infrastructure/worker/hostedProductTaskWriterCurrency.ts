import {
  classifyHostedLifecycleWriterEpoch,
  type HostedLifecycleWriterEpochDecision,
} from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';

import { assertInternalStorageMutationAdmissionOpen } from './coordinationDurabilityState';
import { HostedLifecycleCurrentAuthorityOps } from './hostedLifecycleCurrentAuthorityOps';

import type { HostedLifecycleAuthorityEpoch } from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

/** Writer (W) currency: the calling process's own epoch must not be superseded.
 * A Product restart leaves no row, or a predecessor's active/retired row, until its first launch.
 * Board edits without an executor stay allowed there, so the first admitted task write claims
 * the epoch itself (see classifyHostedLifecycleWriterEpoch). A newer or retired-own row denies.
 * Both calls run inside resolve()'s BEGIN IMMEDIATE, under Product's global authority lock.
 */
export class HostedProductTaskWriterCurrency {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  classify(writerEpoch: HostedLifecycleAuthorityEpoch): HostedLifecycleWriterEpochDecision {
    return classifyHostedLifecycleWriterEpoch(
      this.authorities().lookupAuthority(writerEpoch.deploymentId),
      writerEpoch
    );
  }

  /** Publishes a claimable writer epoch; false leaves the row untouched and denies the write. */
  claim(writerEpoch: HostedLifecycleAuthorityEpoch): boolean {
    const db = this.database();
    if (!db.inTransaction) throw new Error('hosted-task-write-claim-transaction-required');
    const authorities = this.authorities();
    const previous = authorities.lookupAuthority(writerEpoch.deploymentId);
    if (classifyHostedLifecycleWriterEpoch(previous, writerEpoch) !== 'claimable') return false;
    try {
      // resolve() is classified as a read, so a claim must honour a backup writer fence itself.
      assertInternalStorageMutationAdmissionOpen(db, null);
    } catch (error) {
      if (error instanceof Error && error.message === 'internal-storage-mutation-admission-fenced')
        return false;
      throw error;
    }
    authorities.publishEpochInTransaction(previous, writerEpoch);
    return true;
  }

  private authorities(): HostedLifecycleCurrentAuthorityOps {
    return new HostedLifecycleCurrentAuthorityOps(this.database, this.now, this.commitAuthority);
  }
}
