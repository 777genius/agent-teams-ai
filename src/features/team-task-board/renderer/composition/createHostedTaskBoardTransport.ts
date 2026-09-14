import {
  createSafeAppError,
  parseCursor,
  parseRevision,
  parseTeamId,
  type Revision,
} from '@shared/contracts/hosted';

import {
  type ExecuteHostedTaskMutationResult,
  type GetHostedTaskBoardPageResult,
  HOSTED_TASK_BOARD_DEGRADED_REASONS,
  HOSTED_TASK_BOARD_MUTATION_ROUTE,
  HOSTED_TASK_BOARD_PAGE_ROUTE,
  HOSTED_TASK_BOARD_SCHEMA_VERSION,
  HOSTED_TASK_BOARD_TRUNCATION_REASONS,
  type HostedTaskBoardBudgetMetadata,
  type HostedTaskBoardCoreV1MutationCommand,
  type HostedTaskBoardDegradedMetadata,
  type HostedTaskBoardErrorEnvelope,
  type HostedTaskBoardPage,
  type HostedTaskBoardPageRequest,
  isHostedTaskBoardCoreV1MutationCommand,
  parseHostedTaskBoardSourceGeneration,
} from '../../contracts/hosted';
import {
  HOSTED_TASK_BOARD_MAX_PAGE_BYTES,
  HOSTED_TASK_BOARD_MAX_PAGE_ITEMS,
  HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS,
} from '../../core/domain/models/HostedTaskBoardBudget';
import {
  normalizeAndOrderHostedTaskBoardItems,
  normalizeHostedTaskMutationReceipt,
  parseHostedTaskBoardPageRequest,
  parseHostedTaskMutationCommand,
} from '../../core/domain/policies/hostedTaskBoardPolicy';

import type {
  HostedTaskBoardHttpResponse,
  HostedTaskBoardTransport,
  HostedTaskBoardTransportDependencies,
  HostedTaskBoardTransportOptions,
} from '../ports/HostedTaskBoardRendererPorts';

export const HOSTED_TASK_BOARD_PAGE_HTTP_PATH = HOSTED_TASK_BOARD_PAGE_ROUTE;
const HOSTED_TASK_BOARD_MUTATION_HTTP_PATH = HOSTED_TASK_BOARD_MUTATION_ROUTE;

const JSON_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const CSRF_HEADER = 'x-agent-teams-csrf';
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

function success<T>(value: T): ParseResult<T> {
  return Object.freeze({ ok: true, value });
}

function failure(): ParseResult<never> {
  return Object.freeze({ ok: false });
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

function integerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return (
    Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum
  );
}

function parseBudget(
  value: unknown,
  itemCount: number,
  requestLimit: number
): HostedTaskBoardBudgetMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'itemLimit',
      'byteLimit',
      'timeLimitMs',
      'usedItems',
      'usedBytes',
      'elapsedMs',
    ]) ||
    value.itemLimit !== requestLimit ||
    value.usedItems !== itemCount ||
    !integerInRange(value.itemLimit, 1, HOSTED_TASK_BOARD_MAX_PAGE_ITEMS) ||
    !integerInRange(value.byteLimit, 1, HOSTED_TASK_BOARD_MAX_PAGE_BYTES) ||
    !integerInRange(value.timeLimitMs, 1, HOSTED_TASK_BOARD_MAX_PAGE_TIME_MS) ||
    !integerInRange(value.usedBytes, 0, value.byteLimit) ||
    !integerInRange(value.elapsedMs, 0, 60_000)
  ) {
    throw new TypeError('hosted-task-board-response-budget-invalid');
  }
  return Object.freeze({
    itemLimit: value.itemLimit,
    byteLimit: value.byteLimit,
    timeLimitMs: value.timeLimitMs,
    usedItems: value.usedItems,
    usedBytes: value.usedBytes,
    elapsedMs: value.elapsedMs,
  });
}

function parseDegraded(value: unknown): HostedTaskBoardDegradedMetadata {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['active', 'reasons']) ||
    typeof value.active !== 'boolean' ||
    !Array.isArray(value.reasons) ||
    value.reasons.length > HOSTED_TASK_BOARD_DEGRADED_REASONS.length ||
    new Set(value.reasons).size !== value.reasons.length ||
    !value.reasons.every((reason) =>
      HOSTED_TASK_BOARD_DEGRADED_REASONS.includes(
        reason as (typeof HOSTED_TASK_BOARD_DEGRADED_REASONS)[number]
      )
    ) ||
    value.active !== value.reasons.length > 0
  ) {
    throw new TypeError('hosted-task-board-response-degraded-invalid');
  }
  return Object.freeze({
    active: value.active,
    reasons: Object.freeze(
      value.reasons as unknown as HostedTaskBoardDegradedMetadata['reasons'][number][]
    ),
  });
}

