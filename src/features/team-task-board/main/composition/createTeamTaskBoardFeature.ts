import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '@main/services/team/LaunchIoGovernor';
import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';
import { createLogger } from '@shared/utils/logger';

import { AddTaskCommentUseCase } from '../../core/application/use-cases/AddTaskCommentUseCase';
import { TaskAttachmentUseCases } from '../../core/application/use-cases/TaskAttachmentUseCases';
import { UpdateTaskFieldsUseCase } from '../../core/application/use-cases/UpdateTaskFieldsUseCase';
import { TeamTaskCommentAttachmentWriter } from '../adapters/output/TeamTaskCommentAttachmentWriter';

import type {
  TaskAttachmentMetadataPort,
  TaskAttachmentStoragePort,
  TaskChangePresencePort,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TaskFieldsWriterPort,
  TeamLeadNotificationPort,
  TeamRuntimeStatusPort,
  TeamTaskBoardCommandPort,
  TeamTaskBoardLoggerPort,
  TeamTaskBoardQueryPort,
} from '../../core/application/ports/TeamTaskBoardPorts';
import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcBoundary';
import type { GlobalTask } from '@shared/types';

export interface TeamTaskBoardCompatibilityApi
  extends
    TeamTaskBoardQueryPort,
    TeamTaskBoardCommandPort,
    TaskChangePresencePort,
    TaskCommentWriterPort,
    TaskAttachmentMetadataPort,
    TaskFieldsWriterPort {
  getAllTasks: TeamTaskBoardIpcDependencies['globalTasks']['getAllTasks'];
}

export type TeamTaskBoardFeature = TeamTaskBoardIpcDependencies;

function createTaskAttachmentStorageAdapter(
  store: TeamTaskAttachmentStore = new TeamTaskAttachmentStore()
): TaskAttachmentStoragePort {
  return {
    runTransaction: (teamName, taskId, operation) =>
      store.runTaskTransaction(teamName, taskId, (transaction) =>
        operation({
          saveAttachment: async (attachmentId, filename, mimeType, base64Data) => {
            const receipt = await transaction.saveAttachmentWithReceipt(
              attachmentId,
              filename,
              mimeType,
              base64Data
            );
            return {
              metadata: receipt.metadata,
              finalize: () => transaction.finalizeAttachment(receipt),
              rollback: () => transaction.rollbackAttachment(receipt),
            };
          },
          prepareAttachmentDeletion: async (attachmentId, mimeType) => {
            const receipt = await transaction.prepareAttachmentDeletion(attachmentId, mimeType);
            return receipt
              ? {
                  finalize: () => transaction.finalizeAttachmentDeletion(receipt),
                  rollback: () => transaction.rollbackAttachmentDeletion(receipt),
                }
              : null;
          },
          markCommitted: () => transaction.markCommitted(),
        })
      ),
    getAttachment: (teamName, taskId, attachmentId, mimeType) =>
      store.getAttachment(teamName, taskId, attachmentId, mimeType),
  };
}

