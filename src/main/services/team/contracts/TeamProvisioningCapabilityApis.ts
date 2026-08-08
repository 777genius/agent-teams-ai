import type {
  TeamProvisioningRuntimeSnapshotApi as FeatureTeamProvisioningRuntimeSnapshotApi,
  TeamProvisioningStatusApi as FeatureTeamProvisioningStatusApi,
  TeamProvisioningToolApprovalApi as FeatureTeamProvisioningToolApprovalApi,
} from '@features/team-provisioning/contracts';
import type {
  LeadActivitySnapshot,
  LeadContextUsageSnapshot,
  MemberSpawnStatusesSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamClaudeLogsQuery,
  TeamClaudeLogsResponse,
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamSummary,
  TeamViewSnapshot,
} from '@shared/types/team';

export interface TeamProvisioningStartApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

export type TeamProvisioningStatusApi = FeatureTeamProvisioningStatusApi;

export interface TeamProvisioningRunApi {
  cancelProvisioning(runId: string): Promise<void>;
  hasProvisioningRun(teamName: string): boolean;
}

export interface TeamTaskActivityRepairApi {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

export interface TeamProvisioningPrepareOptions {
  forceFresh?: boolean;
  providerId?: TeamProviderId;
  providerIds?: TeamProviderId[];
  modelIds?: string[];
  modelChecks?: TeamProvisioningModelCheckRequest[];
  limitContext?: boolean;
  modelVerificationMode?: TeamProvisioningModelVerificationMode;
}

export interface TeamProvisioningPreflightApi {
  getCliHelpOutput(): Promise<string>;
  prepareForProvisioning(
    cwd?: string,
    opts?: TeamProvisioningPrepareOptions
  ): Promise<TeamProvisioningPrepareResult>;
}

export interface TeamHttpDataApi {
  listTeams(): Promise<TeamSummary[]>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

export type TeamLiveRosterAttachReason = 'member_added' | 'member_restored' | 'member_updated';

export interface TeamMemberLifecycleApi {
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  runLiveRosterMutation(teamName: string, mutation: () => Promise<void>): Promise<void>;
  attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: TeamLiveRosterAttachReason }
  ): Promise<void>;
  detachLiveRosterMember(teamName: string, memberName: string): Promise<void>;
  restartMember(teamName: string, memberName: string): Promise<void>;
  retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  skipMemberForLaunch(teamName: string, memberName: string): Promise<void>;
}

export interface TeamDiagnosticsApi extends FeatureTeamProvisioningRuntimeSnapshotApi {
  getLeadActivityState(teamName: string): LeadActivitySnapshot;
  getLeadContextUsage(teamName: string): LeadContextUsageSnapshot;
}

export interface TeamClaudeLogsApi {
  getClaudeLogs(teamName: string, query?: TeamClaudeLogsQuery): Promise<TeamClaudeLogsResponse>;
}

export interface TeamToolApprovalApi extends FeatureTeamProvisioningToolApprovalApi {
  getPendingToolApprovalFilePath(teamName: string, runId: string, requestId: string): string | null;
  getPendingToolApprovalFileTarget(
    teamName: string,
    runId: string,
    requestId: string
  ): { authorizationGeneration: string; authorizationPath: string; readPath: string } | null;
}