function parsePage(
  value: unknown,
  request: HostedTaskBoardPageRequest
): ParseResult<HostedTaskBoardPage> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'teamId',
        'sourceGeneration',
        'revision',
        'items',
        'nextCursor',
        'truncated',
        'truncationReasons',
        'degraded',
        'budget',
      ]) ||
      value.schemaVersion !== HOSTED_TASK_BOARD_SCHEMA_VERSION ||
      value.kind !== 'task_board_page' ||
      parseTeamId(value.teamId) !== request.teamId ||
      typeof value.truncated !== 'boolean' ||
      !Array.isArray(value.truncationReasons) ||
      value.truncationReasons.length > HOSTED_TASK_BOARD_TRUNCATION_REASONS.length ||
      new Set(value.truncationReasons).size !== value.truncationReasons.length ||
      !value.truncationReasons.every((reason) =>
        HOSTED_TASK_BOARD_TRUNCATION_REASONS.includes(
          reason as (typeof HOSTED_TASK_BOARD_TRUNCATION_REASONS)[number]
        )
      )
    ) {
      return failure();
    }

    const sourceGeneration = parseHostedTaskBoardSourceGeneration(value.sourceGeneration);
    const revision = parseRevision(value.revision);
    const items = normalizeAndOrderHostedTaskBoardItems(value.items, request.teamId);
    if (!items.ok || items.value.length > request.limit) return failure();
    const nextCursor = value.nextCursor === null ? null : parseCursor(value.nextCursor);
    const truncationReasons = Object.freeze(
      value.truncationReasons as unknown as HostedTaskBoardPage['truncationReasons'][number][]
    );
    if (
      (value.truncated && nextCursor === null) ||
      (!value.truncated && (nextCursor !== null || truncationReasons.length > 0)) ||
      (request.cursor !== null && nextCursor === request.cursor)
    ) {
      return failure();
    }

    return success(
      Object.freeze({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        kind: 'task_board_page',
        teamId: request.teamId,
        sourceGeneration,
        revision,
        items: items.value,
        nextCursor,
        truncated: value.truncated,
        truncationReasons,
        degraded: parseDegraded(value.degraded),
        budget: parseBudget(value.budget, items.value.length, request.limit),
      })
    );
  } catch {
    return failure();
  }
}

function parseErrorEnvelope(value: unknown): ParseResult<HostedTaskBoardErrorEnvelope> {
  try {
    if (!isRecord(value)) return failure();
    const allowedKeys = new Set([
      'schemaVersion',
      'kind',
      'error',
      'retryable',
      'currentSourceGeneration',
      'currentRevision',
    ]);
    if (
      value.schemaVersion !== HOSTED_TASK_BOARD_SCHEMA_VERSION ||
      value.kind !== 'error' ||
      typeof value.retryable !== 'boolean' ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowedKeys.has(key))
    ) {
      return failure();
    }
    const error = createSafeAppError(value.error);
    const currentSourceGeneration = Object.hasOwn(value, 'currentSourceGeneration')
      ? parseHostedTaskBoardSourceGeneration(value.currentSourceGeneration)
      : undefined;
    const currentRevision: Revision | undefined = Object.hasOwn(value, 'currentRevision')
      ? parseRevision(value.currentRevision)
      : undefined;
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TASK_BOARD_SCHEMA_VERSION,
        kind: 'error',
        error,
        retryable: value.retryable,
        ...(currentSourceGeneration === undefined ? {} : { currentSourceGeneration }),
        ...(currentRevision === undefined ? {} : { currentRevision }),
      })
    );
  } catch {
    return failure();
  }
}

interface HostedTaskBoardUnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

function unavailable(retryAfterMs?: number): HostedTaskBoardUnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function mapPageError(status: number, value: unknown): GetHostedTaskBoardPageResult {
  const envelope = parseErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'task_board_request_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'task_board_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  if (status === 409 && reason === 'stale_generation') {
    return envelope.value.currentSourceGeneration === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: envelope.value.currentSourceGeneration,
        });
  }
  return status === 503 && reason === 'task_board_unavailable'
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

