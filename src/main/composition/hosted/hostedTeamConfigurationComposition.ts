import {
  classifyHostedHttpAuthorization,
  type HostedAuthenticatedPrincipal,
  type HostedHttpAuthorization,
} from '@features/hosted-access';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only authenticated context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import { HOSTED_TEAM_CONFIGURATION_SCHEMA_VERSION } from '@features/team-configuration/contracts';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only team-configuration facet.
import {
  createHostedTeamConfigurationAuthority,
  createHostedTeamConfigurationFeature,
  createHostedTeamConfigurationRouteContribution,
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

import type { HostedTeamConfigurationStorageGateway } from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const MUTATIONS = new Set<HostedTeamConfigurationOperation>([
  'create_draft',
  'update_draft',
  'delete_draft',
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
  readonly authentication: HostedTeamConfigurationAuthenticationPort;
  readonly storage: HostedTeamConfigurationStorageGateway;
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
      const decision = await dependencies.authentication.isTeamConfigurationScopeAuthorized(
        request,
        authorizationScope(scope),
        MUTATIONS.has(operation)
      );
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
    createHostedTeamConfigurationAuthority(dependencies.storage),
    authorization
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
          return result.context;
        }
      );
    },
    isReady: () => true,
  });
}
