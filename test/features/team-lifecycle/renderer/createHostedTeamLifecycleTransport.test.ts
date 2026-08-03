import {
  TEAM_LIFECYCLE_LIST_ROUTE,
  TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
} from '@features/team-lifecycle/contracts';
import {
  createHostedTeamLifecycleTransport,
  HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS,
} from '@features/team-lifecycle/renderer';
import { parseRevision, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  CanonicalListTeamLifecycleResult,
  ListTeamLifecycleRequest,
} from '@features/team-lifecycle/contracts';
import type { HostedTeamLifecycleFetchPort } from '@features/team-lifecycle/renderer';

const request: ListTeamLifecycleRequest = Object.freeze({
  schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  cursor: null,
  expectedRevision: null,
});
const success: CanonicalListTeamLifecycleResult = Object.freeze({
  schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
  kind: 'success',
  snapshotRevision: parseRevision('revision_hosted-transport'),
  items: Object.freeze([
    Object.freeze({
      workspaceId: parseWorkspaceId(`workspace_${'a'.repeat(32)}`),
      teamId: parseTeamId(`team_${'b'.repeat(32)}`),
      displayName: 'Hosted team',
      lifecycle: 'ready',
      revision: parseRevision('revision_hosted-team'),
    }),
  ]),
  nextCursor: null,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createHostedTeamLifecycleTransport', () => {
  it('sends the exact authenticated no-store request and validates the canonical response', async () => {
    const fetch = vi.fn<HostedTeamLifecycleFetchPort>().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve(success),
    });
    const transport = createHostedTeamLifecycleTransport({
      fetch,
      getCsrfToken: () => 'c'.repeat(32),
    });

    await expect(transport.listTeamLifecycle(request)).resolves.toEqual(success);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0]).toBe(TEAM_LIFECYCLE_LIST_ROUTE);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      credentials: 'include',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'x-agent-teams-csrf': 'c'.repeat(32),
      },
      body: JSON.stringify(request),
      signal: expect.any(AbortSignal),
    });
  });

  it('fails closed before I/O for an invalid request or missing CSRF authority', async () => {
    const fetch = vi.fn<HostedTeamLifecycleFetchPort>();
    const invalidRequestTransport = createHostedTeamLifecycleTransport({
      fetch,
      getCsrfToken: () => 'c'.repeat(32),
    });

    await expect(
      invalidRequestTransport.listTeamLifecycle({ ...request, unexpected: true } as never)
    ).resolves.toMatchObject({
      kind: 'failure',
      retryable: false,
      error: { code: 'invalid_request', reason: 'request_invalid' },
    });
    const missingCsrfTransport = createHostedTeamLifecycleTransport({
      fetch,
      getCsrfToken: () => null,
    });
    await expect(missingCsrfTransport.listTeamLifecycle(request)).resolves.toMatchObject({
      kind: 'failure',
      retryable: true,
      error: { code: 'unavailable', reason: 'transport_unavailable' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves validated typed failures and hides malformed or private transport failures', async () => {
    const sourceFailure: CanonicalListTeamLifecycleResult = Object.freeze({
      schemaVersion: TEAM_LIFECYCLE_READ_SCHEMA_VERSION,
      kind: 'failure',
      error: Object.freeze({ code: 'conflict', reason: 'snapshot_changed' }),
      retryable: false,
    });
    const fetch = vi
      .fn<HostedTeamLifecycleFetchPort>()
      .mockResolvedValueOnce({ status: 200, json: () => Promise.resolve(sourceFailure) })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ privatePath: '/private/team' }),
      })
      .mockRejectedValueOnce(new Error('/private/team could not be read'))
      .mockResolvedValueOnce({ status: 503, json: () => Promise.resolve(sourceFailure) });
    const transport = createHostedTeamLifecycleTransport({
      fetch,
      getCsrfToken: () => 'd'.repeat(32),
    });

    await expect(transport.listTeamLifecycle(request)).resolves.toEqual(sourceFailure);
    await expect(transport.listTeamLifecycle(request)).resolves.toMatchObject({
      kind: 'failure',
      retryable: false,
      error: { code: 'internal', reason: 'source_response_invalid' },
    });
    for (let index = 0; index < 2; index += 1) {
      const result = await transport.listTeamLifecycle(request);
      expect(result).toMatchObject({
        kind: 'failure',
        retryable: true,
        error: { code: 'unavailable', reason: 'transport_unavailable' },
      });
      expect(JSON.stringify(result)).not.toContain('/private/team');
    }
  });

  it('aborts the request at the fixed ten-second boundary and clears the timer', async () => {
    vi.useFakeTimers();
    let receivedSignal: AbortSignal | null = null;
    const fetch = vi.fn<HostedTeamLifecycleFetchPort>().mockImplementation((_input, init) => {
      receivedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError'))
        );
      });
    });
    const transport = createHostedTeamLifecycleTransport({
      fetch,
      getCsrfToken: () => 'e'.repeat(32),
    });

    const result = transport.listTeamLifecycle(request);
    await vi.advanceTimersByTimeAsync(HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS - 1);
    expect((receivedSignal as AbortSignal | null)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toMatchObject({
      kind: 'failure',
      retryable: true,
      error: { code: 'unavailable', reason: 'transport_unavailable' },
    });
    expect((receivedSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
