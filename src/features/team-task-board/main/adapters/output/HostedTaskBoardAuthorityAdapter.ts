import { parseCursor, parseRevision, parseTeamId } from '@shared/contracts/hosted';

import {
  HOSTED_TASK_BOARD_TRUNCATION_REASONS,
  type HostedTaskBoardItem,
  type HostedTaskBoardTruncationReason,
  type HostedTaskMutationCommand,
  type HostedTaskMutationReceipt,
  parseHostedTaskBoardSourceGeneration,
  parseHostedTaskId,
  type TaskId,
} from '../../../contracts/hosted';
import {
  HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS,
  measureHostedTaskBoardJsonBytes,
} from '../../../core/domain/models/HostedTaskBoardBudget';
import {
  isHostedTaskBoardDegradedReasons,
  normalizeHostedTaskBoardItems,
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskMutationCommand,
} from '../../../core/domain/policies/hostedTaskBoardPolicy';

import type {
  HostedTaskBoardPageSourcePort,
  HostedTaskBoardPageSourceRequest,
  HostedTaskBoardPageSourceResult,
  HostedTaskMutationAdmissionPort,
  HostedTaskMutationAdmissionResult,
} from '../../../core/application/ports/HostedTeamTaskBoardPorts';
import type {
  HostedTaskBoardAuthorityPort,
  HostedTaskBoardAuthorityReadWindowRequest,
} from '../../ports/HostedTaskBoardAuthorityPort';
import type { Cursor, QueryContext } from '@shared/contracts/hosted';

const MAX_RETRY_AFTER_MS = 60_000;
const CURSOR_PREFIX = 'cursor_';
const CONFLICT_REASONS = Object.freeze([
  'idempotency_mismatch',
  'relationship_conflict',
  'state_conflict',
] as const);

interface NormalizedReadRequest {
  readonly sourceRequest: HostedTaskBoardPageSourceRequest;
  readonly authorityRequest: HostedTaskBoardAuthorityReadWindowRequest;
}

interface UnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(value);
  return (
    ownKeys.length === keys.length &&
    ownKeys.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactOptionalKey(
  value: Record<PropertyKey, unknown>,
  requiredKeys: readonly string[],
  optionalKey: string
): boolean {
  const hasOptional = Object.hasOwn(value, optionalKey);
  return hasExactKeys(value, hasOptional ? [...requiredKeys, optionalKey] : requiredKeys);
}

function unavailable(retryAfterMs?: number): UnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function normalizeRetryAfterMs(value: unknown): number | null {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_RETRY_AFTER_MS
    ? (value as number)
    : null;
}

function parseCursorTaskId(value: unknown): { readonly cursor: Cursor; readonly taskId: TaskId } {
  const cursor = parseCursor(value);
  if (!cursor.startsWith(CURSOR_PREFIX)) {
    throw new TypeError('hosted-task-board-authority-cursor-invalid');
  }
  const taskId = parseHostedTaskId(cursor.slice(CURSOR_PREFIX.length));
  if (`${CURSOR_PREFIX}${taskId}` !== cursor) {
    throw new TypeError('hosted-task-board-authority-cursor-invalid');
  }
  return Object.freeze({ cursor, taskId });
}

function cursorForTask(taskId: TaskId): Cursor {
  return parseCursor(`cursor_${taskId}`);
}

function readRequest(
  value: HostedTaskBoardPageSourceRequest,
  context: QueryContext
): NormalizedReadRequest | null {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'teamId',
        'cursor',
        'expectedSourceGeneration',
        'itemLimit',
        'byteLimit',
        'deadlineAtMs',
      ])
    ) {
      return null;
    }

    const teamId = parseTeamId(value.teamId);
    const cursorValue = value.cursor;
    const expectedGenerationValue = value.expectedSourceGeneration;
    if ((cursorValue === null) !== (expectedGenerationValue === null)) return null;

    const cursorBinding = cursorValue === null ? null : parseCursorTaskId(cursorValue);
    const expectedSourceGeneration =
      expectedGenerationValue === null
        ? null
        : parseHostedTaskBoardSourceGeneration(expectedGenerationValue);
    const itemLimit = value.itemLimit;
    const byteLimit = value.byteLimit;
    const deadlineAtMs = value.deadlineAtMs;
    if (
      !Number.isSafeInteger(itemLimit) ||
      itemLimit < 1 ||
      itemLimit > HOSTED_TASK_BOARD_MAX_SOURCE_ITEMS ||
      !Number.isSafeInteger(byteLimit) ||
      byteLimit <= HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES ||
      byteLimit > HOSTED_TASK_BOARD_MAX_PAGE_BYTES ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > context.deadlineAtMs
    ) {
      return null;
    }

    return Object.freeze({
      sourceRequest: Object.freeze({
        teamId,
        cursor: cursorBinding?.cursor ?? null,
        expectedSourceGeneration,
        itemLimit,
        byteLimit,
        deadlineAtMs,
      }),
      authorityRequest: Object.freeze({
        teamId,
        afterTaskId: cursorBinding?.taskId ?? null,
        expectedSourceGeneration,
        itemLimit,
        byteLimit,
        deadlineAtMs,
      }),
    });
  } catch {
    return null;
  }
}

