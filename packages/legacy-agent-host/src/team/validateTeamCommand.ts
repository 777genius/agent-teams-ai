import {
  attachmentReferencesSchema,
  attachmentReferenceSchema,
  messageAttachmentReferencesSchema,
} from '../attachments/uploadContracts.js';
import { isGroupUuid } from '../group-chats/model.js';
import { TeamOwnerError } from './contracts.js';
import { safeSegment, stableJson } from './identity.js';
import type { TeamCommand, TaskRef } from './contracts.js';

export function validateTeamText(value: unknown, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.trim()) || value.length > 1_000_000)
    throw new TeamOwnerError('invalid');
}

function validateRefs(value: TaskRef[] | undefined): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 1000) throw new TeamOwnerError('invalid');
  for (const ref of value) {
    if (!ref || typeof ref !== 'object') throw new TeamOwnerError('invalid');
    safeSegment(ref.taskId);
    if (typeof ref.teamName !== 'string') throw new TeamOwnerError('invalid');
    // Opaque same-owner reference metadata is never passed to a filesystem adapter as a Team path.
    if (!/^host-ref:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(ref.teamName))
      safeSegment(ref.teamName);
    validateTeamText(ref.displayId);
    if (
      ref.displayId.length > 128 ||
      ref.displayId.trim() !== ref.displayId ||
      Object.keys(ref).some((key) => !['taskId', 'teamName', 'displayId'].includes(key))
    )
      throw new TeamOwnerError('invalid');
  }
}

