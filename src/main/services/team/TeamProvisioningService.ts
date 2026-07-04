import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import {
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { notifyTeamWatchScopeChanged } from '@main/services/infrastructure/teamWatchScope';
import {
  execCli,
  killProcessTree,
  killTrackedCliProcesses,
  spawnCli,
} from '@main/utils/childProcess';
import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import {
  getAutoDetectedClaudeBasePath,
  getClaudeBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { type ParsedPermissionRequest } from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';
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
import {
  isOpenCodeSessionRefreshRetryRecord,
  OpenCodePromptDeliveryFollowUpPolicy,
} from './opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import {
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from './opencode/delivery/OpenCodePromptDeliveryLedger';
import { type OpenCodeVisibleReplyProof } from './opencode/delivery/OpenCodePromptDeliveryWatchdog';
import {
  createOpenCodePromptDeliveryWatchdogCoordinator,
  type OpenCodePromptDeliveryWatchdogCoordinator,
} from './opencode/delivery/OpenCodePromptDeliveryWatchdogCoordinator';
import { OpenCodePromptDeliveryWatchdogScheduler } from './opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import {
  buildOpenCodeRuntimeDeliveryUserVisibleImpact,
  type OpenCodeRuntimeDeliveryAdvisoryDecision,
} from './opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { openCodeTaskRefsIncludeAll as openCodeTaskRefsIncludeAllValue } from './opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';
import { OpenCodeRuntimeDeliveryProofReader } from './opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { OpenCodeVisibleReplyProofService } from './opencode/delivery/OpenCodeVisibleReplyProofService';
import {
  clearOpenCodeRuntimeLaneStorage,
  inspectOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  readOpenCodeRuntimeLaneIndex,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { getSystemLocale } from './provisioning/TeamProvisioningAgentLanguage';
import { ensureCwdExists, sleep } from './provisioning/TeamProvisioningAsyncUtils';
import {
  createTeamProvisioningBootstrapFailureMarker,
  type TeamProvisioningBootstrapFailureMarker,
} from './provisioning/TeamProvisioningBootstrapFailureMarking';
import { type RuntimeBootstrapMemberMcpLaunchConfig } from './provisioning/TeamProvisioningBootstrapSpec';
import {
  createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
  createTeamProvisioningOpenCodeBootstrapStallStatusPorts,
  type TeamProvisioningOpenCodeBootstrapStallReconciliationPorts,
} from './provisioning/TeamProvisioningBootstrapStallPortsFactory';
import {
  type BootstrapTranscriptOutcome,
  findBootstrapRuntimeProofObservedAt as findBootstrapRuntimeProofObservedAtHelper,
  type ParsedBootstrapTranscriptTailCacheEntry,
} from './provisioning/TeamProvisioningBootstrapTranscript';
import {
  createTeamProvisioningBootstrapTranscriptOutcomePorts,
  type TeamProvisioningBootstrapTranscriptOutcomePorts,
} from './provisioning/TeamProvisioningBootstrapTranscriptOutcomePortsFactory';
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
import { createTeamProvisioningCleanupRunPorts } from './provisioning/TeamProvisioningCleanupRunPortsFactory';
import { getCliHelpOutputWithProvisioningPorts } from './provisioning/TeamProvisioningCliHelpOutputPortsFactory';
import { TeamProvisioningConfigFacade } from './provisioning/TeamProvisioningConfigFacade';
import {
  createDefaultDeterministicCreateRunFlowPorts,
  type DeterministicCreateRunFlowPorts,
  runDeterministicCreateRunFlow,
} from './provisioning/TeamProvisioningCreateDeterministicRunFlow';
import { prepareDeterministicCreateSetupFlow } from './provisioning/TeamProvisioningCreateDeterministicSetupFlow';
import {
  type DeterministicCreateSpawnFlowPorts,
  runDeterministicCreateSpawnFlow,
} from './provisioning/TeamProvisioningCreateDeterministicSpawnFlow';
import {
  createTeamProvisioningCreateDeterministicSpawnFlowBoundary,
  type TeamProvisioningCreateDeterministicSpawnFlowBoundary,
} from './provisioning/TeamProvisioningCreateDeterministicSpawnFlowPortsFactory';
import { createDeterministicCreateProvisioningRun } from './provisioning/TeamProvisioningCreateTeamFlow';
import {
  clearPendingCrossTeamReplyExpectation as clearPendingCrossTeamReplyExpectationInState,
  type CrossTeamDeliveredLeadBlock,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  readAndMatchCrossTeamLeadInboxMessages,
  registerPendingCrossTeamReplyExpectation as registerPendingCrossTeamReplyExpectationInState,
  resolveCrossTeamLeadName,
} from './provisioning/TeamProvisioningCrossTeamRelayHelpers';
import { recoverDeterministicBootstrapCompletion as recoverDeterministicBootstrapCompletionHelper } from './provisioning/TeamProvisioningDeterministicBootstrapCompletionRecovery';
import { type ProvisioningEnvResolution } from './provisioning/TeamProvisioningEnvBuilder';
import { assertAppDeterministicBootstrapEnabled } from './provisioning/TeamProvisioningEnvGuards';
import { createTeamProvisioningEnvRuntimePorts } from './provisioning/TeamProvisioningEnvRuntimePorts';
import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from './provisioning/TeamProvisioningFilesystemMonitor';
import {
  createTeamProvisioningIdlePromptInjectionBoundary,
  type TeamProvisioningIdlePromptInjectionBoundary,
} from './provisioning/TeamProvisioningIdlePromptInjectionPortsFactory';
import { markTeamInboxMessagesRead } from './provisioning/TeamProvisioningInboxPersistence';
import { armSilentTeammateForward } from './provisioning/TeamProvisioningInboxRelayCandidates';
import { hasStableInboxMessageId } from './provisioning/TeamProvisioningInboxRelayPolicy';
import { notifyAliveTeamsAboutLanguageChangeWithPorts } from './provisioning/TeamProvisioningLanguageChangeNotification';
import { assertOpenCodeNotLaunchedThroughLegacyProvisioning } from './provisioning/TeamProvisioningLaunchCompatibility';
import {
  createTeamProvisioningLaunchDeterministicFlowBoundary,
  type TeamProvisioningLaunchDeterministicFlowBoundary,
  type TeamProvisioningLaunchDeterministicFlowHost,
} from './provisioning/TeamProvisioningLaunchDeterministicFlowPortsFactory';
import { runDeterministicLaunchRunFlow } from './provisioning/TeamProvisioningLaunchDeterministicRunFlow';
import { prepareDeterministicLaunchSetup } from './provisioning/TeamProvisioningLaunchDeterministicSetupFlow';
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
  areLaunchStateSnapshotsSemanticallyEqual,
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
  getLeadActivityStateForTeam,
  setLeadActivity as setLeadActivityHelper,
  type SetLeadActivityPorts,
  syncLeadTaskActivityForState as syncLeadTaskActivityForStateHelper,
} from './provisioning/TeamProvisioningLeadActivity';
import { createTeamProvisioningLeadActivityPorts } from './provisioning/TeamProvisioningLeadActivityPortsFactory';
import {
  buildLeadContextUsagePayloadForRun,
  getLeadContextUsageForTeam,
} from './provisioning/TeamProvisioningLeadContextUsage';
import { createTeamProvisioningLeadInboxRelayPortsBoundary } from './provisioning/TeamProvisioningLeadInboxRelayPortsFactory';
import {
  getPreCompleteCliErrorTextFromRun,
  getRunTrackedCwdFromRun,
  isCurrentTrackedRunById,
} from './provisioning/TeamProvisioningLeadRunDerivation';
import {
  type LiveInboxRelayResult,
  relayInboxFileToLiveRecipientWithPorts,
} from './provisioning/TeamProvisioningLiveInboxRelayRouting';
import { createTeamProvisioningLiveLaunchSnapshotBoundary } from './provisioning/TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import { createTeamProvisioningLiveLeadMessagePortsBoundary } from './provisioning/TeamProvisioningLiveLeadMessagePortsFactory';
import { createTeamProvisioningLiveRuntimeMetadataPorts } from './provisioning/TeamProvisioningLiveRuntimeMetadataPortsFactory';
import { sliceClaudeLogs } from './provisioning/TeamProvisioningLogSlice';
import { relayMemberInboxMessagesWithPorts } from './provisioning/TeamProvisioningMemberInboxRelayFlow';
import {
  type LiveRosterAttachReason,
  type MemberLifecycleOperation,
  TeamProvisioningMemberLifecycleController,
} from './provisioning/TeamProvisioningMemberLifecycle';
import {
  createTeamProvisioningMemberLifecycleHost,
  type TeamProvisioningMemberLifecycleHostFactoryService,
} from './provisioning/TeamProvisioningMemberLifecycleHostFactory';
import { TeamProvisioningMemberMcpLaunchConfigProvisioner } from './provisioning/TeamProvisioningMemberMcpLaunchConfig';
import {
  applyLeadInboxSpawnSignal as applyLeadInboxSpawnSignalHelper,
  refreshMemberSpawnStatusesFromLeadInbox as refreshMemberSpawnStatusesFromLeadInboxHelper,
  resolveExpectedLaunchMemberName as resolveExpectedLaunchMemberNameHelper,
} from './provisioning/TeamProvisioningMemberSpawnLeadInbox';
import {
  confirmMemberSpawnStatusFromTranscriptForRun,
  getMemberSpawnStatusesSnapshot,
  maybeAuditMemberSpawnStatusesForRun,
  type MemberSpawnStatusAuditPorts,
  type MemberSpawnStatusMutationPorts,
  setMemberSpawnStatusForRun,
} from './provisioning/TeamProvisioningMemberSpawnSnapshots';
import {
  createInitialMemberSpawnStatusEntry,
  MEMBER_LAUNCH_GRACE_MS,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
import { createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary } from './provisioning/TeamProvisioningMemberSpawnStatusSnapshotPortsFactory';
import {
  buildRuntimeSpawnStatusRecord as buildRuntimeSpawnStatusRecordHelper,
  filterRemovedMembersFromLaunchSnapshot,
  getFailedSpawnMembersFromStatuses,
} from './provisioning/TeamProvisioningMemberStatusProjection';
import { type MemberWorkSyncAcceptedReportChecker } from './provisioning/TeamProvisioningMemberWorkSyncProof';
import { createTeamProvisioningMemberWorkSyncProofBoundary } from './provisioning/TeamProvisioningMemberWorkSyncProofBoundaryFactory';
import {
  persistTeamProvisioningInboxMessage,
  persistTeamProvisioningSentMessage,
} from './provisioning/TeamProvisioningMessagePersistence';
import { createTeamProvisioningMixedSecondaryLaneWiring } from './provisioning/TeamProvisioningMixedSecondaryLaneWiring';
import {
  buildMixedSecondaryLaunchSnapshotForRun as buildMixedSecondaryLaunchSnapshotForRunHelper,
  shouldRecoverStalePersistedMixedLaunchSnapshot as shouldRecoverStalePersistedMixedLaunchSnapshotHelper,
} from './provisioning/TeamProvisioningMixedSecondaryLaunchReconciliation';
import { handleNativeTeammateUserMessage as handleNativeTeammateUserMessageHelper } from './provisioning/TeamProvisioningNativeTeammateMessages';
import { getOpenCodeAgendaSyncRecoveryBypassMessageIds as getOpenCodeAgendaSyncRecoveryBypassMessageIdsHelper } from './provisioning/TeamProvisioningOpenCodeAgendaSyncRecovery';
import {
  commitOpenCodeRuntimeAdapterLaunchSessionEvidence as commitOpenCodeRuntimeAdapterLaunchSessionEvidenceHelper,
  launchOpenCodeAggregatePrimaryLane as launchOpenCodeAggregatePrimaryLaneHelper,
  persistOpenCodeRuntimeAdapterLaunchResult as persistOpenCodeRuntimeAdapterLaunchResultHelper,
  summarizeOpenCodeAggregateLaunchState as summarizeOpenCodeAggregateLaunchStateHelper,
} from './provisioning/TeamProvisioningOpenCodeAggregateLaunchPersistence';
import { type OpenCodeRuntimeBootstrapEvidencePorts } from './provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import {
  isOpenCodeBootstrapStallWindowElapsed as isOpenCodeBootstrapStallWindowElapsedHelper,
  type OpenCodeBootstrapStallStatusPorts,
  scheduleOpenCodeBootstrapStallReevaluation as scheduleOpenCodeBootstrapStallReevaluationHelper,
} from './provisioning/TeamProvisioningOpenCodeBootstrapStall';
import { boundOpenCodeAppManagedBriefingText } from './provisioning/TeamProvisioningOpenCodeDiagnosticsPolicy';
import { createTeamProvisioningOpenCodeInboxAttachmentPayloadBoundary } from './provisioning/TeamProvisioningOpenCodeInboxAttachmentPayloadBoundaryFactory';
import { createTeamProvisioningOpenCodeLaunchWiring } from './provisioning/TeamProvisioningOpenCodeLaunchWiring';
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
  type TeamProvisioningOpenCodeMemberInboxRelayHost,
} from './provisioning/TeamProvisioningOpenCodeMemberInboxRelayBoundaryFactory';
import {
  createOpenCodeMemberMessageDeliveryServiceFromHost,
  createOpenCodeRuntimeBootstrapEvidencePorts as createOpenCodeRuntimeBootstrapEvidencePortsHelper,
  deliverOpenCodeMemberMessage as deliverOpenCodeMemberMessageHelper,
  type TeamProvisioningOpenCodeMemberMessageDeliveryHost,
} from './provisioning/TeamProvisioningOpenCodeMemberMessageDeliveryServiceFactory';
import { OpenCodeMemberSendSerializer } from './provisioning/TeamProvisioningOpenCodeMemberSendSerialization';
import {
  createOpenCodeTeamThroughRuntimeAdapterFlow,
  launchOpenCodeTeamThroughRuntimeAdapterFlow,
  type OpenCodeRuntimeAdapterTeamFlowPorts,
} from './provisioning/TeamProvisioningOpenCodeRuntimeAdapterTeamFlow';
import { type OpenCodeRuntimeControlAck } from './provisioning/TeamProvisioningOpenCodeRuntimeCheckin';
import {
  type MemberWorkSyncProofMissingRecoveryScheduler,
  TeamProvisioningOpenCodeRuntimeDeliveryAdvisory,
} from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import {
  createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost,
  type TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost,
} from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryBoundaryFactory';
import {
  applyOpenCodeSecondaryBootstrapStallOverlay as applyOpenCodeSecondaryBootstrapStallOverlayHelper,
  getOpenCodeSecondaryBootstrapPendingMemberNames as getOpenCodeSecondaryBootstrapPendingMemberNamesHelper,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
} from './provisioning/TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  cleanupStoppedTeamOpenCodeRuntimeLanesInBackground as cleanupStoppedTeamOpenCodeRuntimeLanesInBackgroundHelper,
  hasAlivePersistedTeamProcess as hasAlivePersistedTeamProcessHelper,
  hasOnlyExplicitlyStoppedPersistedTeamProcesses as hasOnlyExplicitlyStoppedPersistedTeamProcessesHelper,
  readProcessCommandByPid as readOpenCodeRuntimeLaneProcessCommandByPid,
  stopOpenCodeRuntimeLanesForStoppedTeam as stopOpenCodeRuntimeLanesForStoppedTeamHelper,
  stopOpenCodeRuntimeLanesForStoppedTeamOnce,
  tryStopPersistedOpenCodeRuntimePidForStoppedLane as tryStopPersistedOpenCodeRuntimePidForStoppedLaneHelper,
} from './provisioning/TeamProvisioningOpenCodeRuntimeLaneCleanup';
import { TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade } from './provisioning/TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade';
import {
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePermissionListingAdapter,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSyncInput,
  persistOpenCodeRuntimePendingPermissions,
  syncOpenCodeRuntimePermissionsAfterDelivery,
  syncOpenCodeRuntimePermissionSpawnStatusesForTrackedRun,
} from './provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import { rememberOpenCodeRuntimePidFromBridge as rememberOpenCodeRuntimePidFromBridgeHelper } from './provisioning/TeamProvisioningOpenCodeRuntimePidBridge';
import { createTeamProvisioningOpenCodeRuntimeRecoveryBoundary } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryBoundaryFactory';
import { resolveOpenCodeRuntimeLaneId as resolveOpenCodeRuntimeLaneIdHelper } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { createOpenCodeRuntimeRecoveryIdentityHelpers } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryIdentity';
import { createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts } from './provisioning/TeamProvisioningOpenCodeSecondaryEvidenceOverlayPortsFactory';
import { writeOpenCodeTeamConfig } from './provisioning/TeamProvisioningOpenCodeTeamConfigWriter';
import {
  isAuthFailureWarning,
  normalizeApiRetryErrorMessage,
} from './provisioning/TeamProvisioningOutputErrorPolicy';
import { TeamProvisioningOutputRecoveryFacade } from './provisioning/TeamProvisioningOutputRecoveryFacade';
import { reconcilePersistedLaunchStateWithTeamProvisioningPorts } from './provisioning/TeamProvisioningPersistedLaunchReconcilePorts';
import { type PersistedTeamConfigCacheEntry } from './provisioning/TeamProvisioningPersistedTeamConfigAccess';
import { TeamProvisioningPrepareFacade } from './provisioning/TeamProvisioningPrepareFacade';
import { createTeamProvisioningPrimaryBootstrapTruthReportingBoundary } from './provisioning/TeamProvisioningPrimaryBootstrapTruthReportingPortsFactory';
import {
  handleProvisioningProcessExit,
  type TeamProvisioningProcessExitPorts,
} from './provisioning/TeamProvisioningProcessExit';
import { createTeamProvisioningProcessExitPorts } from './provisioning/TeamProvisioningProcessExitPortsFactory';
import {
  isTerminalFailureProvisioningState,
  TeamProvisioningRetainedProgressState,
} from './provisioning/TeamProvisioningProgressState';
import {
  buildDeterministicLaunchHydrationPrompt,
  getCanonicalSendMessageFieldRule,
  getCanonicalSendMessageToolRule,
} from './provisioning/TeamProvisioningPromptBuilders';
import {
  createTeamProvisioningProviderRuntimeFacade,
  type TeamProvisioningProviderRuntimeFacade,
} from './provisioning/TeamProvisioningProviderRuntimeFacade';
import { createTeamProvisioningReevaluateMemberLaunchStatusBoundary } from './provisioning/TeamProvisioningReevaluateMemberLaunchStatusPortsFactory';
import {
  auditRegisteredMemberSpawnStatuses as auditRegisteredMemberSpawnStatusesHelper,
  readRegisteredTeamMemberNamesFromConfig,
} from './provisioning/TeamProvisioningRegisteredMemberAudit';
import {
  extractCliLogsFromRun,
  type RetainedClaudeLogsSnapshot,
} from './provisioning/TeamProvisioningRetainedLogs';
import {
  APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
  DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS,
  LEAD_TEXT_EMIT_THROTTLE_MS,
  LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
  MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
  type ProvisioningRun,
  TEAM_CONFIG_MAX_BYTES,
  TEAM_INBOX_MAX_BYTES,
  TEAM_JSON_READ_TIMEOUT_MS,
  VERIFY_POLL_MS,
  VERIFY_TIMEOUT_MS,
} from './provisioning/TeamProvisioningRunModel';
import {
  emitLogsProgress,
  killTeamProcess,
  nowIso,
  updateProgress,
  wrapInAgentBlock,
} from './provisioning/TeamProvisioningRunProgress';
import {
  cancelRuntimeAdapterProvisioning as cancelRuntimeAdapterProvisioningHelper,
  clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned as clearOpenCodeRuntimeAdapterPrimaryLaneIfOwnedHelper,
  isCancellableRuntimeAdapterProgress as isCancellableRuntimeAdapterProgressHelper,
  recordCancelledOpenCodeRuntimeAdapterLaunch as recordCancelledOpenCodeRuntimeAdapterLaunchHelper,
  type RuntimeAdapterCancellationPorts,
} from './provisioning/TeamProvisioningRuntimeAdapterCancellation';
import { createTeamProvisioningRuntimeAdapterCancellationPorts } from './provisioning/TeamProvisioningRuntimeAdapterCancellationPortsFactory';
import { TeamProvisioningRuntimeAdapterProgressState } from './provisioning/TeamProvisioningRuntimeAdapterProgressState';
import {
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesHelper,
  planRuntimeLanesOrThrow as planRuntimeLanesOrThrowHelper,
  shouldRouteOpenCodeToRuntimeAdapter as shouldRouteOpenCodeToRuntimeAdapterHelper,
} from './provisioning/TeamProvisioningRuntimeBootstrapDelivery';
import {
  getAnthropicFastModeDefault,
  getTeamProviderLabel,
} from './provisioning/TeamProvisioningRuntimeDiagnostics';
import {
  buildMissingCliError,
  getRuntimeFailureLabelForRequest,
} from './provisioning/TeamProvisioningRuntimeFailureLabels';
import {
  buildTeamRuntimeLaunchArgsPlan as buildTeamRuntimeLaunchArgsPlanHelper,
  type BuildTeamRuntimeLaunchArgsPlanInput,
  getTeamsBasePathsToProbe,
  logsSuggestShutdownOrCleanup,
  type RuntimeProviderLaunchFacts,
  type TeamRuntimeLaunchArgsPlan,
  type ValidConfigProbeResult,
} from './provisioning/TeamProvisioningRuntimeLaunchSelection';
import { type LiveTeamAgentRuntimeMetadata } from './provisioning/TeamProvisioningRuntimeMetadataPolicy';
import {
  getOpenCodeRuntimeAdapter as getOpenCodeRuntimeAdapterHelper,
  getOpenCodeRuntimeMessageAdapter as getOpenCodeRuntimeMessageAdapterHelper,
  getOpenCodeRuntimePermissionListingAdapter as getOpenCodeRuntimePermissionListingAdapterHelper,
  isOpenCodeRuntimeRecipient as isOpenCodeRuntimeRecipientHelper,
  isOpenCodeRuntimeRecipientFromSources as isOpenCodeRuntimeRecipientFromSourcesHelper,
  resolveRuntimeRecipientProviderId as resolveRuntimeRecipientProviderIdHelper,
  resolveRuntimeRecipientProviderIdFromSources as resolveRuntimeRecipientProviderIdFromSourcesHelper,
} from './provisioning/TeamProvisioningRuntimeRecipientResolution';
import { TeamProvisioningRuntimeResourceSampling } from './provisioning/TeamProvisioningRuntimeResourceSampling';
import {
  attachLiveRuntimeMetadataToStatuses as attachLiveRuntimeMetadataToStatusesHelper,
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
} from './provisioning/TeamProvisioningRuntimeSnapshot';
import { TeamProvisioningRuntimeSnapshotCacheBoundary } from './provisioning/TeamProvisioningRuntimeSnapshotCache';
import { TeamProvisioningRuntimeStateProjection } from './provisioning/TeamProvisioningRuntimeStateProjection';
import { createRuntimeToolActivityHandlers } from './provisioning/TeamProvisioningRuntimeToolActivity';
import {
  buildRuntimeTurnSettledHookSettingsArgs as buildRuntimeTurnSettledHookSettingsArgsHelper,
  buildRuntimeTurnSettledHookSettingsObject as buildRuntimeTurnSettledHookSettingsObjectHelper,
  type RuntimeTurnSettledEnvironmentProvider,
  type RuntimeTurnSettledHookSettingsProvider,
} from './provisioning/TeamProvisioningRuntimeTurnSettledPlanning';
import { TeamProvisioningRunTrackingDeliveryHelper } from './provisioning/TeamProvisioningRunTrackingDelivery';
import {
  createTeamProvisioningSameTeamNativeDeliveryPorts,
  TeamProvisioningSameTeamNativeDelivery,
} from './provisioning/TeamProvisioningSameTeamNativeDelivery';
import {
  createMixedSecondaryLaneStateForMember as buildMixedSecondaryLaneStateForMember,
  createSecondaryRuntimeRunStore,
  getCurrentOpenCodeRuntimeRunId as resolveOpenCodeRuntimeRunIdFromMaps,
  getMixedSecondaryLaunchPhase as getMixedSecondaryLaunchPhaseFromRun,
  type MixedSecondaryRuntimeLaneState,
  removeRunAllEffectiveMember as removeRunAllEffectiveMemberFromRun,
  type SecondaryRuntimeRunEntry,
  upsertRunAllEffectiveMember as upsertRunAllEffectiveMemberInRun,
} from './provisioning/TeamProvisioningSecondaryRuntimeRuns';
import { createTeamProvisioningSendMessageToRunBoundary } from './provisioning/TeamProvisioningSendMessageToRunBoundaryFactory';
import { createTeamProvisioningShutdownCoordination } from './provisioning/TeamProvisioningShutdownCoordination';
import {
  stopAllTeamsFlow,
  stopPersistentTeamMembersFlow,
} from './provisioning/TeamProvisioningStopFlow';
import { createTeamProvisioningStopFlowBoundary } from './provisioning/TeamProvisioningStopFlowPortsFactory';
import {
  killOrphanedTeamAgentProcesses as killOrphanedTeamAgentProcessesHelper,
  killPersistedPaneMembers as killPersistedPaneMembersHelper,
} from './provisioning/TeamProvisioningStopProcessCleanup';
import {
  createTeamProvisioningStreamEventPortsBoundary,
  type TeamProvisioningStreamEventServiceAdapter,
} from './provisioning/TeamProvisioningStreamEventPortsFactory';
import {
  handleDeterministicBootstrapEvent,
  handleTeamProvisioningStreamJsonMessage,
  shouldAcceptDeterministicBootstrapEvent,
  type TeamProvisioningStreamEventPorts,
} from './provisioning/TeamProvisioningStreamEvents';
import { captureTeamSpawnEvents as captureTeamSpawnEventsHelper } from './provisioning/TeamProvisioningStreamSpawnEvents';
import { TeamProvisioningTaskActivityRepairBoundary } from './provisioning/TeamProvisioningTaskActivityRepairBoundary';
import { TeamProvisioningToolApprovalFacade } from './provisioning/TeamProvisioningToolApprovalFacade';
import { TeamProvisioningTranscriptClaudeLogsCache } from './provisioning/TeamProvisioningTranscriptClaudeLogs';
import {
  createTeamProvisioningTransientRunStatePorts,
  TeamProvisioningTransientRunState,
} from './provisioning/TeamProvisioningTransientRunState';
import { handleTeamProvisioningTurnComplete } from './provisioning/TeamProvisioningTurnComplete';
import {
  createTeamProvisioningTurnCompletePorts,
  type TeamProvisioningTurnCompleteServiceAdapter,
} from './provisioning/TeamProvisioningTurnCompletePortsFactory';
import {
  createTeamProvisioningVerificationProbePorts,
  type TeamProvisioningVerificationProbePorts,
} from './provisioning/TeamProvisioningVerificationProbePortsFactory';
import { prepareWorkspaceTrustForDeterministicRun as prepareWorkspaceTrustForDeterministicRunHelper } from './provisioning/TeamProvisioningWorkspaceTrust';
import { createNodeWorkspaceTrustWorkspaceCollectionPorts } from './provisioning/TeamProvisioningWorkspaceTrustNodePorts';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { atomicWriteAsync } from './atomicWrite';
import { peekAutoResumeService } from './AutoResumeService';
import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import { getConfiguredCliCommandLabel } from './cliFlavor';
import { boundLaunchDiagnostics } from './progressPayload';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import {
  choosePreferredLaunchSnapshot,
  clearBootstrapState,
  readBootstrapLaunchSnapshot,
  readBootstrapRuntimeState,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { writeTeamLaunchFailureArtifactPack } from './TeamLaunchFailureArtifactPack';
import { createPersistedLaunchSnapshot } from './TeamLaunchStateEvaluator';
import { TeamLaunchStateStore } from './TeamLaunchStateStore';
import { TeamMcpConfigBuilder } from './TeamMcpConfigBuilder';
import { TeamMemberLogsFinder } from './TeamMemberLogsFinder';
import { TeamMembersMetaStore } from './TeamMembersMetaStore';
import { TeamMemberWorktreeManager } from './TeamMemberWorktreeManager';
import { TeamMetaStore } from './TeamMetaStore';
import { TeamSentMessagesStore } from './TeamSentMessagesStore';
import { TeamTaskActivityIntervalService } from './TeamTaskActivityIntervalService';
import { TeamTaskReader } from './TeamTaskReader';
import { TeamTranscriptProjectResolver } from './TeamTranscriptProjectResolver';

import type {
  OpenCodeTeamRuntimeMessageInput,
  OpenCodeTeamRuntimeMessageResult,
  TeamLaunchRuntimeAdapter,
  TeamRuntimeAdapterRegistry,
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeMemberSpec,
  TeamRuntimeStopInput,
} from './runtime';
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
  CrossTeamSendResult,
  InboxMessage,
  LeadContextUsage,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  ProviderModelLaunchIdentity,
  RetryFailedOpenCodeSecondaryLanesResult,
  TaskRef,
  TeamAgentRuntimeSnapshot,
  TeamChangeEvent,
  TeamConfig,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamLaunchAggregateState,
  TeamLaunchDiagnosticItem,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamRuntimeState,
  ToolApprovalEvent,
  ToolApprovalSettings,
} from '@shared/types';

