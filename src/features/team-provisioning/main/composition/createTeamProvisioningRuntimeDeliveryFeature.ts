import { DeliverRuntimeMessageUseCase } from '../../core/application/commands/DeliverRuntimeMessageUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { LegacyRuntimeDeliveryAdapter } from '../adapters/output/LegacyRuntimeDeliveryAdapter';

import type { TeamProvisioningRuntimeDeliveryApi } from '../../contracts/runtime-delivery';
import type {
  LegacyRuntimeDeliveryAdapterDeps,
  LegacyRuntimeDeliveryCompatibilityApi,
} from '../adapters/output/LegacyRuntimeDeliveryAdapter';

export type TeamProvisioningRuntimeDeliveryFeatureDeps = LegacyRuntimeDeliveryAdapterDeps;

export function createTeamProvisioningRuntimeDeliveryFeature(
  deps: TeamProvisioningRuntimeDeliveryFeatureDeps
): TeamProvisioningRuntimeDeliveryApi & LegacyRuntimeDeliveryCompatibilityApi {
  const runtimeDelivery = new LegacyRuntimeDeliveryAdapter(deps);
  const deliverRuntimeMessage = new DeliverRuntimeMessageUseCase(runtimeDelivery);
  const getRuntimeDeliveryStatus = new GetRuntimeDeliveryStatusUseCase(runtimeDelivery);

  return {
    deliverRuntimeMessage: (input) => deliverRuntimeMessage.execute({ input }),
    getRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
    deliverOpenCodeRuntimeMessage: (raw) => deliverRuntimeMessage.execute({ input: raw }),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
  };
}
