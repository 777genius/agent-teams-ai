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

export interface TeamApplicationDataPort {
  listTeams(): Promise<TeamSummary[]>;
  getTeamData(teamName: string): Promise<TeamViewSnapshot>;
  getSavedRequest(teamName: string): Promise<TeamCreateRequest | null>;
  createTeamConfig(request: TeamCreateConfigRequest): Promise<void>;
}

export interface TeamConfigPresencePort {
  hasConfig(teamName: string): Promise<boolean>;
}

export interface TeamProvisioningStartPort {
  createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse>;
  launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse>;
}

export interface TeamProvisioningStatusPort {
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
}

export interface TeamRuntimePort {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}

export interface TeamTaskActivityPort {
  repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void>;
}

export interface TeamResumePort {
  resumeTeam(teamName: string): void;
}

export interface TeamListInvalidationPort {
  invalidate(): void;
}

export interface TeamApplicationHostPorts {
  readonly configPresence: TeamConfigPresencePort;
  readonly listInvalidation: TeamListInvalidationPort;
  readonly data?: TeamApplicationDataPort;
  readonly provisioningStart?: TeamProvisioningStartPort;
  readonly provisioningStatus?: TeamProvisioningStatusPort;
  readonly runtime?: TeamRuntimePort;
  readonly taskActivity?: TeamTaskActivityPort;
  readonly resume?: TeamResumePort;
}

export interface TeamLaunchRequestBranches {
  createFromDraft(savedRequest: TeamCreateRequest): TeamCreateRequest;
  resumeExisting(): TeamLaunchRequest;
}

export interface PendingTeamDraftView {
  readonly teamName: string;
  readonly pendingCreate: true;
  readonly savedRequest: TeamCreateRequest;
}

export type TeamApplicationView = TeamViewSnapshot | PendingTeamDraftView;
export type TeamApplicationLaunchResult = TeamCreateResponse | TeamLaunchResponse;
