import {
  createHostedDiagnosticsFailure,
  HOSTED_DIAGNOSTICS_QUERY_ROUTE,
  HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  type HostedDiagnosticsResponse,
  parseDiagnosticId,
  parseOperationalReferenceId,
  parseOperationCorrelationId,
} from '@features/hosted-operations/contracts';
import {
  createHostedDiagnosticsFeature,
  createHostedDiagnosticsRouteContribution,
  HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
  type HostedDiagnosticsHttpFacade,
  registerHostedDiagnosticsHttp,
} from '@features/hosted-operations/main/hosted';
import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  HostedRouteAdmission,
} from '@main/composition/hosted/application';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const REFERENCE_ID = parseOperationalReferenceId(`reference_${'1'.repeat(32)}`);
const REQUEST_ID = parseOperationCorrelationId(`request_${'2'.repeat(32)}`);
const DIAGNOSTIC_ID = parseDiagnosticId(`diagnostic_${'3'.repeat(32)}`);
const PRIVATE_VALUE = ['private', 'path', 'provider', 'stderr', 'token'].join('-');

const successResponse: HostedDiagnosticsResponse = Object.freeze({
  schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION,
  kind: 'success',
  correlation: Object.freeze({ requestId: REQUEST_ID, diagnosticId: DIAGNOSTIC_ID }),
  items: Object.freeze([
    Object.freeze({
      referenceId: REFERENCE_ID,
      kind: 'reference_load',
      outcome: 'succeeded',
      occurredAtMonotonicMs: 10,
      attributes: Object.freeze({ component: 'reference_loader', operation: 'load' }),
      byteLength: 20,
    }),
  ]),
  totalBytes: 20,
});

function makeContext(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_http-diagnostics',
    sessionId: 'session_http-diagnostics',
    deploymentId: 'deployment_http-diagnostics',
    bootId: 'boot_http-diagnostics',
    requestId: REQUEST_ID,
    authorizedScope: 'scope_http-diagnostics',
    deadlineAtMs: 10_000,
    signal,
  });
}

function request() {
  return { schemaVersion: HOSTED_DIAGNOSTICS_SCHEMA_VERSION, referenceIds: [REFERENCE_ID] };
}

async function createApp(
  response: unknown = successResponse,
  routeAdmission: HostedRouteAdmission = readyAdmission()
) {
  const facade: HostedDiagnosticsHttpFacade = {
    getDiagnostics: vi.fn(async () => response as HostedDiagnosticsResponse),
  };
  const createContext = vi.fn((_descriptor, _request, signal: AbortSignal) => makeContext(signal));
  const app = Fastify();
  registerHostedDiagnosticsHttp(
    app,
    Object.freeze({
      id: 'hosted-operations.diagnostics.hosted.v1',
      facade,
      routes: HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS,
    }),
    routeAdmission,
    createContext
  );
  await app.ready();
  return { app, createContext, facade };
}

function readyAdmission(): HostedRouteAdmission {
  const dimensions = Object.freeze({
    ...Object.fromEntries(
      HOSTED_READINESS_DIMENSIONS.map((dimension) => [
        dimension,
        Object.freeze({ dimension, status: 'ready' as const, reasons: Object.freeze([]) }),
      ])
    ),
    terminal: HOSTED_TERMINAL_READINESS,
  }) as HostedReadinessDimensionStates;
  return new HostedRouteAdmission(createRouteCatalog(HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS), {
    readiness: async () => ({ revision: 1, dimensions }),
  });
}

