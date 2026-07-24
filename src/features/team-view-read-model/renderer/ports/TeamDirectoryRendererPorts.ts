import type { AppConfig, GlobalTask, TeamSummary } from '@shared/types';

export interface TeamDirectoryRendererSliceState {
  branchByPath: Record<string, string | null>;
  globalTasks: GlobalTask[];
  globalTasksError: string | null;
  globalTasksInitialized: boolean;
  globalTasksLoading: boolean;
  teamByName: Record<string, TeamSummary>;
  teamBySessionId: Record<string, TeamSummary>;
  teams: TeamSummary[];
  teamsError: string | null;
  teamsLoading: boolean;
}

export interface TeamDirectoryRendererState extends TeamDirectoryRendererSliceState {
  appConfig: AppConfig | null;
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
}

export interface TeamDirectoryRendererSliceActions {
  fetchAllTasks(): Promise<void>;
  fetchBranches(paths: string[]): Promise<void>;
  fetchTeams(): Promise<void>;
}

export type TeamDirectoryRendererSlice = TeamDirectoryRendererSliceState &
  TeamDirectoryRendererSliceActions;

export interface TeamDirectoryTransportPort {
  getAllTasks(): Promise<GlobalTask[]>;
  getProjectBranch(path: string): Promise<string | null>;
  listTeams(): Promise<TeamSummary[]>;
}

export interface TeamDirectoryStatePort<StoreState extends TeamDirectoryRendererState> {
  getState(): StoreState;
  setState(
    update:
      | Partial<TeamDirectoryRendererState>
      | ((state: StoreState) => Partial<TeamDirectoryRendererState>)
  ): void;
}

export interface TeamDirectoryRequestScopePort<RequestScope> {
  capture(): RequestScope;
  isCurrent(scope: RequestScope): boolean;
}

export interface TeamDirectoryRefreshCoordinatorPort<RequestScope> {
  beginTeamsFetch(): number;
  isLatestTeamsFetch(requestId: number): boolean;
  getGlobalTasksRefresh(): {
    request: Promise<void>;
    scope: RequestScope | null;
  } | null;
  beginGlobalTasksRefresh(request: Promise<void>): void;
  setGlobalTasksRefreshScope(scope: RequestScope): void;
  clearGlobalTasksRefresh(request: Promise<void>): void;
  queueFreshGlobalTasksRefresh(): void;
  consumeFreshGlobalTasksRefresh(): boolean;
  hasPendingFreshGlobalTasksRefresh(): boolean;
}

export interface TeamDirectoryNotificationPort {
  consumeInitialFetch(): boolean;
  process(input: {
    oldTasks: GlobalTask[];
    newTasks: GlobalTask[];
    appConfig: AppConfig | null;
    teamByName: Record<string, TeamSummary>;
    isInitialFetch: boolean;
  }): void;
}

export interface TeamDirectoryStructuralSharingPort {
  share<T>(previous: T, next: T): T;
}

export interface TeamDirectoryPathPort {
  normalize(path: string): string;
}

export interface TeamDirectorySchedulerPort {
  delay(ms: number): Promise<void>;
}
