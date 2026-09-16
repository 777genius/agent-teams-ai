import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  HOSTED_TEAM_CONFIGURATION_ROUTES,
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
} from '@features/team-configuration/contracts';
// eslint-disable-next-line no-restricted-imports -- Focused production-composition descriptor fixture.
import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from '@features/team-configuration/main/hosted';
import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
} from '@main/composition/hosted/application';
import { parseTeamId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyHostedTeamConfigurationAuthorization,
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
} from '../../../../src/main/composition/hosted/hostedTeamConfigurationComposition';

import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';

const WORKSPACE_ID = `workspace_${'a'.repeat(32)}` as const;
const TEAM_ID = parseTeamId(`team_${'b'.repeat(32)}`);
const DEPLOYMENT_ID = 'deployment_team-configuration-composition';
const SESSION_ID = parseHostedSessionId('session_team-configuration-composition');

function runtimeInstance() {
  return createRuntimeInstanceContext({
    deploymentId: DEPLOYMENT_ID,
    bootId: 'boot_team-configuration-composition',
    claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
    appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
    workspaceRoots: [],
    tempRoot: { kind: 'temp', reference: 'isolated:temp' },
    logsRoot: { kind: 'logs', reference: 'isolated:logs' },
  });
}

function principal(): HostedAuthenticatedPrincipal {
  return Object.freeze({
    principal: Object.freeze({
      userId: parseUserId('user_team-configuration-composition'),
      displayName: 'Configuration member',
      role: 'member',
      permissions: Object.freeze(['hosted.query', 'hosted.command'] as const),
      authenticationMethod: 'oidc',
      sessionId: SESSION_ID,
    }),
    authenticatedSessionId: SESSION_ID,
  });
}

function routeAdmissionBinding() {
  return createHostedRouteAdmissionBinding({
    routes: HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
    readiness: {
      readiness: async () => ({
        revision: 1,
        dimensions: Object.fromEntries(
          HOSTED_READINESS_DIMENSIONS.map((dimension) => [
            dimension,
            { dimension, status: 'ready', reasons: [] },
          ])
        ) as never,
      }),
    },
  });
}

function storage(): HostedTeamConfigurationStorageGateway {
  return {
    createHostedTeamConfiguration: vi.fn(async () =>
      Object.freeze({
        kind: 'created' as const,
        teamId: TEAM_ID,
        revision: 'revision_1' as never,
        outcome: 'created' as const,
      })
    ),
    readHostedTeamConfiguration: vi.fn(async () => Object.freeze({ kind: 'not_found' as const })),
    updateHostedTeamConfiguration: vi.fn(async () => Object.freeze({ kind: 'not_found' as const })),
    deleteHostedTeamConfiguration: vi.fn(async () => ({
      kind: 'deleted' as const,
      outcome: 'already_absent' as const,
    })),
  };
}

