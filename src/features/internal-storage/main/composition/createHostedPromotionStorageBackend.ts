import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedLifecycleCurrentAuthorityGateway } from '../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedLifecycleRunReservationGateway } from '../../contracts/hostedLifecycleRunReservationContracts';
import type { HostedPromotionStorageGateway } from '../../contracts/hostedPromotionStorageContracts';
import type { HostedPromotionCommitBinding } from '../infrastructure/worker/hostedPromotionCommitAuthority';

/** Dedicated worker admitted only after the launcher mount binding is known. */
export function createHostedPromotionStorageBackend(
  databasePath: string,
  promotionCommitBinding: HostedPromotionCommitBinding
): {
  readonly promotions: HostedPromotionStorageGateway;
  readonly hostedRuns: HostedLifecycleRunReservationGateway;
  readonly currentAuthority: HostedLifecycleCurrentAuthorityGateway;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
} {
  const client = new InternalStorageWorkerClient({ databasePath, promotionCommitBinding });
  if (!client.isAvailable()) throw new Error('promotion-storage-worker-unavailable');
  return Object.freeze({
    promotions: client.promotions,
    hostedRuns: client.hostedRuns,
    currentAuthority: client.hostedLifecycleCurrent,
    initialize: async () => {
      await client.ping(true);
    },
    dispose: () => client.close(),
  });
}
