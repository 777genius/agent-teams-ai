export {
  createDesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryCompatibilityHost,
  type DesktopTeamMessageDeliveryFeature,
  type DesktopTeamMessageDeliveryFeatureDependencies,
  registerTeamMessageDeliveryIpc,
  removeTeamMessageDeliveryIpc,
  type TeamMessageDeliveryIpcDependencies,
  type TeamMessageDeliveryIpcMainPort,
} from './composition/createDesktopTeamMessageDeliveryFeature';
export {
  createTeamMessageDeliveryFeature,
  type TeamMessageDeliveryFeature,
  type TeamMessageDeliveryFeatureDependencies,
  type TeamMessageDeliveryRepositoryPort,
} from './composition/createTeamMessageDeliveryFeature';
