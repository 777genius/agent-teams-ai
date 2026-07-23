import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type {
  TeamTaskBoardDeletedTaskQueryPort,
  TeamTaskBoardMutationPort,
} from '../../core/application/ports/TeamTaskBoardInteractionPorts';

export interface TeamTaskBoardTransport {
  deletedTasks: TeamTaskBoardDeletedTaskQueryPort;
  mutations: TeamTaskBoardMutationPort;
}

export function createTeamTaskBoardTransport(): TeamTaskBoardTransport {
  return {
    deletedTasks: {
      getDeletedTasks: (teamName) =>
        unwrapIpc('team:getDeletedTasks', () => api.teams.getDeletedTasks(teamName)),
    },
    mutations: {
      addTaskRelationship: (teamName, taskId, targetId, type) =>
        unwrapIpc('team:addTaskRelationship', () =>
          api.teams.addTaskRelationship(teamName, taskId, targetId, type)
        ),
      createTask: (teamName, request) =>
        unwrapIpc('team:createTask', () => api.teams.createTask(teamName, request)),
      removeTaskRelationship: (teamName, taskId, targetId, type) =>
        unwrapIpc('team:removeTaskRelationship', () =>
          api.teams.removeTaskRelationship(teamName, taskId, targetId, type)
        ),
      requestReview: (teamName, taskId) =>
        unwrapIpc('team:requestReview', () => api.teams.requestReview(teamName, taskId)),
      restoreTask: (teamName, taskId) =>
        unwrapIpc('team:restoreTask', () => api.teams.restoreTask(teamName, taskId)),
      setTaskNeedsClarification: (teamName, taskId, value) =>
        unwrapIpc('team:setTaskClarification', () =>
          api.teams.setTaskClarification(teamName, taskId, value)
        ),
      softDeleteTask: (teamName, taskId) =>
        unwrapIpc('team:softDeleteTask', () => api.teams.softDeleteTask(teamName, taskId)),
      startTask: (teamName, taskId) =>
        unwrapIpc('team:startTask', () => api.teams.startTask(teamName, taskId)),
      startTaskByUser: (teamName, taskId) =>
        unwrapIpc('team:startTaskByUser', () => api.teams.startTaskByUser(teamName, taskId)),
      updateKanban: (teamName, taskId, patch) =>
        unwrapIpc('team:updateKanban', () => api.teams.updateKanban(teamName, taskId, patch)),
      updateKanbanColumnOrder: (teamName, columnId, orderedTaskIds) =>
        unwrapIpc('team:updateKanbanColumnOrder', () =>
          api.teams.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds)
        ),
      updateTaskFields: (teamName, taskId, fields) =>
        unwrapIpc('team:updateTaskFields', () =>
          api.teams.updateTaskFields(teamName, taskId, fields)
        ),
      updateTaskOwner: (teamName, taskId, owner) =>
        unwrapIpc('team:updateTaskOwner', () => api.teams.updateTaskOwner(teamName, taskId, owner)),
      updateTaskStatus: (teamName, taskId, status) =>
        unwrapIpc('team:updateTaskStatus', () =>
          api.teams.updateTaskStatus(teamName, taskId, status)
        ),
    },
  };
}
