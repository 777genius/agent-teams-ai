import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';
import {
  parseCanonicalListTeamLifecycleResult,
  parseListTeamLifecycleRequest,
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import { createSafeAppError } from '@shared/contracts/hosted';

import type {
  CanonicalListTeamLifecycleResult,
  ListTeamLifecycleRequest,
  TeamLifecycleReadFailure,
  TeamLifecycleReadTransportApi,
} from '@features/team-lifecycle/contracts';

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

function failure(error: TeamLifecycleReadFailure['error']): TeamLifecycleReadFailure {
  return Object.freeze({
    schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
    kind: 'failure',
    error,
    retryable: error.code === 'unavailable',
  });
}

function unavailable(): TeamLifecycleReadFailure {
  return failure(
    createSafeAppError({
      code: 'unavailable',
      reason: 'transport_unavailable',
    }) as TeamLifecycleReadFailure['error']
  );
}

function readCsrfToken(dependencies: HostedTeamLifecycleTransportDependencies): string | null {
  try {
    const value: unknown = dependencies.getCsrfToken();
    return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** Creates the browser-only lifecycle list transport without loading the desktop renderer API. */
export function createHostedTeamLifecycleTransport(
  dependencies: HostedTeamLifecycleTransportDependencies
): TeamLifecycleReadTransportApi {
  return Object.freeze({
    async listTeamLifecycle(
      requestValue: ListTeamLifecycleRequest
    ): Promise<CanonicalListTeamLifecycleResult> {
      const request = parseListTeamLifecycleRequest(requestValue);
      if (!request.ok) {
        return failure(request.error as TeamLifecycleReadFailure['error']);
      }
      const csrfToken = readCsrfToken(dependencies);
      if (csrfToken === null) return unavailable();

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS);
      try {
        const response = await dependencies.fetch(TEAM_LIFECYCLE_LIST_ROUTE, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: Object.freeze({
            ...JSON_HEADERS,
            [HOSTED_AUTH_HEADERS.csrf]: csrfToken,
          }),
          body: JSON.stringify(request.value),
          signal: controller.signal,
        });
        if (response.status !== 200) return unavailable();

        const parsed = parseCanonicalListTeamLifecycleResult(await response.json());
        return parsed.ok
          ? parsed.value
          : failure(parsed.error as TeamLifecycleReadFailure['error']);
      } catch {
        return unavailable();
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}
