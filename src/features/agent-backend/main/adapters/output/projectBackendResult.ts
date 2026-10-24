import { isDeepStrictEqual } from 'node:util';

import { attachmentReferenceSchema } from '@agent-teams/legacy-agent-host/attachments/contracts';

import {
  readBackendAttachmentChunk,
  readBackendMessageAttachments,
} from '../../../contracts/attachments';
import { isBackendReviewOperation } from '../input/reviewValues';
import { projectResumePreparation, resumeChoices } from '../resumeValues';

import { projectAttachmentMetadata } from './projectAttachmentMetadata';
import { projectCrossTeamResult } from './projectCrossTeamResult';
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
import { projectProcessResult } from './projectProcessResult';
import { projectReviewResult } from './projectReviewResult';
import { projectRosterConfiguration, projectRosterReceipt } from './projectRoster';
import { projectTaskHistory } from './projectTaskHistory';
import { projectTeamActivityLogs, projectTeamActivityStats } from './projectTeamActivity';
import { projectTeamChanges } from './projectTeamChanges';
import { projectTeamLifecycle } from './projectTeamLifecycle';
import { projectTeamSnapshot } from './projectTeamSnapshot';
import { projectInteractionPreview, projectToolApprovalSettings } from './projectToolApproval';

import type {
  BackendActivityData,
  BackendActivityEvent,
  BackendActivityFeed,
  BackendActivityGap,
  BackendActivitySnapshot,
  BackendActivityState,
  BackendActivityValue,
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

function row(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid host projection');
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Invalid host projection');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid host projection');
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (!values.includes(value as T)) throw new Error('Invalid host projection');
  return value as T;
}
function array<T>(value: unknown, project: (entry: unknown) => T): T[] {
  if (!Array.isArray(value)) throw new Error('Invalid host projection');
  return value.map(project);
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
      'approved',
      'needsFix',
    ] as const);
  if (source.needsClarification !== undefined)
    result.needsClarification = oneOf(source.needsClarification, ['lead', 'user'] as const);
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
  if (source.result !== undefined) {
    const applied = row(source.result);
    if (operation === 'task.board.order') {
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

const activityGapReasons = [
  'retention',
  'incarnation',
  'cursor',
  'oversized',
  'unsupported',
  'unattributed',
  'storage',
  'state-unpublished',
] as const;
const activityCodes = [
  'invalid-config',
  'unavailable',
  'dependency-unavailable',
  'backpressure',
  'stale',
  'unsupported',
  'checkpoint-incompatible',
  'checkpoint-missing',
  'provider-failure',
  'output-limit',
  'unknown',
  'unknown-event',
  'iterator-ended',
] as const;
const runtimeDiagnostics = [
  'open-unknown',
  'observe-ended',
  'observe-failed',
  'readiness-unavailable',
  'close-unknown',
] as const;
function finite(value: unknown, integer = false): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    (integer && !Number.isSafeInteger(value))
  )
    throw new Error('Invalid activity number');
  return value;
}
function activityText(value: unknown, max = 1024): string {
  const result = string(value);
  if (result.length > max || result.includes('\0')) throw new Error('Invalid activity text');
  return result;
}
function content(
  value: unknown,
  depth = 0,
  budget = { nodes: 1024, bytes: 16 * 1024 }
): BackendActivityValue {
  if (--budget.nodes < 0 || depth > 8) throw new Error('Invalid activity content');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    budget.bytes -= Buffer.byteLength(value);
    if (budget.bytes < 0) throw new Error('Invalid activity content');
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => content(entry, depth + 1, budget));
  const source = row(value);
  return Object.fromEntries(
    Object.entries(source).map(([key, entry]) => {
      budget.bytes -= Buffer.byteLength(key);
      if (budget.bytes < 0) throw new Error('Invalid activity content');
      return [key, content(entry, depth + 1, budget)];
    })
  );
}
function activityState(value: unknown): BackendActivityState {
  const source = row(value);
  const control = source.control === null ? null : row(source.control);
  return {
    phase: oneOf(source.phase, ['unopened', 'opening', 'allocated', 'closing', 'closed', 'held']),
    custody: oneOf(source.custody, ['owned', 'released', 'unknown']),
    sealed: boolean(source.sealed),
    nativeReady: boolean(source.nativeReady),
    queuedInputs: finite(source.queuedInputs, true),
    activeInputs: finite(source.activeInputs, true),
    partial: boolean(source.partial),
    diagnostic: source.diagnostic === null ? null : oneOf(source.diagnostic, runtimeDiagnostics),
    control: control
      ? {
          inputId: activityText(control.inputId),
          phase: oneOf(control.phase, ['pending', 'unknown'] as const),
        }
      : null,
    interactions: array(source.interactions, (entry) => {
      const interaction = row(entry);
      return {
        interactionRef: activityText(interaction.interactionRef),
        inputId: activityText(interaction.inputId),
        kind: oneOf(interaction.kind, ['permission', 'question'] as const),
        expiresAt: finite(interaction.expiresAt),
        phase: oneOf(interaction.phase, ['pending', 'responding', 'resolved', 'unknown']),
      };
    }),
  };
}
function activityData(value: unknown, nested = false): BackendActivityData {
  const data = row(value);
  switch (data.kind) {
    case 'subagent': {
      if (nested) throw new Error('Nested subagent activity');
      const phase = oneOf(data.phase, [
        'started',
        'completed',
        'failed',
        'stopped',
        'fact',
        'interaction',
        'usage',
        'gap',
      ] as const);
      const alias = (value: unknown, prefix: string) => {
        const result = activityText(value);
        if (!new RegExp(`^${prefix}-[a-f0-9]{64}$`).test(result))
          throw new Error('Invalid subagent alias');
        return result;
      };
      const result: Extract<BackendActivityData, { kind: 'subagent' }> = {
        kind: 'subagent',
        phase,
        ...(data.childId === undefined && phase === 'gap'
          ? {}
          : { childId: alias(data.childId, 'child') }),
        ...(data.parentToolRef === undefined && phase === 'gap'
          ? {}
          : { parentToolRef: alias(data.parentToolRef, 'tool') }),
      };
      if (phase === 'fact' || phase === 'interaction') {
        const fact = activityData(data.fact, true);
        if (
          fact.kind === 'state' ||
          fact.kind === 'subagent' ||
          fact.kind === 'usage' ||
          fact.kind === 'result' ||
          (phase === 'interaction') !== (fact.kind === 'interaction')
        )
          throw new Error('Invalid subagent fact');
        result.fact = fact;
      }
      if (phase === 'usage')
        for (const key of ['childTotalTokens', 'childToolUses', 'childDurationMs'] as const)
          if (data[key] !== undefined) result[key] = finite(data[key], true);
      if (phase === 'gap')
        result.reason = oneOf(data.reason, ['unattributed', 'stale', 'conflict', 'limit'] as const);
      return result;
    }
    case 'text':
      return {
        kind: 'text',
        messageRef: activityText(data.messageRef),
        block: finite(data.block, true),
        text: activityText(data.text, 24 * 1024),
        phase: oneOf(data.phase, ['snapshot', 'complete'] as const),
      };
    case 'tool':
      return {
        kind: 'tool',
        messageRef: activityText(data.messageRef),
        toolRef: activityText(data.toolRef),
        name: activityText(data.name),
        input: content(data.input),
      };
    case 'tool-result':
      return {
        kind: 'tool-result',
        toolRef: activityText(data.toolRef),
        content: content(data.content),
        isError: boolean(data.isError),
      };
    case 'usage': {
      const usage: Extract<BackendActivityData, { kind: 'usage' }> = { kind: 'usage' };
      for (const key of ['inputTokens', 'outputTokens', 'cumulativeCostUsd'] as const)
        if (data[key] !== undefined) usage[key] = finite(data[key], key !== 'cumulativeCostUsd');
      return usage;
    }
    case 'compaction':
      return {
        kind: 'compaction',
        sourceRef: activityText(data.sourceRef),
        reason: oneOf(data.reason, ['manual', 'automatic', 'unknown'] as const),
      };
    case 'result':
      return {
        kind: 'result',
        outcome: oneOf(data.outcome, ['succeeded', 'failed', 'cancelled', 'unknown'] as const),
        ...(data.code === undefined ? {} : { code: oneOf(data.code, activityCodes) }),
      };
    case 'interaction': {
      const request = row(data.request);
      const common = {
        kind: 'interaction' as const,
        interactionRef: activityText(data.interactionRef),
      };
      if (request.kind === 'permission')
        return {
          ...common,
          request: {
            kind: 'permission',
            tool: activityText(request.tool),
            input: content(request.input),
          },
        };
      if (request.kind === 'question')
        return { ...common, request: { kind: 'question', questions: content(request.questions) } };
      throw new Error('Invalid activity interaction');
    }
    case 'diagnostic':
      return { kind: 'diagnostic', code: oneOf(data.code, activityCodes) };
    case 'gap':
      return { kind: 'gap', reason: oneOf(data.reason, activityGapReasons) };
    case 'state':
      return { kind: 'state', state: activityState(data.state) };
    default:
      throw new Error('Invalid activity event');
  }
}
function activityEvent(value: unknown): BackendActivityEvent {
  const source = row(value);
  return {
    sequence: finite(source.sequence, true),
    eventId: activityText(source.eventId),
    ...(source.inputId === undefined ? {} : { inputId: activityText(source.inputId) }),
    data: activityData(source.data),
  };
}
function activity(
  value: unknown,
  request: BackendOperationRequest
): BackendActivityFeed | BackendActivitySnapshot {
  const source = row(value);
  if (!('memberId' in request.payload) || source.memberId !== request.payload.memberId)
    throw new Error('Wrong activity member');
  const snapshot = request.operation === 'runtime.activity.snapshot';
  if (Buffer.byteLength(JSON.stringify(source)) > (snapshot ? 256 : 128) * 1024)
    throw new Error('Oversized activity result');
  const cursor = activityText(source.cursor);
  if (!/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('Invalid activity cursor');
  const result: BackendActivityFeed = {
    memberId: activityText(source.memberId, 256),
    cursor,
    retainedFrom: finite(source.retainedFrom, true),
    events: array(source.events, activityEvent),
    hasMore: boolean(source.hasMore),
    ...(source.gap === undefined
      ? {}
      : {
          gap: {
            reason: oneOf(row(source.gap).reason, activityGapReasons),
          } satisfies BackendActivityGap,
        }),
  };
  if (result.events.length > 64) throw new Error('Oversized activity page');
  if (!snapshot) return result;
  const latest = row(source.latest);
  return {
    ...result,
    state: source.state === null ? null : activityState(source.state),
    latest: {
      text: array(latest.text, activityEvent),
      tools: array(latest.tools, activityEvent),
      usage: array(latest.usage, activityEvent),
      interactions: array(latest.interactions, activityEvent),
      compaction: latest.compaction === null ? null : activityEvent(latest.compaction),
      ...(latest.subagents === undefined
        ? {}
        : { subagents: array(latest.subagents, activityEvent) }),
    },
  };
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
  if (request.operation === 'team.snapshot')
    return { ok: true, value: projectTeamSnapshot(source.value) };
  if (request.operation === 'task.get') return { ok: true, value: task(source.value) };
  if (request.operation === 'tasks.list') return { ok: true, value: array(source.value, task) };
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
