import { createSafeAppError } from '@shared/contracts/hosted';

import {
  HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH,
  HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
  HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH,
  parseHostedMessageSourceGeneration,
} from '../contracts/hosted';

import { createHostedTeamMessageTransport as createStrictHostedTeamMessageTransport } from './composition/createHostedTeamMessageTransport';

import type {
  HostedTeamMessageHttpResponse,
  HostedTeamMessageTransport,
  HostedTeamMessageTransportDependencies,
} from './ports/HostedTeamMessageRendererPorts';

export { HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH } from '../contracts/hosted';

type ExpectedHostedTeamMessageError = Readonly<{
  code: 'conflict' | 'invalid_request' | 'not_found' | 'unavailable';
  reason:
    | 'stale_generation'
    | 'team_message_idempotency_conflict'
    | 'team_message_not_found'
    | 'team_message_page_request_invalid'
    | 'team_message_send_request_invalid'
    | 'team_message_unavailable';
  retryable: boolean;
  metadata: 'none' | 'current_source_generation' | 'retry_after';
}>;

const EXPECTED_ERROR_BY_ROUTE_AND_STATUS = Object.freeze({
  [`${HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH}\u0000400`]: Object.freeze({
    code: 'invalid_request',
    reason: 'team_message_page_request_invalid',
    retryable: false,
    metadata: 'none',
  }),
  [`${HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH}\u0000404`]: Object.freeze({
    code: 'not_found',
    reason: 'team_message_not_found',
    retryable: false,
    metadata: 'none',
  }),
  [`${HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH}\u0000409`]: Object.freeze({
    code: 'conflict',
    reason: 'stale_generation',
    retryable: false,
    metadata: 'current_source_generation',
  }),
  [`${HOSTED_TEAM_MESSAGE_PAGE_HTTP_PATH}\u0000503`]: Object.freeze({
    code: 'unavailable',
    reason: 'team_message_unavailable',
    retryable: true,
    metadata: 'retry_after',
  }),
  [`${HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH}\u0000400`]: Object.freeze({
    code: 'invalid_request',
    reason: 'team_message_send_request_invalid',
    retryable: false,
    metadata: 'none',
  }),
  [`${HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH}\u0000404`]: Object.freeze({
    code: 'not_found',
    reason: 'team_message_not_found',
    retryable: false,
    metadata: 'none',
  }),
  [`${HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH}\u0000409`]: Object.freeze({
    code: 'conflict',
    reason: 'team_message_idempotency_conflict',
    retryable: false,
    metadata: 'none',
  }),
  [`${HOSTED_TEAM_MESSAGE_SEND_HTTP_PATH}\u0000503`]: Object.freeze({
    code: 'unavailable',
    reason: 'team_message_unavailable',
    retryable: true,
    metadata: 'retry_after',
  }),
} satisfies Readonly<Record<string, ExpectedHostedTeamMessageError>>);

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

/** Matches the HTTP status and every semantic discriminator before the transport maps an error. */
function matchHostedTeamMessageError(path: string, status: number, value: unknown): unknown | null {
  try {
    const expected: ExpectedHostedTeamMessageError | undefined =
      EXPECTED_ERROR_BY_ROUTE_AND_STATUS[`${path}\u0000${status}`];
    if (expected === undefined || !isRecord(value)) return null;
    const expectedKeys =
      expected.metadata === 'current_source_generation'
        ? ['schemaVersion', 'kind', 'error', 'retryable', 'currentSourceGeneration']
        : ['schemaVersion', 'kind', 'error', 'retryable'];
    if (!hasExactKeys(value, expectedKeys) || !isRecord(value.error)) return null;
    const hasRetryAfterMs =
      expected.metadata === 'retry_after' && Object.hasOwn(value.error, 'retryAfterMs');
    const errorKeys = hasRetryAfterMs ? ['code', 'reason', 'retryAfterMs'] : ['code', 'reason'];
    if (
      !hasExactKeys(value.error, errorKeys) ||
      (hasRetryAfterMs && value.error.retryAfterMs === undefined)
    ) {
      return null;
    }
    const schemaVersion = value.schemaVersion;
    const kind = value.kind;
    const error = createSafeAppError(value.error);
    const retryable = value.retryable;
    const currentSourceGeneration =
      expected.metadata === 'current_source_generation'
        ? parseHostedMessageSourceGeneration(value.currentSourceGeneration)
        : undefined;
    if (
      schemaVersion !== HOSTED_TEAM_MESSAGE_SCHEMA_VERSION ||
      kind !== 'error' ||
      error.code !== expected.code ||
      error.reason !== expected.reason ||
      retryable !== expected.retryable
    ) {
      return null;
    }
    return Object.freeze({
      schemaVersion: HOSTED_TEAM_MESSAGE_SCHEMA_VERSION,
      kind: 'error',
      error,
      retryable,
      ...(currentSourceGeneration === undefined ? {} : { currentSourceGeneration }),
    });
  } catch {
    return null;
  }
}

export type { HostedTeamMessagePanelProps } from './components/HostedTeamMessagePanel';
export { HostedTeamMessagePanel } from './components/HostedTeamMessagePanel';
export type { TeamMessageDeliveryRendererSliceDependencies } from './composition/createTeamMessageDeliveryRendererSlice';
export { createTeamMessageDeliveryRendererSlice } from './composition/createTeamMessageDeliveryRendererSlice';
export type {
  HostedTeamMessageFetchPort,
  HostedTeamMessageHttpRequestInit,
  HostedTeamMessageHttpResponse,
  HostedTeamMessageTransport,
  HostedTeamMessageTransportDependencies,
  HostedTeamMessageTransportOptions,
} from './ports/HostedTeamMessageRendererPorts';
export type {
  CrossTeamMessageAnalyticsInput,
  CrossTeamMessageDeliveryTransportPort,
  TeamMessageAttachmentAnalyticsInput,
  TeamMessageAttachmentReadPort,
  TeamMessageDeliveryAnalyticsPort,
  TeamMessageDeliveryClockPort,
  TeamMessageDeliveryDiagnosticsLogPort,
  TeamMessageDeliveryDiagnosticsPort,
  TeamMessageDeliveryDiagnosticsProjection,
  TeamMessageDeliveryErrorPolicyPort,
  TeamMessageDeliveryOptimisticMessagePort,
  TeamMessageDeliveryRefreshPort,
  TeamMessageDeliveryRendererSlice,
  TeamMessageDeliveryRendererSliceActions,
  TeamMessageDeliveryRendererSliceState,
  TeamMessageDeliveryRendererTransports,
  TeamMessageDeliveryRequestScopePort,
  TeamMessageDeliveryStatePort,
  TeamMessageDeliveryTarget,
  TeamMessageDeliveryTransportPort,
} from './ports/TeamMessageDeliveryRendererPorts';

export function createHostedTeamMessageTransport(
  dependencies: HostedTeamMessageTransportDependencies
): HostedTeamMessageTransport {
  return createStrictHostedTeamMessageTransport({
    ...dependencies,
    fetch: async (path, init): Promise<HostedTeamMessageHttpResponse> => {
      const response = await dependencies.fetch(path, init);
      if (response.status === 200) return response;
      let value: unknown = null;
      try {
        value = await response.json();
      } catch {
        // The delegated strict parser will fail closed over the cached null payload.
      }
      const accepted = matchHostedTeamMessageError(path, response.status, value);
      return Object.freeze({ status: response.status, json: async () => accepted });
    },
  });
}
