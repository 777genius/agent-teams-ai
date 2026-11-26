import { isDeepStrictEqual } from 'node:util';

import { attachmentReferenceSchema } from '@agent-teams/legacy-agent-host/attachments/contracts';
import { isGroupUuid } from '@agent-teams/legacy-agent-host/group-chats/policy';
import {
  readGroupCommand,
  readGroupList,
  readGroupReaction,
} from '@agent-teams/legacy-agent-host/group-chats/public-values';

import {
  readBackendAttachmentChunk,
  readBackendMessageAttachments,
} from '../../../contracts/attachments';
import { isBackendReviewOperation } from '../input/reviewValues';
import { projectResumePreparation, resumeChoices } from '../resumeValues';

import { projectAttachmentMetadata } from './projectAttachmentMetadata';
import { projectCrossTeamResult } from './projectCrossTeamResult';
import { projectDeletedTasks } from './projectDeletedTasks';
import {
  projectLaunchConfiguration,
  projectLaunchModelConfiguration,
} from './projectLaunchConfiguration';
import { projectLaunchModelProbe } from './projectLaunchModelProbe';
import { projectLaunchRestorations } from './projectLaunchRestorations';
import { projectLaunchSnapshot } from './projectLaunchSnapshot';
import { projectLeadObservation } from './projectLeadObservation';
import { isMemberActionRequest, projectMemberActionResult } from './projectMemberActionResult';
import { projectMemberCheckpoints } from './projectMemberCheckpoints';
import { projectNativeSessionCommands } from './projectNativeSessionCommands';
import { projectProcessResult } from './projectProcessResult';
import { projectProjectContext, projectProjectLaunchSource } from './projectProjectContext';
import { projectReviewFlow } from './projectReviewFlow';
import { projectReviewResult } from './projectReviewResult';
import { projectRosterConfiguration, projectRosterReceipt } from './projectRoster';
import {
  activity,
  activityEvent,
  array,
  boolean,
  oneOf,
  row,
  string,
} from './projectRuntimeActivity';
import { projectTaskHistory } from './projectTaskHistory';
import { projectTaskSubmission } from './projectTaskSubmission';
import { projectTeamActivityLogs, projectTeamActivityStats } from './projectTeamActivity';
import { projectTeamChanges } from './projectTeamChanges';
import { projectTeamLifecycle } from './projectTeamLifecycle';
import { projectTeamMessagesPage } from './projectTeamMessagesPage';
import { projectTeamSnapshot } from './projectTeamSnapshot';
import { projectInteractionPreview, projectToolApprovalSettings } from './projectToolApproval';

import type {
  BackendCheckpoint,
  BackendCommandReceipt,
  BackendComment,
  BackendOperationRequest,
  BackendOperationResult,
  BackendRuntimeSnapshot,
  BackendTask,
  BackendTaskRef,
} from '../../../contracts/operations';
import type { BackendReviewOperation } from '../../../contracts/review';

function isReviewRequest(
  request: BackendOperationRequest
): request is Extract<BackendOperationRequest, { operation: BackendReviewOperation }> {
  return isBackendReviewOperation(request.operation);
}

