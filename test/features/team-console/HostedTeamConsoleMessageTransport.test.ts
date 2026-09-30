import {
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  parseHostedClientMessageId,
  parseHostedMessageSourceGeneration,
} from '@features/team-message-delivery/contracts/hosted';
import {
  createHostedTeamMessageTransport,
  type HostedTeamMessageFetchPort,
} from '@features/team-message-delivery/renderer';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const TEAM_ID = parseTeamId(`team_${'a'.repeat(32)}`);
const CLIENT_MESSAGE_ID = parseHostedClientMessageId('client_message_transport-send-0001');
const CURRENT_SOURCE_GENERATION = parseHostedMessageSourceGeneration(
  'generation_http-parser-current'
);
const CSRF_TOKEN = 'c'.repeat(32);

type HostedMessageOperation = 'page' | 'send';

function command() {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId: TEAM_ID,
    clientMessageId: CLIENT_MESSAGE_ID,
    text: 'Please review this update.',
  });
}

function pageRequest() {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    teamId: TEAM_ID,
    cursor: null,
    expectedSourceGeneration: null,
    limit: 25,
  });
}

function errorEnvelope(input: {
  readonly code: unknown;
  readonly reason: unknown;
  readonly retryable: unknown;
  readonly currentSourceGeneration?: unknown;
  readonly diagnosticId?: unknown;
  readonly includeCurrentSourceGeneration?: boolean;
  readonly includeRetryAfterMs?: boolean;
  readonly retryAfterMs?: unknown;
}) {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
    kind: 'error',
    error: Object.freeze({
      code: input.code,
      reason: input.reason,
      ...(input.diagnosticId === undefined ? {} : { diagnosticId: input.diagnosticId }),
      ...(input.includeRetryAfterMs || input.retryAfterMs !== undefined
        ? { retryAfterMs: input.retryAfterMs }
        : {}),
    }),
    retryable: input.retryable,
    ...(input.includeCurrentSourceGeneration
      ? { currentSourceGeneration: input.currentSourceGeneration }
      : {}),
  });
}

async function invoke(
  operation: HostedMessageOperation,
  status: number,
  response: unknown
): Promise<unknown> {
  const fetch = vi
    .fn<HostedTeamMessageFetchPort>()
    .mockResolvedValue({ status, json: async () => response });
  const transport = createHostedTeamMessageTransport({
    fetch,
    getCsrfToken: () => CSRF_TOKEN,
  });
  return operation === 'page' ? transport.getPage(pageRequest()) : transport.sendMessage(command());
}