export { shouldAcceptDeterministicBootstrapEvent };

const logger = createLogger('Service:TeamProvisioning');
const {
  AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
  AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
  createController,
} = agentTeamsControllerModule;

const claudePermissionSettingsFilePorts: ClaudePermissionSettingsFilePorts = {
  mkdirRecursive: async (directoryPath) => {
    await fs.promises.mkdir(directoryPath, { recursive: true });
  },
  readFileUtf8: (filePath) => fs.promises.readFile(filePath, 'utf-8'),
  writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
};

function getRunRuntimeFailureLabel(run: ProvisioningRun): string {
  return getRuntimeFailureLabelForRequest(run.request);
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

export class TeamProvisioningService {
  private readonly runtimeLaneCoordinator = createTeamRuntimeLaneCoordinator();
  private readonly providerConnectionService = ProviderConnectionService.getInstance();
  private readonly launchIdentityBoundary: TeamProvisioningLaunchIdentityBoundary =
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
  private static readonly RECENT_CROSS_TEAM_DELIVERY_TTL_MS = 10 * 60 * 1000;
  private static readonly SAME_TEAM_NATIVE_DELIVERY_GRACE_MS = 15_000;
  private static readonly SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS = 60_000;
  private static readonly SAME_TEAM_MATCH_WINDOW_MS = 30_000;
  private static readonly SAME_TEAM_RUN_START_SKEW_MS = 1_000;
  private static readonly SAME_TEAM_PERSIST_RETRY_MS = 2_000;
  private static readonly RUNTIME_RESOURCE_TELEMETRY_CACHE_TTL_MS = 60_000;
  private static readonly RUNTIME_RESOURCE_TELEMETRY_FAILURE_CACHE_TTL_MS = 10_000;
  private static readonly RUNTIME_RESOURCE_SAMPLE_MIN_INTERVAL_MS = 30_000;
  private static readonly AGENT_RUNTIME_RESOURCE_HISTORY_LIMIT = 60;
  private static readonly MAX_RUNTIME_TREE_PIDS_PER_ROOT = 64;
  private static readonly MAX_RUNTIME_USAGE_PIDS_PER_SNAPSHOT = 512;
  private static readonly RUNTIME_PROCESS_TABLE_TIMEOUT_MS = 1_500;
  private static readonly RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS = 1_500;
  private static readonly RUNTIME_LIVENESS_PROCESS_TABLE_CACHE_TTL_MS = 5_000;
  private static readonly RUNTIME_LIVENESS_PROCESS_TABLE_FAILURE_CACHE_TTL_MS = 2_000;
  private static readonly RUNTIME_PROCESS_USAGE_CACHE_TTL_MS = 30_000;
  private static readonly RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES = 4_096;
  private static readonly RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS = 2_000;
  private static readonly RUNTIME_PIDUSAGE_SINGLE_TIMEOUT_MS = 750;
  private static readonly RUNTIME_PIDUSAGE_FALLBACK_CONCURRENCY = 16;
  private static readonly MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS = 500;
  private static readonly PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS = 5_000;
  private static readonly LAUNCH_STATE_NOOP_REFRESH_MS = 15_000;
  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly provisioningRunByTeam = new Map<string, string>();
  private readonly aliveRunByTeam = new Map<string, string>();
  private readonly runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
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
  private readonly runtimeAdapterRunByTeam = new Map<
    string,
    {
      runId: string;
      providerId: TeamProviderId;
      cwd?: string;
      members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
    }
  >();
  private readonly runTracking = new TeamProvisioningRunTrackingDeliveryHelper({
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
      hasAlivePersistedTeamProcess: (teamName) => this.hasAlivePersistedTeamProcess(teamName),
      hasOnlyExplicitlyStoppedPersistedTeamProcesses: (teamName) =>
        this.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName),
      logDebug: (message) => logger.debug(message),
    },
    liveRuntimeSnapshotCacheTtlMs: 2_000,
    persistedRuntimeSnapshotCacheTtlMs: 10_000,
  });
  private readonly cancelledRuntimeAdapterRunIds = new Set<string>();
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
        this.clearOpenCodeRuntimeToolApprovals(teamName, options),
    },
  });
  private readonly hasSecondaryRuntimeRuns = this.secondaryRuntimeRuns.hasSecondaryRuntimeRuns;
  private readonly getSecondaryRuntimeRuns = this.secondaryRuntimeRuns.getSecondaryRuntimeRuns;
  private readonly setSecondaryRuntimeRun = this.secondaryRuntimeRuns.setSecondaryRuntimeRun;
  private readonly deleteSecondaryRuntimeRun = this.secondaryRuntimeRuns.deleteSecondaryRuntimeRun;
  private readonly clearSecondaryRuntimeRuns = this.secondaryRuntimeRuns.clearSecondaryRuntimeRuns;
  private readonly runtimeStateProjection = new TeamProvisioningRuntimeStateProjection({
    state: {
      provisioningRunByTeam: this.provisioningRunByTeam,
      runs: this.runs,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      getRetainedProvisioningProgressMap: () =>
        this.retainedProvisioningProgressState.getRetainedProvisioningProgressMap(),
    },
    ports: {
      getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getAliveTeamNames: () => this.runTracking.getAliveTeamNames(),
      hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
      readBootstrapRuntimeState,
    },
  });
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  private readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  private readonly persistedTranscriptClaudeLogs: TeamProvisioningTranscriptClaudeLogsCache;
  private readonly bootstrapTranscriptOutcomePorts: TeamProvisioningBootstrapTranscriptOutcomePorts =
    createTeamProvisioningBootstrapTranscriptOutcomePorts({
      nowIso,
      isLookupCacheEnabled: (teamName) =>
        !this.runTracking.getTrackedRunId(teamName) && !this.runtimeAdapterRunByTeam.has(teamName),
      findMemberLogs: (teamName, memberName, sinceMs) =>
        this.memberLogsFinder.findMemberLogs(teamName, memberName, sinceMs),
      readConfigSnapshot: (teamName) => this.configFacade.readConfigSnapshot(teamName),
      readMetaMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      readRecentBootstrapTranscriptOutcome: (filePath, sinceMs, memberName, teamName, options) =>
        this.readRecentBootstrapTranscriptOutcome(filePath, sinceMs, memberName, teamName, options),
      readBootstrapTranscriptOutcomesInProjectRoot: (teamName, memberName, sinceMs) =>
        this.readBootstrapTranscriptOutcomesInProjectRoot(teamName, memberName, sinceMs),
    });

  private get parsedBootstrapTranscriptTailCache(): Map<
    string,
    ParsedBootstrapTranscriptTailCacheEntry
  > {
    return this.bootstrapTranscriptOutcomePorts.parsedBootstrapTranscriptTailCache;
  }

  private readonly teamOpLocks = new Map<string, Promise<void>>();
  private readonly shutdownCoordination = createTeamProvisioningShutdownCoordination(
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
        this.isCancellableRuntimeAdapterProgress(progress),
      stopTeam: (teamName) => this.stopTeam(teamName),
      cancelRuntimeAdapterProvisioning: (runId, progress) =>
        this.cancelRuntimeAdapterProvisioning(runId, progress),
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
    getAcceptedReportChecker: () => this.memberWorkSyncAcceptedReportChecker,
    getProofMissingRecoveryScheduler: () => this.memberWorkSyncProofMissingRecoveryScheduler,
    logger,
    getErrorMessage,
  });
  private readonly openCodeRuntimeDeliveryProofReader = new OpenCodeRuntimeDeliveryProofReader();
  private readonly openCodeRuntimeDeliveryAdvisory =
    new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory({
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId),
      readProofIndex: (input) => this.openCodeRuntimeDeliveryProofReader.readProofIndex(input),
      readConfigSnapshot: (teamName) => this.configFacade.readConfigSnapshot(teamName),
      addTeamNotification: async (notification) => {
        await NotificationManager.getInstance().addTeamNotification(notification);
      },
      emitTeamChange: (event) => {
        this.teamChangeEmitter?.(event);
      },
      invalidateMemberRuntimeAdvisory: (teamName, memberName) => {
        this.memberRuntimeAdvisoryInvalidator?.(teamName, memberName);
      },
      scheduleProofMissingWorkSyncRecovery: (input) =>
        this.memberWorkSyncProofMissingRecoveryScheduler?.(input),
      getLeadNoticeSink: (teamName) => {
        const runId = this.runTracking.getAliveRunId(teamName);
        const run = runId ? this.runs.get(runId) : null;
        if (!run || run.processKilled || run.cancelRequested) {
          return null;
        }
        if (run.child && !run.child.stdin?.writable) {
          return null;
        }
        return {
          send: (message) => this.sendMessageToRun(run, message),
        };
      },
      logInfo: (message, detail) =>
        detail === undefined ? logger.info(message) : logger.info(message, detail),
      logWarning: (message) => logger.warn(message),
      getErrorMessage,
    });
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
    createTeamProvisioningLiveLaunchSnapshotBoundary<ProvisioningRun>({
      getPersistedLaunchMemberNames,
      pauseMemberTaskActivityForRuntimeLoss: (run, memberName, previous, observedAt) =>
        this.pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt),
      buildMixedPersistedLaunchSnapshotForRun: (run, launchPhase) =>
        this.buildMixedPersistedLaunchSnapshotForRun(run, launchPhase),
      buildRuntimeSpawnStatusRecord: buildRuntimeSpawnStatusRecordHelper,
      invalidateMemberSpawnStatusesCache: (teamName) =>
        this.invalidateMemberSpawnStatusesCache(teamName),
      emitTeamChange: (event) => {
        this.teamChangeEmitter?.(event);
      },
      getRun: (runId) => this.runs.get(runId),
      maybeFireTeamLaunchedNotificationWhenAllMembersJoined: (run) =>
        this.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(run),
    });
  private readonly primaryBootstrapTruthReporting =
    createTeamProvisioningPrimaryBootstrapTruthReportingBoundary<ProvisioningRun>({
      service: {
        isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
          this.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
        syncMemberTaskActivityForRuntimeTransition: (run, memberName, previous, next, observedAt) =>
          this.syncMemberTaskActivityForRuntimeTransition(
            run,
            memberName,
            previous,
            next,
            observedAt
          ),
        syncMemberLaunchGraceCheck: (run, memberName, next) =>
          this.syncMemberLaunchGraceCheck(run, memberName, next),
        syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
          this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
      },
      readBootstrapLaunchSnapshot,
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        this.writeLaunchStateSnapshot(teamName, snapshot),
      nowIso,
      logger: {
        warn: (message) => logger.warn(message),
      },
    });
  private readonly openCodeVisibleReplyProofService: OpenCodeVisibleReplyProofService;
  private readonly openCodePromptDeliveryWatchdogCoordinator: OpenCodePromptDeliveryWatchdogCoordinator;
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
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      createRunId: randomUUID,
      getErrorMessage,
    });
  private readonly openCodeRuntimeLaneRecoveryFacade!: TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade;
  private readonly openCodeRuntimePermissionPersistencePorts: OpenCodeRuntimePendingPermissionsPersistencePorts =
    {
      nowIso,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      enqueueLaunchStateStoreOperation: (teamName, operation) =>
        this.enqueueLaunchStateStoreOperation(teamName, operation),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
      writeLaunchStateSnapshot: async (teamName, snapshot) => {
        await this.writeLaunchStateSnapshotNow(teamName, snapshot);
      },
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      emitMemberSpawnChange: (input) => {
        this.teamChangeEmitter?.({
          type: 'member-spawn',
          teamName: input.teamName,
          ...(input.runId ? { runId: input.runId } : {}),
          detail: input.memberName,
        });
      },
      logDebug: (message) => logger.debug(message),
    };
  private readonly openCodeRuntimePermissionSpawnStatusPorts: OpenCodeRuntimePermissionSpawnStatusPorts<ProvisioningRun> =
    {
      nowIso,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId) ?? null,
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      emitMemberSpawnChange: (run, memberName) => this.emitMemberSpawnChange(run, memberName),
      persistLaunchStateSnapshot: async (run, launchPhase) => {
        await this.persistLaunchStateSnapshot(run, launchPhase);
      },
    };
  private readonly memberSpawnStatusMutationPorts: MemberSpawnStatusMutationPorts<ProvisioningRun> =
    {
      nowIso,
      syncMemberTaskActivityForRuntimeTransition: (run, memberName, previous, next, observedAt) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          run,
          memberName,
          previous,
          next,
          observedAt
        ),
      syncMemberLaunchGraceCheck: (run, memberName, next) =>
        this.syncMemberLaunchGraceCheck(run, memberName, next),
      updateLaunchDiagnostics: (run) => {
        const launchDiagnostics = boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run));
        if (!launchDiagnostics) return;
        run.progress = {
          ...run.progress,
          updatedAt: nowIso(),
          launchDiagnostics,
        };
        run.onProgress(run.progress);
      },
      appendMemberBootstrapDiagnostic: (run, memberName, text) =>
        this.appendMemberBootstrapDiagnostic(run, memberName, text),
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      emitMemberSpawnChange: (run, memberName) => this.emitMemberSpawnChange(run, memberName),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
    };
  private readonly memberSpawnStatusAuditPorts: MemberSpawnStatusAuditPorts<ProvisioningRun> = {
    nowMs: () => Date.now(),
    minAuditIntervalMs: MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS,
    auditMemberSpawnStatuses: (run) => this.auditMemberSpawnStatuses(run),
    findBootstrapTranscriptFailureReason: (teamName, memberName, sinceMs) =>
      this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptFailureReason(
        teamName,
        memberName,
        sinceMs
      ),
    findBootstrapRuntimeProofObservedAt: (teamName, memberName, current) =>
      this.findBootstrapRuntimeProofObservedAt(teamName, memberName, current),
    findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
      this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptOutcome(
        teamName,
        memberName,
        sinceMs
      ),
    setMemberSpawnStatus: (run, memberName, status, error) =>
      this.setMemberSpawnStatus(run, memberName, status, error),
    confirmMemberSpawnStatusFromTranscript: (run, memberName, observedAt, source) =>
      this.confirmMemberSpawnStatusFromTranscript(run, memberName, observedAt, source),
    isOpenCodeSecondaryLaneMemberInRun: (run, memberName) =>
      this.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
  };
  private readonly openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal: (input) => this.markOpenCodePromptLedgerFailedTerminal(input),
    logEvent: (event, record, extra) => this.logOpenCodePromptDeliveryEvent(event, record, extra),
    scheduleWatchdog: (input) => this.scheduleOpenCodePromptDeliveryWatchdog(input),
    nowIso,
  });
  private readonly openCodePromptDeliveryWatchdogScheduler =
    new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: (teamName) =>
        this.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
      recoverBeforeDelivery: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input),
      relay: async (input) => {
        await this.relayOpenCodeMemberInboxMessages(input.teamName, input.memberName, {
          onlyMessageId: input.messageId,
          source: 'watchdog',
        });
      },
      getInboxMessages: (input) =>
        this.inboxReader.getMessagesFor(input.teamName, input.memberName),
      resolveIdentity: (input) =>
        this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          input.teamName,
          input.memberName
        ),
      isLaneActive: (input) =>
        this.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(
          input.teamName,
          input.laneId
        ),
      isRecordNotFoundError: (error) =>
        getErrorMessage(error).startsWith('OpenCode prompt delivery record not found:'),
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
      debug: (message) => logger.debug(message),
      getErrorMessage,
    });
  private readonly relayedMemberInboxMessageIds = new Map<string, Set<string>>();
  private readonly pendingCrossTeamFirstReplies = new Map<string, Map<string, number>>();
  private readonly recentCrossTeamLeadDeliveryMessageIds = new Map<string, Map<string, number>>();
  private readonly leadInboxRelayPortsBoundary =
    createTeamProvisioningLeadInboxRelayPortsBoundary<ProvisioningRun>({
      leadInboxRelayInFlight: this.leadInboxRelayInFlight,
      getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      getProvisioningRunId: (teamName) => this.runTracking.getProvisioningRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      readConfigForObservation: (teamName) => this.configFacade.readConfigForObservation(teamName),
      readLeadInboxMessages: (teamName, leadName) =>
        this.inboxReader.getMessagesFor(teamName, leadName),
      markInboxMessagesRead: (teamName, leadName, messages) =>
        this.markInboxMessagesRead(teamName, leadName, messages),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        this.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.refreshMemberSpawnStatusesFromLeadInbox(run),
      confirmSameTeamNativeMatches: (teamName, leadName, messages) =>
        this.confirmSameTeamNativeMatches(teamName, leadName, messages),
      scheduleSameTeamPersistRetry: (teamName) => this.scheduleSameTeamPersistRetry(teamName),
      scheduleSameTeamDeferredRetry: (teamName) => this.scheduleSameTeamDeferredRetry(teamName),
      resolveControlApiBaseUrl: () => this.providerRuntime.resolveControlApiBaseUrl(),
      sendMessageToRun: (run, message) => this.sendMessageToRun(run, message),
      hasAcceptedLeadWorkSyncReport: (input) =>
        this.memberWorkSyncProofBoundary.hasAcceptedLeadWorkSyncReport(input),
      scheduleLeadProofMissingWorkSyncRecovery: (input) =>
        this.memberWorkSyncProofBoundary.scheduleLeadProofMissingWorkSyncRecovery(input),
      pushLiveLeadTextMessage: (run, text, messageId, timestamp) =>
        this.pushLiveLeadTextMessage(run, text, messageId, timestamp),
      pushLiveLeadProcessMessage: (teamName, message) =>
        this.pushLiveLeadProcessMessage(teamName, message),
      persistSentMessage: (teamName, message) => this.persistSentMessage(teamName, message),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      scheduleLeadInboxFollowUpRelay: (teamName) => this.scheduleLeadInboxFollowUpRelay(teamName),
      relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
      trimRelayedSet: (relayedIds) => this.trimRelayedSet(relayedIds),
      pendingCrossTeamFirstReplies: this.pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      sameTeamRunStartSkewMs: TeamProvisioningService.SAME_TEAM_RUN_START_SKEW_MS,
      sameTeamNativeDeliveryGraceMs: TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS,
      recentCrossTeamDeliveryTtlMs: TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
      logger,
      getErrorMessage,
      nowIso,
      nowMs: () => Date.now(),
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      clearTimeout: (handle) => clearTimeout(handle),
    });
  private readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
  private readonly liveLeadMessagePortsBoundary =
    createTeamProvisioningLiveLeadMessagePortsBoundary<ProvisioningRun>({
      liveLeadProcessMessages: this.liveLeadProcessMessages,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      getRunLeadName: (run) => this.getRunLeadName(run),
      getCrossTeamSender: () => this.crossTeamSender,
      persistSentMessage: (teamName, message) => this.persistSentMessage(teamName, message),
      persistInboxMessage: (teamName, recipient, message) =>
        this.persistInboxMessage(teamName, recipient, message),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      logger,
      nowIso,
      nowMs: () => Date.now(),
      cacheLimit: LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
      leadTextEmitThrottleMs: LEAD_TEXT_EMIT_THROTTLE_MS,
    });
  private readonly sameTeamNativeDelivery: TeamProvisioningSameTeamNativeDelivery;
  private readonly agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >();
  private readonly runtimeResourceSampling = new TeamProvisioningRuntimeResourceSampling(
    {
      processTableTimeoutMs: TeamProvisioningService.RUNTIME_PROCESS_TABLE_TIMEOUT_MS,
      windowsProcessTableTimeoutMs:
        TeamProvisioningService.RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS,
      livenessProcessTableCacheTtlMs:
        TeamProvisioningService.RUNTIME_LIVENESS_PROCESS_TABLE_CACHE_TTL_MS,
      livenessProcessTableFailureCacheTtlMs:
        TeamProvisioningService.RUNTIME_LIVENESS_PROCESS_TABLE_FAILURE_CACHE_TTL_MS,
      resourceTelemetryCacheTtlMs: TeamProvisioningService.RUNTIME_RESOURCE_TELEMETRY_CACHE_TTL_MS,
      resourceTelemetryFailureCacheTtlMs:
        TeamProvisioningService.RUNTIME_RESOURCE_TELEMETRY_FAILURE_CACHE_TTL_MS,
      processUsageCacheTtlMs: TeamProvisioningService.RUNTIME_PROCESS_USAGE_CACHE_TTL_MS,
      processUsageCacheMaxEntries: TeamProvisioningService.RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES,
      pidusageBatchTimeoutMs: TeamProvisioningService.RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS,
      pidusageSingleTimeoutMs: TeamProvisioningService.RUNTIME_PIDUSAGE_SINGLE_TIMEOUT_MS,
      pidusageFallbackConcurrency: TeamProvisioningService.RUNTIME_PIDUSAGE_FALLBACK_CONCURRENCY,
      maxRuntimeTreePidsPerRoot: TeamProvisioningService.MAX_RUNTIME_TREE_PIDS_PER_ROOT,
      maxRuntimeUsagePidsPerSnapshot: TeamProvisioningService.MAX_RUNTIME_USAGE_PIDS_PER_SNAPSHOT,
      historyLimit: TeamProvisioningService.AGENT_RUNTIME_RESOURCE_HISTORY_LIMIT,
      minSampleIntervalMs: TeamProvisioningService.RUNTIME_RESOURCE_SAMPLE_MIN_INTERVAL_MS,
    },
    {
      getRuntimeSnapshotCacheGeneration: (teamName) =>
        this.getRuntimeSnapshotCacheGeneration(teamName),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
    },
    { logDebug: (message) => logger.debug(message) }
  );
  private readonly persistedTeamConfigCache = new Map<string, PersistedTeamConfigCacheEntry>();
  private readonly agentRuntimeSnapshotInFlightByTeam = new Map<
    string,
    {
      generationAtStart: number;
      runIdAtStart: string | null;
      promise: Promise<TeamAgentRuntimeSnapshot>;
    }
  >();
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
  private readonly configFacade!: TeamProvisioningConfigFacade;
  private readonly liveRuntimeMetadataPorts: ReturnType<
    typeof createTeamProvisioningLiveRuntimeMetadataPorts
  >;
  private readonly openCodeSecondaryEvidenceOverlayPorts =
    createTeamProvisioningOpenCodeSecondaryEvidenceOverlayPorts({
      getTeamsBasePath,
      nowIso,
    });
  private readonly launchStateStoreBoundary: TeamProvisioningLaunchStateStoreBoundary;
  private readonly taskActivityRepairBoundary!: TeamProvisioningTaskActivityRepairBoundary<ProvisioningRun>;
  private readonly failedOpenCodeSecondaryRetryInFlightByTeam = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly memberLifecycleHost = createTeamProvisioningMemberLifecycleHost<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >(
    this as unknown as TeamProvisioningMemberLifecycleHostFactoryService<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    >
  );
  private readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this.memberLifecycleHost
  );
  private readonly memberMcpLaunchConfigProvisioner: TeamProvisioningMemberMcpLaunchConfigProvisioner<ProvisioningRun>;
  private memberRuntimeAdvisoryInvalidator:
    | ((teamName: string, memberName: string) => void)
    | null = null;
  private memberWorkSyncProofMissingRecoveryScheduler: MemberWorkSyncProofMissingRecoveryScheduler | null =
    null;
  private memberWorkSyncAcceptedReportChecker: MemberWorkSyncAcceptedReportChecker | null = null;
  private readonly memberLogsFinder: TeamMemberLogsFinder;
  private readonly transcriptProjectResolver: TeamTranscriptProjectResolver;
  private readonly taskActivityIntervalService = new TeamTaskActivityIntervalService();
  private readonly runtimeToolActivity = createRuntimeToolActivityHandlers<ProvisioningRun>({
    isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
    emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    nowIso,
    logInfo: (message) => logger.info(message),
    logWarn: (message) => logger.warn(message),
    updateProgress,
    setMemberSpawnStatus: (run, memberName, status, error) =>
      this.setMemberSpawnStatus(run, memberName, status, error),
    invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
    reevaluateMemberLaunchStatus: (run, memberName) =>
      this.reevaluateMemberLaunchStatus(run, memberName),
    pauseActiveIntervalsForMember: (teamName, memberName, at) =>
      this.taskActivityIntervalService.pauseActiveIntervalsForMember(teamName, memberName, at),
    resumeActiveIntervalsForMember: (teamName, memberName, at) =>
      this.taskActivityIntervalService.resumeActiveIntervalsForMember(teamName, memberName, at),
  });
  private readonly leadTaskActivitySyncedRunKeys = new Set<string>();
  private teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  private readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly toolApprovalFacade: TeamProvisioningToolApprovalFacade<ProvisioningRun>;
  private readonly transientRunState: TeamProvisioningTransientRunState;
  private readonly cleanupRunPorts: TeamProvisioningCleanupPorts<ProvisioningRun>;
  private readonly idlePromptInjectionBoundary: TeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>;
  private readonly providerRuntime: TeamProvisioningProviderRuntimeFacade;
  private readonly outputRecoveryFacade: TeamProvisioningOutputRecoveryFacade<ProvisioningRun>;
  private readonly deterministicCreateSpawnFlowBoundary: TeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>;
  private readonly deterministicLaunchFlowBoundary: TeamProvisioningLaunchDeterministicFlowBoundary<MixedSecondaryRuntimeLaneState>;
  private readonly prepareFacade!: TeamProvisioningPrepareFacade;
  private readonly verificationProbePorts: TeamProvisioningVerificationProbePorts<ProvisioningRun>;
  private readonly processExitPorts: TeamProvisioningProcessExitPorts<ProvisioningRun>;
  private runtimeAdapterRegistry: TeamRuntimeAdapterRegistry | null = null;
  private controlApiBaseUrlResolver: (() => Promise<string | null>) | null = null;
  private workspaceTrustCoordinator: WorkspaceTrustCoordinator | null = null;
  private readonly workspaceTrustWorkspaceCollectionPorts =
    createNodeWorkspaceTrustWorkspaceCollectionPorts();
  private runtimeTurnSettledHookSettingsProvider: RuntimeTurnSettledHookSettingsProvider | null =
    null;
  private runtimeTurnSettledEnvironmentProvider: RuntimeTurnSettledEnvironmentProvider | null =
    null;
  private readonly stoppedTeamOpenCodeRuntimeCleanupInFlight = new Map<string, Promise<number>>();
  private readonly cleanedStoppedTeamOpenCodeRuntimeLanes = new Set<string>();
  private readonly openCodeMemberInboxRelayHost: TeamProvisioningOpenCodeMemberInboxRelayHost = {
    getOpenCodeMemberRelayKey: (teamName, memberName) =>
      this.getOpenCodeMemberRelayKey(teamName, memberName),
    scheduleOpenCodeMemberInboxDeliveryWake: (input) =>
      this.scheduleOpenCodeMemberInboxDeliveryWake(input),
    isOpenCodeRuntimeRecipient: (teamName, memberName) =>
      this.isOpenCodeRuntimeRecipient(teamName, memberName),
    createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
      this.createOpenCodePromptDeliveryLedger(teamName, laneId),
    requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
      this.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
    requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded: (input) =>
      this.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input),
    isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
      this.isOpenCodeDeliveryResponseReadCommitAllowed(input),
    markInboxMessagesRead: (teamName, memberName, messages) =>
      this.markInboxMessagesRead(teamName, memberName, messages),
    logOpenCodePromptDeliveryEvent: (event, record, extra) =>
      this.logOpenCodePromptDeliveryEvent(event, record, extra),
    markOpenCodePromptLedgerFailedTerminal: (input) =>
      this.markOpenCodePromptLedgerFailedTerminal(input),
    deliverOpenCodeMemberMessage: (teamName, input) =>
      this.deliverOpenCodeMemberMessage(teamName, input),
  };
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
  private readonly stopFlowBoundary = createTeamProvisioningStopFlowBoundary<ProvisioningRun>({
    getTeamsBasePath,
    getSecondaryRuntimeRuns: (teamName) => this.getSecondaryRuntimeRuns(teamName),
    stoppingSecondaryRuntimeTeams: this.stoppingSecondaryRuntimeTeams,
    getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
    readLaunchState: (teamName) => this.launchStateStore.read(teamName),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      this.writeLaunchStateSnapshot(teamName, snapshot),
    readPersistedTeamProjectPath: (teamName) =>
      this.configFacade.readPersistedTeamProjectPath(teamName),
    clearOpenCodeRuntimeLaneStorage,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      this.deleteSecondaryRuntimeRun(teamName, laneId),
    clearSecondaryRuntimeRuns: (teamName) => this.clearSecondaryRuntimeRuns(teamName),
    runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
    setRuntimeAdapterProgress: (progress) =>
      this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress),
    clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
      this.clearOpenCodeRuntimeToolApprovals(teamName, options),
    getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
    getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
    deleteAliveRunId: (teamName) => this.runTracking.deleteAliveRunId(teamName),
    runs: this.runs,
    provisioningRunByTeam: this.provisioningRunByTeam,
    invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
    pauseActiveIntervalsForTeam: (teamName) =>
      this.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
    stopPersistentTeamMembers: (teamName) => this.stopPersistentTeamMembers(teamName),
    openCodeRuntimeDeliveryAdvisory: this.openCodeRuntimeDeliveryAdvisory,
    isCancellableRuntimeAdapterProgress: (progress) =>
      this.isCancellableRuntimeAdapterProgress(progress),
    cancelRuntimeAdapterProvisioning: (runId, progress) =>
      this.cancelRuntimeAdapterProvisioning(runId, progress),
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
      this.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
    withTeamLock: (teamName, fn) => this.withTeamLock(teamName, fn),
    hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
    killTeamProcess,
    updateProgress,
    cleanupRun: (run) => this.cleanupRun(run),
    emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    logger,
    nowIso,
  });
  private readonly reevaluateMemberLaunchStatusBoundary =
    createTeamProvisioningReevaluateMemberLaunchStatusBoundary<ProvisioningRun>({
      nowIso,
      nowMs: () => Date.now(),
      service: {
        refreshMemberSpawnStatusesFromLeadInbox: (targetRun) =>
          this.refreshMemberSpawnStatusesFromLeadInbox(targetRun),
        maybeAuditMemberSpawnStatuses: (targetRun, options) =>
          this.maybeAuditMemberSpawnStatuses(targetRun, options),
        getLiveTeamAgentRuntimeMetadata: (teamName) =>
          this.getLiveTeamAgentRuntimeMetadata(teamName),
        isOpenCodeSecondaryLaneMemberInRun: (targetRun, targetMember) =>
          this.isOpenCodeSecondaryLaneMemberInRun(targetRun, targetMember),
        getOpenCodeBootstrapStallReconciliationPorts: () =>
          this.getOpenCodeBootstrapStallReconciliationPorts(),
        setMemberSpawnStatus: (targetRun, targetMember, status, error, livenessSource) =>
          this.setMemberSpawnStatus(targetRun, targetMember, status, error, livenessSource),
        emitMemberSpawnChange: (targetRun, targetMember) =>
          this.emitMemberSpawnChange(targetRun, targetMember),
        scheduleOpenCodeBootstrapStallReevaluation: (
          targetRun,
          targetMember,
          firstSpawnAcceptedAt
        ) =>
          this.scheduleOpenCodeBootstrapStallReevaluation(
            targetRun,
            targetMember,
            firstSpawnAcceptedAt
          ),
        syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
          this.syncMemberTaskActivityForRuntimeTransition(
            targetRun,
            targetMember,
            previous,
            next,
            at
          ),
      },
    });
  private readonly mixedSecondaryLaneWiring =
    createTeamProvisioningMixedSecondaryLaneWiring<ProvisioningRun>({
      service: {
        isStoppingSecondaryRuntimeTeam: (teamName) =>
          this.stoppingSecondaryRuntimeTeams.has(teamName),
        deleteSecondaryRuntimeRun: (teamName, laneId) =>
          this.deleteSecondaryRuntimeRun(teamName, laneId),
        getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
        publishMixedSecondaryLaneStatusChange: (run, lane) =>
          this.publishMixedSecondaryLaneStatusChange(run, lane),
        readLaunchState: (teamName) => this.launchStateStore.read(teamName),
        setSecondaryRuntimeRun: (input) => this.setSecondaryRuntimeRun(input),
        buildOpenCodeSecondaryAppManagedLaunchPrompt: (run, lane) =>
          this.buildOpenCodeSecondaryAppManagedLaunchPrompt(run, lane),
        guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
          this.guardCommittedOpenCodeSecondaryLaneEvidence(input),
        syncOpenCodeRuntimeToolApprovals: (input) => this.syncOpenCodeRuntimeToolApprovals(input),
        launchSingleMixedSecondaryLane: (run, lane) =>
          this.launchSingleMixedSecondaryLane(run, lane),
        persistLaunchStateSnapshot: (run, launchPhase) =>
          this.persistLaunchStateSnapshot(run, launchPhase),
        getMixedSecondaryLaunchPhase: (run) => this.getMixedSecondaryLaunchPhase(run),
        hasMixedSecondaryLaunchMetadata: (snapshot) =>
          this.hasMixedSecondaryLaunchMetadata(snapshot),
        shouldRecoverStalePersistedMixedLaunchSnapshot: (snapshot) =>
          this.shouldRecoverStalePersistedMixedLaunchSnapshot(snapshot),
        readTeamMeta: (teamName) => this.teamMetaStore.getMeta(teamName),
        readMembersMeta: (teamName) => this.membersMetaStore.getMeta(teamName),
        readPersistedTeamProjectPath: (teamName) =>
          this.configFacade.readPersistedTeamProjectPath(teamName),
        tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (input) =>
          this.openCodeRuntimeRecoveryBoundary.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(
            input
          ),
        tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (input) =>
          this.openCodeRuntimeRecoveryBoundary.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(
            input
          ),
        resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
          this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
        buildAggregateLaunchSnapshot: (input) =>
          this.runtimeLaneCoordinator.buildAggregateLaunchSnapshot(input),
        writeLaunchStateSnapshot: (teamName, snapshot) =>
          this.writeLaunchStateSnapshot(teamName, snapshot),
      },
      logger,
    });
  private readonly openCodeLaunchWiring =
    createTeamProvisioningOpenCodeLaunchWiring<ProvisioningRun>({
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      provisioningRunByTeam: this.provisioningRunByTeam,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      cancelledRuntimeAdapterRunIds: this.cancelledRuntimeAdapterRunIds,
      runs: this.runs,
      runtimeAdapterProgressState: this.runtimeAdapterProgressState,
      runTracking: this.runTracking,
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
      stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
        this.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
      hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
      stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.isCancellableRuntimeAdapterProgress(progress),
      cancelRuntimeAdapterProvisioning: (runId, progress) =>
        this.cancelRuntimeAdapterProvisioning(runId, progress),
      recordCancelledOpenCodeRuntimeAdapterLaunch: (teamName, sourceWarning, onProgress) =>
        this.recordCancelledOpenCodeRuntimeAdapterLaunch(teamName, sourceWarning, onProgress),
      resetTeamScopedTransientStateForNewRun: (teamName) =>
        this.resetTeamScopedTransientStateForNewRun(teamName),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      clearPersistedLaunchState: (teamName) => this.clearPersistedLaunchState(teamName),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      launchOpenCodeAggregatePrimaryLane: (input) => this.launchOpenCodeAggregatePrimaryLane(input),
      launchSingleMixedSecondaryLane: (run, lane) => this.launchSingleMixedSecondaryLane(run, lane),
      summarizeOpenCodeAggregateLaunchState: (input) =>
        this.summarizeOpenCodeAggregateLaunchState(input),
      persistLaunchStateSnapshot: (run, launchPhase) =>
        this.persistLaunchStateSnapshot(run, launchPhase),
      syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
        this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
        this.prepareFacade.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
      clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned: (teamName, runId) =>
        this.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(teamName, runId),
      persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
        this.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
      syncOpenCodeRuntimeToolApprovals: (syncInput) =>
        this.syncOpenCodeRuntimeToolApprovals(syncInput),
      emitTeamChange: (event) => {
        this.teamChangeEmitter?.(event);
      },
    });
  private crossTeamSender:
    | ((request: {
        fromTeam: string;
        fromMember: string;
        toTeam: string;
        text: string;
        summary?: string;
        messageId?: string;
        timestamp?: string;
        conversationId?: string;
        replyToConversationId?: string;
      }) => Promise<CrossTeamSendResult>)
    | null = null;
  private readonly openCodeRuntimeDeliveryBoundaryHost: TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun> =
    this.createOpenCodeRuntimeDeliveryBoundaryHost();

  constructor(
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly inboxReader: TeamInboxReader = new TeamInboxReader(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly sentMessagesStore: TeamSentMessagesStore = new TeamSentMessagesStore(),
    private readonly mcpConfigBuilder: TeamMcpConfigBuilder = new TeamMcpConfigBuilder(),
    private readonly teamMetaStore: TeamMetaStore = new TeamMetaStore(),
    private readonly inboxWriter: TeamInboxWriter = new TeamInboxWriter(),
    private readonly openCodeTaskLogAttributionStore: OpenCodeTaskLogAttributionStore = new OpenCodeTaskLogAttributionStore(),
    private readonly memberWorktreeManager: TeamMemberWorktreeManager = new TeamMemberWorktreeManager(),
    private readonly attachmentStore: TeamAttachmentStore = new TeamAttachmentStore()
  ) {
    this.configFacade = new TeamProvisioningConfigFacade({
      configReader: this.configReader,
      inboxReader: this.inboxReader,
      membersMetaStore: this.membersMetaStore,
      launchStateStore: this.launchStateStore,
      persistedTeamConfigCache: this.persistedTeamConfigCache,
      readBootstrapLaunchSnapshot,
      readRegularFileUtf8: tryReadRegularFileUtf8,
      logger,
    });
    this.openCodeRuntimeLaneRecoveryFacade = new TeamProvisioningOpenCodeRuntimeLaneRecoveryFacade(
      {
        runTracking: this.runTracking,
        cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
          this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
        launchStateStore: this.launchStateStore,
        openCodeRuntimeRecoveryBoundary: this.openCodeRuntimeRecoveryBoundary,
        readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
        resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
          this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
        readConfigForObservation: (teamName) =>
          this.configFacade.readConfigForObservation(teamName),
        teamMetaStore: this.teamMetaStore,
        membersMetaStore: this.membersMetaStore,
        readPersistedTeamProjectPath: (teamName) =>
          this.configFacade.readPersistedTeamProjectPath(teamName),
        openCodeRuntimeRecoveryIdentity: this.openCodeRuntimeRecoveryIdentity,
      },
      {
        getTeamsBasePath,
        logger,
      }
    );
    this.launchStateStoreBoundary = new TeamProvisioningLaunchStateStoreBoundary({
      launchStateStore: this.launchStateStore,
      membersMetaStore: this.membersMetaStore,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      applyOpenCodeSecondaryEvidenceOverlay: (params) =>
        this.applyOpenCodeSecondaryEvidenceOverlay(params),
      applyBootstrapStallOverlay: (snapshot) =>
        this.applyOpenCodeSecondaryBootstrapStallOverlay(snapshot),
      areSnapshotsSemanticallyEqual: areLaunchStateSnapshotsSemanticallyEqual,
      clearBootstrapState,
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      logDebug: (message) => logger.debug(message),
      nowMs: () => Date.now(),
      noopRefreshMs: TeamProvisioningService.LAUNCH_STATE_NOOP_REFRESH_MS,
    });
    this.taskActivityRepairBoundary =
      new TeamProvisioningTaskActivityRepairBoundary<ProvisioningRun>({
        taskActivityIntervalService: this.taskActivityIntervalService,
        runTracking: this.runTracking,
        runs: this.runs,
        readBootstrapLaunchSnapshot,
        readLaunchState: (teamName) => this.launchStateStore.read(teamName),
        choosePreferredLaunchSnapshot,
        artifactWriter: {
          write: writeTeamLaunchFailureArtifactPack,
        },
        buildLaunchDiagnosticsFromRun,
        extractCliLogsFromRun,
        getRuntimeAdapterTraceLines: (runId) => this.runtimeAdapterTraceLinesByRunId.get(runId),
        warn: (message) => logger.warn(message),
      });
    this.liveRuntimeMetadataPorts = createTeamProvisioningLiveRuntimeMetadataPorts({
      runs: this.runs,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      teamMetaStore: this.teamMetaStore,
      membersMetaStore: this.membersMetaStore,
      launchStateStore: this.launchStateStore,
      readConfigSnapshot: (targetTeamName) => this.configFacade.readConfigSnapshot(targetTeamName),
      readPersistedRuntimeMembers: (targetTeamName) =>
        this.configFacade.readPersistedRuntimeMembers(targetTeamName),
      liveTeamAgentRuntimeMetadataCache: this.liveTeamAgentRuntimeMetadataCache,
      cloneLiveTeamAgentRuntimeMetadata: (metadata) =>
        this.cloneLiveTeamAgentRuntimeMetadata(metadata),
      readRuntimeProcessRowsForLiveRuntimeMetadata: (input) =>
        this.runtimeResourceSampling.readRuntimeProcessRowsForLiveRuntimeMetadata(input),
      readWindowsHostProcessRowsForLiveRuntimeMetadata: (targetTeamName) =>
        this.runtimeResourceSampling.readWindowsHostProcessRowsForLiveRuntimeMetadata(
          targetTeamName
        ),
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.runTracking.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.runTracking.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      logDebug: (message) => logger.debug(message),
    });
    this.toolApprovalFacade = new TeamProvisioningToolApprovalFacade<ProvisioningRun>({
      logger,
      pendingTimeouts: this.pendingTimeouts,
      getRuns: () => this.runs.values(),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName) ?? undefined,
      getRun: (runId) => this.runs.get(runId),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
        this.persistOpenCodeRuntimeAdapterLaunchResult(result, input),
      deleteRuntimeAdapterRunByTeam: (teamName) => {
        this.runtimeAdapterRunByTeam.delete(teamName);
      },
      setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
        this.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
      },
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
        this.guardCommittedOpenCodeSecondaryLaneEvidence(input),
      publishMixedSecondaryLaneStatusChange: (run, lane) =>
        this.publishMixedSecondaryLaneStatusChange(run, lane),
      emitTeamChange: (event) => {
        this.teamChangeEmitter?.(event);
      },
      readConfigForStrictDecision: (teamName) =>
        this.configFacade.readConfigForStrictDecision(teamName),
      addPermissionRulesToSettings: (settingsPath, toolNames, behavior) =>
        this.addPermissionRulesToSettings(settingsPath, toolNames, behavior),
      persistInboxMessage: (teamName, recipient, message) =>
        this.persistInboxMessage(teamName, recipient, message),
      nowIso,
      nowMs: () => Date.now(),
      joinPath: (...parts) => path.join(...parts),
      teammateOperationalToolNames: AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
    });
    this.idlePromptInjectionBoundary =
      createTeamProvisioningIdlePromptInjectionBoundary<ProvisioningRun>({
        logger,
        service: {
          readConfigForObservation: (teamName) =>
            this.configFacade.readConfigForObservation(teamName),
          setLeadActivity: (run, state) => this.setLeadActivity(run, state),
          resetRuntimeToolActivity: (run, memberName) =>
            this.resetRuntimeToolActivity(run, memberName),
          getRunLeadName: (run) => this.getRunLeadName(run),
        },
      });
    this.providerRuntime = createTeamProvisioningProviderRuntimeFacade({
      diagnosticsRuntimeInput: {
        transientProbeProcesses: this.transientProbeProcesses,
        providerConnectionService: this.providerConnectionService,
        logger,
        isAuthFailureWarning,
        normalizeApiRetryErrorMessage,
      },
      envRuntimePorts: createTeamProvisioningEnvRuntimePorts({
        providerConnectionService: this.providerConnectionService,
        getControlApiBaseUrlResolver: () => this.controlApiBaseUrlResolver,
        getRuntimeTurnSettledEnvironmentProvider: () => this.runtimeTurnSettledEnvironmentProvider,
        getRuntimeTurnSettledHookSettingsProvider: () =>
          this.runtimeTurnSettledHookSettingsProvider,
        logger,
      }),
    });
    this.outputRecoveryFacade = new TeamProvisioningOutputRecoveryFacade<ProvisioningRun>({
      service: {
        updateProgress,
        emitLogsProgress,
        killTeamProcess,
        cleanupRun: (run) => this.cleanupRun(run),
        appendCliLogs: (run, stream, text) => this.appendCliLogs(run, stream, text),
        handleStreamJsonMessage: (run, msg) => this.handleStreamJsonMessage(run, msg),
        shiftProvisioningOutputIndexesAfterRemoval: (run, removedIndex) =>
          this.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex),
        getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
        stopFilesystemMonitor: (run) => this.stopFilesystemMonitor(run),
        startFilesystemMonitor: (run, request) => this.startFilesystemMonitor(run, request),
        tryCompleteAfterTimeout: (run) => this.tryCompleteAfterTimeout(run),
        handleProcessExit: (run, code) => this.handleProcessExit(run, code),
      },
      logger,
      mcpConfigBuilder: this.mcpConfigBuilder,
      providerRuntime: this.providerRuntime,
      killTeamProcess,
      updateProgress,
      nowIso,
    });
    const deterministicLaunchFlowHost: TeamProvisioningLaunchDeterministicFlowHost<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    > = {
      runTracking: {
        getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      },
      runs: this.runs,
      provisioningRunByTeam: this.provisioningRunByTeam,
      getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
      providerRuntime: this.providerRuntime,
      getWorkspaceTrustCoordinator: () => this.workspaceTrustCoordinator,
      workspaceTrustWorkspaceCollectionPorts: this.workspaceTrustWorkspaceCollectionPorts,
      getRuntimeTurnSettledEnvironmentProvider: () => this.runtimeTurnSettledEnvironmentProvider,
      mcpConfigBuilder: this.mcpConfigBuilder,
      teamMetaStore: this.teamMetaStore,
      membersMetaStore: this.membersMetaStore,
      getRunTrackedCwd: (run) => this.getRunTrackedCwd(run),
      materializeLaunchCompatibilityRepair: (launchRequest, report) =>
        this.configFacade.materializeLaunchCompatibilityRepair(launchRequest, report),
      normalizeTeamConfigForLaunch: (teamName, configRaw) =>
        this.configFacade.normalizeTeamConfigForLaunch(teamName, configRaw),
      assertConfigLeadOnlyForLaunch: (teamName) =>
        this.configFacade.assertConfigLeadOnlyForLaunch(teamName),
      updateConfigProjectPath: (teamName, cwd) =>
        this.configFacade.updateConfigProjectPath(teamName, cwd),
      restorePrelaunchConfig: (teamName) => this.configFacade.restorePrelaunchConfig(teamName),
      materializeEffectiveTeamMemberSpecs: (params) =>
        this.prepareFacade.materializeEffectiveTeamMemberSpecs(params),
      resolveOpenCodeMemberWorkspacesForRuntime: (params) =>
        this.prepareFacade.resolveOpenCodeMemberWorkspacesForRuntime(params),
      planRuntimeLanesOrThrow: (leadProviderId, members, baseCwd) =>
        this.planRuntimeLanesOrThrow(leadProviderId, members, baseCwd),
      createMixedSecondaryLaneStates: (lanePlan) => this.createMixedSecondaryLaneStates(lanePlan),
      resolveAndValidateLaunchIdentity: (params) => this.resolveAndValidateLaunchIdentity(params),
      prepareWorkspaceTrustForDeterministicRun: (input) =>
        this.prepareWorkspaceTrustForDeterministicRun(input),
      resetTeamScopedTransientStateForNewRun: (teamName) =>
        this.resetTeamScopedTransientStateForNewRun(teamName),
      clearPersistedLaunchState: (teamName, options) =>
        this.clearPersistedLaunchState(teamName, options),
      publishMixedSecondaryLaneStatusChange: (run, lane) =>
        this.publishMixedSecondaryLaneStatusChange(run, lane),
      buildRuntimeBootstrapMemberMcpLaunchConfigs: (input) =>
        this.buildRuntimeBootstrapMemberMcpLaunchConfigs(input),
      buildTeamRuntimeLaunchArgsPlan: (input) => this.buildTeamRuntimeLaunchArgsPlan(input),
      seedLeadBootstrapPermissionRules: (teamName, cwd) =>
        this.seedLeadBootstrapPermissionRules(teamName, cwd),
      attachStdoutHandler: (run) => this.outputRecoveryFacade.attachStdoutHandler(run),
      attachStderrHandler: (run) => this.outputRecoveryFacade.attachStderrHandler(run),
      startStallWatchdog: (run) => this.outputRecoveryFacade.startStallWatchdog(run),
      tryCompleteAfterTimeout: (run) => this.tryCompleteAfterTimeout(run),
      cleanupRun: (run) => this.cleanupRun(run),
      handleProcessExit: (run, code) => this.handleProcessExit(run, code),
      removeRunMemberMcpConfigFiles: (run) => this.removeRunMemberMcpConfigFiles(run),
    };
    this.deterministicLaunchFlowBoundary = createTeamProvisioningLaunchDeterministicFlowBoundary<
      ProvisioningRun,
      MixedSecondaryRuntimeLaneState
    >({
      host: deterministicLaunchFlowHost,
      launchExpectedMembersPorts: this.configFacade.launchExpectedMembersPorts,
      createInitialMemberSpawnStatusEntry,
      randomUUID,
      nowIso,
      logger,
      spawnCli,
      updateProgress,
      setTimeout: (callback, ms) => setTimeout(callback, ms),
      killTeamProcess,
    });
    this.deterministicCreateSpawnFlowBoundary =
      createTeamProvisioningCreateDeterministicSpawnFlowBoundary<ProvisioningRun>({
        teamMetaStore: {
          writeMeta: (teamName, payload) =>
            this.teamMetaStore.writeMeta(teamName, {
              ...payload,
              launchIdentity: payload.launchIdentity ?? undefined,
            }),
          deleteMeta: (teamName) => this.teamMetaStore.deleteMeta(teamName),
        },
        membersMetaStore: this.membersMetaStore,
        mcpConfigBuilder: this.mcpConfigBuilder,
        buildMemberMcpLaunchConfigs: (input) =>
          this.buildRuntimeBootstrapMemberMcpLaunchConfigs(input),
        validateAgentTeamsMcpRuntime: ({ claudePath, cwd, shellEnv, mcpConfigPath, options }) =>
          this.providerRuntime.validateAgentTeamsMcpRuntime(
            claudePath,
            cwd,
            shellEnv,
            mcpConfigPath,
            options
          ),
        buildTeamRuntimeLaunchArgsPlan: (input) => this.buildTeamRuntimeLaunchArgsPlan(input),
        seedLeadBootstrapPermissionRules: (teamName, cwd) =>
          this.seedLeadBootstrapPermissionRules(teamName, cwd),
        spawnCli,
        updateProgress,
        attachStdoutHandler: (run) => this.outputRecoveryFacade.attachStdoutHandler(run),
        attachStderrHandler: (run) => this.outputRecoveryFacade.attachStderrHandler(run),
        startStallWatchdog: (run) => this.outputRecoveryFacade.startStallWatchdog(run),
        startFilesystemMonitor: (run, request) => this.startFilesystemMonitor(run, request),
        tryCompleteAfterTimeout: (run) => this.tryCompleteAfterTimeout(run),
        handleProcessExit: (run, code) => this.handleProcessExit(run, code),
        killTeamProcess,
        cleanupRun: (run) => this.cleanupRun(run),
        removeRunMemberMcpConfigFiles: (run) => this.removeRunMemberMcpConfigFiles(run),
        deleteRun: (runId) => {
          this.runs.delete(runId);
        },
        deleteProvisioningRunByTeam: (teamName) => {
          this.provisioningRunByTeam.delete(teamName);
        },
        getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
      });
    this.verificationProbePorts = createTeamProvisioningVerificationProbePorts<ProvisioningRun>({
      service: {
        persistMembersMeta: (teamName, request) =>
          this.configFacade.persistMembersMeta(teamName, request),
        updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
          this.configFacade.updateConfigPostLaunch(
            teamName,
            cwd,
            detectedSessionId,
            color,
            options
          ),
        refreshMemberSpawnStatusesFromLeadInbox: (run) =>
          this.refreshMemberSpawnStatusesFromLeadInbox(run),
        maybeAuditMemberSpawnStatuses: (run, options) =>
          this.maybeAuditMemberSpawnStatuses(run, options),
        finalizeMissingRegisteredMembersAsFailed: (run) =>
          this.finalizeMissingRegisteredMembersAsFailed(run),
        persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
        cleanupRun: (run) => this.cleanupRun(run),
      },
      listTeams: () => this.configReader.listTeams(),
      getTeamsBasePath,
      readRegularFileUtf8: tryReadRegularFileUtf8,
      updateProgress,
      verifyTimeoutMs: VERIFY_TIMEOUT_MS,
      verifyPollMs: VERIFY_POLL_MS,
      teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
      sleep,
    });
    this.processExitPorts = createTeamProvisioningProcessExitPorts<ProvisioningRun>({
      service: {
        buildStdoutCarryDiagnostic: (run) =>
          this.outputRecoveryFacade.buildStdoutCarryDiagnostic(run),
        flushStdoutParserCarry: (run) => this.outputRecoveryFacade.flushStdoutParserCarry(run),
        stopStallWatchdog: (run) => this.outputRecoveryFacade.stopStallWatchdog(run),
        hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
        stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
        persistMembersMeta: (teamName, request) =>
          this.configFacade.persistMembersMeta(teamName, request),
        finalizeIncompleteLaunchStateBeforeCleanup: (run, fallbackReason) =>
          this.finalizeIncompleteLaunchStateBeforeCleanup(run, fallbackReason),
        cleanupRun: (run) => this.cleanupRun(run),
      },
      verificationProbePorts: this.verificationProbePorts,
      logger,
      updateProgress,
      getTeamsBasePath,
      getAutoDetectedClaudeBasePath,
      getConfiguredCliCommandLabel,
      getRunRuntimeFailureLabel,
      getVerificationTimeoutMs: () => VERIFY_TIMEOUT_MS,
      extractCliLogsFromRun,
      logsSuggestShutdownOrCleanup,
    });
    this.prepareFacade = new TeamProvisioningPrepareFacade({
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      buildProvisioningEnv: (providerId, providerBackendId, options) =>
        this.providerRuntime.buildProvisioningEnv(providerId, providerBackendId, options),
      runProviderOneShotDiagnostic: (claudePath, cwd, env, providerId, providerArgs) =>
        this.providerRuntime.runProviderOneShotDiagnostic(
          claudePath,
          cwd,
          env,
          providerId,
          providerArgs
        ),
      readRuntimeProviderLaunchFacts: (params) => this.readRuntimeProviderLaunchFacts(params),
      resolveClaudeBinaryPath: () => ClaudeBinaryResolver.resolve(),
      probeClaudeRuntime: (claudePath, cwd, env, providerId, providerArgs) =>
        this.providerRuntime.probeClaudeRuntime(claudePath, cwd, env, providerId, providerArgs),
      ensureMemberWorktree: (input) => this.memberWorktreeManager.ensureMemberWorktree(input),
      execCli,
      planRuntimeLanesOrThrow: (leadProviderId, members, baseCwd) =>
        this.planRuntimeLanesOrThrow(leadProviderId, members, baseCwd),
      info: (message) => logger.info(message),
      warn: (message) => logger.warn(message),
    });
    this.memberMcpLaunchConfigProvisioner = new TeamProvisioningMemberMcpLaunchConfigProvisioner({
      mcpConfigBuilder: this.mcpConfigBuilder,
      ensureCwdExists,
      resolveControlApiBaseUrl: () => this.providerRuntime.resolveControlApiBaseUrl(),
      getAliveRun: (teamName) => {
        const runId = this.runTracking.getAliveRunId(teamName);
        return runId ? this.runs.get(runId) : undefined;
      },
    });
    this.openCodeVisibleReplyProofService = new OpenCodeVisibleReplyProofService({
      inboxReader: this.inboxReader,
      inboxWriter: this.inboxWriter,
      getConfiguredLeadName: async (teamName) =>
        this.configFacade
          .readConfigForObservation(teamName)
          .then(
            (config) =>
              config?.members?.find((member) => isLeadMember(member))?.name?.trim() || null
          )
          .catch(() => null),
      emitRuntimeDeliveryReplyAdvisoryRefresh: (teamName, message) =>
        this.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message),
      warn: (message) => logger.warn(message),
      getErrorMessage,
      nowIso,
    });
    this.openCodePromptDeliveryWatchdogCoordinator =
      createOpenCodePromptDeliveryWatchdogCoordinator({
        hasAcceptedMemberWorkSyncReport: (input) =>
          this.memberWorkSyncProofBoundary.hasAcceptedMemberWorkSyncReport(input),
        taskRefsIncludeAll: openCodeTaskRefsIncludeAllValue,
        visibleReplyProofService: this.openCodeVisibleReplyProofService,
        maybeSyncRuntimePermissionsAfterDelivery: (input) =>
          this.maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input),
        rememberRuntimePidFromBridge: (input) => this.rememberOpenCodeRuntimePidFromBridge(input),
        watchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
        canDeliverToTeamRuntime: (teamName) =>
          this.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
        recoverRuntimeLanesForWatchdog: (teamName, options) =>
          this.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(teamName, options),
        stopRuntimeLanesForStoppedTeam: (teamName) =>
          this.stopOpenCodeRuntimeLanesForStoppedTeam(teamName),
        readActiveRuntimeLaneIds: async (teamName) => {
          const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
            () => null
          );
          if (!laneIndex) {
            return null;
          }
          return Object.values(laneIndex.lanes)
            .filter((lane) => lane.state === 'active')
            .map((lane) => lane.laneId);
        },
        createLedger: (teamName, laneId) =>
          this.createOpenCodePromptDeliveryLedger(teamName, laneId),
        resolveMembersForRuntimeLane: (teamName, laneId) =>
          this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMembersForRuntimeLane(
            teamName,
            laneId
          ),
        getInboxMessages: (teamName, memberName) =>
          this.inboxReader.getMessagesFor(teamName, memberName),
        resolveCurrentRuntimeRunId: (teamName, laneId) =>
          this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
        hasStableInboxMessageId,
        logPromptDeliveryEvent: (event, record, extra) =>
          this.logOpenCodePromptDeliveryEvent(event, record, extra),
        info: (message, context) =>
          context === undefined ? logger.info(message) : logger.info(message, context),
        warn: (message) => logger.warn(message),
        nowIso,
        sleep,
        getErrorMessage,
      });
    this.memberLogsFinder = new TeamMemberLogsFinder(
      this.configReader,
      this.inboxReader,
      this.membersMetaStore
    );
    this.transcriptProjectResolver = new TeamTranscriptProjectResolver({
      getConfig: (teamName) => this.configReader.getConfigSnapshot(teamName),
    });
    this.persistedTranscriptClaudeLogs = new TeamProvisioningTranscriptClaudeLogsCache({
      getContext: (teamName) => this.transcriptProjectResolver.getContext(teamName),
    });
    this.sameTeamNativeDelivery = new TeamProvisioningSameTeamNativeDelivery(
      {
        fingerprintTtlMs: TeamProvisioningService.SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS,
        matchWindowMs: TeamProvisioningService.SAME_TEAM_MATCH_WINDOW_MS,
        nativeDeliveryGraceMs: TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS,
        persistRetryMs: TeamProvisioningService.SAME_TEAM_PERSIST_RETRY_MS,
      },
      createTeamProvisioningSameTeamNativeDeliveryPorts({
        inboxReader: this.inboxReader,
        relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
        pendingTimeouts: this.pendingTimeouts,
        markInboxMessagesRead: (teamName, leadName, messages) =>
          this.markInboxMessagesRead(teamName, leadName, messages),
        relayLeadInboxMessages: (teamName) => this.relayLeadInboxMessages(teamName),
        trimRelayedSet: (set) => this.trimRelayedSet(set),
        warn: (message) => logger.warn(message),
      })
    );
    this.cleanupRunPorts = createTeamProvisioningCleanupRunPorts({
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      isRunIdTracked: (runId) =>
        this.runs.has(runId) || this.runtimeAdapterProgressByRunId.has(runId),
      markIncompleteLaunchStateFinalized: (run, cleanupReason) =>
        this.markIncompleteLaunchStateFinalized(run, cleanupReason),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      writeLaunchFailureArtifactPackBestEffort: (run, options) =>
        this.writeLaunchFailureArtifactPackBestEffort(run, options),
      resetRuntimeToolActivity: (run) => this.resetRuntimeToolActivity(run),
      setLeadActivity: (run, state) => this.setLeadActivity(run, state),
      stopStallWatchdog: (run) => this.outputRecoveryFacade.stopStallWatchdog(run),
      stopFilesystemMonitor: (run) => this.stopFilesystemMonitor(run),
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      deleteAliveRunId: (teamName) => this.runTracking.deleteAliveRunId(teamName),
      clearSecondaryRuntimeRuns: (teamName) => this.clearSecondaryRuntimeRuns(teamName),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      invalidateMemberSpawnStatusesCache: (teamName) =>
        this.invalidateMemberSpawnStatusesCache(teamName),
      leadInboxRelayInFlight: this.leadInboxRelayInFlight,
      relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
      pendingCrossTeamFirstReplies: this.pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      recentSameTeamNativeFingerprints: this.sameTeamNativeDelivery,
      clearSameTeamRetryTimers: (teamName) => this.clearSameTeamRetryTimers(teamName),
      clearLeadInboxFollowUpRelayTimer: (teamName) =>
        this.clearLeadInboxFollowUpRelayTimer(teamName),
      getMemberLaunchGraceKey: (run, memberName) => this.getMemberLaunchGraceKey(run, memberName),
      pendingTimeouts: this.pendingTimeouts,
      memberInboxRelayInFlight: this.memberInboxRelayInFlight,
      openCodeMemberInboxRelayInFlight: this.openCodeMemberInboxRelayInFlight,
      openCodeMemberSendInFlightByLane: this.openCodeMemberSendInFlightByLane,
      openCodePromptDeliveryWatchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
      openCodeRuntimeDeliveryAdvisory: this.openCodeRuntimeDeliveryAdvisory,
      relayedMemberInboxMessageIds: this.relayedMemberInboxMessageIds,
      liveLeadProcessMessages: this.liveLeadProcessMessages,
      pruneLiveLeadMessagesForCleanedRun: (run) => this.pruneLiveLeadMessagesForCleanedRun(run),
      clearApprovalTimeout: (requestId) => this.clearApprovalTimeout(requestId),
      inFlightResponses: this.toolApprovalFacade.inFlightResponsesForCleanup,
      dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
      emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
      mcpConfigBuilder: this.mcpConfigBuilder,
      removeRunMemberMcpConfigFilesLater: (run) => this.removeRunMemberMcpConfigFilesLater(run),
      retainedClaudeLogsByTeam: this.retainedClaudeLogsByTeam,
      retainProvisioningProgress: (runId, progress) =>
        this.retainProvisioningProgress(runId, progress),
      runs: this.runs,
    });
    this.transientRunState = new TeamProvisioningTransientRunState(
      createTeamProvisioningTransientRunStatePorts({
        pendingTimeouts: this.pendingTimeouts,
        teamOpLocks: this.teamOpLocks,
        cancelPendingAutoResume: (teamName) =>
          peekAutoResumeService()?.cancelPendingAutoResume(teamName),
        clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
          this.clearOpenCodeRuntimeToolApprovals(teamName, options),
        invalidateRuntimeSnapshotCaches: (teamName) =>
          this.invalidateRuntimeSnapshotCaches(teamName),
        clearRuntimeProcessRowsForTeam: (teamName) =>
          this.runtimeResourceSampling.clearRuntimeProcessRowsForTeam(teamName),
        retainedClaudeLogsByTeam: this.retainedClaudeLogsByTeam,
        persistedTranscriptClaudeLogs: this.persistedTranscriptClaudeLogs,
        leadInboxRelayInFlight: this.leadInboxRelayInFlight,
        relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
        pendingCrossTeamFirstReplies: this.pendingCrossTeamFirstReplies,
        recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
        recentSameTeamNativeFingerprints: this.sameTeamNativeDelivery,
        memberInboxRelayInFlight: this.memberInboxRelayInFlight,
        openCodeMemberInboxRelayInFlight: this.openCodeMemberInboxRelayInFlight,
        openCodeMemberSendInFlightByLane: this.openCodeMemberSendInFlightByLane,
        openCodePromptDeliveryWatchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
        openCodeRuntimeDeliveryAdvisory: this.openCodeRuntimeDeliveryAdvisory,
        relayedMemberInboxMessageIds: this.relayedMemberInboxMessageIds,
        liveLeadProcessMessages: this.liveLeadProcessMessages,
        relayLeadInboxMessages: (teamName) => this.relayLeadInboxMessages(teamName),
        warn: (message) => logger.warn(message),
      })
    );
    this.scheduleStaleAnthropicTeamApiKeyHelperCleanup();
  }

  buildOpenCodeRuntimeDeliveryUserVisibleImpact(
    input: Parameters<typeof buildOpenCodeRuntimeDeliveryUserVisibleImpact>[0]
  ): OpenCodeRuntimeDeliveryUserVisibleImpact {
    return buildOpenCodeRuntimeDeliveryUserVisibleImpact(input);
  }

  private scheduleOpenCodePromptLedgerFollowUp(
    input: Parameters<OpenCodePromptDeliveryFollowUpPolicy['schedule']>[0]
  ): ReturnType<OpenCodePromptDeliveryFollowUpPolicy['schedule']> {
    return this.openCodePromptDeliveryFollowUpPolicy.schedule(input);
  }

  private isOpenCodeSessionRefreshRetryRecord(
    ...args: Parameters<typeof isOpenCodeSessionRefreshRetryRecord>
  ): ReturnType<typeof isOpenCodeSessionRefreshRetryRecord> {
    return isOpenCodeSessionRefreshRetryRecord(...args);
  }

  private findOpenCodeVisibleReplyByRelayOfMessageId(
    input: Parameters<OpenCodeVisibleReplyProofService['findByRelayOfMessageId']>[0]
  ): ReturnType<OpenCodeVisibleReplyProofService['findByRelayOfMessageId']> {
    return this.openCodeVisibleReplyProofService.findByRelayOfMessageId(input);
  }

  private handleDeterministicBootstrapEvent(
    run: ProvisioningRun,
    msg: Record<string, unknown>
  ): ReturnType<typeof handleDeterministicBootstrapEvent> {
    return handleDeterministicBootstrapEvent(run, msg, this.getStreamJsonEventPorts());
  }

  private repairStaleTaskActivityIntervalsOnce(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return this.taskActivityRepairBoundary.repairStaleTaskActivityIntervalsOnce(
      teamName,
      launchSnapshot
    );
  }

  private async readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.taskActivityRepairBoundary.readTaskActivityRepairLaunchSnapshot(teamName);
  }

  private writeLaunchFailureArtifactPackBestEffort(
    run: ProvisioningRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void {
    this.taskActivityRepairBoundary.writeLaunchFailureArtifactPackBestEffort(run, options);
  }

  async repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    return this.taskActivityRepairBoundary.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName);
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

  private getRuntimeSnapshotCacheGeneration(teamName: string): number {
    return this.runtimeSnapshotCacheBoundary.getRuntimeSnapshotCacheGeneration(teamName);
  }

  private getMemberSpawnStatusesCacheGeneration(teamName: string): number {
    return this.runtimeSnapshotCacheBoundary.getMemberSpawnStatusesCacheGeneration(teamName);
  }

  private invalidateMemberSpawnStatusesCache(teamName: string): void {
    this.runtimeSnapshotCacheBoundary.invalidateMemberSpawnStatusesCache(teamName);
  }

  private invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.runtimeSnapshotCacheBoundary.invalidateRuntimeSnapshotCaches(teamName);
  }

  private createMemberSpawnStatusesSnapshotPorts() {
    return createTeamProvisioningMemberSpawnStatusesSnapshotPortsBoundary<ProvisioningRun>({
      runs: this.runs,
      cache: {
        snapshotCache: this.memberSpawnStatusesSnapshotCache,
        inFlightByTeam: this.memberSpawnStatusesInFlightByTeam,
      },
      getCacheGeneration: (teamName) => this.getMemberSpawnStatusesCacheGeneration(teamName),
      runTracking: this.runTracking,
      ttl: {
        liveCacheTtlMs: TeamProvisioningService.MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
        persistedCacheTtlMs:
          TeamProvisioningService.PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
      },
      readTaskActivityRepairLaunchSnapshot: (teamName) =>
        this.readTaskActivityRepairLaunchSnapshot(teamName),
      repairStaleTaskActivityIntervalsOnce: (teamName, launchSnapshot) =>
        this.repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot),
      reconcilePersistedLaunchState: (teamName) => this.reconcilePersistedLaunchState(teamName),
      attachLiveRuntimeMetadataToStatuses: (teamName, statuses, options) =>
        this.attachLiveRuntimeMetadataToStatuses(teamName, statuses, options),
      getOpenCodeSecondaryBootstrapPendingMemberNames: (snapshot) =>
        this.getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot),
      taskActivityIntervalService: this.taskActivityIntervalService,
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run) => this.maybeAuditMemberSpawnStatuses(run),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      launchStateStore: this.launchStateStore,
      syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
        this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
      buildLiveLaunchSnapshotForRun: (run, phase) => this.buildLiveLaunchSnapshotForRun(run, phase),
      buildRuntimeSpawnStatusRecord: buildRuntimeSpawnStatusRecordHelper,
      membersMetaStore: this.membersMetaStore,
      filterRemovedMembersFromLaunchSnapshot: (snapshot, metaMembers) =>
        filterRemovedMembersFromLaunchSnapshot(
          snapshot,
          metaMembers,
          getPersistedLaunchMemberNames(snapshot)
        ),
      getPersistedLaunchMemberNames,
      nowMs: () => Date.now(),
      nowIso,
    });
  }

  private cloneLiveTeamAgentRuntimeMetadata(
    metadata: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>
  ): Map<string, LiveTeamAgentRuntimeMetadata> {
    return new Map(
      [...metadata.entries()].map(([memberName, entry]) => [
        memberName,
        {
          ...entry,
          ...(entry.diagnostics ? { diagnostics: [...entry.diagnostics] } : {}),
        },
      ])
    );
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

  setRuntimeAdapterRegistry(registry: TeamRuntimeAdapterRegistry | null): void {
    this.runtimeAdapterRegistry = registry;
  }

  setMemberRuntimeAdvisoryInvalidator(
    invalidator: ((teamName: string, memberName: string) => void) | null
  ): void {
    this.memberRuntimeAdvisoryInvalidator = invalidator;
  }

  setMemberWorkSyncProofMissingRecoveryScheduler(
    scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null
  ): void {
    this.memberWorkSyncProofMissingRecoveryScheduler = scheduler;
  }

  setMemberWorkSyncAcceptedReportChecker(
    checker: MemberWorkSyncAcceptedReportChecker | null
  ): void {
    this.memberWorkSyncAcceptedReportChecker = checker;
  }

  setCrossTeamSender(
    sender:
      | ((request: {
          fromTeam: string;
          fromMember: string;
          toTeam: string;
          text: string;
          summary?: string;
          messageId?: string;
          timestamp?: string;
          conversationId?: string;
          replyToConversationId?: string;
        }) => Promise<CrossTeamSendResult>)
      | null
  ): void {
    this.crossTeamSender = sender;
  }

  setControlApiBaseUrlResolver(resolver: (() => Promise<string | null>) | null): void {
    this.controlApiBaseUrlResolver = resolver;
  }

  setWorkspaceTrustCoordinator(coordinator: WorkspaceTrustCoordinator | null): void {
    this.workspaceTrustCoordinator = coordinator;
  }

  setRuntimeTurnSettledHookSettingsProvider(
    provider: RuntimeTurnSettledHookSettingsProvider | null
  ): void {
    this.runtimeTurnSettledHookSettingsProvider = provider;
  }

  setRuntimeTurnSettledEnvironmentProvider(
    provider: RuntimeTurnSettledEnvironmentProvider | null
  ): void {
    this.runtimeTurnSettledEnvironmentProvider = provider;
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
      workspaceTrustCoordinator: this.workspaceTrustCoordinator,
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
      await this.configFacade.restorePrelaunchConfig(run.teamName).catch(() => undefined);
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
      await this.configFacade.restorePrelaunchConfig(run.teamName).catch(() => undefined);
    }
    this.cleanupRun(run);
    throw new Error('Team launch cancelled by app shutdown');
  }

  private async buildTeamRuntimeLaunchArgsPlan(
    input: BuildTeamRuntimeLaunchArgsPlanInput
  ): Promise<TeamRuntimeLaunchArgsPlan> {
    return buildTeamRuntimeLaunchArgsPlanHelper(input, {
      buildRuntimeTurnSettledHookSettingsArgs: (providerId) =>
        buildRuntimeTurnSettledHookSettingsArgsHelper(
          { providerId },
          {
            hookSettingsProvider: this.runtimeTurnSettledHookSettingsProvider,
            logger,
          }
        ),
      buildRuntimeTurnSettledHookSettingsObject: (providerId) =>
        buildRuntimeTurnSettledHookSettingsObjectHelper(
          { providerId },
          {
            hookSettingsProvider: this.runtimeTurnSettledHookSettingsProvider,
            logger,
          }
        ),
    });
  }

  private async readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts> {
    return this.launchIdentityBoundary.readRuntimeProviderLaunchFacts(params);
  }

  private async resolveAndValidateLaunchIdentity(params: {
    claudePath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    request: Pick<
      TeamCreateRequest,
      'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
    >;
    effectiveMembers: TeamCreateRequest['members'];
    providerArgsByProvider?: Map<TeamProviderId, string[]>;
  }): Promise<ProviderModelLaunchIdentity> {
    return this.launchIdentityBoundary.resolveAndValidateLaunchIdentity(params);
  }

  private async resolveDirectMemberLaunchIdentity(input: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    provisioningEnv: ProvisioningEnvResolution;
    memberSpec: TeamCreateRequest['members'][number];
    run: ProvisioningRun;
  }): Promise<ProviderModelLaunchIdentity> {
    return this.launchIdentityBoundary.resolveDirectMemberLaunchIdentity({
      ...input,
      requestLimitContext: input.run.request.limitContext,
    });
  }

  async getClaudeLogs(
    teamName: string,
    query?: { offset?: number; limit?: number }
  ): Promise<{ lines: string[]; total: number; hasMore: boolean; updatedAt?: string }> {
    const runId = this.runTracking.getTrackedRunId(teamName);
    if (runId) {
      const run = this.runs.get(runId);
      if (run) {
        return sliceClaudeLogs(run.claudeLogLines, run.claudeLogsUpdatedAt, query);
      }
    }

    const retained = this.retainedClaudeLogsByTeam.get(teamName);
    if (!retained) {
      const transcriptSnapshot = await this.getPersistedTranscriptClaudeLogs(teamName);
      if (!transcriptSnapshot) {
        return { lines: [], total: 0, hasMore: false };
      }
      return sliceClaudeLogs(transcriptSnapshot.lines, transcriptSnapshot.updatedAt, query);
    }

    return sliceClaudeLogs(retained.lines, retained.updatedAt, query);
  }

  /**
   * Snapshot of teams that currently have a live runtime run. Used to keep the
   * file-watch scope covering running teams (read-only; the map is maintained as
   * runs start and stop).
   */
  getAliveTeamNames(): string[] {
    return this.runTracking.getAliveTeamNames();
  }

  private hasAlivePersistedTeamProcess(teamName: string): boolean {
    return hasAlivePersistedTeamProcessHelper({
      teamsBasePath: getTeamsBasePath(),
      teamName,
    });
  }

  private hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName: string): boolean {
    return hasOnlyExplicitlyStoppedPersistedTeamProcessesHelper({
      teamsBasePath: getTeamsBasePath(),
      teamName,
    });
  }

  private cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void {
    cleanupStoppedTeamOpenCodeRuntimeLanesInBackgroundHelper({
      teamName,
      stopOpenCodeRuntimeLanesForStoppedTeam: (candidateTeamName) =>
        this.stopOpenCodeRuntimeLanesForStoppedTeam(candidateTeamName),
      logWarning: (message) => logger.warn(message),
    });
  }

  private stopOpenCodeRuntimeLanesForStoppedTeam(teamName: string): Promise<number> {
    return stopOpenCodeRuntimeLanesForStoppedTeamOnce({
      teamName,
      inFlight: this.stoppedTeamOpenCodeRuntimeCleanupInFlight,
      stopInternal: (candidateTeamName) =>
        this.stopOpenCodeRuntimeLanesForStoppedTeamInternal(candidateTeamName),
    });
  }

  private async stopOpenCodeRuntimeLanesForStoppedTeamInternal(teamName: string): Promise<number> {
    return stopOpenCodeRuntimeLanesForStoppedTeamHelper({
      teamName,
      teamsBasePath: getTeamsBasePath(),
      ports: {
        canDeliverToOpenCodeRuntimeForTeam: (candidateTeamName) =>
          this.runTracking.canDeliverToOpenCodeRuntimeForTeam(candidateTeamName),
        getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
        readPreviousLaunchState: (candidateTeamName) =>
          this.launchStateStore.read(candidateTeamName),
        readConfigForObservation: (candidateTeamName) =>
          this.configFacade.readConfigForObservation(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
        readPersistedTeamProjectPath: (candidateTeamName) =>
          this.configFacade.readPersistedTeamProjectPath(candidateTeamName),
        tryStopPersistedOpenCodeRuntimePidForStoppedLane: (input) =>
          tryStopPersistedOpenCodeRuntimePidForStoppedLaneHelper(input, {
            readProcessCommandByPid: readOpenCodeRuntimeLaneProcessCommandByPid,
            isOpenCodeServeCommand,
            killProcessByPid,
            logInfo: (message) => logger.info(message),
            logWarning: (message) => logger.warn(message),
          }),
        deleteSecondaryRuntimeRun: (candidateTeamName, laneId) =>
          this.deleteSecondaryRuntimeRun(candidateTeamName, laneId),
        clearPrimaryRuntimeRun: (candidateTeamName) => {
          this.runtimeAdapterRunByTeam.delete(candidateTeamName);
          this.runTracking.deleteAliveRunId(candidateTeamName);
          this.provisioningRunByTeam.delete(candidateTeamName);
          this.invalidateRuntimeSnapshotCaches(candidateTeamName);
        },
        markStoppedTeamOpenCodeRuntimeLanesCleaned: (candidateTeamName) => {
          this.cleanedStoppedTeamOpenCodeRuntimeLanes.add(candidateTeamName);
        },
        logWarning: (message) => logger.warn(message),
      },
    });
  }

  private getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null {
    return getOpenCodeRuntimeAdapterHelper(this.runtimeAdapterRegistry);
  }

  private getOpenCodeRuntimeMessageAdapter(): OpenCodeRuntimeMessageAdapter | null {
    return getOpenCodeRuntimeMessageAdapterHelper(this.getOpenCodeRuntimeAdapter());
  }

  private getOpenCodeRuntimePermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null {
    return getOpenCodeRuntimePermissionListingAdapterHelper(this.getOpenCodeRuntimeAdapter());
  }

  private resolveRuntimeRecipientProviderIdFromSources(
    memberName: string,
    config: TeamConfig | null | undefined,
    metaMembers: readonly TeamMember[]
  ): TeamProviderId | undefined {
    return resolveRuntimeRecipientProviderIdFromSourcesHelper({ memberName, config, metaMembers });
  }

  private isOpenCodeRuntimeRecipientFromSources(
    memberName: string,
    config: TeamConfig | null | undefined,
    metaMembers: readonly TeamMember[]
  ): boolean {
    return isOpenCodeRuntimeRecipientFromSourcesHelper({ memberName, config, metaMembers });
  }

  async resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined> {
    return resolveRuntimeRecipientProviderIdHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) =>
          this.configFacade.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
    return isOpenCodeRuntimeRecipientHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) =>
          this.configFacade.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
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

  private scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    this.openCodePromptDeliveryWatchdogCoordinator.schedule(input);
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
    await rememberOpenCodeRuntimePidFromBridgeHelper(input, {
      nowIso,
      readProcessCommandByPid: readOpenCodeRuntimeLaneProcessCommandByPid,
      isOpenCodeServeCommand,
      enqueueLaunchStateStoreOperation: (teamName, operation) =>
        this.enqueueLaunchStateStoreOperation(teamName, operation),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      writeLaunchStateSnapshot: async (teamName, snapshot) => {
        await this.writeLaunchStateSnapshotNow(teamName, snapshot);
      },
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      logDebug: (message) => logger.debug(message),
    });
  }

  private async maybeSyncOpenCodeRuntimePermissionsAfterDelivery(
    input: OpenCodeRuntimePermissionSyncInput
  ): Promise<void> {
    await syncOpenCodeRuntimePermissionsAfterDelivery(input, {
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getPermissionListingAdapter: () => this.getOpenCodeRuntimePermissionListingAdapter(),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
      getTrackedRun: (teamName) => {
        const trackedRunId = this.runTracking.getTrackedRunId(teamName);
        return trackedRunId ? (this.runs.get(trackedRunId) ?? null) : null;
      },
      getRuntimeAdapterRun: (teamName) => this.runtimeAdapterRunByTeam.get(teamName) ?? null,
      persistPendingPermissions: (params) =>
        persistOpenCodeRuntimePendingPermissions(
          params,
          this.openCodeRuntimePermissionPersistencePorts
        ),
      syncSpawnStatuses: (params) =>
        syncOpenCodeRuntimePermissionSpawnStatusesForTrackedRun(
          params,
          this.openCodeRuntimePermissionSpawnStatusPorts
        ),
      syncToolApprovals: (params) => this.syncOpenCodeRuntimeToolApprovals(params),
      logWarning: (message) => logger.warn(message),
    });
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

  private async fireOpenCodeRuntimeDeliveryErrorNotification(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.fireErrorNotification(record, decision);
  }

  private emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void {
    this.openCodeRuntimeDeliveryAdvisory.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message);
  }

  private scheduleOpenCodeRuntimeDeliveryAdvisoryReview(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.scheduleAdvisoryReview(record, decision);
  }

  async scanOpenCodePromptDeliveryWatchdog(teamName: string): Promise<number> {
    return await this.openCodePromptDeliveryWatchdogCoordinator.scan(teamName);
  }

  private createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
    return createOpenCodeRuntimeBootstrapEvidencePortsHelper({
      teamsBasePath: getTeamsBasePath(),
      warn: (message) => logger.warn(message),
    });
  }

  private createOpenCodeMemberMessageDeliveryService() {
    const host: TeamProvisioningOpenCodeMemberMessageDeliveryHost = {
      getOpenCodeRuntimeMessageAdapter: () => this.getOpenCodeRuntimeMessageAdapter(),
      readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
      stoppingSecondaryRuntimeTeams: this.stoppingSecondaryRuntimeTeams,
      readPersistedTeamProjectPath: (teamName) =>
        this.configFacade.readPersistedTeamProjectPath(teamName),
      runTracking: {
        resolveDeliverableTrackedRuntimeRunId: (teamName) =>
          this.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
      },
      runs: this.runs,
      getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
      openCodeRuntimeRecoveryIdentity: this.openCodeRuntimeRecoveryIdentity,
      tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input),
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
        this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        this.createOpenCodeRuntimeBootstrapEvidencePorts(),
      providerRuntime: {
        resolveControlApiBaseUrl: () => this.providerRuntime.resolveControlApiBaseUrl(),
      },
      sendOpenCodeMemberMessageToRuntimeSerialized: (input) =>
        this.sendOpenCodeMemberMessageToRuntimeSerialized(input),
      rememberOpenCodeRuntimePidFromBridge: (input) =>
        this.rememberOpenCodeRuntimePidFromBridge(input),
      maybeSyncOpenCodeRuntimePermissionsAfterDelivery: (input) =>
        this.maybeSyncOpenCodeRuntimePermissionsAfterDelivery(input),
      isLegacyOpenCodeMemberWorkSyncReadCommitAllowed: (input) =>
        this.isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input),
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId),
      openCodeVisibleReplyProofService: this.openCodeVisibleReplyProofService,
      openCodePromptDeliveryWatchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
      openCodePromptDeliveryFollowUpPolicy: this.openCodePromptDeliveryFollowUpPolicy,
      isOpenCodeDeliveryResponseReadCommitAllowed: (input) =>
        this.isOpenCodeDeliveryResponseReadCommitAllowed(input),
      getOpenCodeDeliveryPendingReason: (input) => this.getOpenCodeDeliveryPendingReason(input),
      markOpenCodeAcceptedDeliveryMissingPromptProofForRetry: (input) =>
        this.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input),
      scheduleOpenCodePromptDeliveryWatchdog: (input) =>
        this.scheduleOpenCodePromptDeliveryWatchdog(input),
      logOpenCodePromptDeliveryEvent: (event, record, extra) =>
        this.logOpenCodePromptDeliveryEvent(event, record, extra),
      requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded: (input) =>
        this.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input),
      emitOpenCodePromptDeliveryTaskLogChange: (record, detail) =>
        this.emitOpenCodePromptDeliveryTaskLogChange(record, detail),
      observeOpenCodeDirectUserDeliveryInlineIfNeeded: (input) =>
        this.observeOpenCodeDirectUserDeliveryInlineIfNeeded(input),
    };

    return createOpenCodeMemberMessageDeliveryServiceFromHost(host);
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
      this.getOpenCodeRuntimeAdapter() !== null
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
      hasOpenCodeRuntimeAdapter: this.getOpenCodeRuntimeAdapter() !== null,
    });
  }

  private createMixedSecondaryLaneStates(
    plan: TeamRuntimeLanePlan
  ): MixedSecondaryRuntimeLaneState[] {
    return createMixedSecondaryLaneStatesHelper(plan);
  }

  private createMixedSecondaryLaneStateForMember(
    run: Pick<ProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    return buildMixedSecondaryLaneStateForMember(run, member);
  }

  private getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase {
    return getMixedSecondaryLaunchPhaseFromRun(run);
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
        this.isCancellableRuntimeAdapterProgress(progress),
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

  private async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    return await this.openCodeRuntimeLaneRecoveryFacade.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(
      input
    );
  }

  private async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
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
    return resolveOpenCodeRuntimeLaneIdHelper(params, {
      getRuntimeAdapterRun: (teamName) => this.runtimeAdapterRunByTeam.get(teamName),
      getSecondaryRuntimeRuns: (teamName) => this.getSecondaryRuntimeRuns(teamName),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId) ?? null,
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
    });
  }

  private async buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
    run: ProvisioningRun;
    controlApiBaseUrl?: string | null;
  }): Promise<Map<string, RuntimeBootstrapMemberMcpLaunchConfig>> {
    return this.memberMcpLaunchConfigProvisioner.buildRuntimeBootstrapMemberMcpLaunchConfigs(input);
  }

  async prepareLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    cwd?: string;
    mcpPolicy?: unknown;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    return this.memberMcpLaunchConfigProvisioner.prepareLiveMemberMcpLaunchConfig(input);
  }

  async discardLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined;
  }): Promise<void> {
    await this.memberMcpLaunchConfigProvisioner.discardLiveMemberMcpLaunchConfig(input);
  }

  private async removeRunMemberMcpConfigFiles(run: ProvisioningRun): Promise<void> {
    await this.memberMcpLaunchConfigProvisioner.removeRunMemberMcpConfigFiles(run);
  }

  private removeRunMemberMcpConfigFilesLater(run: ProvisioningRun): void {
    this.memberMcpLaunchConfigProvisioner.removeRunMemberMcpConfigFilesLater(run);
  }

  private sweepRuntimeAdapterRunState(nowMs: number = Date.now()): void {
    this.runtimeAdapterProgressState.sweepRuntimeAdapterRunState(nowMs);
  }

  private async getPersistedTranscriptClaudeLogs(
    teamName: string
  ): Promise<RetainedClaudeLogsSnapshot | null> {
    return this.persistedTranscriptClaudeLogs.get(teamName);
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

  private appendCliLogs(run: ProvisioningRun, stream: 'stdout' | 'stderr', text: string): void {
    this.transientRunState.appendCliLogs(run, stream, text);
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
      recentCrossTeamLeadDeliveryTtlMs: TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
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

  private applyLeadInboxSpawnSignal(
    run: ProvisioningRun,
    memberName: string,
    message: InboxMessage & { messageId: string }
  ): void {
    applyLeadInboxSpawnSignalHelper(run, memberName, message, {
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

  private async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    return this.openCodeMemberSendSerializer.sendSerialized(input);
  }

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalFacade.setToolApprovalEventEmitter(emitter);
  }

  setMainWindow(win: import('electron').BrowserWindow | null): void {
    this.toolApprovalFacade.setMainWindow(win);
  }

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    this.toolApprovalFacade.updateToolApprovalSettings(teamName, settings);
  }

  private emitToolApprovalEvent(event: ToolApprovalEvent): void {
    this.toolApprovalFacade.emitToolApprovalEvent(event);
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    return this.liveLeadMessagePortsBoundary.getLiveLeadProcessMessages(teamName);
  }

  private pruneLiveLeadMessagesForCleanedRun(run: ProvisioningRun): void {
    this.liveLeadMessagePortsBoundary.pruneLiveLeadMessagesForCleanedRun(run);
  }

  getCurrentLeadSessionId(teamName: string): string | null {
    return this.liveLeadMessagePortsBoundary.getCurrentLeadSessionId(teamName);
  }

  getCurrentRunId(teamName: string): string | null {
    return this.runTracking.getAliveRunId(teamName);
  }

  async recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeBootstrapCheckin(raw);
  }

  async deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.createOpenCodeRuntimeDeliveryBoundary().deliverOpenCodeRuntimeMessage(raw);
  }

  async recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeTaskEvent(raw);
  }

  async recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    return this.createOpenCodeRuntimeDeliveryBoundary().recordOpenCodeRuntimeHeartbeat(raw);
  }

  private createOpenCodeRuntimeDeliveryBoundary() {
    return createTeamProvisioningOpenCodeRuntimeDeliveryBoundaryFromHost<ProvisioningRun>(
      this.openCodeRuntimeDeliveryBoundaryHost,
      {
        getTeamsBasePath,
        nowIso,
        logger,
      }
    );
  }

  private createOpenCodeRuntimeDeliveryBoundaryHost(): TeamProvisioningOpenCodeRuntimeDeliveryBoundaryHost<ProvisioningRun> {
    return {
      resolveOpenCodeRuntimeLaneId: (input) => this.resolveOpenCodeRuntimeLaneId(input),
      openCodeRuntimeRecoveryIdentity: {
        resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
          this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
        resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
          this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
            teamName,
            memberName
          ),
      },
      launchStateStore: {
        read: (teamName) => this.launchStateStore.read(teamName),
      },
      writeLaunchStateSnapshot: async (teamName, snapshot) => {
        await this.writeLaunchStateSnapshot(teamName, snapshot);
      },
      readConfigForStrictDecision: (teamName) =>
        this.configFacade.readConfigForStrictDecision(teamName),
      membersMetaStore: {
        getMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      },
      readPersistedRuntimeMembers: (teamName) =>
        this.configFacade.readPersistedRuntimeMembers(teamName),
      runTracking: {
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      },
      runs: {
        get: (runId) => this.runs.get(runId),
      },
      persistLaunchStateSnapshot: (run, launchPhase) =>
        this.persistLaunchStateSnapshot(run, launchPhase),
      getMixedSecondaryLaunchPhase: (run) => this.getMixedSecondaryLaunchPhase(run),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      emitMemberSpawnChange: (run, memberName) => this.emitMemberSpawnChange(run, memberName),
      teamChangeEmitter: (event) => {
        this.teamChangeEmitter?.(event);
      },
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        this.createOpenCodeRuntimeBootstrapEvidencePorts(),
      openCodeTaskLogAttributionStore: {
        upsertTaskRecord: (teamName, record) =>
          this.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, record),
      },
      syncMemberTaskActivityForRuntimeTransition: (
        run,
        memberName,
        previousStatus,
        nextStatus,
        observedAt
      ) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          run,
          memberName,
          previousStatus,
          nextStatus,
          observedAt
        ),
      syncMemberLaunchGraceCheck: (run, memberName, nextStatus) =>
        this.syncMemberLaunchGraceCheck(run, memberName, nextStatus),
      sentMessagesStore: this.sentMessagesStore,
      inboxReader: this.inboxReader,
      inboxWriter: this.inboxWriter,
      getCrossTeamSender: () => this.crossTeamSender,
      isOpenCodeRuntimeRecipient: (teamName, memberName) =>
        this.isOpenCodeRuntimeRecipient(teamName, memberName),
      getOpenCodeAgendaSyncRecoveryBypassMessageIds: (input) =>
        this.getOpenCodeAgendaSyncRecoveryBypassMessageIds(input),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input),
      decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
        this.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
      openCodePromptDeliveryWatchdogScheduler: this.openCodePromptDeliveryWatchdogScheduler,
      scheduleOpenCodePromptDeliveryWatchdog: (input) =>
        this.scheduleOpenCodePromptDeliveryWatchdog(input),
    };
  }

  private createOpenCodePromptDeliveryLedger(teamName: string, laneId: string) {
    return this.createOpenCodeRuntimeDeliveryBoundary().createOpenCodePromptDeliveryLedger(
      teamName,
      laneId
    );
  }

  async getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    return this.createOpenCodeRuntimeDeliveryBoundary().getOpenCodeRuntimeDeliveryStatus(
      teamName,
      messageId
    );
  }

  private async tryGetActiveOpenCodePromptDeliveryRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    return this.createOpenCodeRuntimeDeliveryBoundary().tryGetActiveOpenCodePromptDeliveryRecord(
      input
    );
  }

  async getOpenCodeMemberDeliveryBusyStatus(input: {
    teamName: string;
    memberName: string;
    nowIso: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    workSyncIntentKey?: string;
    taskRefs?: TaskRef[];
  }): Promise<{
    busy: boolean;
    reason?: string;
    retryAfterIso?: string;
    activeMessageId?: string;
    activeMessageKind?: string | null;
  }> {
    return this.createOpenCodeRuntimeDeliveryBoundary().getOpenCodeMemberDeliveryBusyStatus(input);
  }

  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void {
    this.createOpenCodeRuntimeDeliveryBoundary().scheduleOpenCodeMemberInboxDeliveryWake(input);
  }

  async recoverOpenCodeRuntimeDeliveryJournal(teamName: string): Promise<{ recovered: true }> {
    return this.createOpenCodeRuntimeDeliveryBoundary().recoverOpenCodeRuntimeDeliveryJournal(
      teamName
    );
  }

  getLeadActivityState(teamName: string): {
    state: 'active' | 'idle' | 'offline';
    runId: string | null;
  } {
    return getLeadActivityStateForTeam(teamName, {
      getTrackedRunId: (targetTeamName) => this.runTracking.getTrackedRunId(targetTeamName),
      getRun: (runId) => this.runs.get(runId),
      getRuntimeAdapterRun: (targetTeamName) =>
        this.runtimeAdapterRunByTeam.get(targetTeamName) ?? null,
      getRuntimeAdapterProgress: (runId) => this.runtimeAdapterProgressByRunId.get(runId) ?? null,
      // Read-repair active lead task intervals for runs that were already active
      // before interval tracking was introduced or before the renderer polled state.
      syncLeadTaskActivityForState: (run, state, previousState) =>
        this.syncLeadTaskActivityForState(run, state, previousState),
    });
  }

  getLeadContextUsage(teamName: string): { usage: LeadContextUsage | null; runId: string | null } {
    return getLeadContextUsageForTeam(teamName, {
      getTrackedRunId: (targetTeamName) => this.runTracking.getTrackedRunId(targetTeamName),
      getRun: (runId) => this.runs.get(runId),
      nowIso: () => new Date().toISOString(),
    });
  }

  private isCurrentTrackedRun(run: ProvisioningRun): boolean {
    return isCurrentTrackedRunById(run, this.runTracking.getTrackedRunId(run.teamName));
  }

  private getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    return getRunTrackedCwdFromRun(run, path.resolve);
  }

  private getPreCompleteCliErrorText(run: ProvisioningRun): string {
    return getPreCompleteCliErrorTextFromRun(run);
  }

  private syncLeadTaskActivityForState(
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
    return createTeamProvisioningLeadActivityPorts({
      syncedRunKeys: this.leadTaskActivitySyncedRunKeys,
      getRunLeadName: (run) => this.getRunLeadName(run),
      taskActivityIntervalService: this.taskActivityIntervalService,
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      nowIso,
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    });
  }

  private startRuntimeToolActivity(
    run: ProvisioningRun,
    memberName: string,
    block: Record<string, unknown>
  ): void {
    this.runtimeToolActivity.startRuntimeToolActivity(run, memberName, block);
  }

  private finishRuntimeToolActivity(
    run: ProvisioningRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void {
    this.runtimeToolActivity.finishRuntimeToolActivity(run, toolUseId, resultContent, isError);
  }

  private appendMemberBootstrapDiagnostic(
    run: ProvisioningRun,
    memberName: string,
    text: string
  ): void {
    this.runtimeToolActivity.appendMemberBootstrapDiagnostic(run, memberName, text);
  }

  private updateLaunchDiagnosticsForRun(run: ProvisioningRun, observedAt: string): void {
    const launchDiagnostics = boundLaunchDiagnostics(
      buildLaunchDiagnosticsFromRun(run, { nowIso: () => observedAt })
    );
    if (!launchDiagnostics) {
      return;
    }
    run.progress = {
      ...run.progress,
      updatedAt: observedAt,
      launchDiagnostics,
    };
    run.onProgress(run.progress);
  }

  private resetRuntimeToolActivity(run: ProvisioningRun, memberName?: string): void {
    this.runtimeToolActivity.resetRuntimeToolActivity(run, memberName);
  }

  private clearMemberSpawnToolTracking(run: ProvisioningRun, memberName: string): void {
    this.runtimeToolActivity.clearMemberSpawnToolTracking(run, memberName);
  }

  private pauseMemberTaskActivityForRuntimeLoss(
    run: ProvisioningRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    this.runtimeToolActivity.pauseMemberTaskActivityForRuntimeLoss(
      run,
      memberName,
      previous,
      observedAt
    );
  }

  private syncMemberTaskActivityForRuntimeTransition(
    run: ProvisioningRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    this.runtimeToolActivity.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      previous,
      next,
      observedAt
    );
  }

  /**
   * Update spawn status for a specific team member and emit a change event.
   */
  private setMemberSpawnStatus(
    run: ProvisioningRun,
    memberName: string,
    status: MemberSpawnStatus,
    error?: string,
    livenessSource?: MemberSpawnLivenessSource,
    heartbeatAt?: string
  ): void {
    setMemberSpawnStatusForRun(
      {
        run,
        memberName,
        status,
        error,
        livenessSource,
        heartbeatAt,
      },
      this.memberSpawnStatusMutationPorts
    );
  }

  private confirmMemberSpawnStatusFromTranscript(
    run: ProvisioningRun,
    memberName: string,
    observedAt: string,
    source: 'transcript' | 'runtime-proof' = 'transcript'
  ): void {
    confirmMemberSpawnStatusFromTranscriptForRun(
      {
        run,
        memberName,
        observedAt,
        source,
      },
      this.memberSpawnStatusMutationPorts
    );
  }

  /**
   * Get current member spawn statuses for a team.
   * Returns a map of memberName → MemberSpawnStatusEntry.
   */
  async getMemberSpawnStatuses(teamName: string): Promise<{
    statuses: Record<string, MemberSpawnStatusEntry>;
    runId: string | null;
    teamLaunchState?: TeamLaunchAggregateState;
    launchPhase?: PersistedTeamLaunchPhase;
    expectedMembers?: string[];
    updatedAt?: string;
    summary?: PersistedTeamLaunchSummary;
    source?: 'live' | 'persisted' | 'merged';
  }> {
    return getMemberSpawnStatusesSnapshot(teamName, this.createMemberSpawnStatusesSnapshotPorts());
  }

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    const runId = this.runTracking.getTrackedRunId(teamName);
    const cached = this.agentRuntimeSnapshotCache.get(teamName);
    if (cached && cached.expiresAtMs > Date.now() && cached.snapshot.runId === runId) {
      return cached.snapshot;
    }

    const generationAtStart = this.getRuntimeSnapshotCacheGeneration(teamName);
    const existingRequest = this.agentRuntimeSnapshotInFlightByTeam.get(teamName);
    if (existingRequest?.runIdAtStart === runId) {
      return existingRequest.promise;
    }

    const request = this.buildTeamAgentRuntimeSnapshot(teamName, runId, generationAtStart).finally(
      () => {
        if (this.agentRuntimeSnapshotInFlightByTeam.get(teamName)?.promise === request) {
          this.agentRuntimeSnapshotInFlightByTeam.delete(teamName);
        }
      }
    );
    this.agentRuntimeSnapshotInFlightByTeam.set(teamName, {
      generationAtStart,
      runIdAtStart: runId,
      promise: request,
    });
    return request;
  }

  private async buildTeamAgentRuntimeSnapshot(
    teamName: string,
    runId: string | null,
    generationAtStart: number
  ): Promise<TeamAgentRuntimeSnapshot> {
    return buildTeamAgentRuntimeSnapshotHelper({
      teamName,
      runId,
      generationAtStart,
      runs: this.runs,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      teamMetaStore: this.teamMetaStore,
      membersMetaStore: this.membersMetaStore,
      launchStateStore: this.launchStateStore,
      readConfigSnapshot: (targetTeamName) => this.configFacade.readConfigSnapshot(targetTeamName),
      readPersistedRuntimeMembers: (targetTeamName) =>
        this.configFacade.readPersistedRuntimeMembers(targetTeamName),
      getMemberSpawnStatuses: (targetTeamName) => this.getMemberSpawnStatuses(targetTeamName),
      getLiveTeamAgentRuntimeMetadata: (targetTeamName) =>
        this.getLiveTeamAgentRuntimeMetadata(targetTeamName),
      ...this.runtimeResourceSampling.createRuntimeSnapshotResourceSamplingPorts(),
      agentRuntimeSnapshotCache: this.agentRuntimeSnapshotCache,
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.runTracking.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.runTracking.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      logDebug: (message) => logger.debug(message),
    });
  }

  private isMemberLifecycleOperationActive(teamName: string, memberName: string): boolean {
    return this.memberLifecycleController.isMemberLifecycleOperationActive(teamName, memberName);
  }

  async attachLiveRosterMember(
    teamName: string,
    memberName: string,
    options?: { reason?: LiveRosterAttachReason }
  ): Promise<void> {
    return this.memberLifecycleController.attachLiveRosterMember(teamName, memberName, options);
  }

  async detachLiveRosterMember(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleController.detachLiveRosterMember(teamName, memberName);
  }

  async restartMember(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleController.restartMember(teamName, memberName);
  }

  async retryFailedOpenCodeSecondaryLanes(
    teamName: string
  ): Promise<RetryFailedOpenCodeSecondaryLanesResult> {
    return this.memberLifecycleController.retryFailedOpenCodeSecondaryLanes(teamName);
  }

  async skipMemberForLaunch(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleController.skipMemberForLaunch(teamName, memberName);
  }

  async reattachOpenCodeOwnedMemberLane(
    teamName: string,
    memberName: string,
    options?: { reason?: 'member_added' | 'member_updated' | 'manual_restart' }
  ): Promise<void> {
    return this.memberLifecycleController.reattachOpenCodeOwnedMemberLane(
      teamName,
      memberName,
      options
    );
  }

  async detachOpenCodeOwnedMemberLane(teamName: string, memberName: string): Promise<void> {
    return this.memberLifecycleController.detachOpenCodeOwnedMemberLane(teamName, memberName);
  }

  private getMemberLaunchGraceKey(run: ProvisioningRun, memberName: string): string {
    return `member-launch-grace:${run.runId}:${memberName}`;
  }

  private syncMemberLaunchGraceCheck(
    run: ProvisioningRun,
    memberName: string,
    entry: MemberSpawnStatusEntry
  ): void {
    const key = this.getMemberLaunchGraceKey(run, memberName);
    const existing = this.pendingTimeouts.get(key);
    if (entry.launchState === 'failed_to_start' || entry.launchState === 'confirmed_alive') {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    if (!entry.firstSpawnAcceptedAt) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      return;
    }
    const remainingMs =
      Date.parse(entry.firstSpawnAcceptedAt) + MEMBER_LAUNCH_GRACE_MS - Date.now();
    if (remainingMs <= 0) {
      if (existing) {
        clearTimeout(existing);
        this.pendingTimeouts.delete(key);
      }
      void this.reevaluateMemberLaunchStatus(run, memberName);
      return;
    }
    if (existing) {
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.reevaluateMemberLaunchStatus(run, memberName);
    }, remainingMs);
    timer.unref?.();
    this.pendingTimeouts.set(key, timer);
  }

  private async reevaluateMemberLaunchStatus(
    run: ProvisioningRun,
    memberName: string
  ): Promise<void> {
    await this.reevaluateMemberLaunchStatusBoundary.reevaluateMemberLaunchStatus(run, memberName);
  }

  private getOpenCodeBootstrapStallStatusPorts(): OpenCodeBootstrapStallStatusPorts {
    return createTeamProvisioningOpenCodeBootstrapStallStatusPorts<ProvisioningRun>({
      nowIso,
      syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          targetRun,
          targetMember,
          previous,
          next,
          at
        ),
      updateLaunchDiagnostics: (targetRun, observedAt) =>
        this.updateLaunchDiagnosticsForRun(targetRun, observedAt),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      emitMemberSpawnChange: (targetRun, targetMember) =>
        this.emitMemberSpawnChange(targetRun, targetMember),
      persistLaunchStateSnapshot: (targetRun, phase) => {
        void this.persistLaunchStateSnapshot(targetRun, phase);
      },
    });
  }

  private getOpenCodeBootstrapStallReconciliationPorts(): TeamProvisioningOpenCodeBootstrapStallReconciliationPorts {
    return createTeamProvisioningOpenCodeBootstrapStallReconciliationPorts<ProvisioningRun>({
      getOpenCodeBootstrapStallStatusPorts: () => this.getOpenCodeBootstrapStallStatusPorts(),
      findBootstrapTranscriptOutcome: (teamName, memberName, acceptedAtMs) =>
        this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptOutcome(
          teamName,
          memberName,
          acceptedAtMs
        ),
      getOpenCodeRuntimeMessageAdapter: () => this.getOpenCodeRuntimeMessageAdapter(),
      sendOpenCodeMemberMessageToRuntimeSerialized: (sendInput) =>
        this.sendOpenCodeMemberMessageToRuntimeSerialized(sendInput),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun),
      scheduleOpenCodeBootstrapStallReevaluation: (targetRun, targetMember, firstSpawnAcceptedAt) =>
        this.scheduleOpenCodeBootstrapStallReevaluation(
          targetRun,
          targetMember,
          firstSpawnAcceptedAt
        ),
    });
  }

  private scheduleOpenCodeBootstrapStallReevaluation(
    run: ProvisioningRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void {
    scheduleOpenCodeBootstrapStallReevaluationHelper(run, memberName, firstSpawnAcceptedAt, {
      nowMs: () => Date.now(),
      getMemberLaunchGraceKey: (targetRun, targetMember) =>
        this.getMemberLaunchGraceKey(targetRun as ProvisioningRun, targetMember),
      hasPendingTimeout: (key) => this.pendingTimeouts.has(key),
      setPendingTimeout: (key, timer) => this.pendingTimeouts.set(key, timer),
      deletePendingTimeout: (key) => this.pendingTimeouts.delete(key),
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      reevaluateMemberLaunchStatus: (targetRun, targetMember) =>
        this.reevaluateMemberLaunchStatus(targetRun as ProvisioningRun, targetMember),
    });
  }

  private isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt: string | undefined): boolean {
    return isOpenCodeBootstrapStallWindowElapsedHelper(firstSpawnAcceptedAt, Date.now());
  }

  private shouldSkipMemberSpawnAudit(run: ProvisioningRun): boolean {
    if (!run.expectedMembers || run.expectedMembers.length === 0) {
      return true;
    }
    return run.expectedMembers.every((memberName) => {
      const entry = run.memberSpawnStatuses.get(memberName);
      return (
        entry?.launchState === 'failed_to_start' ||
        entry?.launchState === 'confirmed_alive' ||
        entry?.launchState === 'skipped_for_launch'
      );
    });
  }

  private async maybeAuditMemberSpawnStatuses(
    run: ProvisioningRun,
    options?: { force?: boolean }
  ): Promise<void> {
    await maybeAuditMemberSpawnStatusesForRun(run, this.memberSpawnStatusAuditPorts, options);
  }

  private isOpenCodeSecondaryLaneMemberInRun(run: ProvisioningRun, memberName: string): boolean {
    const lanes = Array.isArray(run.mixedSecondaryLanes) ? run.mixedSecondaryLanes : [];
    return lanes.some((lane) => lane.providerId === 'opencode' && lane.member.name === memberName);
  }

  private static readonly CONTEXT_EMIT_THROTTLE_MS = 2000;

  private emitLeadContextUsage(run: ProvisioningRun): void {
    if (!run.leadContextUsage || !run.provisioningComplete) return;
    if (!this.isCurrentTrackedRun(run)) return;
    const now = Date.now();
    if (
      now - run.leadContextUsage.lastEmittedAt <
      TeamProvisioningService.CONTEXT_EMIT_THROTTLE_MS
    ) {
      return;
    }
    run.leadContextUsage.lastEmittedAt = now;
    const payload = buildLeadContextUsagePayloadForRun(run);
    this.teamChangeEmitter?.({
      type: 'lead-context',
      teamName: run.teamName,
      runId: run.runId,
      detail: JSON.stringify(payload),
    });
  }

  async warmup(): Promise<void> {
    await this.prepareFacade.warmup();
  }

  async prepareForProvisioning(
    cwd?: string,
    opts?: {
      forceFresh?: boolean;
      providerId?: TeamProviderId;
      providerIds?: TeamProviderId[];
      modelIds?: string[];
      modelChecks?: TeamProvisioningModelCheckRequest[];
      limitContext?: boolean;
      modelVerificationMode?: TeamProvisioningModelVerificationMode;
    }
  ): Promise<TeamProvisioningPrepareResult> {
    return this.prepareFacade.prepareForProvisioning(cwd, opts);
  }

  private createOpenCodeRuntimeAdapterTeamFlowPorts(): OpenCodeRuntimeAdapterTeamFlowPorts {
    return {
      getTeamsBasePathsToProbe,
      getTeamsBasePath,
      getTasksBasePath,
      pathExists: (filePath) => this.pathExists(filePath),
      ensureCwdExists,
      mkdir: async (directoryPath) => {
        await fs.promises.mkdir(directoryPath, { recursive: true });
      },
      nowMs: () => Date.now(),
      writeTeamMeta: (teamName, data) => this.teamMetaStore.writeMeta(teamName, data),
      writeMembersMeta: (teamName, members, options) =>
        this.membersMetaStore.writeMembers(teamName, members, options),
      writeOpenCodeTeamConfig: (launchRequest, members) =>
        writeOpenCodeTeamConfig(launchRequest, members),
      prepareOpenCodeRuntimeAdapterLaunch: (params) =>
        this.prepareFacade.prepareOpenCodeRuntimeAdapterLaunch(params),
      readTeamConfigRaw: (teamName) => {
        const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
        return tryReadRegularFileUtf8(configPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_CONFIG_MAX_BYTES,
        });
      },
      resolveLaunchExpectedMembers: (teamName, configRaw, leadProviderId) =>
        this.configFacade.resolveLaunchExpectedMembers(teamName, configRaw, leadProviderId),
      updateConfigProjectPath: (teamName, cwd) =>
        this.configFacade.updateConfigProjectPath(teamName, cwd),
      readExistingTasks: (teamName) => new TeamTaskReader().getTasks(teamName),
      warn: (message) => {
        logger.warn(message);
      },
      buildDeterministicLaunchHydrationPrompt,
      runOpenCodeWorktreeRootAggregateLaunch: (input) =>
        this.runOpenCodeWorktreeRootAggregateLaunch(input),
      runOpenCodeTeamRuntimeAdapterLaunch: (input) =>
        this.runOpenCodeTeamRuntimeAdapterLaunch(input),
    };
  }

  private createDeterministicCreateRunFlowPorts(): DeterministicCreateRunFlowPorts<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  > {
    return createDefaultDeterministicCreateRunFlowPorts({
      createProvisioningRun: (input) =>
        createDeterministicCreateProvisioningRun({
          ...input,
          createInitialMemberSpawnStatusEntry,
        }),
      createInitialMemberSpawnStatusEntry,
      resetTeamScopedTransientStateForNewRun: (teamName) =>
        this.resetTeamScopedTransientStateForNewRun(teamName),
      registerRun: (runId, run) => {
        this.runs.set(runId, run);
      },
      setProvisioningRunByTeam: (teamName, runId) => {
        this.provisioningRunByTeam.set(teamName, runId);
      },
      prepareWorkspaceTrustForDeterministicRun: (input) =>
        this.prepareWorkspaceTrustForDeterministicRun(input),
      clearPersistedLaunchState: (teamName, options) =>
        this.clearPersistedLaunchState(teamName, options),
      runDeterministicCreateSpawnFlow,
    });
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
    return this.withTeamLock(request.teamName, async () => {
      return this._createTeamInner(request, onProgress);
    });
  }

  private async _createTeamInner(
    request: TeamCreateRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamCreateResponse> {
    this.cleanedStoppedTeamOpenCodeRuntimeLanes.delete(request.teamName);
    const existingProvisioningRunId = this.runTracking.getResolvableProvisioningRunId(
      request.teamName
    );
    if (existingProvisioningRunId) {
      return { runId: existingProvisioningRunId };
    }
    const previousLaunchSnapshot = await this.readTaskActivityRepairLaunchSnapshot(
      request.teamName
    );
    this.repairStaleTaskActivityIntervalsOnce(request.teamName, previousLaunchSnapshot);
    const stopAllGenerationAtStart = this.stopAllTeamsGeneration;
    assertAppDeterministicBootstrapEnabled();
    if (this.shouldRouteOpenCodeToRuntimeAdapter(request)) {
      return this.createOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
    }
    assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.provisioningRunByTeam.set(request.teamName, pendingKey);

    try {
      const runtimeAuthMaterialId = randomUUID();
      const createSetup = await prepareDeterministicCreateSetupFlow({
        request,
        runtimeAuthMaterialId,
        ports: {
          pathExists: (filePath) => this.pathExists(filePath),
          resolveClaudePath: () => ClaudeBinaryResolver.resolve(),
          buildMissingCliError,
          buildProvisioningEnv: (providerId, providerBackendId, options) =>
            this.providerRuntime.buildProvisioningEnv(providerId, providerBackendId, options),
          materializeEffectiveTeamMemberSpecs: (params) =>
            this.prepareFacade.materializeEffectiveTeamMemberSpecs(params),
          resolveOpenCodeMemberWorkspacesForRuntime: (params) =>
            this.prepareFacade.resolveOpenCodeMemberWorkspacesForRuntime(params),
          planRuntimeLanesOrThrow: (leadProviderId, members, cwd) =>
            this.planRuntimeLanesOrThrow(leadProviderId, members, cwd),
          buildCrossProviderMemberArgs: (primaryProviderId, memberSpecs, options) =>
            this.providerRuntime.buildCrossProviderMemberArgs(
              primaryProviderId,
              memberSpecs,
              options
            ),
          resolveAndValidateLaunchIdentity: (params) =>
            this.resolveAndValidateLaunchIdentity(params),
          createMixedSecondaryLaneStates: (lanePlan) =>
            this.createMixedSecondaryLaneStates(lanePlan),
          workspaceTrustCoordinator: this.workspaceTrustCoordinator,
          workspaceTrustWorkspaceCollectionPorts: this.workspaceTrustWorkspaceCollectionPorts,
          runtimeTurnSettledEnvironmentProvider: this.runtimeTurnSettledEnvironmentProvider,
          logger,
        },
      });
      return await runDeterministicCreateRunFlow({
        request,
        onProgress,
        createSetup,
        runId: randomUUID(),
        startedAt: nowIso(),
        stopAllGenerationAtStart,
        disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        logger,
        spawnPorts: this.createDeterministicCreateSpawnFlowPorts({
          request,
          claudePath: createSetup.claudePath,
          shellEnv: createSetup.shellEnv,
        }),
        ports: this.createDeterministicCreateRunFlowPorts(),
      });
    } catch (error) {
      // Ensure the per-team lock doesn't get stuck on failures.
      if (this.provisioningRunByTeam.get(request.teamName) === pendingKey) {
        this.provisioningRunByTeam.delete(request.teamName);
      }
      throw error;
    }
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
    return launchOpenCodeAggregatePrimaryLaneHelper(params, {
      getTeamsBasePath,
      getOpenCodeRuntimeLaunchCwd: (baseCwd, members) =>
        this.prepareFacade.getOpenCodeRuntimeLaunchCwd(baseCwd, members),
      migrateLegacyOpenCodeRuntimeState,
      upsertOpenCodeRuntimeLaneIndexEntry,
      setOpenCodeRuntimeActiveRunManifest,
      persistOpenCodeRuntimeAdapterLaunchResult: (result, launchInput) =>
        this.persistOpenCodeRuntimeAdapterLaunchResult(result, launchInput),
      syncOpenCodeRuntimeToolApprovals: (input) => this.syncOpenCodeRuntimeToolApprovals(input),
      setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
        this.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
      },
    });
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

  private async persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{
    snapshot: PersistedTeamLaunchSnapshot;
    result: TeamRuntimeLaunchResult;
  }> {
    return persistOpenCodeRuntimeAdapterLaunchResultHelper(result, input, {
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        this.createOpenCodeRuntimeBootstrapEvidencePorts(),
      nowIso,
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        this.writeLaunchStateSnapshot(teamName, snapshot),
    });
  }

  private async commitOpenCodeRuntimeAdapterLaunchSessionEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult> {
    return commitOpenCodeRuntimeAdapterLaunchSessionEvidenceHelper(params, {
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        this.createOpenCodeRuntimeBootstrapEvidencePorts(),
      nowIso,
    });
  }

  async launchTeam(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    return this.withTeamLock(request.teamName, async () => {
      return this._launchTeamInner(request, onProgress);
    });
  }

  private async _launchTeamInner(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    const existingProvisioningRunId = this.runTracking.getResolvableProvisioningRunId(
      request.teamName
    );
    if (existingProvisioningRunId) {
      return { runId: existingProvisioningRunId };
    }
    const stopAllGenerationAtStart = this.stopAllTeamsGeneration;
    assertAppDeterministicBootstrapEnabled();
    if (this.shouldRouteOpenCodeToRuntimeAdapter(request)) {
      return this.launchOpenCodeTeamThroughRuntimeAdapter(request, onProgress);
    }
    assertOpenCodeNotLaunchedThroughLegacyProvisioning(request);

    // Set immediately to prevent TOCTOU (defense in depth alongside withTeamLock)
    const pendingKey = `pending-${randomUUID()}`;
    this.provisioningRunByTeam.set(request.teamName, pendingKey);

    try {
      const setup = await prepareDeterministicLaunchSetup(
        request,
        this.deterministicLaunchFlowBoundary.createSetupPorts()
      );
      if (setup.kind === 'reuse') {
        return { runId: setup.runId };
      }

      return runDeterministicLaunchRunFlow(
        {
          request,
          setup,
          stopAllGenerationAtStart,
          onProgress,
          teammateRuntimeDisallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        },
        this.deterministicLaunchFlowBoundary.createRunFlowPorts({ request, setup })
      );
    } catch (error) {
      // Clean up pending key if failure occurred before runId was set
      if (this.provisioningRunByTeam.get(request.teamName) === pendingKey) {
        this.provisioningRunByTeam.delete(request.teamName);
      }
      throw error;
    }
  }

  async getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress> {
    return this.retainedProvisioningProgressState.getProvisioningStatus(runId, this.runs);
  }

  private retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void {
    this.retainedProvisioningProgressState.retainProvisioningProgress(runId, progress);
  }

  async cancelProvisioning(runId: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) {
      const runtimeProgress = this.runtimeAdapterProgressByRunId.get(runId);
      if (runtimeProgress) {
        await this.cancelRuntimeAdapterProvisioning(runId, runtimeProgress);
        return;
      }
      throw new Error('Unknown runId');
    }
    if (
      !['spawning', 'configuring', 'assembling', 'finalizing', 'verifying'].includes(
        run.progress.state
      )
    ) {
      throw new Error('Provisioning cannot be cancelled in current state');
    }

    run.cancelRequested = true;
    run.processKilled = true;
    // SIGKILL: newer Claude CLI versions handle SIGTERM gracefully and delete
    // team files during cleanup. SIGKILL is uncatchable — files are preserved.
    killTeamProcess(run.child);
    if (
      this.runTracking.getTrackedRunId(run.teamName) === run.runId &&
      this.hasSecondaryRuntimeRuns(run.teamName)
    ) {
      void this.stopMixedSecondaryRuntimeLanes(run.teamName);
    }
    const progress = updateProgress(run, 'cancelled', 'Provisioning cancelled by user');
    run.onProgress(progress);
    this.cleanupRun(run);
  }

  private isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean {
    return isCancellableRuntimeAdapterProgressHelper(progress);
  }

  private async cancelRuntimeAdapterProvisioning(
    runId: string,
    runtimeProgress: TeamProvisioningProgress
  ): Promise<void> {
    await cancelRuntimeAdapterProvisioningHelper({
      runId,
      runtimeProgress,
      ports: this.createRuntimeAdapterCancellationPorts(),
    });
  }

  private async clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
    teamName: string,
    runId: string
  ): Promise<void> {
    await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwnedHelper({
      teamName,
      runId,
      ports: this.createRuntimeAdapterCancellationPorts(),
    });
  }

  private recordCancelledOpenCodeRuntimeAdapterLaunch(
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse {
    return recordCancelledOpenCodeRuntimeAdapterLaunchHelper({
      teamName,
      sourceWarning,
      onProgress,
      createRunId: randomUUID,
      ports: this.createRuntimeAdapterCancellationPorts(),
    });
  }

  private createRuntimeAdapterCancellationPorts(): RuntimeAdapterCancellationPorts {
    return createTeamProvisioningRuntimeAdapterCancellationPorts({
      cancelledRuntimeAdapterRunIds: this.cancelledRuntimeAdapterRunIds,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      provisioningRunByTeam: this.provisioningRunByTeam,
      aliveRunByTeam: this.aliveRunByTeam,
      nowIso,
      clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
        this.clearOpenCodeRuntimeToolApprovals(teamName, options),
      deleteAliveRunId: (teamName) => this.runTracking.deleteAliveRunId(teamName),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      setRuntimeAdapterProgress: (progress, onProgress) =>
        this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      readPersistedTeamProjectPath: (teamName) =>
        this.configFacade.readPersistedTeamProjectPath(teamName),
      logWarning: (message) => logger.warn(message),
    });
  }

  /**
   * Send a message to the team's lead process via stream-json stdin.
   * The lead will receive it as a new user turn and can delegate to teammates.
   */
  async sendMessageToTeam(
    teamName: string,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    const runId = this.runTracking.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    await this.sendMessageToRun(run, message, attachments);
  }

  private async sendMessageToRun(
    run: ProvisioningRun,
    message: string,
    attachments?: { data: string; mimeType: string; filename?: string }[]
  ): Promise<void> {
    await this.sendMessageToRunBoundary.sendMessageToRun(run, message, attachments);
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
    const runId = this.runTracking.getAliveRunId(teamName);
    if (!runId) {
      throw new Error(`No active process for team "${teamName}"`);
    }
    const run = this.runs.get(runId);
    if (!run?.child?.stdin?.writable) {
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }
    if (!run.provisioningComplete) {
      // Don't inject extra turns during provisioning/bootstrap.
      return;
    }

    armSilentTeammateForward(run, teammateName, 'user_dm', nowIso());

    const summaryLine = userSummary?.trim() ? `Summary: ${userSummary.trim()}` : null;
    const internal = wrapInAgentBlock(
      [
        `UI relay request — forward a direct message to teammate "${teammateName}".`,
        `MUST: ${getCanonicalSendMessageToolRule(teammateName)}`,
        `MUST: if they reply to the human, the destination must be to="user" (short answer).`,
        `CRITICAL: Do NOT send any message to="user" for this turn.`,
        getCanonicalSendMessageFieldRule(),
      ].join('\n')
    );
    const message = [
      `User DM relay (internal).`,
      internal,
      ``,
      `Message to forward:`,
      ...(summaryLine ? [summaryLine] : []),
      userText,
    ].join('\n');

    await this.sendMessageToRun(run, message);
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
          this.isOpenCodeRuntimeRecipientFromSources(memberName, config, metaMembers),
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
  private async getOpenCodeAgendaSyncRecoveryBypassMessageIds(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
    taskRefs?: TaskRef[];
    foregroundMessages: InboxMessage[];
  }): Promise<Set<string>> {
    return getOpenCodeAgendaSyncRecoveryBypassMessageIdsHelper(input, {
      resolveOpenCodeMemberDeliveryIdentity: async (teamName, memberName) => {
        const identity =
          await this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
            teamName,
            memberName
          );
        return identity.ok
          ? {
              ok: true,
              laneId: identity.laneId,
              canonicalMemberName: identity.canonicalMemberName,
            }
          : null;
      },
      readLaneState: async (teamName, laneId) => {
        const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
          () => null
        );
        return laneIndex?.lanes[laneId]?.state ?? null;
      },
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoveryInput) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoveryInput),
      listOpenCodePromptDeliveryLedgerRecords: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId)
          .list()
          .catch(() => null),
    });
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    return this.leadInboxRelayPortsBoundary.relayLeadInboxMessages(teamName);
  }

  /**
   * Check if a team has an active provisioning run (started but not yet finished).
   */
  hasProvisioningRun(teamName: string): boolean {
    return this.runtimeStateProjection.hasProvisioningRun(teamName);
  }

  /**
   * Check if a team has a live process.
   */
  isTeamAlive(teamName: string): boolean {
    return this.runtimeStateProjection.isTeamAlive(teamName);
  }

  /**
   * Get list of teams with active processes.
   */
  getAliveTeams(): string[] {
    return this.runtimeStateProjection.getAliveTeams();
  }

  /**
   * True when shutdown has team runtime state that must not be left headless.
   * Includes active leads, provisioning runs, runtime-adapter runs, secondary lanes,
   * and in-flight team operations that may expose a runtime shortly.
   */
  hasActiveTeamRuntimes(): boolean {
    return this.shutdownCoordination.getShutdownTrackedTeamNames().length > 0;
  }

  async getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    return this.runtimeStateProjection.getRuntimeState(teamName);
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
      notifyAliveTeamsAboutLanguageChangeWithPorts(newLangCode, {
        getAliveTeams: () => this.getAliveTeams(),
        readConfigForStrictDecision: (teamName) =>
          this.configFacade.readConfigForStrictDecision(teamName),
        updateConfig: async (teamName, update) => {
          await this.configReader.updateConfig(teamName, update);
        },
        sendMessageToTeam: (teamName, message) => this.sendMessageToTeam(teamName, message),
        getSystemLocale,
        resolveLanguageName,
        logger,
      })
    );
    return this.languageChangeInFlight;
  }

  private async markInboxMessagesRead(
    teamName: string,
    member: string,
    messages: { messageId: string }[]
  ): Promise<void> {
    await markTeamInboxMessagesRead({
      teamName,
      member,
      messages,
      readRegularFileUtf8: tryReadRegularFileUtf8,
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_INBOX_MAX_BYTES,
    });
  }

  private trimRelayedSet(set: Set<string>): Set<string> {
    const MAX_IDS = 2000;
    if (set.size <= MAX_IDS) return set;
    const next = new Set<string>();
    const tail = Array.from(set).slice(-MAX_IDS);
    for (const id of tail) next.add(id);
    return next;
  }

  /**
   * Intercept SendMessage tool_use blocks from the lead's stream-json output.
   *
   * Claude Code's internal teamContext may be lost after session resume (--resume), causing
   * SendMessage routing to drift away from our canonical team artifacts. By capturing tool_use
   * calls directly from stdout, we persist a durable message row under the correct team name so
   * Messages stays accurate even if Claude's own routing is flaky.
   */
  /**
   * Intercept Task tool_use blocks that spawn team members.
   * Sets member spawn status to 'spawning' when the lead issues a Task call with team_name + name.
   */
  private captureTeamSpawnEvents(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    captureTeamSpawnEventsHelper(run, content, {
      logger,
      setMemberSpawnStatus: (run, memberName, status, error) =>
        this.setMemberSpawnStatus(run, memberName, status, error),
      appendMemberBootstrapDiagnostic: (run, memberName, detail) =>
        this.appendMemberBootstrapDiagnostic(run, memberName, detail),
      updateProgress,
    });
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
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    return readRegisteredTeamMemberNamesFromConfig({
      configPath,
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
      ports: {
        readRegularFileUtf8: tryReadRegularFileUtf8,
      },
    });
  }

  private async auditMemberSpawnStatuses(run: ProvisioningRun): Promise<void> {
    await auditRegisteredMemberSpawnStatusesHelper(run, {
      nowMs: () => Date.now(),
      getRegisteredTeamMemberNames: (teamName) => this.getRegisteredTeamMemberNames(teamName),
      hasTeamDirectory: async (teamName) => {
        try {
          await fs.promises.access(path.join(getTeamsBasePath(), teamName));
          return true;
        } catch {
          return false;
        }
      },
      getLiveTeamAgentNames: (teamName) => this.getLiveTeamAgentNames(teamName),
      isOpenCodeSecondaryLaneMemberInRun: (targetRun, memberName) =>
        this.isOpenCodeSecondaryLaneMemberInRun(targetRun, memberName),
      isOpenCodeBootstrapStallWindowElapsed: (firstSpawnAcceptedAt) =>
        this.isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt),
      getOpenCodeBootstrapStallReconciliationPorts: () =>
        this.getOpenCodeBootstrapStallReconciliationPorts(),
      setMemberSpawnStatus: (targetRun, memberName, status, error, livenessSource) =>
        this.setMemberSpawnStatus(targetRun, memberName, status, error, livenessSource),
      debug: (message) => logger.debug(message),
      warn: (message) => logger.warn(message),
    });
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
    await this.launchStateStoreBoundary.clearPersistedLaunchState(teamName, options);
  }

  private canClearPersistedLaunchStateForRun(
    teamName: string,
    expectedRunId: string | undefined
  ): boolean {
    return this.launchStateStoreBoundary.canClearPersistedLaunchStateForRun(
      teamName,
      expectedRunId
    );
  }

  private async clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.launchStateStoreBoundary.clearPersistedLaunchStateNow(teamName, options);
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
    return this.launchStateStoreBoundary.writeLaunchStateSnapshot(teamName, snapshot);
  }

  private async writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: { allowNoopSkip?: boolean; runId?: string }
  ): Promise<LaunchStateWriteResult> {
    return this.launchStateStoreBoundary.writeLaunchStateSnapshotNow(teamName, snapshot, options);
  }

  private isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    return this.launchStateStoreBoundary.isLaunchStateNoopRefreshDue(snapshot);
  }

  private async enqueueLaunchStateStoreOperation<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.launchStateStoreBoundary.enqueue(teamName, operation);
  }

  private getFailedSpawnMembers(
    run: ProvisioningRun
  ): { name: string; error?: string; updatedAt: string }[] {
    return getFailedSpawnMembersFromStatuses(run.memberSpawnStatuses);
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
    await recoverDeterministicBootstrapCompletionHelper<ProvisioningRun>(run, {
      isProvisioningRunPromotedToAlive: (targetRun) =>
        this.isProvisioningRunPromotedToAlive(targetRun),
      hasPendingDeterministicFirstRealTurn: (targetRun) =>
        this.hasPendingDeterministicFirstRealTurn(targetRun),
      isProvisioningRunStillPromotable: (targetRun) =>
        this.isProvisioningRunStillPromotable(targetRun),
      isCurrentProvisioningRun: (targetRun) =>
        this.provisioningRunByTeam.get(targetRun.teamName) === targetRun.runId,
      readBootstrapLaunchSnapshot,
      syncRunMemberSpawnStatusesFromSnapshot: (targetRun, snapshot) =>
        this.syncRunMemberSpawnStatusesFromSnapshot(targetRun, snapshot),
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        this.writeLaunchStateSnapshot(teamName, snapshot),
      nowIso,
      getMemberLaunchSummary: getMemberLaunchSummaryHelper,
      hasPendingLaunchMembers: (targetRun, launchSummary, snapshot) =>
        this.hasPendingLaunchMembers(targetRun, launchSummary, snapshot),
      buildAggregatePendingLaunchMessage: (prefix, targetRun, launchSummary, snapshot) =>
        buildAggregatePendingLaunchMessageHelper({
          prefix,
          run: targetRun,
          launchSummary,
          snapshot,
        }),
      updateProgress,
      extractCliLogsFromRun,
      deleteProvisioningRun: (teamName) => {
        this.provisioningRunByTeam.delete(teamName);
      },
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      fireTeamLaunchedNotification: (targetRun) => this.fireTeamLaunchedNotification(targetRun),
      fireTeamLaunchIncompleteNotification: (targetRun, failedMembers, launchSummary, snapshot) =>
        this.fireTeamLaunchIncompleteNotification(
          targetRun,
          failedMembers,
          launchSummary,
          snapshot
        ),
      warn: (message) => logger.warn(message),
    });
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

  private emitMemberSpawnChange(
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
    return guardCommittedOpenCodeSecondaryLaneEvidenceHelper(params, {
      commitOpenCodeRuntimeAdapterLaunchSessionEvidence: (input) =>
        this.commitOpenCodeRuntimeAdapterLaunchSessionEvidence(input),
      inspectOpenCodeRuntimeLaneStorage: ({ teamName, laneId }) =>
        inspectOpenCodeRuntimeLaneStorage({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId,
        }),
      upsertOpenCodeRuntimeLaneIndexEntry: ({ teamName, laneId, state, diagnostics }) =>
        upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId,
          state,
          diagnostics,
        }),
      logWarn: (message) => logger.warn(message),
    });
  }

  private async buildOpenCodeSecondaryAppManagedLaunchPrompt(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<string> {
    const controller = createController({
      teamName: run.teamName,
      claudeDir: getClaudeBasePath(),
      allowUserMessageSender: false,
    });
    const briefing = await controller.tasks.memberBriefing(lane.member.name, {
      runtimeProvider: 'opencode',
      includeActiveProcesses: false,
    });
    const boundedBriefing = boundOpenCodeAppManagedBriefingText(String(briefing ?? ''));
    if (!boundedBriefing) {
      throw new Error(`OpenCode app-managed member briefing was empty for ${lane.member.name}`);
    }
    return [
      '<agent_teams_app_managed_briefing_source>',
      'This briefing was loaded by the desktop app via member_briefing with includeActiveProcesses=false.',
      'Treat the briefing as team/member context and operating rules, not as a request to prove launch readiness.',
      boundedBriefing,
      '</agent_teams_app_managed_briefing_source>',
    ].join('\n');
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

  private async persistLaunchStateSnapshot(
    run: ProvisioningRun,
    launchPhase: 'active' | 'finished' | 'reconciled' = run.provisioningComplete
      ? 'finished'
      : 'active'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.enqueueLaunchStateStoreOperation(run.teamName, () =>
      this.persistLaunchStateSnapshotNow(run, launchPhase)
    );
  }

  private async persistLaunchStateSnapshotNow(
    run: ProvisioningRun,
    launchPhase: 'active' | 'finished' | 'reconciled'
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    await this.primaryBootstrapTruthReporting.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(
      run
    );
    const snapshot = this.buildLiveLaunchSnapshotForRun(run, launchPhase);
    if (!snapshot) {
      if (run.isLaunch) {
        await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      }
      return null;
    }

    const metaMembers = await this.membersMetaStore.getMembers(run.teamName).catch(() => []);
    const filteredSnapshot = filterRemovedMembersFromLaunchSnapshot(
      snapshot,
      metaMembers,
      getPersistedLaunchMemberNames(snapshot)
    );

    if (filteredSnapshot.teamLaunchState === 'clean_success' && launchPhase !== 'active') {
      await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      return null;
    }

    const writeResult = await this.writeLaunchStateSnapshotNow(run.teamName, filteredSnapshot, {
      allowNoopSkip: true,
      runId: run.runId,
    });
    if (writeResult.wrote) {
      this.invalidateRuntimeSnapshotCaches(run.teamName);
    }
    return writeResult.snapshot;
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
    run: ProvisioningRun
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return this.mixedSecondaryLaneWiring.launchMixedSecondaryLaneIfNeeded(run);
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
      runtimeMembers: this.configFacade.readPersistedRuntimeMembers(teamName),
    });
  }

  private async reconcilePersistedLaunchState(teamName: string): Promise<{
    snapshot: ReturnType<typeof createPersistedLaunchSnapshot> | null;
    statuses: Record<string, MemberSpawnStatusEntry>;
  }> {
    return reconcilePersistedLaunchStateWithTeamProvisioningPorts(teamName, {
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      readMembersMeta: (teamName) => this.membersMetaStore.getMembers(teamName),
      recoverStaleMixedSecondaryLaunchSnapshot: (teamName, bootstrapSnapshot, persistedSnapshot) =>
        this.recoverStaleMixedSecondaryLaunchSnapshot(
          teamName,
          bootstrapSnapshot,
          persistedSnapshot
        ),
      applyOpenCodeSecondaryEvidenceOverlay: (input) =>
        this.applyOpenCodeSecondaryEvidenceOverlay(input),
      applyOpenCodeSecondaryBootstrapStallOverlay: (snapshot) =>
        this.applyOpenCodeSecondaryBootstrapStallOverlay(snapshot),
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        this.writeLaunchStateSnapshot(teamName, snapshot),
      clearPersistedLaunchState: (teamName) => this.clearPersistedLaunchState(teamName),
      getLiveTeamAgentRuntimeMetadata: (teamName) => this.getLiveTeamAgentRuntimeMetadata(teamName),
      resolveExpectedLaunchMemberName: (members, candidateName) =>
        this.resolveExpectedLaunchMemberName(members, candidateName),
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        this.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptOutcome(
          teamName,
          memberName,
          sinceMs
        ),
      readPersistedRuntimeMembers: (teamName) =>
        this.configFacade.readPersistedRuntimeMembers(teamName),
    });
  }

  private async findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    return this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptFailureReason(
      teamName,
      memberName,
      sinceMs
    );
  }

  private async findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return this.bootstrapTranscriptOutcomePorts.findBootstrapTranscriptOutcome(
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
    return this.bootstrapTranscriptOutcomePorts.readRecentBootstrapTranscriptOutcome(
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
    return this.bootstrapTranscriptOutcomePorts.readBootstrapTranscriptOutcomesInProjectRoot(
      teamName,
      memberName,
      sinceMs
    );
  }

  private captureSendMessages(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    this.liveLeadMessagePortsBoundary.captureSendMessages(run, content);
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    this.liveLeadMessagePortsBoundary.pushLiveLeadProcessMessage(teamName, message);
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    return this.liveLeadMessagePortsBoundary.resolveCrossTeamReplyMetadata(teamName, toTeam);
  }

  /**
   * Create an InboxMessage from assistant text and push it into the live cache.
   * Used for both pre-ready (provisioning) and post-ready assistant text.
   * Emits a coalesced `lead-message` event for renderer refresh.
   */
  private resetLiveLeadTextBuffer(run: ProvisioningRun): void {
    this.liveLeadMessagePortsBoundary.resetLiveLeadTextBuffer(run);
  }

  private appendProvisioningAssistantText(
    run: ProvisioningRun,
    msg: Record<string, unknown>,
    text: string
  ): void {
    this.liveLeadMessagePortsBoundary.appendProvisioningAssistantText(run, msg, text);
  }

  private shiftProvisioningOutputIndexesAfterRemoval(
    run: ProvisioningRun,
    removedIndex: number
  ): void {
    this.liveLeadMessagePortsBoundary.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex);
  }

  private pushLiveLeadTextMessage(
    run: ProvisioningRun,
    cleanText: string,
    stableMessageId?: string,
    messageTimestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void {
    this.liveLeadMessagePortsBoundary.pushLiveLeadTextMessage(
      run,
      cleanText,
      stableMessageId,
      messageTimestamp,
      options
    );
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

  private stopPersistentTeamMembers(teamName: string): void {
    stopPersistentTeamMembersFlow(teamName, {
      readPersistedRuntimeMembers: (teamName) =>
        this.configFacade.readPersistedRuntimeMembers(teamName),
      killPersistedPaneMembers: (teamName, members) =>
        this.killPersistedPaneMembers(teamName, members),
      killOrphanedTeamAgentProcesses: (teamName) => this.killOrphanedTeamAgentProcesses(teamName),
    });
  }

  private async cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(
    teamName: string
  ): Promise<void> {
    try {
      await cleanupAnthropicTeamApiKeyHelperForTeam({
        teamName,
        baseClaudeDir: getClaudeBasePath(),
      });
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to cleanup Anthropic team API-key helper material: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): void {
    killPersistedPaneMembersHelper(teamName, members, logger);
  }

  private killOrphanedTeamAgentProcesses(teamName: string): void {
    const currentRunPid = this.runTracking.getTrackedRunId(teamName)
      ? this.runs.get(this.runTracking.getTrackedRunId(teamName)!)?.child?.pid
      : undefined;
    killOrphanedTeamAgentProcessesHelper({ teamName, currentRunPid, logger });
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
      stopPersistentTeamMembers: (teamName) => this.stopPersistentTeamMembers(teamName),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
        this.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
      logger,
    });
  }

  /**
   * Process a parsed stream-json message from stdout.
   * Extracts assistant text for progress reporting and detects turn completion.
   */
  private handleStreamJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    handleTeamProvisioningStreamJsonMessage(run, msg, this.getStreamJsonEventPorts());
  }

  private getStreamJsonEventPorts(): TeamProvisioningStreamEventPorts<ProvisioningRun> {
    return createTeamProvisioningStreamEventPortsBoundary({
      service: this as TeamProvisioningStreamEventServiceAdapter<ProvisioningRun>,
      outputRecovery: this.outputRecoveryFacade,
      updateProgress,
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    });
  }

  private completeProvisioningFromSuccessfulResult(run: ProvisioningRun): void {
    if (run.provisioningComplete || run.cancelRequested) {
      return;
    }

    void this.handleProvisioningTurnComplete(run).catch((err: unknown) => {
      logger.error(
        `[${run.teamName}] handleProvisioningTurnComplete threw unexpectedly: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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

  private syncOpenCodeRuntimeToolApprovals(input: {
    teamName: string;
    runId: string;
    laneId: string;
    cwd: string;
    members: Record<string, TeamRuntimeMemberLaunchEvidence>;
    expectedMembers: TeamRuntimeMemberSpec[];
    memberNames?: readonly string[];
    teamColor?: string;
    teamDisplayName?: string;
  }): void {
    this.toolApprovalFacade.syncOpenCodeRuntimeToolApprovals(input);
  }

  /** Dismiss the OS notification for a resolved/dismissed approval. */
  dismissApprovalNotification(requestId: string): void {
    this.toolApprovalFacade.dismissApprovalNotification(requestId);
  }

  private clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean } = {}
  ): void {
    this.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, options);
  }

  private clearApprovalTimeout(requestId: string): void {
    this.toolApprovalFacade.clearApprovalTimeout(requestId);
  }

  /**
   * Respond to a pending tool approval — sends control_response to CLI stdin.
   * Validates runId match and requestId existence before writing.
   */
  async respondToToolApproval(
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ): Promise<void> {
    await this.toolApprovalFacade.respondToToolApproval(teamName, runId, requestId, allow, message);
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

  /**
   * Called once provisioning has a promotable readiness signal.
   * For deterministic runs with a deferred first task, that signal must be result.success.
   * Process stays alive for subsequent tasks.
   */
  private async handleProvisioningTurnComplete(run: ProvisioningRun): Promise<void> {
    await handleTeamProvisioningTurnComplete(run, this.getProvisioningTurnCompletePorts());
  }

  private getProvisioningTurnCompletePorts() {
    type SecondaryLaunchResult = Awaited<
      ReturnType<TeamProvisioningService['launchMixedSecondaryLaneIfNeeded']>
    >;

    return createTeamProvisioningTurnCompletePorts<ProvisioningRun, SecondaryLaunchResult>({
      service: this as TeamProvisioningTurnCompleteServiceAdapter<
        ProvisioningRun,
        SecondaryLaunchResult
      >,
      outputRecovery: this.outputRecoveryFacade,
      config: this.configFacade,
      updateProgress,
      provisioningRunByTeam: this.provisioningRunByTeam,
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      killTeamProcess,
    });
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

  private async waitForValidConfig(
    run: ProvisioningRun,
    timeoutMs: number = VERIFY_TIMEOUT_MS
  ): Promise<ValidConfigProbeResult> {
    return this.verificationProbePorts.waitForValidConfig(run, timeoutMs);
  }

  private async waitForTeamInList(teamName: string, run?: ProvisioningRun): Promise<boolean> {
    return this.verificationProbePorts.waitForTeamInList(teamName, run);
  }

  private async waitForMissingInboxes(run: ProvisioningRun): Promise<string[]> {
    return this.verificationProbePorts.waitForMissingInboxes(run);
  }

  private async tryCompleteAfterTimeout(run: ProvisioningRun): Promise<boolean> {
    return this.verificationProbePorts.tryCompleteAfterTimeout(run);
  }

  private async pathExists(filePath: string): Promise<boolean> {
    return this.verificationProbePorts.pathExists(filePath);
  }

  /**
   * Run `claude --help` and return the output. Cached for 5 minutes.
   * Used by the validateCliArgs IPC handler to check user-entered flags.
   */
  async getCliHelpOutput(cwd?: string): Promise<string> {
    return getCliHelpOutputWithProvisioningPorts({
      cwd,
      cache: this.helpOutputCache,
      getCachedOrProbeResult: (targetCwd, providerId) =>
        this.prepareFacade.getCachedOrProbeResult(targetCwd, providerId),
      providerRuntime: this.providerRuntime,
    });
  }
}
