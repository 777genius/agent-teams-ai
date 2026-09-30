import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_READINESS_ROUTE,
  HOSTED_READINESS_SCHEMA_VERSION,
  type HostedReadinessProjection,
} from '@features/hosted-readiness/contracts';
import {
  createHostedReadinessFeature,
  createHostedReadinessRouteContribution,
  HOSTED_READINESS_ROUTE_DESCRIPTORS,
  type HostedReadinessHttpFacade,
  registerHostedReadinessHttp,
} from '@features/hosted-readiness/main/hosted';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseBootId, parseDeploymentId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const DEPLOYMENT_ID = parseDeploymentId('deployment_http_readiness');
const BOOT_ID = parseBootId('boot_http_readiness');

function projection(): HostedReadinessProjection {
  return {
    schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
    kind: 'success',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    revision: 1,
    requiredReadiness: ['serve', 'auth'],
    dimensions: HOSTED_READINESS_DIMENSIONS.map((dimension) => ({
      dimension,
      status: 'ready',
      reasons: [],
    })),
    terminal: { dimension: 'terminal', status: 'not_offered', reasons: [] },
    facets: [],
    actions: [],
  };
}

function context(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_http_readiness',
    sessionId: 'session_http_readiness',
    deploymentId: DEPLOYMENT_ID,
    bootId: BOOT_ID,
    requestId: 'request_http_readiness',
    authorizedScope: 'scope_authenticated-hosted-query',
    deadlineAtMs: Date.now() + 10_000,
    signal,
  });
}

async function appFor(response: unknown = projection()) {
  const facade: HostedReadinessHttpFacade = {
    getReadiness: vi.fn(async () => response as HostedReadinessProjection),
  };
  const createContext = vi.fn((_request, signal: AbortSignal) => context(signal));
  const app = Fastify();
  registerHostedReadinessHttp(app, facade, createContext);
  await app.ready();
  return { app, createContext, facade };
}

describe('hosted readiness HTTP', () => {
  it('declares one authenticated browser GET with serve+auth static readiness only', () => {
    const catalog = createRouteCatalog(HOSTED_READINESS_ROUTE_DESCRIPTORS, 'production');
    const feature = createHostedReadinessFeature({
      source: { readProjection: () => projection() },
    });
    const contribution = createHostedReadinessRouteContribution(feature);

    expect(catalog.routes).toHaveLength(1);
    expect(catalog.routes[0]).toEqual(
      expect.objectContaining({
        method: 'GET',
        path: HOSTED_READINESS_ROUTE,
        owner: 'hosted-readiness',
        trustKind: 'browser',
        authPolicyId: 'hosted.browser.session',
        readiness: ['serve', 'auth'],
        testOnly: false,
      })
    );
    expect(contribution.facade).toBe(feature);
    expect(contribution.routes).toBe(HOSTED_READINESS_ROUTE_DESCRIPTORS);
    expect(Object.isFrozen(contribution)).toBe(true);
  });

  it('serves only the strict projection through authenticated QueryContext with no-store', async () => {
    const { app, createContext, facade } = await appFor();
    try {
      const response = await app.inject({ method: 'GET', url: HOSTED_READINESS_ROUTE });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(projection());
      expect(createContext).toHaveBeenCalledOnce();
      expect(createContext.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal);
      expect(facade.getReadiness).toHaveBeenCalledWith(
        expect.objectContaining({
          authorizedScope: 'scope_authenticated-hosted-query',
          deploymentId: DEPLOYMENT_ID,
          bootId: BOOT_ID,
        })
      );
    } finally {
      await app.close();
    }
  });

  it('revalidates facade output and never exposes private diagnostics', async () => {
    const privateValue = 'private-host-provider-command-secret';
    const malicious = {
      ...projection(),
      checks: [{ probeId: 'probe.internal', path: `/private/${privateValue}` }],
      providerOutput: privateValue,
    };
    const { app } = await appFor(malicious);
    try {
      const response = await app.inject({ method: 'GET', url: HOSTED_READINESS_ROUTE });

      expect(response.statusCode).toBe(500);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
        kind: 'failure',
        reason: 'response_invalid',
      });
      expect(response.body).not.toContain(privateValue);
      expect(response.body).not.toContain('probeId');
      expect(response.body).not.toContain('checks');
    } finally {
      await app.close();
    }
  });

  it('maps context/source failure to one bounded safe no-store response', async () => {
    const app = Fastify();
    registerHostedReadinessHttp(app, { getReadiness: vi.fn() }, () => {
      throw new Error('private hostname, path, command, provider output and secret');
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: HOSTED_READINESS_ROUTE });
      expect(response.statusCode).toBe(503);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        schemaVersion: HOSTED_READINESS_SCHEMA_VERSION,
        kind: 'failure',
        reason: 'readiness_unavailable',
      });
      expect(response.body).not.toContain('private hostname');
    } finally {
      await app.close();
    }
  });
});
