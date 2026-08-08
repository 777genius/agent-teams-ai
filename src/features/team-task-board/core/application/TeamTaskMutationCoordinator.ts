import { resolveTaskMutationWorkflowColumn } from '../domain/policies/taskMutationReviewPolicy';

import type { TaskAttachmentMeta } from '../../contracts/taskAttachments';
import type {
  KanbanColumnId,
  TaskComment,
  TaskRef,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from './models/TeamTaskBoardPortModels';
import type {
  TaskClarificationValue,
  TaskRelationshipType,
} from './ports/TeamTaskBoardMutationPorts';
import type {
  TaskMutationBoardPort,
  TeamTaskMutationCoordinatorPorts,
} from './ports/TeamTaskMutationCoordinatorPorts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readTaskComment(result: unknown): TaskComment | null {
  if (!isRecord(result)) {
    return null;
  }
  const comment = result.comment;
  return isRecord(comment) ? (comment as unknown as TaskComment) : null;
}

function readTaskSnapshot(
  taskBoard: TaskMutationBoardPort,
  taskId: string
): {
  status: string;
  reviewState?: unknown;
  historyEvents?: readonly unknown[];
  kanbanColumn?: unknown;
} | null {
  if (!taskBoard.getTask || !taskBoard.getKanbanState) {
    return null;
  }

  const task = taskBoard.getTask(taskId);
  if (!isRecord(task) || typeof task.status !== 'string') {
    return null;
  }

  const kanbanState = taskBoard.getKanbanState();
  const kanbanTasks = isRecord(kanbanState) ? kanbanState.tasks : undefined;
  const kanbanTask = isRecord(kanbanTasks) ? kanbanTasks[String(task.id)] : undefined;

  return {
    status: task.status,
    reviewState: task.reviewState,
    historyEvents: Array.isArray(task.historyEvents) ? task.historyEvents : undefined,
    kanbanColumn: isRecord(kanbanTask) ? kanbanTask.column : undefined,
  };
}

export class TeamTaskMutationCoordinator {
  constructor(private readonly ports: TeamTaskMutationCoordinatorPorts) {}

  async updateTaskStatus(
    teamName: string,
    taskId: string,
    status: TeamTaskStatus,
    actor?: string
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).setTaskStatus(taskId, status, actor);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async softDeleteTask(teamName: string, taskId: string): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).softDeleteTask(taskId, 'user');
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async restoreTask(teamName: string, taskId: string): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).restoreTask(taskId, 'user');
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).setTaskOwner(taskId, owner, 'user');
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async updateTaskFields(
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).updateTaskFields(taskId, fields);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async addTaskAttachment(
    teamName: string,
    taskId: string,
    metadata: TaskAttachmentMeta
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).addTaskAttachmentMeta(taskId, metadata);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async removeTaskAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).removeTaskAttachment(taskId, attachmentId);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: TaskClarificationValue
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).setNeedsClarification(taskId, value);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void> {
    this.ports.taskBoards
      .getTaskBoard(teamName)
      .linkTask(taskId, targetId, type === 'blockedBy' ? 'blocked-by' : type);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void> {
    this.ports.taskBoards
      .getTaskBoard(teamName)
      .unlinkTask(taskId, targetId, type === 'blockedBy' ? 'blocked-by' : type);
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();
  }

  async addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment> {
    const addResult = this.ports.taskBoards.getTaskBoard(teamName).addTaskComment(taskId, {
      from: 'user',
      text,
      attachments,
      taskRefs,
    });
    this.ports.taskProjection.invalidateGlobalTaskProjectionCache();

    return (
      readTaskComment(addResult) ?? {
        id: this.ports.identity.createId(),
        author: 'user',
        text,
        createdAt: this.ports.clock.nowIso(),
        type: 'regular',
        ...(taskRefs && taskRefs.length > 0 ? { taskRefs } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }
    );
  }

  async requestReview(teamName: string, taskId: string): Promise<void> {
    const { leadName, leadSessionId } =
      await this.ports.leadContext.resolveLeadRuntimeContext(teamName);
    this.ports.taskBoards.getTaskBoard(teamName).requestReview(taskId, {
      from: leadName,
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  }

  async updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    const taskBoard = this.ports.taskBoards.getTaskBoard(teamName);

    if (patch.op === 'remove') {
      taskBoard.clearKanban(taskId);
      return;
    }

    if (patch.op === 'set_column') {
      const { leadName, leadSessionId } =
        await this.ports.leadContext.resolveLeadRuntimeContext(teamName);
      if (patch.column === 'review') {
        taskBoard.requestReview(taskId, {
          from: leadName,
          ...(leadSessionId ? { leadSessionId } : {}),
        });
        return;
      }

      const taskSnapshot = readTaskSnapshot(taskBoard, taskId);
      const workflowColumn = taskSnapshot ? resolveTaskMutationWorkflowColumn(taskSnapshot) : null;
      if (workflowColumn === undefined) {
        taskBoard.setKanbanColumn(taskId, 'approved', {
          transition: 'manual_approve',
        });
      } else {
        taskBoard.approveReview(taskId, {
          from: leadName,
          suppressTaskComment: true,
          'notify-owner': true,
          ...(leadSessionId ? { leadSessionId } : {}),
        });
      }
      return;
    }

    const { leadName, leadSessionId } =
      await this.ports.leadContext.resolveLeadRuntimeContext(teamName);
    taskBoard.requestChanges(taskId, {
      from: leadName,
      comment: patch.comment?.trim() || 'Reviewer requested changes.',
      ...(patch.taskRefs?.length ? { taskRefs: patch.taskRefs } : {}),
      ...(leadSessionId ? { leadSessionId } : {}),
    });
  }

  async updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    this.ports.taskBoards.getTaskBoard(teamName).updateColumnOrder(columnId, orderedTaskIds);
  }
}
