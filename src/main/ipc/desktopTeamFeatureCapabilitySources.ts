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
import type { HostedApprovalRuntimeTransitionService } from '@main/services/team/provisioning/HostedApprovalRuntimeTransitionService';

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
  teamProvisioningService: DesktopTeamFeatureCapabilitySource,
  hostedApprovalRuntime?: HostedApprovalRuntimeTransitionService
): DesktopTeamFeatureCapabilitySources & {
  readonly messaging: ReturnType<typeof bindTeamMessagingApi>;
} {
  const runTeams = new Map<string, string>();
  const provisioningStart = bindTeamProvisioningStartApi(teamProvisioningService);
  const provisioningRun = bindTeamProvisioningRunApi(teamProvisioningService);
  const runtime = bindTeamRuntimeApi(teamProvisioningService);
  const memberLifecycle = bindTeamMemberLifecycleApi(teamProvisioningService);
  const sources = {
    provisioningStart: hostedApprovalRuntime
      ? {
          createTeam: (request, onProgress) =>
            hostedApprovalRuntime.beforeBindingChange(request.teamName, async () => {
              const response = await provisioningStart.createTeam(request, onProgress);
              runTeams.set(response.runId, request.teamName);
              return response;
            }),
          launchTeam: (request, onProgress) =>
            hostedApprovalRuntime.beforeBindingChange(request.teamName, async () => {
              const response = await provisioningStart.launchTeam(request, onProgress);
              runTeams.set(response.runId, request.teamName);
              return response;
            }),
        }
      : provisioningStart,
    provisioningStatus: bindTeamProvisioningStatusApi(teamProvisioningService),
    preflight: bindTeamProvisioningPreflightApi(teamProvisioningService),
    provisioningRun: hostedApprovalRuntime
      ? {
          async cancelProvisioning(runId: string) {
            const teamName = runTeams.get(runId);
            if (!teamName) return provisioningRun.cancelProvisioning(runId);
            await hostedApprovalRuntime.beforeCancel(teamName, () =>
              provisioningRun.cancelProvisioning(runId)
            );
            runTeams.delete(runId);
          },
          hasProvisioningRun: provisioningRun.hasProvisioningRun,
        }
      : provisioningRun,
    taskActivity: bindTeamTaskActivityRepairApi(teamProvisioningService),
    runtime: hostedApprovalRuntime
      ? {
          ...runtime,
          stopTeam: (teamName: string) =>
            hostedApprovalRuntime.beforeStop(teamName, () => runtime.stopTeam(teamName)),
        }
      : runtime,
    memberLifecycle: hostedApprovalRuntime
      ? {
          ...memberLifecycle,
          attachLiveRosterMember: (
            ...args: Parameters<typeof memberLifecycle.attachLiveRosterMember>
          ) =>
            hostedApprovalRuntime.beforeBindingChange(args[0], () =>
              memberLifecycle.attachLiveRosterMember(...args)
            ),
          detachLiveRosterMember: (
            ...args: Parameters<typeof memberLifecycle.detachLiveRosterMember>
          ) =>
            hostedApprovalRuntime.beforeBindingChange(args[0], () =>
              memberLifecycle.detachLiveRosterMember(...args)
            ),
          restartMember: (...args: Parameters<typeof memberLifecycle.restartMember>) =>
            hostedApprovalRuntime.beforeBindingChange(args[0], () =>
              memberLifecycle.restartMember(...args)
            ),
        }
      : memberLifecycle,
    diagnostics: bindTeamDiagnosticsApi(teamProvisioningService),
    claudeLogs: bindTeamClaudeLogsApi(teamProvisioningService),
    messaging: bindTeamMessagingApi(teamProvisioningService),
    toolApproval: bindTeamToolApprovalApi(teamProvisioningService),
  } satisfies DesktopTeamFeatureCapabilitySources & DesktopTeamApplicationCapabilitySources;

  return sources;
}
