import {
  createTeamRuntimeLifecycleHostPort,
  type TeamRuntimeOperationsHostPorts,
} from '@features/team-runtime-operations/main';

import type { createDesktopTeamProvisioningFeature } from './teamProvisioningHost';
import type { createTeamApprovalsFeature } from '@features/team-approvals/main';
import type { createTeamConfigurationFeature } from '@features/team-configuration/main';
import type { DesktopTeamMessageDeliveryFeatureDependencies } from '@features/team-message-delivery/main';
import type { createTeamRosterMutationFeature } from '@features/team-roster-mutations/main';
import type { createTeamTaskBoardFeature } from '@features/team-task-board/main';
import type { createTeamViewReadModelFeature } from '@features/team-view-read-model/main';
import type {
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationTaskActivityApi,
} from '@main/services/team/contracts/TeamApplicationCapabilityApis';

type TeamApprovalsDependencies = Parameters<typeof createTeamApprovalsFeature>[0];
type TeamConfigurationDependencies = Parameters<typeof createTeamConfigurationFeature>[0];
type TeamProvisioningDependencies = Parameters<typeof createDesktopTeamProvisioningFeature>[0];
type TeamRosterMutationDependencies = Parameters<typeof createTeamRosterMutationFeature>[0];
type TeamTaskBoardDependencies = Parameters<typeof createTeamTaskBoardFeature>[0];
type TeamViewReadModelDependencies = Parameters<typeof createTeamViewReadModelFeature>[0];

export type DesktopTeamProvisioningStartCapability = TeamApplicationProvisioningStartApi;
export type DesktopTeamProvisioningStatusCapability = TeamApplicationProvisioningStatusApi;
export type DesktopTeamProvisioningPreflightCapability = TeamProvisioningDependencies['preflight'];
export type DesktopTeamProvisioningRunCapability = TeamProvisioningDependencies['provisioningRun'] &
  TeamViewReadModelDependencies['provisioningRuns'];
export type DesktopTeamTaskActivityCapability = TeamApplicationTaskActivityApi;
export type DesktopTeamRuntimeCapability = TeamRuntimeOperationsHostPorts['runtime'];
export type DesktopTeamRosterLifecycleCapability = TeamRosterMutationDependencies['lifecycle'];
export type DesktopTeamRuntimeLifecycleCapability = TeamRuntimeOperationsHostPorts['lifecycle'];
export type DesktopTeamDiagnosticsCapability = TeamRuntimeOperationsHostPorts['diagnostics'];
export type DesktopTeamRuntimeLogsCapability = Pick<
  TeamRuntimeOperationsHostPorts['logs'],
  'getClaudeLogs'
>;
export type DesktopTeamMessageDeliveryCompatibilityCapability =
  DesktopTeamMessageDeliveryFeatureDependencies['messaging'];
export type DesktopTeamLiveLeadMessagesCapability = TeamViewReadModelDependencies['messaging'];
export type DesktopTeamMessagingCapability = TeamConfigurationDependencies['messaging'] &
  TeamTaskBoardDependencies['notificationApi'] &
  TeamRosterMutationDependencies['messaging'] &
  TeamRuntimeOperationsHostPorts['messaging'];
export type DesktopTeamToolApprovalCapability = TeamApprovalsDependencies['toolApprovalApi'];

export interface DesktopTeamFeatureCapabilitySources {
  readonly provisioningStart: DesktopTeamProvisioningStartCapability;
  readonly provisioningStatus: DesktopTeamProvisioningStatusCapability;
  readonly preflight: DesktopTeamProvisioningPreflightCapability;
  readonly provisioningRun: DesktopTeamProvisioningRunCapability;
  readonly taskActivity: DesktopTeamTaskActivityCapability;
  readonly runtime: DesktopTeamRuntimeCapability;
  readonly memberLifecycle: DesktopTeamRosterLifecycleCapability &
    Parameters<typeof createTeamRuntimeLifecycleHostPort>[0];
  readonly diagnostics: DesktopTeamDiagnosticsCapability;
  readonly claudeLogs: DesktopTeamRuntimeLogsCapability;
  readonly messaging: DesktopTeamMessageDeliveryCompatibilityCapability &
    DesktopTeamLiveLeadMessagesCapability &
    DesktopTeamMessagingCapability;
  readonly toolApproval: DesktopTeamToolApprovalCapability;
}

/**
 * Frozen app-shell boundary for the narrow capabilities consumed by Desktop team features.
 * Adding a capability requires an intentional architecture-boundary test update.
 */
export interface DesktopTeamFeatureCapabilities {
  readonly provisioningStart: DesktopTeamProvisioningStartCapability;
  readonly provisioningStatus: DesktopTeamProvisioningStatusCapability;
  readonly preflight: DesktopTeamProvisioningPreflightCapability;
  readonly provisioningRun: DesktopTeamProvisioningRunCapability;
  readonly taskActivity: DesktopTeamTaskActivityCapability;
  readonly runtime: DesktopTeamRuntimeCapability;
  readonly rosterLifecycle: DesktopTeamRosterLifecycleCapability;
  readonly runtimeLifecycle: DesktopTeamRuntimeLifecycleCapability;
  readonly runtimeDiagnostics: DesktopTeamDiagnosticsCapability;
  readonly runtimeLogs: DesktopTeamRuntimeLogsCapability;
  readonly messageDeliveryCompatibility: DesktopTeamMessageDeliveryCompatibilityCapability;
  readonly liveLeadMessages: DesktopTeamLiveLeadMessagesCapability;
  readonly messaging: DesktopTeamMessagingCapability;
  readonly toolApproval: DesktopTeamToolApprovalCapability;
}

export function createDesktopTeamFeatureCapabilities(
  sources: DesktopTeamFeatureCapabilitySources
): DesktopTeamFeatureCapabilities {
  return Object.freeze({
    provisioningStart: sources.provisioningStart,
    provisioningStatus: sources.provisioningStatus,
    preflight: sources.preflight,
    provisioningRun: sources.provisioningRun,
    taskActivity: sources.taskActivity,
    runtime: sources.runtime,
    rosterLifecycle: sources.memberLifecycle,
    runtimeLifecycle: createTeamRuntimeLifecycleHostPort(sources.memberLifecycle),
    runtimeDiagnostics: sources.diagnostics,
    runtimeLogs: sources.claudeLogs,
    messageDeliveryCompatibility: sources.messaging,
    liveLeadMessages: sources.messaging,
    messaging: sources.messaging,
    toolApproval: sources.toolApproval,
  });
}
