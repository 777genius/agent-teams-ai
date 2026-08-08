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
import type {
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationRuntimeApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';

type DesktopTeamFeatureCapabilitySource = Parameters<typeof bindTeamMessagingApi>[0] &
  Parameters<typeof bindTeamClaudeLogsApi>[0] &
  Parameters<typeof bindTeamDiagnosticsApi>[0] &
  Parameters<typeof bindTeamMemberLifecycleApi>[0] &
  Parameters<typeof bindTeamProvisioningPreflightApi>[0] &
  Parameters<typeof bindTeamProvisioningRunApi>[0] &
  Parameters<typeof bindTeamProvisioningStartApi>[0] &
  Parameters<typeof bindTeamProvisioningStatusApi>[0] &
  Parameters<typeof bindTeamRuntimeApi>[0] &
  Parameters<typeof bindTeamTaskActivityRepairApi>[0] &
  Parameters<typeof bindTeamToolApprovalApi>[0];

interface DesktopTeamApplicationCapabilitySources {
  readonly provisioningStart: TeamApplicationProvisioningStartApi;
  readonly provisioningStatus: TeamApplicationProvisioningStatusApi;
  readonly runtime: TeamApplicationRuntimeApi;
  readonly taskActivity: TeamApplicationTaskActivityApi;
}

export function createDesktopTeamFeatureCapabilitySources(
  teamProvisioningService: DesktopTeamFeatureCapabilitySource
): DesktopTeamFeatureCapabilitySources & {
  readonly messaging: ReturnType<typeof bindTeamMessagingApi>;
} {
  const sources = {
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
  } satisfies DesktopTeamFeatureCapabilitySources & DesktopTeamApplicationCapabilitySources;

  return sources;
}
