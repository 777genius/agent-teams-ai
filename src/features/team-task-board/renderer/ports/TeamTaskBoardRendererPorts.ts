import type { TeamTaskBoardActions } from '../../core/application/createTeamTaskBoardActions';
import type {
  TeamTaskBoardDeletedTaskQueryPort,
  TeamTaskBoardMutationPort,
} from '../../core/application/ports/TeamTaskBoardInteractionPorts';
import type { TaskChangeRequestOptions, TeamTask, TeamViewSnapshot } from '@shared/types';

export interface TeamTaskBoardTransport {
  deletedTasks: TeamTaskBoardDeletedTaskQueryPort;
  mutations: TeamTaskBoardMutationPort;
}

export interface TeamTaskBoardRendererSlice extends TeamTaskBoardActions {
  reviewActionError: string | null;
  deletedTasks: TeamTask[];
  deletedTasksLoading: boolean;
}

export interface TeamTaskBoardRendererStoreContext {
  checkTaskHasChanges?: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<unknown>;
  fetchAllTasks(): Promise<void>;
  getTeamData(teamName: string): TeamViewSnapshot | null;
  invalidateTaskChangePresence?: (cacheKeys: string[]) => void;
  refreshTeamData(teamName: string): Promise<void>;
  selectedTeamData: TeamViewSnapshot | null;
  selectedTeamName: string | null;
}

export interface TeamTaskBoardRendererSliceDependencies {
  getState(): TeamTaskBoardRendererStoreContext;
  mapReviewError(error: unknown): string;
  setState(state: Partial<TeamTaskBoardRendererSlice>): void;
  transport: TeamTaskBoardTransport;
}