function contextIsOpen(
  context: QueryContext,
  now: () => number,
  operationDeadlineAtMs?: number
): boolean {
  try {
    const nowMs = now();
    const effectiveDeadlineAtMs = operationDeadlineAtMs ?? context.deadlineAtMs;
    return (
      context.signal instanceof AbortSignal &&
      !context.signal.aborted &&
      Number.isSafeInteger(context.deadlineAtMs) &&
      context.deadlineAtMs >= 0 &&
      Number.isSafeInteger(effectiveDeadlineAtMs) &&
      effectiveDeadlineAtMs >= 0 &&
      effectiveDeadlineAtMs <= context.deadlineAtMs &&
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      nowMs < effectiveDeadlineAtMs
    );
  } catch {
    return false;
  }
}

function normalizeTruncationReason(value: unknown): HostedTaskBoardTruncationReason | null {
  if (value === null) return null;
  return HOSTED_TASK_BOARD_TRUNCATION_REASONS.includes(value as HostedTaskBoardTruncationReason)
    ? (value as HostedTaskBoardTruncationReason)
    : null;
}

function relationshipsAreSymmetric(items: readonly HostedTaskBoardItem[]): boolean {
  const byId = new Map(items.map((item) => [item.taskId, item]));
  return items.every((item) => {
    const blockedByIsSymmetric = item.blockedByTaskIds.every((otherTaskId) => {
      const other = byId.get(otherTaskId);
      return other === undefined || other.blocksTaskIds.includes(item.taskId);
    });
    const blocksIsSymmetric = item.blocksTaskIds.every((otherTaskId) => {
      const other = byId.get(otherTaskId);
      return other === undefined || other.blockedByTaskIds.includes(item.taskId);
    });
    const relatedIsSymmetric = item.relatedTaskIds.every((otherTaskId) => {
      const other = byId.get(otherTaskId);
      return other === undefined || other.relatedTaskIds.includes(item.taskId);
    });
    return blockedByIsSymmetric && blocksIsSymmetric && relatedIsSymmetric;
  });
}

