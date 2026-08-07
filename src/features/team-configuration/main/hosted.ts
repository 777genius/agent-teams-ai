export {
  HostedTeamConfigurationAdapter,
  type HostedTeamConfigurationFacade,
} from './adapters/input/http/HostedTeamConfigurationAdapter';
export { HOSTED_TEAM_CONFIGURATION_ROUTE_DESCRIPTORS } from './adapters/input/http/hostedTeamConfigurationRoutes';
export {
  type HostedTeamConfigurationContextFactory,
  registerHostedTeamConfigurationHttp,
} from './adapters/input/http/registerHostedTeamConfigurationHttp';
export { createHostedTeamConfigurationAuthority } from './composition/createHostedTeamConfigurationAuthority';
export {
  createHostedTeamConfigurationFeature,
  createHostedTeamConfigurationRouteContribution,
  type HostedTeamConfigurationFeature,
} from './composition/createHostedTeamConfigurationFeature';
export {
  HOSTED_TEAM_CONFIGURATION_OPERATIONS,
  type HostedTeamConfigurationApplicationError,
  type HostedTeamConfigurationApplicationPort,
  type HostedTeamConfigurationAuthorizationPort,
  type HostedTeamConfigurationAuthorizationRequest,
  type HostedTeamConfigurationAuthorizationResult,
  type HostedTeamConfigurationAuthorizationScope,
  type HostedTeamConfigurationOperation,
} from './ports/HostedTeamConfigurationAuthorizationPort';