export function createTeamTaskBoardFeature(dependencies: {
  taskBoardApi: TeamTaskBoardCompatibilityApi;
  runtimeApi: TeamRuntimeStatusPort;
  notificationApi: TeamLeadNotificationPort;
  launchIoGovernor?: LaunchIoGovernor;
  commentAttachments?: TaskCommentAttachmentWriterPort;
  taskAttachmentStorage?: TaskAttachmentStoragePort;
  taskAttachmentLogger?: TeamTaskBoardLoggerPort;
  withWriterAdmission?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
  withWriterWorkflow?: <T>(teamName: string, operation: () => Promise<T>) => Promise<T>;
  logger: TeamTaskBoardLoggerPort;
}): TeamTaskBoardFeature {
  const admitted = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterAdmission?.(teamName, operation) ?? operation();
  const workflow = <T>(teamName: string, operation: () => Promise<T>): Promise<T> =>
    dependencies.withWriterWorkflow?.(teamName, operation) ?? operation();
  const api = dependencies.taskBoardApi;
  const commands: TeamTaskBoardCommandPort = {
    createTask: (teamName, request) => admitted(teamName, () => api.createTask(teamName, request)),
    requestReview: (teamName, taskId) =>
      admitted(teamName, () => api.requestReview(teamName, taskId)),
    updateKanban: (teamName, taskId, patch) =>
      admitted(teamName, () => api.updateKanban(teamName, taskId, patch)),
    updateKanbanColumnOrder: (teamName, columnId, ids) =>
      admitted(teamName, () => api.updateKanbanColumnOrder(teamName, columnId, ids)),
    updateTaskStatus: (teamName, taskId, status) =>
      admitted(teamName, () => api.updateTaskStatus(teamName, taskId, status)),
    updateTaskOwner: (teamName, taskId, owner) =>
      admitted(teamName, () => api.updateTaskOwner(teamName, taskId, owner)),
    startTask: (teamName, taskId) => admitted(teamName, () => api.startTask(teamName, taskId)),
    startTaskByUser: (teamName, taskId) =>
      admitted(teamName, () => api.startTaskByUser(teamName, taskId)),
    softDeleteTask: (teamName, taskId) =>
      admitted(teamName, () => api.softDeleteTask(teamName, taskId)),
    restoreTask: (teamName, taskId) => admitted(teamName, () => api.restoreTask(teamName, taskId)),
    setTaskNeedsClarification: (teamName, taskId, value) =>
      admitted(teamName, () => api.setTaskNeedsClarification(teamName, taskId, value)),
    addTaskRelationship: (teamName, taskId, targetId, type) =>
      admitted(teamName, () => api.addTaskRelationship(teamName, taskId, targetId, type)),
    removeTaskRelationship: (teamName, taskId, targetId, type) =>
      admitted(teamName, () => api.removeTaskRelationship(teamName, taskId, targetId, type)),
  };
  const updateTaskFields = new UpdateTaskFieldsUseCase({
    fields: {
      updateTaskFields: (teamName, taskId, fields) =>
        admitted(teamName, () => api.updateTaskFields(teamName, taskId, fields)),
    },
    runtime: dependencies.runtimeApi,
    notifications: dependencies.notificationApi,
    logger: dependencies.logger,
  });
  const commentAttachments =
    dependencies.commentAttachments ?? new TeamTaskCommentAttachmentWriter();
  const addTaskComment = new AddTaskCommentUseCase({
    comments: api,
    attachments: commentAttachments,
    logger: dependencies.logger,
  });
  const taskAttachmentLogger = dependencies.taskAttachmentLogger ?? createLogger('IPC:teams');
  const taskAttachments = new TaskAttachmentUseCases({
    metadata: api,
    storage: dependencies.taskAttachmentStorage ?? createTaskAttachmentStorageAdapter(),
    logger: taskAttachmentLogger,
  });

  return {
    queries: dependencies.taskBoardApi,
    commands,
    changePresence: {
      getTaskChangePresence: (teamName) => api.getTaskChangePresence(teamName),
      setTaskChangePresenceTracking: (teamName, enabled) =>
        admitted(teamName, async () => api.setTaskChangePresenceTracking(teamName, enabled)),
    },
    addTaskComment: {
      execute: (teamName, taskId, input) =>
        admitted(teamName, () => addTaskComment.execute(teamName, taskId, input)),
    },
    globalTasks: {
      getAllTasks: (): Promise<GlobalTask[]> => {
        const loadFresh = (): Promise<GlobalTask[]> => dependencies.taskBoardApi.getAllTasks();
        return dependencies.launchIoGovernor
          ? dependencies.launchIoGovernor.runSummaryOperation('teams:getAllTasks', loadFresh, {
              clone: cloneLaunchIoGovernorPayload,
            })
          : loadFresh();
      },
    },
    updateTaskFields: {
      execute: (teamName, taskId, fields) =>
        workflow(teamName, () => updateTaskFields.execute(teamName, taskId, fields)),
    },
    taskAttachments: {
      save: (teamName, taskId, attachmentId, filename, mimeType, data) =>
        admitted(teamName, () =>
          taskAttachments.save(teamName, taskId, attachmentId, filename, mimeType, data)
        ),
      get: (teamName, taskId, attachmentId, mimeType) =>
        taskAttachments.get(teamName, taskId, attachmentId, mimeType),
      delete: (teamName, taskId, attachmentId, mimeType) =>
        admitted(teamName, () => taskAttachments.delete(teamName, taskId, attachmentId, mimeType)),
    },
    taskAttachmentLogger,
    operationTracker: {
      setCurrent: setCurrentMainOp,
    },
    clock: {
      now: Date.now,
    },
    logger: dependencies.logger,
  };
}
