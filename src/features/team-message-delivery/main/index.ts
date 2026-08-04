export {
  createDesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryCompatibilityHost,
  type DesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryFeatureDependencies,
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
  type TeamMessageDeliveryIpcDependencies,
  type TeamMessageDeliveryIpcMainPort,
  type TeamMessageDeliveryRepositoryPort,
} from './composition/createDesktopTeamMessageDeliveryFeature';
export {
  createTeamMessageDeliveryFeature,
  createTeamMessagePersistenceFacade,
  type TeamMessageDeliveryFeature,
  type TeamMessageDeliveryFeatureDependencies,
  type TeamMessageLeadResolutionPort,
  type TeamMessagePersistenceCoordinatorPorts,
  type TeamMessagePersistenceFacade,
  type TeamMessageSystemNotificationPort,
} from './composition/createTeamMessageDeliveryFeature';
