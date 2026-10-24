import {
  attachmentReferenceSchema,
  attachmentReferencesSchema,
  attachmentUploadSchema,
  messageAttachmentReferencesSchema,
} from '@agent-teams/legacy-agent-host/attachments/contracts';
import { taskAttachmentReadSchema } from '@agent-teams/legacy-agent-host/stopped-team-import';
import { parseStandaloneSlashCommand } from '@shared/utils/slashCommands';

import {
  readMemberActionLookup,
  readMemberActionQuery,
  readMemberActionRequest,
} from '../../../contracts/memberActions';
import { isProcessRef } from '../../../contracts/processes';
import { readBackendToolApprovalSettings } from '../../../contracts/toolApprovals';
import { parseResumePrepare } from '../resumeValues';
import { parseRosterReplacement } from '../rosterValues';

import { parseCrossTeamSend } from './crossTeamValues';
import { isBackendReviewOperation, parseBackendReviewPayload } from './reviewValues';
import { parseTeamLifecyclePayload } from './teamLifecycleValues';

import type {
  BackendLaunchConfiguration,
  BackendLaunchModelSelection,
} from '../../../contracts/launch';
import type {
  BackendOperationPayloads,
  BackendOperationRequest,
  BackendTaskRef,
} from '../../../contracts/operations';

export class InvalidBackendOperation extends Error {
  constructor() {
    super('Invalid backend operation');
  }
}

export function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new InvalidBackendOperation();
  return value as Record<string, unknown>;
}

/** Only own plain data crosses the interaction reply boundary. */
function interactionData(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const row = object(value, keys);
  const prototype = Object.getPrototypeOf(row);
  const descriptors = Object.getOwnPropertyDescriptors(row);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(descriptors).some(
      (key) => typeof key !== 'string' || !('value' in descriptors[key]!)
    )
  )
    throw new InvalidBackendOperation();
  return Object.fromEntries(Object.entries(descriptors).map(([key, entry]) => [key, entry.value]));
}

export function text(value: unknown, max = 256): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > max ||
    value.includes('\0')
  ) {
    throw new InvalidBackendOperation();
  }
  return value;
}

