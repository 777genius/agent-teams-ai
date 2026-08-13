import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import { createSafeAppError } from '@shared/contracts/hosted';

import {
  parseCanonicalListTeamLifecycleResult,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '../contracts';
import {
  HOSTED_LIFECYCLE_COMMAND_ROUTES,
  HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
  isHostedLifecycleCommandAction,
  parseHostedLifecycleCommand,
  parseHostedLifecycleCommandPublicResult,
  parseHostedLifecycleControlState,
  parseHostedLifecycleControlStateRequest,
  parseHostedLifecyclePreparedState,
  parseHostedLifecyclePrepareRequest,
  parseHostedLifecycleProgressRequest,
  parseHostedLifecycleProvisioningStatus,
} from '../contracts/hosted-lifecycle-commands';

import type {
  CanonicalListTeamLifecycleResult,
  ListTeamLifecycleRequest,
  TeamLifecycleReadFailure,
  TeamLifecycleReadTransportApi,
} from '../contracts';
import type {
  HostedLifecycleCommand,
  HostedLifecycleCommandExecutionResult,
  HostedLifecycleCommandPublicResult,
  HostedLifecycleControlStateRequest,
  HostedLifecycleControlStateResult,
  HostedLifecyclePrepareRequest,
  HostedLifecyclePrepareResult,
  HostedLifecycleProgressRequest,
  HostedLifecycleProgressResult,
} from '../contracts/hosted-lifecycle-commands';

export const HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS = 10_000;

const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;
const JSON_HEADERS = Object.freeze({
  Accept: 'application/json',
  'Content-Type': 'application/json',
});

export interface HostedTeamLifecycleHttpResponse {
  readonly status: number;
  json(): Promise<unknown>;
}

export type HostedTeamLifecycleFetchPort = (
  input: string,
  init: Readonly<{
    method: 'POST';
    credentials: 'include';
    cache: 'no-store';
    headers: Readonly<Record<string, string>>;
    body: string;
    signal: AbortSignal;
  }>
) => Promise<HostedTeamLifecycleHttpResponse>;

export interface HostedTeamLifecycleTransportDependencies {
  readonly fetch: HostedTeamLifecycleFetchPort;
  readonly getCsrfToken: () => string | null;
}

export interface HostedTeamLifecycleTransport extends TeamLifecycleReadTransportApi {
  getControlState(
    request: HostedLifecycleControlStateRequest
  ): Promise<HostedLifecycleControlStateResult>;
  prepare(request: HostedLifecyclePrepareRequest): Promise<HostedLifecyclePrepareResult>;
  getProgress(request: HostedLifecycleProgressRequest): Promise<HostedLifecycleProgressResult>;
  execute(command: HostedLifecycleCommand): Promise<HostedLifecycleCommandExecutionResult>;
}

function failure(error: TeamLifecycleReadFailure['error']): TeamLifecycleReadFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error,
    retryable: error.code === 'unavailable',
  });
}

function readUnavailable(): TeamLifecycleReadFailure {
  return failure(
    createSafeAppError({
      code: 'unavailable',
      reason: 'transport_unavailable',
    }) as TeamLifecycleReadFailure['error']
  );
}

function commandUnavailable(): Extract<
  HostedLifecycleCommandPublicResult,
  { readonly kind: 'unavailable' }
> {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'unavailable',
    retryAfterMs: null,
  });
}

function invalidRequest(): Extract<
  HostedLifecycleControlStateResult,
  { readonly kind: 'invalid_request' }
> {
  return Object.freeze({
    schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
    kind: 'invalid_request',
  });
}

function readCsrfToken(dependencies: HostedTeamLifecycleTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
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

async function postJson(
  dependencies: HostedTeamLifecycleTransportDependencies,
  path: string,
  body: string
): Promise<Readonly<{ status: number; value: unknown }> | null> {
  const csrfToken = readCsrfToken(dependencies);
  if (csrfToken === null) return null;
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      controller.abort();
      reject(new Error('hosted-team-lifecycle-request-timeout'));
    }, HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await dependencies.fetch(path, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: Object.freeze({
            ...JSON_HEADERS,
            [HOSTED_AUTH_HEADERS.csrf]: csrfToken,
          }),
          body,
          signal: controller.signal,
        });
        return Object.freeze({ status: response.status, value: await response.json() });
      })(),
      deadline,
    ]);
  } catch {
    return null;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }
}

function commandMatchesResult(
  command: HostedLifecycleCommand,
  result: HostedLifecycleCommandPublicResult
): boolean {
  if (result.kind === 'unavailable') return true;
  if (
    result.action !== command.action ||
    result.commandId !== command.commandId ||
    result.workspaceId !== command.workspaceId ||
    result.teamId !== command.teamId
  ) {
    return false;
  }
  return (
    (result.kind !== 'accepted' && result.kind !== 'idempotent_replay') ||
    command.action === 'launch' ||
    result.runId === command.runId
  );
}

function commandStatusMatches(status: number, result: HostedLifecycleCommandPublicResult): boolean {
  switch (result.kind) {
    case 'accepted':
    case 'started':
      return status === 202;
    case 'idempotent_replay':
      return status === 200;
    case 'conflict':
    case 'operator_required':
      return status === 409;
    case 'not_found':
      return status === 404;
    case 'unavailable':
      return status === 503;
  }
}

