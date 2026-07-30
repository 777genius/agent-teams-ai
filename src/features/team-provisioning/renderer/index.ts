import { createProductTeamLaunchAnalyticsCoordinator as createLaunchAnalyticsCoordinator } from './adapters/createProductTeamLaunchAnalyticsCoordinator';
import { createTeamProvisioningControlSlice as createProvisioningControlSlice } from './adapters/createTeamProvisioningControlSlice';
import {
  createTeamProvisioningLaunchPersistence as createProvisioningLaunchPersistence,
  loadAllTeamLaunchParams as loadLaunchParams,
  saveTeamLaunchParams as saveLaunchParams,
  saveTeamToolApprovalSettings as saveToolApprovalSettings,
} from './adapters/createTeamProvisioningLaunchPersistence';
import { createTeamProvisioningLaunchSlice as createProvisioningLaunchSlice } from './adapters/createTeamProvisioningLaunchSlice';
import { createTeamProvisioningLaunchTransport as createProvisioningLaunchTransport } from './adapters/createTeamProvisioningLaunchTransport';
import { createTeamProvisioningProgressSlice as createProvisioningProgressSlice } from './adapters/createTeamProvisioningProgressSlice';
import { createTeamRuntimeObservationSlice as createRuntimeObservationSlice } from './adapters/createTeamRuntimeObservationSlice';

import type {
  TeamProvisioningControlEffectsPort,
  TeamProvisioningControlStatePort,
  TeamProvisioningControlTransportPort,
} from './ports/TeamProvisioningControlPorts';
import type {
  TeamProvisioningLaunchAnalyticsPort,
  TeamProvisioningLaunchClockPort,
  TeamProvisioningLaunchControlPort,
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchPersistencePort,
  TeamProvisioningLaunchScopePort,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchStatePort,
  TeamProvisioningLaunchTransportPort,
} from './ports/TeamProvisioningLaunchPorts';
import type {
  TeamProvisioningProgressAnalyticsPort,
  TeamProvisioningProgressRefreshPort,
  TeamProvisioningProgressRuntimePort,
  TeamProvisioningProgressStatePort,
} from './ports/TeamProvisioningProgressPorts';
import type {
  TeamRuntimeObservationBackoffPort,
  TeamRuntimeObservationMemberSpawnPolicyPort,
  TeamRuntimeObservationRequestScopePort,
  TeamRuntimeObservationSnapshotPolicyPort,
  TeamRuntimeObservationStatePort,
  TeamRuntimeObservationTransportPort,
} from './ports/TeamRuntimeObservationPorts';
import type { TeamLaunchAnalyticsCoordinator } from './utils/TeamLaunchAnalyticsCoordinator';
import type { TeamLaunchParams } from './utils/teamLaunchParams';
import type { TeamProvisioningProgress, ToolApprovalSettings } from '@shared/types';

export interface TeamProvisioningControlSlice {
  provisioningProgressUnsubscribe: (() => void) | null;
  cancelProvisioning(runId: string): Promise<void>;
  clearMissingProvisioningRun(runId: string): void;
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
  subscribeProvisioningProgress(): void;
  unsubscribeProvisioningProgress(): void;
}

export interface TeamProvisioningControlSliceDependencies {
  effects: TeamProvisioningControlEffectsPort;
  state: TeamProvisioningControlStatePort;
  transport?: TeamProvisioningControlTransportPort;
}

export interface TeamProvisioningLaunchSliceDependencies<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
> {
  analytics: TeamProvisioningLaunchAnalyticsPort<TContext>;
  clock?: TeamProvisioningLaunchClockPort;
  control: TeamProvisioningLaunchControlPort;
  persistence?: TeamProvisioningLaunchPersistencePort;
  scope: TeamProvisioningLaunchScopePort<TMessageEntry>;
  state: TeamProvisioningLaunchStatePort<TMessageEntry>;
  transport?: TeamProvisioningLaunchTransportPort;
}

