import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import {
  parseDirectoryFingerprint,
  parseLegacyTeamKey,
  parseTeamAdoptionIntentId,
  parseTeamDraftPublicationScope,
} from '@features/internal-storage/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import {
  HOSTED_TEAM_CONFIGURATION_ROUTES,
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
} from '@features/team-configuration/contracts';
import { HOSTED_PROMOTION_ROUTE } from '@features/team-configuration/contracts/hostedPromotion';
// eslint-disable-next-line no-restricted-imports -- Focused production-composition descriptor fixture.
import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from '@features/team-configuration/main/hosted';
import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
} from '@main/composition/hosted/application';
import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import {
  classifyHostedTeamConfigurationAuthorization,
  createHostedTeamConfigurationComposition,
  createHostedTeamConfigurationRouteAdmissionBinding,
} from '../../../../src/main/composition/hosted/hostedTeamConfigurationComposition';

import type {
  HostedPromotionStorageGateway,
  HostedTeamConfigurationStorageGateway,
} from '@features/internal-storage/contracts';
import type { HostedDraftPublicationComposition } from '@main/composition/hosted/hostedDraftPublicationComposition';

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

function promotionFixture(failure: 'publish' | 'fence' | 'session_changed' | 'identity_changed' | 'owner_transport' | 'owner_rejected' | 'after_owner' | 'topology' | 'success') {
  const runtimeWorkspaceId = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
  const createOperationId = parseTeamAdoptionIntentId(`adoption_${'d'.repeat(32)}`);
  const directoryFingerprint = parseDirectoryFingerprint('e'.repeat(64));
  const planGeneration = `plan-generation_${'f'.repeat(64)}`;
  let published = false;
  let admitted = false;
  let identityReads = 0;
  const publication = {
    journal: {
      readTeamDraftPublication: async (scope: unknown) => ({
        ...parseTeamDraftPublicationScope(scope),
        operationId: createOperationId, runtimeWorkspaceId, bindingGeneration: 1,
        legacyKey: parseLegacyTeamKey(`draft-${'d'.repeat(32)}`),
        createdAt: '2026-09-24T00:00:00.000Z',
        directoryFingerprint, state: 'published' as const,
      }),
    },
    identities: {
      getTeamIdentity: async () => {
        identityReads += 1;
        return {
          teamId: TEAM_ID, state: 'active',
          legacyKey: parseLegacyTeamKey(`draft-${'d'.repeat(32)}`),
          directoryFingerprint,
          workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
          adoptionIntentId: createOperationId,
          identityChecksum: (failure === 'identity_changed' && identityReads >= 3 ? 'e' : 'f').repeat(64),
          createdAt: '2026-09-24T00:00:00.000Z',
          activatedAt: '2026-09-24T00:00:01.000Z', tombstonedAt: null,
        };
      },
    },
    captureWorkspace: async () => ({
      runtimeWorkspaceId, bindingGeneration: 1,
      grantRevision: 'a'.repeat(64), grantGeneration: 1,
      assertCurrent: async () => {
        if ((failure === 'fence' && published) || (failure === 'after_owner' && admitted)) {
          throw new Error('/secret/team/path and private plan content');
        }
      },
    }),
    publishPromotionPlan: vi.fn(async () => {
      published = true;
      if (failure === 'publish') throw new Error('/secret/team/path and private plan content');
    }),
  } as unknown as HostedDraftPublicationComposition;
  const promotions: HostedPromotionStorageGateway = {
    begin: vi.fn(async (input) => failure === 'topology' ? {
      kind: 'unavailable' as const, reason: 'mixed_runtime_topology' as const,
    } : ({
      kind: 'frozen' as const,
      operation: {
        workspaceId: input.workspaceId, teamId: input.teamId,
        actorId: input.actorId, deploymentId: input.deploymentId,
        createOperationId, runtimeWorkspaceId, bindingGeneration: 1,
        expectedRevision: input.expectedRevision, idempotencyKey: input.idempotencyKey,
        operationId: `promotion_${'a'.repeat(32)}`,
        admittedWorkspaceRoot: '/private/root', frozenRosterJson: '{}',
        frozenDraftJson: '{}', laneIds: [`lane_${'b'.repeat(32)}`],
        planJson: '{"private":"plan"}', planSha256: 'f'.repeat(64),
        planGeneration, createdAtMs: 1, state: 'frozen' as const,
      },
    })),
    lookup: vi.fn(async () => null),
    lookupRosterBinding: vi.fn(async () => null),
  };
  const admitPromotionPlan = vi.fn(async (..._args: unknown[]) => {
    if (failure === 'owner_transport') throw new Error('/secret/team/path and private plan content');
    if (failure === 'owner_rejected') return { kind: 'unavailable' as const };
    admitted = true;
    return { kind: 'admitted' as const, planGeneration };
  });
  const composition = createHostedTeamConfigurationComposition({
    authentication: {
      authenticatedPrincipalFor: () =>
        failure === 'session_changed' && published
          ? { ...principal(), authenticatedSessionId: parseHostedSessionId('session_changed') }
          : principal(),
      isTeamConfigurationScopeAuthorized: async () => 'authorized',
    },
    storage: storage(), publication, restoreGeneration: 1,
    promotions, promotionWorkspaceRoot: '/private/root', admitPromotionPlan,
    runtimeInstance: runtimeInstance(), expectedDeploymentId: DEPLOYMENT_ID,
    routeAdmissionBinding: routeAdmissionBinding(),
  });
  const app = Fastify();
  composition.register(app);
  return { app, publication, admitPromotionPlan };
}

