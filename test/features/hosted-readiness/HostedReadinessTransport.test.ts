import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_ROUTE,
  HOSTED_READINESS_SCHEMA_VERSION,
  type HostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import {
  createHostedReadinessTransport,
  HostedReadinessTransportError,
} from '@features/hosted-readiness/renderer';
import { parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const DEPLOYMENT_ID = parseDeploymentId('deployment_transport');
const BOOT_ID = parseBootId('boot_transport');

function projection(
  revision: number,
  overrides: Partial<HostedReadinessProjection> = {}
): HostedReadinessProjection {
  return {
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    revision,
    requiredReadiness: ['serve', 'auth'],
    dimensions: HOSTED_READINESS_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'ready',
      reasons: [],
    })),
    terminal: { dimension: 'terminal', status: 'not_offered', reasons: [] },
    facets: [
      {
        facetId: 'team.lifecycle',
        availability: 'temporarily_unavailable',
        requiredReadiness: ['runtime-control'],
        reasons: ['provider_unavailable'],
      },
    ],
    actions: [
      {
        actionId: 'team.lifecycle.launch',
        facetId: 'team.lifecycle',
        implementation: 'implemented',
        availability: 'temporarily_unavailable',
        requiredReadiness: ['runtime-control'],
        reasons: ['provider_unavailable'],
      },
    ],
    ...overrides,
  };
}

function response(body: unknown, status = 200) {
  return { status, json: vi.fn(async () => body) };
}

function transport(fetch: ReturnType<typeof vi.fn>, timeoutMs?: number) {
  return createHostedReadinessTransport({
    fetch,
    expectedDeploymentId: DEPLOYMENT_ID,
    expectedBootId: BOOT_ID,
    timeoutMs,
  });
}

describe('hosted readiness renderer transport', () => {
  it('uses the exact authenticated no-store GET and preserves temporary denial as implemented', async () => {
    const fetch = vi.fn(async () => response(projection(1)));
    const client = transport(fetch);

    const result = await client.load();

    expect(fetch).toHaveBeenCalledWith(HOSTED_READINESS_ROUTE, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: expect.any(AbortSignal),
    });
    expect(result.actions[0]).toMatchObject({
      implementation: 'implemented',
      availability: 'temporarily_unavailable',
      reasons: ['provider_unavailable'],
    });
  });

  it('rejects extra response keys rather than projecting private diagnostics', async () => {
    const fetch = vi.fn(async () =>
      response({ ...projection(1), checks: [{ probeId: 'probe.private' }], path: '/private/path' })
    );
    await expect(transport(fetch).load()).rejects.toMatchObject({ code: 'response_invalid' });
  });

  it('rejects stale deployment, boot, revision, and equal-revision conflicts', async () => {
    const deploymentFetch = vi.fn(async () =>
      response({ ...projection(1), deploymentId: 'deployment_stale' })
    );
    await expect(transport(deploymentFetch).load()).rejects.toMatchObject({
      code: 'stale_deployment',
    });

    const bootFetch = vi.fn(async () => response({ ...projection(1), bootId: 'boot_stale' }));
    await expect(transport(bootFetch).load()).rejects.toMatchObject({ code: 'stale_boot' });

    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response(projection(2)))
      .mockResolvedValueOnce(response(projection(1)))
      .mockResolvedValueOnce(
        response(
          projection(2, {
            requiredReadiness: ['serve'],
          })
        )
      );
    const client = transport(fetch);
    await expect(client.load()).resolves.toMatchObject({ revision: 2 });
    await expect(client.load()).rejects.toMatchObject({ code: 'stale_revision' });
    await expect(client.load()).rejects.toMatchObject({ code: 'revision_conflict' });
  });

  it('honors caller cancellation and a bounded deadline', async () => {
    vi.useFakeTimers();
    try {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn((_input, init: { signal: AbortSignal }) => {
        signals.push(init.signal);
        return new Promise(() => undefined);
      });
      const caller = new AbortController();
      const cancelled = transport(fetch, 20).load(caller.signal);
      await Promise.resolve();
      caller.abort();
      await expect(cancelled).rejects.toEqual(
        expect.objectContaining({ code: 'request_cancelled' })
      );
      expect(signals[0]?.aborted).toBe(true);

      const deadline = transport(fetch, 20).load();
      const deadlineAssertion = expect(deadline).rejects.toEqual(
        expect.objectContaining({ code: 'deadline_exceeded' })
      );
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(20);
      await deadlineAssertion;
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses only bounded transport errors and never fabricates an unimplemented action', async () => {
    const fetch = vi.fn(async () => response({}, 503));
    const error = await transport(fetch)
      .load()
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(HostedReadinessTransportError);
    expect(error).toMatchObject({ code: 'transport_unavailable' });
    expect(error).not.toHaveProperty('projection');
    expect(error).not.toHaveProperty('actions');
  });
});
