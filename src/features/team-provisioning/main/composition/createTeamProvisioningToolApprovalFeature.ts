import { RespondToToolApprovalUseCase } from '../../core/application/commands/RespondToToolApprovalUseCase';
import { UpdateToolApprovalSettingsUseCase } from '../../core/application/commands/UpdateToolApprovalSettingsUseCase';
import { LegacyToolApprovalAdapter } from '../adapters/output/LegacyToolApprovalAdapter';

import type { TeamProvisioningToolApprovalApi } from '../../contracts/tool-approval';
import type { LegacyToolApprovalSource } from '../adapters/output/LegacyToolApprovalAdapter';

export type TeamProvisioningToolApprovalFeature = TeamProvisioningToolApprovalApi;

export interface TeamProvisioningToolApprovalFeatureDeps {
  toolApprovalSource: LegacyToolApprovalSource;
}

export function createTeamProvisioningToolApprovalFeature(
  deps: TeamProvisioningToolApprovalFeatureDeps
): TeamProvisioningToolApprovalFeature {
  const toolApproval = new LegacyToolApprovalAdapter(deps.toolApprovalSource);
  const respond = new RespondToToolApprovalUseCase(toolApproval);
  const updateSettings = new UpdateToolApprovalSettingsUseCase(toolApproval);

  return {
    respondToToolApproval: (teamName, runId, requestId, allow, message) =>
      respond.execute({ teamName, runId, requestId, allow, message }),
    updateToolApprovalSettings: (teamName, settings) =>
      updateSettings.execute({ teamName, settings }),
  };
}