describe('hosted team-configuration production composition', () => {
  it('passes a server-captured published-draft grant and identity fence to signed Owner admission', async () => {
    const { app, admitPromotionPlan } = promotionFixture('success');
    try {
      const response = await app.inject({
        method: 'POST', url: HOSTED_PROMOTION_ROUTE,
        payload: {
          schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID,
          expectedRevision: 'revision_saved-draft',
          idempotencyKey: 'idempotency_published-draft-0001',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(admitPromotionPlan).toHaveBeenCalledOnce();
      expect(admitPromotionPlan.mock.calls[0]).toHaveLength(4);
      expect(admitPromotionPlan.mock.calls[0]?.[3]).toMatchObject({
        workspaceId: `workspace_${'c'.repeat(32)}`,
        teamId: TEAM_ID,
        ownerEffectFence: {
          grantRevision: 'a'.repeat(64),
          identityChecksum: 'f'.repeat(64),
        },
      });
    } finally {
      await app.close();
    }
  });

  it.each([
    ['publish', 'promotion_publish_unavailable'],
    ['fence', 'promotion_post_publish_fence_unavailable'],
    ['session_changed', 'promotion_post_publish_fence_unavailable'],
    ['identity_changed', 'promotion_owner_admission_proof_unavailable'],
    ['owner_transport', 'promotion_owner_admission_transport_unavailable'],
    ['owner_rejected', 'promotion_owner_admission_rejected'],
    ['after_owner', 'promotion_post_owner_fence_unavailable'],
  ] as const)('reports only the allowlisted %s promotion failure stage', async (failure, reason) => {
    const { app, admitPromotionPlan } = promotionFixture(failure);
    try {
      const response = await app.inject({
        method: 'POST', url: HOSTED_PROMOTION_ROUTE,
        payload: {
          schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID,
          expectedRevision: 'revision_saved-draft',
          idempotencyKey: 'idempotency_published-draft-0001',
        },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        schemaVersion: 1, kind: 'error',
        error: { code: 'unavailable', reason }, retryable: true,
      });
      expect(response.body).not.toContain('/secret/team/path');
      expect(response.body).not.toContain('private plan content');
      if (failure === 'identity_changed') expect(admitPromotionPlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('reports an unlaunchable roster topology as a permanent typed refusal', async () => {
    const { app, admitPromotionPlan } = promotionFixture('topology');
    try {
      const response = await app.inject({
        method: 'POST', url: HOSTED_PROMOTION_ROUTE,
        payload: {
          schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID,
          expectedRevision: 'revision_saved-draft',
          idempotencyKey: 'idempotency_published-draft-0001',
        },
      });
      expect(response.statusCode).toBe(422);
      expect(response.json()).toEqual({
        schemaVersion: 1, kind: 'error',
        error: { code: 'unsupported', reason: 'promotion_mixed_runtime_topology' }, retryable: false,
      });
      expect(admitPromotionPlan).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('authorizes a published draft promotion with the exact four-field publication scope', async () => {
    const runtimeWorkspaceId = parseWorkspaceId(`workspace_${'c'.repeat(32)}`);
    const operationId = parseTeamAdoptionIntentId(`adoption_${'d'.repeat(32)}`);
    const directoryFingerprint = parseDirectoryFingerprint('e'.repeat(64));
    const readTeamDraftPublication = vi.fn(async (scope: unknown) => {
      const exact = parseTeamDraftPublicationScope(scope);
      return {
        ...exact, operationId,
        runtimeWorkspaceId, bindingGeneration: 1,
        legacyKey: parseLegacyTeamKey(`draft-${'d'.repeat(32)}`),
        createdAt: '2026-09-24T00:00:00.000Z',
        initialRevision: 'revision_saved-draft' as never,
        directoryFingerprint, state: 'published' as const,
      };
    });
    const publication = {
      journal: { readTeamDraftPublication },
      identities: { getTeamIdentity: async () => ({
        teamId: TEAM_ID, state: 'active',
        legacyKey: parseLegacyTeamKey(`draft-${'d'.repeat(32)}`),
        directoryFingerprint,
        workspaceBinding: { workspaceId: runtimeWorkspaceId, generation: 1 },
        adoptionIntentId: operationId,
        identityChecksum: 'f'.repeat(64),
        createdAt: '2026-09-24T00:00:00.000Z',
        activatedAt: '2026-09-24T00:00:01.000Z', tombstonedAt: null,
      }) },
      captureWorkspace: async () => ({
        runtimeWorkspaceId, bindingGeneration: 1,
        grantRevision: 'a'.repeat(64), grantGeneration: 1,
        assertCurrent: async () => {},
      }),
    } as unknown as HostedDraftPublicationComposition;
    const composition = createHostedTeamConfigurationComposition({
      authentication: {
        authenticatedPrincipalFor: () => principal(),
        isTeamConfigurationScopeAuthorized: async () => 'authorized',
      },
      storage: storage(), publication, restoreGeneration: 1,
      runtimeInstance: runtimeInstance(), expectedDeploymentId: DEPLOYMENT_ID,
      routeAdmissionBinding: routeAdmissionBinding(),
    });
    const app = Fastify();
    composition.register(app);
    try {
      const response = await app.inject({
        method: 'POST', url: HOSTED_PROMOTION_ROUTE,
        payload: {
          schemaVersion: 1, workspaceId: WORKSPACE_ID, teamId: TEAM_ID,
          expectedRevision: 'revision_saved-draft',
          idempotencyKey: 'idempotency_published-draft-0001',
        },
      });
      expect(readTeamDraftPublication).toHaveBeenCalledOnce();
      expect(response.statusCode).toBe(503);
      // No promotion executor is wired here; reaching its own error proves exact attribution passed.
      expect(response.json()).toMatchObject({
        kind: 'error', error: { code: 'unavailable', reason: 'promotion_unavailable' },
      });
    } finally {
      await app.close();
    }
  });

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
