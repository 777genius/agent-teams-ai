import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { HostedLifecycleCurrentAuthorityGateway } from '../../contracts/hostedLifecycleCurrentAuthorityContracts';
import type { HostedLifecycleRunReservationGateway } from '../../contracts/hostedLifecycleRunReservationContracts';
import type { HostedPromotionStorageGateway } from '../../contracts/hostedPromotionStorageContracts';
import type {
  HostedTaskAssignmentCurrentPin,
  HostedTaskAssignmentCurrentSelector,
} from '../../contracts/hostedTaskAssignmentCurrentContracts';
import type { HostedPromotionCommitBinding } from '../infrastructure/worker/hostedPromotionCommitAuthority';

/** Dedicated worker admitted only after the launcher mount binding is known. */
export function createHostedPromotionStorageBackend(
  databasePath: string,
  promotionCommitBinding: HostedPromotionCommitBinding,
  productAuthorityLockDirectory?: string
): {
  readonly promotions: HostedPromotionStorageGateway;
  readonly hostedRuns: HostedLifecycleRunReservationGateway;
  readonly currentAuthority: HostedLifecycleCurrentAuthorityGateway;
  readonly taskAssignmentCurrent: {
    resolveCurrent(
      input: HostedTaskAssignmentCurrentSelector
    ): Promise<HostedTaskAssignmentCurrentPin | null>;
  };
  initialize(): Promise<void>;
  dispose(): Promise<void>;
} {
  const client = new InternalStorageWorkerClient({
    databasePath,
    promotionCommitBinding,
    productAuthorityLockDirectory,
  });
  if (!client.isAvailable()) throw new Error('promotion-storage-worker-unavailable');
  return Object.freeze({
    promotions: client.promotions,
    hostedRuns: client.hostedRuns,
    currentAuthority: client.hostedLifecycleCurrent,
    taskAssignmentCurrent: client.hostedTaskAssignmentCurrent,
    initialize: async () => {
      await client.ping(true);
    },
    dispose: () => client.close(),
  });
}
