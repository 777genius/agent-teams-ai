import type {
  TeamCreateConfigRequest,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
  TeamRuntimeState,
  TeamSummary,
  TeamViewSnapshot,
} from '@shared/types/team';

/**
 * Provider-neutral data operations consumed by the team application host.
 *
 * This contract deliberately contains only application-visible data methods;
 * provider execution, process supervision, and transport concerns stay behind
 * their respective capability boundaries.
 */
export interface TeamApplicationDataApi {
  listTeams(): Promise<TeamSummary[]>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

/** Application-visible create and launch commands. */
export interface TeamApplicationProvisioningStartApi {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

/** Application-visible provisioning status query. */
export interface TeamApplicationProvisioningStatusApi {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

/** Application-visible runtime read/stop operations. */
export interface TeamApplicationRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}

/** Explicit snapshot reconciliation needed before an application read. */
export interface TeamApplicationTaskActivityApi {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

/** Post-write work-sync resumption delegated to its existing owner. */
export interface TeamApplicationResumeApi {
  resumeTeam(teamName: string): void;
}
