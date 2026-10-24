import {
  attachmentReferenceSchema,
  attachmentReferencesSchema,
  attachmentUploadSchema,
  messageAttachmentReferencesSchema,
} from '@agent-teams/legacy-agent-host/attachments/contracts';
import { parseGroupPayload } from '@agent-teams/legacy-agent-host/group-chats/operations';
import { taskAttachmentReadSchema } from '@agent-teams/legacy-agent-host/stopped-team-import';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import { isProcessRef } from '../../../contracts/processes';

import { InvalidBackendOperation, object, stringArray, text } from './backendOperationInput';
import { parseCrossTeamSend } from './crossTeamValues';
import { isBackendReviewOperation, parseBackendReviewPayload } from './reviewValues';
import { parseBackendRuntimeOperation } from './runtimeOperationValues';
import { parseBackendTeamOperation } from './teamOperationValues';

import type {
  BackendOperationPayloads,
  BackendOperationRequest,
  BackendTaskRef,
} from '../../../contracts/operations';

export { InvalidBackendOperation, object, stringArray, text } from './backendOperationInput';

function description(value: unknown): string {
  if (value === '') return '';
  return text(value, 200_000);
}

function refs(value: unknown): BackendTaskRef[] {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidBackendOperation();
  return value.map((entry) => {
    const ref = object(entry, ['taskId', 'displayId', 'teamName']);
    return {
      taskId: text(ref.taskId),
      displayId: text(ref.displayId),
      teamName: text(ref.teamName),
    };
  });
}

