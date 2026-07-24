import { validateMemberName, validateTaskId, validateTeamName } from '@main/ipc/guards';
import { validateTaskRefs } from '@main/ipc/validation/taskRefs';
import { looksLikeCanonicalTaskId } from '@shared/utils/taskIdentity';

import { executeTeamTaskBoardHandler } from './executeTeamTaskBoardHandler';
import { isUpdateKanbanPatch, validateKanbanColumnId } from './teamTaskBoardValidation';

import type {
  TaskClarificationValue,
  TaskRelationshipType,
} from '../../../../core/application/ports/TeamTaskBoardPorts';
import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { CreateTaskRequest, IpcResult, TeamTask, TeamTaskStatus } from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

const VALID_TASK_STATUSES: TeamTaskStatus[] = ['pending', 'in_progress', 'completed'];
const VALID_CLARIFICATION_VALUES = ['lead', 'user'] as const;
const VALID_RELATIONSHIP_TYPES: TaskRelationshipType[] = ['blockedBy', 'blocks', 'related'];

function validateRelationship(
  teamName: unknown,
  taskId: unknown,
  targetId: unknown,
  type: unknown
):
  | { error: string }
  | {
      value: {
        teamName: string;
        taskId: string;
        targetId: string;
        type: TaskRelationshipType;
      };
    } {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return { error: validatedTaskId.error ?? 'Invalid taskId' };
  }
  const validatedTargetId = validateTaskId(targetId);
  if (!validatedTargetId.valid) {
    return { error: validatedTargetId.error ?? 'Invalid targetId' };
  }
  if (
    typeof type !== 'string' ||
    !VALID_RELATIONSHIP_TYPES.includes(type as TaskRelationshipType)
  ) {
    return { error: `type must be one of: ${VALID_RELATIONSHIP_TYPES.join(', ')}` };
  }
  return {
    value: {
      teamName: validatedTeamName.value!,
      taskId: validatedTaskId.value!,
      targetId: validatedTargetId.value!,
      type: type as TaskRelationshipType,
    },
  };
}

