import {
  getTeamDataRequestLabel,
  type TeamDirectoryTransportPort,
  type TeamMessageFeedTransportPort,
  type TeamViewDataTransportPort,
} from '@features/team-view-read-model/renderer';
import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type {
  TeamTaskArtifactsTransport,
  TeamTaskBoardTransport,
} from '@features/team-task-board/renderer';

const TEAM_FETCH_TIMEOUT_MS = 30_000;
const TEAM_GET_DATA_TIMEOUT_MS = 30_000;

type TeamCollaborationDataApi = Pick<typeof api, 'review' | 'teams'>;

export interface TeamCollaborationDataTransports {
  directory: TeamDirectoryTransportPort;
  messageFeed: TeamMessageFeedTransportPort;
  taskArtifacts: TeamTaskArtifactsTransport;
  taskBoard: TeamTaskBoardTransport;
  viewData: TeamViewDataTransportPort;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function createTeamCollaborationDataTransports(
  appApi: TeamCollaborationDataApi = api
): TeamCollaborationDataTransports {
  const getReview = () => appApi.review;
  const getTeams = () => appApi.teams;

  return {
    directory: {
      getAllTasks: () =>
        withTimeout(
          unwrapIpc('team:getAllTasks', () => getTeams().getAllTasks()),
          TEAM_FETCH_TIMEOUT_MS,
          'fetchAllTasks'
        ),
      getProjectBranch: (path) => getTeams().getProjectBranch(path),
      listTeams: () =>
        withTimeout(
          unwrapIpc('team:list', () => getTeams().list()),
          TEAM_FETCH_TIMEOUT_MS,
          'fetchTeams'
        ),
    },
    messageFeed: {
      getMemberActivityMeta: (teamName) =>
        unwrapIpc('team:getMemberActivityMeta', () => getTeams().getMemberActivityMeta(teamName)),
      getMessagesPage: (teamName, options) =>
        unwrapIpc('team:getMessagesPage', () => getTeams().getMessagesPage(teamName, options)),
    },
    taskArtifacts: {
      addTaskComment: (teamName, taskId, request) =>
        unwrapIpc('team:addTaskComment', () =>
          getTeams().addTaskComment(teamName, taskId, request)
        ),
      deleteTaskAttachment: (teamName, taskId, attachmentId, mimeType) =>
        unwrapIpc('team:deleteTaskAttachment', () =>
          getTeams().deleteTaskAttachment(teamName, taskId, attachmentId, mimeType)
        ),
      getTaskAttachmentData: (teamName, taskId, attachmentId, mimeType) =>
        unwrapIpc('team:getTaskAttachment', () =>
          getTeams().getTaskAttachment(teamName, taskId, attachmentId, mimeType)
        ),
      getTaskChangePresence: (teamName) =>
        unwrapIpc('team:getTaskChangePresence', () => getTeams().getTaskChangePresence(teamName)),
      saveTaskAttachment: (teamName, taskId, attachmentId, filename, mimeType, base64) =>
        unwrapIpc('team:saveTaskAttachment', () =>
          getTeams().saveTaskAttachment(teamName, taskId, attachmentId, filename, mimeType, base64)
        ),
    },
    taskBoard: {
      deletedTasks: {
        getDeletedTasks: (teamName) =>
          unwrapIpc('team:getDeletedTasks', () => getTeams().getDeletedTasks(teamName)),
      },
      mutations: {
        addTaskRelationship: (teamName, taskId, targetId, type) =>
          unwrapIpc('team:addTaskRelationship', () =>
            getTeams().addTaskRelationship(teamName, taskId, targetId, type)
          ),
        createTask: (teamName, request) =>
          unwrapIpc('team:createTask', () => getTeams().createTask(teamName, request)),
        removeTaskRelationship: (teamName, taskId, targetId, type) =>
          unwrapIpc('team:removeTaskRelationship', () =>
            getTeams().removeTaskRelationship(teamName, taskId, targetId, type)
          ),
        requestReview: (teamName, taskId) =>
          unwrapIpc('team:requestReview', () => getTeams().requestReview(teamName, taskId)),
        restoreTask: (teamName, taskId) =>
          unwrapIpc('team:restoreTask', () => getTeams().restoreTask(teamName, taskId)),
        setTaskNeedsClarification: (teamName, taskId, value) =>
          unwrapIpc('team:setTaskClarification', () =>
            getTeams().setTaskClarification(teamName, taskId, value)
          ),
        softDeleteTask: (teamName, taskId) =>
          unwrapIpc('team:softDeleteTask', () => getTeams().softDeleteTask(teamName, taskId)),
        startTask: (teamName, taskId) =>
          unwrapIpc('team:startTask', () => getTeams().startTask(teamName, taskId)),
        startTaskByUser: (teamName, taskId) =>
          unwrapIpc('team:startTaskByUser', () => getTeams().startTaskByUser(teamName, taskId)),
        updateKanban: (teamName, taskId, patch) =>
          unwrapIpc('team:updateKanban', () => getTeams().updateKanban(teamName, taskId, patch)),
        updateKanbanColumnOrder: (teamName, columnId, orderedTaskIds) =>
          unwrapIpc('team:updateKanbanColumnOrder', () =>
            getTeams().updateKanbanColumnOrder(teamName, columnId, orderedTaskIds)
          ),
        updateTaskFields: (teamName, taskId, fields) =>
          unwrapIpc('team:updateTaskFields', () =>
            getTeams().updateTaskFields(teamName, taskId, fields)
          ),
        updateTaskOwner: (teamName, taskId, owner) =>
          unwrapIpc('team:updateTaskOwner', () =>
            getTeams().updateTaskOwner(teamName, taskId, owner)
          ),
        updateTaskStatus: (teamName, taskId, status) =>
          unwrapIpc('team:updateTaskStatus', () =>
            getTeams().updateTaskStatus(teamName, taskId, status)
          ),
      },
    },
    viewData: {
      getData: (teamName, options) =>
        withTimeout(
          unwrapIpc('team:getData', () =>
            options === undefined
              ? getTeams().getData(teamName)
              : getTeams().getData(teamName, options)
          ),
          TEAM_GET_DATA_TIMEOUT_MS,
          getTeamDataRequestLabel(teamName, options)
        ),
      invalidateTaskChangeSummaries: (teamName, taskIds) =>
        getReview().invalidateTaskChangeSummaries(teamName, taskIds),
    },
  };
}