function mapMutationError(status: number, value: unknown): ExecuteHostedTaskMutationResult {
  const envelope = parseErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'task_board_mutation_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'task_board_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  if (status === 503 && reason === 'task_board_unavailable') {
    return unavailable(envelope.value.error.retryAfterMs);
  }
  if (status !== 409) return unavailable();
  if (reason === 'stale_generation') {
    return envelope.value.currentSourceGeneration === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'stale_generation',
          currentSourceGeneration: envelope.value.currentSourceGeneration,
        });
  }
  if (reason === 'stale_revision') {
    return envelope.value.currentRevision === undefined
      ? unavailable()
      : Object.freeze({ kind: 'stale_revision', currentRevision: envelope.value.currentRevision });
  }
  if (reason === 'state_conflict') {
    return envelope.value.currentRevision === undefined
      ? unavailable()
      : Object.freeze({
          kind: 'conflict',
          reason: 'state_conflict',
          currentRevision: envelope.value.currentRevision,
        });
  }
  if (reason === 'idempotency_mismatch') {
    return Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
  }
  if (reason === 'relationship_conflict') {
    return envelope.value.currentRevision === undefined
      ? Object.freeze({ kind: 'conflict', reason: 'relationship_conflict' })
      : Object.freeze({
          kind: 'conflict',
          reason: 'relationship_conflict',
          currentRevision: envelope.value.currentRevision,
        });
  }
  return reason === 'task_board_unsafe_active'
    ? Object.freeze({ kind: 'unsafe_active' })
    : unavailable();
}

function parseMutationReceipt(
  value: unknown,
  command: HostedTaskBoardCoreV1MutationCommand
): ExecuteHostedTaskMutationResult {
  if (!isRecord(value)) return unavailable();
  const outcome = value.outcome;
  if (outcome !== 'committed' && outcome !== 'idempotent_replay') return unavailable();
  const receipt = normalizeHostedTaskMutationReceipt(
    value,
    outcome,
    command.commandId,
    command.teamId,
    command.expectedSourceGeneration
  );
  if (!receipt.ok) return unavailable();
  if (outcome === 'committed') {
    return receipt.value.outcome === 'committed'
      ? Object.freeze({ kind: 'committed', receipt: receipt.value })
      : unavailable();
  }
  return receipt.value.outcome === 'idempotent_replay'
    ? Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value })
    : unavailable();
}

function readCsrfToken(dependencies: HostedTaskBoardTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJson(response: HostedTaskBoardHttpResponse): Promise<unknown | null> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Creates a browser-only task-board transport from injected HTTP and in-memory auth ports. */
export function createHostedTaskBoardTransport(
  dependencies: HostedTaskBoardTransportDependencies
): HostedTaskBoardTransport {
  return Object.freeze({
    async getPage(
      requestValue: HostedTaskBoardPageRequest,
      options?: HostedTaskBoardTransportOptions
    ): Promise<GetHostedTaskBoardPageResult> {
      const request = parseHostedTaskBoardPageRequest(requestValue);
      if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable();

      let response: HostedTaskBoardHttpResponse;
      try {
        response = await dependencies.fetch(HOSTED_TASK_BOARD_PAGE_HTTP_PATH, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: Object.freeze({ ...JSON_HEADERS, [CSRF_HEADER]: csrfToken }),
          body: JSON.stringify(request.value),
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
        });
      } catch {
        return options?.signal?.aborted ? Object.freeze({ kind: 'cancelled' }) : unavailable();
      }
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const value = await readJson(response);
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      if (response.status !== 200) return mapPageError(response.status, value);
      const page = parsePage(value, request.value);
      return page.ok ? Object.freeze({ kind: 'success', page: page.value }) : unavailable();
    },

    ...(dependencies.mutationsEnabled === true
      ? {
          async executeMutation(
            commandValue: HostedTaskBoardCoreV1MutationCommand,
            options?: HostedTaskBoardTransportOptions
          ): Promise<ExecuteHostedTaskMutationResult> {
            const command = parseHostedTaskMutationCommand(commandValue);
            if (!command.ok || !isHostedTaskBoardCoreV1MutationCommand(command.value)) {
              return Object.freeze({ kind: 'invalid_request' });
            }
            if (options?.signal?.aborted) return unavailable();
            const csrfToken = readCsrfToken(dependencies);
            if (csrfToken === null) return unavailable();

            let response: HostedTaskBoardHttpResponse;
            try {
              response = await dependencies.fetch(HOSTED_TASK_BOARD_MUTATION_HTTP_PATH, {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store',
                headers: Object.freeze({ ...JSON_HEADERS, [CSRF_HEADER]: csrfToken }),
                body: JSON.stringify(command.value),
                ...(options?.signal === undefined ? {} : { signal: options.signal }),
              });
            } catch {
              return unavailable();
            }
            if (options?.signal?.aborted) return unavailable();
            const value = await readJson(response);
            if (options?.signal?.aborted) return unavailable();
            return response.status === 200
              ? parseMutationReceipt(value, command.value)
              : mapMutationError(response.status, value);
          },
        }
      : {}),
  });
}