export function createTeamTaskBoardMutationHandlers(dependencies: TeamTaskBoardIpcDependencies): {
  createTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    request: unknown
  ): Promise<IpcResult<TeamTask>>;
  requestReview(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<void>>;
  updateKanban(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    patch: unknown
  ): Promise<IpcResult<void>>;
  updateKanbanColumnOrder(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    columnId: unknown,
    orderedTaskIds: unknown
  ): Promise<IpcResult<void>>;
  updateTaskStatus(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    status: unknown
  ): Promise<IpcResult<void>>;
  updateTaskOwner(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    owner: unknown
  ): Promise<IpcResult<void>>;
  updateTaskFields(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    fields: unknown
  ): Promise<IpcResult<void>>;
  startTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<{ notifiedOwner: boolean }>>;
  startTaskByUser(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<{ notifiedOwner: boolean }>>;
  setChangePresenceTracking(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    enabled: unknown
  ): Promise<IpcResult<void>>;
  softDeleteTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<void>>;
  restoreTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<void>>;
  setTaskClarification(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    value: unknown
  ): Promise<IpcResult<void>>;
  addTaskRelationship(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    targetId: unknown,
    type: unknown
  ): Promise<IpcResult<void>>;
  removeTaskRelationship(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    targetId: unknown,
    type: unknown
  ): Promise<IpcResult<void>>;
} {
  return {
    async createTask(_event, teamName, request) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }

      if (!request || typeof request !== 'object') {
        return { success: false, error: 'Invalid create task request' };
      }

      const payload = request as Partial<CreateTaskRequest>;
      let command: CreateTaskRequest['command'];
      if (payload.command !== undefined) {
        if (!payload.command || typeof payload.command !== 'object') {
          return { success: false, error: 'command must be an object' };
        }
        const commandId = payload.command.commandId;
        const idempotencyKey = payload.command.idempotencyKey;
        if (typeof commandId !== 'string' || !looksLikeCanonicalTaskId(commandId)) {
          return { success: false, error: 'command.commandId must be a UUID' };
        }
        if (
          typeof idempotencyKey !== 'string' ||
          idempotencyKey.trim().length === 0 ||
          idempotencyKey.trim().length > 200
        ) {
          return {
            success: false,
            error: 'command.idempotencyKey must be a non-empty string up to 200 characters',
          };
        }
        command = {
          commandId: commandId.trim(),
          idempotencyKey: idempotencyKey.trim(),
        };
      }
      if (typeof payload.subject !== 'string' || payload.subject.trim().length === 0) {
        return { success: false, error: 'subject must be a non-empty string' };
      }
      if (payload.subject.trim().length > 500) {
        return { success: false, error: 'subject exceeds max length (500)' };
      }
      if (payload.description !== undefined && typeof payload.description !== 'string') {
        return { success: false, error: 'description must be string' };
      }
      const validatedDescriptionTaskRefs = validateTaskRefs(payload.descriptionTaskRefs);
      if (!validatedDescriptionTaskRefs.valid) {
        return { success: false, error: validatedDescriptionTaskRefs.error };
      }
      if (payload.owner !== undefined) {
        const validatedOwner = validateMemberName(payload.owner);
        if (!validatedOwner.valid) {
          return { success: false, error: validatedOwner.error ?? 'Invalid owner' };
        }
      }
      if (payload.blockedBy !== undefined) {
        if (
          !Array.isArray(payload.blockedBy) ||
          payload.blockedBy.some((id) => typeof id !== 'string')
        ) {
          return { success: false, error: 'blockedBy must be an array of task ID strings' };
        }
      }
      if (payload.related !== undefined) {
        if (
          !Array.isArray(payload.related) ||
          payload.related.some((id) => typeof id !== 'string')
        ) {
          return { success: false, error: 'related must be an array of task ID strings' };
        }
        for (const id of payload.related) {
          const validated = validateTaskId(id);
          if (!validated.valid) {
            return { success: false, error: validated.error ?? 'Invalid related task id' };
          }
        }
      }
      if (payload.prompt !== undefined) {
        if (typeof payload.prompt !== 'string') {
          return { success: false, error: 'prompt must be a string' };
        }
        if (payload.prompt.length > 5000) {
          return { success: false, error: 'prompt exceeds max length (5000)' };
        }
      }
      const validatedPromptTaskRefs = validateTaskRefs(payload.promptTaskRefs);
      if (!validatedPromptTaskRefs.valid) {
        return { success: false, error: validatedPromptTaskRefs.error };
      }
      if (payload.startImmediately !== undefined && typeof payload.startImmediately !== 'boolean') {
        return { success: false, error: 'startImmediately must be a boolean' };
      }

      return executeTeamTaskBoardHandler(dependencies.logger, 'createTask', () =>
        dependencies.commands.createTask(validatedTeamName.value!, {
          ...(command ? { command } : {}),
          subject: payload.subject!.trim(),
          description: payload.description?.trim(),
          owner: payload.owner?.trim() || undefined,
          blockedBy: payload.blockedBy,
          related: payload.related,
          descriptionTaskRefs: validatedDescriptionTaskRefs.value,
          prompt: payload.prompt?.trim() || undefined,
          promptTaskRefs: validatedPromptTaskRefs.value,
          startImmediately: payload.startImmediately,
        })
      );
    },

    async requestReview(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'requestReview', () =>
        dependencies.commands.requestReview(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async updateKanban(_event, teamName, taskId, patch) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (!isUpdateKanbanPatch(patch)) {
        return { success: false, error: 'Invalid kanban patch' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'updateKanban', async () => {
        await dependencies.commands.updateKanban(
          validatedTeamName.value!,
          validatedTaskId.value!,
          patch
        );
      });
    },

    async updateKanbanColumnOrder(_event, teamName, columnId, orderedTaskIds) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedColumnId = validateKanbanColumnId(columnId);
      if (!validatedColumnId.valid) {
        return { success: false, error: validatedColumnId.error ?? 'Invalid columnId' };
      }
      if (!Array.isArray(orderedTaskIds)) {
        return { success: false, error: 'orderedTaskIds must be an array' };
      }
      const ids = orderedTaskIds.filter((id): id is string => typeof id === 'string');
      return executeTeamTaskBoardHandler(dependencies.logger, 'updateKanbanColumnOrder', () =>
        dependencies.commands.updateKanbanColumnOrder(
          validatedTeamName.value!,
          validatedColumnId.value,
          ids
        )
      );
    },

    async updateTaskStatus(_event, teamName, taskId, status) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (typeof status !== 'string' || !VALID_TASK_STATUSES.includes(status as TeamTaskStatus)) {
        return {
          success: false,
          error: `status must be one of: ${VALID_TASK_STATUSES.join(', ')}`,
        };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'updateTaskStatus', () =>
        dependencies.commands.updateTaskStatus(
          validatedTeamName.value!,
          validatedTaskId.value!,
          status as TeamTaskStatus
        )
      );
    },

    async updateTaskOwner(_event, teamName, taskId, owner) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      let nextOwner: string | null = null;
      if (owner !== null) {
        const validatedOwner = validateMemberName(owner);
        if (!validatedOwner.valid) {
          return { success: false, error: validatedOwner.error ?? 'Invalid owner' };
        }
        nextOwner = validatedOwner.value!;
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'updateTaskOwner', () =>
        dependencies.commands.updateTaskOwner(
          validatedTeamName.value!,
          validatedTaskId.value!,
          nextOwner
        )
      );
    },

    async updateTaskFields(_event, teamName, taskId, fields) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (!fields || typeof fields !== 'object') {
        return { success: false, error: 'fields must be an object' };
      }
      const { subject, description } = fields as { subject?: unknown; description?: unknown };
      if (subject !== undefined) {
        if (typeof subject !== 'string') {
          return { success: false, error: 'subject must be a string' };
        }
        if (subject.trim().length === 0) {
          return { success: false, error: 'subject cannot be empty' };
        }
        if (subject.length > 500) {
          return { success: false, error: 'subject must be 500 characters or less' };
        }
      }
      if (description !== undefined && typeof description !== 'string') {
        return { success: false, error: 'description must be a string' };
      }

      const validFields: { subject?: string; description?: string } = {};
      if (typeof subject === 'string') validFields.subject = subject.trim();
      if (typeof description === 'string') validFields.description = description;
      if (Object.keys(validFields).length === 0) {
        return { success: false, error: 'At least one field must be provided' };
      }

      return executeTeamTaskBoardHandler(dependencies.logger, 'updateTaskFields', () =>
        dependencies.updateTaskFields.execute(
          validatedTeamName.value!,
          validatedTaskId.value!,
          validFields
        )
      );
    },

    async startTask(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'startTask', () =>
        dependencies.commands.startTask(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async startTaskByUser(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'startTaskByUser', () =>
        dependencies.commands.startTaskByUser(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async setChangePresenceTracking(_event, teamName, enabled) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      if (typeof enabled !== 'boolean') {
        return { success: false, error: 'enabled must be a boolean' };
      }
      return executeTeamTaskBoardHandler(
        dependencies.logger,
        'setChangePresenceTracking',
        async () => {
          dependencies.changePresence.setTaskChangePresenceTracking(
            validatedTeamName.value!,
            enabled
          );
        }
      );
    },

    async softDeleteTask(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'softDeleteTask', () =>
        dependencies.commands.softDeleteTask(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async restoreTask(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'restoreTask', () =>
        dependencies.commands.restoreTask(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async setTaskClarification(_event, teamName, taskId, value) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (
        value !== null &&
        (typeof value !== 'string' ||
          !VALID_CLARIFICATION_VALUES.includes(value as 'lead' | 'user'))
      ) {
        return { success: false, error: `value must be "lead", "user", or null` };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'setTaskClarification', () =>
        dependencies.commands.setTaskNeedsClarification(
          validatedTeamName.value!,
          validatedTaskId.value!,
          value as TaskClarificationValue
        )
      );
    },

    async addTaskRelationship(_event, teamName, taskId, targetId, type) {
      const validated = validateRelationship(teamName, taskId, targetId, type);
      if ('error' in validated) {
        return { success: false, error: validated.error };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'addTaskRelationship', () =>
        dependencies.commands.addTaskRelationship(
          validated.value.teamName,
          validated.value.taskId,
          validated.value.targetId,
          validated.value.type
        )
      );
    },

    async removeTaskRelationship(_event, teamName, taskId, targetId, type) {
      const validated = validateRelationship(teamName, taskId, targetId, type);
      if ('error' in validated) {
        return { success: false, error: validated.error };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'removeTaskRelationship', () =>
        dependencies.commands.removeTaskRelationship(
          validated.value.teamName,
          validated.value.taskId,
          validated.value.targetId,
          validated.value.type
        )
      );
    },
  };
}
