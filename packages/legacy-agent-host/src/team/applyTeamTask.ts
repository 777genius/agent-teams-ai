import { TeamOwnerError } from './contracts.js';
import { createTeamTask } from './createTeamTask.js';
import type { CommandReceipt } from './contracts.js';
import type { TaskBoardPolicy, TeamAttachmentPort } from './ports.js';
import type { JsonValue } from '../contracts.js';

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function applyTeamTask(
  receipt: CommandReceipt,
  actor: string,
  board: TaskBoardPolicy,
  teamName: string,
  attachments?: TeamAttachmentPort
): JsonValue {
  const command = receipt.command;
  switch (command.operation) {
    case 'task.create':
      return createTeamTask(receipt, actor, board, teamName);
    case 'task.attachment.add': {
      if (!board.addTaskAttachmentMeta) throw new TeamOwnerError('invalid');
      const metadata = attachments!.metadata([command.payload.attachment], {
        kind: 'task',
        taskId: command.payload.taskId,
      })[0]!;
      return json(board.addTaskAttachmentMeta(command.payload.taskId, { ...metadata }));
    }
    case 'task.attachment.remove':
      if (!board.removeTaskAttachment) throw new TeamOwnerError('invalid');
      return json(board.removeTaskAttachment(command.payload.taskId, command.payload.attachmentId));
    case 'task.update': {
      const { taskId, ...fields } = command.payload;
      return json(board.updateTaskFields(taskId, fields));
    }
    case 'task.board.clear':
      board.clearKanban(command.payload.taskId);
      return json(board.getTask(command.payload.taskId));
    case 'task.board.order':
      return json(
        board.updateColumnOrder(command.payload.columnId, command.payload.orderedTaskIds)
      );
    case 'task.relationship': {
      const { taskId, targetId, type, action } = command.payload;
      const relationship = type === 'blockedBy' ? 'blocked-by' : type;
      if (action === 'add') board.linkTask(taskId, targetId, relationship);
      else board.unlinkTask(taskId, targetId, relationship);
      return json(board.getTask(taskId));
    }
    case 'task.clarification':
      return json(board.setNeedsClarification(command.payload.taskId, command.payload.value));
    case 'task.assign':
      return json(board.setTaskOwner(command.payload.taskId, command.payload.owner, actor));
    case 'task.comment':
      return json(
        board.addTaskComment(command.payload.taskId, {
          text: command.payload.text,
          taskRefs: command.payload.taskRefs,
          ...(command.payload.attachments?.length
            ? {
                attachments: attachments!.metadata(command.payload.attachments, {
                  kind: 'task',
                  taskId: command.payload.taskId,
                }),
              }
            : {}),
          from: actor,
          id: receipt.effects.commentId,
          createdAt: receipt.createdAt,
        })
      );
    case 'task.start':
      return json(
        board.startTaskNotifying({
          ...command.payload,
          ...(receipt.taskStartLeadName ? { leadName: receipt.taskStartLeadName } : {}),
          messageId: receipt.effects.messageId,
          timestamp: receipt.createdAt,
          recipients: receipt.taskRecipients!.map(({ name }) => name),
        })
      );
    case 'task.review': {
      const payload = command.payload;
      const { taskId } = payload;
      if (payload.action === 'request')
        board.requestReview(taskId, {
          from: actor,
          ...(payload.reviewer === undefined ? {} : { reviewer: payload.reviewer }),
        });
      else if (payload.action === 'start') board.startReview(taskId, { from: actor });
      else if (payload.action === 'disapprove') board.disapproveReview(taskId, { from: actor });
      else if (payload.action === 'approve')
        board.approveReview(taskId, {
          from: actor,
          ...(payload.note === undefined ? {} : { note: payload.note }),
          ...(payload.notifyOwner === undefined ? {} : { 'notify-owner': payload.notifyOwner }),
          ...(payload.suppressTaskComment === undefined
            ? {}
            : { suppressTaskComment: payload.suppressTaskComment }),
        });
      else
        board.requestChanges(taskId, {
          from: actor,
          comment: payload.comment,
          ...(payload.taskRefs === undefined ? {} : { taskRefs: payload.taskRefs }),
        });
      return json(board.getTask(taskId));
    }
    case 'task.lifecycle': {
      const { taskId, action } = command.payload;
      if (action === 'start') return json(board.startTask(taskId, actor));
      if (action === 'complete') return json(board.completeTask(taskId, actor));
      if (action === 'delete') return json(board.softDeleteTask(taskId, actor));
      if (action === 'restore') return json(board.restoreTask(taskId, actor));
      return json(board.setTaskStatus(taskId, 'pending', actor));
    }
    default:
      throw new TeamOwnerError('invalid');
  }
}