function itemsFitByteLimit(items: readonly HostedTaskBoardItem[], byteLimit: number): boolean {
  try {
    let usedBytes = HOSTED_TASK_BOARD_ENVELOPE_RESERVE_BYTES;
    for (const item of items) {
      usedBytes += measureHostedTaskBoardJsonBytes(item) + 1;
      if (usedBytes > byteLimit) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function normalizeFoundRead(
  value: Record<PropertyKey, unknown>,
  request: NormalizedReadRequest
): HostedTaskBoardPageSourceResult {
  if (
    !hasExactKeys(value, [
      'kind',
      'teamId',
      'sourceGeneration',
      'revision',
      'items',
      'hasMore',
      'truncatedBy',
      'degradedReasons',
    ])
  ) {
    return unavailable();
  }

  try {
    const teamId = parseTeamId(value.teamId);
    if (teamId !== request.sourceRequest.teamId) return unavailable();
    const sourceGeneration = parseHostedTaskBoardSourceGeneration(value.sourceGeneration);
    if (
      request.sourceRequest.expectedSourceGeneration !== null &&
      sourceGeneration !== request.sourceRequest.expectedSourceGeneration
    ) {
      return Object.freeze({ kind: 'stale_generation', currentSourceGeneration: sourceGeneration });
    }
    const revision = parseRevision(value.revision);
    if (
      !Array.isArray(value.items) ||
      value.items.length > request.sourceRequest.itemLimit ||
      typeof value.hasMore !== 'boolean' ||
      !isHostedTaskBoardDegradedReasons(value.degradedReasons)
    ) {
      return unavailable();
    }

    const truncatedBy = normalizeTruncationReason(value.truncatedBy);
    if (
      (value.truncatedBy !== null && truncatedBy === null) ||
      (!value.hasMore && truncatedBy !== null) ||
      (value.hasMore && value.items.length === 0) ||
      (value.hasMore &&
        value.items.length < request.sourceRequest.itemLimit &&
        truncatedBy === null) ||
      (truncatedBy === 'item_budget' && value.items.length !== request.sourceRequest.itemLimit)
    ) {
      return unavailable();
    }

    const normalized = normalizeHostedTaskBoardItems(value.items, teamId);
    if (
      !normalized.ok ||
      !relationshipsAreSymmetric(normalized.value) ||
      !itemsFitByteLimit(normalized.value, request.sourceRequest.byteLimit)
    ) {
      return unavailable();
    }
    const requestTaskId = request.authorityRequest.afterTaskId;
    if (requestTaskId !== null && normalized.value.some((item) => item.taskId === requestTaskId)) {
      return unavailable();
    }

    return Object.freeze({
      kind: 'found',
      teamId,
      sourceGeneration,
      revision,
      candidates: Object.freeze(
        normalized.value.map((item) =>
          Object.freeze({ item, cursorAfter: cursorForTask(item.taskId) })
        )
      ),
      hasMore: value.hasMore,
      truncatedBy,
      degradedReasons: Object.freeze([...value.degradedReasons]),
    });
  } catch {
    return unavailable();
  }
}

function expectedAffectedTaskIdsArePresent(
  command: HostedTaskMutationCommand,
  receipt: HostedTaskMutationReceipt
): boolean {
  const affected = new Set(receipt.affectedTaskIds);
  switch (command.kind) {
    case 'create_task':
      return affected.size === 1;
    case 'reorder_column':
      return command.orderedTaskIds.every((taskId) => affected.has(taskId));
    case 'update_relationship':
      return (
        affected.size === 2 && affected.has(command.taskId) && affected.has(command.otherTaskId)
      );
    default:
      return affected.has(command.taskId);
  }
}

function normalizeReceiptResult(
  value: Record<PropertyKey, unknown>,
  expectedKind: 'committed' | 'idempotent_replay',
  command: HostedTaskMutationCommand
): HostedTaskMutationAdmissionResult {
  if (!hasExactKeys(value, ['kind', 'receipt'])) return unavailable();
  const receipt = normalizeHostedTaskMutationReceipt(
    value.receipt,
    expectedKind,
    command.commandId,
    command.teamId,
    command.expectedSourceGeneration
  );
  if (
    !receipt.ok ||
    receipt.value.revision === command.expectedRevision ||
    !expectedAffectedTaskIdsArePresent(command, receipt.value)
  ) {
    return unavailable();
  }
  if (expectedKind === 'committed' && receipt.value.outcome === 'committed') {
    return Object.freeze({ kind: 'committed', receipt: receipt.value });
  }
  if (expectedKind === 'idempotent_replay' && receipt.value.outcome === 'idempotent_replay') {
    return Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value });
  }
  return unavailable();
}

/** Maps the feature's trusted atomic authority to its read and mutation application ports. */
export class HostedTaskBoardAuthorityAdapter
  implements HostedTaskBoardPageSourcePort, HostedTaskMutationAdmissionPort
{
  constructor(
    private readonly authority: HostedTaskBoardAuthorityPort,
    private readonly now: () => number = Date.now
  ) {}

  async readPage(
    requestValue: HostedTaskBoardPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardPageSourceResult> {
    const request = readRequest(requestValue, context);
    if (request === null || !contextIsOpen(context, this.now, request.sourceRequest.deadlineAtMs)) {
      return unavailable();
    }

    try {
      const result: unknown = await this.authority.readWindow(request.authorityRequest, context);
      if (
        !contextIsOpen(context, this.now, request.sourceRequest.deadlineAtMs) ||
        !isRecord(result)
      ) {
        return unavailable();
      }
      if (result.kind === 'found') return normalizeFoundRead(result, request);
      if (result.kind === 'not_found' && hasExactKeys(result, ['kind'])) {
        return Object.freeze({ kind: 'not_found' });
      }
      if (result.kind === 'stale_generation') {
        if (!hasExactKeys(result, ['kind', 'currentSourceGeneration'])) return unavailable();
        const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(
          result.currentSourceGeneration
        );
        if (
          request.sourceRequest.expectedSourceGeneration === null ||
          currentSourceGeneration === request.sourceRequest.expectedSourceGeneration
        ) {
          return unavailable();
        }
        return Object.freeze({ kind: result.kind, currentSourceGeneration });
      }
      if (result.kind === 'unavailable') {
        if (!hasExactOptionalKey(result, ['kind'], 'retryAfterMs')) return unavailable();
        if (!Object.hasOwn(result, 'retryAfterMs')) return unavailable();
        const retryAfterMs = normalizeRetryAfterMs(result.retryAfterMs);
        return retryAfterMs === null ? unavailable() : unavailable(retryAfterMs);
      }
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  async admit(
    commandValue: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<HostedTaskMutationAdmissionResult> {
    const parsedCommand = parseHostedTaskMutationCommand(commandValue);
    if (!parsedCommand.ok || !contextIsOpen(context, this.now)) return unavailable();
    const command = parsedCommand.value;

    try {
      const result: unknown = await this.authority.compareAndCommit(command, context);
      if (!contextIsOpen(context, this.now) || !isRecord(result)) return unavailable();
      switch (result.kind) {
        case 'committed':
        case 'idempotent_replay':
          return normalizeReceiptResult(result, result.kind, command);
        case 'stale_generation': {
          if (!hasExactKeys(result, ['kind', 'currentSourceGeneration'])) {
            return unavailable();
          }
          const currentSourceGeneration = parseHostedTaskBoardSourceGeneration(
            result.currentSourceGeneration
          );
          if (currentSourceGeneration === command.expectedSourceGeneration) {
            return unavailable();
          }
          return Object.freeze({ kind: result.kind, currentSourceGeneration });
        }
        case 'stale_revision': {
          if (!hasExactKeys(result, ['kind', 'currentRevision'])) return unavailable();
          const currentRevision = parseRevision(result.currentRevision);
          if (currentRevision === command.expectedRevision) return unavailable();
          return Object.freeze({ kind: result.kind, currentRevision });
        }
        case 'conflict': {
          if (!hasExactOptionalKey(result, ['kind', 'reason'], 'currentRevision')) {
            return unavailable();
          }
          if (!CONFLICT_REASONS.includes(result.reason as (typeof CONFLICT_REASONS)[number])) {
            return unavailable();
          }
          const currentRevision = Object.hasOwn(result, 'currentRevision')
            ? parseRevision(result.currentRevision)
            : undefined;
          return Object.freeze({
            kind: result.kind,
            reason: result.reason as (typeof CONFLICT_REASONS)[number],
            ...(currentRevision === undefined ? {} : { currentRevision }),
          });
        }
        case 'not_found':
        case 'unsafe_active':
          return hasExactKeys(result, ['kind'])
            ? Object.freeze({ kind: result.kind })
            : unavailable();
        case 'unavailable': {
          if (!hasExactOptionalKey(result, ['kind'], 'retryAfterMs')) {
            return unavailable();
          }
          if (!Object.hasOwn(result, 'retryAfterMs')) return unavailable();
          const retryAfterMs = normalizeRetryAfterMs(result.retryAfterMs);
          return retryAfterMs === null ? unavailable() : unavailable(retryAfterMs);
        }
        default:
          return unavailable();
      }
    } catch {
      return unavailable();
    }
  }
}