function parseControlStateResult(
  status: number,
  value: unknown,
  request: HostedLifecycleControlStateRequest
): HostedLifecycleControlStateResult | null {
  const state = parseHostedLifecycleControlState(value);
  if (status === 200 && state.ok) {
    return state.value.workspaceId === request.workspaceId && state.value.teamId === request.teamId
      ? state.value
      : null;
  }
  if (!isRecord(value) || value.schemaVersion !== HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION) {
    return null;
  }
  if (
    status === 400 &&
    value.kind === 'invalid_request' &&
    hasExactKeys(value, ['schemaVersion', 'kind'])
  ) {
    return invalidRequest();
  }
  if (
    status === 404 &&
    value.kind === 'not_found' &&
    hasExactKeys(value, ['schemaVersion', 'kind'])
  ) {
    return Object.freeze({
      schemaVersion: HOSTED_LIFECYCLE_COMMAND_SCHEMA_VERSION,
      kind: 'not_found',
    });
  }
  const unavailable = parseHostedLifecycleCommandPublicResult(value);
  return status === 503 && unavailable.ok && unavailable.value.kind === 'unavailable'
    ? unavailable.value
    : null;
}

function parseProjectionResult(
  status: number,
  value: unknown,
  request: HostedLifecycleControlStateRequest,
  kind: 'prepare'
): HostedLifecyclePrepareResult | null;
function parseProjectionResult(
  status: number,
  value: unknown,
  request: HostedLifecycleControlStateRequest,
  kind: 'progress'
): HostedLifecycleProgressResult | null;
function parseProjectionResult(
  status: number,
  value: unknown,
  request: HostedLifecycleControlStateRequest,
  kind: 'prepare' | 'progress'
): HostedLifecyclePrepareResult | HostedLifecycleProgressResult | null {
  const parsed =
    kind === 'prepare'
      ? parseHostedLifecyclePreparedState(value)
      : parseHostedLifecycleProvisioningStatus(value);
  if (status === 200 && parsed.ok) {
    return parsed.value.workspaceId === request.workspaceId &&
      parsed.value.teamId === request.teamId
      ? parsed.value
      : null;
  }
  const fallback = parseControlStateResult(status, value, request);
  return fallback?.kind === 'control_state' ? null : fallback;
}

/** Creates the browser-only lifecycle read/command transport without loading the desktop API. */
export function createHostedTeamLifecycleTransport(
  dependencies: HostedTeamLifecycleTransportDependencies
): HostedTeamLifecycleTransport {
  return Object.freeze({
    async listTeamLifecycle(
      requestValue: ListTeamLifecycleRequest
    ): Promise<CanonicalListTeamLifecycleResult> {
      const request = parseListTeamLifecycleRequest(requestValue);
      if (!request.ok) {
        return failure(request.error as TeamLifecycleReadFailure['error']);
      }
      const response = await postJson(
        dependencies,
        TEAM_LIFECYCLE_LIST_ROUTE,
        JSON.stringify(request.value)
      );
      if (response === null || response.status !== 200) return readUnavailable();
      const parsed = parseCanonicalListTeamLifecycleResult(response.value);
      return parsed.ok ? parsed.value : failure(parsed.error as TeamLifecycleReadFailure['error']);
    },

    async getControlState(
      requestValue: HostedLifecycleControlStateRequest
    ): Promise<HostedLifecycleControlStateResult> {
      const request = parseHostedLifecycleControlStateRequest(requestValue);
      if (!request.ok) return invalidRequest();
      const response = await postJson(
        dependencies,
        HOSTED_LIFECYCLE_COMMAND_ROUTES.controlState,
        JSON.stringify(request.value)
      );
      if (response === null) return commandUnavailable();
      return (
        parseControlStateResult(response.status, response.value, request.value) ??
        commandUnavailable()
      );
    },

    async prepare(
      requestValue: HostedLifecyclePrepareRequest
    ): Promise<HostedLifecyclePrepareResult> {
      const request = parseHostedLifecyclePrepareRequest(requestValue);
      if (!request.ok) return invalidRequest();
      const response = await postJson(
        dependencies,
        HOSTED_LIFECYCLE_COMMAND_ROUTES.prepare,
        JSON.stringify(request.value)
      );
      if (response === null) return commandUnavailable();
      return (
        parseProjectionResult(response.status, response.value, request.value, 'prepare') ??
        commandUnavailable()
      );
    },

    async getProgress(
      requestValue: HostedLifecycleProgressRequest
    ): Promise<HostedLifecycleProgressResult> {
      const request = parseHostedLifecycleProgressRequest(requestValue);
      if (!request.ok) return invalidRequest();
      const response = await postJson(
        dependencies,
        HOSTED_LIFECYCLE_COMMAND_ROUTES.progress,
        JSON.stringify(request.value)
      );
      if (response === null) return commandUnavailable();
      return (
        parseProjectionResult(response.status, response.value, request.value, 'progress') ??
        commandUnavailable()
      );
    },

    async execute(
      commandValue: HostedLifecycleCommand
    ): Promise<HostedLifecycleCommandExecutionResult> {
      if (!isRecord(commandValue) || !isHostedLifecycleCommandAction(commandValue.action)) {
        return invalidRequest();
      }
      const { action, ...body } = commandValue;
      const command = parseHostedLifecycleCommand(action, body);
      if (!command.ok) return invalidRequest();
      const response = await postJson(
        dependencies,
        HOSTED_LIFECYCLE_COMMAND_ROUTES[action],
        JSON.stringify(body)
      );
      if (response === null) return commandUnavailable();
      const result = parseHostedLifecycleCommandPublicResult(response.value);
      return result.ok &&
        commandMatchesResult(command.value, result.value) &&
        commandStatusMatches(response.status, result.value)
        ? result.value
        : commandUnavailable();
    },
  });
}
