import { isDeepStrictEqual } from 'node:util';

import { HostedLifecycleCurrentAuthorityOps } from './hostedLifecycleCurrentAuthorityOps';

import type { HostedLifecycleAuthorityEpoch } from '../../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedPromotionCommitAuthority } from './hostedPromotionStorageOps';
import type DatabaseConstructor from 'better-sqlite3';

type Database = InstanceType<typeof DatabaseConstructor>;

/** Writer (W) currency: the calling process's own epoch must not be superseded.
 * Unlike member/run currency, an absent deployment authority row is allowed: it means no
 * launch has published an epoch yet, or every published epoch has since been fully retired
 * and swept, not that this caller lost a race against a live successor.
 */
export class HostedProductTaskWriterCurrency {
  constructor(
    private readonly database: () => Database,
    private readonly now: () => number,
    private readonly commitAuthority: () => HostedPromotionCommitAuthority | undefined
  ) {}

  isCurrent(writerEpoch: HostedLifecycleAuthorityEpoch): boolean {
    const authority = new HostedLifecycleCurrentAuthorityOps(
      this.database,
      this.now,
      this.commitAuthority
    ).lookupAuthority(writerEpoch.deploymentId);
    if (!authority) return true;
    if (authority.state !== 'active') return false;
    const { revision: ignoredRevision, state: ignoredState, ...epoch } = authority;
    void ignoredRevision;
    void ignoredState;
    return isDeepStrictEqual(epoch, writerEpoch);
  }
}
