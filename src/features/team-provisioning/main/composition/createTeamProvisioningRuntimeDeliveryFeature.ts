import { DeliverRuntimeMessageUseCase } from '../../core/application/commands/DeliverRuntimeMessageUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { LegacyRuntimeDeliveryAdapter } from '../adapters/output/LegacyRuntimeDeliveryAdapter';

import type { TeamProvisioningRuntimeDeliveryApi } from '../../contracts/runtime-delivery';
import type { LegacyRuntimeDeliveryAdapterDeps } from '../adapters/output/LegacyRuntimeDeliveryAdapter';

export type TeamProvisioningRuntimeDeliveryFeatureDeps = LegacyRuntimeDeliveryAdapterDeps;

export function createTeamProvisioningRuntimeDeliveryFeature(
  deps: TeamProvisioningRuntimeDeliveryFeatureDeps
): TeamProvisioningRuntimeDeliveryApi {
  const runtimeDelivery = new LegacyRuntimeDeliveryAdapter(deps);
  const deliverRuntimeMessage = new DeliverRuntimeMessageUseCase(runtimeDelivery);
  const getRuntimeDeliveryStatus = new GetRuntimeDeliveryStatusUseCase(runtimeDelivery);

  return {
    deliverOpenCodeRuntimeMessage: (raw) => deliverRuntimeMessage.execute({ raw }),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
  };
}
