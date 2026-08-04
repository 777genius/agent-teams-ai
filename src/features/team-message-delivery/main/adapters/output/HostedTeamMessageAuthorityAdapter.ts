import {
  type Cursor,
  parseCursor,
  parseRevision,
  parseTeamId,
  type QueryContext,
} from '@shared/contracts/hosted';

import {
  parseHostedClientMessageId,
  parseHostedMessageId,
  parseHostedMessageSourceGeneration,
} from '../../../contracts/hosted';
import {
  HOSTED_MESSAGE_MAX_SOURCE_ITEMS,
  normalizeHostedMessagePersistenceReceipt,
  normalizeHostedTeamMessages,
  parseSendHostedTeamMessageCommand,
  sanitizeHostedMessageText,
} from '../../../core/domain/hostedMessagePolicy';

import type {
  HostedMessagePageSourcePort,
  HostedMessagePageSourceRequest,
  HostedMessagePageSourceResult,
  HostedMessagePersistenceAdmissionResult,
  HostedMessageRuntimeDeliveryRequest,
  HostedMessageRuntimeDeliveryResult,
  HostedTeamMessagePersistencePort,
  HostedTeamMessageRuntimeDeliveryPort,
} from '../../../core/application/ports/HostedTeamMessagePorts';
import type {
  HostedTeamMessageAuthorityPort,
  HostedTeamMessageAuthorityReadWindowRequest,
} from '../../ports/HostedTeamMessageAuthorityPort';

const CURSOR_PREFIX = 'cursor_';
const MAX_RETRY_AFTER_MS = 60_000;

interface NormalizedReadRequest {
  readonly sourceRequest: HostedMessagePageSourceRequest;
  readonly authorityRequest: HostedTeamMessageAuthorityReadWindowRequest;
}

interface UnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function hasExactOptionalKey(
  value: Record<PropertyKey, unknown>,
  required: readonly string[],
  optional: string
): boolean {
  return hasExactKeys(value, Object.hasOwn(value, optional) ? [...required, optional] : required);
}

function unavailable(retryAfterMs?: number): UnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function operatorRequired(): HostedMessageRuntimeDeliveryResult {
  return Object.freeze({ kind: 'operator_required' });
}

function validRetryAfterMs(value: unknown): number | undefined {
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_RETRY_AFTER_MS
    ? (value as number)
    : undefined;
}

function parseCursorMessageId(value: unknown): {
  readonly cursor: Cursor;
  readonly messageId: ReturnType<typeof parseHostedMessageId>;
} {
  const cursor = parseCursor(value);
  if (!cursor.startsWith(CURSOR_PREFIX)) throw new TypeError('hosted-team-message-cursor-invalid');
  const messageId = parseHostedMessageId(cursor.slice(CURSOR_PREFIX.length));
  if (`${CURSOR_PREFIX}${messageId}` !== cursor) {
    throw new TypeError('hosted-team-message-cursor-invalid');
  }
  return Object.freeze({ cursor, messageId });
}

function cursorForMessage(messageId: ReturnType<typeof parseHostedMessageId>): Cursor {
  return parseCursor(`${CURSOR_PREFIX}${messageId}`);
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
      Number.isSafeInteger(nowMs) &&
      nowMs >= 0 &&
      Number.isSafeInteger(context.deadlineAtMs) &&
      context.deadlineAtMs >= 0 &&
      Number.isSafeInteger(effectiveDeadlineAtMs) &&
      effectiveDeadlineAtMs >= 0 &&
      effectiveDeadlineAtMs <= context.deadlineAtMs &&
      nowMs < effectiveDeadlineAtMs
    );
  } catch {
    return false;
  }
}