describe('hosted team-configuration production composition', () => {
  it('derives read and mutation auth policy from the admitted production descriptors', () => {
    expect(
      classifyHostedTeamConfigurationAuthorization(
        'POST',
        `${HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest}?cache=ignored`
      )
    ).toEqual({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: false,
      workspaceRequired: false,
    });
    expect(
      classifyHostedTeamConfigurationAuthorization(
        'POST',
        HOSTED_TEAM_CONFIGURATION_ROUTES.updateDraft
      )
    ).toEqual({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
    });
    expect(
      classifyHostedTeamConfigurationAuthorization(
        'GET',
        HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest
      )
    ).toEqual({ kind: 'forbidden' });
  });

  it('binds authenticated hosted context and exact workspace scope to the durable authority', async () => {
    const gateway = storage();
    const authorize = vi.fn(async (_request, scope, mutation) =>
      mutation && scope.workspaceId === WORKSPACE_ID && scope.teamId === undefined
        ? ('authorized' as const)
        : ('denied' as const)
    );
    const composition = createHostedTeamConfigurationComposition({
      authentication: {
        authenticatedPrincipalFor: () => principal(),
        isTeamConfigurationScopeAuthorized: authorize,
      },
      storage: gateway,
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      routeAdmissionBinding: routeAdmissionBinding(),
    });
    const app = Fastify();
    composition.register(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_CONFIGURATION_ROUTES.createDraft,
        payload: {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId: WORKSPACE_ID,
          idempotencyKey: 'idempotency_composition-0001',
          name: 'Hosted draft',
          members: [{ name: 'lead' }],
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({
        kind: 'created',
        identity: { workspaceId: WORKSPACE_ID, teamId: TEAM_ID },
      });
      expect(authorize).toHaveBeenCalledWith(
        expect.any(Object),
        { workspaceId: WORKSPACE_ID },
        true
      );
      expect(gateway.createHostedTeamConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: WORKSPACE_ID,
          metadata: { name: 'Hosted draft' },
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) })
      );
    } finally {
      await app.close();
    }
  });

  it('denies a saved-request read unless the canonical workspace/team grant matches', async () => {
    const gateway = storage();
    const authorize = vi.fn(async () => 'denied' as const);
    const composition = createHostedTeamConfigurationComposition({
      authentication: {
        authenticatedPrincipalFor: () => principal(),
        isTeamConfigurationScopeAuthorized: authorize,
      },
      storage: gateway,
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      routeAdmissionBinding: routeAdmissionBinding(),
    });
    const app = Fastify();
    composition.register(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
        payload: {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId: WORKSPACE_ID,
          teamId: TEAM_ID,
        },
      });
      expect(response.statusCode).toBe(403);
      expect(authorize).toHaveBeenCalledWith(
        expect.any(Object),
        { workspaceId: WORKSPACE_ID, teamId: TEAM_ID },
        false
      );
      expect(gateway.readHostedTeamConfiguration).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('fails closed on runtime/auth deployment mismatch and duplicate registration', async () => {
    const dependencies = {
      authentication: {
        authenticatedPrincipalFor: () => principal(),
        isTeamConfigurationScopeAuthorized: async () => 'authorized' as const,
      },
      storage: storage(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      routeAdmissionBinding: routeAdmissionBinding(),
    };
    expect(() =>
      createHostedTeamConfigurationComposition({
        ...dependencies,
        expectedDeploymentId: 'deployment_other',
      })
    ).toThrow('hosted-team-configuration-deployment-binding-invalid');

    const composition = createHostedTeamConfigurationComposition(dependencies);
    const app = Fastify();
    composition.register(app);
    expect(() => composition.register(app)).toThrow(
      'hosted-team-configuration-composition-already-registered'
    );
    await app.close();
  });

  it('uses feature-specific admission so configuration readiness cannot admit lifecycle routes', async () => {
    let ready = false;
    const binding = createHostedTeamConfigurationRouteAdmissionBinding(() => ready);

    await expect(
      binding.routeAdmission.admit('team-configuration.create-draft.v1')
    ).resolves.toMatchObject({ admitted: false, statusCode: 503 });
    ready = true;
    await expect(
      binding.routeAdmission.admit('team-configuration.create-draft.v1')
    ).resolves.toMatchObject({ admitted: true });
    await expect(binding.routeAdmission.admit('team-lifecycle.launch.v1')).rejects.toThrow(
      'hosted-route-not-found'
    );
  });

  it('maps authorization dependency unavailability to retryable 503', async () => {
    const composition = createHostedTeamConfigurationComposition({
      authentication: {
        authenticatedPrincipalFor: () => principal(),
        isTeamConfigurationScopeAuthorized: async () => 'unavailable',
      },
      storage: storage(),
      runtimeInstance: runtimeInstance(),
      expectedDeploymentId: DEPLOYMENT_ID,
      routeAdmissionBinding: routeAdmissionBinding(),
    });
    const app = Fastify();
    composition.register(app);
    try {
      const response = await app.inject({
        method: 'POST',
        url: HOSTED_TEAM_CONFIGURATION_ROUTES.getSavedRequest,
        payload: {
          schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
          workspaceId: WORKSPACE_ID,
          teamId: TEAM_ID,
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        kind: 'error',
        error: { code: 'unavailable' },
        retryable: true,
      });
    } finally {
      await app.close();
    }
  });
});
