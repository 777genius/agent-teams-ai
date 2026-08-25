import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  HOSTED_TEAM_CONFIGURATION_ROUTES,
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
} from '../../../../src/features/team-configuration/contracts';
import {
  createHostedTeamConfigurationRouteContribution,
  HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
  type HostedTeamConfigurationFacade,
  type HostedTeamConfigurationFeature,
  registerHostedTeamConfigurationHttp,
} from '../../../../src/features/team-configuration/main/hosted';
import {
  assembleHostedRoutes,
  HOSTED_READINESS_DIMENSIONS,
  HostedRouteAdmission,
} from '../../../../src/main/composition/hosted/application';
import { createQueryContext, createSafeAppError } from '../../../../src/shared/contracts/hosted';

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function facade(): HostedTeamConfigurationFacade {
  const invalid = () => ({
    schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
    kind: 'error' as const,
    error: createSafeAppError({
      code: 'invalid_request',
      reason: 'team_configuration_request_invalid',
    }),
    retryable: false,
  });
  return {
    getSavedRequest: vi.fn(async () => invalid()),
    createDraft: vi.fn(async () => invalid()),
    updateDraft: vi.fn(async () => invalid()),
    deleteDraft: vi.fn(async () => invalid()),
  };
}

function contribution(feature = facade()) {
  return createHostedTeamConfigurationRouteContribution(
    Object.freeze({
      ...feature,
      routes: HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
    }) satisfies HostedTeamConfigurationFeature
  );
}

function admission(
  routeContribution: ReturnType<typeof contribution>,
  unavailable: 'read' | 'mutation' | null = null
) {
  const assembly = assembleHostedRoutes([routeContribution], 'production');
  return new HostedRouteAdmission(assembly.catalog, {
    readiness: vi.fn(async () => ({
      revision: 1,
      dimensions: Object.fromEntries(
        HOSTED_READINESS_DIMENSIONS.map((dimension) => [
          dimension,
          Object.freeze({
            status: dimension === unavailable ? 'unavailable' : 'ready',
            reasons: Object.freeze([]),
          }),
        ])
      ),
    })) as never,
  });
}

function contextFactory(descriptors: string[]) {
  return (
    descriptor: (typeof HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS)[number],
    request: {
      readonly headers: Readonly<Record<string, string | string[] | undefined>>;
    },
    signal: AbortSignal
  ) => {
    descriptors.push(descriptor.id);
    if (request.headers['x-test-session'] !== 'authenticated') throw new Error('unauthenticated');
    if (
      descriptor.authPolicyId === 'hosted.browser.session.csrf' &&
      request.headers['x-agent-teams-csrf'] !== 'valid-csrf'
    ) {
      throw new Error('csrf-rejected');
    }
    return createQueryContext({
      actorId: 'actor_authenticated-user',
      sessionId: 'session_authenticated-session',
      deploymentId: 'deployment_test-deployment',
      bootId: 'boot_test-boot',
      requestId: 'request_test-request',
      authorizedScope: 'scope_team-configuration-test',
      deadlineAtMs: Date.now() + 60_000,
      signal,
    });
  };
}

