import type { ToolApprovalSettings } from '@shared/types';

export interface RespondToToolApprovalCommand {
  teamName: string;
  runId: string;
  requestId: string;
  allow: boolean;
  message?: string;
}

export interface UpdateToolApprovalSettingsCommand {
  teamName: string;
  settings: ToolApprovalSettings;
}

/**
 * Stable tool-approval command surface used by the provisioning compatibility
 * boundary while callers migrate to the feature.
 */
export interface TeamProvisioningToolApprovalApi {
  respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void>;
  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void;
}
