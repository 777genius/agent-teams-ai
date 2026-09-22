import { HOSTED_AUTH_HEADERS } from '@features/hosted-access/contracts';

import {
  HOSTED_WORKSPACE_REGISTRY_ROUTES,
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  parseHostedWorkspaceRegistryListResponse,
  parseHostedWorkspaceRegistrySelectRequest,
  parseHostedWorkspaceRegistrySelectResponse,
} from '../../contracts';
import {
  type CreateHostedWorkspaceRegistryTransportDependencies,
  type HostedWorkspaceRegistryRendererPort,
  HostedWorkspaceRegistryTransportError,
} from '../ports/HostedWorkspaceRegistryRendererPorts';

import type { WorkspaceId } from '@shared/contracts/hosted';

export const HOSTED_WORKSPACE_REGISTRY_TRANSPORT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const CSRF_TOKEN = /^[A-Za-z0-9_-]{32,512}$/;

export function createHostedWorkspaceRegistryTransport(
  dependencies: CreateHostedWorkspaceRegistryTransportDependencies
): HostedWorkspaceRegistryRendererPort {
  if (!dependencies || typeof dependencies.fetch !== 'function') {
    throw new TypeError('hosted-workspace-registry-transport-dependencies-invalid');
  }
  const timeoutMs = dependencies.timeoutMs ?? HOSTED_WORKSPACE_REGISTRY_TRANSPORT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError('hosted-workspace-registry-transport-timeout-invalid');
  }

  const send = async <T>(
    route: string,
    body: unknown,
    parseResponse: (value: unknown) => T,
    signal?: AbortSignal
  ): Promise<T> => {
    if (signal?.aborted) throw new HostedWorkspaceRegistryTransportError('request_cancelled');
    let csrfToken: string | null;
    try {
      csrfToken = dependencies.getCsrfToken();
    } catch {
      csrfToken = null;
    }
    if (typeof csrfToken !== 'string' || !CSRF_TOKEN.test(csrfToken)) {
      throw new HostedWorkspaceRegistryTransportError('transport_unavailable');
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    const deadlineAt = Date.now() + timeoutMs;
    let deadlineExpired = false;
    const timer = setTimeout(() => {
      deadlineExpired = true;
      controller.abort();
    }, timeoutMs);
    try {
      const response = await raceAbort(
        dependencies.fetch(route, {
          method: 'POST',
          credentials: 'include',
          cache: 'no-store',
          headers: Object.freeze({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            [HOSTED_AUTH_HEADERS.csrf]: csrfToken,
          }),
          body: JSON.stringify(body),
          signal: controller.signal,
        }),
        controller.signal
      );
      assertWithinDeadline(deadlineAt, signal);
      if (response.status === 404) throw new HostedWorkspaceRegistryTransportError('not_found');
      if (response.status === 400) {
        throw new HostedWorkspaceRegistryTransportError('invalid_request');
      }
      if (response.status !== 200 || typeof response.json !== 'function') {
        throw new HostedWorkspaceRegistryTransportError('transport_unavailable');
      }
      const payload = await raceAbort(response.json(), controller.signal);
      assertWithinDeadline(deadlineAt, signal);
      try {
        const result = parseResponse(payload);
        assertWithinDeadline(deadlineAt, signal);
        return result;
      } catch (error) {
        if (error instanceof HostedWorkspaceRegistryTransportError) throw error;
        throw new HostedWorkspaceRegistryTransportError('response_invalid');
      }
    } catch (error) {
      if (error instanceof HostedWorkspaceRegistryTransportError) throw error;
      if (signal?.aborted) throw new HostedWorkspaceRegistryTransportError('request_cancelled');
      if (deadlineExpired || Date.now() >= deadlineAt) {
        throw new HostedWorkspaceRegistryTransportError('transport_unavailable');
      }
      throw new HostedWorkspaceRegistryTransportError('transport_unavailable');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (!controller.signal.aborted) controller.abort();
    }
  };

  return Object.freeze({
    async list(signal?: AbortSignal) {
      return await send(
        HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
        { schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION },
        parseHostedWorkspaceRegistryListResponse,
        signal
      );
    },
    async select(workspaceId: WorkspaceId, signal?: AbortSignal) {
      let request;
      try {
        request = parseHostedWorkspaceRegistrySelectRequest({
          schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
          workspaceId,
        });
      } catch {
        throw new HostedWorkspaceRegistryTransportError('invalid_request');
      }
      return await send(
        HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
        request,
        parseHostedWorkspaceRegistrySelectResponse,
        signal
      );
    },
  });
}

function assertWithinDeadline(deadlineAt: number, signal?: AbortSignal): void {
  if (signal?.aborted) throw new HostedWorkspaceRegistryTransportError('request_cancelled');
  if (Date.now() >= deadlineAt) {
    throw new HostedWorkspaceRegistryTransportError('transport_unavailable');
  }
}

function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('hosted-workspace-registry-request-ended'));
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new Error('hosted-workspace-registry-request-ended'));
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
