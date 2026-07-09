import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import {
  type WorkspaceTrustArgsOnlyPlanRequest,
  type WorkspaceTrustArgsOnlyPlanResult,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanRequest,
  type WorkspaceTrustFullPlanResult,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '@features/workspace-trust/main';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { notifyTeamWatchScopeChanged } from '@main/services/infrastructure/teamWatchScope';
import { execCli, killProcessTree, killTrackedCliProcesses } from '@main/utils/childProcess';
import { getClaudeBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { type ParsedPermissionRequest, type PermissionSuggestion } from '@shared/utils/inboxNoise';
import { createLogger } from '@shared/utils/logger';
import { type ParsedTeammateContent } from '@shared/utils/teammateMessageParser';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  cleanupStaleAnthropicTeamApiKeyHelpers,
} from '../runtime/anthropicTeamApiKeyHelper';
import { ProviderConnectionService } from '../runtime/ProviderConnectionService';

import { isOpenCodeServeCommand } from './opencode/bridge/OpenCodeManagedHostProcessCleanup';
import {
  type OpenCodeMemberDirectory,
  type OpenCodeMemberIdentityResolution,
  type OpenCodeMemberInboxDelivery,
  type OpenCodeMemberMessageDeliveryInput,
  type OpenCodeRuntimeMessageAdapter,
} from './opencode/delivery/OpenCodeMemberMessageDeliveryService';
import { OpenCodePromptDeliveryFollowUpPolicy } from './opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import {
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from './opencode/delivery/OpenCodePromptDeliveryLedger';
import { type OpenCodeVisibleReplyProof } from './opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { type OpenCodePromptDeliveryWatchdogCoordinator } from './opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { type OpenCodeRuntimeDeliveryAdvisoryDecision } from './opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { OpenCodeRuntimeDeliveryProofReader } from './opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { type OpenCodeVisibleReplyProofService } from './opencode/delivery/OpenCodeVisibleReplyProofService';
import { clearOpenCodeRuntimeLaneStorage } from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { getSystemLocale } from './provisioning/TeamProvisioningAgentLanguage';
import {
  createAppendDirectProcessRuntimeEventUseCase,
  createNodeAppendDirectProcessRuntimeEventUseCasePorts,
} from './provisioning/TeamProvisioningAppendDirectProcessRuntimeEventUseCase';
import {
  createTeamProvisioningBootstrapFailureMarker,
  type TeamProvisioningBootstrapFailureMarker,
} from './provisioning/TeamProvisioningBootstrapFailureMarking';
import {
  applyBootstrapTranscriptEvidenceOverlay as applyBootstrapTranscriptEvidenceOverlayHelper,
  applyProcessBootstrapTransportOverlay as applyProcessBootstrapTransportOverlayHelper,
  type BootstrapTranscriptOutcome,
  findBootstrapRuntimeProofObservedAt as findBootstrapRuntimeProofObservedAtHelper,
  type ParsedBootstrapTranscriptTailCacheEntry,
} from './provisioning/TeamProvisioningBootstrapTranscript';
import {
  TeamProvisioningBootstrapTranscriptFacade,
  type TeamProvisioningBootstrapTranscriptMemberLogsPort,
} from './provisioning/TeamProvisioningBootstrapTranscriptFacade';
import {
  createTeamProvisioningCancellationBoundary,
  createTeamProvisioningCancellationBoundaryPortsFromService,
  type TeamProvisioningCancellationBoundary,
  type TeamProvisioningCancellationBoundaryServiceHost,
} from './provisioning/TeamProvisioningCancellationBoundary';
import {
  addPermissionRulesToSettings as addClaudePermissionRulesToSettings,
  type ClaudePermissionSettingsFilePorts,
  seedLeadBootstrapPermissionRules as seedLeadBootstrapPermissionRulesHelper,
} from './provisioning/TeamProvisioningClaudePermissionSettings';
import {
  cleanupProvisioningRun,
  finalizeIncompleteLaunchStateBeforeCleanup as finalizeIncompleteLaunchStateBeforeCleanupHelper,
  type TeamProvisioningCleanupPorts,
} from './provisioning/TeamProvisioningCleanup';
import { type TeamProvisioningCompatibilityDelegation } from './provisioning/TeamProvisioningCompatibilityFacade';
import { TeamProvisioningConfigFacade } from './provisioning/TeamProvisioningConfigFacade';
import { type TeamProvisioningConfigTaskActivityBoundary } from './provisioning/TeamProvisioningConfigTaskActivityBoundary';
import { type DeterministicCreateRunFlowPorts } from './provisioning/TeamProvisioningCreateDeterministicRunFlow';
import {
  createTeamProvisioningCreateDeterministicRunFlowPortsFromService,
  type TeamProvisioningCreateDeterministicRunFlowServiceHost,
} from './provisioning/TeamProvisioningCreateDeterministicRunFlowPortsFactory';
import { type DeterministicCreateSetupFlowPorts } from './provisioning/TeamProvisioningCreateDeterministicSetupFlow';
import {
  createTeamProvisioningCreateDeterministicSetupFlowPortsFromService,
  type TeamProvisioningCreateDeterministicSetupFlowServiceHost,
} from './provisioning/TeamProvisioningCreateDeterministicSetupFlowPortsFactory';
import { type DeterministicCreateSpawnFlowPorts } from './provisioning/TeamProvisioningCreateDeterministicSpawnFlow';
import { type TeamProvisioningCreateDeterministicSpawnFlowBoundary } from './provisioning/TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import {
  clearPendingCrossTeamReplyExpectation as clearPendingCrossTeamReplyExpectationInState,
  type CrossTeamDeliveredLeadBlock,
  getPendingCrossTeamReplyExpectationKeys as getPendingCrossTeamReplyExpectationKeysFromState,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  readAndMatchCrossTeamLeadInboxMessages,
  registerPendingCrossTeamReplyExpectation as registerPendingCrossTeamReplyExpectationInState,
  rememberRecentCrossTeamLeadDeliveryMessageIds as rememberRecentCrossTeamLeadDeliveryMessageIdsHelper,
  resolveCrossTeamLeadName,
} from './provisioning/TeamProvisioningCrossTeamRelayHelpers';
import {
  type DeterministicBootstrapCompletionRecoveryServiceHost,
  recoverDeterministicBootstrapCompletionWithService,
} from './provisioning/TeamProvisioningDeterministicBootstrapCompletionRecovery';
import { TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade } from './provisioning/TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade';
import { type ProvisioningEnvResolution } from './provisioning/TeamProvisioningEnvBuilder';
import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from './provisioning/TeamProvisioningFilesystemMonitor';
import { type TeamProvisioningIdlePromptInjectionBoundary } from './provisioning/TeamProvisioningIdlePromptInjectionPortsFactory';
import { markTeamInboxMessagesReadWithDefaults } from './provisioning/TeamProvisioningInboxPersistence';
import {
  getLeadRelayReadCommitBatch as getLeadRelayReadCommitBatchHelper,
  type NativeSameTeamFingerprint,
  trimRelayedMessageIdSet,
} from './provisioning/TeamProvisioningInboxRelayPolicy';
import {
  notifyAliveTeamsAboutLanguageChangeWithService,
  type TeamProvisioningLanguageChangeNotificationServiceHost,
} from './provisioning/TeamProvisioningLanguageChangeNotification';
import { type TeamProvisioningLaunchDeterministicFlowBoundary } from './provisioning/TeamProvisioningLaunchDeterministicFlowPortsFactory';
import { buildLaunchDiagnosticsFromRun } from './provisioning/TeamProvisioningLaunchDiagnostics';
import {
  createTeamProvisioningLaunchIdentityBoundary,
  type TeamProvisioningLaunchIdentityBoundary,
} from './provisioning/TeamProvisioningLaunchIdentityBoundaryFactory';
import { buildTeamLaunchIncompleteNotificationPayload } from './provisioning/TeamProvisioningLaunchIncompleteNotification';
import { TeamProvisioningLaunchNotifications } from './provisioning/TeamProvisioningLaunchNotifications';
import {
  buildAggregatePendingLaunchMessage as buildAggregatePendingLaunchMessageHelper,
  hasPendingLaunchMembers as hasPendingLaunchMembersHelper,
} from './provisioning/TeamProvisioningLaunchPendingMessage';
import {
  areAllExpectedLaunchMembersConfirmed as areAllExpectedLaunchMembersConfirmedHelper,
  getMemberLaunchSummary as getMemberLaunchSummaryHelper,
  getPersistedLaunchMemberNames,
  hasMixedLaunchMetadata,
  hasMixedSecondaryLaunchMetadata,
  hasPrimaryOnlyLaneAwareLaunchMetadata,
} from './provisioning/TeamProvisioningLaunchStateProjection';
import {
  applyOpenCodeSecondaryEvidenceOverlay as applyOpenCodeSecondaryEvidenceOverlayHelper,
  finalizeMissingRegisteredMembersAsFailed as finalizeMissingRegisteredMembersAsFailedHelper,
  guardCommittedOpenCodeSecondaryLaneEvidence as guardCommittedOpenCodeSecondaryLaneEvidenceHelper,
} from './provisioning/TeamProvisioningLaunchStateReconciliation';
import {
  type LaunchStateWriteResult,
  TeamProvisioningLaunchStateStoreBoundary,
} from './provisioning/TeamProvisioningLaunchStateStoreBoundary';
import {
  setLeadActivity as setLeadActivityHelper,
  type SetLeadActivityPorts,
  syncLeadTaskActivityForState as syncLeadTaskActivityForStateHelper,
} from './provisioning/TeamProvisioningLeadActivity';
import {
  createTeamProvisioningLeadActivityPortsFromService,
  type TeamProvisioningLeadActivityPortsServiceHost,
} from './provisioning/TeamProvisioningLeadActivityPortsFactory';
import { emitLeadContextUsageForRun } from './provisioning/TeamProvisioningLeadContextUsage';
import {
  createTeamProvisioningLeadInboxRelayPortsBoundary,
  createTeamProvisioningLeadInboxRelayPortsDepsFromService,
  type TeamProvisioningLeadInboxRelayServiceHost,
} from './provisioning/TeamProvisioningLeadInboxRelayPortsFactory';
import { getRunTrackedCwdFromRun } from './provisioning/TeamProvisioningLeadRunDerivation';
import {
  type LiveInboxRelayResult,
  relayInboxFileToLiveRecipientWithPorts,
} from './provisioning/TeamProvisioningLiveInboxRelayRouting';
import {
  createTeamProvisioningLiveLaunchSnapshotBoundaryFromService,
  type TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost,
} from './provisioning/TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import {
  createTeamProvisioningLiveLeadMessagePortsBoundary,
  createTeamProvisioningLiveLeadMessagePortsDepsFromService,
  type TeamProvisioningLiveLeadMessageServiceHost,
} from './provisioning/TeamProvisioningLiveLeadMessagePortsFactory';
import { relayMemberInboxMessagesWithPorts } from './provisioning/TeamProvisioningMemberInboxRelayFlow';
import {
  type MemberLifecycleOperation,
  TeamProvisioningMemberLifecycleController,
} from './provisioning/TeamProvisioningMemberLifecycle';
import { type TeamProvisioningMemberLifecyclePublicFacade } from './provisioning/TeamProvisioningMemberLifecycleCompatibilityFacade';
import { createTeamProvisioningMemberLifecycleHostFromPortGroups } from './provisioning/TeamProvisioningMemberLifecycleHostFactory';
import { createTeamProvisioningMemberLifecycleOperationRunner } from './provisioning/TeamProvisioningMemberLifecycleOperationRunner';
import { createTeamProvisioningMemberLifecycleOperationUseCases } from './provisioning/TeamProvisioningMemberLifecycleOperationUseCases';
import { createTeamProvisioningMemberLifecycleServiceUseCases } from './provisioning/TeamProvisioningMemberLifecycleServiceUseCases';
import {
  refreshMemberSpawnStatusesFromLeadInbox as refreshMemberSpawnStatusesFromLeadInboxHelper,
  resolveExpectedLaunchMemberName as resolveExpectedLaunchMemberNameHelper,
} from './provisioning/TeamProvisioningMemberSpawnLeadInbox';
import {
  createMemberSpawnStatusAuditPortsFromService,
  createMemberSpawnStatusMutationPortsFromService,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusAuditServiceHost,
  type MemberSpawnStatusMutationPorts,
  type MemberSpawnStatusMutationServiceHost,
  reconcileBootstrapTranscriptFailuresForRun,
  reconcileBootstrapTranscriptSuccessesForRun,
} from './provisioning/TeamProvisioningMemberSpawnSnapshots';
import {
  createInitialMemberSpawnStatusEntry,
  MEMBER_LAUNCH_GRACE_MS,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
import { buildRuntimeSpawnStatusRecord as buildRuntimeSpawnStatusRecordHelper } from './provisioning/TeamProvisioningMemberStatusProjection';
import { createTeamProvisioningMemberWorkSyncProofBoundary } from './provisioning/TeamProvisioningMemberWorkSyncProofBoundaryFactory';
import {
  persistTeamProvisioningInboxMessage,
  persistTeamProvisioningSentMessage,
} from './provisioning/TeamProvisioningMessagePersistence';
import {
  createTeamProvisioningMixedSecondaryLaneWiring,
  createTeamProvisioningMixedSecondaryLaneWiringDepsFromService,
  type TeamProvisioningMixedSecondaryLaneWiringServiceHost,
} from './provisioning/TeamProvisioningMixedSecondaryLaneWiring';
import {
  buildMixedSecondaryLaunchSnapshotForRun as buildMixedSecondaryLaunchSnapshotForRunHelper,
  shouldRecoverStalePersistedMixedLaunchSnapshot as shouldRecoverStalePersistedMixedLaunchSnapshotHelper,
} from './provisioning/TeamProvisioningMixedSecondaryLaunchReconciliation';
import { handleNativeTeammateUserMessage as handleNativeTeammateUserMessageHelper } from './provisioning/TeamProvisioningNativeTeammateMessages';
import {
  getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService,
  type OpenCodeAgendaSyncRecoveryBypassServiceHost,
} from './provisioning/TeamProvisioningOpenCodeAgendaSyncRecovery';
import {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence as commitOpenCodeRuntimeAdapterLaunchSessionEvidenceHelper,
  launchOpenCodeAggregatePrimaryLane as launchOpenCodeAggregatePrimaryLaneHelper,
  persistOpenCodeRuntimeAdapterLaunchResult as persistOpenCodeRuntimeAdapterLaunchResultHelper,
  summarizeOpenCodeAggregateLaunchState as summarizeOpenCodeAggregateLaunchStateHelper,
} from './provisioning/TeamProvisioningOpenCodeAggregateLaunchPersistence';
import {
  createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService,
  type TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost,
} from './provisioning/TeamProvisioningOpenCodeAggregatePrimaryLanePortsFactory';
import { type OpenCodeRuntimeBootstrapEvidencePorts } from './provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import { createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary } from './provisioning/TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryFactory';
import {
  createTeamProvisioningOpenCodeLaunchPersistencePortsFromService,
  type TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
} from './provisioning/TeamProvisioningOpenCodeLaunchPersistencePortsFactory';
import {
  createTeamProvisioningOpenCodeLaunchWiring,
  createTeamProvisioningOpenCodeLaunchWiringHostFromService,
  type TeamProvisioningOpenCodeLaunchWiringServiceHost,
} from './provisioning/TeamProvisioningOpenCodeLaunchWiring';
import {
  createTeamProvisioningOpenCodeMemberIdentityBoundary,
  type TeamProvisioningOpenCodeMemberIdentityBoundary,
} from './provisioning/TeamProvisioningOpenCodeMemberIdentityBoundaryFactory';
import {
  type OpenCodeMemberInboxRelayOptions,
  type OpenCodeMemberInboxRelayResult,
} from './provisioning/TeamProvisioningOpenCodeMemberInboxRelay';
import {
  createTeamProvisioningOpenCodeMemberInboxRelayBoundary,
  createTeamProvisioningOpenCodeMemberInboxRelayHostFromService,
  type TeamProvisioningOpenCodeMemberInboxRelayServiceHost,
} from './provisioning/TeamProvisioningOpenCodeMemberInboxRelayBoundaryFactory';
import {
  createOpenCodeMemberMessageDeliveryServiceFromHost,
  createOpenCodeRuntimeBootstrapEvidencePorts as createOpenCodeRuntimeBootstrapEvidencePortsHelper,
  createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService,
  deliverOpenCodeMemberMessage as deliverOpenCodeMemberMessageHelper,
  type TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost,
} from './provisioning/TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import { OpenCodeMemberSendSerializer } from './provisioning/TeamProvisioningOpenCodeMemberSendSerialization';
import {
  createOpenCodePromptDeliveryWatchdogSchedulerFromService,
  type TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
} from './provisioning/TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerFactory';
import {
  createOpenCodeTeamThroughRuntimeAdapterFlow,
  launchOpenCodeTeamThroughRuntimeAdapterFlow,
  type OpenCodeRuntimeAdapterTeamFlowPorts,
} from './provisioning/TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import {
  createOpenCodeRuntimeAdapterTeamFlowPortsFromService,
  type TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimeAdapterTeamFlowPortsFactory';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService,
  type TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import { type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost } from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  applyOpenCodeSecondaryBootstrapStallOverlay as applyOpenCodeSecondaryBootstrapStallOverlayHelper,
  getOpenCodeSecondaryBootstrapPendingMemberNames as getOpenCodeSecondaryBootstrapPendingMemberNamesHelper,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
} from './provisioning/TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { readProcessCommandByPid as readOpenCodeRuntimeLaneProcessCommandByPid } from './provisioning/TeamProvisioningOpenCodeRuntimeLaneCleanup';
import { TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade } from './provisioning/TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import {
  createOpenCodeRuntimePendingPermissionsPersistencePortsFromService,
  createOpenCodeRuntimePermissionSpawnStatusPortsFromService,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePendingPermissionsPersistenceServiceHost,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSpawnStatusServiceHost,
  type OpenCodeRuntimePermissionSyncInput,
  type OpenCodeRuntimePermissionSyncServiceHost,
  syncOpenCodeRuntimePermissionsAfterDeliveryWithService,
} from './provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import {
  createRememberOpenCodeRuntimePidFromBridgePortsFromService,
  rememberOpenCodeRuntimePidFromBridge as rememberOpenCodeRuntimePidFromBridgeHelper,
  type RememberOpenCodeRuntimePidFromBridgeServiceHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimePidBridge';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import {
  type OpenCodeRuntimeLaneIdResolutionServiceHost,
  resolveOpenCodeRuntimeLaneIdWithService,
} from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { createOpenCodeRuntimeRecoveryIdentityHelpers } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryIdentity';
import { createTeamProvisioningOpenCodeSecondaryBriefingBuilder } from './provisioning/TeamProvisioningOpenCodeSecondaryBriefingBuilder';
import { createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts } from './provisioning/TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortsFactory';
import {
  createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService,
  type TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
} from './provisioning/TeamProvisioningOpenCodeSecondaryLaneEvidencePortsFactory';
import {
  createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
  type TeamProvisioningOpenCodeStoppedLaneCleanupBoundary,
} from './provisioning/TeamProvisioningOpenCodeStoppedLaneCleanupBoundary';
import { writeOpenCodeTeamConfig } from './provisioning/TeamProvisioningOpenCodeTeamConfigWriter';
import { TeamProvisioningOutputRecoveryFacade } from './provisioning/TeamProvisioningOutputRecoveryFacade';
import { type PersistedTeamConfigCacheEntry } from './provisioning/TeamProvisioningPersistedTeamConfigAccess';
import { type TeamProvisioningPersistenceReconcileFacade } from './provisioning/TeamProvisioningPersistenceReconcileFacade';
import { createTeamProvisioningPersistentRuntimeCleanup } from './provisioning/TeamProvisioningPersistentRuntimeCleanup';
import { TeamProvisioningPrepareFacade } from './provisioning/TeamProvisioningPrepareFacade';
import { createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase } from './provisioning/TeamProvisioningPreparePrimaryOwnedMemberRestartRuntimeUseCase';
import {
  createTeamProvisioningPrimaryBootstrapTruthReportingBoundaryFromService,
  type TeamProvisioningPrimaryBootstrapTruthReportingServiceHost,
} from './provisioning/TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';
import {
  handleProvisioningProcessExit,
  type TeamProvisioningProcessExitPorts,
} from './provisioning/TeamProvisioningProcessExit';
import {
  isTerminalFailureProvisioningState,
  TeamProvisioningRetainedProgressState,
} from './provisioning/TeamProvisioningProgressState';
import {
  type TeamProvisioningProviderRuntimeCompatibility,
  type TeamProvisioningProviderRuntimeFacade,
} from './provisioning/TeamProvisioningProviderRuntimeFacade';
import {
  createTeamProvisioningReevaluateMemberLaunchStatusBoundary,
  createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService,
  type TeamProvisioningReevaluateMemberLaunchStatusServiceHost,
} from './provisioning/TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import {
  auditRegisteredMemberSpawnStatusesWithService,
  type AuditRegisteredMemberSpawnStatusServiceHost,
  readRegisteredTeamMemberNamesFromConfigDefaults,
} from './provisioning/TeamProvisioningRegisteredMemberAudit';
import {
  createTeamProvisioningRequestAdmissionBoundary,
  type TeamProvisioningRequestAdmissionServiceHost,
} from './provisioning/TeamProvisioningRequestAdmission';
import {
  extractCliLogsFromRun,
  type RetainedClaudeLogsSnapshot,
} from './provisioning/TeamProvisioningRetainedLogs';
import {
  DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS,
  LEAD_TEXT_EMIT_THROTTLE_MS,
  LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
  MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
  type ProvisioningRun,
} from './provisioning/TeamProvisioningRunModel';
import {
  killTeamProcess,
  nowIso,
  updateProgress,
} from './provisioning/TeamProvisioningRunProgress';
import { TeamProvisioningRuntimeAdapterProgressState } from './provisioning/TeamProvisioningRuntimeAdapterProgressState';
import {
  planRuntimeLanesOrThrow as planRuntimeLanesOrThrowHelper,
  shouldRouteOpenCodeToRuntimeAdapter as shouldRouteOpenCodeToRuntimeAdapterHelper,
} from './provisioning/TeamProvisioningRuntimeBootstrapDelivery';
import {
  getAnthropicFastModeDefault,
  getTeamProviderLabel,
} from './provisioning/TeamProvisioningRuntimeDiagnostics';
import { mergeRuntimeDiagnostics } from './provisioning/TeamProvisioningRuntimeMetadata';
import { type LiveTeamAgentRuntimeMetadata } from './provisioning/TeamProvisioningRuntimeMetadataPolicy';
import { type TeamProvisioningRuntimeProjection } from './provisioning/TeamProvisioningRuntimeProjectionFactory';
import { isOpenCodeRuntimeRecipientFromSources } from './provisioning/TeamProvisioningRuntimeRecipientResolution';
import { createTeamProvisioningRuntimeResourceSamplingForService } from './provisioning/TeamProvisioningRuntimeResourceSamplingCompatibilityFacade';
import { attachLiveRuntimeMetadataToStatuses as attachLiveRuntimeMetadataToStatusesHelper } from './provisioning/TeamProvisioningRuntimeSnapshot';
import { TeamProvisioningRuntimeSnapshotCacheBoundary } from './provisioning/TeamProvisioningRuntimeSnapshotCache';
import {
  createRuntimeToolActivityHandlerPortsFromService,
  createRuntimeToolActivityHandlers,
  type RuntimeToolActivityServiceHost,
} from './provisioning/TeamProvisioningRuntimeToolActivity';
import { TeamProvisioningRunTrackingDeliveryHelper } from './provisioning/TeamProvisioningRunTrackingDelivery';
import { TeamProvisioningSameTeamNativeDelivery } from './provisioning/TeamProvisioningSameTeamNativeDelivery';
import {
  createSecondaryRuntimeRunStore,
  getCurrentOpenCodeRuntimeRunId as resolveOpenCodeRuntimeRunIdFromMaps,
  isOpenCodeSecondaryLaneMemberInRun,
  type MixedSecondaryRuntimeLaneState,
  removeRunAllEffectiveMember as removeRunAllEffectiveMemberFromRun,
  type SecondaryRuntimeRunEntry,
  upsertRunAllEffectiveMember as upsertRunAllEffectiveMemberInRun,
} from './provisioning/TeamProvisioningSecondaryRuntimeRuns';
import { createTeamProvisioningSendMessageToRunBoundary } from './provisioning/TeamProvisioningSendMessageToRunBoundaryFactory';
import {
  createTeamProvisioningServiceComposition,
  type RuntimeAdapterRunByTeamEntry,
} from './provisioning/TeamProvisioningServiceComposition';
import {
  createTeamProvisioningServiceMemberLifecycleHostPortGroups,
  type TeamProvisioningServiceMemberLifecycleHostPortGroupPorts,
  type TeamProvisioningServiceMemberLifecycleHostPortGroups,
} from './provisioning/TeamProvisioningServiceMemberLifecycleHostPortGroups';
import { createTeamProvisioningShutdownCoordination } from './provisioning/TeamProvisioningShutdownCoordination';
import { stopAllTeamsFlow } from './provisioning/TeamProvisioningStopFlow';
import {
  createTeamProvisioningStopFlowBoundary,
  createTeamProvisioningStopFlowDepsFromService,
  type TeamProvisioningStopFlowServiceHost,
} from './provisioning/TeamProvisioningStopFlowPortsFactory';
import { createNodeStopPrimaryOwnedRosterRuntimeUseCase } from './provisioning/TeamProvisioningStopPrimaryOwnedRosterRuntimeUseCase';
import {
  killOrphanedTeamAgentProcesses,
  killPersistedPaneMembers,
} from './provisioning/TeamProvisioningStopProcessCleanup';
import { TeamProvisioningToolApprovalFacade } from './provisioning/TeamProvisioningToolApprovalFacade';
import { TeamProvisioningTransientRunState } from './provisioning/TeamProvisioningTransientRunState';
import { forwardUserDmToTeammateWithPorts } from './provisioning/TeamProvisioningUserDmRelay';
import { type TeamProvisioningVerificationProbePorts } from './provisioning/TeamProvisioningVerificationProbePortsFactory';
import {
  collectWorkspaceTrustProviders as collectWorkspaceTrustProvidersHelper,
  collectWorkspaceTrustWorkspaces as collectWorkspaceTrustWorkspacesHelper,
  planWorkspaceTrustArgsOnlySafely as planWorkspaceTrustArgsOnlySafelyHelper,
  planWorkspaceTrustFullSafely as planWorkspaceTrustFullSafelyHelper,
  prepareWorkspaceTrustForDeterministicRun as prepareWorkspaceTrustForDeterministicRunHelper,
} from './provisioning/TeamProvisioningWorkspaceTrust';
import { createNodeWorkspaceTrustWorkspaceCollectionPorts } from './provisioning/TeamProvisioningWorkspaceTrustNodePorts';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { atomicWriteAsync } from './atomicWrite';
import { boundLaunchDiagnostics } from './progressPayload';
import {
  createTeamRuntimeControlCompatibilityApiFromService,
  type TeamRuntimeControlCompatibilityServiceHost,
} from './runtime-control';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import { readBootstrapLaunchSnapshot } from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMcpConfigBuilder } from './TeamMcpConfigBuilder';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMemberWorktreeManager } from './TeamMemberWorktreeManager';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { TeamTaskActivityIntervalService } from './TeamTaskActivityIntervalService';