function refs(value: unknown): BackendTaskRef[] {
  return array(value, (entry) => {
    const ref = row(entry);
    return {
      taskId: string(ref.taskId),
      displayId: string(ref.displayId),
      teamName: string(ref.teamName),
    };
  });
}
function optionalStrings(
  source: Record<string, unknown>,
  keys: readonly string[]
): Record<string, string> {
  return Object.fromEntries(
    keys.filter((key) => source[key] !== undefined).map((key) => [key, string(source[key])])
  );
}
function comment(value: unknown): BackendComment {
  const source = row(value);
  return {
    id: string(source.id),
    ...optionalStrings(source, ['author', 'text', 'createdAt', 'type']),
    ...(source.taskRefs === undefined ? {} : { taskRefs: refs(source.taskRefs) }),
    ...(source.attachments === undefined
      ? {}
      : { attachments: projectAttachmentMetadata(source.attachments) }),
  };
}
function task(value: unknown): BackendTask {
  const source = row(value);
  const result: BackendTask = {
    id: string(source.id),
    status: string(source.status),
    ...optionalStrings(source, ['subject', 'description', 'displayId', 'owner', 'prompt']),
  };
  for (const key of ['blocks', 'blockedBy', 'related'] as const) {
    if (source[key] !== undefined) result[key] = array(source[key], string);
  }
  if (source.historyEvents !== undefined)
    result.historyEvents = projectTaskHistory(source.historyEvents);
  if (source.reviewState !== undefined)
    result.reviewState = oneOf(source.reviewState, [
      'none',
      'review',
      'reviewed',
      'approved',
      'needsFix',
    ] as const);
  if (source.clarificationRequestedAt !== undefined)
    result.clarificationRequestedAt = string(source.clarificationRequestedAt);
  if (source.clarificationRequestId !== undefined)
    result.clarificationRequestId = string(source.clarificationRequestId);
  if (source.needsClarification !== undefined)
    result.needsClarification = oneOf(source.needsClarification, ['lead', 'user'] as const);
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
  return result;
}
function receipt(value: unknown, request: BackendOperationRequest): BackendCommandReceipt {
  const source = row(value);
  const operation = oneOf(row(source.command).operation, [
    'task.create',
    'task.update',
    'task.assign',
    'task.lifecycle',
    'task.start',
    'task.comment',
    'task.attachment.add',
    'task.attachment.remove',
    'task.review',
    'task.board.clear',
    'task.board.order',
    'task.board.review-flow',
    'task.relationship',
    'task.clarification',
    'message.send',
  ] as const);
  if (
    source.commandId !== request.commandId ||
    (request.operation !== 'command.lookup' && operation !== request.operation)
  )
    throw new Error('Wrong receipt');
  const result: BackendCommandReceipt = {
    commandId: request.commandId,
    operation,
    phase: oneOf(source.phase, ['prepared', 'applying', 'completed', 'rejected', 'held'] as const),
  };
  if (operation === 'task.create' || operation === 'task.comment')
    Object.assign(result, projectTaskSubmission(source, request));
  if (result.taskSubmissionNoEffect) return result;
  if (source.result !== undefined) {
    const applied = row(source.result);
    if (operation === 'task.board.order' || operation === 'task.board.review-flow') {
      string(applied.teamName);
      array(applied.reviewers, string);
      for (const value of Object.values(row(applied.tasks)))
        oneOf(row(value).column, ['review', 'approved']);
      if (applied.columnOrder !== undefined) {
        for (const [column, ids] of Object.entries(row(applied.columnOrder))) {
          oneOf(column, ['todo', 'in_progress', 'done', 'review', 'approved']);
          array(ids, string);
        }
      }
    } else if (operation === 'message.send') {
      result.messageId = string(applied.messageId);
      if (
        request.operation === 'message.send' &&
        request.payload.messageId !== undefined &&
        result.messageId !== request.payload.messageId
      )
        throw new Error('Wrong message identity');
      if (applied.deliveryId !== undefined) result.deliveryId = string(applied.deliveryId);
    } else if (operation === 'task.start') {
      result.task = task(applied.task);
      result.notifiedOwner = boolean(applied.notifiedOwner);
    } else if (operation === 'task.comment') {
      if (applied.task !== undefined) result.task = task(applied.task);
      result.comment = comment(applied.comment);
    } else result.task = task(applied);
  }
  return result;
}
function runtime(value: unknown, request: BackendOperationRequest): BackendRuntimeSnapshot {
  const source = row(value);
  if (!('memberId' in request.payload) || source.memberId !== request.payload.memberId)
    throw new Error('Wrong member');
  const result: BackendRuntimeSnapshot = {
    memberId: string(source.memberId),
    ...(source.generation === undefined ? {} : { generation: string(source.generation) }),
    phase: oneOf(source.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    sealed: boolean(source.sealed),
    custody: oneOf(source.custody, ['owned', 'released', 'unknown']),
    nativeReady: boolean(source.nativeReady),
    attached: boolean(source.attached),
    inputs: array(source.inputs, (entry) => {
      const input = row(entry);
      return {
        inputId: string(input.inputId),
        phase: oneOf(input.phase, [
          'admitted',
          'claimed',
          'consumed',
          'terminal',
          'cancelled',
          'rejected',
          'not-sent',
          'unknown',
        ]),
        ...(input.terminal === undefined
          ? {}
          : { terminal: oneOf(input.terminal, ['succeeded', 'failed', 'cancelled'] as const) }),
      };
    }),
    interactions: array(source.interactions, (entry) => {
      const interaction = row(entry);
      if (typeof interaction.expiresAt !== 'number' || !Number.isFinite(interaction.expiresAt))
        throw new Error('Invalid expiry');
      return {
        interactionRef: string(interaction.interactionRef),
        inputId: string(interaction.inputId),
        kind: oneOf(interaction.kind, ['permission', 'question'] as const),
        expiresAt: interaction.expiresAt,
        phase: oneOf(interaction.phase, ['pending', 'responding', 'resolved', 'unknown']),
      };
    }),
  };
  if (request.operation === 'runtime.read' && request.payload.nativePromptProof !== undefined)
    result.nativePromptCurrent = boolean(source.nativePromptCurrent);
  // Ordinary Runtime reads must never project private suggestion provenance.
  if (source.sessionCommands !== undefined)
    result.sessionCommands = projectNativeSessionCommands(source.sessionCommands, result);
  if (source.attachmentCapabilities !== undefined) {
    if (
      !result.generation ||
      !result.attached ||
      !result.nativeReady ||
      result.sealed ||
      result.phase !== 'allocated' ||
      result.custody !== 'owned'
    )
      throw new Error('Inactive native attachment capability');
    const capabilities = row(source.attachmentCapabilities);
    result.attachmentCapabilities = {
      images: boolean(capabilities.images),
      documents: boolean(capabilities.documents),
      textFiles: boolean(capabilities.textFiles),
    };
    if (capabilities.nativeMedia !== undefined) {
      const transport = row(capabilities.nativeMedia);
      const mimeTypes = array(transport.mimeTypes, (value) =>
        oneOf(value, [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
        ] as const)
      );
      if (
        transport.revision !== 'opencode-2.1.4-native-media-v1' ||
        transport.videos !== false ||
        new Set(mimeTypes).size !== mimeTypes.length ||
        mimeTypes.length > 5 ||
        mimeTypes.some((mime) => mime.startsWith('image/')) !==
          result.attachmentCapabilities.images ||
        mimeTypes.includes('application/pdf') !== result.attachmentCapabilities.documents ||
        !Number.isSafeInteger(transport.maxBytes) ||
        Number(transport.maxBytes) < 1 ||
        Number(transport.maxBytes) > 4 * 1024 * 1024 ||
        !Number.isSafeInteger(transport.maxCount) ||
        Number(transport.maxCount) < 1 ||
        Number(transport.maxCount) > 5 ||
        !Number.isSafeInteger(transport.maxTotalBytes) ||
        Number(transport.maxTotalBytes) < 1 ||
        Number(transport.maxTotalBytes) > 8 * 1024 * 1024
      ) {
        throw new Error('Invalid native media transport capability');
      }
      result.attachmentCapabilities.nativeMedia = {
        revision: transport.revision,
        mimeTypes,
        maxBytes: Number(transport.maxBytes),
        maxCount: Number(transport.maxCount),
        maxTotalBytes: Number(transport.maxTotalBytes),
        videos: false,
      };
    }
  }
  if (source.diagnostic !== undefined)
    result.diagnostic = oneOf(source.diagnostic, [
      'open-unknown',
      'observe-ended',
      'observe-failed',
      'readiness-unavailable',
      'close-unknown',
    ]);
  return result;
}
function checkpoint(value: unknown, request: BackendOperationRequest): BackendCheckpoint {
  const source = row(value);
  if (
    request.operation !== 'runtime.checkpoint' ||
    source.checkpointId !== request.payload.checkpointId
  )
    throw new Error('Wrong checkpoint');
  const result: BackendCheckpoint = {
    checkpointId: string(source.checkpointId),
    status: oneOf(source.status, ['published', 'unsupported', 'held']),
  };
  if (source.reference !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(string(source.reference)))
      throw new Error('Invalid reference');
    result.reference = string(source.reference);
  }
  return result;
}

