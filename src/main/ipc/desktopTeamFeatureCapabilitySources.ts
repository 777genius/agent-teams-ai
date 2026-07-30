import { bindTeamMessagingApi } from '@main/services/team/contracts/TeamMessagingApiBinder';
import {
  bindTeamClaudeLogsApi,
  bindTeamDiagnosticsApi,
  bindTeamMemberLifecycleApi,
  bindTeamProvisioningPreflightApi,
  bindTeamProvisioningRunApi,
  bindTeamProvisioningStartApi,
  bindTeamProvisioningStatusApi,
  bindTeamTaskActivityRepairApi,
  bindTeamToolApprovalApi,
} from '@main/services/team/contracts/TeamProvisioningCapabilityApiBinder';
import { bindTeamRuntimeApi } from '@main/services/team/contracts/TeamRuntimeApiBinder';

import type { DesktopTeamFeatureCapabilitySources } from './teamFeatureCapabilities';
import type { TeamProvisioningService } from '@main/services/team/TeamProvisioningService';

export function createDesktopTeamFeatureCapabilitySources(
  teamProvisioningService: TeamProvisioningService
): DesktopTeamFeatureCapabilitySources & {
  readonly messaging: ReturnType<typeof bindTeamMessagingApi>;
} {
  return {
    provisioningStart: bindTeamProvisioningStartApi(teamProvisioningService),
    provisioningStatus: bindTeamProvisioningStatusApi(teamProvisioningService),
    preflight: bindTeamProvisioningPreflightApi(teamProvisioningService),
    provisioningRun: bindTeamProvisioningRunApi(teamProvisioningService),
    taskActivity: bindTeamTaskActivityRepairApi(teamProvisioningService),
    runtime: bindTeamRuntimeApi(teamProvisioningService),
    memberLifecycle: bindTeamMemberLifecycleApi(teamProvisioningService),
    diagnostics: bindTeamDiagnosticsApi(teamProvisioningService),
    claudeLogs: bindTeamClaudeLogsApi(teamProvisioningService),
    messaging: bindTeamMessagingApi(teamProvisioningService),
    toolApproval: bindTeamToolApprovalApi(teamProvisioningService),
  };
}
