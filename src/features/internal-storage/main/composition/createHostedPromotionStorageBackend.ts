import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedPromotionStorageGateway } from '../../contracts/hostedPromotionStorageContracts';
import type { HostedPromotionCommitBinding } from '../infrastructure/worker/hostedPromotionCommitAuthority';

/** Dedicated worker admitted only after the launcher mount binding is known. */
export function createHostedPromotionStorageBackend(
  databasePath: string,
  promotionCommitBinding: HostedPromotionCommitBinding
): {
  readonly promotions: HostedPromotionStorageGateway;
  initialize(): Promise<void>;
  dispose(): Promise<void>;
} {
  const client = new InternalStorageWorkerClient({ databasePath, promotionCommitBinding });
  if (!client.isAvailable()) throw new Error('promotion-storage-worker-unavailable');
  return Object.freeze({
    promotions: client.promotions,
    initialize: async () => {
      await client.ping(true);
    },
    dispose: () => client.close(),
  });
}