/** Allowlist response projection; raw receipts/config/native identities never reach transports. */
export function projectBackendResult(
  request: BackendOperationRequest,
  raw: unknown
): BackendOperationResult {
  const source = row(raw);
  if (source.ok === false)
    return {
      ok: false,
      code: oneOf(source.code, ['invalid', 'conflict', 'forbidden', 'hold', 'busy']),
      outcome: oneOf(source.outcome, ['not-dispatched', 'rejected', 'unknown']),
    };
  if (source.ok !== true) throw new Error('Invalid result');
  if (
    request.operation === 'crossTeam.send' ||
    request.operation === 'crossTeam.lookup' ||
    request.operation === 'crossTeam.outbox.read'
  )
    return {
      ok: true,
      value: projectCrossTeamResult(
        request.operation,
        source.value,
        request.commandId,
        request.operation === 'crossTeam.send' ? request.payload : undefined
      ),
    };
  if (request.operation.startsWith('group.'))
    return {
      ok: true,
      value:
        request.operation === 'group.list'
          ? readGroupList(source.value)
          : request.operation === 'group.reaction.read'
            ? readGroupReaction(source.value)
            : readGroupCommand(source.value, request.commandId),
    };
  if (request.operation.startsWith('process.'))
    return { ok: true, value: projectProcessResult(request, source.value) };
  if (isReviewRequest(request))
    return {
      ok: true,
      value: projectReviewResult(
        request.operation,
        request.payload,
        source.value,
        request.commandId
      ),
    };
  if (
    request.operation === 'team.lead.activity.read' ||
    request.operation === 'team.lead.context.read'
  )
    return { ok: true, value: projectLeadObservation(source.value, request.operation) };
  if (request.operation === 'team.activity.logs.read')
    return {
      ok: true,
      value: projectTeamActivityLogs(source.value, activityEvent, request.payload),
    };
  if (request.operation === 'team.activity.stats.read')
    return { ok: true, value: projectTeamActivityStats(source.value, request.payload.memberName) };
  if (
    request.operation.startsWith('team.lifecycle.') ||
    request.operation.startsWith('team.queue.')
  )
    return {
      ok: true,
      value: projectTeamLifecycle(source.value, request.operation, request.commandId),
    };
  if (request.operation === 'team.roster.read')
    return { ok: true, value: projectRosterConfiguration(source.value) };
  if (
    request.operation === 'team.project-context.read' ||
    request.operation === 'team.project-context.prepare'
  )
    return { ok: true, value: projectProjectContext(source.value) };
  if (request.operation === 'team.project-context.launch-source.read')
    return { ok: true, value: projectProjectLaunchSource(source.value) };
  if (request.operation === 'team.roster.replace' || request.operation === 'team.roster.lookup')
    return {
      ok: true,
      value: projectRosterReceipt(
        source.value,
        request.commandId,
        request.operation === 'team.roster.lookup'
      ),
    };
  if (request.operation === 'team.launch.model.configuration.read')
    return { ok: true, value: projectLaunchModelConfiguration(source.value) };
  if (request.operation.startsWith('team.launch.probe.'))
    return { ok: true, value: projectLaunchModelProbe(source.value, request) };
  if (isMemberActionRequest(request))
    return { ok: true, value: projectMemberActionResult(source.value, request) };
  if (request.operation === 'team.launch.restorations.read')
    return { ok: true, value: projectLaunchRestorations(source.value, request) };
  if (request.operation === 'team.launch.resume.prepare') {
    const prepared = projectResumePreparation(source.value);
    const choices = prepared.members.map(
      ({ requested: _requested, refused: _refused, ...member }) => member
    );
    if (
      prepared.resumeId !== request.payload.resumeId ||
      prepared.rosterRevision !== request.payload.rosterRevision ||
      !isDeepStrictEqual(choices, resumeChoices(request.payload.members))
    )
      throw new Error('Wrong Resume preparation');
    return { ok: true, value: prepared };
  }
  if (
    request.operation === 'team.launch.configuration.read' ||
    request.operation === 'team.launch.capture'
  ) {
    const configuration = source.value === null ? null : projectLaunchConfiguration(source.value);
    if (request.operation === 'team.launch.capture' && !configuration)
      throw new Error('Missing captured launch');
    if (
      request.operation === 'team.launch.configuration.read' &&
      request.payload.launchId !== undefined &&
      configuration?.launch.launchId !== request.payload.launchId
    )
      throw new Error('Wrong retained launch');
    return {
      ok: true,
      value: configuration,
    };
  }
  if (request.operation.startsWith('team.launch.')) {
    if (source.value === null && request.operation === 'team.launch.read')
      return { ok: true, value: null };
    const launch = projectLaunchSnapshot(source.value);
    if (
      request.operation === 'team.launch.read' &&
      request.payload.launchId !== undefined &&
      launch.launchId !== request.payload.launchId
    )
      throw new Error('Wrong retained launch');
    if (request.operation !== 'team.launch.read' && 'launchId' in request.payload) {
      if (launch.launchId !== request.payload.launchId) throw new Error('Wrong launch selection');
      if (request.operation === 'team.launch.start' && request.payload.configuration) {
        const admitted = row(row(source.value).admission);
        const expected = request.payload.configuration.members.map(
          ({ memberId, ...configuration }) => ({ memberId, configuration })
        );
        if (
          launch.admission?.commandId !== request.commandId ||
          launch.admission.sourceRosterRevision !== request.payload.rosterRevision ||
          !isDeepStrictEqual(admitted.members, expected)
        )
          throw new Error('Wrong launch admission');
      } else if (launch.rosterRevision !== request.payload.rosterRevision)
        throw new Error('Wrong launch selection');
    }
    return { ok: true, value: launch };
  }
  if (request.operation === 'team.changes.read')
    return { ok: true, value: projectTeamChanges(source.value) };
  if (request.operation === 'attachment.upload') {
    const value = row(source.value);
    const end = request.payload.offset + Buffer.from(request.payload.base64, 'base64').length;
    if (
      value.nextOffset !== null &&
      (!Number.isSafeInteger(value.nextOffset) ||
        Number(value.nextOffset) < end ||
        Number(value.nextOffset) > request.payload.attachment.size)
    )
      throw new Error('Invalid upload offset');
    if (value.nextOffset === null) {
      const reference = attachmentReferenceSchema.parse(value.reference);
      if (
        reference.digest !== request.payload.digest ||
        reference.byteLength !== request.payload.attachment.size ||
        reference.mimeType !== request.payload.attachment.mimeType
      )
        throw new Error('Invalid upload reference');
      return { ok: true, value: { nextOffset: null, reference } };
    }
    if (value.reference !== undefined) throw new Error('Incomplete attachment');
    return { ok: true, value: { nextOffset: Number(value.nextOffset) } };
  }
  if (request.operation === 'message.attachments.read')
    return { ok: true, value: readBackendMessageAttachments(source.value) };
  if (
    request.operation === 'message.attachment.read' ||
    request.operation === 'task.attachment.read'
  )
    return { ok: true, value: readBackendAttachmentChunk(source.value, request.payload) };
  if (request.operation === 'team.review-flow.read')
    return { ok: true, value: projectReviewFlow(source.value) };
  if (request.operation === 'team.snapshot')
    return { ok: true, value: projectTeamSnapshot(source.value) };
  if (request.operation === 'team.messages.page')
    return { ok: true, value: projectTeamMessagesPage(source.value) };
  if (request.operation === 'task.get') return { ok: true, value: task(source.value) };
  if (request.operation === 'tasks.list')
    return {
      ok: true,
      value: request.payload.deleted
        ? projectDeletedTasks(source.value)
        : array(source.value, task),
    };
  if (request.operation === 'command.lookup' && source.value === null)
    return { ok: true, value: null };
  if (request.operation === 'runtime.checkpoint')
    return { ok: true, value: checkpoint(source.value, request) };
  if (request.operation === 'runtime.checkpoints.read')
    return { ok: true, value: projectMemberCheckpoints(source.value, request) };
  if (
    request.operation === 'runtime.activity.snapshot' ||
    request.operation === 'runtime.activity.feed'
  )
    return { ok: true, value: activity(source.value, request) };
  if (
    request.operation === 'runtime.approval.settings.read' ||
    request.operation === 'runtime.approval.settings.update'
  )
    return { ok: true, value: projectToolApprovalSettings(source.value) };
  if (request.operation === 'runtime.interaction.preview.read')
    return { ok: true, value: projectInteractionPreview(source.value, request.payload) };
  if (request.operation.startsWith('runtime.'))
    return { ok: true, value: runtime(source.value, request) };
  return { ok: true, value: receipt(source.value, request) };
}
