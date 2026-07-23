import type {
  TeamTaskBoardClockPort,
  TeamTaskBoardDeletedTaskQueryPort,
  TeamTaskBoardInteractionLoggerPort,
  TeamTaskBoardInteractionStatePort,
  TeamTaskBoardMutationPort,
  TeamTaskBoardPresenceRefreshPort,
  TeamTaskBoardRefreshPort,
  TeamTaskBoardReviewErrorPort,
  TeamTaskCreationLifecyclePort,
} from './ports/TeamTaskBoardInteractionPorts';
import type {
  TaskClarificationValue,
  TaskFields,
  TaskRelationshipType,
} from './ports/TeamTaskBoardPorts';
import type {
  CreateTaskRequest,
  KanbanColumnId,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types';

export interface TeamTaskBoardActions {
  requestReview(teamName: string, taskId: string): Promise<void>;
  updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void>;
  updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void>;
  createTeamTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask>;
  startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }>;
  startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }>;
  updateTaskStatus(teamName: string, taskId: string, status: TeamTaskStatus): Promise<void>;
  updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void>;
  updateTaskFields(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
  addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void>;
  removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void>;
  setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: TaskClarificationValue
  ): Promise<void>;
  softDeleteTask(teamName: string, taskId: string): Promise<void>;
  restoreTask(teamName: string, taskId: string): Promise<void>;
  fetchDeletedTasks(teamName: string): Promise<void>;
}

export interface TeamTaskBoardActionDependencies {
  clock: TeamTaskBoardClockPort;
  deletedTasks: TeamTaskBoardDeletedTaskQueryPort;
  lifecycle: TeamTaskCreationLifecyclePort;
  logger: TeamTaskBoardInteractionLoggerPort;
  mutations: TeamTaskBoardMutationPort;
  presence: TeamTaskBoardPresenceRefreshPort;
  refresh: TeamTaskBoardRefreshPort;
  reviewErrors: TeamTaskBoardReviewErrorPort;
  state: TeamTaskBoardInteractionStatePort;
}

export function createTeamTaskBoardActions(
  dependencies: TeamTaskBoardActionDependencies
): TeamTaskBoardActions {
  const refreshTaskPresence = (teamName: string, taskId: string): void => {
    void dependencies.presence.refreshAfterTaskTransition(teamName, taskId);
  };

  const fetchDeletedTasks = async (teamName: string): Promise<void> => {
    dependencies.state.setDeletedTasksLoading(true);
    try {
      const tasks = await dependencies.deletedTasks.getDeletedTasks(teamName);
      dependencies.state.setDeletedTasks(tasks, false);
    } catch (error) {
      dependencies.logger.error('Failed to fetch deleted tasks:', error);
      dependencies.state.setDeletedTasks([], false);
    }
  };

  return {
    requestReview: async (teamName, taskId) => {
      try {
        dependencies.state.setReviewActionError(null);
        await dependencies.mutations.requestReview(teamName, taskId);
        await dependencies.refresh.refreshTeamData(teamName);
        refreshTaskPresence(teamName, taskId);
      } catch (error) {
        dependencies.state.setReviewActionError(dependencies.reviewErrors.map(error));
        throw error;
      }
    },

    updateKanban: async (teamName, taskId, patch) => {
      try {
        dependencies.state.setReviewActionError(null);
        await dependencies.mutations.updateKanban(teamName, taskId, patch);
        await dependencies.refresh.refreshTeamData(teamName);
      } catch (error) {
        dependencies.state.setReviewActionError(dependencies.reviewErrors.map(error));
        throw error;
      }
    },

    updateKanbanColumnOrder: async (teamName, columnId, orderedTaskIds) => {
      await dependencies.mutations.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    createTeamTask: async (teamName, request) => {
      const startedAtMs = dependencies.clock.now();
      const task = await dependencies.mutations.createTask(teamName, request);
      dependencies.lifecycle.recordCreatedTask(
        teamName,
        task,
        request,
        dependencies.state.getTeamData(teamName),
        startedAtMs
      );
      await dependencies.refresh.refreshTeamData(teamName);
      return task;
    },

    startTask: async (teamName, taskId) => {
      const result = await dependencies.mutations.startTask(teamName, taskId);
      await dependencies.refresh.refreshTeamData(teamName);
      refreshTaskPresence(teamName, taskId);
      return result;
    },

    startTaskByUser: async (teamName, taskId) => {
      const result = await dependencies.mutations.startTaskByUser(teamName, taskId);
      await dependencies.refresh.refreshTeamData(teamName);
      refreshTaskPresence(teamName, taskId);
      return result;
    },

    updateTaskStatus: async (teamName, taskId, status) => {
      await dependencies.mutations.updateTaskStatus(teamName, taskId, status);
      await dependencies.refresh.refreshTeamData(teamName);
      refreshTaskPresence(teamName, taskId);
    },

    updateTaskOwner: async (teamName, taskId, owner) => {
      await dependencies.mutations.updateTaskOwner(teamName, taskId, owner);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    updateTaskFields: async (teamName, taskId, fields) => {
      await dependencies.mutations.updateTaskFields(teamName, taskId, fields);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    addTaskRelationship: async (teamName, taskId, targetId, type) => {
      await dependencies.mutations.addTaskRelationship(teamName, taskId, targetId, type);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    removeTaskRelationship: async (teamName, taskId, targetId, type) => {
      await dependencies.mutations.removeTaskRelationship(teamName, taskId, targetId, type);
      await dependencies.refresh.refreshTeamData(teamName);
    },

    setTaskNeedsClarification: async (teamName, taskId, value) => {
      await dependencies.mutations.setTaskNeedsClarification(teamName, taskId, value);
      await dependencies.refresh.refreshTeamData(teamName);
      await dependencies.refresh.refreshAllTasks();
    },

    softDeleteTask: async (teamName, taskId) => {
      await dependencies.mutations.softDeleteTask(teamName, taskId);
      await dependencies.refresh.refreshTeamData(teamName);
      await fetchDeletedTasks(teamName);
    },

    restoreTask: async (teamName, taskId) => {
      await dependencies.mutations.restoreTask(teamName, taskId);
      await dependencies.refresh.refreshTeamData(teamName);
      await fetchDeletedTasks(teamName);
    },

    fetchDeletedTasks,
  };
}