export interface TeamProvisioningProgressSlice {
  onProvisioningProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningProgressSliceDependencies {
  analytics: TeamProvisioningProgressAnalyticsPort;
  refresh: TeamProvisioningProgressRefreshPort;
  runtime: TeamProvisioningProgressRuntimePort;
  state: TeamProvisioningProgressStatePort;
}

export interface TeamRuntimeObservationSlice {
  fetchMemberSpawnStatuses(teamName: string): Promise<void>;
  fetchTeamAgentRuntime(teamName: string): Promise<void>;
}

export interface TeamRuntimeObservationSliceDependencies<TScope> {
  backoff: TeamRuntimeObservationBackoffPort;
  memberSpawnPolicy: TeamRuntimeObservationMemberSpawnPolicyPort;
  requestScope: TeamRuntimeObservationRequestScopePort<TScope>;
  runtimeSnapshotPolicy: TeamRuntimeObservationSnapshotPolicyPort;
  state: TeamRuntimeObservationStatePort;
  transport?: TeamRuntimeObservationTransportPort;
}

export function createProductTeamLaunchAnalyticsCoordinator(): TeamLaunchAnalyticsCoordinator {
  return createLaunchAnalyticsCoordinator();
}

export function createTeamProvisioningControlSlice(
  dependencies: TeamProvisioningControlSliceDependencies
): TeamProvisioningControlSlice {
  return createProvisioningControlSlice(dependencies);
}

export function loadAllTeamLaunchParams(): Record<string, TeamLaunchParams> {
  return loadLaunchParams();
}

export function saveTeamLaunchParams(teamName: string, params: TeamLaunchParams): void {
  saveLaunchParams(teamName, params);
}

export function saveTeamToolApprovalSettings(
  teamName: string,
  settings: ToolApprovalSettings
): void {
  saveToolApprovalSettings(teamName, settings);
}

export function createTeamProvisioningLaunchPersistence(): TeamProvisioningLaunchPersistencePort {
  return createProvisioningLaunchPersistence();
}

export function createTeamProvisioningLaunchSlice<
  TMessageEntry extends TeamProvisioningLaunchMessageEntry,
  TContext,
>(
  dependencies: TeamProvisioningLaunchSliceDependencies<TMessageEntry, TContext>
): TeamProvisioningLaunchSlice {
  return createProvisioningLaunchSlice(dependencies);
}

export function createTeamProvisioningLaunchTransport(): TeamProvisioningLaunchTransportPort {
  return createProvisioningLaunchTransport();
}

export function createTeamProvisioningProgressSlice(
  dependencies: TeamProvisioningProgressSliceDependencies
): TeamProvisioningProgressSlice {
  return createProvisioningProgressSlice(dependencies);
}

export function createTeamRuntimeObservationSlice<TScope>(
  dependencies: TeamRuntimeObservationSliceDependencies<TScope>
): TeamRuntimeObservationSlice {
  return createRuntimeObservationSlice(dependencies);
}

export { createTeamListProvisioningPorts } from './composition/createTeamListProvisioningPorts';
export type { TeamToolApprovalRendererSliceDependencies } from './composition/createTeamToolApprovalRendererSlice';
export {
  createTeamToolApprovalRendererSlice,
  loadTeamToolApprovalSettingsIntoRenderer,
} from './composition/createTeamToolApprovalRendererSlice';
export type { TeamLaunchAnalyticsContext } from './ports/TeamLaunchAnalyticsPorts';
export type {
  TeamListProvisioningLaunchPort,
  TeamListProvisioningPorts,
} from './ports/TeamListProvisioningPorts';
export type {
  TeamProvisioningControlEffectsPort,
  TeamProvisioningControlStatePort,
  TeamProvisioningControlStoreState,
  TeamProvisioningControlTransportPort,
} from './ports/TeamProvisioningControlPorts';
export type {
  TeamProvisioningLaunchAnalyticsPort,
  TeamProvisioningLaunchClockPort,
  TeamProvisioningLaunchControlPort,
  TeamProvisioningLaunchMessageEntry,
  TeamProvisioningLaunchPersistencePort,
  TeamProvisioningLaunchScopePort,
  TeamProvisioningLaunchSlice,
  TeamProvisioningLaunchStatePort,
  TeamProvisioningLaunchStoreState,
  TeamProvisioningLaunchTransportPort,
} from './ports/TeamProvisioningLaunchPorts';
export type {
  TeamProvisioningProgressAnalyticsPort,
  TeamProvisioningProgressRefreshPort,
  TeamProvisioningProgressRuntimePort,
  TeamProvisioningProgressStatePort,
  TeamProvisioningProgressStoreState,
  TeamProvisioningRefreshFanoutNote,
  TeamProvisioningSurfaceSnapshot,
} from './ports/TeamProvisioningProgressPorts';
export type {
  TeamRuntimeObservationBackoffPort,
  TeamRuntimeObservationMemberSpawnPolicyPort,
  TeamRuntimeObservationRequestScopePort,
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
export {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  extractBaseModel,
  type TeamLaunchParams,
} from './utils/teamLaunchParams';
export { normalizePersistedTeamLaunchParams } from './utils/teamLaunchParamsPersistence';
export { TeamRuntimeFreshnessCoordinator } from './utils/TeamRuntimeFreshnessCoordinator';
