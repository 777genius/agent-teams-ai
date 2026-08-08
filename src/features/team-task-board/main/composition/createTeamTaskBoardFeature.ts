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
  logger: TeamTaskBoardLoggerPort;
}): TeamTaskBoardFeature {
  const updateTaskFields = new UpdateTaskFieldsUseCase({
    fields: dependencies.taskBoardApi,
    runtime: dependencies.runtimeApi,
    notifications: dependencies.notificationApi,
    logger: dependencies.logger,
  });
  const commentAttachments =
    dependencies.commentAttachments ?? new TeamTaskCommentAttachmentWriter();
  const addTaskComment = new AddTaskCommentUseCase({
    comments: dependencies.taskBoardApi,
    attachments: commentAttachments,
    logger: dependencies.logger,
  });
  const taskAttachmentLogger = dependencies.taskAttachmentLogger ?? createLogger('IPC:teams');
  const taskAttachments = new TaskAttachmentUseCases({
    metadata: dependencies.taskBoardApi,
    storage: dependencies.taskAttachmentStorage ?? createTaskAttachmentStorageAdapter(),
    logger: taskAttachmentLogger,
  });

  return {
    queries: dependencies.taskBoardApi,
    commands: dependencies.taskBoardApi,
    changePresence: dependencies.taskBoardApi,
    addTaskComment,
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
    updateTaskFields,
    taskAttachments,
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
