import { bindTeamMessagingApi } from './TeamMessagingApiBinder';
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
} from './TeamProvisioningCapabilityApiBinder';
import {
  bindTeamHttpRuntimeApi,
  bindTeamRuntimeApi,
  bindTeamRuntimeControlCompatibilityApi,
} from './TeamRuntimeApiBinder';

import type {
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamMemberLifecycleApi,
  TeamProvisioningPreflightApi,
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamTaskActivityRepairApi,
  TeamToolApprovalApi,
} from './TeamProvisioningCapabilityApis';
import type { TeamMessagingApi } from './TeamProvisioningMessagingApis';
import type {
  TeamHttpRuntimeApi,
  TeamRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
} from './TeamProvisioningRuntimeApis';

export interface TeamHttpHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamHttpRuntimeApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
}

export interface TeamIpcHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  preflight: TeamProvisioningPreflightApi;
  provisioningRun: TeamProvisioningRunApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamRuntimeApi;
  memberLifecycle: TeamMemberLifecycleApi;
  diagnostics: TeamDiagnosticsApi;
  claudeLogs: TeamClaudeLogsApi;
  messaging: TeamMessagingApi;
  toolApproval: TeamToolApprovalApi;
}

export function bindTeamHttpHandlerApis(
  source: TeamProvisioningStartApi &
    TeamProvisioningStatusApi &
    TeamTaskActivityRepairApi &
    TeamHttpRuntimeApi &
    TeamRuntimeControlCompatibilityApi
): TeamHttpHandlerApis {
  return {
    provisioningStart: bindTeamProvisioningStartApi(source),
    provisioningStatus: bindTeamProvisioningStatusApi(source),
    taskActivity: bindTeamTaskActivityRepairApi(source),
    runtime: bindTeamHttpRuntimeApi(source),
    runtimeControl: bindTeamRuntimeControlCompatibilityApi(source),
  };
}

export function bindTeamIpcHandlerApis(
  source: TeamProvisioningStartApi &
    TeamProvisioningStatusApi &
    TeamProvisioningPreflightApi &
    TeamProvisioningRunApi &
    TeamTaskActivityRepairApi &
    TeamRuntimeApi &
    TeamMemberLifecycleApi &
    TeamDiagnosticsApi &
    TeamClaudeLogsApi &
    TeamMessagingApi &
    TeamToolApprovalApi
): TeamIpcHandlerApis {
  return {
    provisioningStart: bindTeamProvisioningStartApi(source),
    provisioningStatus: bindTeamProvisioningStatusApi(source),
    preflight: bindTeamProvisioningPreflightApi(source),
    provisioningRun: bindTeamProvisioningRunApi(source),
    taskActivity: bindTeamTaskActivityRepairApi(source),
    runtime: bindTeamRuntimeApi(source),
    memberLifecycle: bindTeamMemberLifecycleApi(source),
    diagnostics: bindTeamDiagnosticsApi(source),
    claudeLogs: bindTeamClaudeLogsApi(source),
    messaging: bindTeamMessagingApi(source),
    toolApproval: bindTeamToolApprovalApi(source),
  };
}

export { bindTeamCrossTeamMessagingApi, bindTeamMessagingApi } from './TeamMessagingApiBinder';
export {
  bindTeamClaudeLogsApi,
  bindTeamDiagnosticsApi,
  bindTeamHttpDataApi,
  bindTeamMemberLifecycleApi,
  bindTeamProvisioningPreflightApi,
  bindTeamProvisioningRunApi,
  bindTeamProvisioningStartApi,
  bindTeamProvisioningStatusApi,
  bindTeamTaskActivityRepairApi,
  bindTeamToolApprovalApi,
} from './TeamProvisioningCapabilityApiBinder';
export {
  bindTeamHttpRuntimeApi,
  bindTeamRuntimeApi,
  bindTeamRuntimeControlCompatibilityApi,
} from './TeamRuntimeApiBinder';
