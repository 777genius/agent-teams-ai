import {
  classifyHostedHttpAuthorization,
  type HostedAuthenticatedPrincipal,
  type HostedHttpAuthorization,
} from '@features/hosted-access';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only authenticated context facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
import { HOSTED_WORKSPACE_REGISTRY_ROUTES } from '@features/workspace-registry/contracts';
// eslint-disable-next-line no-restricted-imports -- Bounded server-only workspace-registry facet.
import {
  type HostedWorkspaceRegistryAuthorizationPort,
  HostedWorkspaceRegistryHttpAdapter,
  type HostedWorkspaceRegistryPrincipal,
  registerHostedWorkspaceRegistryHttp,
} from '@features/workspace-registry/main/hosted';
import { parseWorkspaceId, type QueryContext, type WorkspaceId } from '@shared/contracts/hosted';

import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceRegistryStartupSnapshot } from '@features/workspace-registry/main';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const REGISTRY_ROUTE_AUTHORIZATION = new Map<string, HostedHttpAuthorization>([
  [
    `POST:${HOSTED_WORKSPACE_REGISTRY_ROUTES.list}`,
    Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
    }),
  ],
  [
    `POST:${HOSTED_WORKSPACE_REGISTRY_ROUTES.select}`,
    Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
    }),
  ],
]);

/** Adds only the two registry POST routes to the fail-closed hosted auth inventory. */
export function classifyHostedWorkspaceRegistryAuthorization(
  method: string,
  url: string,
  fallback: (
    method: string,
    url: string
  ) => HostedHttpAuthorization = classifyHostedHttpAuthorization
): HostedHttpAuthorization {
  const path = url.split('?', 1)[0] ?? url;
  return (
    REGISTRY_ROUTE_AUTHORIZATION.get(`${method.toUpperCase()}:${path}`) ?? fallback(method, url)
  );
}

export interface HostedWorkspaceRegistryAuthenticationPort {
  authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  resolveGrantedRuntimeWorkspaceId(
    request: object,
    publicWorkspaceId: string
  ): Promise<string | null>;
  projectGrantedPublicWorkspaceId(
    request: object,
    runtimeWorkspaceId: string
  ): Promise<string | null>;
}

export interface HostedWorkspaceRegistryComposition {
  register(app: FastifyInstance): void;
}

export interface CreateHostedWorkspaceRegistryCompositionDependencies {
  readonly authentication: HostedWorkspaceRegistryAuthenticationPort;
  readonly snapshot: WorkspaceRegistryStartupSnapshot;
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
}

/** Mounts the immutable admitted snapshot while revalidating the live principal grant per row. */
export function createHostedWorkspaceRegistryComposition(
  dependencies: CreateHostedWorkspaceRegistryCompositionDependencies
): HostedWorkspaceRegistryComposition {
  if (dependencies.runtimeInstance.deploymentId !== dependencies.expectedDeploymentId) {
    throw new TypeError('hosted-workspace-registry-deployment-binding-invalid');
  }
  const contexts = createAuthenticatedHostedQueryContextFactory({
    authentication: dependencies.authentication,
    runtimeInstance: dependencies.runtimeInstance,
  });
  const requests = new Map<QueryContext['requestId'], FastifyRequest>();
  const requestFor = (
    principal: HostedWorkspaceRegistryPrincipal,
    context: QueryContext
  ): FastifyRequest | null => {
    if (principal.actorId !== context.actorId || principal.sessionId !== context.sessionId)
      return null;
    return requests.get(context.requestId) ?? null;
  };
  const authorization: HostedWorkspaceRegistryAuthorizationPort = Object.freeze({
    projectPublicWorkspaceId: async (
      principal: HostedWorkspaceRegistryPrincipal,
      runtimeWorkspaceId: WorkspaceId,
      context: QueryContext
    ) => {
      const request = requestFor(principal, context);
      if (request === null) return null;
      const projected = await dependencies.authentication.projectGrantedPublicWorkspaceId(
        request,
        runtimeWorkspaceId
      );
      return projected === null ? null : parseWorkspaceId(projected);
    },
    resolveRuntimeWorkspaceId: async (
      principal: HostedWorkspaceRegistryPrincipal,
      publicWorkspaceId: WorkspaceId,
      context: QueryContext
    ) => {
      const request = requestFor(principal, context);
      if (request === null) return null;
      const resolved = await dependencies.authentication.resolveGrantedRuntimeWorkspaceId(
        request,
        publicWorkspaceId
      );
      return resolved === null ? null : parseWorkspaceId(resolved);
    },
  });
  const facade = new HostedWorkspaceRegistryHttpAdapter(
    dependencies.snapshot,
    authorization,
    dependencies.runtimeInstance.bootId
  );
  let registered = false;

  return Object.freeze({
    register(app: FastifyInstance): void {
      if (registered) throw new Error('hosted-workspace-registry-composition-already-registered');
      registered = true;
      registerHostedWorkspaceRegistryHttp(
        app,
        facade,
        (request, signal) => {
          const result = contexts.create(request, signal);
          if (result.kind !== 'success') {
            throw new Error(`hosted-workspace-registry-context-${result.code}`);
          }
          requests.set(result.context.requestId, request);
          return result.context;
        },
        (context) => requests.delete(context.requestId)
      );
    },
  });
}