export function validateTeamCommand(command: TeamCommand): void {
  if (!command || typeof command !== 'object') throw new TeamOwnerError('invalid');
  validateTeamText(command.commandId);
  if (command.commandId.length > 256) throw new TeamOwnerError('invalid');
  const payload = command.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new TeamOwnerError('invalid');
  switch (command.operation) {
    case 'task.create':
      if (command.payload.groupChatId !== undefined && !isGroupUuid(command.payload.groupChatId))
        throw new TeamOwnerError('invalid');
      validateRefs(command.payload.descriptionTaskRefs);
      validateRefs(command.payload.promptTaskRefs);
      if (command.payload.prompt !== undefined) validateTeamText(command.payload.prompt, true);
      if (
        command.payload.startImmediately !== undefined &&
        typeof command.payload.startImmediately !== 'boolean'
      )
        throw new TeamOwnerError('invalid');
      validateTeamText(command.payload.subject);
      if (command.payload.description !== undefined)
        validateTeamText(command.payload.description, true);
      if (command.payload.owner !== undefined) validateTeamText(command.payload.owner);
      for (const key of ['blockedBy', 'related'] as const) {
        const ids = command.payload[key];
        if (ids !== undefined) {
          if (!Array.isArray(ids) || ids.length > 1000) throw new TeamOwnerError('invalid');
          ids.forEach((id) => safeSegment(id));
        }
      }
      break;
    case 'task.update':
      safeSegment(command.payload.taskId);
      if (command.payload.subject === undefined && command.payload.description === undefined)
        throw new TeamOwnerError('invalid');
      if (command.payload.subject !== undefined) validateTeamText(command.payload.subject);
      if (command.payload.description !== undefined)
        validateTeamText(command.payload.description, true);
      break;
    case 'task.attachment.add':
      safeSegment(command.payload.taskId);
      attachmentReferenceSchema.parse(command.payload.attachment);
      break;
    case 'task.attachment.remove':
      safeSegment(command.payload.taskId);
      safeSegment(command.payload.attachmentId);
      break;
    case 'task.board.clear':
      safeSegment(command.payload.taskId);
      break;
    case 'task.board.order': {
      const { columnId, orderedTaskIds } = command.payload;
      if (
        !['todo', 'in_progress', 'done', 'review', 'approved'].includes(columnId) ||
        !Array.isArray(orderedTaskIds) ||
        orderedTaskIds.length > 1000 ||
        new Set(orderedTaskIds).size !== orderedTaskIds.length
      )
        throw new TeamOwnerError('invalid');
      for (const id of orderedTaskIds) safeSegment(id);
      break;
    }
    case 'task.relationship':
      safeSegment(command.payload.taskId);
      safeSegment(command.payload.targetId);
      if (
        !['blockedBy', 'blocks', 'related'].includes(command.payload.type) ||
        !['add', 'remove'].includes(command.payload.action)
      )
        throw new TeamOwnerError('invalid');
      break;
    case 'task.clarification':
      safeSegment(command.payload.taskId);
      if (command.payload.value !== null && !['lead', 'user'].includes(command.payload.value))
        throw new TeamOwnerError('invalid');
      break;
    case 'task.assign':
      safeSegment(command.payload.taskId);
      if (command.payload.owner !== null) validateTeamText(command.payload.owner);
      break;
    case 'task.start':
      safeSegment(command.payload.taskId);
      if (!['legacy', 'user'].includes(command.payload.notification))
        throw new TeamOwnerError('invalid');
      break;
    case 'task.lifecycle':
      safeSegment(command.payload.taskId);
      if (!['start', 'complete', 'delete', 'restore', 'pending'].includes(command.payload.action))
        throw new TeamOwnerError('invalid');
      break;
    case 'task.review': {
      const review = command.payload;
      safeSegment(review.taskId);
      if (!['request', 'start', 'approve', 'disapprove', 'request_changes'].includes(review.action))
        throw new TeamOwnerError('invalid');
      const fields =
        review.action === 'request'
          ? ['reviewer']
          : review.action === 'approve'
            ? ['note', 'notifyOwner', 'suppressTaskComment']
            : review.action === 'request_changes'
              ? ['comment', 'taskRefs']
              : [];
      if (Object.keys(review).some((key) => !['taskId', 'action', ...fields].includes(key)))
        throw new TeamOwnerError('invalid');
      if (review.action === 'request' && review.reviewer !== undefined)
        safeSegment(review.reviewer);
      if (review.action === 'approve') {
        if (review.note !== undefined) validateTeamText(review.note, true);
        for (const key of ['notifyOwner', 'suppressTaskComment'] as const)
          if (review[key] !== undefined && typeof review[key] !== 'boolean')
            throw new TeamOwnerError('invalid');
      }
      if (review.action === 'request_changes') {
        validateTeamText(review.comment);
        validateRefs(review.taskRefs);
      }
      break;
    }
    case 'task.comment':
      if (command.payload.attachments !== undefined)
        attachmentReferencesSchema.parse(command.payload.attachments);
      validateRefs(command.payload.taskRefs);
      safeSegment(command.payload.taskId);
      validateTeamText(command.payload.text);
      break;
    case 'message.send':
      if (command.payload.attachments !== undefined)
        messageAttachmentReferencesSchema.parse(command.payload.attachments);
      validateRefs(command.payload.taskRefs);
      safeSegment(command.payload.to);
      validateTeamText(command.payload.text);
      if (command.payload.messageId !== undefined) {
        validateTeamText(command.payload.messageId);
        if (
          command.payload.messageId !== command.commandId ||
          command.payload.messageId.includes('\0')
        )
          throw new TeamOwnerError('invalid');
      }
      if (command.payload.summary !== undefined) {
        validateTeamText(command.payload.summary, true);
        if (command.payload.summary.length > 200_000) throw new TeamOwnerError('invalid');
      }
      if (
        command.payload.actionMode !== undefined &&
        !['do', 'ask', 'delegate'].includes(command.payload.actionMode)
      )
        throw new TeamOwnerError('invalid');
      break;
    default:
      throw new TeamOwnerError('invalid');
  }
  const allowed: Record<TeamCommand['operation'], string[]> = {
    'task.create': [
      'subject',
      'groupChatId',
      'description',
      'owner',
      'blockedBy',
      'related',
      'prompt',
      'promptTaskRefs',
      'startImmediately',
      'descriptionTaskRefs',
    ],
    'task.update': ['taskId', 'subject', 'description'],
    'task.attachment.add': ['taskId', 'attachment'],
    'task.attachment.remove': ['taskId', 'attachmentId'],
    'task.board.clear': ['taskId'],
    'task.board.order': ['columnId', 'orderedTaskIds'],
    'task.relationship': ['taskId', 'targetId', 'type', 'action'],
    'task.clarification': ['taskId', 'value'],
    'task.assign': ['taskId', 'owner'],
    'task.lifecycle': ['taskId', 'action'],
    'task.start': ['taskId', 'notification'],
    'task.comment': ['taskId', 'text', 'taskRefs', 'attachments'],
    'task.review': [
      'taskId',
      'action',
      'reviewer',
      'note',
      'notifyOwner',
      'suppressTaskComment',
      'comment',
      'taskRefs',
    ],
    'message.send': ['to', 'text', 'taskRefs', 'messageId', 'summary', 'actionMode', 'attachments'],
  };
  if (
    Object.keys(command).some((key) => !['commandId', 'operation', 'payload'].includes(key)) ||
    Object.keys(payload).some((key) => !allowed[command.operation].includes(key))
  )
    throw new TeamOwnerError('invalid');
  // Reject non-JSON values, unsupported objects and conflicting identity overrides.
  stableJson(command);
  for (const key of ['from', 'actor', 'createdBy', 'id', 'creationCommand'])
    if (Object.hasOwn(payload, key)) throw new TeamOwnerError('invalid');
}
