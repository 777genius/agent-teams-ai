import { createTeamApplicationHost } from './createTeamApplicationHost';

import type { TeamApplicationHost } from './TeamApplicationHost';
import type { TeamApplicationResumeApi } from '@main/services/team/contracts/TeamApplicationCapabilityApis';
import type { TeamHttpMemberDiagnosticsApi } from '@main/services/team/contracts/TeamHttpMemberDiagnosticsApi';
import type { TeamHttpDataApi } from '@main/services/team/contracts/TeamProvisioningCapabilityApis';
import type { TeamHttpHandlerApis } from '@main/services/team/contracts/TeamProvisioningApiBinders';

/** Desktop-only composition for the HTTP team application host. */
export function createDesktopTeamApplicationHost(
  data: TeamHttpDataApi & {
    renameDraftTeam(oldTeamName: string, newTeamName: string): Promise<void>;
  },
  handlers: TeamHttpHandlerApis,
  memberWorkSync?: TeamApplicationResumeApi | null
): TeamApplicationHost {
  return createTeamApplicationHost({
    data,
    provisioningStart: handlers.provisioningStart,
    provisioningStatus: handlers.provisioningStatus,
    runtime: handlers.runtime,
    runtimeIngress: handlers.runtimeIngress,
    taskActivity: handlers.taskActivity,
    memberWorkSync: memberWorkSync ?? undefined,
  });
}

/** Binds read-only diagnostics without exposing the provisioning aggregate to routes. */
export function createTeamHttpMemberDiagnosticsApi(
  source: TeamHttpMemberDiagnosticsApi
): TeamHttpMemberDiagnosticsApi {
  return {
    getMemberSpawnStatusesReadOnly: (teamName) => source.getMemberSpawnStatusesReadOnly(teamName),
    getTeamAgentRuntimeSnapshotReadOnly: (teamName, options) =>
      source.getTeamAgentRuntimeSnapshotReadOnly(teamName, options),
  };
}
