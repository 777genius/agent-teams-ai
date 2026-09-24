import {
  classifyHostedHttpAuthorization,
  type HostedAuthenticatedPrincipal,
  type HostedHttpAuthorization,
} from '@features/hosted-access';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only authenticated context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import {
  HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
  promotionError,
} from '@features/team-configuration/contracts';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only team-configuration facet.
import {
  createHostedPromotionPrerequisite,
  createHostedTeamConfigurationAuthority,
  createHostedTeamConfigurationFeature,
  createHostedTeamConfigurationRouteContribution,
  createReservedDraftConfigurationAttribution,
  HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
  type HostedTeamConfigurationAuthorizationPort,
  type HostedTeamConfigurationAuthorizationRequest,
  type HostedTeamConfigurationAuthorizationScope,
  type HostedTeamConfigurationOperation,
  registerHostedTeamConfigurationHttp,
} from '@features/team-configuration/main/hosted';
import {
  createSafeAppError,
  type QueryContext,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import {
  createHostedRouteAdmissionBinding,
  HOSTED_READINESS_DIMENSIONS,
  HOSTED_TERMINAL_READINESS,
  type HostedReadinessDimensionStates,
  type HostedRouteAdmissionBinding,
} from './application';

import type { HostedDraftPublicationComposition } from './hostedDraftPublicationComposition';
import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';
import type { HostedPromotionStorageGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type {
  HostedPromoteDraftRequest,
  HostedPromoteDraftResult,
} from '@features/team-configuration/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MUTATIONS = new Set<HostedTeamConfigurationOperation>([
  'create_draft',
  'update_draft',
  'delete_draft',
  'recover_publication',
  'promote_draft',
]);

const AUTHORIZATION_BY_ROUTE = new Map(
  HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS.map((descriptor) => [
    `${descriptor.method}:${descriptor.path}`,
    descriptor.authPolicyId === 'hosted.browser.session.csrf'
      ? Object.freeze({
          kind: 'authenticated' as const,
          permission: 'hosted.command' as const,
          csrfRequired: true,
          workspaceRequired: false,
        })
      : Object.freeze({
          kind: 'authenticated' as const,
          permission: 'hosted.query' as const,
          csrfRequired: false,
          workspaceRequired: false,
        }),
  ])
);

/** Extends hosted auth admission only for the exact durable configuration descriptors. */
export function classifyHostedTeamConfigurationAuthorization(
  method: string,
  url: string
): HostedHttpAuthorization {
  const path = url.split('?', 1)[0] ?? url;
  return (
    AUTHORIZATION_BY_ROUTE.get(`${method.toUpperCase()}:${path}`) ??
    classifyHostedHttpAuthorization(method, url)
  );
}

export interface HostedTeamConfigurationAuthenticationPort {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  isTeamConfigurationScopeAuthorized(
    request: object,
    scope: Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }>,
    mutation: boolean
  ): Promise<'authorized' | 'denied' | 'unavailable'>;
}

export interface HostedTeamConfigurationComposition {
  register(app: FastifyInstance): void;
  isReady(): boolean;
}

export interface CreateHostedTeamConfigurationCompositionDependencies {
  readonly publication?: HostedDraftPublicationComposition | null;
  readonly restoreGeneration?: number;
  readonly authentication: HostedTeamConfigurationAuthenticationPort;
  readonly storage: HostedTeamConfigurationStorageGateway;
  readonly promotions?: HostedPromotionStorageGateway;
  readonly promotionWorkspaceRoot?: string;
  /** Signed Owner operation: accepts a generation only, never Product plan bytes. */
  readonly admitPromotionPlan?: (
    input: {
      readonly workspaceId: WorkspaceId;
      readonly teamId: TeamId;
      readonly workspaceRoot: string;
      readonly expectedPlanGeneration: string;
    },
    context: QueryContext,
    httpRequest: object
  ) => Promise<
    | { readonly kind: 'admitted'; readonly planGeneration: string }
    | { readonly kind: 'not_found' | 'unavailable' }
  >;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  readonly routeAdmissionBinding: HostedRouteAdmissionBinding;
  readonly now?: () => number;
}

