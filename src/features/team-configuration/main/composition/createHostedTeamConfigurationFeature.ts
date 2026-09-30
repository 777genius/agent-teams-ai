import { HostedTeamConfigurationAdapter } from '../adapters/input/http/HostedTeamConfigurationAdapter';
import { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from '../adapters/input/http/hostedTeamConfigurationRoutes';

import type {
  HostedPromoteDraftRequest,
  HostedPromoteDraftResult,
} from '../../contracts/hostedPromotion';
import type { HostedTeamConfigurationFacade } from '../adapters/input/http/HostedTeamConfigurationAdapter';
import type {
  HostedTeamConfigurationApplicationPort,
  HostedTeamConfigurationAuthorizationPort,
} from '../ports/HostedTeamConfigurationAuthorizationPort';
import type { HostedRouteContribution } from '@main/composition/hosted/application';
import type { QueryContext } from '@shared/contracts/hosted';

export interface HostedTeamConfigurationFeature extends HostedTeamConfigurationFacade {
  readonly routes: typeof HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS;
}

export function createHostedTeamConfigurationFeature(
  application: HostedTeamConfigurationApplicationPort,
  authorization: HostedTeamConfigurationAuthorizationPort,
  promotion?: (
    request: HostedPromoteDraftRequest,
    principal: QueryContext
  ) => Promise<HostedPromoteDraftResult>
): HostedTeamConfigurationFeature {
  const adapter = new HostedTeamConfigurationAdapter(application, authorization, promotion);
  return Object.freeze({
    routes: HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS,
    promoteDraft: adapter.promoteDraft.bind(adapter),
    getPublication: adapter.getPublication.bind(adapter),
    recoverPublication: adapter.recoverPublication.bind(adapter),
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
