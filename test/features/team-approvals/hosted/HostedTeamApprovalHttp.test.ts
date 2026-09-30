import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';

import {
  bindProductHostedProducerInstance,
  clearProductHostedProducerProvenance,
  type HostedProducerProvenance,
  installProductHostedProducerProvenance,
} from '@features/hosted-producer-provenance/main/hosted';
import {
  HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
  parseHostedTeamApprovalGeneration,
  parseHostedTeamApprovalId,
  parseHostedTeamApprovalPreviewRef,
} from '@features/team-approvals/contracts';
import {
  createHostedTeamApprovalsFeature,
  createHostedTeamApprovalsRouteContribution,
  HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
  HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
  HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
  HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
  type HostedTeamApprovalsContextFactory,
  type HostedTeamApprovalsHttpFacade,
  type HostedTeamApprovalsHttpGeneration,
  registerHostedTeamApprovalsHttp,
} from '@features/team-approvals/main/hosted';
import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  HostedRouteAdmission,
} from '@main/composition/hosted/application';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseRunId, parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const runId = parseRunId(`run_${'d'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_http-1');
const replacementGeneration = parseHostedTeamApprovalGeneration('generation_http-2');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_http-1');

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function makeContext(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_approval-http',
    sessionId: 'session_approval-http',
    deploymentId: 'deployment_approval-http',
    bootId: 'boot_approval-http',
    requestId: 'request_approval-http',
    authorizedScope: 'scope_approval-http',
    deadlineAtMs: 10_000,
    signal,
  });
}

function page() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_page' as const,
    teamId,
    items: [
      {
        teamId,
        runId,
        approvalId,
        generation,
        category: 'file_change' as const,
        summary: 'Review a bounded file change',
        requestedAtMs: 100,
        expiresAtMs: 1_000,
        previewRef,
      },
    ],
    nextCursor: null,
    truncated: false,
    budget: {
      itemLimit: 25,
      byteLimit: 128 * 1024,
      timeLimitMs: 250,
      usedItems: 1,
      usedBytes: 256,
      elapsedMs: 1,
    },
  };
}

function preview() {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    kind: 'approval_preview' as const,
    teamId,
    runId,
    approvalId,
    generation,
    content: 'safe preview',
    byteLength: 12,
    truncated: false,
    isBinary: false,
  };
}

function receipt<const Outcome extends 'committed' | 'idempotent_replay'>(outcome: Outcome) {
  return {
    schemaVersion: HOSTED_TEAM_APPROVAL_SCHEMA_VERSION,
    outcome,
    teamId,
    runId,
    approvalId,
    generation,
    decision: 'allow' as const,
  };
}

function facade(): HostedTeamApprovalsHttpFacade {
  return {
    getPage: vi.fn(() => Promise.resolve({ kind: 'success' as const, page: page() })),
    getPreview: vi.fn(() => Promise.resolve({ kind: 'success' as const, preview: preview() })),
    decide: vi.fn(() =>
      Promise.resolve({ kind: 'committed' as const, receipt: receipt('committed') })
    ),
  };
}

function producerProvenance(): HostedProducerProvenance {
  return {
    role: 'product-producer',
    controllerNonce: 'c'.repeat(64),
    runId: 'd'.repeat(64),
    emit: vi.fn(),
    bindInvalidation: vi.fn(),
    poison: vi.fn((reason: string) => { throw new Error(reason); }),
    close: vi.fn(),
  };
}

function currentGeneration(
  feature: HostedTeamApprovalsHttpFacade,
  routeAdmission: HostedRouteAdmission,
  provenance: HostedProducerProvenance,
  createContext: HostedTeamApprovalsContextFactory,
  isCurrent: () => boolean
): HostedTeamApprovalsHttpGeneration {
  return {
    contribution: Object.freeze({
      id: 'team-approvals.hosted.v1',
      facade: feature,
      routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    }),
    routeAdmission,
    provenance,
    createContext,
    isCurrent,
    release: vi.fn(),
  };
}

async function createApp(
  feature = facade(),
  createContext: HostedTeamApprovalsContextFactory = (_descriptor, _request, signal) =>
    makeContext(signal),
  routeAdmission: HostedRouteAdmission = readyAdmission(),
  provenance: HostedProducerProvenance = {
    role: 'product-producer',
    controllerNonce: 'c'.repeat(64),
    runId: 'd'.repeat(64),
    emit: vi.fn(),
    bindInvalidation: vi.fn(),
    poison: vi.fn((reason: string) => { throw new Error(reason); }),
    close: vi.fn(),
  },
  acquireGeneration?: () => HostedTeamApprovalsHttpGeneration | null
) {
  const app = Fastify();
  bindProductHostedProducerInstance(provenance, {
    deploymentId: 'deployment_approval-http',
    bootId: 'boot_approval-http',
    ownerAuthority: 'owner-authority_http',
    ownerGeneration: 7,
    ownerSessionId: 'owner-session_http',
  });
  const contextFactory = vi.fn(createContext);
  registerHostedTeamApprovalsHttp(
    app,
    Object.freeze({
      id: 'team-approvals.hosted.v1',
      facade: feature,
      routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    }),
    routeAdmission,
    provenance,
    contextFactory,
    acquireGeneration
  );
  await app.ready();
  return { app, contextFactory, feature };
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
  return new HostedRouteAdmission(createRouteCatalog(HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS), {
    readiness: async () => ({ revision: 1, dimensions }),
  });
}

describe('hosted team approvals HTTP contribution', () => {
  it('does not create context after authority revokes before an admitted callback begins', async () => {
    const admitted = deferred(), allowCallback = deferred();
    const feature = facade(), provenance = producerProvenance();
    const contextFactory = vi.fn<HostedTeamApprovalsContextFactory>(
      (_descriptor, _request, signal) => makeContext(signal)
    );
    let current = true;
    const routeAdmission = {
      invoke: vi.fn(async (routeId: string, callback: () => unknown) => {
        admitted.resolve();
        await allowCallback.promise;
        return { admitted: true as const, routeId, revision: 1, value: await callback() };
      }),
    } as unknown as HostedRouteAdmission;
    const acquireGeneration = () =>
      currentGeneration(feature, routeAdmission, provenance, contextFactory, () => current);
    const { app } = await createApp(
      feature,
      contextFactory,
      routeAdmission,
      provenance,
      acquireGeneration
    );
    try {
      const response = app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        payload: {},
      });
      await admitted.promise;
      current = false;
      allowCallback.resolve();

      expect((await response).statusCode).toBe(503);
      expect(contextFactory).not.toHaveBeenCalled();
      expect(feature.getPage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('rechecks authority after the admission callback and before response dispatch', async () => {
    const callbackComplete = deferred(), allowDispatch = deferred();
    const feature = facade(), provenance = producerProvenance();
    let current = true;
    const routeAdmission = {
      invoke: vi.fn(async (routeId: string, callback: () => unknown) => {
        const value = await callback();
        callbackComplete.resolve();
        await allowDispatch.promise;
        return { admitted: true as const, routeId, revision: 1, value };
      }),
    } as unknown as HostedRouteAdmission;
    const contextFactory: HostedTeamApprovalsContextFactory =
      (_descriptor, _request, signal) => makeContext(signal);
    const acquireGeneration = () =>
      currentGeneration(feature, routeAdmission, provenance, contextFactory, () => current);
    const { app } = await createApp(
      feature,
      contextFactory,
      routeAdmission,
      provenance,
      acquireGeneration
    );
    try {
      const response = app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        payload: {},
      });
      await callbackComplete.promise;
      current = false;
      allowDispatch.resolve();

      expect((await response).statusCode).toBe(503);
      expect(feature.getPage).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    { outcome: 'committed', result: { kind: 'committed' as const, receipt: receipt('committed') } },
    {
      outcome: 'idempotent replay',
      result: { kind: 'idempotent_replay' as const, receipt: receipt('idempotent_replay') },
    },
  ])('fences a $outcome decision after its admission callback completes', async ({ result }) => {
    const callbackComplete = deferred(), allowDispatch = deferred();
    const feature = facade(), provenance = producerProvenance();
    vi.mocked(feature.decide).mockResolvedValueOnce(result);
    let current = true;
    const routeAdmission = {
      invoke: vi.fn(async (routeId: string, callback: () => unknown) => {
        const value = await callback();
        callbackComplete.resolve();
        await allowDispatch.promise;
        return { admitted: true as const, routeId, revision: 1, value };
      }),
    } as unknown as HostedRouteAdmission;
    const contextFactory: HostedTeamApprovalsContextFactory =
      (_descriptor, _request, signal) => makeContext(signal);
    const acquireGeneration = () =>
      currentGeneration(feature, routeAdmission, provenance, contextFactory, () => current);
    const { app } = await createApp(
      feature,
      contextFactory,
      routeAdmission,
      provenance,
      acquireGeneration
    );
    try {
      const response = app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        payload: {},
      });
      await callbackComplete.promise;
      current = false;
      allowDispatch.resolve();

      expect((await response).statusCode).toBe(503);
      expect(feature.decide).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });

  it.each([
    'approval_generation_state',
    'hosted-operator-production-recovery-incomplete',
  ])('maps closed or rolling-over context creation (%s) to structured unavailable', async reason => {
    const feature = facade();
    const contextFactory = vi.fn<HostedTeamApprovalsContextFactory>(() => {
      throw new Error(reason);
    });
    const { app } = await createApp(feature, contextFactory);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: { code: 'unavailable', reason: 'team_approval_unavailable' },
        retryable: true,
      });
      expect(feature.getPage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed for a retired generation while the replacement serves concurrent approvals', async () => {
    const previousEntered = deferred();
    const releasePrevious = deferred();
    const previous = facade(), replacement = facade();
    const generationProvenance: HostedProducerProvenance = {
      role: 'product-producer', controllerNonce: 'c'.repeat(64), runId: 'd'.repeat(64),
      emit: vi.fn(), bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => { throw new Error(reason); }), close: vi.fn(),
    };
    vi.mocked(previous.getPage).mockImplementationOnce(async () => {
      previousEntered.resolve();
      await releasePrevious.promise;
      return { kind: 'success', page: page() };
    });
    let active = 'previous';
    const released = vi.fn();
    const acquireGeneration = (): HostedTeamApprovalsHttpGeneration => {
      const selected = active === 'previous' ? previous : replacement;
      return {
        contribution: Object.freeze({
          id: 'team-approvals.hosted.v1',
          facade: selected,
          routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
        }),
        routeAdmission: readyAdmission(),
        provenance: generationProvenance,
        createContext: (_descriptor, _request, signal) => makeContext(signal),
        isCurrent: () => active === (selected === previous ? 'previous' : 'replacement'),
        release: released,
      };
    };
    const { app } = await createApp(
      facade(), undefined, undefined, generationProvenance, acquireGeneration
    );
    try {
      const stale = app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} });
      await previousEntered.promise;
      active = 'replacement';
      const current = await app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} });
      releasePrevious.resolve();
      const staleResponse = await stale;

      expect(staleResponse.statusCode).toBe(503);
      expect(staleResponse.json()).toMatchObject({
        schemaVersion: 1, kind: 'error', error: { reason: 'team_approval_unavailable' }, retryable: true,
      });
      expect(current.statusCode).toBe(200);
      expect(previous.getPage).toHaveBeenCalledOnce();
      expect(replacement.getPage).toHaveBeenCalledOnce();
      expect(released).toHaveBeenCalledTimes(2);
    } finally {
      await app.close();
    }
  });

  it('fails closed when no approval generation authority is available', async () => {
    const { app, feature } = await createApp(facade(), undefined, undefined, undefined, () => null);
    try {
      const response = await app.inject({ method: 'POST', url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, payload: {} });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        schemaVersion: 1, kind: 'error', error: { reason: 'team_approval_unavailable' }, retryable: true,
      });
      expect(feature.getPage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('publishes three browser route descriptors and a feature-local contribution', () => {
    const catalog = createRouteCatalog(HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS, 'production');
    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOSTED_TEAM_APPROVAL_PAGE_ROUTE}`,
      `POST ${HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE}`,
      `POST ${HOSTED_TEAM_APPROVAL_DECISION_ROUTE}`,
    ]);
    expect(catalog.routes.every((route) => route.owner === 'team-approvals')).toBe(true);
    expect(catalog.routes.every((route) => route.trustKind === 'browser')).toBe(true);
    expect(catalog.routes.every((route) => Object.isFrozen(route))).toBe(true);

    const feature = createHostedTeamApprovalsFeature({
      pageSource: { readPage: vi.fn() },
      previewSource: { readPreview: vi.fn() },
      decisionAdmission: { admit: vi.fn() },
    });
    expect(createHostedTeamApprovalsRouteContribution(feature)).toEqual({
      id: 'team-approvals.hosted.v1',
      facade: feature,
      routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    });
  });

  it('rejects reordered canonical descriptors instead of matching by id', async () => {
    const app = Fastify();
    expect(() =>
      registerHostedTeamApprovalsHttp(
        app,
        Object.freeze({
          id: 'team-approvals.hosted.v1',
          facade: facade(),
          routes: Object.freeze([...HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS].reverse()),
        }),
        readyAdmission(),
        {
          role: 'product-producer',
          controllerNonce: 'c'.repeat(64),
          runId: 'd'.repeat(64),
          emit: vi.fn(),
          bindInvalidation: vi.fn(),
          poison: vi.fn((reason: string) => { throw new Error(reason); }),
          close: vi.fn(),
        },
        (_descriptor, _request, signal) => makeContext(signal)
      )
    ).toThrow('hosted-team-approvals-route-contribution-invalid');
    await app.close();
  });

  it.each([
    { route: HOSTED_TEAM_APPROVAL_PAGE_ROUTE, method: 'getPage' as const, body: { page: true } },
    {
      route: HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
      method: 'getPreview' as const,
      body: { preview: true },
    },
    {
      route: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
      method: 'decide' as const,
      body: { decision: true },
    },
  ])(
    'serves a no-store $method response through an injected context',
    async ({ route, method, body }) => {
      const { app, contextFactory, feature } = await createApp();
      try {
        const response = await app.inject({ method: 'POST', url: route, payload: body });
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(contextFactory).toHaveBeenCalledOnce();
        expect(feature[method]).toHaveBeenCalledWith(body, expect.any(Object));
        const signal = contextFactory.mock.calls[0][2];
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(signal.aborted).toBe(false);
      } finally {
        await app.close();
      }
    }
  );

  it('propagates request abort into the QueryContext signal', async () => {
    let observedSignal: AbortSignal | undefined;
    const feature = facade();
    const { app } = await createApp(feature, (_descriptor, request, signal) => {
      observedSignal = signal;
      request.raw.emit('aborted');
      return makeContext(signal);
    });
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('rejects an oversized request before context creation or body parsing', async () => {
    const feature = facade();
    const contextFactory = vi.fn<HostedTeamApprovalsContextFactory>(
      (_descriptor, _request, signal) => makeContext(signal)
    );
    const { app } = await createApp(feature, contextFactory);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: Buffer.alloc(256 * 1024 + 1, 0x20),
      });
      expect(response.statusCode).toBe(413);
      expect(contextFactory).not.toHaveBeenCalled();
      expect(feature.getPage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops buffering a chunked request as soon as the streaming limit is exceeded', async () => {
    const feature = facade();
    const contextFactory = vi.fn<HostedTeamApprovalsContextFactory>(
      (_descriptor, _request, signal) => makeContext(signal)
    );
    const { app } = await createApp(feature, contextFactory);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        headers: {
          'content-type': 'application/json',
          'transfer-encoding': 'chunked',
        },
        payload: Readable.from([
          Buffer.alloc(128 * 1024, 0x20),
          Buffer.alloc(128 * 1024, 0x20),
          Buffer.from('x'),
        ]),
      });
      expect(response.statusCode).toBe(413);
      expect(contextFactory).not.toHaveBeenCalled();
      expect(feature.getPage).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it.each([
    {
      result: { kind: 'invalid_request' as const },
      status: 400,
      reason: 'approval_decision_invalid',
    },
    {
      result: { kind: 'stale_generation' as const, currentGeneration: replacementGeneration },
      status: 409,
      reason: 'stale_generation',
    },
    {
      result: {
        kind: 'already_resolved' as const,
        generation,
        decision: 'deny' as const,
      },
      status: 409,
      reason: 'approval_already_resolved',
    },
    {
      result: { kind: 'conflict' as const, reason: 'idempotency_mismatch' as const },
      status: 409,
      reason: 'idempotency_mismatch',
    },
    { result: { kind: 'expired' as const }, status: 410, reason: 'approval_expired' },
    { result: { kind: 'not_found' as const }, status: 404, reason: 'approval_not_found' },
    {
      result: { kind: 'unavailable' as const, retryAfterMs: 1_500 },
      status: 503,
      reason: 'team_approval_unavailable',
    },
  ])('maps $result.kind to a safe decision response', async ({ result, status, reason }) => {
    const feature = facade();
    vi.mocked(feature.decide).mockResolvedValueOnce(result);
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        schemaVersion: 1,
        kind: 'error',
        error: { reason },
        retryable: status === 503,
      });
      expect(response.body).not.toMatch(/authorization|principal|provider|token|private|readPath/);
      if (status === 503) expect(response.headers['retry-after']).toBe('2');
    } finally {
      await app.close();
    }
  });

  it('returns committed and replay receipts without widening them', async () => {
    const feature = facade();
    vi.mocked(feature.decide)
      .mockResolvedValueOnce({ kind: 'committed', receipt: receipt('committed') })
      .mockResolvedValueOnce({
        kind: 'idempotent_replay',
        receipt: receipt('idempotent_replay'),
      });
    const { app } = await createApp(feature);
    try {
      const committed = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        payload: {},
      });
      const replay = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        payload: {},
      });
      expect(committed.json()).toEqual(receipt('committed'));
      expect(replay.json()).toEqual(receipt('idempotent_replay'));
    } finally {
      await app.close();
    }
  });

  it('contains thrown context and facade errors as generic unavailable envelopes', async () => {
    const feature = facade();
    vi.mocked(feature.getPreview).mockRejectedValueOnce(
      new Error('provider token at /private/project/secret')
    );
    const { app } = await createApp(feature);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PREVIEW_ROUTE,
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'error',
        error: { code: 'unavailable', reason: 'team_approval_unavailable' },
        retryable: true,
      });
      expect(response.body).not.toMatch(/provider|token|private|project|secret/);
    } finally {
      await app.close();
    }
  });

  it('keeps reads mounted but rejects unavailable mutation before context and facade work', async () => {
    const feature = facade();
    const contextFactory = vi.fn<HostedTeamApprovalsContextFactory>(
      (_descriptor, _request, signal) => makeContext(signal)
    );
    const invoke = vi.fn(async (routeId: string, operation: () => unknown) => {
      if (routeId === HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[2].id) {
        return {
          admitted: false as const,
          routeId,
          revision: 3,
          statusCode: 503 as const,
          reason: {
            code: 'required_readiness_unavailable' as const,
            dimensions: ['mutation'] as const,
          },
        };
      }
      return { admitted: true as const, routeId, revision: 3, value: await operation() };
    });
    const { app } = await createApp(feature, contextFactory, {
      invoke,
    } as unknown as HostedRouteAdmission);
    try {
      const read = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        payload: {},
      });
      const decision = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_DECISION_ROUTE,
        payload: {},
      });
      expect(read.statusCode).toBe(200);
      expect(decision.statusCode).toBe(503);
      expect(contextFactory).toHaveBeenCalledTimes(1);
      expect(feature.getPage).toHaveBeenCalledOnce();
      expect(feature.decide).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('emits the finalized status and body digest before dispatch without retaining body text', async () => {
    const emit = vi.fn();
    const provenance: HostedProducerProvenance = {
      role: 'product-producer',
      controllerNonce: 'c'.repeat(64),
      runId: 'd'.repeat(64),
      emit,
      bindInvalidation: vi.fn(),
      poison: vi.fn((reason: string) => { throw new Error(reason); }),
      close: vi.fn(),
    };
    installProductHostedProducerProvenance(provenance);
    const { app } = await createApp(facade(), undefined, undefined, provenance);
    try {
      const rawRequest = '{ "page" : true }';
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_APPROVAL_PAGE_ROUTE,
        headers: { 'content-type': 'application/json' },
        payload: rawRequest,
      });
      expect(response.statusCode).toBe(200);
      expect(emit).toHaveBeenCalledWith('productTimeline', {
        recordType: 'approval-http-response-finalized',
        operationNonce: expect.stringMatching(/^[0-9a-f]{64}$/u),
        native: expect.objectContaining({
          method: 'POST',
          outcome: 'success',
          requestBodyBytes: Buffer.byteLength(rawRequest),
          requestBodySha256: createHash('sha256').update(rawRequest).digest('hex'),
          responseBodyBytes: Buffer.byteLength(JSON.stringify(page())),
          responseBodySha256: createHash('sha256').update(JSON.stringify(page())).digest('hex'),
          routeId: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS[0].id,
          status: 200,
        }),
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain('Review a bounded file change');
    } finally {
      clearProductHostedProducerProvenance(provenance);
      await app.close();
    }
  });
});
