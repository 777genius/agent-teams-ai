import type { TeamLaunchParams } from '../utils/teamLaunchParams';
import type { TeamProvisioningControlStoreState } from './TeamProvisioningControlPorts';
import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamSummary,
  TeamViewSnapshot,
  ToolApprovalSettings,
} from '@shared/types';

export interface TeamProvisioningLaunchMessageEntry {
  loadingHead: boolean;
  loadingOlder: boolean;
}

export interface TeamProvisioningLaunchStoreState<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
> extends Pick<
  TeamProvisioningControlStoreState,
  | 'activeToolsByTeam'
  | 'currentProvisioningRunIdByTeam'
  | 'currentRuntimeRunIdByTeam'
  | 'finishedVisibleByTeam'
  | 'ignoredProvisioningRunIds'
  | 'ignoredRuntimeRunIds'
  | 'memberSpawnSnapshotsByTeam'
  | 'memberSpawnStatusesByTeam'
  | 'provisioningRuns'
  | 'teamAgentRuntimeByTeam'
  | 'toolHistoryByTeam'
> {
  launchParamsByTeam: Record<string, TeamLaunchParams>;
  provisioningErrorByTeam: Record<string, string | null>;
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
  selectedTeamError: string | null;
  selectedTeamLoading: boolean;
  selectedTeamName: string | null;
  teamMessagesByName: Record<string, TMessageEntry>;
  toolApprovalSettings: ToolApprovalSettings;
}

export interface TeamProvisioningLaunchStatePort<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
> {
  getState(): TeamProvisioningLaunchStoreState<TMessageEntry>;
  setState(
    update:
      | Partial<TeamProvisioningLaunchStoreState<TMessageEntry>>
      | ((
          state: TeamProvisioningLaunchStoreState<TMessageEntry>
        ) => Partial<TeamProvisioningLaunchStoreState<TMessageEntry>>)
  ): void;
}

export interface TeamProvisioningLaunchSlice {
  launchParamsByTeam: Record<string, TeamLaunchParams>;
  createTeam(request: TeamCreateRequest): Promise<string>;
  launchTeam(request: TeamLaunchRequest): Promise<string>;
}

export interface TeamProvisioningLaunchTransportPort {
  create(request: TeamCreateRequest): Promise<{ runId: string }>;
  launch(request: TeamLaunchRequest): Promise<{ runId: string }>;
}

export interface TeamProvisioningLaunchControlPort {
  clearMissingRun(runId: string): void;
  getStatus(runId: string): Promise<TeamProvisioningProgress>;
  subscribe(): void;
}

export interface TeamProvisioningLaunchScopePort<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
> {
  collectVisibleLoadingResets(
    state: TeamProvisioningLaunchStoreState<TMessageEntry>,
    teamName: string
  ): Partial<TeamProvisioningLaunchStoreState<TMessageEntry>>;
  getTeamData(teamName: string): TeamViewSnapshot | null;
  reset(teamName: string): void;
}

export interface TeamProvisioningLaunchPersistencePort {
  loadAllLaunchParams(): Record<string, TeamLaunchParams>;
  saveLaunchParams(teamName: string, params: TeamLaunchParams): void;
  saveToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void;
}

export interface TeamProvisioningLaunchClockPort {
  nowIso(): string;
  nowMs(): number;
  sleep(ms: number): Promise<void>;
}

export interface TeamProvisioningLaunchAnalyticsPort<TContext> {
  createContext(request: TeamCreateRequest, startedAtMs: number): TContext;
  launchContext(
    request: TeamLaunchRequest,
    data: TeamViewSnapshot | null,
    startedAtMs: number
  ): TContext;
  recordCreateAccepted(request: TeamCreateRequest, runId: string, context: TContext): void;
  recordIpcFailure(context: TContext, error: unknown): void;
  recordLaunchAccepted(runId: string, context: TContext): void;
}
