import {
  createSafeAppError,
  parseCursor,
  parseRevision,
  parseTeamId,
} from '@shared/contracts/hosted';

import {
  type GetHostedMessagePageResult,
  HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH,
  type HostedMessagePage,
  type HostedMessagePageRequest,
  type HostedTeamMessageErrorEnvelope,
  type HostedTeamMessageSendReceipt,
  parseHostedMessageSourceGeneration,
  type SendHostedTeamMessageCommand,
  type SendHostedTeamMessageResult,
} from '../../contracts/hosted';
import {
  normalizeHostedMessagePersistenceReceipt,
  normalizeHostedTeamMessages,
  parseHostedMessagePageRequest,
  parseHostedMessageRuntimeDeliveryState,
  parseSendHostedTeamMessageCommand,
} from '../../core/domain/hostedMessagePolicy';

import type {
  HostedTeamMessageHttpRequestInit,
  HostedTeamMessageHttpResponse,
  HostedTeamMessageTransport,
  HostedTeamMessageTransportDependencies,
  HostedTeamMessageTransportOptions,
} from '../ports/HostedTeamMessageRendererPorts';

const JSON_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});
const CSRF_HEADER = 'x-agent-teams-csrf';
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

type ParseResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };
interface UnavailableResult {
  readonly kind: 'unavailable';
  readonly retryAfterMs?: number;
}

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
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parsePage(
  value: unknown,
  request: HostedMessagePageRequest
): ParseResult<HostedMessagePage> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'kind',
        'teamId',
        'sourceGeneration',
        'revision',
        'messages',
        'nextCursor',
      ]) ||
      value.schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION ||
      value.kind !== 'message_page' ||
      parseTeamId(value.teamId) !== request.teamId
    ) {
      return failure();
    }
    const sourceGeneration = parseHostedMessageSourceGeneration(value.sourceGeneration);
    if (
      request.expectedSourceGeneration !== null &&
      sourceGeneration !== request.expectedSourceGeneration
    ) {
      return failure();
    }
    const messages = normalizeHostedTeamMessages(value.messages, request.teamId);
    if (!messages.ok || messages.value.length > request.limit) return failure();
    const nextCursor = value.nextCursor === null ? null : parseCursor(value.nextCursor);
    if (
      (nextCursor !== null && messages.value.length === 0) ||
      (nextCursor === request.cursor && nextCursor !== null)
    ) {
      return failure();
    }
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        kind: 'message_page',
        teamId: request.teamId,
        sourceGeneration,
        revision: parseRevision(value.revision),
        messages: messages.value,
        nextCursor,
      })
    );
  } catch {
    return failure();
  }
}

function parseErrorEnvelope(value: unknown): ParseResult<HostedTeamMessageErrorEnvelope> {
  try {
    if (!isRecord(value)) return failure();
    const allowed = new Set([
      'schemaVersion',
      'kind',
      'error',
      'retryable',
      'currentSourceGeneration',
    ]);
    if (
      value.schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION ||
      value.kind !== 'error' ||
      typeof value.retryable !== 'boolean' ||
      Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !allowed.has(key))
    ) {
      return failure();
    }
    const error = createSafeAppError(value.error);
    const currentSourceGeneration = Object.hasOwn(value, 'currentSourceGeneration')
      ? parseHostedMessageSourceGeneration(value.currentSourceGeneration)
      : undefined;
    return success(
      Object.freeze({
        schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
        kind: 'error',
        error,
        retryable: value.retryable,
        ...(currentSourceGeneration === undefined ? {} : { currentSourceGeneration }),
      })
    );
  } catch {
    return failure();
  }
}

function unavailable(retryAfterMs?: number): UnavailableResult {
  return retryAfterMs === undefined
    ? Object.freeze({ kind: 'unavailable' })
    : Object.freeze({ kind: 'unavailable', retryAfterMs });
}

