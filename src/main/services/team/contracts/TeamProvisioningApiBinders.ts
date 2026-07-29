import {
  bindTeamProvisioningStartApi,
  bindTeamProvisioningStatusApi,
  bindTeamTaskActivityRepairApi,
} from './TeamProvisioningCapabilityApiBinder';
import {
  bindTeamHttpRuntimeApi,
  bindTeamRuntimeControlCompatibilityApi,
} from './TeamRuntimeApiBinder';

import type {
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamTaskActivityRepairApi,
} from './TeamProvisioningCapabilityApis';
import type {
  TeamHttpRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
} from './TeamProvisioningRuntimeApis';

export interface TeamHttpHandlerApis {
  provisioningStart: TeamProvisioningStartApi;
  provisioningStatus: TeamProvisioningStatusApi;
  taskActivity: TeamTaskActivityRepairApi;
  runtime: TeamHttpRuntimeApi;
  runtimeControl: TeamRuntimeControlCompatibilityApi;
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
