import { DeliverRuntimeMessageUseCase } from '../../core/application/commands/DeliverRuntimeMessageUseCase';
import { RespondToToolApprovalUseCase } from '../../core/application/commands/RespondToToolApprovalUseCase';
import { UpdateToolApprovalSettingsUseCase } from '../../core/application/commands/UpdateToolApprovalSettingsUseCase';
import { GetRuntimeDeliveryStatusUseCase } from '../../core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { GetRuntimeSnapshotUseCase } from '../../core/application/queries/GetRuntimeSnapshotUseCase';

import type { TeamAgentRuntimeSnapshot, TeamProvisioningApplicationApi } from '../../contracts';
import type { RuntimeDeliveryPort } from '../../core/application/ports/RuntimeDeliveryPort';
import type { ToolApprovalPort } from '../../core/application/ports/ToolApprovalPort';
import type { RuntimeSnapshotReaderPort } from '../../core/application/queries/GetRuntimeSnapshotUseCase';

export type TeamProvisioningApplicationFeature = TeamProvisioningApplicationApi;

export interface TeamProvisioningApplicationFeatureDependencies {
  runtimeSnapshot: RuntimeSnapshotReaderPort<TeamAgentRuntimeSnapshot>;
  toolApproval: ToolApprovalPort;
  runtimeDelivery: RuntimeDeliveryPort;
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
    deliverOpenCodeRuntimeMessage: (raw) => deliverRuntimeMessage.execute({ raw }),
    getOpenCodeRuntimeDeliveryStatus: (teamName, messageId) =>
      getRuntimeDeliveryStatus.execute({ teamName, messageId }),
  };
}
