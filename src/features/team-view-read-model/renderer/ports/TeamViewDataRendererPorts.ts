import type { RefreshTeamMessagesHeadResult } from './TeamMessageFeedRendererPorts';
import type {
  AppConfig,
  GlobalTask,
  TeamGetDataOptions,
  TeamSummary,
  TeamViewSnapshot,
  ToolApprovalSettings,
} from '@shared/types';

export interface RefreshTeamDataOptions {
  withDedup?: boolean;
}

export interface SelectTeamOptions {
  skipProjectAutoSelect?: boolean;
  allowReloadWhileProvisioning?: boolean;
}

export interface TeamViewDataRendererSliceState {
  selectedTeamData: TeamViewSnapshot | null;
  selectedTeamError: string | null;
  selectedTeamLoading: boolean;
  selectedTeamLoadNonce: number;
  selectedTeamName: string | null;
  teamDataCacheByName: Record<string, TeamViewSnapshot>;
}

export interface TeamViewDataRendererState extends TeamViewDataRendererSliceState {
  appConfig: AppConfig | null;
  globalTasks: GlobalTask[];
  globalTasksInitialized: boolean;
  reviewActionError: string | null;
  teamByName: Record<string, TeamSummary>;
  toolApprovalSettings: ToolApprovalSettings;
}

export interface TeamViewDataRendererSliceActions {
  refreshTeamData(teamName: string, options?: RefreshTeamDataOptions): Promise<void>;
  selectTeam(teamName: string, options?: SelectTeamOptions): Promise<void>;
}

export type TeamViewDataRendererSlice = TeamViewDataRendererSliceState &
  TeamViewDataRendererSliceActions;

export interface TeamViewDataStatePort {
  getState(): TeamViewDataRendererState;
  setState(
    update:
      | Partial<TeamViewDataRendererState>
      | ((state: TeamViewDataRendererState) => Partial<TeamViewDataRendererState>)
  ): void;
}

export interface TeamViewDataTransportPort {
  getData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot>;
  invalidateTaskChangeSummaries(teamName: string, taskIds: string[]): Promise<void>;
}

export interface TeamViewDataRequestScopePort<TScope> {
  capture(teamName: string): TScope;
  isCurrent(teamName: string, scope: TScope): boolean;
}

export interface TeamViewDataActionsPort {
  getActions(): TeamViewDataRendererSliceActions & {
    invalidateTaskChangePresence(cacheKeys: string[]): void;
    refreshMemberActivityMeta(teamName: string): Promise<void>;
    refreshTeamMessagesHead(teamName: string): Promise<RefreshTeamMessagesHeadResult>;
  };
}

export interface TeamViewDataSnapshotPolicyPort {
  getForTeam(state: TeamViewDataRendererState, teamName: string): TeamViewSnapshot | null;
  preserveKnownTaskChangePresence(
    teamName: string,
    previousTasks: TeamViewSnapshot['tasks'] | null | undefined,
    nextTasks: TeamViewSnapshot['tasks']
  ): TeamViewSnapshot['tasks'];
  shouldPreserveSelectedSnapshot(
    current: TeamViewSnapshot | null,
    baseline: TeamViewSnapshot | null,
    incoming: TeamViewSnapshot,
    summary: TeamSummary | undefined
  ): boolean;
  structurallyShare(
    previous: TeamViewSnapshot | null | undefined,
    incoming: TeamViewSnapshot
  ): TeamViewSnapshot;
}

export interface TeamViewDataTaskInvalidation {
  cacheKeys: string[];
  taskIds: string[];
}

export interface TeamViewDataTaskPolicyPort {
  collectInvalidation(
    teamName: string,
    previousTasks: TeamViewSnapshot['tasks'],
    nextTasks: TeamViewSnapshot['tasks']
  ): TeamViewDataTaskInvalidation;
}

export interface TeamViewDataGlobalTaskProjectionPort<TNotification> {
  buildNotification(
    state: TeamViewDataRendererState,
    nextGlobalTasks: GlobalTask[]
  ): TNotification | null;
  notify(notification: TNotification): void;
  project(current: GlobalTask[], teamName: string, snapshot: TeamViewSnapshot): GlobalTask[];
}

export interface TeamViewDataSelectionEffectsPort {
  autoSelectProject(projectPath: string): void;
  loadToolApprovalSettings(teamName: string): ToolApprovalSettings;
  syncTabLabels(teamName: string, displayName: string): void;
}

export interface TeamViewDataLifecyclePort {
  isProvisioningActive(teamName: string): boolean;
  isMemberActivityMetaStale(teamName: string): boolean;
  recordLastResolvedRefresh(teamName: string): void;
  recordTaskBoardTransitions(
    teamName: string,
    previous: TeamViewSnapshot | null,
    next: TeamViewSnapshot
  ): void;
  shouldInvalidateCachedData(teamName: string, message: string): boolean;
}

export interface TeamViewDataDiagnosticsPort {
  debug(message: string): void;
  noteRefreshBurst(teamName: string): void;
  warn(message: string): void;
}