export function createHostedTeamConfigurationRouteAdmissionBinding(
  isReady: () => boolean
): HostedRouteAdmissionBinding {
  return createHostedRouteAdmissionBinding({
    routes: HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
    routeScope: 'production',
    readiness: {
      readiness: async () => {
        const ready = isReady();
        return Object.freeze({
          revision: ready ? 1 : 0,
          dimensions: Object.freeze({
            ...Object.fromEntries(
              HOSTED_READINESS_DIMENSIONS.map((dimension) => [
                dimension,
                Object.freeze({
                  dimension,
                  status: ready ? ('ready' as const) : ('not_ready' as const),
                  reasons: Object.freeze(ready ? [] : ['team_configuration_unavailable']),
                }),
              ])
            ),
            terminal: HOSTED_TERMINAL_READINESS,
          }) as HostedReadinessDimensionStates,
        });
      },
    },
  });
}

function authorizationScope(
  scope: HostedTeamConfigurationAuthorizationScope
): Readonly<{ workspaceId: WorkspaceId; teamId?: TeamId }> {
  return scope.kind === 'workspace'
    ? Object.freeze({ workspaceId: scope.workspaceId })
    : Object.freeze({ workspaceId: scope.identity.workspaceId, teamId: scope.identity.teamId });
}

function authorizationUnavailableResult() {
  return Object.freeze({
    schemaVersion: HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION,
    kind: 'error' as const,
    error: createSafeAppError({
      code: 'unavailable',
      reason: 'team_configuration_unavailable',
    }),
    retryable: true,
  });
}