function normalizeReadRequest(
  value: HostedMessagePageSourceRequest,
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
        'deadlineAtMs',
      ])
    ) {
      return null;
    }
    const teamId = parseTeamId(value.teamId);
    const cursor = value.cursor === null ? null : parseCursorMessageId(value.cursor);
    const expectedSourceGeneration =
      value.expectedSourceGeneration === null
        ? null
        : parseHostedMessageSourceGeneration(value.expectedSourceGeneration);
    const itemLimit = value.itemLimit;
    const deadlineAtMs = value.deadlineAtMs;
    if (
      (cursor === null) !== (expectedSourceGeneration === null) ||
      !Number.isSafeInteger(itemLimit) ||
      itemLimit < 1 ||
      itemLimit > HOSTED_MESSAGE_MAX_SOURCE_ITEMS ||
      !Number.isSafeInteger(deadlineAtMs) ||
      deadlineAtMs < 0 ||
      deadlineAtMs > context.deadlineAtMs
    ) {
      return null;
    }
    return Object.freeze({
      sourceRequest: Object.freeze({
        teamId,
        cursor: cursor?.cursor ?? null,
        expectedSourceGeneration,
        itemLimit,
        deadlineAtMs,
      }),
      authorityRequest: Object.freeze({
        teamId,
        afterMessageId: cursor?.messageId ?? null,
        expectedSourceGeneration,
        itemLimit,
        deadlineAtMs,
      }),
    });
  } catch {
    return null;
  }
}

function normalizeFoundRead(
  value: Record<PropertyKey, unknown>,
  request: NormalizedReadRequest
): HostedMessagePageSourceResult {
  if (
    !hasExactKeys(value, ['kind', 'teamId', 'sourceGeneration', 'revision', 'messages', 'hasMore'])
  ) {
    return unavailable();
  }
  try {
    const teamId = parseTeamId(value.teamId);
    if (teamId !== request.sourceRequest.teamId) return unavailable();
    const sourceGeneration = parseHostedMessageSourceGeneration(value.sourceGeneration);
    if (
      request.sourceRequest.expectedSourceGeneration !== null &&
      sourceGeneration !== request.sourceRequest.expectedSourceGeneration
    ) {
      return Object.freeze({ kind: 'stale_generation', currentSourceGeneration: sourceGeneration });
    }
    if (
      !Array.isArray(value.messages) ||
      value.messages.length > request.sourceRequest.itemLimit ||
      typeof value.hasMore !== 'boolean'
    ) {
      return unavailable();
    }
    const messages = normalizeHostedTeamMessages(value.messages, teamId);
    if (
      !messages.ok ||
      (value.hasMore && messages.value.length === 0) ||
      (request.authorityRequest.afterMessageId !== null &&
        messages.value.some(
          (message) => message.messageId === request.authorityRequest.afterMessageId
        ))
    ) {
      return unavailable();
    }
    return Object.freeze({
      kind: 'found',
      teamId,
      sourceGeneration,
      revision: parseRevision(value.revision),
      candidates: Object.freeze(
        messages.value.map((message) =>
          Object.freeze({ message, cursorAfter: cursorForMessage(message.messageId) })
        )
      ),
      hasMore: value.hasMore,
    });
  } catch {
    return unavailable();
  }
}

function normalizePersistenceResult(
  value: unknown,
  command: Parameters<HostedTeamMessagePersistencePort['persist']>[0]
): HostedMessagePersistenceAdmissionResult {
  if (!isRecord(value)) return unavailable();
  try {
    if (value.kind === 'persisted' || value.kind === 'idempotent_replay') {
      if (!hasExactKeys(value, ['kind', 'receipt'])) return unavailable();
      const receipt = normalizeHostedMessagePersistenceReceipt(value.receipt, command);
      if (!receipt.ok) return unavailable();
      return value.kind === 'persisted'
        ? Object.freeze({ kind: 'persisted', receipt: receipt.value })
        : Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value });
    }
    if (value.kind === 'conflict') {
      return hasExactKeys(value, ['kind', 'reason']) && value.reason === 'idempotency_mismatch'
        ? Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' })
        : unavailable();
    }
    if (value.kind === 'not_found') {
      return hasExactKeys(value, ['kind']) ? Object.freeze({ kind: 'not_found' }) : unavailable();
    }
    if (value.kind === 'unavailable' && hasExactOptionalKey(value, ['kind'], 'retryAfterMs')) {
      return Object.hasOwn(value, 'retryAfterMs')
        ? unavailable(validRetryAfterMs(value.retryAfterMs))
        : unavailable();
    }
    return unavailable();
  } catch {
    return unavailable();
  }
}

