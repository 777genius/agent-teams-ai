export { BackendOperationsFacade } from './adapters/input/BackendOperationsFacade';
export {
  type CapturedReviewWatch,
  createCapturedReviewWatch,
} from './adapters/input/CapturedReviewWatch';
export { registerAgentBackendHttp } from './adapters/input/registerAgentBackendHttp';
export { registerAgentBackendIpc } from './adapters/input/registerAgentBackendIpc';
export {
  registerBackendConnectionsHttp,
  registerBackendConnectionsIpc,
} from './adapters/input/registerBackendConnections';
export { registerCapturedReviewWatchHttp } from './adapters/input/registerCapturedReviewWatchHttp';
export { registerCapturedReviewWatchIpc } from './adapters/input/registerCapturedReviewWatchIpc';
export {
  type BackendOwnerBinding,
  type BackendOwnerRef,
  type BackendRequestGuard,
  BackendRoutingError,
  type BackendScope,
  type HandleBindingStore,
  type StoredBackendBinding,
} from './application/backendBinding';
export {
  BackendOwnerRouter,
  type BoundBackendCommand,
  type CapturedBackendOwner,
} from './application/BackendOwnerRouter';
export { createConfiguredHostTeam } from './application/createConfiguredHostTeam';
export { createLaunchedHostTeam, prepareCreatedHostTeam } from './application/createdHostTeam';
export { ForegroundModelChecks } from './application/ForegroundModelChecks';
export {
  importStoppedLegacyTeam,
  validateStoppedImportAction,
} from './application/importStoppedLegacyTeam';
export {
  type CapturedTeamModelRequest,
  prepareCapturedTeamModels,
} from './application/prepareCapturedTeamModels';
export {
  type HostNotificationSource,
  prepareHostNotification,
} from './application/prepareHostNotification';
export { createCapturedHostClient } from './composition/createCapturedHostClient';
export {
  DesktopBackendFeature,
  type DesktopBackendFeatureOptions,
} from './composition/DesktopBackendFeature';
export { CapturedHostClient, type CapturedHostShutdown } from './infrastructure/CapturedHostClient';
export type {
  CapturedProviderManagement,
  CapturedProviderPreferencePaths,
  ProviderManagementOperation,
} from './infrastructure/CapturedProviderManagement';
export { FileHandleBindingStore } from './infrastructure/FileHandleBindingStore';
export { FileTeamModelProbeIntents } from './infrastructure/FileTeamModelProbeIntents';
export {
  type DesktopBackendDescriptor,
  type DesktopBackendDescriptorSelection,
  loadDesktopBackendDescriptor,
} from './infrastructure/loadDesktopBackendDescriptor';
export { HostClientError, type SelectedHostProfile } from './infrastructure/selectedHostProfile';
export { CapturedStoppedTeamImport } from './infrastructure/stopped-import/CapturedStoppedTeamImport';
export { captureLegacyStoppedSource } from './infrastructure/stopped-import/captureLegacyStoppedSource';
export type {
  CapturedLegacyStoppedSource,
  LegacyStoppedImportReason,
  LegacyStoppedSourceOwners,
} from './infrastructure/stopped-import/createLegacyStoppedTeamSource';
export {
  createLegacyStoppedTeamSource,
  LegacyStoppedImportHold,
} from './infrastructure/stopped-import/createLegacyStoppedTeamSource';
export { prepareStoppedLegacyImport } from './infrastructure/stopped-import/prepareStoppedLegacyImport';
