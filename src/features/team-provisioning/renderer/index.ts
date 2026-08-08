import { createTeamProvisioningControlSlice as createProvisioningControlSlice } from './slices/createTeamProvisioningControlSlice';
import { createTeamProvisioningLaunchSlice as createProvisioningLaunchSlice } from './slices/createTeamProvisioningLaunchSlice';

import type {
  TeamProvisioningControlSlice,
  TeamProvisioningControlSliceDependencies,
} from './ports/TeamProvisioningControlPorts';
import type {
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchSliceDependencies,
} from './ports/TeamProvisioningLaunchPorts';

export function createTeamProvisioningControlSlice(
  dependencies: TeamProvisioningControlSliceDependencies
): TeamProvisioningControlSlice {
  return createProvisioningControlSlice(dependencies);
}

export function createTeamProvisioningLaunchSlice<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
>(
  dependencies: TeamProvisioningLaunchSliceDependencies<TMessageEntry, TContext>
): TeamProvisioningLaunchSlice {
  return createProvisioningLaunchSlice(dependencies);
}

export { createProductTeamLaunchAnalyticsCoordinator } from './composition/createProductTeamLaunchAnalyticsCoordinator';
export { createTeamListProvisioningPorts } from './composition/createTeamListProvisioningPorts';
export type { TeamToolApprovalRendererSliceDependencies } from './composition/createTeamToolApprovalRendererSlice';
export {
  createTeamToolApprovalRendererSlice,
  loadTeamToolApprovalSettingsIntoRenderer,
} from './composition/createTeamToolApprovalRendererSlice';
export type { WorktreeGitReadinessState } from './hooks/useWorktreeGitReadiness';
export { useWorktreeGitReadiness } from './hooks/useWorktreeGitReadiness';
export type {
  TeamLaunchAnalyticsContext,
  TeamLaunchAnalyticsCoordinatorDependencies,
} from './ports/TeamLaunchAnalyticsPorts';
export type {
  TeamListProvisioningLaunchPort,
  TeamListProvisioningPorts,
} from './ports/TeamListProvisioningPorts';
export type {
  TeamProvisioningControlEffectsPort,
  TeamProvisioningControlSlice,
  TeamProvisioningControlSliceDependencies,
  TeamProvisioningControlStatePort,
  TeamProvisioningControlStoreState,
  TeamProvisioningControlTransportPort,
} from './ports/TeamProvisioningControlPorts';
export type { TeamProvisioningDiagnosticsRendererPorts } from './ports/TeamProvisioningDiagnosticsRendererPorts';
export type {
  TeamProvisioningLaunchAnalyticsPort,
  TeamProvisioningLaunchClockPort,
  TeamProvisioningLaunchControlPort,
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchPersistencePort,
  TeamProvisioningLaunchScopePort,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchSliceDependencies,
  TeamProvisioningLaunchStatePort,
  TeamProvisioningLaunchStoreState,
  TeamProvisioningLaunchTransportPort,
} from './ports/TeamProvisioningLaunchPorts';
export type { TeamProvisioningPreparationRendererPort } from './ports/TeamProvisioningPreparationRendererPort';
export type { TeamProvisioningPreparationRendererPorts } from './ports/TeamProvisioningPreparationRendererPorts';
export type {
  TeamProvisioningProgressAnalyticsPort,
  TeamProvisioningProgressRefreshPort,
  TeamProvisioningProgressRuntimePort,
  TeamProvisioningProgressSlice,
  TeamProvisioningProgressSliceDependencies,
  TeamProvisioningProgressStatePort,
  TeamProvisioningProgressStoreState,
  TeamProvisioningRefreshFanoutNote,
  TeamProvisioningSurfaceSnapshot,
} from './ports/TeamProvisioningProgressPorts';
export type {
  TeamRuntimeObservationBackoffPort,
  TeamRuntimeObservationMemberSpawnPolicyPort,
  TeamRuntimeObservationRequestScopePort,
  TeamRuntimeObservationSlice,
  TeamRuntimeObservationSliceDependencies,
  TeamRuntimeObservationSnapshotPolicyPort,
  TeamRuntimeObservationStatePort,
  TeamRuntimeObservationTransportPort,
} from './ports/TeamRuntimeObservationPorts';
export type {
  TeamToolApprovalErrorLogPort,
  TeamToolApprovalProjectionPort,
  TeamToolApprovalRendererSlice,
  TeamToolApprovalRendererSliceActions,
  TeamToolApprovalRendererSliceState,
  TeamToolApprovalRendererState,
  TeamToolApprovalRendererStatePort,
  TeamToolApprovalRendererTransportPort,
  TeamToolApprovalResponseTransportPort,
  TeamToolApprovalSettingsLoadPort,
  TeamToolApprovalSettingsSyncPort,
} from './ports/TeamToolApprovalRendererPorts';
export type { TeamWorktreeGitReadinessRendererPorts } from './ports/TeamWorktreeGitReadinessRendererPorts';
export { createTeamProvisioningProgressSlice } from './slices/createTeamProvisioningProgressSlice';
export { createTeamRuntimeObservationSlice } from './slices/createTeamRuntimeObservationSlice';
export {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  extractBaseModel,
  type TeamLaunchParams,
} from './utils/teamLaunchParams';
export { normalizePersistedTeamLaunchParams } from './utils/teamLaunchParamsPersistence';
export { TeamRuntimeFreshnessCoordinator } from './utils/TeamRuntimeFreshnessCoordinator';