function normalizeRuntimeRequest(
  value: HostedMessageRuntimeDeliveryRequest
): HostedMessageRuntimeDeliveryRequest | null {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['teamId', 'messageId', 'clientMessageId', 'text'])
    ) {
      return null;
    }
    return Object.freeze({
      teamId: parseTeamId(value.teamId),
      messageId: parseHostedMessageId(value.messageId),
      clientMessageId: parseHostedClientMessageId(value.clientMessageId),
      text: sanitizeHostedMessageText(value.text),
    });
  } catch {
    return null;
  }
}

function normalizeRuntimeResult(value: unknown): HostedMessageRuntimeDeliveryResult {
  if (!isRecord(value)) return operatorRequired();
  if (value.kind === 'delivered' && hasExactKeys(value, ['kind'])) {
    return Object.freeze({ kind: 'delivered' });
  }
  if (value.kind === 'pending' && hasExactKeys(value, ['kind'])) {
    return Object.freeze({ kind: 'pending' });
  }
  if (value.kind === 'operator_required' && hasExactKeys(value, ['kind'])) {
    return Object.freeze({ kind: 'operator_required' });
  }
  if (value.kind === 'unavailable' && hasExactOptionalKey(value, ['kind'], 'retryAfterMs')) {
    return Object.hasOwn(value, 'retryAfterMs')
      ? unavailable(validRetryAfterMs(value.retryAfterMs))
      : unavailable();
  }
  return operatorRequired();
}

/** Maps the trusted authority into the narrow application ports without exposing its implementation. */
export class HostedTeamMessageAuthorityAdapter
  implements
    HostedMessagePageSourcePort,
    HostedTeamMessagePersistencePort,
    HostedTeamMessageRuntimeDeliveryPort
{
  constructor(
    private readonly authority: HostedTeamMessageAuthorityPort,
    private readonly now: () => number = Date.now
  ) {}

  async readPage(
    requestValue: HostedMessagePageSourceRequest,
    context: QueryContext
  ): Promise<HostedMessagePageSourceResult> {
    const request = normalizeReadRequest(requestValue, context);
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
      if (
        result.kind === 'stale_generation' &&
        hasExactKeys(result, ['kind', 'currentSourceGeneration'])
      ) {
        const currentSourceGeneration = parseHostedMessageSourceGeneration(
          result.currentSourceGeneration
        );
        return request.sourceRequest.expectedSourceGeneration === null ||
          currentSourceGeneration === request.sourceRequest.expectedSourceGeneration
          ? unavailable()
          : Object.freeze({ kind: 'stale_generation', currentSourceGeneration });
      }
      if (result.kind === 'unavailable' && hasExactOptionalKey(result, ['kind'], 'retryAfterMs')) {
        return Object.hasOwn(result, 'retryAfterMs')
          ? unavailable(validRetryAfterMs(result.retryAfterMs))
          : unavailable();
      }
      return unavailable();
    } catch {
      return unavailable();
    }
  }

  async persist(
    command: Parameters<HostedTeamMessagePersistencePort['persist']>[0],
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult> {
    const normalizedCommand = parseSendHostedTeamMessageCommand(command);
    if (!normalizedCommand.ok || !contextIsOpen(context, this.now)) return unavailable();
    try {
      const result = await this.authority.persistMessage(normalizedCommand.value, context);
      return contextIsOpen(context, this.now)
        ? normalizePersistenceResult(result, normalizedCommand.value)
        : unavailable();
    } catch {
      return unavailable();
    }
  }

  async deliver(
    requestValue: HostedMessageRuntimeDeliveryRequest,
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult> {
    const request = normalizeRuntimeRequest(requestValue);
    if (request === null || !contextIsOpen(context, this.now)) return unavailable();
    try {
      const result = await this.authority.deliverPersistedMessage(request, context);
      return contextIsOpen(context, this.now) ? normalizeRuntimeResult(result) : operatorRequired();
    } catch {
      return operatorRequired();
    }
  }
}
