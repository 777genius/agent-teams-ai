import {
  createHostedTeamMessageRouteContribution,
  type CreateHostedTeamMessageRouteContributionDependencies,
  createHostedTeamMessageRouteFactory as createFeatureHostedTeamMessageRouteFactory,
  type HostedTeamMessageRouteAccess,
  type HostedTeamMessageRouteContribution,
} from '@features/team-message-delivery/main';

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
