import {
  classifyHostedHttpAuthorization,
  type HostedHttpAuthorization,
} from '@features/hosted-access';
import {
  createHostedTeamMessageRouteContribution,
  type CreateHostedTeamMessageRouteContributionDependencies,
  type HostedTeamMessageRouteAccess,
  type HostedTeamMessageRouteContribution,
} from '@features/team-message-delivery/main';

import {
  createHostedBoundTeamReadDispatcher,
  type HostedBoundTeamReadDependencies,
} from './hostedBoundTeamReadDispatcher';

const AUTHORIZATION_BY_ROUTE = new Map<string, HostedHttpAuthorization>([
  [
    'POST:/api/hosted/v1/team-messages/page',
    Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.query',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    }),
  ],
  [
    'POST:/api/hosted/v1/team-messages/send',
    Object.freeze({
      kind: 'authenticated',
      permission: 'hosted.command',
      csrfRequired: true,
      workspaceRequired: false,
      teamWorkspaceRequired: true,
    }),
  ],
]);

/** Adds only the exact hosted team-message POST routes to the fail-closed auth inventory. */
export function classifyHostedTeamMessageAuthorization(
  method: string,
  url: string,
  fallback: (
    method: string,
    url: string
  ) => HostedHttpAuthorization = classifyHostedHttpAuthorization
): HostedHttpAuthorization {
  const path = url.split('?', 1)[0] ?? url;
  return AUTHORIZATION_BY_ROUTE.get(`${method.toUpperCase()}:${path}`) ?? fallback(method, url);
}

/**
 * App-shell wiring for the feature-owned hosted message contribution. Message projection,
 * persistence, authorization, and delivery classification remain inside team-message-delivery.
 */
export interface CreateHostedTeamMessageCompositionDependencies
  extends
    Omit<CreateHostedTeamMessageRouteContributionDependencies, 'authorization'>,
    HostedBoundTeamReadDependencies {
  readonly authentication: HostedTeamMessageRouteAccess['http'];
}

export interface HostedTeamMessageComposition extends HostedTeamMessageRouteContribution {
  canReadWorkspace(runtimeWorkspaceId: string): boolean;
}

export interface HostedTeamMessageCompositionAccess {
  readonly http: HostedTeamMessageRouteAccess['http'];
  readonly deploymentId: string;
}

export type HostedTeamMessageRouteFactory = (
  access: HostedTeamMessageCompositionAccess
) => HostedTeamMessageComposition;

export function createHostedTeamMessageComposition(
  dependencies: CreateHostedTeamMessageCompositionDependencies
): HostedTeamMessageComposition {
  const { authentication, ...featureDependencies } = dependencies;
  if (dependencies.admittedReadBindings !== undefined) {
    const boundReads = createHostedBoundTeamReadDispatcher(dependencies);
    const contribution = createHostedTeamMessageRouteContribution({
      ...featureDependencies,
      authorization: authentication,
      boundReadTargets: boundReads,
    });
    return Object.freeze({
      register: (app: unknown) => contribution.register(app),
      canReadWorkspace: (runtimeWorkspaceId: string) =>
        boundReads.canReadWorkspace(runtimeWorkspaceId),
    });
  }
  const contribution = createHostedTeamMessageRouteContribution({
    ...featureDependencies,
    authorization: authentication,
  });
  return Object.freeze({
    register: (app: unknown) => contribution.register(app),
    canReadWorkspace: (runtimeWorkspaceId: string) =>
      runtimeWorkspaceId === dependencies.mountBinding.workspaceId,
  });
}

export function createHostedTeamMessageRouteFactory(
  dependencies: Omit<
    CreateHostedTeamMessageCompositionDependencies,
    'authentication' | 'expectedDeploymentId'
  >
): HostedTeamMessageRouteFactory {
  return (access) =>
    createHostedTeamMessageComposition({
      ...dependencies,
      authentication: access.http,
      expectedDeploymentId: access.deploymentId,
    });
}
