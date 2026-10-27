import { hasGroupChatEnvelopeMarker } from '@agent-teams/legacy-agent-host/group-chats/contracts';
import { isGroupUuid } from '@agent-teams/legacy-agent-host/group-chats/policy';

import { readBackendProcesses } from '../../../contracts/processes';

import { projectAttachmentMetadata } from './projectAttachmentMetadata';
import { projectGroupMessageEnvelope } from './projectGroupMessageEnvelope';
import { projectTaskSourceMessage } from './projectSourceMessage';
import { projectTeamPosition } from './projectTeamChanges';
import { projectTeamLifecycleSnapshot } from './projectTeamLifecycle';

import type { BackendTeamSnapshot } from '../../../contracts/teamSnapshot';
import type { KanbanState, TaskComment, TeamTaskWithKanban } from '@shared/types/team';

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid snapshot');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Invalid snapshot');
  return value;
}
function array<T>(value: unknown, parse: (value: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid snapshot');
  return value.map(parse);
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (!choices.includes(value as T)) throw new Error('Invalid snapshot');
  return value as T;
}
function strings(source: Record<string, unknown>, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, text(source[key])])
  );
}
function refs(value: unknown) {
  return array(value, (value) => {
    const ref = row(value);
    return {
      taskId: text(ref.taskId),
      teamName: text(ref.teamName),
      displayId: text(ref.displayId),
    };
  });
}
function comment(value: unknown): TaskComment {
  const source = row(value);
  return {
    id: text(source.id),
    author: text(source.author),
    text: text(source.text),
    createdAt: text(source.createdAt),
    type: choice(source.type, ['regular', 'review_request', 'review_approved']),
    ...(source.taskRefs === undefined ? {} : { taskRefs: refs(source.taskRefs) }),
    ...(source.attachments === undefined
      ? {}
      : { attachments: projectAttachmentMetadata(source.attachments) }),
  };
}
function task(value: unknown, teamName: string): TeamTaskWithKanban {
  const source = row(value);
  const result: TeamTaskWithKanban = {
    ...projectTaskSourceMessage(source, teamName),
    id: text(source.id),
    subject: text(source.subject),
    status: choice(source.status, ['pending', 'in_progress', 'completed', 'deleted']),
    ...strings(source, [
      'displayId',
      'description',
      'prompt',
      'owner',
      'createdBy',
      'createdAt',
      'updatedAt',
      'activeForm',
      'deletedAt',
    ]),
  };
  for (const key of ['blocks', 'blockedBy', 'related'] as const)
    if (source[key] !== undefined) result[key] = array(source[key], text);
  if (source.groupChatId !== undefined) {
    if (!isGroupUuid(source.groupChatId)) throw new Error('Invalid task group');
    result.groupChatId = source.groupChatId;
  }
  if (source.descriptionTaskRefs !== undefined)
    result.descriptionTaskRefs = refs(source.descriptionTaskRefs);
  if (source.promptTaskRefs !== undefined) result.promptTaskRefs = refs(source.promptTaskRefs);
  if (source.comments !== undefined) result.comments = array(source.comments, comment);
  if (source.attachments !== undefined)
    result.attachments = projectAttachmentMetadata(source.attachments);
  if (source.reviewState !== undefined)
    result.reviewState = choice(source.reviewState, [
      'none',
      'review',
      'needsFix',
      'approved',
    ] as const);
  if (source.needsClarification !== undefined)
    result.needsClarification = choice(source.needsClarification, ['lead', 'user'] as const);
  return result;
}
function origin(value: unknown) {
  const r = row(value);
  return {
    fromTeamResourceRef: text(r.fromTeamResourceRef),
    toTeamResourceRef: text(r.toTeamResourceRef),
    fromTeamName: text(r.fromTeamName),
    toTeamName: text(r.toTeamName),
    ...strings(r, ['fromHandleId', 'toHandleId']),
  };
}
function message(value: unknown): BackendTeamSnapshot['messages'][number] {
  const source = row(value);
  if (typeof source.read !== 'boolean') throw new Error('Invalid snapshot');
  return {
    ...(hasGroupChatEnvelopeMarker(source) ? projectGroupMessageEnvelope(source) : {}),
    from: text(source.from),
    ...(source.source === undefined
      ? {}
      : {
          source: choice(source.source, [
            'inbox',
            'lead_session',
            'lead_process',
            'runtime_delivery',
            'user_sent',
            'system_notification',
            'cross_team',
            'cross_team_sent',
          ] as const),
        }),
    ...(source.crossTeamOrigin === undefined
      ? {}
      : { crossTeamOrigin: origin(source.crossTeamOrigin) }),
    ...(source.actionMode === undefined
      ? {}
      : { actionMode: choice(source.actionMode, ['do', 'ask', 'delegate'] as const) }),
    text: text(source.text),
    timestamp: text(source.timestamp),
    read: source.read,
    ...strings(source, [
      'to',
      'messageId',
      'summary',
      'color',
      'relayOfMessageId',
      'commentId',
      'conversationId',
      'replyToConversationId',
    ]),
    ...(source.taskRefs === undefined ? {} : { taskRefs: refs(source.taskRefs) }),
    ...(source.attachments === undefined
      ? {}
      : { attachments: projectAttachmentMetadata(source.attachments) }),
  };
}
function kanban(value: unknown, teamName: string): KanbanState {
  const source = row(value);
  if (source.teamName !== teamName) throw new Error('Wrong snapshot team');
  const result: KanbanState = { teamName, reviewers: array(source.reviewers, text), tasks: {} };
  for (const [id, value] of Object.entries(row(source.tasks))) {
    const entry = row(value);
    result.tasks[id] = {
      column: choice(entry.column, ['review', 'approved']),
      movedAt: text(entry.movedAt),
      ...(entry.reviewer === undefined
        ? {}
        : { reviewer: entry.reviewer === null ? null : text(entry.reviewer) }),
      ...strings(entry, ['errorDescription']),
    };
  }
  if (source.columnOrder !== undefined) {
    result.columnOrder = {};
    for (const [column, ids] of Object.entries(row(source.columnOrder))) {
      const key = choice(column, ['todo', 'in_progress', 'done', 'review', 'approved']);
      result.columnOrder[key] = array(ids, text);
    }
  }
  return result;
}

