import {
  HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS,
  HOSTED_LIFECYCLE_COMMAND_ROUTES,
  type HostedLifecycleCommandExecutionResult,
  type HostedLifecycleCommandHttpFacade,
  type HostedLifecycleControlStateResult,
  registerHostedLifecycleCommandHttp,
} from '@features/team-lifecycle/main/hosted';
import {
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  HostedRouteAdmission,
} from '@main/composition/hosted/application';
import { createRouteCatalog } from '@main/composition/hosted/routing';
import { createQueryContext, parseRevision } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

const TEAM_ID = `team_${'a'.repeat(32)}`;
const WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const RUN_ID = `run_${'c'.repeat(32)}`;
const COMMAND_ID = 'lifecycle-command_http-0001';
const IDEMPOTENCY_KEY = 'idempotency_http-0001';
const REVISION = parseRevision('revision_http');

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
  return new HostedRouteAdmission(createRouteCatalog(HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS), {
    readiness: async () => ({ revision: 1, dimensions }),
  });
}

function launchBody() {
  return {
    schemaVersion: 1,
    commandId: COMMAND_ID,
    idempotencyKey: IDEMPOTENCY_KEY,
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: REVISION,
  };
}

function accepted(): HostedLifecycleCommandExecutionResult {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'accepted',
    action: 'launch',
    commandId: COMMAND_ID as never,
    workspaceId: WORKSPACE_ID as never,
    teamId: TEAM_ID as never,
    runId: RUN_ID as never,
    resourceRevision: REVISION,
  });
}

function context(signal: AbortSignal) {
  return createQueryContext({
    actorId: 'actor_lifecycle-command-http',
    sessionId: 'session_lifecycle-command-http',
    deploymentId: 'deployment_lifecycle-command-http',
    bootId: 'boot_lifecycle-command-http',
    requestId: 'request_lifecycle-command-http',
    authorizedScope: 'scope_lifecycle-command-http',
    deadlineAtMs: Date.now() + 10_000,
    signal,
  });
}

async function appFor(result: HostedLifecycleCommandExecutionResult, bindRequestSignal = true) {
  const app = Fastify();
  const facade: HostedLifecycleCommandHttpFacade = {
    getControlState: vi.fn(async () => ({
      schemaVersion: 1 as const,
      kind: 'unavailable' as const,
      retryAfterMs: null,
    })),
    execute: vi.fn(async () => result),
  };
  const createContext = vi.fn((_descriptor, _request, signal: AbortSignal) =>
    context(bindRequestSignal ? signal : new AbortController().signal)
  );
  registerHostedLifecycleCommandHttp(app, facade, readyAdmission(), createContext);
  await app.ready();
  return { app, createContext, facade };
}

