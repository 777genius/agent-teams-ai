import {
  TEAM_ADD_TASK_COMMENT,
  TEAM_ADD_TASK_RELATIONSHIP,
  TEAM_CREATE_TASK,
  TEAM_GET_ALL_TASKS,
  TEAM_GET_DELETED_TASKS,
  TEAM_GET_TASK,
  TEAM_GET_TASK_CHANGE_PRESENCE,
  TEAM_REMOVE_TASK_RELATIONSHIP,
  TEAM_REQUEST_REVIEW,
  TEAM_RESTORE_TASK,
  TEAM_SET_CHANGE_PRESENCE_TRACKING,
  TEAM_SET_TASK_CLARIFICATION,
  TEAM_SOFT_DELETE_TASK,
  TEAM_START_TASK,
  TEAM_START_TASK_BY_USER,
  TEAM_UPDATE_KANBAN,
  TEAM_UPDATE_KANBAN_COLUMN_ORDER,
  TEAM_UPDATE_TASK_FIELDS,
  TEAM_UPDATE_TASK_OWNER,
  TEAM_UPDATE_TASK_STATUS,
} from '@features/team-task-board/contracts';

import { createTeamTaskBoardCommentHandlers } from './createTeamTaskBoardCommentHandlers';
import { createTeamTaskBoardMutationHandlers } from './createTeamTaskBoardMutationHandlers';
import { createTeamTaskBoardQueryHandlers } from './createTeamTaskBoardQueryHandlers';

import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcMain } from 'electron';

export function registerTeamTaskBoardIpc(
  ipcMain: IpcMain,
  dependencies: TeamTaskBoardIpcDependencies
): void {
  const mutations = createTeamTaskBoardMutationHandlers(dependencies);
  const queries = createTeamTaskBoardQueryHandlers(dependencies);
  const comments = createTeamTaskBoardCommentHandlers(dependencies);

  ipcMain.handle(TEAM_GET_TASK_CHANGE_PRESENCE, queries.getTaskChangePresence.bind(queries));
  ipcMain.handle(
    TEAM_SET_CHANGE_PRESENCE_TRACKING,
    mutations.setChangePresenceTracking.bind(mutations)
  );
  ipcMain.handle(TEAM_CREATE_TASK, mutations.createTask.bind(mutations));
  ipcMain.handle(TEAM_GET_TASK, queries.getTask.bind(queries));
  ipcMain.handle(TEAM_REQUEST_REVIEW, mutations.requestReview.bind(mutations));
  ipcMain.handle(TEAM_UPDATE_KANBAN, mutations.updateKanban.bind(mutations));
  ipcMain.handle(
    TEAM_UPDATE_KANBAN_COLUMN_ORDER,
    mutations.updateKanbanColumnOrder.bind(mutations)
  );
  ipcMain.handle(TEAM_UPDATE_TASK_STATUS, mutations.updateTaskStatus.bind(mutations));
  ipcMain.handle(TEAM_UPDATE_TASK_OWNER, mutations.updateTaskOwner.bind(mutations));
  ipcMain.handle(TEAM_UPDATE_TASK_FIELDS, mutations.updateTaskFields.bind(mutations));
  ipcMain.handle(TEAM_START_TASK, mutations.startTask.bind(mutations));
  ipcMain.handle(TEAM_START_TASK_BY_USER, mutations.startTaskByUser.bind(mutations));
  ipcMain.handle(TEAM_GET_ALL_TASKS, queries.getAllTasks.bind(queries));
  ipcMain.handle(TEAM_ADD_TASK_COMMENT, comments.addTaskComment.bind(comments));
  ipcMain.handle(TEAM_SOFT_DELETE_TASK, mutations.softDeleteTask.bind(mutations));
  ipcMain.handle(TEAM_RESTORE_TASK, mutations.restoreTask.bind(mutations));
  ipcMain.handle(TEAM_GET_DELETED_TASKS, queries.getDeletedTasks.bind(queries));
  ipcMain.handle(TEAM_SET_TASK_CLARIFICATION, mutations.setTaskClarification.bind(mutations));
  ipcMain.handle(TEAM_ADD_TASK_RELATIONSHIP, mutations.addTaskRelationship.bind(mutations));
  ipcMain.handle(TEAM_REMOVE_TASK_RELATIONSHIP, mutations.removeTaskRelationship.bind(mutations));
}

export function removeTeamTaskBoardIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_GET_TASK_CHANGE_PRESENCE);
  ipcMain.removeHandler(TEAM_SET_CHANGE_PRESENCE_TRACKING);
  ipcMain.removeHandler(TEAM_CREATE_TASK);
  ipcMain.removeHandler(TEAM_GET_TASK);
  ipcMain.removeHandler(TEAM_REQUEST_REVIEW);
  ipcMain.removeHandler(TEAM_UPDATE_KANBAN);
  ipcMain.removeHandler(TEAM_UPDATE_KANBAN_COLUMN_ORDER);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_STATUS);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_OWNER);
  ipcMain.removeHandler(TEAM_UPDATE_TASK_FIELDS);
  ipcMain.removeHandler(TEAM_START_TASK);
  ipcMain.removeHandler(TEAM_START_TASK_BY_USER);
  ipcMain.removeHandler(TEAM_GET_ALL_TASKS);
  ipcMain.removeHandler(TEAM_ADD_TASK_COMMENT);
  ipcMain.removeHandler(TEAM_SOFT_DELETE_TASK);
  ipcMain.removeHandler(TEAM_RESTORE_TASK);
  ipcMain.removeHandler(TEAM_GET_DELETED_TASKS);
  ipcMain.removeHandler(TEAM_SET_TASK_CLARIFICATION);
  ipcMain.removeHandler(TEAM_ADD_TASK_RELATIONSHIP);
  ipcMain.removeHandler(TEAM_REMOVE_TASK_RELATIONSHIP);
}
