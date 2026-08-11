import {
  HOSTED_WORKSPACE_REGISTRY_ROUTES,
  HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
} from '@features/workspace-registry/contracts';
import {
  WorkspaceMountBinding,
  WorkspaceRegistration,
  WorkspaceRegistrationRegistry,
} from '@features/workspace-registry/core';
import {
  HostedWorkspaceRegistryHttpAdapter,
  registerHostedWorkspaceRegistryHttp,
} from '@features/workspace-registry/main/hosted';
import { createQueryContext, parseBootId, parseWorkspaceId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
import type {
  HostedWorkspaceRegistryAuthorizationPort,
  HostedWorkspaceRegistryHttpFacade,
} from '@features/workspace-registry/main/hosted';
import type { ActorId, WorkspaceId } from '@shared/contracts/hosted';
import type { FastifyInstance } from 'fastify';

const ROOT_A = 'a'.repeat(64);
const ROOT_B = 'b'.repeat(64);
const ROOT_C = 'c'.repeat(64);
const ROOT_D = 'd'.repeat(64);
const WORKSPACE_A = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const WORKSPACE_B = parseWorkspaceId(`workspace_${'b'.repeat(32)}`);
const WORKSPACE_C = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
const WORKSPACE_DENIED_EARLIER = parseWorkspaceId(`workspace_${'0'.repeat(32)}`);
const WORKSPACE_DISABLED_EARLIER = parseWorkspaceId(`workspace_${'1'.repeat(32)}`);
const WORKSPACE_UNBOUND_EARLIER = parseWorkspaceId(`workspace_${'2'.repeat(32)}`);
const BOOT_ID = parseBootId('boot_workspace_http');
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function registration(
  workspaceId: WorkspaceId,
  displayName: string,
  declaredRootHash: string,
  enabled = true
) {
  return new WorkspaceRegistration({
    schemaVersion: 1,
    registrationKey: `registration-${workspaceId.slice(-1)}`,
    workspaceId,
    displayName,
    registrationRevision: 1,
    declaredRootHash,
    enabled,
  });
}

function snapshot(): WorkspaceRegistryStartupSnapshot {
  const a = registration(WORKSPACE_A, '/srv/private/workspace-a', ROOT_A);
  const b = registration(WORKSPACE_B, ROOT_B, ROOT_B);
  const disabled = registration(WORKSPACE_C, 'Disabled private', ROOT_C, false);
  return Object.freeze({
    registry: new WorkspaceRegistrationRegistry([a, disabled, b]),
    bindings: Object.freeze([
      new WorkspaceMountBinding({
        registration: a,
        bootId: BOOT_ID,
        mountGeneration: 1,
        declaredRootHash: ROOT_A,
        observedAt: 20,
        health: 'healthy',
        allowedOperations: [
          'workspace.registry.get-project-branch',
          'workspace.registry.get-worktree-git-status',
        ],
      }),
      new WorkspaceMountBinding({
        registration: b,
        bootId: BOOT_ID,
        mountGeneration: 1,
        declaredRootHash: ROOT_B,
        observedAt: 10,
        health: 'unavailable',
        allowedOperations: ['workspace.registry.get-worktree-git-status'],
      }),
    ]),
  });
}

function context(actorId: ActorId, signal: AbortSignal) {
  return createQueryContext({
    actorId,
    sessionId: `session_${actorId.slice('actor_'.length)}`,
    deploymentId: 'deployment_workspace_http',
    bootId: 'boot_workspace_http',
    requestId: 'request_workspace_http',
    authorizedScope: 'scope_authenticated-hosted-query',
    deadlineAtMs: Date.now() + 10_000,
    signal,
  });
}

async function createApp(
  authorization: HostedWorkspaceRegistryAuthorizationPort,
  actorId: ActorId = 'actor_principal-a' as ActorId
) {
  const app = Fastify();
  apps.push(app);
  const facade = new HostedWorkspaceRegistryHttpAdapter(snapshot(), authorization, BOOT_ID);
  const createContext = vi.fn((_request, signal: AbortSignal) => context(actorId, signal));
  registerHostedWorkspaceRegistryHttp(app, facade, createContext);
  await app.ready();
  return { app, createContext };
}

const payload = (workspaceId?: WorkspaceId) => ({
  schemaVersion: HOSTED_WORKSPACE_REGISTRY_SCHEMA_VERSION,
  ...(workspaceId === undefined ? {} : { workspaceId }),
});

function authorizationFor(
  authorized: (actorId: ActorId, runtimeWorkspaceId: WorkspaceId) => boolean = () => true
): HostedWorkspaceRegistryAuthorizationPort {
  return {
    projectPublicWorkspaceId: vi.fn(async (principal, runtimeWorkspaceId) =>
      authorized(principal.actorId, runtimeWorkspaceId) ? runtimeWorkspaceId : null
    ),
    resolveRuntimeWorkspaceId: vi.fn(async (principal, publicWorkspaceId) =>
      authorized(principal.actorId, publicWorkspaceId) ? publicWorkspaceId : null
    ),
  };
}

describe('hosted workspace registry HTTP', () => {
  it('lists authorized enabled registrations in deterministic order with safe mount data', async () => {
    const authorization = authorizationFor();
    const { app } = await createApp(authorization);

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: payload(),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      schemaVersion: 1,
      kind: 'workspace-list',
      workspaces: [
        {
          workspaceId: WORKSPACE_A,
          label: 'Workspace 1',
          registrationRevision: 1,
          mount: {
            bootId: 'boot_workspace_http',
            mountGeneration: 1,
            observedAt: 20,
            health: 'healthy',
            capabilities: ['git.status.read', 'git.branch.read'],
          },
        },
        {
          workspaceId: WORKSPACE_B,
          label: 'Workspace 2',
          registrationRevision: 1,
          mount: {
            bootId: 'boot_workspace_http',
            mountGeneration: 1,
            observedAt: 10,
            health: 'unavailable',
            capabilities: [],
          },
        },
      ],
    });
    for (const privateValue of [
      ROOT_A,
      ROOT_B,
      ROOT_C,
      '/srv/private/workspace-a',
      'registration-',
      '/srv/',
      'sourceLocation',
    ]) {
      expect(response.body).not.toContain(privateValue);
    }
    expect(response.body).not.toContain('Disabled private');
    expect(response.body).not.toContain('workspace.registry.');
  });

  it('filters per principal and fails cross-workspace selection closed as not-found', async () => {
    const authorization = authorizationFor(
      (actorId, workspaceId) => actorId === 'actor_principal-a' && workspaceId === WORKSPACE_A
    );
    const { app } = await createApp(authorization);

    const list = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: payload(),
    });
    const denied = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: payload(WORKSPACE_B),
    });
    const allowed = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: payload(WORKSPACE_A),
    });

    expect(list.json().workspaces).toHaveLength(1);
    expect(list.json().workspaces[0].workspaceId).toBe(WORKSPACE_A);
    expect(denied.statusCode).toBe(404);
    expect(denied.json()).toEqual({ schemaVersion: 1, kind: 'error', code: 'not_found' });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().workspace.workspaceId).toBe(WORKSPACE_A);
  });

  it('derives list and selection labels only from the principal-effective projection', async () => {
    const denied = registration(WORKSPACE_DENIED_EARLIER, 'Denied private', ROOT_A);
    const disabled = registration(WORKSPACE_DISABLED_EARLIER, 'Disabled private', ROOT_B, false);
    const unbound = registration(WORKSPACE_UNBOUND_EARLIER, 'Unbound private', ROOT_C);
    const target = registration(WORKSPACE_A, 'Target private', ROOT_D);
    const authorization = authorizationFor((_actorId, workspaceId) => workspaceId === WORKSPACE_A);
    const facade = new HostedWorkspaceRegistryHttpAdapter(
      Object.freeze({
        registry: new WorkspaceRegistrationRegistry([denied, disabled, unbound, target]),
        bindings: Object.freeze([
          new WorkspaceMountBinding({
            registration: denied,
            bootId: BOOT_ID,
            mountGeneration: 1,
            declaredRootHash: ROOT_A,
            observedAt: 10,
            health: 'healthy',
            allowedOperations: [],
          }),
          new WorkspaceMountBinding({
            registration: target,
            bootId: BOOT_ID,
            mountGeneration: 1,
            declaredRootHash: ROOT_D,
            observedAt: 10,
            health: 'healthy',
            allowedOperations: [],
          }),
        ]),
      }),
      authorization,
      BOOT_ID
    );
    const queryContext = context('actor_principal-a' as ActorId, new AbortController().signal);

    const list = await facade.list(queryContext);
    const selection = await facade.select(WORKSPACE_A, queryContext);

    expect(list.workspaces).toEqual([
      expect.objectContaining({ workspaceId: WORKSPACE_A, label: 'Workspace 1' }),
    ]);
    expect(selection?.workspace).toEqual(
      expect.objectContaining({ workspaceId: WORKSPACE_A, label: 'Workspace 1' })
    );
    expect(authorization.projectPublicWorkspaceId).not.toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_DISABLED_EARLIER,
      expect.anything()
    );
    expect(authorization.projectPublicWorkspaceId).not.toHaveBeenCalledWith(
      expect.anything(),
      WORKSPACE_UNBOUND_EARLIER,
      expect.anything()
    );
  });

  it('rejects malformed payloads before principal resolution', async () => {
    const authorization = authorizationFor();
    const { app, createContext } = await createApp(authorization);

    for (const request of [
      { url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list, payload: { schemaVersion: 1, root: '/tmp' } },
      { url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select, payload: { schemaVersion: 1 } },
      {
        url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
        payload: { schemaVersion: 1, workspaceId: '/srv/private' },
      },
    ]) {
      const response = await app.inject({ method: 'POST', ...request });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ schemaVersion: 1, kind: 'error', code: 'invalid_request' });
    }
    expect(createContext).not.toHaveBeenCalled();
    expect(authorization.projectPublicWorkspaceId).not.toHaveBeenCalled();
    expect(authorization.resolveRuntimeWorkspaceId).not.toHaveBeenCalled();
  });

  it('revalidates facade output and redacts private failure details', async () => {
    const privateValue = '/srv/private/declared-root-hash';
    const facade: HostedWorkspaceRegistryHttpFacade = {
      list: vi.fn(
        async () =>
          ({
            schemaVersion: 1,
            kind: 'workspace-list',
            workspaces: [],
            sourceLocation: privateValue,
          }) as never
      ),
      select: vi.fn(async () => {
        throw new Error(privateValue);
      }),
    };
    const app = Fastify();
    apps.push(app);
    registerHostedWorkspaceRegistryHttp(app, facade, (_request, signal) =>
      context('actor_principal-a' as ActorId, signal)
    );

    const list = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: payload(),
    });
    const select = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.select,
      payload: payload(WORKSPACE_A),
    });

    expect(list.statusCode).toBe(503);
    expect(select.statusCode).toBe(503);
    expect(list.body).not.toContain(privateValue);
    expect(select.body).not.toContain(privateValue);
  });

  it('authenticates before invoking the facade and rejects results after the context deadline', async () => {
    vi.useFakeTimers();
    try {
      const order: string[] = [];
      let facadeSignal!: AbortSignal;
      let settle!: () => void;
      const facade: HostedWorkspaceRegistryHttpFacade = {
        list: vi.fn(async (queryContext) => {
          order.push('facade');
          facadeSignal = queryContext.signal;
          await new Promise<void>((resolve) => {
            settle = resolve;
          });
          return { schemaVersion: 1, kind: 'workspace-list', workspaces: [] } as const;
        }),
        select: vi.fn(async () => null),
      };
      const app = Fastify();
      apps.push(app);
      registerHostedWorkspaceRegistryHttp(app, facade, (_request, signal) => {
        order.push('context');
        const queryContext = context('actor_principal-a' as ActorId, signal);
        return Object.freeze({ ...queryContext, deadlineAtMs: Date.now() + 10 });
      });
      await app.ready();

      const pending = app.inject({
        method: 'POST',
        url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
        payload: payload(),
      });
      await vi.advanceTimersByTimeAsync(10);
      const result = await pending;
      expect(order).toEqual(['context', 'facade']);
      expect(result.statusCode).toBe(503);
      expect(facadeSignal.aborted).toBe(true);
      settle();
      await vi.runAllTimersAsync();
      expect(result.statusCode).toBe(503);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels a pre-closed request before principal resolution or facade work', async () => {
    const facade: HostedWorkspaceRegistryHttpFacade = {
      list: vi.fn(
        async () => ({ schemaVersion: 1, kind: 'workspace-list', workspaces: [] }) as const
      ),
      select: vi.fn(async () => null),
    };
    const createContext = vi.fn((_request, signal: AbortSignal) =>
      context('actor_principal-a' as ActorId, signal)
    );
    const app = Fastify();
    apps.push(app);
    app.addHook('preHandler', (request, _reply, done) => {
      request.raw.aborted = true;
      done();
    });
    registerHostedWorkspaceRegistryHttp(app, facade, createContext);

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_WORKSPACE_REGISTRY_ROUTES.list,
      payload: payload(),
    });

    expect(response.statusCode).toBe(503);
    expect(createContext).not.toHaveBeenCalled();
    expect(facade.list).not.toHaveBeenCalled();
  });
});