describe('hosted diagnostics HTTP contribution', () => {
  it('publishes one production-valid read-only route contribution', () => {
    const catalog = createRouteCatalog(HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS, 'production');
    const feature = createHostedDiagnosticsFeature({
      correlationIds: { resolveCorrelationId: () => REQUEST_ID },
      deadlineScheduler: {
        nowMs: () => 0,
        schedule: () => () => undefined,
      },
      diagnosticIds: { generateDiagnosticId: () => DIAGNOSTIC_ID },
      source: {
        async load() {
          throw new Error('not invoked');
        },
      },
    });
    const contribution = createHostedDiagnosticsRouteContribution(feature);

    expect(catalog.routes).toHaveLength(1);
    expect(catalog.routes[0]).toMatchObject({
      method: 'POST',
      path: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
      owner: 'hosted-operations',
      trustKind: 'browser',
      readiness: ['serve', 'auth', 'read'],
    });
    expect(contribution.facade).toBe(feature);
    expect(contribution.routes).toBe(HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS);
    expect(Object.isFrozen(contribution)).toBe(true);
  });

  it('rejects a copied route descriptor before registering the handler', async () => {
    const app = Fastify();
    expect(() =>
      registerHostedDiagnosticsHttp(
        app,
        Object.freeze({
          id: 'hosted-operations.diagnostics.hosted.v1',
          facade: { getDiagnostics: vi.fn() },
          routes: Object.freeze([{ ...HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS[0] }]),
        }),
        readyAdmission(),
        (_descriptor, _request, signal) => makeContext(signal)
      )
    ).toThrow('hosted-diagnostics-route-contribution-invalid');
    await app.close();
  });

  it('serves a no-store safe response through an injected QueryContext', async () => {
    const { app, createContext, facade } = await createApp();
    const body = request();
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload: body,
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual(successResponse);
      expect(createContext).toHaveBeenCalledOnce();
      expect(createContext.mock.calls[0][0]).toBe(HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS[0]);
      expect(createContext.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
      expect(facade.getDiagnostics).toHaveBeenCalledWith(body, expect.any(Object));
    } finally {
      await app.close();
    }
  });

  it.each([
    [createHostedDiagnosticsFailure('request_invalid', DIAGNOSTIC_ID), 400],
    [createHostedDiagnosticsFailure('reference_budget_exceeded', DIAGNOSTIC_ID), 413],
    [createHostedDiagnosticsFailure('request_cancelled', DIAGNOSTIC_ID), 503],
    [createHostedDiagnosticsFailure('diagnostics_unavailable', DIAGNOSTIC_ID), 503],
  ])('maps a typed safe failure to HTTP status %i', async (failure, status) => {
    const { app } = await createApp(failure);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload: request(),
      });

      expect(response.statusCode).toBe(status);
      expect(response.json()).toEqual(failure);
      expect(response.body).not.toContain(PRIVATE_VALUE);
    } finally {
      await app.close();
    }
  });

  it('rejects a facade response that tries to add raw diagnostics', async () => {
    const malicious = {
      ...successResponse,
      items: [
        {
          ...successResponse.items[0],
          rawPath: `/private/${PRIVATE_VALUE}`,
          providerStderr: PRIVATE_VALUE,
        },
      ],
    };
    const { app } = await createApp(malicious);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload: request(),
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual(createHostedDiagnosticsFailure('response_invalid'));
      expect(response.body).not.toContain(PRIVATE_VALUE);
      expect(response.body).not.toContain('rawPath');
      expect(response.body).not.toContain('providerStderr');
    } finally {
      await app.close();
    }
  });

  it('returns 503 on admission rejection without creating context or invoking diagnostics', async () => {
    const invoke = vi.fn(async () => ({
      admitted: false as const,
      routeId: HOSTED_DIAGNOSTICS_ROUTE_DESCRIPTORS[0].id,
      revision: 2,
      statusCode: 503 as const,
      reason: { code: 'required_readiness_unavailable' as const, dimensions: ['read'] as const },
    }));
    const { app, createContext, facade } = await createApp(successResponse, {
      invoke,
    } as unknown as HostedRouteAdmission);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_DIAGNOSTICS_QUERY_ROUTE,
        payload: request(),
      });
      expect(response.statusCode).toBe(503);
      expect(createContext).not.toHaveBeenCalled();
      expect(facade.getDiagnostics).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