describe('hosted team configuration HTTP', () => {
  it('registers all bounded routes and maps malformed-payload results without orchestration', async () => {
    const app = Fastify();
    apps.push(app);
    const feature = facade();
    const routeContribution = contribution(feature);
    registerHostedTeamConfigurationHttp(
      app,
      routeContribution,
      admission(routeContribution),
      contextFactory([]) as never
    );

    for (const [operation, path] of Object.entries(HOSTED_TEAM_CONFIGURATION_ROUTES)) {
      const response = await app.inject({
        method: 'POST',
        url: path,
        payload: { malformed: true },
        headers: {
          'x-test-session': 'authenticated',
          'x-agent-teams-csrf': 'valid-csrf',
        },
      });
      expect(response.statusCode, operation).toBe(400);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toEqual({
        schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
        kind: 'error',
        error: {
          code: 'invalid_request',
          reason: 'team_configuration_request_invalid',
        },
        retryable: false,
      });
    }
    expect(feature.getSavedRequest).toHaveBeenCalledTimes(1);
    expect(feature.createDraft).toHaveBeenCalledTimes(1);
    expect(feature.updateDraft).toHaveBeenCalledTimes(1);
    expect(feature.deleteDraft).toHaveBeenCalledTimes(1);
  });

  it('declares read readiness without CSRF and CSRF only for mutations', () => {
    const [read, ...mutations] = HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS;
    expect(read).toMatchObject({
      authPolicyId: 'hosted.browser.session',
      readiness: ['serve', 'auth', 'read'],
    });
    for (const mutation of mutations) {
      expect(mutation).toMatchObject({
        authPolicyId: 'hosted.browser.session.csrf',
        readiness: ['serve', 'auth', 'mutation'],
      });
    }
  });

  it('assembles lowercase stable descriptors through the central production catalog', () => {
    const routeContribution = contribution();
    const assembly = assembleHostedRoutes([routeContribution], 'production');

    expect(assembly.facades).toEqual([
      expect.objectContaining({ id: 'team-configuration.hosted.v1' }),
    ]);
    expect(assembly.catalog.routes).toHaveLength(4);
    for (const route of assembly.catalog.routes) {
      for (const reference of [
        route.id,
        route.owner,
        route.authPolicyId,
        route.requestSchemaId,
        route.responseSchemaId,
        route.handlerId,
        route.clientId,
        route.semanticTestId,
      ]) {
        expect(reference).toMatch(/^[a-z][a-z0-9.-]+$/);
      }
    }
  });

  it('enforces authentication, descriptor-owned CSRF, and readiness before invoking facades', async () => {
    const app = Fastify();
    apps.push(app);
    const feature = facade();
    const routeContribution = contribution(feature);
    const descriptors: string[] = [];
    registerHostedTeamConfigurationHttp(
      app,
      routeContribution,
      admission(routeContribution),
      contextFactory(descriptors) as never
    );

    const unauthenticatedRead = await app.inject({
      method: 'POST',
      url: HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
      payload: {},
    });
    expect(unauthenticatedRead.statusCode).toBe(503);
    expect(feature.getSavedRequest).not.toHaveBeenCalled();

    const authenticatedRead = await app.inject({
      method: 'POST',
      url: HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
      headers: { 'x-test-session': 'authenticated' },
      payload: {},
    });
    expect(authenticatedRead.statusCode).toBe(400);
    expect(feature.getSavedRequest).toHaveBeenCalledOnce();

    const mutationWithoutCsrf = await app.inject({
      method: 'POST',
      url: HOSTED_TEAM_CONFIGURATION_ROUTES.createDraft,
      headers: { 'x-test-session': 'authenticated' },
      payload: {},
    });
    expect(mutationWithoutCsrf.statusCode).toBe(503);
    expect(feature.createDraft).not.toHaveBeenCalled();
    expect(descriptors).toEqual([
      'team-configuration.saved-request.v1',
      'team-configuration.saved-request.v1',
      'team-configuration.create-draft.v1',
    ]);
  });

  it('rejects unavailable mutation readiness before authentication or mutation execution', async () => {
    const app = Fastify();
    apps.push(app);
    const feature = facade();
    const routeContribution = contribution(feature);
    const descriptors: string[] = [];
    registerHostedTeamConfigurationHttp(
      app,
      routeContribution,
      admission(routeContribution, 'mutation'),
      contextFactory(descriptors) as never
    );

    const response = await app.inject({
      method: 'POST',
      url: HOSTED_TEAM_CONFIGURATION_ROUTES.deleteDraft,
      headers: {
        'x-test-session': 'authenticated',
        'x-agent-teams-csrf': 'valid-csrf',
      },
      payload: {},
    });
    expect(response.statusCode).toBe(503);
    expect(descriptors).toEqual([]);
    expect(feature.deleteDraft).not.toHaveBeenCalled();
  });
});