describe('hosted team-message HTTP error parser', () => {
  it.each([
    {
      operation: 'page' as const,
      status: 400,
      response: errorEnvelope({
        code: 'invalid_request',
        reason: 'team_message_page_request_invalid',
        retryable: false,
      }),
      expected: { kind: 'invalid_request' },
    },
    {
      operation: 'page' as const,
      status: 404,
      response: errorEnvelope({
        code: 'not_found',
        reason: 'team_message_not_found',
        retryable: false,
      }),
      expected: { kind: 'not_found' },
    },
    {
      operation: 'page' as const,
      status: 409,
      response: errorEnvelope({
        code: 'conflict',
        reason: 'stale_generation',
        retryable: false,
        currentSourceGeneration: CURRENT_SOURCE_GENERATION,
        includeCurrentSourceGeneration: true,
      }),
      expected: { kind: 'stale_generation', currentSourceGeneration: CURRENT_SOURCE_GENERATION },
    },
    {
      operation: 'page' as const,
      status: 503,
      response: errorEnvelope({
        code: 'unavailable',
        reason: 'team_message_unavailable',
        retryable: true,
        retryAfterMs: 2_000,
      }),
      expected: { kind: 'unavailable', retryAfterMs: 2_000 },
    },
    {
      operation: 'send' as const,
      status: 400,
      response: errorEnvelope({
        code: 'invalid_request',
        reason: 'team_message_send_request_invalid',
        retryable: false,
      }),
      expected: { kind: 'invalid_request' },
    },
    {
      operation: 'send' as const,
      status: 404,
      response: errorEnvelope({
        code: 'not_found',
        reason: 'team_message_not_found',
        retryable: false,
      }),
      expected: { kind: 'not_found' },
    },
    {
      operation: 'send' as const,
      status: 409,
      response: errorEnvelope({
        code: 'conflict',
        reason: 'team_message_idempotency_conflict',
        retryable: false,
      }),
      expected: { kind: 'conflict', reason: 'idempotency_mismatch' },
    },
    {
      operation: 'send' as const,
      status: 503,
      response: errorEnvelope({
        code: 'unavailable',
        reason: 'team_message_unavailable',
        retryable: true,
      }),
      expected: { kind: 'unavailable' },
    },
  ])('maps the exact $operation $status error combination', async (input) => {
    await expect(invoke(input.operation, input.status, input.response)).resolves.toEqual(
      input.expected
    );
  });

  it.each([
    {
      operation: 'page' as const,
      status: 400,
      mismatch: 'code',
      response: errorEnvelope({
        code: 'not_found',
        reason: 'team_message_page_request_invalid',
        retryable: false,
      }),
    },
    {
      operation: 'page' as const,
      status: 404,
      mismatch: 'retryability',
      response: errorEnvelope({
        code: 'not_found',
        reason: 'team_message_not_found',
        retryable: true,
      }),
    },
    {
      operation: 'page' as const,
      status: 409,
      mismatch: 'missing current source generation',
      response: errorEnvelope({
        code: 'conflict',
        reason: 'stale_generation',
        retryable: false,
      }),
    },
    {
      operation: 'page' as const,
      status: 409,
      mismatch: 'forbidden retry metadata',
      response: errorEnvelope({
        code: 'conflict',
        reason: 'stale_generation',
        retryable: false,
        currentSourceGeneration: CURRENT_SOURCE_GENERATION,
        includeCurrentSourceGeneration: true,
        retryAfterMs: 1,
      }),
    },
    {
      operation: 'page' as const,
      status: 503,
      mismatch: 'forbidden current source generation',
      response: errorEnvelope({
        code: 'unavailable',
        reason: 'team_message_unavailable',
        retryable: true,
        currentSourceGeneration: CURRENT_SOURCE_GENERATION,
        includeCurrentSourceGeneration: true,
      }),
    },
    {
      operation: 'page' as const,
      status: 503,
      mismatch: 'undefined retry metadata',
      response: errorEnvelope({
        code: 'unavailable',
        reason: 'team_message_unavailable',
        retryable: true,
        includeRetryAfterMs: true,
      }),
    },
    {
      operation: 'send' as const,
      status: 400,
      mismatch: 'forbidden retry metadata',
      response: errorEnvelope({
        code: 'invalid_request',
        reason: 'team_message_send_request_invalid',
        retryable: false,
        retryAfterMs: 1,
      }),
    },
    {
      operation: 'send' as const,
      status: 404,
      mismatch: 'forbidden diagnostic metadata',
      response: errorEnvelope({
        code: 'not_found',
        reason: 'team_message_not_found',
        retryable: false,
        diagnosticId: 'unexpected-diagnostic',
      }),
    },
    {
      operation: 'send' as const,
      status: 409,
      mismatch: 'forbidden current source generation',
      response: errorEnvelope({
        code: 'conflict',
        reason: 'team_message_idempotency_conflict',
        retryable: false,
        currentSourceGeneration: CURRENT_SOURCE_GENERATION,
        includeCurrentSourceGeneration: true,
      }),
    },
    {
      operation: 'send' as const,
      status: 409,
      mismatch: 'code',
      response: errorEnvelope({
        code: 'invalid_request',
        reason: 'team_message_idempotency_conflict',
        retryable: false,
      }),
    },
    {
      operation: 'send' as const,
      status: 503,
      mismatch: 'retryability',
      response: errorEnvelope({
        code: 'unavailable',
        reason: 'team_message_unavailable',
        retryable: false,
      }),
    },
  ])('fails closed for $operation $status with $mismatch', async (input) => {
    await expect(invoke(input.operation, input.status, input.response)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
