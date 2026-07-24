import { setCurrentMainOp } from '@main/services/infrastructure/EventLoopLagMonitor';
import {
  cloneLaunchIoGovernorPayload,
  type LaunchIoGovernor,
} from '@main/services/team/LaunchIoGovernor';

import { UpdateTaskFieldsUseCase } from '../../core/application/use-cases/UpdateTaskFieldsUseCase';
import { TeamTaskCommentAttachmentWriter } from '../adapters/output/TeamTaskCommentAttachmentWriter';

import type {
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
import type { TeamTaskBoardIpcDependencies } from '../adapters/input/ipc/TeamTaskBoardIpcDependencies';
import type { GlobalTask } from '@shared/types';

export interface TeamTaskBoardCompatibilityApi
  extends
    TeamTaskBoardQueryPort,
    TeamTaskBoardCommandPort,
    TaskChangePresencePort,
    TaskCommentWriterPort,
    TaskFieldsWriterPort {
  getAllTasks: TeamTaskBoardIpcDependencies['globalTasks']['getAllTasks'];
}

export type TeamTaskBoardFeature = TeamTaskBoardIpcDependencies;

export function createTeamTaskBoardFeature(dependencies: {
  taskBoardApi: TeamTaskBoardCompatibilityApi;
  runtimeApi: TeamRuntimeStatusPort;
  notificationApi: TeamLeadNotificationPort;
  launchIoGovernor?: LaunchIoGovernor;
  commentAttachments?: TaskCommentAttachmentWriterPort;
  logger: TeamTaskBoardLoggerPort;
}): TeamTaskBoardFeature {
  const updateTaskFields = new UpdateTaskFieldsUseCase({
    fields: dependencies.taskBoardApi,
    runtime: dependencies.runtimeApi,
    notifications: dependencies.notificationApi,
    logger: dependencies.logger,
  });

  return {
    queries: dependencies.taskBoardApi,
    commands: dependencies.taskBoardApi,
    changePresence: dependencies.taskBoardApi,
    comments: dependencies.taskBoardApi,
    commentAttachments: dependencies.commentAttachments ?? new TeamTaskCommentAttachmentWriter(),
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
    operationTracker: {
      setCurrent: setCurrentMainOp,
    },
    clock: {
      now: Date.now,
    },
    logger: dependencies.logger,
  };
}