function payload(
  operation: string,
  value: unknown
): BackendOperationPayloads[keyof BackendOperationPayloads] {
  if (operation.startsWith('team.')) return parseBackendTeamOperation(operation, value);
  if (operation.startsWith('runtime.')) return parseBackendRuntimeOperation(operation, value);
  if (isBackendReviewOperation(operation)) return parseBackendReviewPayload(operation, value);
  if (operation.startsWith('group.')) return parseGroupPayload(operation, value);
  switch (operation) {
    case 'process.list':
    case 'process.pending.read':
    case 'crossTeam.lookup':
    case 'crossTeam.outbox.read':
    case 'tasks.list':
    case 'command.lookup':
      object(value, []);
      return {};
    case 'process.lookup': {
      const p = object(value, ['originalCommandId']);
      return { originalCommandId: text(p.originalCommandId) };
    }
    case 'process.terminate': {
      const p = object(value, ['processRef']);
      if (!isProcessRef(p.processRef)) throw new InvalidBackendOperation();
      return { processRef: p.processRef };
    }
    case 'crossTeam.send':
      return parseCrossTeamSend(value);
    case 'message.attachments.read':
    case 'message.attachment.read': {
      const list = operation === 'message.attachments.read';
      const p = object(
        value,
        list ? ['reference'] : ['reference', 'attachmentId', 'offset', 'expectedSha256']
      );
      const reference = text(p.reference);
      if (
        !/^(?:im1:[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[a-f0-9]{64}|[A-Za-z0-9][A-Za-z0-9_-]{0,127})$/.test(
          reference
        )
      )
        throw new InvalidBackendOperation();
      if (list) return { reference };
      const parsed = taskAttachmentReadSchema.parse({
        taskId: 'message',
        attachmentId: p.attachmentId,
        offset: p.offset,
        ...(p.expectedSha256 === undefined ? {} : { expectedSha256: p.expectedSha256 }),
      });
      const { taskId: _task, ...chunk } = parsed;
      return { reference, ...chunk };
    }
    case 'attachment.upload':
      return attachmentUploadSchema.parse(value);
    case 'task.attachment.add': {
      const p = object(value, ['taskId', 'attachment']);
      return { taskId: text(p.taskId), attachment: attachmentReferenceSchema.parse(p.attachment) };
    }
    case 'task.attachment.remove': {
      const p = object(value, ['taskId', 'attachmentId']);
      return { taskId: text(p.taskId), attachmentId: text(p.attachmentId) };
    }
    case 'task.attachment.read':
      return taskAttachmentReadSchema.parse(value);
    case 'task.create': {
      const p = object(value, [
        'subject',
        'description',
        'owner',
        'blockedBy',
        'related',
        'prompt',
        'promptTaskRefs',
        'startImmediately',
        'descriptionTaskRefs',
      ]);
      if (p.startImmediately !== undefined && typeof p.startImmediately !== 'boolean')
        throw new InvalidBackendOperation();
      return {
        subject: text(p.subject, 20_000),
        ...(p.related === undefined ? {} : { related: stringArray(p.related) }),
        ...(p.prompt === undefined ? {} : { prompt: description(p.prompt) }),
        ...(p.promptTaskRefs === undefined ? {} : { promptTaskRefs: refs(p.promptTaskRefs) }),
        ...(p.startImmediately === undefined ? {} : { startImmediately: p.startImmediately }),
        ...(p.description === undefined ? {} : { description: description(p.description) }),
        ...(p.owner === undefined ? {} : { owner: text(p.owner) }),
        ...(p.blockedBy === undefined ? {} : { blockedBy: stringArray(p.blockedBy) }),
        ...(p.descriptionTaskRefs === undefined
          ? {}
          : { descriptionTaskRefs: refs(p.descriptionTaskRefs) }),
      };
    }
    case 'task.update': {
      const p = object(value, ['taskId', 'subject', 'description']);
      if (p.subject === undefined && p.description === undefined)
        throw new InvalidBackendOperation();
      return {
        taskId: text(p.taskId),
        ...(p.subject === undefined ? {} : { subject: text(p.subject, 20_000) }),
        ...(p.description === undefined ? {} : { description: description(p.description) }),
      };
    }
    case 'task.board.clear': {
      const p = object(value, ['taskId']);
      return { taskId: text(p.taskId) };
    }
    case 'task.board.order': {
      const p = object(value, ['columnId', 'orderedTaskIds']);
      if (
        typeof p.columnId !== 'string' ||
        !['todo', 'in_progress', 'done', 'review', 'approved'].includes(p.columnId)
      )
        throw new InvalidBackendOperation();
      if (!Array.isArray(p.orderedTaskIds) || p.orderedTaskIds.length > 1000)
        throw new InvalidBackendOperation();
      const orderedTaskIds = p.orderedTaskIds.map((id) => text(id));
      if (new Set(orderedTaskIds).size !== orderedTaskIds.length)
        throw new InvalidBackendOperation();
      return {
        columnId: p.columnId as BackendOperationPayloads['task.board.order']['columnId'],
        orderedTaskIds,
      };
    }
    case 'task.relationship': {
      const p = object(value, ['taskId', 'targetId', 'type', 'action']);
      if (
        typeof p.type !== 'string' ||
        !['blockedBy', 'blocks', 'related'].includes(p.type) ||
        typeof p.action !== 'string' ||
        !['add', 'remove'].includes(p.action)
      )
        throw new InvalidBackendOperation();
      return {
        taskId: text(p.taskId),
        targetId: text(p.targetId),
        type: p.type as BackendOperationPayloads['task.relationship']['type'],
        action: p.action as BackendOperationPayloads['task.relationship']['action'],
      };
    }
    case 'task.clarification': {
      const p = object(value, ['taskId', 'value']);
      if (p.value !== null && p.value !== 'lead' && p.value !== 'user')
        throw new InvalidBackendOperation();
      return { taskId: text(p.taskId), value: p.value };
    }
    case 'task.assign': {
      const p = object(value, ['taskId', 'owner']);
      return { taskId: text(p.taskId), owner: p.owner === null ? null : text(p.owner) };
    }
    case 'task.start': {
      const p = object(value, ['taskId', 'notification']);
      if (p.notification !== 'legacy' && p.notification !== 'user')
        throw new InvalidBackendOperation();
      return { taskId: text(p.taskId), notification: p.notification };
    }
    case 'task.lifecycle': {
      const p = object(value, ['taskId', 'action']);
      if (!['start', 'complete', 'delete', 'restore', 'pending'].includes(String(p.action)))
        throw new InvalidBackendOperation();
      return {
        taskId: text(p.taskId),
        action: p.action as BackendOperationPayloads['task.lifecycle']['action'],
      };
    }
    case 'task.review': {
      const p = object(value, [
        'taskId',
        'action',
        'reviewer',
        'note',
        'notifyOwner',
        'suppressTaskComment',
        'comment',
        'taskRefs',
      ]);
      const taskId = text(p.taskId);
      if (p.action === 'request') {
        object(value, ['taskId', 'action', 'reviewer']);
        return {
          taskId,
          action: 'request',
          ...(p.reviewer === undefined ? {} : { reviewer: text(p.reviewer) }),
        };
      }
      if (p.action === 'start') {
        object(value, ['taskId', 'action']);
        return { taskId, action: 'start' };
      }
      if (p.action === 'disapprove') {
        object(value, ['taskId', 'action']);
        return { taskId, action: 'disapprove' };
      }
      if (p.action === 'approve') {
        object(value, ['taskId', 'action', 'note', 'notifyOwner', 'suppressTaskComment']);
        for (const key of ['notifyOwner', 'suppressTaskComment'])
          if (p[key] !== undefined && typeof p[key] !== 'boolean')
            throw new InvalidBackendOperation();
        return {
          taskId,
          action: 'approve',
          ...(p.note === undefined ? {} : { note: description(p.note) }),
          ...(p.notifyOwner === undefined ? {} : { notifyOwner: p.notifyOwner as boolean }),
          ...(p.suppressTaskComment === undefined
            ? {}
            : { suppressTaskComment: p.suppressTaskComment as boolean }),
        };
      }
      if (p.action === 'request_changes') {
        object(value, ['taskId', 'action', 'comment', 'taskRefs']);
        return {
          taskId,
          action: 'request_changes',
          comment: text(p.comment, 200_000),
          ...(p.taskRefs === undefined ? {} : { taskRefs: refs(p.taskRefs) }),
        };
      }
      throw new InvalidBackendOperation();
    }
    case 'task.comment': {
      const p = object(value, ['taskId', 'text', 'taskRefs', 'attachments']);
      return {
        taskId: text(p.taskId),
        text: text(p.text, 200_000),
        ...(p.attachments === undefined
          ? {}
          : { attachments: attachmentReferencesSchema.parse(p.attachments) }),
        ...(p.taskRefs === undefined ? {} : { taskRefs: refs(p.taskRefs) }),
      };
    }
    case 'message.send': {
      const p = object(value, [
        'to',
        'text',
        'taskRefs',
        'messageId',
        'summary',
        'actionMode',
        'attachments',
      ]);
      if (parseStandaloneSlashCommand(text(p.text, 200_000))) throw new InvalidBackendOperation();
      if (
        p.actionMode !== undefined &&
        (typeof p.actionMode !== 'string' || !['do', 'ask', 'delegate'].includes(p.actionMode))
      )
        throw new InvalidBackendOperation();
      return {
        to: text(p.to),
        text: text(p.text, 200_000),
        ...(p.attachments === undefined
          ? {}
          : { attachments: messageAttachmentReferencesSchema.parse(p.attachments) }),
        ...(p.messageId === undefined ? {} : { messageId: text(p.messageId) }),
        ...(p.summary === undefined ? {} : { summary: description(p.summary) }),
        ...(p.actionMode === undefined
          ? {}
          : { actionMode: p.actionMode as 'do' | 'ask' | 'delegate' }),
        ...(p.taskRefs === undefined ? {} : { taskRefs: refs(p.taskRefs) }),
      };
    }
    case 'task.get':
      return { taskId: text(object(value, ['taskId']).taskId) };

    default:
      throw new InvalidBackendOperation();
  }
}

/** Strict input projection: transport clients cannot supply RPC methods, roots or authority. */
export function parseBackendOperation(value: unknown): BackendOperationRequest {
  const input = object(value, ['handle', 'commandId', 'operation', 'payload']);
  const handle = object(input.handle, ['handleId']);
  const operation = text(input.operation);
  const commandId = text(input.commandId);
  const capturedPayload = payload(operation, input.payload);
  if (
    (operation === 'message.send' || operation === 'crossTeam.send') &&
    'messageId' in capturedPayload &&
    capturedPayload.messageId !== commandId
  )
    throw new InvalidBackendOperation();
  return {
    handle: { handleId: text(handle.handleId) },
    commandId,
    operation,
    payload: capturedPayload,
  } as BackendOperationRequest;
}
