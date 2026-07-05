import type { OpenCodeRuntimeControlAck } from '../runtime-control';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types/team';

export interface TeamLaunchApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
  repairStaleTaskActivityIntervalsBeforeSnapshot?(teamName: string): Promise<void>;
}

export type TeamProvisioningStartApi = TeamLaunchApi;

export type { OpenCodeRuntimeControlAck };

export interface TeamRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  getCurrentRunId(teamName: string): string | null;
  recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
}

export interface TeamMemberLifecycleApi {
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
}

export interface TeamDiagnosticsApi {
  getLeadActivityState(teamName: string): LeadActivitySnapshot;
  getLeadContextUsage(teamName: string): LeadContextUsageSnapshot;
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}

export function bindTeamLaunchApi(source: TeamLaunchApi): TeamLaunchApi {
  const api: TeamLaunchApi = {
    createTeam: source.createTeam.bind(source),
    launchTeam: source.launchTeam.bind(source),
    getProvisioningStatus: source.getProvisioningStatus.bind(source),
  };
  const repairStaleTaskActivityIntervalsBeforeSnapshot =
    source.repairStaleTaskActivityIntervalsBeforeSnapshot?.bind(source);
  if (repairStaleTaskActivityIntervalsBeforeSnapshot) {
    api.repairStaleTaskActivityIntervalsBeforeSnapshot =
      repairStaleTaskActivityIntervalsBeforeSnapshot;
  }
  return api;
}

export function bindTeamRuntimeApi(source: TeamRuntimeApi): TeamRuntimeApi {
  return {
    getRuntimeState: source.getRuntimeState.bind(source),
    stopTeam: source.stopTeam.bind(source),
    isTeamAlive: source.isTeamAlive.bind(source),
    getAliveTeams: source.getAliveTeams.bind(source),
    getCurrentRunId: source.getCurrentRunId.bind(source),
    recordOpenCodeRuntimeBootstrapCheckin:
      source.recordOpenCodeRuntimeBootstrapCheckin.bind(source),
    deliverOpenCodeRuntimeMessage: source.deliverOpenCodeRuntimeMessage.bind(source),
    recordOpenCodeRuntimeTaskEvent: source.recordOpenCodeRuntimeTaskEvent.bind(source),
    recordOpenCodeRuntimeHeartbeat: source.recordOpenCodeRuntimeHeartbeat.bind(source),
  };
}

export function bindTeamMemberLifecycleApi(source: TeamMemberLifecycleApi): TeamMemberLifecycleApi {
  return {
    getMemberSpawnStatuses: source.getMemberSpawnStatuses.bind(source),
    restartMember: source.restartMember.bind(source),
    retryFailedOpenCodeSecondaryLanes: source.retryFailedOpenCodeSecondaryLanes.bind(source),
    skipMemberForLaunch: source.skipMemberForLaunch.bind(source),
  };
}

export function bindTeamDiagnosticsApi(source: TeamDiagnosticsApi): TeamDiagnosticsApi {
  return {
    getLeadActivityState: source.getLeadActivityState.bind(source),
    getLeadContextUsage: source.getLeadContextUsage.bind(source),
    getTeamAgentRuntimeSnapshot: source.getTeamAgentRuntimeSnapshot.bind(source),
  };
}