function description(value: unknown): string {
  if (value === '') return '';
  return text(value, 200_000);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new InvalidBackendOperation();
  return value.map((entry) => text(entry));
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

function launchConfiguration(value: unknown): BackendLaunchConfiguration {
  const source = object(value, ['members']);
  if (!Array.isArray(source.members) || source.members.length < 1 || source.members.length > 256)
    throw new InvalidBackendOperation();
  const members = source.members.map((value) => {
    const row = object(value, [
      'memberId',
      'model',
      'effort',
      'fastMode',
      'permissions',
      'context',
    ]);
    const result: BackendLaunchConfiguration['members'][number] = { memberId: text(row.memberId) };
    if (row.model !== undefined) result.model = text(row.model);
    if (row.effort !== undefined) {
      if (
        typeof row.effort !== 'string' ||
        !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(row.effort)
      )
        throw new InvalidBackendOperation();
      result.effort = row.effort as NonNullable<typeof result.effort>;
    }
    if (row.fastMode !== undefined) {
      if (typeof row.fastMode !== 'boolean') throw new InvalidBackendOperation();
      result.fastMode = row.fastMode;
    }
    if (row.permissions !== undefined) {
      if (row.permissions !== 'manual' && row.permissions !== 'bypass')
        throw new InvalidBackendOperation();
      result.permissions = row.permissions;
    }
    if (row.context !== undefined) {
      if (row.context !== 'model-default' && row.context !== 'one-million')
        throw new InvalidBackendOperation();
      result.context = row.context;
    }
    return result;
  });
  if (new Set(members.map((member) => member.memberId)).size !== members.length)
    throw new InvalidBackendOperation();
  return { members };
}

function payload(
  operation: string,
  value: unknown
): BackendOperationPayloads[keyof BackendOperationPayloads] {
  if (isBackendReviewOperation(operation)) return parseBackendReviewPayload(operation, value);
  switch (operation) {
    case 'process.list':
    case 'process.pending.read':
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
    case 'crossTeam.lookup':
    case 'crossTeam.outbox.read':
      object(value, []);
      return {};
    case 'team.lead.activity.read':
    case 'team.lead.context.read':
      object(value, []);
      return {};
    case 'team.activity.logs.read': {
      const p = object(value, ['memberName', 'taskId']);
      if (Object.hasOwn(p, 'memberName') === Object.hasOwn(p, 'taskId'))
        throw new InvalidBackendOperation();
      return Object.hasOwn(p, 'memberName')
        ? { memberName: text(p.memberName) }
        : { taskId: text(p.taskId) };
    }
    case 'team.activity.stats.read': {
      const p = object(value, ['memberName']);
      return { memberName: text(p.memberName) };
    }
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
    case 'team.lifecycle.read':
    case 'team.lifecycle.change':
    case 'team.lifecycle.lookup':
    case 'team.lifecycle.purge':
    case 'team.lifecycle.purge.lookup':
    case 'team.queue.read':
    case 'team.queue.discard':
    case 'team.queue.lookup':
      return parseTeamLifecyclePayload(operation, value);
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
    case 'team.member.action.prepare':
    case 'team.member.action.execute':
      return readMemberActionRequest(value);
    case 'team.member.actions.read':
      return readMemberActionQuery(value);
    case 'team.member.action.lookup':
      return readMemberActionLookup(value);
    case 'team.launch.resume.prepare':
      return parseResumePrepare(value);
    case 'team.launch.restorations.read': {
      const p = object(value, ['launchId']);
      return { launchId: text(p.launchId) };
    }
    case 'team.launch.model.configuration.read':
    case 'team.roster.read':
      object(value, []);
      return {};
    case 'team.roster.lookup': {
      const p = object(value, ['expected']);
      return !Object.hasOwn(p, 'expected') ? {} : { expected: parseRosterReplacement(p.expected) };
    }
    case 'team.roster.replace':
      return parseRosterReplacement(value);
    case 'team.launch.probe.start':
    case 'team.launch.probe.read':
    case 'team.launch.probe.cancel': {
      const p = object(value, [
        'launchId',
        'rosterRevision',
        'memberId',
        'model',
        'effort',
        'context',
        'draft',
      ]);
      const member = launchConfiguration({
        members: [
          {
            memberId: p.memberId,
            model: p.model,
            ...(p.effort === undefined ? {} : { effort: p.effort }),
            ...(p.context === undefined ? {} : { context: p.context }),
          },
        ],
      }).members[0];
      if (/[\r\n]/u.test(member.model!)) throw new InvalidBackendOperation();
      let draft: BackendLaunchModelSelection['draft'];
      if (p.draft !== undefined) {
        const raw = object(p.draft, ['providerId', 'target', 'workspace']);
        if (!['anthropic', 'codex', 'opencode'].includes(String(raw.providerId)))
          throw new InvalidBackendOperation();
        const target = object(raw.target, ['kind', 'name', 'originalName']);
        if (target.kind !== 'lead' && target.kind !== 'member') throw new InvalidBackendOperation();
        if (
          target.kind === 'lead' &&
          (target.name !== undefined || target.originalName !== undefined)
        )
          throw new InvalidBackendOperation();
        const workspace = raw.workspace === undefined ? undefined : text(raw.workspace, 8192);
        if (workspace !== undefined && (!workspace.startsWith('/') || /[\r\n]/u.test(workspace)))
          throw new InvalidBackendOperation();
        draft = {
          providerId: raw.providerId as NonNullable<typeof draft>['providerId'],
          target:
            target.kind === 'lead'
              ? { kind: 'lead' }
              : {
                  kind: 'member',
                  name: text(target.name),
                  ...(target.originalName === undefined
                    ? {}
                    : { originalName: text(target.originalName) }),
                },
          ...(workspace === undefined ? {} : { workspace }),
        };
      }
      const selection: BackendLaunchModelSelection = {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        memberId: member.memberId,
        model: member.model!,
        ...(draft === undefined ? {} : { draft }),
        ...(member.effort === undefined ? {} : { effort: member.effort }),
        ...(member.context === undefined ? {} : { context: member.context }),
      };
      return selection;
    }
    case 'team.launch.read':
    case 'team.launch.configuration.read': {
      const p = object(value, ['launchId']);
      return p.launchId === undefined ? {} : { launchId: text(p.launchId) };
    }
    case 'team.launch.capture': {
      const p = object(value, ['rosterCommandId']);
      return { rosterCommandId: text(p.rosterCommandId) };
    }
    case 'team.launch.start': {
      const p = object(value, ['launchId', 'rosterRevision', 'configuration']);
      return {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        ...(p.configuration === undefined
          ? {}
          : { configuration: launchConfiguration(p.configuration) }),
      };
    }
    case 'team.launch.retry': {
      const p = object(value, ['launchId', 'rosterRevision', 'attemptId', 'memberIds']);
      const memberIds = stringArray(p.memberIds);
      if (!memberIds.length || new Set(memberIds).size !== memberIds.length)
        throw new InvalidBackendOperation();
      return {
        launchId: text(p.launchId),
        rosterRevision: text(p.rosterRevision),
        attemptId: text(p.attemptId),
        memberIds,
      };
    }
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
    case 'team.snapshot':
    case 'tasks.list':
    case 'command.lookup':
      object(value, []);
      return {};
    case 'runtime.read':
    case 'runtime.open':
    case 'runtime.dispatch':
    case 'runtime.stop':
    case 'runtime.reconcile': {
      const p = object(value, ['memberId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'team.changes.read': {
      const p = object(value, ['cursor']);
      return p.cursor === undefined ? {} : { cursor: text(p.cursor, 128) };
    }
    case 'runtime.activity.snapshot': {
      const p = object(value, ['memberId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.restore': {
      const p = object(value, ['memberId', 'reference', 'expectedGeneration', 'resumeId']);
      const reference = text(p.reference, 68);
      if (!/^cp1-[a-f0-9]{64}$/.test(reference)) throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        reference,
        expectedGeneration: text(p.expectedGeneration),
        ...(p.resumeId === undefined ? {} : { resumeId: text(p.resumeId) }),
      };
    }
    case 'runtime.checkpoints.read': {
      const p = object(value, ['memberId', 'expectedGeneration']);
      return { memberId: text(p.memberId), expectedGeneration: text(p.expectedGeneration) };
    }
    case 'runtime.activity.feed': {
      const p = object(value, ['memberId', 'cursor', 'expectedGeneration']);
      const cursor = text(p.cursor, 1024);
      if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        cursor,
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.interrupt': {
      const p = object(value, ['memberId', 'inputId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        inputId: text(p.inputId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.checkpoint': {
      const p = object(value, ['memberId', 'checkpointId', 'expectedGeneration']);
      return {
        memberId: text(p.memberId),
        checkpointId: text(p.checkpointId),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
      };
    }
    case 'runtime.approval.settings.read':
      object(value, []);
      return {};
    case 'runtime.approval.settings.update': {
      const p = object(value, ['settings']);
      return { settings: readBackendToolApprovalSettings(p.settings) };
    }
    case 'runtime.interaction.preview.read': {
      const p = object(value, [
        'memberId',
        'expectedGeneration',
        'inputId',
        'interactionRef',
        'offset',
        'expectedSha256',
        'expectedSource',
      ]);
      if (
        !Number.isSafeInteger(p.offset) ||
        (p.offset as number) < 0 ||
        (p.offset as number) > 2 * 1024 * 1024 ||
        [p.expectedSha256, p.expectedSource].some(
          (value) =>
            value !== undefined && (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
        ) ||
        ((p.offset as number) > 0 &&
          (p.expectedSha256 === undefined || p.expectedSource === undefined))
      )
        throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        expectedGeneration: text(p.expectedGeneration),
        inputId: text(p.inputId),
        interactionRef: text(p.interactionRef),
        offset: p.offset as number,
        ...(p.expectedSha256 === undefined ? {} : { expectedSha256: p.expectedSha256 as string }),
        ...(p.expectedSource === undefined ? {} : { expectedSource: p.expectedSource as string }),
      };
    }
    case 'runtime.interaction': {
      const p = object(value, [
        'memberId',
        'inputId',
        'interactionRef',
        'reply',
        'expectedGeneration',
      ]);
      const reply = interactionData(p.reply, ['kind', 'decision', 'answers']);
      let captured: BackendOperationPayloads['runtime.interaction']['reply'];
      if (reply.kind === 'permission') {
        object(p.reply, ['kind', 'decision']);
        if (reply.decision !== 'allow' && reply.decision !== 'deny')
          throw new InvalidBackendOperation();
        captured = { kind: 'permission', decision: reply.decision };
      } else if (reply.kind === 'question' && reply.decision === 'deny') {
        interactionData(p.reply, ['kind', 'decision']);
        captured = { kind: 'question', decision: 'deny' };
      } else if (reply.kind === 'question') {
        interactionData(p.reply, ['kind', 'answers']);
        if (
          !reply.answers ||
          typeof reply.answers !== 'object' ||
          Array.isArray(reply.answers) ||
          Object.keys(reply.answers).length > 100
        )
          throw new InvalidBackendOperation();
        const answerData = interactionData(reply.answers, Object.keys(reply.answers));
        const answers = Object.fromEntries(
          Object.entries(answerData).map(([key, answer]) => [text(key), text(answer, 20_000)])
        );
        captured = { kind: 'question', answers };
      } else throw new InvalidBackendOperation();
      return {
        memberId: text(p.memberId),
        inputId: text(p.inputId),
        interactionRef: text(p.interactionRef),
        ...(p.expectedGeneration === undefined
          ? {}
          : { expectedGeneration: text(p.expectedGeneration) }),
        reply: captured,
      };
    }
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
