import { DeliverRuntimeMessageUseCase } from '../../core/application/commands/DeliverRuntimeMessageUseCase';
import { RespondToToolApprovalUseCase } from '../../core/application/commands/RespondToToolApprovalUseCase';
import { UpdateToolApprovalSettingsUseCase } from '../../core/application/commands/UpdateToolApprovalSettingsUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { GetRuntimeSnapshotUseCase } from '../../core/application/queries/GetRuntimeSnapshotUseCase';

import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
  TeamProvisioningApplicationApi,
} from '../../contracts';
import type { RuntimeDeliveryPort } from '../../core/application/ports/RuntimeDeliveryPort';
import type { ToolApprovalPort } from '../../core/application/ports/ToolApprovalPort';
import type { RuntimeSnapshotReaderPort } from '../../core/application/queries/GetRuntimeSnapshotUseCase';

export type TeamProvisioningApplicationFeature = TeamProvisioningApplicationApi;

type TeamAgentRuntimeSnapshot = Awaited<
  ReturnType<TeamProvisioningApplicationApi['getTeamAgentRuntimeSnapshot']>
>;
type OpenCodeRuntimeMessageDeliveryAck = RuntimeMessageDeliveryAck<'opencode'>;
type OpenCodeRuntimeDeliveryStatus = RuntimeDeliveryStatus<'opencode'>;

export interface TeamProvisioningApplicationFeatureDependencies {
  runtimeSnapshot: RuntimeSnapshotReaderPort<TeamAgentRuntimeSnapshot>;
  toolApproval: ToolApprovalPort;
  runtimeDelivery: RuntimeDeliveryPort<
    unknown,
    OpenCodeRuntimeMessageDeliveryAck,
    OpenCodeRuntimeDeliveryStatus
  >;
}

export function createTeamProvisioningApplicationFeature(
  dependencies: TeamProvisioningApplicationFeatureDependencies
): TeamProvisioningApplicationFeature {
  const getRuntimeSnapshot = new GetRuntimeSnapshotUseCase(dependencies.runtimeSnapshot);
  const respondToToolApproval = new RespondToToolApprovalUseCase(dependencies.toolApproval);
  const updateToolApprovalSettings = new UpdateToolApprovalSettingsUseCase(
    dependencies.toolApproval
  );
  const deliverRuntimeMessage = new DeliverRuntimeMessageUseCase(dependencies.runtimeDelivery);
  const getRuntimeDeliveryStatus = new GetRuntimeDeliveryStatusUseCase(
    dependencies.runtimeDelivery
  );

  return {
    getTeamAgentRuntimeSnapshot: (teamName) => getRuntimeSnapshot.execute({ teamName }),
    respondToToolApproval: (teamName, runId, requestId, allow, message) =>
      respondToToolApproval.execute({ teamName, runId, requestId, allow, message }),
    updateToolApprovalSettings: (teamName, settings) =>
      updateToolApprovalSettings.execute({ teamName, settings }),
    deliverRuntimeMessage: (input) => deliverRuntimeMessage.execute({ input }),
    getRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
    deliverOpenCodeRuntimeMessage: (raw) => deliverRuntimeMessage.execute({ input: raw }),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
  };
}