/** Wires durable use cases to hosted HTTP without adding transport-owned team behavior. */
export function createHostedTeamConfigurationComposition(
  dependencies: CreateHostedTeamConfigurationCompositionDependencies
): HostedTeamConfigurationComposition {
  if (dependencies.runtimeInstance.deploymentId !== dependencies.expectedDeploymentId) {
    throw new TypeError('hosted-team-configuration-deployment-binding-invalid');
  }
  const requests = new WeakMap<QueryContext, FastifyRequest>();
  const authorizationUnavailable = new WeakSet<QueryContext>();
  const mutations = new WeakMap<QueryContext, boolean>();
  const publication = dependencies.publication;
  const captureWorkspace = async (workspaceId: WorkspaceId, context: QueryContext) => {
    const request = requests.get(context);
    const principal = request && dependencies.authentication.authenticatedPrincipalFor(request);
    if (!request || !principal || !publication || dependencies.restoreGeneration === undefined) {
      throw new Error('draft-publication-authority-unavailable');
    }
    const authorizeWorkspace = async () => {
      const fresh = dependencies.authentication.authenticatedPrincipalFor(request);
      if (
        !fresh ||
        fresh.principal.userId !== principal.principal.userId ||
        fresh.authenticatedSessionId !== principal.authenticatedSessionId ||
        (await dependencies.authentication.isTeamConfigurationScopeAuthorized(
          request,
          { workspaceId },
          mutations.get(context) === true
        )) !== 'authorized'
      ) {
        throw new Error('draft-publication-authorization-changed');
      }
    };
    await authorizeWorkspace();
    const fence = await publication.captureWorkspace(
      workspaceId,
      principal,
      context,
      dependencies.restoreGeneration
    );
    return {
      ...fence,
      assertCurrent: async () => {
        await authorizeWorkspace();
        await fence.assertCurrent();
      },
    };
  };
  const reservedAttribution = publication
    ? createReservedDraftConfigurationAttribution({
        publications: publication.journal,
        identities: publication.identities,
      })
    : null;
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authentication,
    runtimeInstance: dependencies.runtimeInstance,
    ...(dependencies.now === undefined ? {} : { clock: { nowMs: dependencies.now } }),
  });
  const authorization: HostedTeamConfigurationAuthorizationPort = Object.freeze({
    authorize: async ({
      operation,
      scope,
      principal,
    }: HostedTeamConfigurationAuthorizationRequest) => {
      const request = requests.get(principal);
      if (request === undefined) return Object.freeze({ kind: 'denied' as const });
      let decision: 'authorized' | 'denied' | 'unavailable';
      try {
        if (publication && scope.kind === 'team' && reservedAttribution) {
          const fence = await captureWorkspace(scope.identity.workspaceId, principal);
          const attribution = await reservedAttribution(
            {
              workspaceId: scope.identity.workspaceId,
              teamId: scope.identity.teamId,
              actorId: principal.actorId,
              deploymentId: principal.deploymentId,
            },
            fence.runtimeWorkspaceId
          );
          await fence.assertCurrent();
          decision =
            attribution.kind === 'found'
              ? 'authorized'
              : attribution.kind === 'unavailable'
                ? 'unavailable'
                : await dependencies.authentication.isTeamConfigurationScopeAuthorized(
                    request,
                    authorizationScope(scope),
                    MUTATIONS.has(operation)
                  );
        } else {
          decision = await dependencies.authentication.isTeamConfigurationScopeAuthorized(
            request,
            authorizationScope(scope),
            MUTATIONS.has(operation)
          );
        }
      } catch {
        decision = 'unavailable';
      }
      if (decision === 'authorized') {
        return Object.freeze({
          kind: 'authorized' as const,
          principalId: principal.actorId,
          scope,
        });
      }
      if (decision === 'unavailable') authorizationUnavailable.add(principal);
      return Object.freeze({ kind: 'denied' as const });
    },
  });
  const feature = createHostedTeamConfigurationFeature(
    createHostedTeamConfigurationAuthority(
      dependencies.storage,
      publication
        ? {
            journal: publication.journal,
            publisher: publication.publisher,
            captureWorkspace,
          }
        : undefined
    ),
    authorization,
    async (
      request: HostedPromoteDraftRequest,
      context: QueryContext
    ): Promise<HostedPromoteDraftResult> => {
      const promotionStorage = dependencies.promotions;
      const workspaceRoot = dependencies.promotionWorkspaceRoot;
      const ownerAdmission = dependencies.admitPromotionPlan;
      const incoming = requests.get(context);
      if (!promotionStorage || !publication || !workspaceRoot || !ownerAdmission || !incoming) {
        return promotionError('unavailable', 'promotion_unavailable', true);
      }
      let admittedGeneration: string | null = null;
      const promotion = createHostedPromotionPrerequisite({
        storage: promotionStorage,
        capture: async (scope, signal) => {
          const authenticated = dependencies.authentication.authenticatedPrincipalFor(incoming);
          if (!authenticated || signal.aborted || authenticated.principal.userId.length === 0) {
            throw new Error('promotion-principal-unavailable');
          }
          const workspaceFence = await captureWorkspace(scope.workspaceId, context);
          const publicationScope = {
            workspaceId: scope.workspaceId,
            teamId: scope.teamId,
            actorId: context.actorId,
            deploymentId: context.deploymentId,
          };
          const saved = await publication.journal.readTeamDraftPublication(publicationScope);
          if (
            !saved ||
            saved.state !== 'published' ||
            !saved.directoryFingerprint ||
            saved.runtimeWorkspaceId !== workspaceFence.runtimeWorkspaceId ||
            workspaceFence.grantRevision === undefined ||
            workspaceFence.grantGeneration === undefined
          ) {
            throw new Error('promotion-publication-unavailable');
          }
          const revalidate = async () => {
            const fresh = dependencies.authentication.authenticatedPrincipalFor(incoming);
            if (
              !fresh ||
              fresh.principal.userId !== authenticated.principal.userId ||
              fresh.authenticatedSessionId !== authenticated.authenticatedSessionId ||
              context.signal.aborted ||
              Date.now() >= context.deadlineAtMs ||
              (await dependencies.authentication.isTeamConfigurationScopeAuthorized(
                incoming,
                { workspaceId: scope.workspaceId, teamId: scope.teamId },
                true
              )) !== 'authorized'
            ) {
              throw new Error('promotion-authority-revoked');
            }
            await workspaceFence.assertCurrent();
          };
          await revalidate();
          return {
            binding: {
              actorId: context.actorId,
              deploymentId: context.deploymentId,
              runtimeWorkspaceId: workspaceFence.runtimeWorkspaceId,
              bindingGeneration: saved.bindingGeneration,
              createOperationId: saved.operationId,
              admittedWorkspaceRoot: workspaceRoot,
              authorityEvidence: {
                userId: authenticated.principal.userId,
                sessionId: authenticated.authenticatedSessionId,
                grantRevision: workspaceFence.grantRevision,
                grantGeneration: workspaceFence.grantGeneration,
              },
            },
            revalidate,
          };
        },
        publish: async (operation, fence) => {
          const saved = await publication.journal.readTeamDraftPublication({
            workspaceId: operation.workspaceId,
            teamId: operation.teamId,
            actorId: operation.actorId,
            deploymentId: operation.deploymentId,
          });
          if (
            !saved ||
            saved.state !== 'published' ||
            !saved.directoryFingerprint ||
            saved.operationId !== operation.createOperationId ||
            saved.bindingGeneration !== operation.bindingGeneration
          ) {
            throw new Error('promotion-publication-conflict');
          }
          await publication.publishPromotionPlan(operation, saved.directoryFingerprint, () =>
            fence.revalidate()
          );
          await fence.revalidate();
          const admitted = await ownerAdmission(
            {
              workspaceId: operation.runtimeWorkspaceId,
              teamId: operation.teamId,
              workspaceRoot,
              expectedPlanGeneration: operation.planGeneration,
            },
            context,
            incoming
          );
          if (
            admitted.kind !== 'admitted' ||
            admitted.planGeneration !== operation.planGeneration
          ) {
            throw new Error('promotion-owner-admission-unavailable');
          }
          admittedGeneration = operation.planGeneration;
        },
      });
      const result = await promotion.execute(request, {
        signal: context.signal,
        deadlineAtMs: context.deadlineAtMs,
      });
      if ('operationId' in result) {
        return admittedGeneration
          ? {
              schemaVersion: 1,
              kind: 'promoted',
              teamId: result.teamId,
              operationId: result.operationId,
              planGeneration: admittedGeneration,
            }
          : promotionError('unavailable', 'promotion_owner_admission_unavailable', true);
      }
      return result.kind === 'conflict'
        ? promotionError('conflict', `promotion_${result.reason}`, false)
        : promotionError(
            'unavailable',
            `promotion_${result.kind === 'unavailable' ? result.reason : 'unavailable'}`,
            true
          );
    }
  );
  const preserveAuthorizationAvailability = async <Result>(
    principal: QueryContext,
    operation: () => Promise<Result>
  ): Promise<Result> => {
    authorizationUnavailable.delete(principal);
    const result = await operation();
    // Every request owns a distinct QueryContext, so this marker cannot cross request boundaries.
    return authorizationUnavailable.delete(principal)
      ? (authorizationUnavailableResult() as Result)
      : result;
  };
  const httpFeature = Object.freeze({
    routes: feature.routes,
    promoteDraft: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.promoteDraft!(body, principal)),
    getPublication: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.getPublication!(body, principal)),
    recoverPublication: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () =>
        feature.recoverPublication!(body, principal)
      ),
    getSavedRequest: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.getSavedRequest(body, principal)),
    createDraft: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.createDraft(body, principal)),
    updateDraft: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.updateDraft(body, principal)),
    deleteDraft: (body: unknown, principal: QueryContext) =>
      preserveAuthorizationAvailability(principal, () => feature.deleteDraft(body, principal)),
  });
  const contribution = createHostedTeamConfigurationRouteContribution(httpFeature);
  let registered = false;

  return Object.freeze({
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-team-configuration-composition-already-registered');
      registered = true;
      registerHostedTeamConfigurationHttp(
        app,
        contribution,
        dependencies.routeAdmissionBinding.routeAdmission,
        (_descriptor, request, signal) => {
          const result = contexts.create(request, signal);
          if (result.kind !== 'success') {
            throw new Error(`hosted-team-configuration-context-${result.code}`);
          }
          requests.set(result.context, request);
          mutations.set(result.context, _descriptor.authPolicyId === 'hosted.browser.session.csrf');
          return result.context;
        }
      );
    },
    isReady: () => dependencies.publication !== null,
  });
}
