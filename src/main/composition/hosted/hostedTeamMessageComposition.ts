import {
  classifyHostedHttpAuthorization,
  type HostedHttpAuthorization,
} from '@features/hosted-access';
import {
  createHostedTeamMessageRouteContribution,
  type CreateHostedTeamMessageRouteContributionDependencies,
  createHostedTeamMessageRouteFactory as createFeatureHostedTeamMessageRouteFactory,
  type HostedTeamMessageRouteAccess,
  type HostedTeamMessageRouteContribution,
} from '@features/team-message-delivery/main';
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
export interface CreateHostedTeamMessageCompositionDependencies extends Omit<
  CreateHostedTeamMessageRouteContributionDependencies,
  'authorization'
> {
  readonly authentication: HostedTeamMessageRouteAccess['http'];
}

export type HostedTeamMessageComposition = HostedTeamMessageRouteContribution;

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
  return createHostedTeamMessageRouteContribution({
    ...featureDependencies,
    authorization: authentication,
  });
}

export function createHostedTeamMessageRouteFactory(
  dependencies: Omit<
    CreateHostedTeamMessageCompositionDependencies,
    'authentication' | 'expectedDeploymentId'
  >
): HostedTeamMessageRouteFactory {
  return createFeatureHostedTeamMessageRouteFactory(dependencies);
}