describe('hosted lifecycle command HTTP contribution', () => {
  it('publishes one browser query plus four mutations and no desktop transport route', () => {
    const catalog = createRouteCatalog(HOSTED_LIFECYCLE_COMMAND_ROUTE_DESCRIPTORS, 'production');

    expect(catalog.routes.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST ${HOSTED_LIFECYCLE_COMMAND_ROUTES.controlState}`,
      `POST ${HOSTED_LIFECYCLE_COMMAND_ROUTES.launch}`,
      `POST ${HOSTED_LIFECYCLE_COMMAND_ROUTES.cancel}`,
      `POST ${HOSTED_LIFECYCLE_COMMAND_ROUTES.stop}`,
      `POST ${HOSTED_LIFECYCLE_COMMAND_ROUTES.recover}`,
    ]);
    for (const route of catalog.routes) {
      expect(route).toMatchObject({
        owner: 'team-lifecycle',
        trustKind: 'browser',
        authPolicyId: 'hosted.browser.session.csrf',
        testOnly: false,
      });
    }
    expect(catalog.routes.find(({ id }) => id === 'team-lifecycle.control-state.v1')).toMatchObject(
      {
        readiness: ['serve', 'auth', 'read'],
      }
    );
    for (const action of ['launch', 'cancel', 'stop', 'recover'] as const) {
      expect(catalog.routes.find(({ id }) => id === `team-lifecycle.${action}.v1`)).toMatchObject({
        readiness: ['serve', 'auth', 'mutation'],
      });
    }
  });

  it('returns deployment/boot fenced lifecycle control state from the facade', async () => {
    const app = Fastify();
    const state: HostedLifecycleControlStateResult = Object.freeze({
      schemaVersion: 1,
      kind: 'control_state',
      workspaceId: WORKSPACE_ID as never,
      teamId: TEAM_ID as never,
      deploymentId: 'deployment_lifecycle-command-http' as never,
      bootId: 'boot_lifecycle-command-http' as never,
      runId: RUN_ID as never,
      resourceRevision: REVISION,
      availableActions: Object.freeze(['stop'] as const),
    });
    const facade: HostedLifecycleCommandHttpFacade = {
      getControlState: vi.fn(async () => state),
      execute: vi.fn(),
    };
    registerHostedLifecycleCommandHttp(
      app,
      facade,
      readyAdmission(),
      (_descriptor, _request, signal) => context(signal)
    );
    await app.ready();
    try {
      const payload = { schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID };
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_LIFECYCLE_COMMAND_ROUTES.controlState,
        payload,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(state);
      expect(facade.getControlState).toHaveBeenCalledWith(payload, expect.any(Object));
    } finally {
      await app.close();
    }
  });

  it('passes only a request-bound context to the facade and returns an opaque accepted receipt', async () => {
    const { app, createContext, facade } = await appFor(accepted());
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_LIFECYCLE_COMMAND_ROUTES.launch,
        payload: launchBody(),
      });

      expect(response.statusCode).toBe(202);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.json()).toEqual(accepted());
      expect(response.body).not.toContain('grantId');
      expect(response.body).not.toContain('authorizationGeneration');
      expect(response.body).not.toContain('bootId');
      expect(createContext).toHaveBeenCalledOnce();
      expect(createContext.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
      expect(facade.execute).toHaveBeenCalledWith('launch', launchBody(), expect.any(Object));
    } finally {
      await app.close();
    }
  });

  it.each([
    [Object.freeze({ ...accepted(), kind: 'idempotent_replay' as const }), 200, undefined],
    [
      Object.freeze({ schemaVersion: 1 as const, kind: 'invalid_request' as const }),
      400,
      undefined,
    ],
    [
      Object.freeze({
        schemaVersion: 1 as const,
        kind: 'conflict' as const,
        action: 'launch' as const,
        commandId: COMMAND_ID as never,
        workspaceId: WORKSPACE_ID as never,
        teamId: TEAM_ID as never,
        reason: 'stale_revision' as const,
        currentRevision: REVISION,
      }),
      409,
      undefined,
    ],
    [
      Object.freeze({
        schemaVersion: 1 as const,
        kind: 'not_found' as const,
        action: 'launch' as const,
        commandId: COMMAND_ID as never,
        workspaceId: WORKSPACE_ID as never,
        teamId: TEAM_ID as never,
      }),
      404,
      undefined,
    ],
    [
      Object.freeze({
        schemaVersion: 1 as const,
        kind: 'unavailable' as const,
        retryAfterMs: 1_500,
      }),
      503,
      '2',
    ],
  ] as const)('maps $0.kind to its exact HTTP status', async (result, status, retryAfter) => {
    const { app } = await appFor(result as HostedLifecycleCommandExecutionResult);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_LIFECYCLE_COMMAND_ROUTES.launch,
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(status);
      expect(response.headers['retry-after']).toBe(retryAfter);
    } finally {
      await app.close();
    }
  });

  it('fails closed when a context factory substitutes the request abort signal', async () => {
    const { app, facade } = await appFor(accepted(), false);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_LIFECYCLE_COMMAND_ROUTES.launch,
        payload: launchBody(),
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1,
        kind: 'unavailable',
        retryAfterMs: null,
      });
      expect(facade.execute).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
