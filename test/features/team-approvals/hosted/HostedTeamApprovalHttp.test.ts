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
  registerHostedTeamApprovalsHttp,
} from '@features/team-approvals/main/hosted';
import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  HostedRouteAdmission,
} from '@main/composition/hosted/application';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
const approvalId = parseHostedTeamApprovalId(`approval_${'b'.repeat(32)}`);
const generation = parseHostedTeamApprovalGeneration('generation_http-1');
const replacementGeneration = parseHostedTeamApprovalGeneration('generation_http-2');
const previewRef = parseHostedTeamApprovalPreviewRef('approval_preview_http-1');

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

async function createApp(
  feature = facade(),
  createContext: HostedTeamApprovalsContextFactory = (_descriptor, _request, signal) =>
    makeContext(signal),
  routeAdmission: HostedRouteAdmission = readyAdmission()
) {
  const app = Fastify();
  const contextFactory = vi.fn(createContext);
  registerHostedTeamApprovalsHttp(
    app,
    Object.freeze({
      id: 'team-approvals.hosted.v1',
      facade: feature,
      routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    }),
    routeAdmission,
    contextFactory
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
});
