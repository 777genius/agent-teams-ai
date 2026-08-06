import { HostedTeamConfigurationAdapter } from '../adapters/input/http/HostedTeamConfigurationAdapter';
import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedTeamConfigurationRoutes';

import type { HostedTeamConfigurationFacade } from '../adapters/input/http/HostedTeamConfigurationAdapter';
import type {
  HostedTeamConfigurationApplicationPort,
  HostedTeamConfigurationAuthorizationPort,
} from '../ports/HostedTeamConfigurationAuthorizationPort';
import type { HostedRouteContribution } from '@main/composition/hosted/application';

export interface HostedTeamConfigurationFeature extends HostedTeamConfigurationFacade {
  readonly routes: typeof HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS;
}

export function createHostedTeamConfigurationFeature(
  application: HostedTeamConfigurationApplicationPort,
  authorization: HostedTeamConfigurationAuthorizationPort
): HostedTeamConfigurationFeature {
  const adapter = new HostedTeamConfigurationAdapter(application, authorization);
  return Object.freeze({
    routes: HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
    getSavedRequest: adapter.getSavedRequest.bind(adapter),
    createDraft: adapter.createDraft.bind(adapter),
    updateDraft: adapter.updateDraft.bind(adapter),
    deleteDraft: adapter.deleteDraft.bind(adapter),
  });
}

export function createHostedTeamConfigurationRouteContribution(
  feature: HostedTeamConfigurationFeature
): HostedRouteContribution<HostedTeamConfigurationFacade> {
  return Object.freeze({
    id: 'team-configuration.hosted.v1',
    facade: feature,
    routes: feature.routes,
  });
}