function mapPageError(status: number, value: unknown): GetHostedMessagePageResult {
  const envelope = parseErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'team_message_page_request_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'team_message_not_found') {
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
  return status === 503 && reason === 'team_message_unavailable'
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

function parseSendReceipt(
  value: unknown,
  command: SendHostedTeamMessageCommand
): ParseResult<HostedTeamMessageSendReceipt> {
  try {
    if (
      !isRecord(value) ||
      !hasExactKeys(value, [
        'schemaVersion',
        'teamId',
        'messageId',
        'clientMessageId',
        'persistence',
        'runtimeDelivery',
      ])
    ) {
      return failure();
    }
    const persistence = normalizeHostedMessagePersistenceReceipt(
      Object.freeze({
        schemaVersion: value.schemaVersion,
        teamId: value.teamId,
        messageId: value.messageId,
        clientMessageId: value.clientMessageId,
        persistence: value.persistence,
      }),
      command
    );
    if (!persistence.ok) return failure();
    return success(
      Object.freeze({
        ...persistence.value,
        runtimeDelivery: parseHostedMessageRuntimeDeliveryState(value.runtimeDelivery),
      })
    );
  } catch {
    return failure();
  }
}

function parseSendResult(
  value: unknown,
  command: SendHostedTeamMessageCommand
): ParseResult<SendHostedTeamMessageResult> {
  try {
    if (!isRecord(value) || (value.kind !== 'persisted' && value.kind !== 'idempotent_replay')) {
      return failure();
    }
    if (!hasExactKeys(value, ['kind', 'receipt'])) return failure();
    const receipt = parseSendReceipt(value.receipt, command);
    if (!receipt.ok) return failure();
    return value.kind === 'persisted'
      ? success(Object.freeze({ kind: 'persisted', receipt: receipt.value }))
      : success(Object.freeze({ kind: 'idempotent_replay', receipt: receipt.value }));
  } catch {
    return failure();
  }
}

function mapSendError(status: number, value: unknown): SendHostedTeamMessageResult {
  const envelope = parseErrorEnvelope(value);
  if (!envelope.ok) return unavailable();
  const reason = envelope.value.error.reason;
  if (status === 400 && reason === 'team_message_send_request_invalid') {
    return Object.freeze({ kind: 'invalid_request' });
  }
  if (status === 404 && reason === 'team_message_not_found') {
    return Object.freeze({ kind: 'not_found' });
  }
  if (status === 409 && reason === 'team_message_idempotency_conflict') {
    return Object.freeze({ kind: 'conflict', reason: 'idempotency_mismatch' });
  }
  return status === 503 && reason === 'team_message_unavailable'
    ? unavailable(envelope.value.error.retryAfterMs)
    : unavailable();
}

function readCsrfToken(dependencies: HostedTeamMessageTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function readJson(response: HostedTeamMessageHttpResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function requestInit(
  body: string,
  options?: HostedTeamMessageTransportOptions
): HostedTeamMessageHttpRequestInit {
  return Object.freeze({
    method: 'POST' as const,
    credentials: 'include' as const,
    cache: 'no-store' as const,
    headers: Object.freeze({ ...JSON_HEADERS }),
    body,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
}

/** Creates a browser-only message transport from injected HTTP and in-memory auth ports. */
export function createHostedTeamMessageTransport(
  dependencies: HostedTeamMessageTransportDependencies
): HostedTeamMessageTransport {
  const send = async (
    path: string,
    body: string,
    options: HostedTeamMessageTransportOptions | undefined,
    csrfToken: string
  ): Promise<HostedTeamMessageHttpResponse> =>
    dependencies.fetch(path, {
      ...requestInit(body, options),
      headers: Object.freeze({ ...JSON_HEADERS, [CSRF_HEADER]: csrfToken }),
    });

  return Object.freeze({
    async getPage(
      requestValue: HostedMessagePageRequest,
      options?: HostedTeamMessageTransportOptions
    ): Promise<GetHostedMessagePageResult> {
      const request = parseHostedMessagePageRequest(requestValue);
      if (!request.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return Object.freeze({ kind: 'cancelled' });
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable();
      let response: HostedTeamMessageHttpResponse;
      try {
        response = await send(
          HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
          JSON.stringify(request.value),
          options,
          csrfToken
        );
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

    async sendMessage(
      commandValue: SendHostedTeamMessageCommand,
      options?: HostedTeamMessageTransportOptions
    ): Promise<SendHostedTeamMessageResult> {
      const command = parseSendHostedTeamMessageCommand(commandValue);
      if (!command.ok) return Object.freeze({ kind: 'invalid_request' });
      if (options?.signal?.aborted) return unavailable();
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable();
      let response: HostedTeamMessageHttpResponse;
      try {
        response = await send(
          HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH,
          JSON.stringify(command.value),
          options,
          csrfToken
        );
      } catch {
        return unavailable();
      }
      if (options?.signal?.aborted) return unavailable();
      const value = await readJson(response);
      if (options?.signal?.aborted) return unavailable();
      if (response.status !== 200) return mapSendError(response.status, value);
      const result = parseSendResult(value, command.value);
      return result.ok ? result.value : unavailable();
    },
  });
}