/** Product fields only; private paths, receipts, native IDs and arbitrary extras are omitted. */
export function projectTeamSnapshot(value: unknown): BackendTeamSnapshot {
  const source = row(value);
  if (Buffer.byteLength(JSON.stringify(source)) > 512 * 1024) throw new Error('Oversized snapshot');
  const teamName = text(source.teamName);
  const revision = text(source.revision);
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid snapshot revision');
  const configurationRevision = source.configurationRevision;
  if (
    configurationRevision !== undefined &&
    (typeof configurationRevision !== 'string' || !/^[a-f0-9]{64}$/.test(configurationRevision))
  )
    throw new Error('Invalid configuration revision');
  if (source.runtimeNeverLaunched !== undefined && source.runtimeNeverLaunched !== true)
    throw new Error('Invalid runtime history');
  const kanbanState = kanban(source.kanbanState, teamName);
  return {
    teamName,
    revision,
    ...(source.runtimeNeverLaunched === true ? { runtimeNeverLaunched: true as const } : {}),
    ...(source.lifecycle === undefined
      ? {}
      : { lifecycle: projectTeamLifecycleSnapshot(source.lifecycle) }),
    ...(configurationRevision === undefined ? {} : { configurationRevision }),
    feed: projectTeamPosition(source.feed),
    kanbanState,
    members: array(source.members, (value) => {
      const member = row(value);
      return { name: text(member.name), role: choice(member.role, ['lead', 'member']) };
    }),
    tasks: array(source.tasks, (value) => task(value, teamName)).map((task) => ({
      ...task,
      ...(kanbanState.tasks[task.id]
        ? {
            kanbanColumn: kanbanState.tasks[task.id].column,
            reviewer: kanbanState.tasks[task.id].reviewer,
          }
        : {}),
    })),
    messages: array(source.messages, message),
    ...(source.processes === undefined
      ? {}
      : { processes: readBackendProcesses(source.processes) }),
  };
}