import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeStopInput,
} from './runtime';
import type { createPersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
export type { RuntimeBootstrapMemberMcpLaunchConfig } from './provisioning/TeamProvisioningBootstrapSpec';
export { buildDirectTmuxRestartEnvAssignments } from './provisioning/TeamProvisioningDirectRestart';
export {
  getMixedLaunchFallbackRecoveryError,
  getOpenCodeMixedProviderProvisioningError,
} from './provisioning/TeamProvisioningLaunchCompatibility';
export {
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
export {
  buildAddMemberSpawnMessage,
  buildRestartMemberSpawnMessage,
} from './provisioning/TeamProvisioningPromptBuilders';

import type {
  AgentActionMode,
  InboxMessage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  RetryFailedOpenCodeSecondaryLanesResult,
  TaskRef,
  TeamAgentRuntimeSnapshot,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchDiagnosticItem,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');
const { AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES, createController } =
  agentTeamsControllerModule;

const claudePermissionSettingsFilePorts: ClaudePermissionSettingsFilePorts = {
  mkdirRecursive: async (directoryPath) => {
    await fs.promises.mkdir(directoryPath, { recursive: true });
  },
  readFileUtf8: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
  writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
};

export class TeamProvisioningService extends TeamProvisioningMemberMcpLaunchConfigCompatibilityFacade<ProvisioningRun> {
  private readonly runtimeLaneCoordinator = createTeamRuntimeLaneCoordinator();
  private readonly providerConnectionService = ProviderConnectionService.getInstance();
  protected readonly launchIdentityBoundary: TeamProvisioningLaunchIdentityBoundary =
    createTeamProvisioningLaunchIdentityBoundary({
      execCli,
      providerConnectionService: this.providerConnectionService,
      getAnthropicFastModeDefault,
      getProviderLabel: getTeamProviderLabel,
      logger,
    });
  private readonly openCodeMemberIdentityBoundary: TeamProvisioningOpenCodeMemberIdentityBoundary =
    createTeamProvisioningOpenCodeMemberIdentityBoundary({
      getSecondaryRuntimeRuns: (teamName) => this.getSecondaryRuntimeRuns(teamName),
      getRuntimeAdapterProviderId: (teamName) =>
        this.runtimeAdapterRunByTeam.get(teamName)?.providerId ?? null,
    });
  private readonly openCodeSecondaryBriefingBuilder =
    createTeamProvisioningOpenCodeSecondaryBriefingBuilder({
      createController: (input) => createController(input),
      getClaudeBasePath,
    });
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly provisioningRunByTeam = new Map<string, string>();
  private readonly aliveRunByTeam = new Map<string, string>();
  protected readonly runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  private readonly runtimeAdapterTraceLinesByRunId = new Map<string, string[]>();
  private readonly runtimeAdapterTraceKeyByRunId = new Map<string, string>();
  private readonly retainedProvisioningProgressState = new TeamProvisioningRetainedProgressState({
    runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
    runtimeAdapterTraceLinesByRunId: this.runtimeAdapterTraceLinesByRunId,
    runtimeAdapterTraceKeyByRunId: this.runtimeAdapterTraceKeyByRunId,
  });
  private readonly runtimeAdapterProgressState = new TeamProvisioningRuntimeAdapterProgressState({
    state: {
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterTraceLinesByRunId: this.runtimeAdapterTraceLinesByRunId,
      runtimeAdapterTraceKeyByRunId: this.runtimeAdapterTraceKeyByRunId,
    },
    retainProvisioningProgress: (runId, progress) =>
      this.retainProvisioningProgress(runId, progress),
    isRuntimeAdapterRunStateReferenced: (runId) =>
      this.runs.has(runId) ||
      [...this.provisioningRunByTeam.values()].includes(runId) ||
      [...this.aliveRunByTeam.values()].includes(runId) ||
      [...this.runtimeAdapterRunByTeam.values()].some((entry) => entry.runId === runId),
  });
  protected readonly runtimeAdapterRunByTeam = new Map<string, RuntimeAdapterRunByTeamEntry>();
  protected readonly runTracking = new TeamProvisioningRunTrackingDeliveryHelper({
    state: {
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      runs: this.runs,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      getRetainedProvisioningProgressMap: () =>
        this.retainedProvisioningProgressState.getRetainedProvisioningProgressMap(),
    },
    ports: {
      notifyTeamWatchScopeChanged,
      isTeamAlive: (teamName) => this.isTeamAlive(teamName),
      hasAlivePersistedTeamProcess: (teamName) =>
        this.openCodeStoppedLaneCleanup.hasAlivePersistedTeamProcess(teamName),
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: (teamName) =>
        this.openCodeStoppedLaneCleanup.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName),
      logDebug: (message) => logger.debug(message),
    },
    liveRuntimeSnapshotCacheTtlMs: 2_000,
    persistedRuntimeSnapshotCacheTtlMs: 10_000,
  });
  private readonly cancelledRuntimeAdapterRunIds = new Set<string>();
  private readonly cancellationBoundary: TeamProvisioningCancellationBoundary =
    createTeamProvisioningCancellationBoundary<ProvisioningRun>(
      createTeamProvisioningCancellationBoundaryPortsFromService(
        this as unknown as TeamProvisioningCancellationBoundaryServiceHost<ProvisioningRun>,
        {
          logWarning: (message) => logger.warn(message),
        }
      )
    );
  private stopAllTeamsGeneration = 0;
  private readonly transientProbeProcesses = new Set<ReturnType<typeof spawn>>();
  private readonly secondaryRuntimeRunByTeam = new Map<
    string,
    Map<string, SecondaryRuntimeRunEntry>
  >();
  private readonly secondaryRuntimeRuns = createSecondaryRuntimeRunStore({
    secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
    ports: {
      clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
        this.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, options),
    },
  });
  private readonly hasSecondaryRuntimeRuns = this.secondaryRuntimeRuns.hasSecondaryRuntimeRuns;
  private readonly getSecondaryRuntimeRuns = this.secondaryRuntimeRuns.getSecondaryRuntimeRuns;
  private readonly setSecondaryRuntimeRun = this.secondaryRuntimeRuns.setSecondaryRuntimeRun;
  private readonly deleteSecondaryRuntimeRun = this.secondaryRuntimeRuns.deleteSecondaryRuntimeRun;
  private readonly clearSecondaryRuntimeRuns = this.secondaryRuntimeRuns.clearSecondaryRuntimeRuns;
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  protected readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  protected readonly bootstrapTranscriptFacade!: TeamProvisioningBootstrapTranscriptFacade;

  private get parsedBootstrapTranscriptTailCache(): Map<
    string,
    ParsedBootstrapTranscriptTailCacheEntry
  > {
    return this.bootstrapTranscriptFacade.parsedBootstrapTranscriptTailCache;
  }

  private get memberLogsFinder(): TeamProvisioningBootstrapTranscriptMemberLogsPort {
    return (
      this.bootstrapTranscriptFacade as unknown as {
        memberLogsFinder: TeamProvisioningBootstrapTranscriptMemberLogsPort;
      }
    ).memberLogsFinder;
  }

  private set memberLogsFinder(value: TeamProvisioningBootstrapTranscriptMemberLogsPort) {
    (
      this.bootstrapTranscriptFacade as unknown as {
        memberLogsFinder: TeamProvisioningBootstrapTranscriptMemberLogsPort;
      }
    ).memberLogsFinder = value;
  }

  private rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: readonly string[]
  ): void {
    rememberRecentCrossTeamLeadDeliveryMessageIdsHelper(
      this.recentCrossTeamLeadDeliveryMessageIds,
      teamName,
      messageIds,
      Date.now()
    );
  }

  private async handleOpenCodeRuntimeDeliveryUserFacingSideEffects(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.handleUserFacingSideEffects(record);
  }

  private readonly teamOpLocks = new Map<string, Promise<void>>();
  protected readonly shutdownCoordination = createTeamProvisioningShutdownCoordination(
    {
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
      teamOpLocks: this.teamOpLocks,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      transientProbeProcesses: this.transientProbeProcesses,
    },
    {
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
      stopTeam: (teamName) => this.stopTeam(teamName),
      cancelRuntimeAdapterProvisioning: (runId, progress) =>
        this.cancellationBoundary.cancelRuntimeAdapterProvisioning(runId, progress),
      killProcessTree,
      logger,
    }
  );
  private readonly leadInboxRelayInFlight = new Map<string, Promise<number>>();
  private readonly relayedLeadInboxMessageIds = new Map<string, Set<string>>();
  private readonly sendMessageToRunBoundary =
    createTeamProvisioningSendMessageToRunBoundary<ProvisioningRun>({
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      setLeadActivity: (run, state) => this.setLeadActivity(run, state),
    });
  private readonly memberInboxRelayInFlight = new Map<string, Promise<number>>();
  private readonly openCodeMemberInboxRelayInFlight = new Map<
    string,
    Promise<OpenCodeMemberInboxRelayResult>
  >();
  private readonly openCodeMemberSendInFlightByLane = new Map<
    string,
    Promise<OpenCodeTeamRuntimeMessageResult>
  >();
  private readonly openCodeMemberSendSerializer = new OpenCodeMemberSendSerializer({
    inFlightByLane: this.openCodeMemberSendInFlightByLane,
  });
  private readonly openCodeInboxAttachmentPayloadBoundary =
    createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary({
      getAttachmentStore: () => this.attachmentStore,
    });
  private readonly memberWorkSyncProofBoundary = createTeamProvisioningMemberWorkSyncProofBoundary({
    getAcceptedReportChecker: () => this.appShellBoundary.getMemberWorkSyncAcceptedReportChecker(),
    getProofMissingRecoveryScheduler: () =>
      this.appShellBoundary.getMemberWorkSyncProofMissingRecoveryScheduler(),
    logger,
    getErrorMessage,
  });
  private readonly openCodeRuntimeDeliveryProofReader = new OpenCodeRuntimeDeliveryProofReader();
  private readonly openCodeRuntimeDeliveryAdvisory =
    createTeamProvisioningOpenCodeRuntimeDeliveryAdvisoryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningOpenCodeRuntimeDeliveryAdvisoryServiceHost<ProvisioningRun>,
      {
        addTeamNotification: async (notification) => {
          await NotificationManager.getInstance().addTeamNotification(notification);
        },
        logInfo: (message, detail) =>
          detail === undefined ? logger.info(message) : logger.info(message, detail),
        logWarning: (message) => logger.warn(message),
        getErrorMessage,
      }
    );
  private readonly launchNotifications = new TeamProvisioningLaunchNotifications<ProvisioningRun>({
    getConfig: () => ConfigManager.getInstance().getConfig(),
    addTeamNotification: (notification) =>
      NotificationManager.getInstance().addTeamNotification(notification),
    areAllExpectedLaunchMembersConfirmed: (run) => this.areAllExpectedLaunchMembersConfirmed(run),
    buildLaunchIncompleteNotificationPayload: buildTeamLaunchIncompleteNotificationPayload,
    logger: {
      warn: (message) => logger.warn(message),
    },
  });
  private readonly liveLaunchSnapshotBoundary =
    createTeamProvisioningLiveLaunchSnapshotBoundaryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<ProvisioningRun>,
      {
        getPersistedLaunchMemberNames,
        buildRuntimeSpawnStatusRecord: buildRuntimeSpawnStatusRecordHelper,
      }
    );
  private readonly primaryBootstrapTruthReporting =
    createTeamProvisioningPrimaryBootstrapTruthReportingBoundaryFromService<ProvisioningRun>(
      this as unknown as TeamProvisioningPrimaryBootstrapTruthReportingServiceHost<ProvisioningRun>,
      {
        isOpenCodeSecondaryLaneMemberInRun,
        readBootstrapLaunchSnapshot,
        nowIso,
        logger: {
          warn: (message) => logger.warn(message),
        },
      }
    );
  private readonly openCodeVisibleReplyProofService!: OpenCodeVisibleReplyProofService;
  private readonly openCodePromptDeliveryWatchdogCoordinator!: OpenCodePromptDeliveryWatchdogCoordinator;
  private readonly openCodeRuntimeRecoveryIdentity = createOpenCodeRuntimeRecoveryIdentityHelpers({
    getTeamsBasePath,
    getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
      this.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
    readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
    resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
      this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
  });
  private readonly openCodeRuntimeRecoveryBoundary =
    createTeamProvisioningOpenCodeRuntimeRecoveryBoundary({
      teamsBasePath: getTeamsBasePath(),
      logger,
      getOpenCodeRuntimeAdapter: () => this.appShellBoundary.getOpenCodeRuntimeAdapter(),
      createRunId: randomUUID,
      getErrorMessage,
    });
  private readonly openCodeRuntimeLaneRecoveryFacade!: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade;
  private readonly openCodeRuntimePermissionPersistencePorts: OpenCodeRuntimePendingPermissionsPersistencePorts =
    createOpenCodeRuntimePendingPermissionsPersistencePortsFromService(
      this as unknown as OpenCodeRuntimePendingPermissionsPersistenceServiceHost,
      {
        nowIso,
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
        readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
        logDebug: (message) => logger.debug(message),
      }
    );
  private readonly openCodeRuntimePermissionSpawnStatusPorts: OpenCodeRuntimePermissionSpawnStatusPorts<ProvisioningRun> =
    createOpenCodeRuntimePermissionSpawnStatusPortsFromService(
      this as unknown as OpenCodeRuntimePermissionSpawnStatusServiceHost<ProvisioningRun>,
      {
        nowIso,
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
        getRun: (runId) => this.runs.get(runId) ?? null,
      }
    );
  private readonly openCodeRuntimePidBridgePorts =
    createRememberOpenCodeRuntimePidFromBridgePortsFromService(
      this as unknown as RememberOpenCodeRuntimePidFromBridgeServiceHost,
      {
        nowIso,
        readProcessCommandByPid: readOpenCodeRuntimeLaneProcessCommandByPid,
        isOpenCodeServeCommand,
        logDebug: (message) => logger.debug(message),
      }
    );
  protected readonly memberSpawnStatusMutationPorts: MemberSpawnStatusMutationPorts<ProvisioningRun> =
    createMemberSpawnStatusMutationPortsFromService(
      this as unknown as MemberSpawnStatusMutationServiceHost<ProvisioningRun>,
      {
        nowIso,
        buildLaunchDiagnostics: (run) => boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run)),
      }
    );
  protected readonly memberSpawnStatusAuditPorts: MemberSpawnStatusAuditPorts<ProvisioningRun> =
    createMemberSpawnStatusAuditPortsFromService(
      this as unknown as MemberSpawnStatusAuditServiceHost<ProvisioningRun>,
      {
        nowMs: () => Date.now(),
        minAuditIntervalMs: MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
        isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
          isOpenCodeSecondaryLaneMemberInRun(
            run as Parameters<typeof isOpenCodeSecondaryLaneMemberInRun>[0],
            memberName
          ),
      }
    );
  private readonly openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal: (input) => this.markOpenCodePromptLedgerFailedTerminal(input),
    logEvent: (event, record, extra) => this.logOpenCodePromptDeliveryEvent(event, record, extra),
    scheduleWatchdog: (input) => this.scheduleOpenCodePromptDeliveryWatchdog(input),
    nowIso,
  });
  protected readonly openCodePromptDeliveryWatchdogScheduler =
    createOpenCodePromptDeliveryWatchdogSchedulerFromService(
      this as unknown as TeamProvisioningOpenCodePromptDeliveryWatchdogSchedulerServiceHost,
      {
        logger,
        getErrorMessage,
      }
    );
  private readonly relayedMemberInboxMessageIds = new Map<string, Set<string>>();
  private readonly pendingCrossTeamFirstReplies = new Map<string, Map<string, number>>();
  private readonly recentCrossTeamLeadDeliveryMessageIds = new Map<string, Map<string, number>>();
  private readonly leadInboxRelayPortsBoundary =
    createTeamProvisioningLeadInboxRelayPortsBoundary<ProvisioningRun>(
      createTeamProvisioningLeadInboxRelayPortsDepsFromService(
        this as unknown as TeamProvisioningLeadInboxRelayServiceHost<ProvisioningRun>,
        {
          logger,
          getErrorMessage,
          nowIso,
          nowMs: () => Date.now(),
          setTimeout: (callback, ms) => setTimeout(callback, ms),
          clearTimeout: (handle) => clearTimeout(handle),
        }
      )
    );
  private readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
  private readonly recentSameTeamNativeFingerprints = new Map<
    string,
    NativeSameTeamFingerprint[]
  >();
  protected readonly liveLeadMessagePortsBoundary =
    createTeamProvisioningLiveLeadMessagePortsBoundary<ProvisioningRun>(
      createTeamProvisioningLiveLeadMessagePortsDepsFromService(
        this as unknown as TeamProvisioningLiveLeadMessageServiceHost<ProvisioningRun>,
        {
          logger,
          nowIso,
          nowMs: () => Date.now(),
          cacheLimit: LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
          leadTextEmitThrottleMs: LEAD_TEXT_EMIT_THROTTLE_MS,
        }
      )
    );
  private readonly sameTeamNativeDelivery!: TeamProvisioningSameTeamNativeDelivery;
  protected readonly persistentRuntimeCleanup = createTeamProvisioningPersistentRuntimeCleanup({
    readPersistedRuntimeMembers: (teamName) => this.readPersistedRuntimeMembers(teamName),
    killPersistedPaneMembers: (teamName, members) =>
      killPersistedPaneMembers(teamName, members, logger),
    killOrphanedTeamAgentProcesses: (teamName, currentRunPid) =>
      killOrphanedTeamAgentProcesses({ teamName, currentRunPid, logger }),
    getCurrentRunPid: (teamName) => {
      const currentRunId = this.runTracking.getTrackedRunId(teamName);
      return currentRunId ? this.runs.get(currentRunId)?.child?.pid : undefined;
    },
    cleanupAnthropicTeamApiKeyHelperForTeam,
    getClaudeBasePath,
    logger,
  });
  private readonly agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >();
  private readonly runtimeResourceSampling =
    createTeamProvisioningRuntimeResourceSamplingForService(
      {
        getRuntimeSnapshotCacheGeneration: (teamName) =>
          this.getRuntimeSnapshotCacheGeneration(teamName),
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      },
      { logDebug: (message) => logger.debug(message) }
    );
  private readonly persistedTeamConfigCache = new Map<string, PersistedTeamConfigCacheEntry>();
  protected readonly runtimeSnapshotFacade!: TeamProvisioningRuntimeProjection['runtimeSnapshotFacade'];
  private readonly liveTeamAgentRuntimeMetadataCache = new Map<
    string,
    {
      expiresAtMs: number;
      metadata: Map<string, LiveTeamAgentRuntimeMetadata>;
      runId: string | null;
    }
  >();
  private readonly memberSpawnStatusesSnapshotCache = new Map<
    string,
    {
      expiresAtMs: number;
      generation: number;
      runId: string | null;
      snapshot: MemberSpawnStatusesSnapshot;
    }
  >();
  private readonly memberSpawnStatusesInFlightByTeam = new Map<
    string,
    {
      generationAtStart: number;
      runIdAtStart: string;
      promise: Promise<MemberSpawnStatusesSnapshot>;
    }
  >();
  private readonly runtimeSnapshotCacheBoundary = new TeamProvisioningRuntimeSnapshotCacheBoundary<
    TeamAgentRuntimeSnapshot,
    Map<string, LiveTeamAgentRuntimeMetadata>,
    MemberSpawnStatusesSnapshot,
    PersistedTeamConfigCacheEntry
  >({
    agentRuntimeSnapshotCache: this.agentRuntimeSnapshotCache,
    liveTeamAgentRuntimeMetadataCache: this.liveTeamAgentRuntimeMetadataCache,
    persistedTeamConfigCache: this.persistedTeamConfigCache,
    memberSpawnStatusesSnapshotCache: this.memberSpawnStatusesSnapshotCache,
    memberSpawnStatusesInFlightByTeam: this.memberSpawnStatusesInFlightByTeam,
  });
  private readonly launchStateStore = new TeamLaunchStateStore();
  private readonly defaultLaunchStateStore = this.launchStateStore;
  private readonly configFacade!: TeamProvisioningConfigFacade;
  private readonly liveRuntimeMetadataPorts!: TeamProvisioningRuntimeProjection['liveRuntimeMetadataPorts'];
  private readonly openCodeSecondaryEvidenceOverlayPorts =
    createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts({
      getTeamsBasePath,
      nowIso,
    });
  private readonly launchStateWrittenRunIdByTeam = new Map<string, string>();
  private readonly launchStateStoreBoundary!: TeamProvisioningLaunchStateStoreBoundary;
  private readonly persistenceReconcileFacade!: TeamProvisioningPersistenceReconcileFacade<ProvisioningRun>;
  private readonly configTaskActivityBoundary!: TeamProvisioningConfigTaskActivityBoundary<ProvisioningRun>;
  private readonly failedOpenCodeSecondaryRetryInFlightByTeam = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly memberLifecycleOperationRunner =
    createTeamProvisioningMemberLifecycleOperationRunner({
      memberLifecycleOperations: this.memberLifecycleOperations,
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      nowMs: () => Date.now(),
    });
  private readonly memberLifecycleUseCases = createTeamProvisioningMemberLifecycleServiceUseCases({
    persistSentMessage: (teamName, message) =>
      this.persistSentMessage(teamName, message as unknown as InboxMessage),
    readLaunchStateSnapshot: (teamName) => this.launchStateStore.read(teamName),
    appendDirectProcessRuntimeEvent: createAppendDirectProcessRuntimeEventUseCase(
      createNodeAppendDirectProcessRuntimeEventUseCasePorts({ nowIso })
    ),
    stopPrimaryOwnedRosterRuntime: createNodeStopPrimaryOwnedRosterRuntimeUseCase(),
    preparePrimaryOwnedMemberRestartRuntime:
      createNodePreparePrimaryOwnedMemberRestartRuntimeUseCase(),
    nowIso,
    randomUUID,
  });
  private readonly memberLifecycleOperationUseCases =
    createTeamProvisioningMemberLifecycleOperationUseCases({
      operationRunner: this.memberLifecycleOperationRunner,
    });
  private readonly memberLifecycleHost = createTeamProvisioningMemberLifecycleHostFromPortGroups<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(this.createMemberLifecycleHostPortGroups());
  private readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this.memberLifecycleHost,
    this.memberLifecycleOperationUseCases,
    {
      restart: this.memberLifecycleUseCases,
      openCodeRetry: this.memberLifecycleUseCases,
    }
  );
  protected readonly memberLifecycleFacade: TeamProvisioningMemberLifecyclePublicFacade =
    this.memberLifecycleController;
  private readonly taskActivityIntervalService = new TeamTaskActivityIntervalService();
  protected readonly runtimeToolActivity = createRuntimeToolActivityHandlers<ProvisioningRun>(
    createRuntimeToolActivityHandlerPortsFromService(
      this as unknown as RuntimeToolActivityServiceHost<ProvisioningRun>,
      {
        nowIso,
        logInfo: (message) => logger.info(message),
        logWarn: (message) => logger.warn(message),
        updateProgress,
      }
    )
  );
  private readonly leadTaskActivitySyncedRunKeys = new Set<string>();
  protected teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly toolApprovalFacade!: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  protected readonly transientRunState!: TeamProvisioningTransientRunState;
  private readonly cleanupRunPorts!: TeamProvisioningCleanupPorts<ProvisioningRun>;
  private readonly idlePromptInjectionBoundary!: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  protected readonly providerRuntime!: TeamProvisioningProviderRuntimeFacade;
  private readonly providerRuntimeCompatibility!: TeamProvisioningProviderRuntimeCompatibility;
  protected readonly compatibilityDelegation!: TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly outputRecoveryFacade!: TeamProvisioningOutputRecoveryFacade<ProvisioningRun>;
  private readonly deterministicCreateSpawnFlowBoundary!: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  private readonly deterministicLaunchFlowBoundary!: TeamProvisioningLaunchDeterministicFlowBoundary<MixedSecondaryRuntimeLaneState>;
  protected readonly prepareFacade!: TeamProvisioningPrepareFacade;
  protected readonly verificationProbePorts!: TeamProvisioningVerificationProbePorts<ProvisioningRun>;
  private readonly processExitPorts!: TeamProvisioningProcessExitPorts<ProvisioningRun>;
  private readonly workspaceTrustWorkspaceCollectionPorts =
    createNodeWorkspaceTrustWorkspaceCollectionPorts();

  private readonly cleanedStoppedTeamOpenCodeRuntimeLanes = new Set<string>();
  private readonly openCodeStoppedLaneCleanup: TeamProvisioningOpenCodeStoppedLaneCleanupBoundary =
    createTeamProvisioningOpenCodeStoppedLaneCleanupBoundary(
      {
        canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
          this.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
        getOpenCodeRuntimeAdapter: () => this.appShellBoundary.getOpenCodeRuntimeAdapter(),
        readPreviousLaunchState: (teamName) => this.launchStateStore.read(teamName),
        readConfigForObservation: (teamName) =>
          this.configFacade.readConfigForObservation(teamName),
        readMembersMeta: (teamName) => this.membersMetaStore.getMembers(teamName),
        readPersistedTeamProjectPath: (teamName) => this.readPersistedTeamProjectPath(teamName),
        deleteSecondaryRuntimeRun: (teamName, laneId) =>
          this.deleteSecondaryRuntimeRun(teamName, laneId),
        clearPrimaryRuntimeRun: (teamName) => {
          this.runtimeAdapterRunByTeam.delete(teamName);
          this.runTracking.deleteAliveRunId(teamName);
          this.provisioningRunByTeam.delete(teamName);
          this.invalidateRuntimeSnapshotCaches(teamName);
        },
        markStoppedTeamOpenCodeRuntimeLanesCleaned: (teamName) => {
          this.cleanedStoppedTeamOpenCodeRuntimeLanes.add(teamName);
        },
        logInfo: (message) => logger.info(message),
        logWarning: (message) => logger.warn(message),
      },
      { getTeamsBasePath }
    );
  private readonly openCodeMemberInboxRelayHost =
    createTeamProvisioningOpenCodeMemberInboxRelayHostFromService(
      this as unknown as TeamProvisioningOpenCodeMemberInboxRelayServiceHost
    );
  private readonly openCodeMemberInboxRelayBoundary =
    createTeamProvisioningOpenCodeMemberInboxRelayBoundary({
      host: this.openCodeMemberInboxRelayHost,
      inFlight: this.openCodeMemberInboxRelayInFlight,
      getInboxReader: () => this.inboxReader,
      openCodeRuntimeRecoveryIdentity: this.openCodeRuntimeRecoveryIdentity,
      getOpenCodeVisibleReplyProofService: () => this.openCodeVisibleReplyProofService,
      openCodeInboxAttachmentPayloadBoundary: this.openCodeInboxAttachmentPayloadBoundary,
      cleanedStoppedTeamOpenCodeRuntimeLanes: this.cleanedStoppedTeamOpenCodeRuntimeLanes,
      logger,
      nowIso,
      getErrorMessage,
    });
  private readonly stopFlowBoundary = createTeamProvisioningStopFlowBoundary<ProvisioningRun>(
    createTeamProvisioningStopFlowDepsFromService(
      this as unknown as TeamProvisioningStopFlowServiceHost<ProvisioningRun>,
      {
        getTeamsBasePath,
        clearOpenCodeRuntimeLaneStorage,
        killTeamProcess,
        updateProgress,
        logger,
        nowIso,
      }
    )
  );
  protected readonly reevaluateMemberLaunchStatusBoundary =
    createTeamProvisioningReevaluateMemberLaunchStatusBoundary<ProvisioningRun>(
      createTeamProvisioningReevaluateMemberLaunchStatusDepsFromService(
        this as unknown as TeamProvisioningReevaluateMemberLaunchStatusServiceHost<ProvisioningRun>,
        {
          nowIso,
          nowMs: () => Date.now(),
          isOpenCodeSecondaryLaneMemberInRun,
        }
      )
    );
  private readonly mixedSecondaryLaneWiring =
    createTeamProvisioningMixedSecondaryLaneWiring<ProvisioningRun>(
      createTeamProvisioningMixedSecondaryLaneWiringDepsFromService(
        this as unknown as TeamProvisioningMixedSecondaryLaneWiringServiceHost<ProvisioningRun>,
        { logger }
      )
    );
  private readonly openCodeLaunchWiring =
    createTeamProvisioningOpenCodeLaunchWiring<ProvisioningRun>(
      createTeamProvisioningOpenCodeLaunchWiringHostFromService(
        this as unknown as TeamProvisioningOpenCodeLaunchWiringServiceHost<ProvisioningRun>
      )
    );
  private readonly requestAdmissionBoundary = createTeamProvisioningRequestAdmissionBoundary(
    this as unknown as TeamProvisioningRequestAdmissionServiceHost
  );
  protected readonly openCodeRuntimeDeliveryBoundaryHost!: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun>;
  protected readonly openCodeRuntimeControlApi =
    createTeamRuntimeControlCompatibilityApiFromService(
      this as unknown as TeamRuntimeControlCompatibilityServiceHost
    );

  private createMemberLifecycleHostPortGroups(): TeamProvisioningServiceMemberLifecycleHostPortGroups {
    return createTeamProvisioningServiceMemberLifecycleHostPortGroups(
      this as unknown as TeamProvisioningServiceMemberLifecycleHostPortGroupPorts
    );
  }

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    protected readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    protected readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly mcpConfigBuilder: TeamMcpConfigBuilder = new TeamMcpConfigBuilder(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly openCodeTaskLogAttributionStore: OpenCodeTaskLogAttributionStore = new OpenCodeTaskLogAttributionStore(),
    private readonly memberWorktreeManager: TeamMemberWorktreeManager = new TeamMemberWorktreeManager(),
    private readonly attachmentStore: TeamAttachmentStore = new TeamAttachmentStore()
  ) {
    super();
    createTeamProvisioningServiceComposition(this);
    this.scheduleStaleAnthropicTeamApiKeyHelperCleanup();
  }

  private scheduleStaleAnthropicTeamApiKeyHelperCleanup(): void {
    void cleanupStaleAnthropicTeamApiKeyHelpers({
      baseClaudeDir: getClaudeBasePath(),
      maxAgeMs: 14 * 24 * 60 * 60 * 1000,
    }).catch((error: unknown) => {
      logger.warn(
        `Failed to cleanup stale Anthropic team API-key helper material: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private async readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory> {
    const [config, teamMeta, metaMembers] = await Promise.all([
      this.configFacade.readConfigForObservation(teamName).catch(() => null),
      this.teamMetaStore.getMeta(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    return { config, teamMeta, metaMembers };
  }

  protected async resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution> {
    return await this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
      teamName,
      memberName
    );
  }

  private getTrackedRunId(teamName: string): string | null {
    return this.runTracking.getTrackedRunId(teamName);
  }

  private getRuntimeSnapshotCacheGeneration(teamName: string): number {
    return this.runtimeSnapshotCacheBoundary.getRuntimeSnapshotCacheGeneration(teamName);
  }

  private invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.runtimeSnapshotCacheBoundary.invalidateRuntimeSnapshotCaches(teamName);
  }

  private resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution {
    return this.openCodeMemberIdentityBoundary.resolveOpenCodeMemberIdentityFromDirectory(
      teamName,
      memberName,
      directory
    );
  }

  private collectWorkspaceTrustProviders(input: {
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): WorkspaceTrustProvider[] {
    return collectWorkspaceTrustProvidersHelper(input);
  }

  private async collectWorkspaceTrustWorkspaces(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
  }): Promise<WorkspaceTrustWorkspace[]> {
    return collectWorkspaceTrustWorkspacesHelper({
      ...input,
      ports: this.workspaceTrustWorkspaceCollectionPorts,
    });
  }

  private async planWorkspaceTrustArgsOnlySafely(
    request: WorkspaceTrustArgsOnlyPlanRequest
  ): Promise<WorkspaceTrustArgsOnlyPlanResult> {
    return planWorkspaceTrustArgsOnlySafelyHelper({
      coordinator: this.appShellBoundary.getWorkspaceTrustCoordinator(),
      request,
      logger,
    });
  }

  private async planWorkspaceTrustFullSafely(
    request: WorkspaceTrustFullPlanRequest
  ): Promise<WorkspaceTrustFullPlanResult | null> {
    return planWorkspaceTrustFullSafelyHelper({
      coordinator: this.appShellBoundary.getWorkspaceTrustCoordinator(),
      request,
      logger,
    });
  }

  private isLaunchRunStillCurrent(run: ProvisioningRun): boolean {
    return (
      this.runs.get(run.runId) === run &&
      this.provisioningRunByTeam.get(run.teamName) === run.runId &&
      !run.cancelRequested &&
      !run.processKilled
    );
  }

  private materializeEffectiveTeamMemberSpecs(
    params: Parameters<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']>[0]
  ): ReturnType<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']> {
    return this.prepareFacade.materializeEffectiveTeamMemberSpecs(params);
  }

  private resolveOpenCodeMemberWorkspacesForRuntime(
    params: Parameters<
      TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']
    >[0]
  ): ReturnType<TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']> {
    return this.prepareFacade.resolveOpenCodeMemberWorkspacesForRuntime(params);
  }

  private writeOpenCodeTeamConfig(
    launchRequest: Parameters<typeof writeOpenCodeTeamConfig>[0],
    members: Parameters<typeof writeOpenCodeTeamConfig>[1]
  ): ReturnType<typeof writeOpenCodeTeamConfig> {
    return writeOpenCodeTeamConfig(launchRequest, members);
  }

  private async respondToTeammatePermission(
    run: Parameters<
      TeamProvisioningToolApprovalFacade<ProvisioningRun>['respondToTeammatePermission']
    >[0]['run'],
    agentId: string,
    requestId: string,
    allow: boolean,
    message?: string,
    permissionSuggestions?: PermissionSuggestion[],
    toolName?: string,
    toolInput?: Record<string, unknown>
  ): Promise<void> {
    await this.toolApprovalFacade.respondToTeammatePermission({
      run,
      agentId,
      requestId,
      allow,
      message,
      permissionSuggestions,
      toolName,
      toolInput,
    });
  }

  private hasAcceptedLeadWorkSyncReport(input: {
    teamName: string;
    leadName: string;
  }): Promise<boolean> {
    return this.memberWorkSyncProofBoundary.hasAcceptedLeadWorkSyncReport(input);
  }

  private scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean> {
    return this.memberWorkSyncProofBoundary.scheduleLeadProofMissingWorkSyncRecovery(input);
  }

  private getLeadRelayReadCommitBatch(
    input: Omit<
      Parameters<typeof getLeadRelayReadCommitBatchHelper>[0],
      'hasAcceptedLeadWorkSyncReport' | 'scheduleLeadProofMissingWorkSyncRecovery'
    >
  ): ReturnType<typeof getLeadRelayReadCommitBatchHelper> {
    return getLeadRelayReadCommitBatchHelper({
      ...input,
      hasAcceptedLeadWorkSyncReport: (reportInput) =>
        this.hasAcceptedLeadWorkSyncReport(reportInput),
      scheduleLeadProofMissingWorkSyncRecovery: (recoveryInput) =>
        this.scheduleLeadProofMissingWorkSyncRecovery(recoveryInput),
    });
  }

  private async prepareWorkspaceTrustForDeterministicRun(input: {
    mode: 'create' | 'launch';
    run: ProvisioningRun;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
    stopAllGenerationAtStart: number;
    workspaceTrustPlan: WorkspaceTrustFullPlanResult | null;
    featureFlags: WorkspaceTrustFeatureFlags;
    provisioningEnv: ProvisioningEnvResolution;
  }): Promise<void> {
    await prepareWorkspaceTrustForDeterministicRunHelper(input, {
      workspaceTrustCoordinator: this.appShellBoundary.getWorkspaceTrustCoordinator(),
      stopAllTeamsGeneration: this.stopAllTeamsGeneration,
      updateProgress,
      boundLaunchDiagnostics,
      isLaunchRunStillCurrent: (run) => this.isLaunchRunStillCurrent(run),
      isRunStillTracked: (run) => this.runs.get(run.runId) === run,
      cancelDeterministicRunBeforeSpawn: (run, cancelInput) =>
        this.cancelDeterministicRunBeforeSpawn(run, cancelInput),
      failDeterministicRunBeforeSpawn: (run, failInput) =>
        this.failDeterministicRunBeforeSpawn(run, failInput),
    });
  }

  private async failDeterministicRunBeforeSpawn(
    run: ProvisioningRun,
    input: {
      mode: 'create' | 'launch';
      message: string;
      error: string;
      launchDiagnostics?: TeamLaunchDiagnosticItem[];
      provisioningEnv: ProvisioningEnvResolution;
    }
  ): Promise<never> {
    updateProgress(run, 'failed', input.message, {
      error: input.error,
      warnings: run.progress.warnings,
      launchDiagnostics: input.launchDiagnostics,
    });
    run.onProgress(run.progress);

    if (input.provisioningEnv.anthropicApiKeyHelper) {
      await cleanupAnthropicTeamApiKeyHelperMaterial({
        directory: input.provisioningEnv.anthropicApiKeyHelper.directory,
      }).catch(() => undefined);
    }
    if (input.mode === 'launch') {
      await this.restorePrelaunchConfig(run.teamName).catch(() => undefined);
    }
    this.cleanupRun(run);
    throw new Error(input.error);
  }

  private async cancelDeterministicRunBeforeSpawn(
    run: ProvisioningRun,
    input: {
      mode: 'create' | 'launch';
      provisioningEnv: ProvisioningEnvResolution;
    }
  ): Promise<never> {
    updateProgress(run, 'cancelled', 'Team launch cancelled', {
      warnings: run.progress.warnings,
    });
    run.cancelRequested = true;
    run.onProgress(run.progress);

    if (input.provisioningEnv.anthropicApiKeyHelper) {
      await cleanupAnthropicTeamApiKeyHelperMaterial({
        directory: input.provisioningEnv.anthropicApiKeyHelper.directory,
      }).catch(() => undefined);
    }
    if (input.mode === 'launch') {
      await this.restorePrelaunchConfig(run.teamName).catch(() => undefined);
    }
    this.cleanupRun(run);
    throw new Error('Team launch cancelled by app shutdown');
  }

  private async isOpenCodeDeliveryResponseReadCommitAllowed(input: {
    teamName?: string;
    memberName?: string;
    responseState?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>['state'];
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogCoordinator.isDeliveryResponseReadCommitAllowed(
      input
    );
  }

  private async isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    responseObservation?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogCoordinator.isLegacyMemberWorkSyncReadCommitAllowed(
      input
    );
  }

  private getOpenCodeDeliveryPendingReason(input: {
    responseState?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>['state'];
    actionMode?: AgentActionMode | null;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): string {
    return this.openCodePromptDeliveryWatchdogCoordinator.getDeliveryPendingReason(input);
  }

  private async markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.markAcceptedDeliveryMissingPromptProofForRetry(
      input
    );
  }

  private async requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.requeueNoAssistantTerminalDeliveryIfNeeded(
      input
    );
  }

  private async requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.requeueRuntimeManifestWatermarkDeliveryIfNeeded(
      input
    );
  }

  private async markOpenCodePromptLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    return this.openCodePromptDeliveryWatchdogCoordinator.markLedgerFailedTerminal(input);
  }

  private async observeOpenCodeDirectUserDeliveryInlineIfNeeded(input: {
    adapter: OpenCodeRuntimeMessageAdapter;
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    teamName: string;
    memberName: string;
    laneId: string;
    cwd: string;
    text: string;
    messageId: string;
    runtimeRunId?: string | null;
    replyRecipient?: string | null;
    actionMode?: AgentActionMode;
    messageKind?: OpenCodeTeamRuntimeMessageInput['messageKind'];
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    workSyncReviewRequestEventIds?: string[];
    taskRefs?: TaskRef[];
    promptAccepted: boolean;
    visibleReply?: OpenCodeVisibleReplyProof | null;
  }): Promise<{
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    visibleReply: OpenCodeVisibleReplyProof | null;
  }> {
    return this.openCodePromptDeliveryWatchdogCoordinator.observeDirectUserDeliveryInlineIfNeeded(
      input
    );
  }

  protected scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    this.openCodePromptDeliveryWatchdogScheduler.schedule(input);
  }

  private async rememberOpenCodeRuntimePidFromBridge(input: {
    teamName: string;
    memberName: string;
    laneId: string;
    runId?: string | null;
    runtimeSessionId?: string | null;
    runtimePid?: number;
    reason: string;
  }): Promise<void> {
    await rememberOpenCodeRuntimePidFromBridgeHelper(input, this.openCodeRuntimePidBridgePorts);
  }

  private async maybeSyncOpenCodeRuntimePermissionsAfterDelivery(
    input: OpenCodeRuntimePermissionSyncInput
  ): Promise<void> {
    await syncOpenCodeRuntimePermissionsAfterDeliveryWithService(
      input,
      this as unknown as OpenCodeRuntimePermissionSyncServiceHost<ProvisioningRun>,
      { logWarning: (message) => logger.warn(message) }
    );
  }

  private logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra: Record<string, unknown> = {}
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.logPromptDeliveryEvent(event, record, extra);
  }

  private emitOpenCodePromptDeliveryTaskLogChange(
    record: OpenCodePromptDeliveryLedgerRecord,
    detail: string
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.emitPromptDeliveryTaskLogChange(record, detail);
  }

  private async decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision;
  }> {
    return await this.openCodeRuntimeDeliveryAdvisory.decideUserFacingAdvisory(record);
  }

  private emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void {
    this.openCodeRuntimeDeliveryAdvisory.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message);
  }

  async scanOpenCodePromptDeliveryWatchdog(teamName: string): Promise<number> {
    return await this.openCodePromptDeliveryWatchdogCoordinator.scan(teamName);
  }

  private async scanOpenCodePromptDeliveryWatchdogForActiveLanes(
    teamName: string,
    laneIds: string[]
  ): Promise<number> {
    return await this.openCodePromptDeliveryWatchdogCoordinator.scanActiveLanes(teamName, laneIds);
  }

  private createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
    return createOpenCodeRuntimeBootstrapEvidencePortsHelper({
      teamsBasePath: getTeamsBasePath(),
      warn: (message) => logger.warn(message),
    });
  }

  private createOpenCodeMemberMessageDeliveryService() {
    return createOpenCodeMemberMessageDeliveryServiceFromHost(
      createTeamProvisioningOpenCodeMemberMessageDeliveryHostFromService(
        this as unknown as TeamProvisioningOpenCodeMemberMessageDeliveryServiceHost
      )
    );
  }

  async deliverOpenCodeMemberMessage(
    teamName: string,
    input: OpenCodeMemberMessageDeliveryInput
  ): Promise<OpenCodeMemberInboxDelivery> {
    return await deliverOpenCodeMemberMessageHelper(
      this.createOpenCodeMemberMessageDeliveryService(),
      teamName,
      input
    );
  }

  private shouldRouteOpenCodeToRuntimeAdapter(request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  }): boolean {
    return shouldRouteOpenCodeToRuntimeAdapterHelper(
      request,
      this.appShellBoundary.getOpenCodeRuntimeAdapter() !== null
    );
  }

  private planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan {
    return planRuntimeLanesOrThrowHelper(this.runtimeLaneCoordinator, {
      leadProviderId,
      members,
      baseCwd,
      hasOpenCodeRuntimeAdapter: this.appShellBoundary.getOpenCodeRuntimeAdapter() !== null,
    });
  }

  private createMixedSecondaryLaneStates(
    plan: TeamRuntimeLanePlan
  ): MixedSecondaryRuntimeLaneState[] {
    return this.mixedSecondaryLaneWiring.createMixedSecondaryLaneStates(plan);
  }

  private createMixedSecondaryLaneStateForMember(
    run: Pick<ProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    return this.mixedSecondaryLaneWiring.createMixedSecondaryLaneStateForMember(run, member);
  }

  private getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase {
    return this.mixedSecondaryLaneWiring.getMixedSecondaryLaunchPhase(run);
  }

  private upsertRunAllEffectiveMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): void {
    upsertRunAllEffectiveMemberInRun(run, member);
  }

  private removeRunAllEffectiveMember(run: ProvisioningRun, memberName: string): void {
    removeRunAllEffectiveMemberFromRun(run, memberName);
  }

  private getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null {
    return resolveOpenCodeRuntimeRunIdFromMaps({
      teamName,
      laneId,
      trackedRunId: this.runTracking.getTrackedRunId(teamName),
      runs: this.runs,
      provisioningRunByTeam: this.provisioningRunByTeam,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      secondaryRuntimeRunByTeam: this.secondaryRuntimeRunByTeam,
      shouldRouteOpenCodeToRuntimeAdapter: (request) =>
        this.shouldRouteOpenCodeToRuntimeAdapter(request),
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
    });
  }

  private async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(
      input
    );
  }

  private async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  }): Promise<boolean> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
      input
    );
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(
      input
    );
  }

  private async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
      teamName,
      options
    );
  }

  private async resolveOpenCodeRuntimeLaneId(params: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string> {
    return resolveOpenCodeRuntimeLaneIdWithService(
      params,
      this as unknown as OpenCodeRuntimeLaneIdResolutionServiceHost
    );
  }

  private sweepRuntimeAdapterRunState(nowMs: number = Date.now()): void {
    this.runtimeAdapterProgressState.sweepRuntimeAdapterRunState(nowMs);
  }

  private clearSameTeamRetryTimers(teamName: string): void {
    this.transientRunState.clearSameTeamRetryTimers(teamName);
  }

  private clearLeadInboxFollowUpRelayTimer(teamName: string): void {
    this.transientRunState.clearLeadInboxFollowUpRelayTimer(teamName);
  }

  private scheduleLeadInboxFollowUpRelay(teamName: string): void {
    this.transientRunState.scheduleLeadInboxFollowUpRelay(teamName);
  }

  private resetTeamScopedTransientStateForNewRun(teamName: string): void {
    this.transientRunState.resetTeamScopedTransientStateForNewRun(teamName);
  }

  /**
   * Serializes operations per team name using promise-chaining.
   * Same pattern as withInboxLock / withTaskLock.
   * Prevents TOCTOU races between concurrent createTeam/launchTeam calls.
   */
  private async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    return this.transientRunState.withTeamLock(teamName, fn);
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    registerPendingCrossTeamReplyExpectationInState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      otherTeam,
      conversationId,
      Date.now()
    );
  }

  clearPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    clearPendingCrossTeamReplyExpectationInState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      otherTeam,
      conversationId
    );
  }

  private getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string> {
    return getPendingCrossTeamReplyExpectationKeysFromState(
      this.pendingCrossTeamFirstReplies,
      teamName,
      Date.now()
    );
  }

  private getRunLeadName(run: ProvisioningRun): string {
    return resolveCrossTeamLeadName(run.request?.members);
  }

  private async matchCrossTeamLeadInboxMessages(
    teamName: string,
    leadName: string,
    deliveredBlocks: CrossTeamDeliveredLeadBlock[]
  ): Promise<
    {
      teammateId: string;
      content: string;
      toTeam: string;
      conversationId: string;
      messageId: string;
      wasRead: boolean;
    }[]
  > {
    return readAndMatchCrossTeamLeadInboxMessages({
      inboxReader: this.inboxReader,
      teamName,
      leadName,
      deliveredBlocks,
    });
  }

  private handleNativeTeammateUserMessage(
    run: ProvisioningRun,
    msg: Record<string, unknown>
  ): void {
    handleNativeTeammateUserMessageHelper(run, msg, {
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      nowMs: () => Date.now(),
      nowIso,
      getRunLeadName: (run) => this.getRunLeadName(run),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        this.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      matchCrossTeamLeadInboxMessages: (teamName, leadName, deliveredBlocks) =>
        this.matchCrossTeamLeadInboxMessages(teamName, leadName, deliveredBlocks),
      markInboxMessagesRead: (teamName, leadName, messages) =>
        this.markInboxMessagesRead(teamName, leadName, messages),
      setMemberSpawnStatus: (run, memberName, status, error, source) =>
        this.setMemberSpawnStatus(run, memberName, status, error, source),
      rememberSameTeamNativeFingerprints: (teamName, blocks) =>
        this.rememberSameTeamNativeFingerprints(teamName, blocks),
      reconcileSameTeamNativeDeliveries: (teamName, leadName) =>
        this.reconcileSameTeamNativeDeliveries(teamName, leadName),
    });
  }

  private async refreshMemberSpawnStatusesFromLeadInbox(run: ProvisioningRun): Promise<void> {
    await refreshMemberSpawnStatusesFromLeadInboxHelper(run, {
      getRunLeadName: (run) => this.getRunLeadName(run),
      readLeadInboxMessages: (teamName, leadName) =>
        this.inboxReader.getMessagesFor(teamName, leadName),
      setMemberSpawnStatus: (run, memberName, status, error, source, heartbeatTimestamp) =>
        this.setMemberSpawnStatus(run, memberName, status, error, source, heartbeatTimestamp),
    });
  }

  private resolveExpectedLaunchMemberName(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null {
    return resolveExpectedLaunchMemberNameHelper(expectedMembers, candidateName);
  }

  private persistSentMessage(teamName: string, message: InboxMessage): void {
    persistTeamProvisioningSentMessage(teamName, message, {
      createController: (input) => createController(input),
      getClaudeBasePath,
      logger,
    });
  }

  private persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void {
    persistTeamProvisioningInboxMessage(teamName, recipient, message, {
      createController: (input) => createController(input),
      getClaudeBasePath,
      logger,
      emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
        this.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
    });
  }

  private getMemberRelayKey(teamName: string, memberName: string): string {
    return this.openCodeMemberSendSerializer.getMemberRelayKey(teamName, memberName);
  }

  private getOpenCodeMemberRelayKey(teamName: string, memberName: string): string {
    return this.openCodeMemberSendSerializer.getOpenCodeMemberRelayKey(teamName, memberName);
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    return this.openCodeMemberSendSerializer.sendSerialized(input);
  }

  private getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    return getRunTrackedCwdFromRun(run, path.resolve);
  }

  protected syncLeadTaskActivityForState(
    run: ProvisioningRun,
    state: 'active' | 'idle' | 'offline',
    previousState: 'active' | 'idle' | 'offline',
    at = nowIso()
  ): void {
    syncLeadTaskActivityForStateHelper(
      run,
      state,
      previousState,
      this.createLeadActivityPorts(),
      at
    );
  }

  private setLeadActivity(run: ProvisioningRun, state: 'active' | 'idle' | 'offline'): void {
    setLeadActivityHelper(run, state, this.createLeadActivityPorts());
  }

  private createLeadActivityPorts(): SetLeadActivityPorts<ProvisioningRun> {
    return createTeamProvisioningLeadActivityPortsFromService(
      this as unknown as TeamProvisioningLeadActivityPortsServiceHost<ProvisioningRun>,
      { nowIso }
    );
  }

  private emitLeadContextUsage(run: ProvisioningRun): void {
    emitLeadContextUsageForRun(run, {
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      nowMs: () => Date.now(),
      nowIso: () => new Date().toISOString(),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    });
  }

  private createOpenCodeRuntimeAdapterTeamFlowPorts(): OpenCodeRuntimeAdapterTeamFlowPorts {
    return createOpenCodeRuntimeAdapterTeamFlowPortsFromService(
      this as unknown as TeamProvisioningOpenCodeRuntimeAdapterTeamFlowServiceHost,
      {
        warn: (message) => {
          logger.warn(message);
        },
      }
    );
  }

  private createDeterministicCreateSetupFlowPorts(): DeterministicCreateSetupFlowPorts<MixedSecondaryRuntimeLaneState> {
    return createTeamProvisioningCreateDeterministicSetupFlowPortsFromService(
      this as unknown as TeamProvisioningCreateDeterministicSetupFlowServiceHost,
      { logger }
    );
  }

  private createDeterministicCreateRunFlowPorts(): DeterministicCreateRunFlowPorts<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  > {
    return createTeamProvisioningCreateDeterministicRunFlowPortsFromService(
      this as unknown as TeamProvisioningCreateDeterministicRunFlowServiceHost
    );
  }

  private createDeterministicCreateSpawnFlowPorts(input: {
    request: TeamCreateRequest;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
  }): DeterministicCreateSpawnFlowPorts<ProvisioningRun> {
    return this.deterministicCreateSpawnFlowBoundary.createSpawnFlowPorts(input);
  }

  async createTeam(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    return this.requestAdmissionBoundary.createTeam(request, onProgress);
  }

  private async createOpenCodeTeamThroughRuntimeAdapter(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    return createOpenCodeTeamThroughRuntimeAdapterFlow(
      request,
      onProgress,
      this.createOpenCodeRuntimeAdapterTeamFlowPorts()
    );
  }

  private async launchOpenCodeTeamThroughRuntimeAdapter(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return launchOpenCodeTeamThroughRuntimeAdapterFlow(
      request,
      onProgress,
      this.createOpenCodeRuntimeAdapterTeamFlowPorts()
    );
  }

  private async launchOpenCodeAggregatePrimaryLane(params: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeLaunchResult | null> {
    return launchOpenCodeAggregatePrimaryLaneHelper(
      params,
      createTeamProvisioningOpenCodeAggregatePrimaryLanePortsFromService(
        this as unknown as TeamProvisioningOpenCodeAggregatePrimaryLaneServiceHost
      )
    );
  }

  private summarizeOpenCodeAggregateLaunchState(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'] {
    return summarizeOpenCodeAggregateLaunchStateHelper(input);
  }

  private async runOpenCodeWorktreeRootAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_worktree_root_lanes' }>;
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    return this.openCodeLaunchWiring.runOpenCodeWorktreeRootAggregateLaunch(input);
  }

  private async runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    return this.openCodeLaunchWiring.runOpenCodeTeamRuntimeAdapterLaunch(input);
  }

  private createOpenCodeLaunchPersistencePorts() {
    return createTeamProvisioningOpenCodeLaunchPersistencePortsFromService(
      this as unknown as TeamProvisioningOpenCodeLaunchPersistenceServiceHost,
      { nowIso }
    );
  }

  private async persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{
    snapshot: PersistedTeamLaunchSnapshot;
    result: TeamRuntimeLaunchResult;
  }> {
    return persistOpenCodeRuntimeAdapterLaunchResultHelper(
      result,
      input,
      this.createOpenCodeLaunchPersistencePorts()
    );
  }

  private async commitOpenCodeRuntimeAdapterLaunchSessionEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult> {
    return commitOpenCodeRuntimeAdapterLaunchSessionEvidenceHelper(
      params,
      this.createOpenCodeLaunchPersistencePorts()
    );
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return this.requestAdmissionBoundary.launchTeam(request, onProgress);
  }

  /**
   * UNUSED (2026-03-23): teammates read their own inbox files directly via fs.watch,
   * so forwarding through the lead is unnecessary. Kept for reference — the prompt
   * pattern here ("MUST: ask teammate to reply back to user") was a useful finding
   * that informed the direct inbox approach.
   *
   * Original purpose: forward a user DM to a teammate by injecting a relay turn
   * into the lead's stdin and suppressing the lead's textual output.
   */
  async forwardUserDmToTeammate(
    teamName: string,
    teammateName: string,
    userText: string,
    userSummary?: string
  ): Promise<void> {
    await forwardUserDmToTeammateWithPorts(
      { teamName, teammateName, userText, userSummary },
      {
        getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
        getRun: (runId) => this.runs.get(runId),
        sendMessageToRun: (run, message) => this.sendMessageToRun(run, message),
        nowIso,
      }
    );
  }

  async relayMemberInboxMessages(teamName: string, memberName: string): Promise<number> {
    if (isCrossTeamPseudoRecipientName(memberName) || isCrossTeamToolRecipientName(memberName)) {
      return 0;
    }
    const relayKey = this.getMemberRelayKey(teamName, memberName);
    return relayMemberInboxMessagesWithPorts(
      { teamName, memberName, relayKey },
      {
        inFlight: this.memberInboxRelayInFlight,
        getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
        getRun: (runId) => this.runs.get(runId),
        isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
        readInboxMessages: (teamName, memberName) =>
          this.inboxReader.getMessagesFor(teamName, memberName),
        markInboxMessagesRead: (teamName, memberName, messages) =>
          this.markInboxMessagesRead(teamName, memberName, messages),
        sendMessageToRun: (run, message) => this.sendMessageToRun(run, message),
        hasAcceptedMemberWorkSyncReport: (input) =>
          this.memberWorkSyncProofBoundary.hasAcceptedMemberWorkSyncReport(input),
        relayedMemberInboxMessageIds: this.relayedMemberInboxMessageIds,
        trimRelayedSet: (relayedIds) => this.trimRelayedSet(relayedIds),
        logger,
        nowIso,
        getErrorMessage,
      }
    );
  }

  async relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<LiveInboxRelayResult> {
    return relayInboxFileToLiveRecipientWithPorts(
      { teamName, inboxName, options },
      {
        readConfigSnapshot: (teamName) => this.configFacade.readConfigSnapshot(teamName),
        readMetaMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
        isOpenCodeRuntimeRecipientFromSources: ({ memberName, config, metaMembers }) =>
          isOpenCodeRuntimeRecipientFromSources({ memberName, config, metaMembers }),
        relayOpenCodeMemberInboxMessages: (teamName, memberName, relayOptions) =>
          this.relayOpenCodeMemberInboxMessages(teamName, memberName, relayOptions),
        relayLeadInboxMessages: (teamName) => this.relayLeadInboxMessages(teamName),
        isTeamAlive: (teamName) => this.isTeamAlive(teamName),
      }
    );
  }

  async relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<OpenCodeMemberInboxRelayResult> {
    return this.openCodeMemberInboxRelayBoundary.relayOpenCodeMemberInboxMessages(
      teamName,
      memberName,
      options
    );
  }

  /**
   * Relay unread inbox messages addressed to the team lead into the live lead process.
   *
   * Why: teammates (and the UI) write to `inboxes/<lead>.json`, but the live lead CLI
   * process consumes new turns via stream-json stdin. Without relaying, the lead
   * appears unresponsive to direct messages.
   *
   * Returns the number of messages relayed.
   */
  protected async getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  }): Promise<Set<string>> {
    return getOpenCodeAgendaSyncRecoveryBypassMessageIdsWithService(
      input,
      this as unknown as OpenCodeAgendaSyncRecoveryBypassServiceHost
    );
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    return this.leadInboxRelayPortsBoundary.relayLeadInboxMessages(teamName);
  }

  private languageChangeInFlight: Promise<void> = Promise.resolve();

  /**
   * Notify alive teams when the agent language setting changes.
   * Compares each team's stored `config.language` with the new code and sends
   * a message to the team lead if they differ.
   *
   * Serialised: rapid language switches (e.g. ru → en → ru) are queued so that
   * only the latest value is applied to each team.
   */
  async notifyLanguageChange(newLangCode: string): Promise<void> {
    this.languageChangeInFlight = this.languageChangeInFlight.then(() =>
      notifyAliveTeamsAboutLanguageChangeWithService(
        newLangCode,
        this as unknown as TeamProvisioningLanguageChangeNotificationServiceHost,
        {
          getSystemLocale,
          resolveLanguageName,
          logger,
        }
      )
    );
    return this.languageChangeInFlight;
  }

  private async markInboxMessagesRead(
    teamName: string,
    member: string,
    messages: { messageId: string }[]
  ): Promise<void> {
    await markTeamInboxMessagesReadWithDefaults({ teamName, member, messages });
  }

  private trimRelayedSet(set: Set<string>): Set<string> {
    return trimRelayedMessageIdSet(set);
  }

  /**
   * Post-provisioning audit: read config.json members and flag any expectedMember
   * that was NOT registered by Claude Code as a team member.
   *
   * This is the ground-truth check — when Agent(team_name=X, name=Y) succeeds,
   * the CLI adds Y to config.json members[]. If a member is missing, the spawn
   * was incorrect (e.g., missing team_name/name params) and the agent ran as a
   * one-shot subagent instead of a persistent teammate.
   */
  private async getRegisteredTeamMemberNames(teamName: string): Promise<Set<string> | null> {
    return readRegisteredTeamMemberNamesFromConfigDefaults(teamName);
  }

  private async auditMemberSpawnStatuses(run: ProvisioningRun): Promise<void> {
    await auditRegisteredMemberSpawnStatusesWithService<ProvisioningRun>(
      run,
      this as unknown as AuditRegisteredMemberSpawnStatusServiceHost<ProvisioningRun>,
      {
        debug: (message) => logger.debug(message),
        warn: (message) => logger.warn(message),
      }
    );
  }

  private async finalizeMissingRegisteredMembersAsFailed(run: ProvisioningRun): Promise<void> {
    return finalizeMissingRegisteredMembersAsFailedHelper(run, {
      getRegisteredTeamMemberNames: (teamName) => this.getRegisteredTeamMemberNames(teamName),
      isMemberLifecycleOperationActive: (teamName, memberName) =>
        this.isMemberLifecycleOperationActive(teamName, memberName),
      setMemberSpawnStatus: (targetRun, memberName, status, error) =>
        this.setMemberSpawnStatus(targetRun, memberName, status, error),
    });
  }

  private createBootstrapFailureMarker(): TeamProvisioningBootstrapFailureMarker<ProvisioningRun> {
    return createTeamProvisioningBootstrapFailureMarker<ProvisioningRun>({
      nowIso,
      createInitialMemberSpawnStatusEntry,
      isMemberLifecycleOperationActive: (teamName, memberName) =>
        this.isMemberLifecycleOperationActive(teamName, memberName),
      syncMemberTaskActivityForRuntimeTransition: (targetRun, memberName, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(targetRun, memberName, previous, next, at),
      appendMemberBootstrapDiagnostic: (targetRun, memberName, detail) =>
        this.appendMemberBootstrapDiagnostic(targetRun, memberName, detail),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      emitMemberSpawnChange: (targetRun, memberName) =>
        this.emitMemberSpawnChange(targetRun, memberName),
    });
  }

  private markUnconfirmedBootstrapMembersFailed(
    run: ProvisioningRun,
    reason: string,
    options?: { cleanupRequested?: boolean; preserveExistingFailure?: boolean }
  ): void {
    this.createBootstrapFailureMarker().markUnconfirmedBootstrapMembersFailed(run, reason, options);
  }

  private async attachLiveRuntimeMetadataToStatuses(
    teamName: string,
    statuses: Record<string, MemberSpawnStatusEntry>,
    options?: {
      openCodeSecondaryBootstrapPendingMembers?: ReadonlySet<string>;
    }
  ): Promise<Record<string, MemberSpawnStatusEntry>> {
    const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName);
    return attachLiveRuntimeMetadataToStatusesHelper({
      statuses,
      runtimeByMember,
      openCodeSecondaryBootstrapPendingMembers: options?.openCodeSecondaryBootstrapPendingMembers,
      isOpenCodeBootstrapStallWindowElapsed: (firstSpawnAcceptedAt) =>
        this.isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt),
    });
  }

  private getOpenCodeSecondaryBootstrapPendingMemberNames(
    snapshot: PersistedTeamLaunchSnapshot | null | undefined
  ): ReadonlySet<string> {
    return getOpenCodeSecondaryBootstrapPendingMemberNamesHelper(snapshot);
  }

  private applyOpenCodeSecondaryBootstrapStallOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null {
    return applyOpenCodeSecondaryBootstrapStallOverlayHelper(snapshot, {
      nowMs: Date.now(),
      updatedAt: nowIso(),
    });
  }

  private async getLiveTeamAgentNames(teamName: string): Promise<Set<string>> {
    const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName);
    return new Set(
      [...runtimeByMember.entries()]
        .filter(([, metadata]) => metadata.alive)
        .map(([memberName]) => memberName)
    );
  }

  private async getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return this.liveRuntimeMetadataPorts.getLiveTeamAgentRuntimeMetadata(teamName);
  }

  private async clearPersistedLaunchState(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.persistenceReconcileFacade.clearPersistedLaunchState(teamName, options);
  }

  private canClearPersistedLaunchStateForRun(
    teamName: string,
    expectedRunId: string | undefined
  ): boolean {
    return this.persistenceReconcileFacade.canClearPersistedLaunchStateForRun(
      teamName,
      expectedRunId
    );
  }

  private async clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.persistenceReconcileFacade.clearPersistedLaunchStateNow(teamName, options);
  }

  private async applyOpenCodeSecondaryEvidenceOverlay(params: {
    teamName: string;
    snapshot: PersistedTeamLaunchSnapshot;
    previousSnapshot?: PersistedTeamLaunchSnapshot | null;
    metaMembers?: readonly TeamMember[];
  }): Promise<PersistedTeamLaunchSnapshot> {
    return applyOpenCodeSecondaryEvidenceOverlayHelper(
      params,
      this.openCodeSecondaryEvidenceOverlayPorts
    );
  }

  private async writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot> {
    return this.persistenceReconcileFacade.writeLaunchStateSnapshot(teamName, snapshot);
  }

  private async writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: { allowNoopSkip?: boolean; runId?: string }
  ): Promise<LaunchStateWriteResult> {
    return this.persistenceReconcileFacade.writeLaunchStateSnapshotNow(teamName, snapshot, options);
  }

  private isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    return this.persistenceReconcileFacade.isLaunchStateNoopRefreshDue(snapshot);
  }

  private async enqueueLaunchStateStoreOperation<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.persistenceReconcileFacade.enqueueLaunchStateStoreOperation(teamName, operation);
  }

  private getMemberLaunchSummary(run: ProvisioningRun): {
    confirmedCount: number;
    pendingCount: number;
    failedCount: number;
    skippedCount?: number;
    runtimeAlivePendingCount: number;
    shellOnlyPendingCount?: number;
    runtimeProcessPendingCount?: number;
    runtimeCandidatePendingCount?: number;
    noRuntimePendingCount?: number;
    permissionPendingCount?: number;
  } {
    return getMemberLaunchSummaryHelper(run);
  }

  private buildAggregatePendingLaunchMessage(
    prefix: string,
    run: ProvisioningRun,
    launchSummary: {
      confirmedCount: number;
      pendingCount: number;
      failedCount: number;
      runtimeAlivePendingCount: number;
      runtimeProcessPendingCount?: number;
    },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): string {
    return buildAggregatePendingLaunchMessageHelper({ prefix, run, launchSummary, snapshot });
  }

  private buildRuntimeSpawnStatusRecord(
    run: ProvisioningRun
  ): Record<string, MemberSpawnStatusEntry> {
    return buildRuntimeSpawnStatusRecordHelper(run);
  }

  private async reconcileFinalLaunchReportingSnapshot(
    run: ProvisioningRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.primaryBootstrapTruthReporting.reconcileFinalLaunchReportingSnapshot(run, snapshot);
  }

  private scheduleDeterministicBootstrapCompletionRecovery(run: ProvisioningRun): void {
    if (!run.deterministicBootstrap) {
      return;
    }

    const handle = setTimeout(() => {
      void this.recoverDeterministicBootstrapCompletion(run).catch((error: unknown) => {
        logger.warn(
          `[${run.teamName}] Failed to recover completed deterministic bootstrap state: ${getErrorMessage(
            error
          )}`
        );
      });
    }, DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS);
    handle.unref?.();
  }

  private async recoverDeterministicBootstrapCompletion(run: ProvisioningRun): Promise<void> {
    await recoverDeterministicBootstrapCompletionWithService<ProvisioningRun>(
      run,
      this as unknown as DeterministicBootstrapCompletionRecoveryServiceHost<ProvisioningRun>,
      {
        readBootstrapLaunchSnapshot,
        nowIso,
        getMemberLaunchSummary: getMemberLaunchSummaryHelper,
        buildAggregatePendingLaunchMessage: (prefix, targetRun, launchSummary, snapshot) =>
          buildAggregatePendingLaunchMessageHelper({
            prefix,
            run: targetRun,
            launchSummary,
            snapshot,
          }),
        updateProgress,
        extractCliLogsFromRun,
        warn: (message) => logger.warn(message),
      }
    );
  }

  private isProvisioningRunPromotedToAlive(run: ProvisioningRun): boolean {
    return (
      this.aliveRunByTeam.get(run.teamName) === run.runId &&
      this.provisioningRunByTeam.get(run.teamName) !== run.runId
    );
  }

  private hasPendingDeterministicFirstRealTurn(run: ProvisioningRun): boolean {
    return (
      run.deterministicBootstrap && run.requiresFirstRealTurnSuccess && !run.firstRealTurnSucceeded
    );
  }

  private isProvisioningRunStillPromotable(run: ProvisioningRun): boolean {
    if (this.runs.get(run.runId) !== run) return false;
    if (this.provisioningRunByTeam.get(run.teamName) !== run.runId) return false;
    if (
      run.cancelRequested ||
      run.processKilled ||
      run.processClosed ||
      run.finalizingByTimeout ||
      run.authRetryInProgress
    ) {
      return false;
    }
    if (
      run.progress.state === 'ready' ||
      run.progress.state === 'disconnected' ||
      run.progress.state === 'cancelled' ||
      isTerminalFailureProvisioningState(run.progress.state)
    ) {
      return false;
    }
    if (!run.child || run.child.killed) return false;
    const stdin = run.child.stdin as
      | (NodeJS.WritableStream & {
          destroyed?: boolean;
          writableEnded?: boolean;
          writable?: boolean;
        })
      | null
      | undefined;
    if (!stdin) return false;
    if (stdin.destroyed || stdin.writableEnded || stdin.writable === false) return false;
    return true;
  }

  private syncRunMemberSpawnStatusesFromSnapshot(
    run: ProvisioningRun,
    snapshot: PersistedTeamLaunchSnapshot
  ): void {
    this.liveLaunchSnapshotBoundary.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
  }

  private hasPendingLaunchMembers(
    run: ProvisioningRun,
    launchSummary: {
      pendingCount: number;
    },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return hasPendingLaunchMembersHelper({ run, launchSummary, snapshot });
  }

  private buildLiveLaunchSnapshotForRun(
    run: ProvisioningRun,
    launchPhase: PersistedTeamLaunchPhase = run.provisioningComplete ? 'finished' : 'active'
  ): PersistedTeamLaunchSnapshot | null {
    return this.liveLaunchSnapshotBoundary.buildLiveLaunchSnapshotForRun(run, launchPhase);
  }

  protected emitMemberSpawnChange(
    run: Pick<ProvisioningRun, 'teamName' | 'runId'>,
    memberName: string
  ): void {
    this.liveLaunchSnapshotBoundary.emitMemberSpawnChange(run, memberName);
  }

  private async maybeFireTeamLaunchedNotificationWhenAllMembersJoined(
    run: ProvisioningRun
  ): Promise<void> {
    if (
      !run.isLaunch ||
      run.teamLaunchedNotificationFired ||
      run.processKilled ||
      run.cancelRequested ||
      !this.isProvisioningRunPromotedToAlive(run) ||
      !this.areAllExpectedLaunchMembersConfirmed(run)
    ) {
      return;
    }

    await this.fireTeamLaunchedNotification(run);
  }

  private areAllExpectedLaunchMembersConfirmed(run: ProvisioningRun): boolean {
    return areAllExpectedLaunchMembersConfirmedHelper(run);
  }

  private async publishMixedSecondaryLaneStatusChange(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void> {
    if (!this.isCurrentTrackedRun(run)) {
      return;
    }
    let snapshot: PersistedTeamLaunchSnapshot | null = null;
    if (run.isLaunch) {
      snapshot = await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
    }
    if (snapshot) {
      this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    }
    this.emitMemberSpawnChange(run, lane.member.name);
  }

  private async guardCommittedOpenCodeSecondaryLaneEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
    memberName: string;
  }): Promise<TeamRuntimeLaunchResult> {
    return guardCommittedOpenCodeSecondaryLaneEvidenceHelper(
      params,
      createTeamProvisioningOpenCodeSecondaryLaneEvidencePortsFromService(
        this as unknown as TeamProvisioningOpenCodeSecondaryLaneEvidenceServiceHost,
        {
          logWarn: (message) => logger.warn(message),
        }
      )
    );
  }

  private async buildOpenCodeSecondaryAppManagedLaunchPrompt(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<string> {
    return this.openCodeSecondaryBriefingBuilder.buildOpenCodeSecondaryAppManagedLaunchPrompt({
      teamName: run.teamName,
      memberName: lane.member.name,
    });
  }

  private buildMixedPersistedLaunchSnapshotForRun(
    run: ProvisioningRun,
    launchPhase: PersistedTeamLaunchPhase
  ): PersistedTeamLaunchSnapshot | null {
    return buildMixedSecondaryLaunchSnapshotForRunHelper(run, launchPhase, {
      buildRuntimeSpawnStatusRecord: (inputRun) => this.buildRuntimeSpawnStatusRecord(inputRun),
      buildAggregateLaunchSnapshot: (params) =>
        this.runtimeLaneCoordinator.buildAggregateLaunchSnapshot(params),
    });
  }

  private hasMixedLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean {
    return hasMixedLaunchMetadata(snapshot);
  }

  private hasMixedSecondaryLaunchMetadata(snapshot: PersistedTeamLaunchSnapshot | null): boolean {
    return hasMixedSecondaryLaunchMetadata(snapshot);
  }

  private hasPrimaryOnlyLaneAwareLaunchMetadata(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return hasPrimaryOnlyLaneAwareLaunchMetadata(snapshot);
  }

  private shouldRecoverStalePersistedMixedLaunchSnapshot(
    snapshot: PersistedTeamLaunchSnapshot
  ): boolean {
    return shouldRecoverStalePersistedMixedLaunchSnapshotHelper({
      snapshot,
      nowMs: Date.now(),
      graceMs: MEMBER_LAUNCH_GRACE_MS,
      isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
    });
  }

  protected async persistLaunchStateSnapshot(
    run: ProvisioningRun,
    launchPhase: 'active' | 'finished' | 'reconciled' = run.provisioningComplete
      ? 'finished'
      : 'active'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.persistenceReconcileFacade.persistLaunchStateSnapshot(run, launchPhase);
  }

  private async persistLaunchStateSnapshotNow(
    run: ProvisioningRun,
    launchPhase: 'active' | 'finished' | 'reconciled'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.persistenceReconcileFacade.persistLaunchStateSnapshotNow(run, launchPhase);
  }

  private async launchSingleMixedSecondaryLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void> {
    await this.mixedSecondaryLaneWiring.launchSingleMixedSecondaryLane(run, lane);
  }

  private async stopSingleMixedSecondaryRuntimeLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: TeamRuntimeStopInput['reason']
  ): Promise<void> {
    await this.mixedSecondaryLaneWiring.stopSingleMixedSecondaryRuntimeLane(run, lane, reason);
  }

  private launchQueuedMixedSecondaryLaneInBackground(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): void {
    this.mixedSecondaryLaneWiring.launchQueuedMixedSecondaryLaneInBackground(run, lane);
  }

  private async launchMixedSecondaryLaneIfNeeded(
    run: ProvisioningRun,
    options: { waitForCompletion?: boolean } = {}
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.mixedSecondaryLaneWiring.launchMixedSecondaryLaneIfNeeded(run, options);
  }

  private async recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.mixedSecondaryLaneWiring.recoverStaleMixedSecondaryLaunchSnapshot(
      teamName,
      bootstrapSnapshot,
      persistedSnapshot
    );
  }

  private async findBootstrapRuntimeProofObservedAt(
    teamName: string,
    memberName: string,
    member: Pick<
      PersistedTeamLaunchMemberState,
      'firstSpawnAcceptedAt' | 'launchState' | 'hardFailureReason'
    >
  ): Promise<string | null> {
    return findBootstrapRuntimeProofObservedAtHelper({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      memberName,
      member,
      runtimeMembers: this.readPersistedRuntimeMembers(teamName),
    });
  }

  private async reconcilePersistedLaunchState(teamName: string): Promise<{
    snapshot: ReturnType<typeof createPersistedLaunchSnapshot> | null;
    statuses: Record<string, MemberSpawnStatusEntry>;
  }> {
    return this.persistenceReconcileFacade.reconcilePersistedLaunchState(teamName);
  }

  private async findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    return this.bootstrapTranscriptFacade.findBootstrapTranscriptFailureReason(
      teamName,
      memberName,
      sinceMs
    );
  }

  protected async findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapTranscriptFacade.findBootstrapTranscriptOutcome(
      teamName,
      memberName,
      sinceMs
    );
  }

  private async readRecentBootstrapTranscriptOutcome(
    filePath: string,
    sinceMs: number | null,
    memberName: string,
    teamName: string,
    options: {
      allowAnonymousFailure?: boolean;
      contextMemberNames?: readonly string[];
    } = {}
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapTranscriptFacade.readRecentBootstrapTranscriptOutcome(
      filePath,
      sinceMs,
      memberName,
      teamName,
      options
    );
  }

  private async readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]> {
    return this.bootstrapTranscriptFacade.readBootstrapTranscriptOutcomesInProjectRoot(
      teamName,
      memberName,
      sinceMs
    );
  }

  private applyProcessBootstrapTransportOverlay(
    input: Omit<
      Parameters<typeof applyProcessBootstrapTransportOverlayHelper>[0],
      'nowIso' | 'mergeRuntimeDiagnostics'
    >
  ): ReturnType<typeof applyProcessBootstrapTransportOverlayHelper> {
    return applyProcessBootstrapTransportOverlayHelper({
      ...input,
      nowIso,
      mergeRuntimeDiagnostics,
    });
  }

  private async applyBootstrapTranscriptEvidenceOverlay(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return applyBootstrapTranscriptEvidenceOverlayHelper({
      snapshot,
      expectedMembers: snapshot ? getPersistedLaunchMemberNames(snapshot) : [],
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        this.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
      nowIso,
    });
  }

  private async reconcileBootstrapTranscriptFailures(run: ProvisioningRun): Promise<void> {
    await reconcileBootstrapTranscriptFailuresForRun(run, this.memberSpawnStatusAuditPorts);
  }

  private async reconcileBootstrapTranscriptSuccesses(run: ProvisioningRun): Promise<void> {
    await reconcileBootstrapTranscriptSuccessesForRun(run, this.memberSpawnStatusAuditPorts);
  }

  /**
   * Stop the running process for a team. No-op if team is not running.
   * Always uses SIGKILL via killTeamProcess() to prevent CLI cleanup.
   */
  async stopTeam(teamName: string): Promise<void> {
    await this.stopFlowBoundary.stopTeam(teamName);
  }

  private async stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void> {
    await this.stopFlowBoundary.stopMixedSecondaryRuntimeLanes(teamName);
  }

  private async stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void> {
    await this.stopFlowBoundary.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
  }

  /**
   * Stop all running team processes. Called during app shutdown.
   * Uses killTeamProcess() (SIGKILL) to guarantee instant death
   * without CLI cleanup that would delete team files.
   */
  async stopAllTeams(): Promise<void> {
    await stopAllTeamsFlow({
      incrementStopAllTeamsGeneration: () => {
        this.stopAllTeamsGeneration += 1;
      },
      getShutdownTrackedTeamNames: () => this.shutdownCoordination.getShutdownTrackedTeamNames(),
      pauseActiveIntervalsForTeam: (teamName) =>
        this.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
      killTrackedCliProcesses,
      killTransientProbeProcessesForShutdown: () =>
        this.shutdownCoordination.killTransientProbeProcessesForShutdown(),
      stopTrackedTeamsForShutdown: (label) =>
        this.shutdownCoordination.stopTrackedTeamsForShutdown(label),
      cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
        this.shutdownCoordination.cancelPendingRuntimeAdapterLaunchesForShutdown(),
      waitForInFlightTeamOperationsForShutdown: () =>
        this.shutdownCoordination.waitForInFlightTeamOperationsForShutdown(),
      listPersistedTeamNames: () => this.configFacade.listPersistedTeamNames(),
      stopPersistentTeamMembers: (teamName) =>
        this.persistentRuntimeCleanup.stopPersistentTeamMembers(teamName),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
        this.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
      logger,
    });
  }

  /**
   * Injects a post-compact context reminder into the lead process via stdin.
   * Reinjects durable lead rules (constraints, communication protocol, board MCP ops)
   * plus a fresh task board snapshot so the lead recovers full operational context
   * after context compaction.
   *
   * Policy: strict drop-after-attempt — one compact cycle gives at most one reminder turn.
   * If the injection fails (stdin not writable, process killed), we do not retry.
   */
  private async injectPostCompactReminder(run: ProvisioningRun): Promise<void> {
    await this.idlePromptInjectionBoundary.injectPostCompactReminder(run);
  }

  private async injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    await this.idlePromptInjectionBoundary.injectGeminiPostLaunchHydration(run);
  }

  /**
   * Handles a control_request message from CLI stream-json output.
   * `can_use_tool` → emits to renderer for manual approval.
   * All other subtypes (hook_callback, etc.) → auto-allowed to prevent deadlock.
   */
  private handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    this.toolApprovalFacade.handleControlRequest(run, msg);
  }

  /**
   * Handles a teammate permission_request received via inbox message.
   * Converts it to a ToolApprovalRequest and feeds it into the existing approval flow.
   */
  private handleTeammatePermissionRequest(
    run: ProvisioningRun,
    perm: ParsedPermissionRequest,
    messageTimestamp: string
  ): void {
    this.toolApprovalFacade.handleTeammatePermissionRequest(run, perm, messageTimestamp);
  }

  /**
   * Safely add tool names to the permissions.allow (or deny) array in a Claude settings file.
   * Creates the file and parent directories if they don't exist.
   * Merges with existing entries — never overwrites.
   */
  private async addPermissionRulesToSettings(
    settingsPath: string,
    toolNames: string[],
    behavior: string
  ): Promise<number> {
    return addClaudePermissionRulesToSettings(
      { settingsPath, toolNames, behavior },
      claudePermissionSettingsFilePorts
    );
  }

  private async seedLeadBootstrapPermissionRules(
    teamName: string,
    projectCwd: string
  ): Promise<void> {
    await seedLeadBootstrapPermissionRulesHelper(
      {
        teamName,
        projectCwd,
        bootstrapToolNames: AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
      },
      { ...claudePermissionSettingsFilePorts, logger }
    );
  }

  // ---------------------------------------------------------------------------
  // Team Launched notification
  // ---------------------------------------------------------------------------

  /**
   * Fires a "team_launched" notification when a team transitions to ready state.
   * Uses the existing addTeamNotification() pipeline.
   */
  private async fireTeamLaunchedNotification(run: ProvisioningRun): Promise<void> {
    await this.launchNotifications.fireTeamLaunchedNotification(run);
  }

  private async fireTeamLaunchIncompleteNotification(
    run: ProvisioningRun,
    failedMembers: readonly { name: string }[],
    launchSummary: {
      confirmedCount: number;
      pendingCount: number;
      failedCount: number;
      runtimeAlivePendingCount: number;
      runtimeProcessPendingCount?: number;
    },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): Promise<void> {
    await this.launchNotifications.fireTeamLaunchIncompleteNotification(
      run,
      failedMembers,
      launchSummary,
      snapshot
    );
  }

  // ---------------------------------------------------------------------------
  // Same-team native delivery dedup (Layer 2)
  // ---------------------------------------------------------------------------

  private rememberSameTeamNativeFingerprints(
    teamName: string,
    blocks: ParsedTeammateContent[]
  ): void {
    this.sameTeamNativeDelivery.rememberSameTeamNativeFingerprints(teamName, blocks);
  }

  private async confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: InboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }> {
    return this.sameTeamNativeDelivery.confirmSameTeamNativeMatches(teamName, leadName, messages);
  }

  private async reconcileSameTeamNativeDeliveries(
    teamName: string,
    leadName: string
  ): Promise<void> {
    await this.sameTeamNativeDelivery.reconcileSameTeamNativeDeliveries(teamName, leadName);
  }

  private scheduleSameTeamDeferredRetry(teamName: string): void {
    this.sameTeamNativeDelivery.scheduleSameTeamDeferredRetry(teamName);
  }

  /**
   * Best-effort durable follow-up after native delivery was matched but inbox read-state
   * could not be persisted. If the run dies before this retry succeeds, a later reconnect
   * may still relay the row once because in-memory dedupe is not durable.
   */
  private scheduleSameTeamPersistRetry(teamName: string): void {
    this.sameTeamNativeDelivery.scheduleSameTeamPersistRetry(teamName);
  }

  private markIncompleteLaunchStateFinalized(run: ProvisioningRun, cleanupReason: string): void {
    logger.warn(`[${run.teamName}] Launch cleanup finalizing unconfirmed bootstrap members`, {
      runId: run.runId,
      progressState: run.progress.state,
      progressMessage: run.progress.message,
      progressError: run.progress.error ?? null,
      cleanupReason,
      unconfirmedMembers: this.outputRecoveryFacade.getUnconfirmedBootstrapMemberNames(run),
      ...this.outputRecoveryFacade.buildStdoutCarryDiagnostic(run),
    });
    this.markUnconfirmedBootstrapMembersFailed(run, cleanupReason, {
      cleanupRequested: true,
      preserveExistingFailure: true,
    });
    run.launchCleanupStateFinalized = true;
  }

  private async finalizeIncompleteLaunchStateBeforeCleanup(
    run: ProvisioningRun,
    fallbackReason?: string
  ): Promise<void> {
    await finalizeIncompleteLaunchStateBeforeCleanupHelper(run, this.cleanupRunPorts, {
      fallbackReason,
      onPersistFailure: (run, error) => {
        logger.warn(
          `[${run.teamName}] Failed to finalize launch state before cleanup: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    });
  }

  /**
   * Remove a run from tracking maps.
   */
  private cleanupRun(run: ProvisioningRun): void {
    cleanupProvisioningRun(run, this.cleanupRunPorts);
  }

  /**
   * Polls the filesystem to track provisioning progress in real time.
   * Emits progress updates as team files appear (config, inboxes, tasks).
   */
  private startFilesystemMonitor(run: ProvisioningRun, request: TeamCreateRequest): void {
    startProvisioningFilesystemMonitor(run, request, {
      updateProgress,
      getRegisteredTeamMemberNames: (teamName) => this.getRegisteredTeamMemberNames(teamName),
      handleProvisioningTurnComplete: (run) => this.handleProvisioningTurnComplete(run),
    });
  }

  private stopFilesystemMonitor(run: ProvisioningRun): void {
    stopProvisioningFilesystemMonitor(run);
  }

  private async handleProcessExit(run: ProvisioningRun, code: number | null): Promise<void> {
    await handleProvisioningProcessExit(run, code, this.processExitPorts);
  }
}
