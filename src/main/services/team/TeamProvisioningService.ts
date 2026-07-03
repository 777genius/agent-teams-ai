import {
  buildClaudeAttachmentDeliveryParts,
  buildCodexNativeAttachmentDeliveryParts,
} from '@features/agent-attachments/main';
import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
  isPureOpenCodeWorktreeRootLanePlan,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import {
  resolveWorkspaceTrustFeatureFlags,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustDiagnosticsManifest,
  type WorkspaceTrustExecutionResult,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import { ConfigManager } from '@main/services/infrastructure/ConfigManager';
import { NotificationManager } from '@main/services/infrastructure/NotificationManager';
import { notifyTeamWatchScopeChanged } from '@main/services/infrastructure/teamWatchScope';
import { getAppIconPath } from '@main/utils/appIcon';
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
  getProjectsBasePath,
  getTasksBasePath,
  getTeamsBasePath,
} from '@main/utils/pathDecoder';
import { killProcessByPid } from '@main/utils/processKill';
import { shouldAutoAllow } from '@main/utils/toolApprovalRules';
import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { CROSS_TEAM_SENT_SOURCE, CROSS_TEAM_SOURCE } from '@shared/constants/crossTeam';
import { type AttachmentPayload, DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { getErrorMessage } from '@shared/utils/errorHandling';
import {
  isMeaningfulBootstrapCheckInMessage,
  type ParsedPermissionRequest,
  parsePermissionRequest,
} from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';
import { type ParsedTeammateContent } from '@shared/utils/teammateMessageParser';
import { normalizeTeamMemberMcpPolicy } from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type ChildProcess, type spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS,
  type AnthropicTeamApiKeyHelperMaterial,
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  cleanupStaleAnthropicTeamApiKeyHelpers,
} from '../runtime/anthropicTeamApiKeyHelper';
import { ProviderConnectionService } from '../runtime/ProviderConnectionService';
import { resolveTeamProviderId } from '../runtime/providerRuntimeEnv';

import {
  buildOpenCodeRuntimePermissionAnswerInput,
  buildOpenCodeRuntimePermissionLaunchInput,
  openCodeRuntimeApprovalProvider,
} from './approvals/OpenCodeRuntimeApprovalProvider';
import {
  RuntimeToolApprovalCoordinator,
  type RuntimeToolApprovalEntry,
} from './approvals/RuntimeToolApprovalCoordinator';
import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from './bootstrap/NativeAppManagedBootstrapContextBuilder';
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
  getOpenCodeRuntimeRunTombstonesPath,
  inspectOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  prepareOpenCodeRuntimeLaneForLaunchGeneration,
  readOpenCodeRuntimeLaneIndex,
  recoverStaleOpenCodeRuntimeLaneIndexEntry,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { createRuntimeRunTombstoneStore } from './opencode/store/RuntimeRunTombstoneStore';
import { getSystemLocale } from './provisioning/TeamProvisioningAgentLanguage';
import { ensureCwdExists, sleep } from './provisioning/TeamProvisioningAsyncUtils';
import { respawnCliAfterAuthFailure } from './provisioning/TeamProvisioningAuthRetryRecovery';
import {
  buildDeterministicLaunchBootstrapSpec,
  getProvisioningRunTimeoutMs,
  removeDeterministicBootstrapSpecFile,
  removeDeterministicBootstrapUserPromptFile,
  type RuntimeBootstrapMemberMcpLaunchConfig,
  writeDeterministicBootstrapSpecFile,
  writeDeterministicBootstrapUserPromptFile,
} from './provisioning/TeamProvisioningBootstrapSpec';
import {
  applyBootstrapTranscriptEvidenceOverlay as applyBootstrapTranscriptEvidenceOverlayHelper,
  applyProcessBootstrapTransportOverlay as applyProcessBootstrapTransportOverlayHelper,
  BOOTSTRAP_FAILURE_TAIL_BYTES,
  BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS,
  BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
  type BootstrapTranscriptOutcome,
  type BootstrapTranscriptOutcomeCacheEntry,
  type BootstrapTranscriptOutcomeLookupCacheEntry,
  cleanConfirmedBootstrapRuntimeDiagnostics as cleanConfirmedBootstrapRuntimeDiagnosticsHelper,
  findBootstrapRuntimeProofObservedAt as findBootstrapRuntimeProofObservedAtHelper,
  findBootstrapTranscriptOutcome as findBootstrapTranscriptOutcomeHelper,
  getParsedBootstrapTranscriptTail as getParsedBootstrapTranscriptTailHelper,
  hasBootstrapTranscriptLaunchReconcileOutcome as hasBootstrapTranscriptLaunchReconcileOutcomeHelper,
  isBootstrapProofClearableLaunchFailureReason,
  type LeadInboxLaunchReconcileMessage,
  needsBootstrapAcceptanceReconcile as needsBootstrapAcceptanceReconcileHelper,
  needsConfirmedBootstrapDiagnosticReconcile as needsConfirmedBootstrapDiagnosticReconcileHelper,
  type ParsedBootstrapTranscriptTailCacheEntry,
  type ParsedBootstrapTranscriptTailLine,
  PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS,
  readBootstrapTranscriptOutcomesInProjectRoot as readBootstrapTranscriptOutcomesInProjectRootHelper,
  readLeadInboxMessagesForLaunchReconcile as readLeadInboxMessagesForLaunchReconcileHelper,
  readProcessBootstrapTransportSummary as readProcessBootstrapTransportSummaryHelper,
  readRecentBootstrapTranscriptOutcome as readRecentBootstrapTranscriptOutcomeHelper,
  shouldClearRuntimeDiagnosticAfterBootstrapConfirmation,
} from './provisioning/TeamProvisioningBootstrapTranscript';
import {
  addPermissionRulesToSettings as addClaudePermissionRulesToSettings,
  type ClaudePermissionSettingsFilePorts,
  seedLeadBootstrapPermissionRules as seedLeadBootstrapPermissionRulesHelper,
} from './provisioning/TeamProvisioningClaudePermissionSettings';
import {
  buildIncompleteLaunchCleanupReason as buildIncompleteLaunchCleanupReasonHelper,
  cleanupProvisioningRun,
  shouldFinalizeIncompleteLaunchState as shouldFinalizeIncompleteLaunchStateHelper,
} from './provisioning/TeamProvisioningCleanup';
import { buildCombinedLogs } from './provisioning/TeamProvisioningCliExitPresentation';
import { buildMembersMetaWritePayload } from './provisioning/TeamProvisioningConfigLaunchNormalization';
import { TeamProvisioningConfigMaintenance } from './provisioning/TeamProvisioningConfigMaintenance';
import { type TeamProvisioningEffectiveLaunchState } from './provisioning/TeamProvisioningConfigMaterialization';
import {
  assertCreateTeamDoesNotExist,
  buildDeterministicCreateSpawnArgs,
  materializeDeterministicCreateTeamBootstrapFiles,
} from './provisioning/TeamProvisioningCreateTeamFlow';
import {
  buildLeadActiveCrossTeamReplyHints,
  clearPendingCrossTeamReplyExpectation as clearPendingCrossTeamReplyExpectationInState,
  createCrossTeamLeadSuppressionState,
  type CrossTeamDeliveredLeadBlock,
  isCrossTeamPseudoRecipientName,
  isCrossTeamToolRecipientName,
  markCrossTeamReplyToOwnOutbound,
  matchCrossTeamLeadInboxMessages as matchCrossTeamLeadInboxMessagesHelper,
  registerPendingCrossTeamReplyExpectation as registerPendingCrossTeamReplyExpectationInState,
  rememberRecentCrossTeamLeadDeliveryMessageIds,
  wasRecentlyDeliveredCrossTeamLeadMessage,
} from './provisioning/TeamProvisioningCrossTeamRelayHelpers';
import { buildProvisioningTraceDetail } from './provisioning/TeamProvisioningDiagnosticsHelpers';
import {
  type ProvisioningEnvResolution,
  type TeamRuntimeAuthContext,
} from './provisioning/TeamProvisioningEnvBuilder';
import {
  applyAppManagedRuntimeSettingsPathEnv,
  assertAppDeterministicBootstrapEnabled,
} from './provisioning/TeamProvisioningEnvGuards';
import {
  createTeamProvisioningEnvRuntimePorts,
} from './provisioning/TeamProvisioningEnvRuntimePorts';
import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from './provisioning/TeamProvisioningFilesystemMonitor';
import {
  injectGeminiPostLaunchHydration as injectGeminiPostLaunchHydrationHelper,
  injectPostCompactReminder as injectPostCompactReminderHelper,
} from './provisioning/TeamProvisioningIdlePromptInjection';
import { markTeamInboxMessagesRead } from './provisioning/TeamProvisioningInboxPersistence';
import {
  armSilentTeammateForward,
  forgetPendingInboxRelayCandidates,
  isInboxRelayInFlightTimeoutError,
  type PendingInboxRelayCandidate,
  rememberPendingInboxRelayCandidates,
  waitForInboxRelayInFlight,
} from './provisioning/TeamProvisioningInboxRelayCandidates';
import {
  buildLeadInboxRelayPrompt,
  buildMemberInboxRelayPrompt,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  getLeadInboxRelayNoiseIds,
  getLeadRelayReadCommitBatch,
  hasStableInboxMessageId,
  inferOpenCodeInboxMessageTaskRefs,
  planLeadInboxRelayReadOnlyMessages,
  selectActionableLeadRelayUnread,
  selectLeadInboxRelayBatch,
  selectMemberInboxRelayBatch,
  shouldDeferSameTeamMessage as shouldDeferSameTeamMessageHelper,
  splitMemberInboxRelayUnread,
} from './provisioning/TeamProvisioningInboxRelayPolicy';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  assertOpenCodeNotLaunchedThroughLegacyProvisioning,
  buildLargeDeterministicBootstrapWarning,
  getMixedLaunchFallbackRecoveryError,
  mergeProvisioningWarnings,
  type TeamLaunchCompatibilityReport,
} from './provisioning/TeamProvisioningLaunchCompatibility';
import {
  buildLaunchDiagnosticsFromRun,
  mentionsProcessTableUnavailable,
} from './provisioning/TeamProvisioningLaunchDiagnostics';
import {
  probeLaunchCompatibility as probeLaunchCompatibilityHelper,
  resolveLaunchExpectedMembers as resolveLaunchExpectedMembersHelper,
  resolveLaunchExpectedMembersFromCompatibility,
  type TeamProvisioningLaunchExpectedMembersPorts,
} from './provisioning/TeamProvisioningLaunchExpectedMembers';
import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isBootstrapCheckInTimeoutFailureReason,
  isCliProvisionedButNotAliveFailureReason,
  isProvisionedButNotAliveFailureReason,
} from './provisioning/TeamProvisioningLaunchFailurePolicy';
import {
  readRuntimeProviderLaunchFacts as readRuntimeProviderLaunchFactsHelper,
  resolveAndValidateLaunchIdentity as resolveAndValidateLaunchIdentityHelper,
  resolveDirectMemberLaunchIdentity as resolveDirectMemberLaunchIdentityHelper,
} from './provisioning/TeamProvisioningLaunchIdentity';
import { buildTeamLaunchIncompleteNotificationPayload } from './provisioning/TeamProvisioningLaunchIncompleteNotification';
import { TeamProvisioningLaunchNotifications } from './provisioning/TeamProvisioningLaunchNotifications';
import {
  buildAggregatePendingLaunchMessage as buildAggregatePendingLaunchMessageHelper,
  buildPendingBootstrapStatusMessage as buildPendingBootstrapStatusMessageHelper,
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
  shouldOverlayPrimaryBootstrapTruth as shouldOverlayPrimaryBootstrapTruthHelper,
} from './provisioning/TeamProvisioningLaunchStateProjection';
import {
  applyOpenCodeSecondaryEvidenceOverlay as applyOpenCodeSecondaryEvidenceOverlayHelper,
  createDefaultOpenCodeSecondaryEvidenceOverlayPorts,
  finalizeMissingRegisteredMembersAsFailed as finalizeMissingRegisteredMembersAsFailedHelper,
  guardCommittedOpenCodeSecondaryLaneEvidence as guardCommittedOpenCodeSecondaryLaneEvidenceHelper,
} from './provisioning/TeamProvisioningLaunchStateReconciliation';
import {
  type LaunchStateWriteResult,
  TeamProvisioningLaunchStateStoreBoundary,
} from './provisioning/TeamProvisioningLaunchStateStoreBoundary';
import {
  buildDeterministicLaunchProcessArgs,
  buildLaunchSyntheticRequest,
  getInitialLaunchValidationMessage,
  parseLaunchConfigProjectPath,
  prepareDeterministicLaunchRunState,
  resolveExistingLaunchRunReuse,
} from './provisioning/TeamProvisioningLaunchTeamFlow';
import {
  getLeadActivityStateForTeam,
  type LeadActivityState,
  setLeadActivity as setLeadActivityHelper,
  syncLeadTaskActivityForState as syncLeadTaskActivityForStateHelper,
} from './provisioning/TeamProvisioningLeadActivity';
import {
  codexImagePartToContentBlock,
  toLeadAttachmentPayloads,
} from './provisioning/TeamProvisioningLeadAttachments';
import {
  buildLeadContextUsagePayloadForRun,
  getLeadContextUsageForTeam,
  updateLeadContextUsageFromUsageForRun,
} from './provisioning/TeamProvisioningLeadContextUsage';
import { scanLeadInboxPermissionRequests } from './provisioning/TeamProvisioningLeadPermissionScan';
import {
  appendProvisioningAssistantText as appendProvisioningAssistantTextHelper,
  getCurrentLeadSessionId as getCurrentLeadSessionIdHelper,
  getLiveLeadProcessMessages as getLiveLeadProcessMessagesHelper,
  joinLeadRelayCaptureText,
  pruneLiveLeadMessagesForCleanedRun as pruneLiveLeadMessagesForCleanedRunHelper,
  pushLiveLeadProcessMessage as pushLiveLeadProcessMessageHelper,
  pushLiveLeadTextMessage as pushLiveLeadTextMessageHelper,
  resetLiveLeadTextBuffer as resetLiveLeadTextBufferHelper,
  shiftProvisioningOutputIndexesAfterRemoval as shiftProvisioningOutputIndexesAfterRemovalHelper,
} from './provisioning/TeamProvisioningLeadProcessMessages';
import { projectLeadRelayReply } from './provisioning/TeamProvisioningLeadRelayProjection';
import {
  getPreCompleteCliErrorTextFromRun,
  getRunTrackedCwdFromRun,
  isCurrentTrackedRunById,
} from './provisioning/TeamProvisioningLeadRunDerivation';
import { captureLeadSendMessages } from './provisioning/TeamProvisioningLeadSendMessageCapture';
import {
  autoAllowLeadControlRequest,
  autoDenyLeadControlRequest,
  createDefaultLeadToolApprovalPorts,
  handleLeadControlRequest,
  respondToLeadToolApproval,
  type TeamProvisioningLeadToolApprovalPorts,
  type TeamProvisioningLeadToolApprovalResponsePorts,
} from './provisioning/TeamProvisioningLeadToolApproval';
import { extractLogsTail, sliceClaudeLogs } from './provisioning/TeamProvisioningLogSlice';
import { matchesObservedMemberNameForExpected } from './provisioning/TeamProvisioningMemberIdentity';
import {
  type LiveRosterAttachReason,
  type MemberLifecycleOperation,
  type MemberLifecycleOperationKind,
  TeamProvisioningMemberLifecycleController,
  type TeamProvisioningMemberLifecycleHost,
} from './provisioning/TeamProvisioningMemberLifecycle';
import { TeamProvisioningMemberMcpLaunchConfigProvisioner } from './provisioning/TeamProvisioningMemberMcpLaunchConfig';
import {
  isMemberSpawnHeartbeatTimestampNewer,
  type MemberSpawnInboxCursor,
} from './provisioning/TeamProvisioningMemberSpawnCursor';
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
  type MemberSpawnStatusesSnapshotPorts,
  type MemberSpawnStatusMutationPorts,
  setMemberSpawnStatusForRun,
} from './provisioning/TeamProvisioningMemberSpawnSnapshots';
import {
  buildRestartGraceTimeoutReason,
  createInitialMemberSpawnStatusEntry,
  MEMBER_LAUNCH_GRACE_MS,
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
import {
  buildEffectiveTeamMemberSpec,
  normalizeTeamMemberProviderId,
  teamRequestIncludesCodexMember,
} from './provisioning/TeamProvisioningMemberSpecs';
import {
  buildLaunchMemberSpawnStatus,
  buildRuntimeSpawnStatusRecord as buildRuntimeSpawnStatusRecordHelper,
  filterRemovedMembersFromLaunchSnapshot,
  findConfiguredMemberModel,
  findEffectiveRunMember,
  findEffectiveRunMemberModel,
  findMetaMemberModel,
  findTrackedMemberSpawnStatus,
  getFailedSpawnMembersFromStatuses,
  isLaunchMemberStatusRelevantToRuntimeRun,
  isMemberRemovedInMeta,
  projectPendingRestartStatusForSnapshot as projectPendingRestartStatusForSnapshotHelper,
  resolveEffectiveConfiguredMember,
  resolveLeadMemberName,
  shouldPreferCurrentLaunchMemberStatus,
} from './provisioning/TeamProvisioningMemberStatusProjection';
import {
  hasAcceptedLeadWorkSyncReport as hasAcceptedLeadWorkSyncReportHelper,
  hasAcceptedMemberWorkSyncReport as hasAcceptedMemberWorkSyncReportHelper,
  type MemberWorkSyncAcceptedReportChecker,
  scheduleLeadProofMissingWorkSyncRecovery as scheduleLeadProofMissingWorkSyncRecoveryHelper,
} from './provisioning/TeamProvisioningMemberWorkSyncProof';
import { setupMixedSecondaryLaneLaunch } from './provisioning/TeamProvisioningMixedSecondaryLaneLaunchSetup';
import {
  launchMixedSecondaryLaneIfNeeded as launchMixedSecondaryLaneIfNeededHelper,
  launchQueuedMixedSecondaryLaneInBackground as launchQueuedMixedSecondaryLaneInBackgroundHelper,
} from './provisioning/TeamProvisioningMixedSecondaryLaunchQueue';
import {
  buildMixedSecondaryLaunchSnapshotForRun as buildMixedSecondaryLaunchSnapshotForRunHelper,
  hasMixedSecondaryLaunchReconcileHeartbeat as hasMixedSecondaryLaunchReconcileHeartbeatHelper,
  selectLatestMixedSecondaryLaunchReconcileMessage as selectLatestMixedSecondaryLaunchReconcileMessageHelper,
  shouldRecoverStalePersistedMixedLaunchSnapshot as shouldRecoverStalePersistedMixedLaunchSnapshotHelper,
} from './provisioning/TeamProvisioningMixedSecondaryLaunchReconciliation';
import { handleNativeTeammateUserMessage as handleNativeTeammateUserMessageHelper } from './provisioning/TeamProvisioningNativeTeammateMessages';
import { getOpenCodeAgendaSyncRecoveryBypassMessageIds as getOpenCodeAgendaSyncRecoveryBypassMessageIdsHelper } from './provisioning/TeamProvisioningOpenCodeAgendaSyncRecovery';
import {
  createOpenCodeAggregateProvisioningRun as createOpenCodeAggregateProvisioningRunHelper,
  type CreateOpenCodeAggregateProvisioningRunParams,
} from './provisioning/TeamProvisioningOpenCodeAggregateRun';
import { resolveOpenCodeInboxAttachmentPayloads as resolveOpenCodeInboxAttachmentPayloadsHelper } from './provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapEvidencePorts,
} from './provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import {
  buildOpenCodeSecondaryBootstrapStallDiagnostic as buildOpenCodeSecondaryBootstrapStallDiagnosticHelper,
  isOpenCodeBootstrapStallWindowElapsed as isOpenCodeBootstrapStallWindowElapsedHelper,
  markOpenCodeSecondaryBootstrapStalled as markOpenCodeSecondaryBootstrapStalledHelper,
  type MarkOpenCodeSecondaryBootstrapStalledPorts,
  maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt as maybeSendOpenCodeSecondaryBootstrapCheckinRetryPromptHelper,
  type OpenCodeBootstrapStallStatusPorts,
  type ReconcileOpenCodeRuntimeProcessBootstrapPorts,
  reconcileOpenCodeRuntimeProcessBootstrapStatus as reconcileOpenCodeRuntimeProcessBootstrapStatusHelper,
  scheduleOpenCodeBootstrapStallReevaluation as scheduleOpenCodeBootstrapStallReevaluationHelper,
  setOpenCodeRuntimePendingBootstrapStatus as setOpenCodeRuntimePendingBootstrapStatusHelper,
  setOpenCodeSecondaryBootstrapStalledStatus as setOpenCodeSecondaryBootstrapStalledStatusHelper,
} from './provisioning/TeamProvisioningOpenCodeBootstrapStall';
import {
  boundOpenCodeAppManagedBriefingText,
  isPersistedOpenCodeSecondaryLaneMember,
  promoteOpenCodePersistedFailureReasonsFromDiagnostics,
} from './provisioning/TeamProvisioningOpenCodeDiagnosticsPolicy';
import { resolveOpenCodeMemberIdentityFromDirectory as resolveOpenCodeMemberIdentityFromDirectoryHelper } from './provisioning/TeamProvisioningOpenCodeMemberIdentity';
import {
  buildOpenCodeInboxReadFailedResult,
  buildOpenCodeMemberInboxAlreadyReadResult,
  buildOpenCodeMemberInboxMessageMissingResult,
  buildOpenCodeMemberInboxQueuedBehindResult,
  buildOpenCodeMemberInboxRelayTimeoutResult,
  buildOpenCodeMemberWorkSyncReadWaitingResult,
  commitOpenCodeInboxRelayReadAfterDelivery,
  createOpenCodeMemberInboxRelayResult,
  dedupeOpenCodeMemberInboxRelayDiagnostics,
  handleOpenCodeInboxAttachmentFailure,
  type OpenCodeMemberInboxRelayOptions,
  type OpenCodeMemberInboxRelayResult,
  projectOpenCodeInboxDeliveryFailure,
  resolveOpenCodeMemberInboxDeliveryDecision,
  selectOpenCodeMemberInboxRelayUnreadMessages,
} from './provisioning/TeamProvisioningOpenCodeMemberInboxRelay';
import { OpenCodeMemberSendSerializer } from './provisioning/TeamProvisioningOpenCodeMemberSendSerialization';
import { type OpenCodeRuntimeControlAck } from './provisioning/TeamProvisioningOpenCodeRuntimeCheckin';
import { materializeOpenCodeRuntimeAdapterDefaults as materializeOpenCodeRuntimeAdapterDefaultsHelper } from './provisioning/TeamProvisioningOpenCodeRuntimeDefaults';
import { createTeamProvisioningOpenCodeRuntimeDeliveryBoundary } from './provisioning/TeamProvisioningOpenCodeRuntimeDelivery';
import {
  type MemberWorkSyncProofMissingRecoveryScheduler,
  TeamProvisioningOpenCodeRuntimeDeliveryAdvisory,
} from './provisioning/TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import {
  appendDiagnosticOnce,
  applyOpenCodeSecondaryBootstrapStallOverlay as applyOpenCodeSecondaryBootstrapStallOverlayHelper,
  buildOpenCodeSecondaryLaneTimingDiagnostic,
  collectOpenCodeSecondaryLaneFailureDiagnostics,
  createUnexpectedMixedSecondaryLaneFailureResult,
  getOpenCodeSecondaryBootstrapPendingMemberNames as getOpenCodeSecondaryBootstrapPendingMemberNamesHelper,
  getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted,
  isBootstrapMemberEvidenceCurrentForMember,
  isDefinitiveOpenCodePreLaunchFailure,
  isRecoverableOpenCodeBootstrapPendingLaunchResult,
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
  MEMBER_BOOTSTRAP_STALL_MS,
  normalizeRecoverableOpenCodeBootstrapPendingLaunchResult,
  promoteCommittedOpenCodeAppManagedBootstrapEvidence,
  shouldMarkPersistedOpenCodeBootstrapStalled,
  summarizeRuntimeLaunchResultMembers,
  toOpenCodePersistedLaunchMember as toOpenCodePersistedLaunchMemberHelper,
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
import {
  findPersistedLaunchMemberForLane as findPersistedLaunchMemberForLaneHelper,
  type OpenCodeRuntimePendingPermissionsPersistencePorts,
  type OpenCodeRuntimePermissionListingAdapter,
  type OpenCodeRuntimePermissionSpawnStatusPorts,
  type OpenCodeRuntimePermissionSyncInput,
  persistOpenCodeRuntimePendingPermissions,
  syncOpenCodeRuntimePermissionsAfterDelivery,
  syncOpenCodeRuntimePermissionSpawnStatusesForTrackedRun,
} from './provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import {
  type OpenCodeRuntimeLaneRecoveryPorts,
  resolveOpenCodeRuntimeLaneId as resolveOpenCodeRuntimeLaneIdHelper,
  tryRecoverOpenCodeRuntimeLaneBeforeDelivery as tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery as tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery as tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper,
  tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog as tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdogHelper,
} from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryFlow';
import { createOpenCodeRuntimeRecoveryIdentityHelpers } from './provisioning/TeamProvisioningOpenCodeRuntimeRecoveryIdentity';
import {
  stopMixedSecondaryRuntimeLanes as stopMixedSecondaryRuntimeLanesHelper,
  stopOpenCodeRuntimeAdapterTeam as stopOpenCodeRuntimeAdapterTeamHelper,
  stopSingleMixedSecondaryRuntimeLane as stopSingleMixedSecondaryRuntimeLaneHelper,
} from './provisioning/TeamProvisioningOpenCodeRuntimeStopFlow';
import {
  type AuthWarningSource,
  buildStallProgressMessage,
  buildStallWarningText,
  extractApiErrorSnippet,
  hasApiError,
  isAuthFailureWarning,
  isQuotaRetryMessage,
  normalizeApiRetryErrorMessage,
  toMarkdownCodeSafe,
} from './provisioning/TeamProvisioningOutputErrorPolicy';
import { createTeamProvisioningOutputRecoveryHelper } from './provisioning/TeamProvisioningOutputRecovery';
import {
  combinePersistedLaunchSnapshotWriteDecisions,
  decideFinalReconciledSnapshotWrite,
  decidePreferredBootstrapSnapshot,
  filterOptionalRemovedMembersFromLaunchSnapshot,
  getCommittedEvidenceOverlayWriteDecision,
  getPromotionCleanupWriteDecision,
  projectEmptyPersistedLaunchReconciliationResult,
  projectPersistedLaunchReconciliationResult,
  shouldReturnSnapshotBeforeRuntimeReconcileFromPorts,
} from './provisioning/TeamProvisioningPersistedLaunchReconciliation';
import {
  listPersistedTeamNames as listPersistedTeamNamesHelper,
  type PersistedTeamConfigCacheEntry,
  readPersistedRuntimeMembers as readPersistedRuntimeMembersHelper,
  readPersistedTeamProjectPath as readPersistedTeamProjectPathHelper,
} from './provisioning/TeamProvisioningPersistedTeamConfigAccess';
import {
  type CachedProbeResult,
  createDefaultTeamProvisioningPrepareCoordinatorPorts,
  type PrepareForProvisioningOptions,
  type ProbeResult,
  TeamProvisioningPrepareCoordinator,
} from './provisioning/TeamProvisioningPrepareCoordinator';
import {
  handleProvisioningProcessExit,
  pathExists as provisioningPathExists,
  tryCompleteAfterTimeout as tryCompleteAfterTimeoutHelper,
  waitForMissingInboxes as waitForMissingInboxesHelper,
  waitForTeamInList as waitForTeamInListHelper,
} from './provisioning/TeamProvisioningProcessExit';
import {
  appendProvisioningTrace,
  boundRunProvisioningOutputParts,
  boundStdoutParserCarry,
  buildProvisioningLiveOutput,
  emitProvisioningCheckpoint,
  initializeProvisioningTrace,
} from './provisioning/TeamProvisioningProgressBuffers';
import {
  isTerminalFailureProvisioningState,
  looksLikeClaudeStdoutJsonFragment,
  shouldIgnoreProvisioningProgressRegression,
  TeamProvisioningRetainedProgressState,
} from './provisioning/TeamProvisioningProgressState';
import {
  buildDeterministicLaunchHydrationPrompt,
  buildGeminiPostLaunchHydrationPrompt,
  buildPersistentLeadContext,
  buildTaskBoardSnapshot,
  extractBootstrapFailureReason,
  getCanonicalSendMessageFieldRule,
  getCanonicalSendMessageToolRule,
} from './provisioning/TeamProvisioningPromptBuilders';
import { PREFLIGHT_AUTH_RETRY_DELAY_MS } from './provisioning/TeamProvisioningProviderDiagnostics';
import { getCliHelpOutputForProvisioning } from './provisioning/TeamProvisioningProviderPreflight';
import {
  createTeamProvisioningProviderRuntimeFacade,
  type TeamProvisioningProviderRuntimeFacade,
} from './provisioning/TeamProvisioningProviderRuntimeFacade';
import {
  buildRetainedClaudeLogsSnapshot,
  extractCliLogsFromRun,
  type RetainedClaudeLogsSnapshot,
} from './provisioning/TeamProvisioningRetainedLogs';
import { TeamProvisioningRuntimeAdapterProgressState } from './provisioning/TeamProvisioningRuntimeAdapterProgressState';
import {
  createMixedSecondaryLaneStates as createMixedSecondaryLaneStatesHelper,
  createOpenCodeMemberMessageDeliveryService as createOpenCodeMemberMessageDeliveryServiceHelper,
  createOpenCodeRuntimeBootstrapEvidencePorts as createOpenCodeRuntimeBootstrapEvidencePortsHelper,
  deliverOpenCodeMemberMessage as deliverOpenCodeMemberMessageHelper,
  planRuntimeLanesOrThrow as planRuntimeLanesOrThrowHelper,
  shouldRouteOpenCodeToRuntimeAdapter as shouldRouteOpenCodeToRuntimeAdapterHelper,
} from './provisioning/TeamProvisioningRuntimeBootstrapDelivery';
import {
  buildRuntimeLaunchWarning,
  getAnthropicFastModeDefault,
  getPromptSizeSummary,
  getTeamProviderLabel,
  logRuntimeLaunchSnapshot,
} from './provisioning/TeamProvisioningRuntimeDiagnostics';
import {
  buildMissingCliError,
  getRuntimeFailureLabelForRequest,
} from './provisioning/TeamProvisioningRuntimeFailureLabels';
import {
  buildProviderModelLaunchIdentity as buildProviderModelLaunchIdentityHelper,
  buildTeamRuntimeLaunchArgsPlan as buildTeamRuntimeLaunchArgsPlanHelper,
  getLaunchModelArg,
  getTeamsBasePathsToProbe,
  logsSuggestShutdownOrCleanup,
  type RuntimeProviderLaunchFacts,
  type TeamRuntimeLaunchArgsPlan,
  type TeamsBaseLocation,
  validateRuntimeLaunchSelection as validateRuntimeLaunchSelectionHelper,
  type ValidConfigProbeResult,
} from './provisioning/TeamProvisioningRuntimeLaunchSelection';
import {
  mergeRuntimeDiagnostics,
  normalizeRuntimePositiveInteger,
} from './provisioning/TeamProvisioningRuntimeMetadata';
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
  buildLiveTeamAgentRuntimeMetadata as buildLiveTeamAgentRuntimeMetadataHelper,
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
} from './provisioning/TeamProvisioningRuntimeSnapshot';
import { TeamProvisioningRuntimeSnapshotCacheBoundary } from './provisioning/TeamProvisioningRuntimeSnapshotCache';
import { createRuntimeToolActivityHandlers } from './provisioning/TeamProvisioningRuntimeToolActivity';
import { answerOpenCodeRuntimeToolApproval } from './provisioning/TeamProvisioningRuntimeToolApprovalAnswer';
import {
  buildRuntimeTurnSettledEnvironmentForMembers as buildRuntimeTurnSettledEnvironmentForMembersHelper,
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
import { scanForNewestProjectSession } from './provisioning/TeamProvisioningSessionDiscovery';
import { createTeamProvisioningShutdownCoordination } from './provisioning/TeamProvisioningShutdownCoordination';
import {
  stopAllTeamsFlow,
  stopPersistentTeamMembersFlow,
  stopTeamFlow,
} from './provisioning/TeamProvisioningStopFlow';
import {
  killOrphanedTeamAgentProcesses as killOrphanedTeamAgentProcessesHelper,
  killPersistedPaneMembers as killPersistedPaneMembersHelper,
} from './provisioning/TeamProvisioningStopProcessCleanup';
import {
  handleDeterministicBootstrapEvent,
  handleTeamProvisioningStreamJsonMessage,
  shouldAcceptDeterministicBootstrapEvent,
  type TeamProvisioningStreamEventPorts,
} from './provisioning/TeamProvisioningStreamEvents';
import { captureTeamSpawnEvents as captureTeamSpawnEventsHelper } from './provisioning/TeamProvisioningStreamSpawnEvents';
import {
  readTaskActivityRepairLaunchSnapshot as readTaskActivityRepairLaunchSnapshotHelper,
  repairStaleTaskActivityIntervalsBeforeSnapshot as repairStaleTaskActivityIntervalsBeforeSnapshotHelper,
  repairStaleTaskActivityIntervalsOnce as repairStaleTaskActivityIntervalsOnceHelper,
  writeLaunchFailureArtifactPackBestEffort as writeLaunchFailureArtifactPackBestEffortHelper,
} from './provisioning/TeamProvisioningTaskActivityRepair';
import {
  handleTeammatePermissionRequest as handleTeammatePermissionRequestHelper,
  type TeamProvisioningTeammatePermissionRequestPorts,
} from './provisioning/TeamProvisioningTeammatePermissionRequest';
import {
  respondToTeammatePermission as respondToTeammatePermissionHelper,
  type TeamProvisioningTeammatePermissionResponsePorts,
} from './provisioning/TeamProvisioningTeammatePermissionResponse';
import {
  buildLeadToolApprovalDecisionPayload,
  buildTeammateToolApprovalRequest,
  buildToolApprovalAutoResolvedEvent,
} from './provisioning/TeamProvisioningToolApprovalFlow';
import {
  type TeamProvisioningToolApprovalNotification,
  type TeamProvisioningToolApprovalNotificationConstructor,
  TeamProvisioningToolApprovalNotifications,
} from './provisioning/TeamProvisioningToolApprovalNotifications';
import { TeamProvisioningToolApprovalTimeouts } from './provisioning/TeamProvisioningToolApprovalTimeouts';
import { TeamProvisioningTranscriptClaudeLogsCache } from './provisioning/TeamProvisioningTranscriptClaudeLogs';
import {
  createTeamProvisioningTransientRunStatePorts,
  TeamProvisioningTransientRunState,
} from './provisioning/TeamProvisioningTransientRunState';
import {
  handleTeamProvisioningTurnComplete,
  type TeamProvisioningTurnCompletePorts,
} from './provisioning/TeamProvisioningTurnComplete';
import {
  collectWorkspaceTrustProviders as collectWorkspaceTrustProvidersHelper,
  collectWorkspaceTrustWorkspaces as collectWorkspaceTrustWorkspacesHelper,
  createDefaultModelWorkspaceTrustProviderArgsResolver as createDefaultModelWorkspaceTrustProviderArgsResolverHelper,
  planWorkspaceTrustArgsOnlySafely as planWorkspaceTrustArgsOnlySafelyHelper,
  planWorkspaceTrustFullSafely as planWorkspaceTrustFullSafelyHelper,
  prepareWorkspaceTrustForDeterministicRun as prepareWorkspaceTrustForDeterministicRunHelper,
} from './provisioning/TeamProvisioningWorkspaceTrust';
import {
  buildWorkspaceTrustLaunchArgs as buildWorkspaceTrustLaunchArgsHelper,
} from './provisioning/TeamProvisioningWorkspaceTrustLaunchArgs';
import { createNodeWorkspaceTrustWorkspaceCollectionPorts } from './provisioning/TeamProvisioningWorkspaceTrustNodePorts';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { atomicWriteAsync } from './atomicWrite';
import { peekAutoResumeService } from './AutoResumeService';
import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import { getConfiguredCliCommandLabel } from './cliFlavor';
import { withFileLock } from './fileLock';
import { withInboxLock } from './inboxLock';
import { type ProcessBootstrapTransportSummary } from './ProcessBootstrapTransportEvidence';
import {
  boundLaunchDiagnostics,
  boundProgressAssistantParts,
  buildProgressLogsTail,
} from './progressPayload';
import {
  applyDesktopTeammateModeDecisionToEnv,
  resolveDesktopTeammateModeDecision,
} from './runtimeTeammateMode';
import { TeamAttachmentStore } from './TeamAttachmentStore';
import {
  choosePreferredLaunchSnapshot,
  clearBootstrapState,
  readBootstrapLaunchSnapshot,
  readBootstrapRealTaskSubmissionState,
  readBootstrapRuntimeState,
} from './TeamBootstrapStateReader';
import { TeamConfigReader } from './TeamConfigReader';
import { TeamInboxReader } from './TeamInboxReader';
import { TeamInboxWriter } from './TeamInboxWriter';
import { writeTeamLaunchFailureArtifactPack } from './TeamLaunchFailureArtifactPack';
import {
  createPersistedLaunchSnapshot,
  deriveTeamLaunchAggregateState,
  snapshotFromRuntimeMemberStatuses,
  snapshotToMemberSpawnStatuses,
} from './TeamLaunchStateEvaluator';
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
import type {
  RuntimeTelemetryProcessTableRow,
  RuntimeUsageProcessTree,
} from './TeamRuntimeTelemetry';

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

/**
 * Kill a team CLI process using SIGKILL (uncatchable).
 *
 * Newer Claude CLI versions (≥2.1.x) handle SIGTERM gracefully and run cleanup
 * that deletes team files (config.json, inboxes/, tasks/). SIGKILL prevents this.
 *
 * ALWAYS use this instead of killProcessTree() for team processes.
 * stdin.end() is also forbidden — EOF triggers the same cleanup.
 */
function killTeamProcess(child: ChildProcess | null | undefined): void {
  killProcessTree(child, 'SIGKILL');
}

import type {
  ActiveToolCall,
  AgentActionMode,
  CrossTeamSendResult,
  EffortLevel,
  InboxMessage,
  LeadContextUsage,
  MemberLaunchState,
  MemberSpawnLivenessSource,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  OpenCodeAppManagedBootstrapCandidate,
  OpenCodeBootstrapEvidenceSource,
  OpenCodeRuntimeDeliveryStatus,
  OpenCodeRuntimeDeliveryUserVisibleImpact,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchPhase,
  PersistedTeamLaunchSnapshot,
  PersistedTeamLaunchSummary,
  ProviderModelLaunchIdentity,
  RetryFailedOpenCodeSecondaryLanesResult,
  TaskRef,
  TeamAgentRuntimeDiagnosticSeverity,
  TeamAgentRuntimeLivenessKind,
  TeamAgentRuntimePidSource,
  TeamAgentRuntimeSnapshot,
  TeamChangeEvent,
  TeamConfig,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamFastMode,
  TeamLaunchAggregateState,
  TeamLaunchDiagnosticItem,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareIssue,
  TeamProvisioningPrepareResult,
  TeamProvisioningProgress,
  TeamProvisioningState,
  TeamRuntimeState,
  TeamTask,
  ToolApprovalEvent,
  ToolApprovalRequest,
  ToolApprovalSettings,
  ToolCallMeta,
} from '@shared/types';

export { shouldAcceptDeterministicBootstrapEvent };

const logger = createLogger('Service:TeamProvisioning');
const {
  AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
  AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
  createController,
} = agentTeamsControllerModule;
const VERIFY_TIMEOUT_MS = 15_000;

const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT = 100;
// Progress emissions fan out the latest CLI tail + assistant output to the
// renderer over IPC. Under load the previous 300ms cadence combined with an
// unbounded payload (see `emitLogsProgress`) caused renderer OOM crashes
// (about 3 full-history serializations per second, each holding thousands of
// lines). The tail cap in `emitLogsProgress` bounds each payload; we also
// slow the cadence to ~1s so Zustand can keep up on large teams.
const LOG_PROGRESS_THROTTLE_MS = 1000;
const STALL_CHECK_INTERVAL_MS = 10_000;
const STALL_WARNING_THRESHOLD_MS = 20_000;
const APP_TEAM_RUNTIME_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop';
const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;
const MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS = 1_500;

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

const DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS = 12_000;

interface ProvisioningRun {
  runId: string;
  teamName: string;
  startedAt: string;
  progress: TeamProvisioningProgress;
  stdoutBuffer: string;
  stderrBuffer: string;
  /** Rolling buffer of CLI log lines (oldest -> newest). */
  claudeLogLines: string[];
  /** Last stream used for claudeLogLines markers. */
  lastClaudeLogStream: 'stdout' | 'stderr' | null;
  /** Carry buffer for stdout line splitting (CLI output). */
  stdoutLogLineBuf: string;
  /** Carry buffer for stderr line splitting (CLI output). */
  stderrLogLineBuf: string;
  /** Raw stdout parser carry that has not been newline-delimited yet. */
  stdoutParserCarry: string;
  /** Whether the current stdout parser carry is a complete JSON fragment. */
  stdoutParserCarryIsCompleteJson: boolean;
  /** Whether the current stdout parser carry looks like Claude stream-json structure. */
  stdoutParserCarryLooksLikeClaudeJson: boolean;
  /** ISO timestamp when the last CLI line was recorded. */
  claudeLogsUpdatedAt?: string;
  /** ISO timestamp when the first accepted deterministic bootstrap event arrived. */
  deterministicBootstrapStartedAt?: string;
  /** Latest accepted deterministic bootstrap event name. */
  lastDeterministicBootstrapEvent?: string;
  /** Latest accepted deterministic bootstrap phase name. */
  lastDeterministicBootstrapPhase?: string;
  /** True after deterministic bootstrap reports that teammate spawning started. */
  deterministicBootstrapMemberSpawnSeen: boolean;
  /** True after deterministic bootstrap reports at least one teammate spawn result. */
  deterministicBootstrapMemberResultSeen: boolean;
  processKilled: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  teamsBasePathsToProbe: { location: TeamsBaseLocation; basePath: string }[];
  child: ReturnType<typeof spawn> | null;
  timeoutHandle: NodeJS.Timeout | null;
  fsMonitorHandle: NodeJS.Timeout | null;
  onProgress: (progress: TeamProvisioningProgress) => void;
  expectedMembers: string[];
  request: TeamCreateRequest;
  allEffectiveMembers: TeamCreateRequest['members'];
  effectiveMembers: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  mixedSecondaryLanes: MixedSecondaryRuntimeLaneState[];
  /**
   * OpenCode secondary lanes share bridge state files. Launch them sequentially
   * per team run to avoid file-lock contention while keeping launch non-blocking.
   */
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
  lastLogProgressAt: number;
  /** Monotonic ms timestamp of last stdout/stderr data. For stall detection. */
  lastDataReceivedAt: number;
  /** Monotonic ms timestamp of last stdout data only. Stall watchdog uses this
   *  instead of lastDataReceivedAt because stderr emits periodic debug logs
   *  that reset the timer without producing any user-visible output. */
  lastStdoutReceivedAt: number;
  /** Stall watchdog interval handle. Cleared in cleanupRun(). */
  stallCheckHandle: NodeJS.Timeout | null;
  /** Index of the current stall warning in provisioningOutputParts.
   *  Used to replace in-place instead of pushing duplicates. */
  stallWarningIndex: number | null;
  /** The progress.message before the stall watchdog overwrote it.
   *  Restored when stdout resumes and the stall warning is cleared. */
  preStallMessage: string | null;
  /** Monotonic ms timestamp of last api_retry message. When set, the stall
   *  watchdog defers to retry messages for progress.message (retries are
   *  more informative than the generic "CLI not responding" stall text). */
  lastRetryAt: number;
  /** Index of the latest api_retry warning block in provisioningOutputParts. */
  apiRetryWarningIndex: number | null;
  /** True after emitApiErrorWarning() fires once — prevents duplicate warnings and pre-complete false positives. */
  apiErrorWarningEmitted: boolean;
  fsPhase: 'waiting_config' | 'waiting_members' | 'waiting_tasks' | 'all_files_found';
  waitingTasksSince: number | null;
  provisioningComplete: boolean;
  processClosed: boolean;
  requiresFirstRealTurnSuccess: boolean;
  firstRealTurnSucceeded: boolean;
  /** Path to the generated MCP config file for later cleanup. */
  mcpConfigPath: string | null;
  /** Paths to per-member generated MCP config files consumed by deterministic bootstrap. */
  memberMcpConfigPaths: string[];
  /** Path to the deterministic bootstrap spec file for later cleanup. */
  bootstrapSpecPath: string | null;
  /** Path to the deferred first-user-task file consumed by runtime after bootstrap. */
  bootstrapUserPromptPath: string | null;
  isLaunch: boolean;
  launchStateClearedForRun: boolean;
  deterministicBootstrap: boolean;
  launchCleanupStateFinalized?: boolean;
  workspaceTrustPlan?: WorkspaceTrustFullPlanResult | null;
  workspaceTrustExecution?: WorkspaceTrustExecutionResult | null;
  workspaceTrustDiagnostics?: WorkspaceTrustDiagnosticsManifest | null;
  workspaceTrustRetryAttempted?: boolean;
  leadRelayCapture: {
    leadName: string;
    startedAt: string;
    textParts: string[];
    textJoinMode?: 'block' | 'stream';
    replyVisibility?: 'user' | 'internal_activity';
    hasVisibleSendMessage?: boolean;
    hasUserVisibleSendMessage?: boolean;
    settled: boolean;
    idleHandle: NodeJS.Timeout | null;
    idleMs: number;
    resolveOnce: (text: string) => void;
    rejectOnce: (error: string) => void;
    timeoutHandle: NodeJS.Timeout;
  } | null;
  activeCrossTeamReplyHints: {
    toTeam: string;
    conversationId: string;
  }[];
  /** Monotonic counter for individual lead assistant messages. */
  leadMsgSeq: number;
  /** Active text bubble for token-streamed lead assistant output. */
  liveLeadTextBuffer: {
    messageId: string;
    text: string;
    timestamp: string;
    toolCalls?: ToolCallMeta[];
    toolSummary?: string;
  } | null;
  /** Accumulated tool_use details between text messages. */
  pendingToolCalls: ToolCallMeta[];
  /** Active runtime tool calls keyed by tool_use_id. */
  activeToolCalls: Map<string, ActiveToolCall>;
  /** True when a direct MCP cross_team_send happened and sentMessages history should refresh. */
  pendingDirectCrossTeamSendRefresh: boolean;
  /** Throttle timestamp for emitting inbox refresh events for lead text. */
  lastLeadTextEmitMs: number;
  /**
   * When set, the current stdin-injected turn is an internal "forward user DM to teammate"
   * request triggered by the UI. We suppress any lead→user echo for that turn.
   */
  silentUserDmForward: {
    target: string;
    startedAt: string;
    mode: 'user_dm' | 'member_inbox_relay';
  } | null;
  /** Safety valve: clears silentUserDmForward if turn never completes. */
  silentUserDmForwardClearHandle: NodeJS.Timeout | null;
  /** Exact inbox rows currently being bridged into the live teammate process. */
  pendingInboxRelayCandidates: PendingInboxRelayCandidate[];
  /** Accumulates assistant text during provisioning phase for live UI preview. */
  provisioningOutputParts: string[];
  /** Bounded orchestration checkpoints shown in the Live output panel. */
  provisioningTraceLines: string[];
  /** Last emitted trace key, used to avoid duplicate progress spam. */
  lastProvisioningTraceKey: string | null;
  /** Stable assistant message ids -> provisioningOutputParts index for in-place updates. */
  provisioningOutputIndexByMessageId: Map<string, number>;
  /** Session ID detected from stream-json output (result.session_id or message.session_id). */
  detectedSessionId: string | null;
  /** Lead process activity: 'active' during turn processing, 'idle' waiting for input, 'offline' after exit. */
  leadActivityState: LeadActivityState;
  /** Whether an auth failure retry was already attempted for this run. */
  authFailureRetried: boolean;
  /** Set to true while auth-failure respawn is in progress to prevent duplicate handling. */
  authRetryInProgress: boolean;
  /** Tracks lead process context window usage from stream-json usage data. */
  leadContextUsage: {
    promptInputTokens: number | null;
    outputTokens: number | null;
    contextUsedTokens: number | null;
    contextWindowTokens: number | null;
    promptInputSource: LeadContextUsage['promptInputSource'];
    lastUsageMessageId: string | null;
    lastEmittedAt: number;
  } | null;
  /** Saved spawn context for auth-failure respawn. */
  spawnContext: {
    claudePath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
  } | null;
  /** Run-scoped helper material used by Anthropic API-key team runtimes. */
  anthropicApiKeyHelper: AnthropicTeamApiKeyHelperMaterial | null;
  /** Pending tool approval requests awaiting user response (control_request protocol). */
  pendingApprovals: Map<string, ToolApprovalRequest>;
  /** Teammate permission_request IDs already intercepted (prevents re-processing read messages). */
  processedPermissionRequestIds: Set<string>;
  /**
   * Post-compact context reinjection lifecycle.
   * - pendingPostCompactReminder: compact_boundary was received; waiting for idle to inject.
   * - postCompactReminderInFlight: the reminder turn has been injected via stdin, waiting for result.
   * - suppressPostCompactReminderOutput: true while processing a reminder turn - suppress
   *   low-value context-refresh acknowledgement text.
   */
  pendingPostCompactReminder: boolean;
  postCompactReminderInFlight: boolean;
  suppressPostCompactReminderOutput: boolean;
  /** Gemini-only phase-2 launch hydration after the first successful provisioning turn. */
  pendingGeminiPostLaunchHydration: boolean;
  geminiPostLaunchHydrationInFlight: boolean;
  geminiPostLaunchHydrationSent: boolean;
  suppressGeminiPostLaunchHydrationOutput: boolean;
  /** Per-member spawn lifecycle statuses tracked from stream-json output. */
  memberSpawnStatuses: Map<string, MemberSpawnStatusEntry>;
  /** Agent tool_use_id -> teammate name for persistent teammate spawns. */
  memberSpawnToolUseIds: Map<string, string>;
  /** Explicit restart requests awaiting teammate rejoin or failure. */
  pendingMemberRestarts: Map<string, PendingMemberRestartContext>;
  /** Per-member latest processed lead-inbox bootstrap signal cursor for the current live run. */
  memberSpawnLeadInboxCursorByMember: Map<string, MemberSpawnInboxCursor>;
  /** Highest accepted deterministic bootstrap event sequence for this run. */
  lastDeterministicBootstrapSeq: number;
  /** Throttles config/inbox audit work triggered by frequent status polling. */
  lastMemberSpawnAuditAt: number;
  /** Throttles repeated audit warnings when config.json is temporarily unreadable. */
  lastMemberSpawnAuditConfigReadWarningAt: number;
  /** Per-member warning throttle for repeated "missing from config" logs. */
  lastMemberSpawnAuditMissingWarningAt: Map<string, number>;
  /** Prevents duplicate Team Launched notifications for the same live run. */
  teamLaunchedNotificationFired?: boolean;
}

function nowIso(): string {
  return new Date().toISOString();
}

interface PendingMemberRestartContext {
  requestedAt: string;
  desired: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'isolation' | 'providerId' | 'model' | 'effort'
  >;
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

/** @deprecated Use wrapAgentBlock from @shared/constants/agentBlocks instead. */
const wrapInAgentBlock = wrapAgentBlock;

function updateProgress(
  run: ProvisioningRun,
  state: Exclude<TeamProvisioningState, 'idle'>,
  message: string,
  extras?: Pick<
    TeamProvisioningProgress,
    | 'pid'
    | 'error'
    | 'warnings'
    | 'cliLogsTail'
    | 'configReady'
    | 'messageSeverity'
    | 'launchDiagnostics'
  >
): TeamProvisioningProgress {
  if (shouldIgnoreProvisioningProgressRegression(run.progress.state, state)) {
    return run.progress;
  }

  // Cap assistant output on every progress tick. `updateProgress` is invoked
  // from ~20 event-driven sites (auth retries, stall warnings, spawn events),
  // and an unbounded `provisioningOutputParts.join` was part of the same OOM
  // class that `emitLogsProgress` already guards against.
  appendProvisioningTrace(run, state, message, buildProvisioningTraceDetail(extras));
  const assistantOutput = buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput;
  run.progress = {
    ...run.progress,
    state,
    message,
    updatedAt: nowIso(),
    pid: extras?.pid ?? run.progress.pid,
    error: extras?.error,
    warnings: extras?.warnings,
    cliLogsTail: extras?.cliLogsTail ?? run.progress.cliLogsTail,
    assistantOutput,
    configReady: extras?.configReady ?? run.progress.configReady,
    messageSeverity: extras?.messageSeverity,
    launchDiagnostics: boundLaunchDiagnostics(
      extras?.launchDiagnostics ??
        buildLaunchDiagnosticsFromRun(run) ??
        run.progress.launchDiagnostics
    ),
  };
  return run.progress;
}

/**
 * Builds provisioning CLI logs from the line-buffered claudeLogLines array
 * instead of the byte-capped stdoutBuffer/stderrBuffer ring buffers.
 *
 * claudeLogLines already contains [stdout]/[stderr] markers and individual
 * lines in chronological order. The retained in-memory history is byte-bounded
 * so failed launches cannot pin gigabytes in the main-process heap.
 *
 * Returns the bounded launch log history preserved in claudeLogLines. Falls
 * back to the legacy tail extraction only when claudeLogLines is empty (e.g.
 * early in provisioning before any output has been line-split).
 */

/**
 * Emit a throttled progress update for the renderer. Payloads are capped to a
 * tail window so that the hot emission path (called every LOG_PROGRESS_THROTTLE_MS
 * under streaming output) cannot accumulate into multi-megabyte IPC messages
 * that would OOM the renderer's Zustand state. The retained in-process
 * diagnostics are separately byte-bounded on append.
 */
function emitLogsProgress(run: ProvisioningRun): void {
  // Prefer the line-buffered history (already chronological with [stdout]/[stderr]
  // markers) and fall back to the legacy ring-buffer tail only when no lines
  // have been captured yet (early in provisioning).
  const logsTail =
    buildProgressLogsTail(run.claudeLogLines) ??
    extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
  const assistantOutput = buildProvisioningLiveOutput(run);
  const assistantOutputChanged =
    assistantOutput !== undefined && assistantOutput !== run.progress.assistantOutput;

  if (!logsTail && !assistantOutputChanged) {
    return;
  }
  run.progress = {
    ...run.progress,
    updatedAt: nowIso(),
    ...(logsTail !== undefined && { cliLogsTail: logsTail }),
    ...(assistantOutputChanged && { assistantOutput }),
  };
  run.onProgress(run.progress);
}

interface LiveInboxRelayResult {
  kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
  relayed: number;
  diagnostics?: string[];
  lastDelivery?: OpenCodeMemberInboxDelivery;
}

export class TeamProvisioningService {
  private readonly runtimeLaneCoordinator = createTeamRuntimeLaneCoordinator();
  private readonly providerConnectionService = ProviderConnectionService.getInstance();

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
  });
  private readonly runtimeToolApprovalCoordinator = new RuntimeToolApprovalCoordinator({
    getSettings: (teamName) => this.getToolApprovalSettings(teamName),
    answerApproval: ({ entry, allow, message }) =>
      this.answerRuntimeToolApproval(entry, allow, message),
    emitApprovalEvent: (event) => this.emitToolApprovalEvent(event),
    showApprovalNotification: (approval) =>
      this.maybeShowToolApprovalOsNotification(undefined, approval),
    dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
    logWarning: (message) => logger.warn(message),
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
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  private readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  private readonly persistedTranscriptClaudeLogs: TeamProvisioningTranscriptClaudeLogsCache;
  private readonly bootstrapTranscriptOutcomeCache = new Map<
    string,
    BootstrapTranscriptOutcomeCacheEntry
  >();
  // Shared parsed-tail cache keyed by filePath (validated by mtime+size) so the
  // same growing transcript is read + JSON.parsed ONCE per change instead of once
  // per member per poll. The per-member outcome scan below is unchanged.
  private readonly parsedBootstrapTranscriptTailCache = new Map<
    string,
    ParsedBootstrapTranscriptTailCacheEntry
  >();
  private readonly bootstrapTranscriptOutcomeLookupCache = new Map<
    string,
    BootstrapTranscriptOutcomeLookupCacheEntry
  >();
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
  private readonly openCodeRuntimeDeliveryProofReader = new OpenCodeRuntimeDeliveryProofReader();
  private readonly openCodeRuntimeDeliveryAdvisory =
    new TeamProvisioningOpenCodeRuntimeDeliveryAdvisory({
      createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
        this.createOpenCodePromptDeliveryLedger(teamName, laneId),
      readProofIndex: (input) => this.openCodeRuntimeDeliveryProofReader.readProofIndex(input),
      readConfigSnapshot: (teamName) => this.readConfigSnapshot(teamName),
      addTeamNotification: (notification) =>
        NotificationManager.getInstance().addTeamNotification(notification),
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
  private readonly openCodeRuntimePermissionPersistencePorts: OpenCodeRuntimePendingPermissionsPersistencePorts =
    {
      nowIso,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      enqueueLaunchStateStoreOperation: (teamName, operation) =>
        this.enqueueLaunchStateStoreOperation(teamName, operation),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
      writeLaunchStateSnapshot: (teamName, snapshot) =>
        this.writeLaunchStateSnapshotNow(teamName, snapshot),
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
      persistLaunchStateSnapshot: (run, launchPhase) =>
        this.persistLaunchStateSnapshot(run, launchPhase),
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
      this.findBootstrapTranscriptFailureReason(teamName, memberName, sinceMs),
    findBootstrapRuntimeProofObservedAt: (teamName, memberName, current) =>
      this.findBootstrapRuntimeProofObservedAt(teamName, memberName, current),
    findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
      this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
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
  private readonly liveLeadProcessMessages = new Map<string, InboxMessage[]>();
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
  private readonly liveTeamAgentRuntimeMetadataInFlightByTeam = new Map<
    string,
    {
      generationAtStart: number;
      runIdAtStart: string | null;
      promise: Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
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
  private readonly launchStateStoreBoundary = new TeamProvisioningLaunchStateStoreBoundary({
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
  private readonly launchFailureArtifactPackRunIds = new Set<string>();
  private readonly failedOpenCodeSecondaryRetryInFlightByTeam = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this as unknown as TeamProvisioningMemberLifecycleHost
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
  private readonly crashRepairedActivityIntervalsByTeam = new Set<string>();
  private readonly pendingCrashRepairSnapshotByTeam = new Map<
    string,
    PersistedTeamLaunchSnapshot | null
  >();
  private teamChangeEmitter: ((event: TeamChangeEvent) => void) | null = null;
  private helpOutputCache: string | null = null;
  private helpOutputCacheTime = 0;
  private toolApprovalSettingsByTeam = new Map<string, ToolApprovalSettings>();
  private pendingTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly toolApprovalTimeouts: TeamProvisioningToolApprovalTimeouts<ProvisioningRun>;
  private readonly transientRunState: TeamProvisioningTransientRunState;
  private inFlightResponses = new Set<string>();
  private readonly providerRuntime: TeamProvisioningProviderRuntimeFacade;
  private readonly prepareCoordinator: TeamProvisioningPrepareCoordinator;
  private readonly configMaintenance: TeamProvisioningConfigMaintenance;
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
    this.toolApprovalTimeouts = new TeamProvisioningToolApprovalTimeouts<ProvisioningRun>(
      {
        pendingTimeouts: this.pendingTimeouts,
        inFlightResponses: this.inFlightResponses,
      },
      {
        getSettings: (teamName) => this.getToolApprovalSettings(teamName),
        autoAllowControlRequest: (run, requestId) => this.autoAllowControlRequest(run, requestId),
        autoDenyControlRequest: (run, requestId) => this.autoDenyControlRequest(run, requestId),
        respondToTeammatePermission: (run, approval, allow, message) =>
          respondToTeammatePermissionHelper(
            {
              run,
              agentId: approval.source,
              requestId: approval.requestId,
              allow,
              message,
              permissionSuggestions: approval.permissionSuggestions,
              toolName: approval.toolName,
              toolInput: approval.toolInput,
            },
            this.getTeammatePermissionResponsePorts()
          ),
        dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
        emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
        logInfo: (message) => logger.info(message),
      }
    );
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
        getRuntimeTurnSettledHookSettingsProvider: () => this.runtimeTurnSettledHookSettingsProvider,
        logger,
      }),
    });
    this.configMaintenance = new TeamProvisioningConfigMaintenance({
      ports: {
        getTeamsBasePath,
        getProjectsBasePath,
        readRegularFileUtf8: tryReadRegularFileUtf8,
        writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
        unlink: (filePath) => fs.promises.unlink(filePath),
        readDir: (dirPath) => fs.promises.readdir(dirPath),
        stat: (filePath) => fs.promises.stat(filePath),
        withCanonicalInboxLock: (filePath, fn) =>
          withFileLock(filePath, () => withInboxLock(filePath, fn)),
        scanForNewestProjectSession,
        membersMetaStore: this.membersMetaStore,
        invalidateTeam: (teamName) => TeamConfigReader.invalidateTeam(teamName),
        getLanguage: () =>
          ConfigManager.getInstance().getConfig().general.agentLanguage || 'system',
        now: () => Date.now(),
        logger,
      },
      limits: {
        teamJsonReadTimeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        teamConfigMaxBytes: TEAM_CONFIG_MAX_BYTES,
        teamInboxMaxBytes: TEAM_INBOX_MAX_BYTES,
      },
    });
    this.prepareCoordinator = new TeamProvisioningPrepareCoordinator(
      createDefaultTeamProvisioningPrepareCoordinatorPorts({
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
        validatePrepareCwd: (cwd) => this.validatePrepareCwd(cwd),
        getFreshCachedProbeResult: (cwd, providerId) =>
          this.getFreshCachedProbeResult(cwd, providerId),
        clearProbeCache: (cwd, providerId) => this.clearProbeCache(cwd, providerId),
        getCachedOrProbeResult: (cwd, providerId) => this.getCachedOrProbeResult(cwd, providerId),
        verifySelectedProviderModels: (input) => this.verifySelectedProviderModels(input),
        resolveProviderDefaultModel: (
          claudePath,
          cwd,
          providerId,
          env,
          providerArgs,
          limitContext
        ) =>
          this.resolveProviderDefaultModel(
            claudePath,
            cwd,
            providerId,
            env,
            providerArgs,
            limitContext
          ),
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
      })
    );
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
        this.readConfigForObservation(teamName)
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
        hasAcceptedMemberWorkSyncReport: (input) => this.hasAcceptedMemberWorkSyncReport(input),
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

  private readCachedRuntimeProcessRowsForLiveRuntimeMetadata(
    teamName: string,
    runId: string | null
  ): ReturnType<
    TeamProvisioningRuntimeResourceSampling['readCachedRuntimeProcessRowsForLiveRuntimeMetadata']
  > {
    return this.runtimeResourceSampling.readCachedRuntimeProcessRowsForLiveRuntimeMetadata(
      teamName,
      runId
    );
  }

  private buildRuntimeUsageProcessTrees(
    rootPids: readonly number[],
    processRows: readonly RuntimeTelemetryProcessTableRow[] | null,
    rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>
  ): Map<number, RuntimeUsageProcessTree> {
    return this.runtimeResourceSampling.buildRuntimeUsageProcessTrees(
      rootPids,
      processRows,
      rootOwnersByPid
    );
  }

  private buildRuntimeProcessLoadStats(
    input: Parameters<TeamProvisioningRuntimeResourceSampling['buildRuntimeProcessLoadStats']>[0]
  ): ReturnType<TeamProvisioningRuntimeResourceSampling['buildRuntimeProcessLoadStats']> {
    return this.runtimeResourceSampling.buildRuntimeProcessLoadStats(input);
  }

  private recordAgentRuntimeResourceSample(
    input: Parameters<
      TeamProvisioningRuntimeResourceSampling['recordAgentRuntimeResourceSample']
    >[0]
  ): ReturnType<TeamProvisioningRuntimeResourceSampling['recordAgentRuntimeResourceSample']> {
    return this.runtimeResourceSampling.recordAgentRuntimeResourceSample(input);
  }

  private pruneAgentRuntimeResourceHistory(
    teamName: string,
    activeKeys: ReadonlySet<string>
  ): void {
    this.runtimeResourceSampling.pruneAgentRuntimeResourceHistory(teamName, activeKeys);
  }

  private findOpenCodeVisibleReplyByRelayOfMessageId(
    input: Parameters<OpenCodeVisibleReplyProofService['findByRelayOfMessageId']>[0]
  ): ReturnType<OpenCodeVisibleReplyProofService['findByRelayOfMessageId']> {
    return this.openCodeVisibleReplyProofService.findByRelayOfMessageId(input);
  }

  private buildStallProgressMessage(
    silenceSec: number,
    elapsed: string
  ): ReturnType<typeof buildStallProgressMessage> {
    return buildStallProgressMessage(silenceSec, elapsed);
  }

  private buildStallWarningText(
    silenceSec: number,
    request: Parameters<typeof buildStallWarningText>[1]
  ): ReturnType<typeof buildStallWarningText> {
    return buildStallWarningText(silenceSec, request);
  }

  private getLeadRelayReadCommitBatch(
    input: Omit<
      Parameters<typeof getLeadRelayReadCommitBatch>[0],
      'hasAcceptedLeadWorkSyncReport' | 'scheduleLeadProofMissingWorkSyncRecovery'
    > &
      Partial<
        Pick<
          Parameters<typeof getLeadRelayReadCommitBatch>[0],
          'hasAcceptedLeadWorkSyncReport' | 'scheduleLeadProofMissingWorkSyncRecovery'
        >
      >
  ): ReturnType<typeof getLeadRelayReadCommitBatch> {
    return getLeadRelayReadCommitBatch({
      ...input,
      hasAcceptedLeadWorkSyncReport:
        input.hasAcceptedLeadWorkSyncReport ??
        ((report) => this.hasAcceptedLeadWorkSyncReport(report)),
      scheduleLeadProofMissingWorkSyncRecovery:
        input.scheduleLeadProofMissingWorkSyncRecovery ??
        ((recoveryInput) => this.scheduleLeadProofMissingWorkSyncRecovery(recoveryInput)),
    });
  }

  private handleDeterministicBootstrapEvent(
    run: ProvisioningRun,
    msg: Record<string, unknown>
  ): ReturnType<typeof handleDeterministicBootstrapEvent> {
    return handleDeterministicBootstrapEvent(run, msg, this.getStreamJsonEventPorts());
  }

  private launchDirectProcessMemberRestart(
    input: Parameters<
      TeamProvisioningMemberLifecycleController['launchDirectProcessMemberRestartInternal']
    >[0]
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['launchDirectProcessMemberRestartInternal']
  > {
    return this.memberLifecycleController.launchDirectProcessMemberRestartInternal(input);
  }

  private persistOpenCodeMemberRestartSystemMessage(
    input: Parameters<
      TeamProvisioningMemberLifecycleController['persistOpenCodeMemberRestartSystemMessageInternal']
    >[0]
  ): void {
    this.memberLifecycleController.persistOpenCodeMemberRestartSystemMessageInternal(input);
  }

  private runMemberLifecycleOperation<T>(
    teamName: string,
    memberName: string,
    kind: MemberLifecycleOperationKind,
    operation: () => Promise<T>
  ): Promise<T> {
    return this.memberLifecycleController.runMemberLifecycleOperationInternal(
      teamName,
      memberName,
      kind,
      operation
    );
  }

  private stopPrimaryOwnedRosterRuntime(
    input: Parameters<
      TeamProvisioningMemberLifecycleController['stopPrimaryOwnedRosterRuntimeInternal']
    >[0]
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['stopPrimaryOwnedRosterRuntimeInternal']
  > {
    return this.memberLifecycleController.stopPrimaryOwnedRosterRuntimeInternal(input);
  }

  private collectFailedOpenCodeSecondaryRetryCandidates(
    run: Parameters<
      TeamProvisioningMemberLifecycleController['collectFailedOpenCodeSecondaryRetryCandidatesInternal']
    >[0]
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['collectFailedOpenCodeSecondaryRetryCandidatesInternal']
  > {
    return this.memberLifecycleController.collectFailedOpenCodeSecondaryRetryCandidatesInternal(
      run
    );
  }

  private reattachOpenCodeOwnedMemberLaneUnlocked(
    ...args: Parameters<
      TeamProvisioningMemberLifecycleController['reattachOpenCodeOwnedMemberLaneUnlockedInternal']
    >
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['reattachOpenCodeOwnedMemberLaneUnlockedInternal']
  > {
    return this.memberLifecycleController.reattachOpenCodeOwnedMemberLaneUnlockedInternal(...args);
  }

  private readOpenCodeSecondaryRetryOutcome(
    ...args: Parameters<
      TeamProvisioningMemberLifecycleController['readOpenCodeSecondaryRetryOutcomeInternal']
    >
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['readOpenCodeSecondaryRetryOutcomeInternal']
  > {
    return this.memberLifecycleController.readOpenCodeSecondaryRetryOutcomeInternal(...args);
  }

  private notifyLeadAboutConfirmedOpenCodeRetries(
    ...args: Parameters<
      TeamProvisioningMemberLifecycleController['notifyLeadAboutConfirmedOpenCodeRetriesInternal']
    >
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['notifyLeadAboutConfirmedOpenCodeRetriesInternal']
  > {
    return this.memberLifecycleController.notifyLeadAboutConfirmedOpenCodeRetriesInternal(...args);
  }

  private detachOpenCodeOwnedMemberLaneUnlocked(
    ...args: Parameters<
      TeamProvisioningMemberLifecycleController['detachOpenCodeOwnedMemberLaneUnlockedInternal']
    >
  ): ReturnType<
    TeamProvisioningMemberLifecycleController['detachOpenCodeOwnedMemberLaneUnlockedInternal']
  > {
    return this.memberLifecycleController.detachOpenCodeOwnedMemberLaneUnlockedInternal(...args);
  }

  private repairStaleTaskActivityIntervalsOnce(
    teamName: string,
    launchSnapshot?: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return repairStaleTaskActivityIntervalsOnceHelper(teamName, launchSnapshot, {
      taskActivityIntervalService: this.taskActivityIntervalService,
      tracking: {
        repairedTeams: this.crashRepairedActivityIntervalsByTeam,
        pendingSnapshots: this.pendingCrashRepairSnapshotByTeam,
      },
    });
  }

  private async readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return readTaskActivityRepairLaunchSnapshotHelper(teamName, {
      readBootstrapLaunchSnapshot,
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      choosePreferredLaunchSnapshot,
    });
  }

  private writeLaunchFailureArtifactPackBestEffort(
    run: ProvisioningRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void {
    writeLaunchFailureArtifactPackBestEffortHelper(run, options, {
      writtenRunIds: this.launchFailureArtifactPackRunIds,
      artifactWriter: {
        write: writeTeamLaunchFailureArtifactPack,
      },
      buildLaunchDiagnosticsFromRun,
      extractCliLogsFromRun,
      getRuntimeAdapterTraceLines: (runId) => this.runtimeAdapterTraceLinesByRunId.get(runId),
      onWriteError: (error) => {
        logger.warn(
          `[${run.teamName}] Failed to write launch failure artifact pack: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      },
    });
  }

  async repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    return repairStaleTaskActivityIntervalsBeforeSnapshotHelper(teamName, {
      tracking: {
        repairedTeams: this.crashRepairedActivityIntervalsByTeam,
        pendingSnapshots: this.pendingCrashRepairSnapshotByTeam,
      },
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      hasRun: (runId) => this.runs.has(runId),
      readRepairLaunchSnapshot: (teamName) => this.readTaskActivityRepairLaunchSnapshot(teamName),
      repairOnce: (teamName, launchSnapshot) =>
        this.repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot),
    });
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

  private async readConfigSnapshot(teamName: string): Promise<TeamConfig | null> {
    const configReader = this.configReader as TeamConfigReader & {
      getConfigSnapshot?: (name: string) => Promise<TeamConfig | null>;
    };
    return typeof configReader.getConfigSnapshot === 'function'
      ? configReader.getConfigSnapshot(teamName)
      : configReader.getConfig(teamName);
  }

  private readConfigForObservation(teamName: string): Promise<TeamConfig | null> {
    return this.readConfigSnapshot(teamName);
  }

  private readConfigForStrictDecision(teamName: string): Promise<TeamConfig | null> {
    return this.configReader.getConfig(teamName);
  }

  private getTeammatePermissionResponsePorts(): TeamProvisioningTeammatePermissionResponsePorts {
    return {
      readConfigForStrictDecision: (teamName) => this.readConfigForStrictDecision(teamName),
      addPermissionRulesToSettings: (settingsPath, toolNames, behavior) =>
        this.addPermissionRulesToSettings(settingsPath, toolNames, behavior),
      persistInboxMessage: (teamName, recipient, message) =>
        this.persistInboxMessage(teamName, recipient, message),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      logger,
      nowIso,
      nowMs: () => Date.now(),
      joinPath: (...parts) => path.join(...parts),
      teammateOperationalToolNames: AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
    };
  }

  private async readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory> {
    const [config, teamMeta, metaMembers] = await Promise.all([
      this.readConfigForObservation(teamName).catch(() => null),
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

  private createMemberSpawnStatusesSnapshotPorts(): MemberSpawnStatusesSnapshotPorts<ProvisioningRun> {
    return {
      getRun: (runId) => this.runs.get(runId),
      cache: {
        snapshotCache: this.memberSpawnStatusesSnapshotCache,
        inFlightByTeam: this.memberSpawnStatusesInFlightByTeam,
        getCacheGeneration: (teamName) => this.getMemberSpawnStatusesCacheGeneration(teamName),
        getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
        nowMs: () => Date.now(),
        liveCacheTtlMs: TeamProvisioningService.MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
        persistedCacheTtlMs:
          TeamProvisioningService.PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
      },
      persisted: {
        readTaskActivityRepairLaunchSnapshot: (teamName) =>
          this.readTaskActivityRepairLaunchSnapshot(teamName),
        repairStaleTaskActivityIntervalsOnce: (teamName, launchSnapshot) =>
          this.repairStaleTaskActivityIntervalsOnce(teamName, launchSnapshot),
        reconcilePersistedLaunchState: (teamName) => this.reconcilePersistedLaunchState(teamName),
        attachLiveRuntimeMetadataToStatuses: (teamName, statuses, options) =>
          this.attachLiveRuntimeMetadataToStatuses(teamName, statuses, options),
        getOpenCodeSecondaryBootstrapPendingMemberNames: (snapshot) =>
          this.getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot),
        resumeActiveTaskActivityForMembers: (teamName, memberNames, observedAt) =>
          this.taskActivityIntervalService.resumeActiveIntervalsForMembers(
            teamName,
            memberNames,
            observedAt
          ),
      },
      live: {
        refreshMemberSpawnStatusesFromLeadInbox: (run) =>
          this.refreshMemberSpawnStatusesFromLeadInbox(run),
        maybeAuditMemberSpawnStatuses: (run) => this.maybeAuditMemberSpawnStatuses(run),
        persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
        readLaunchState: (teamName) => this.launchStateStore.read(teamName),
        syncRunMemberSpawnStatusesFromSnapshot: (run, snapshot) =>
          this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot),
        buildLiveLaunchSnapshotForRun: (run, phase) =>
          this.buildLiveLaunchSnapshotForRun(run, phase),
        buildSnapshotFromRuntimeMemberStatuses: (input) => snapshotFromRuntimeMemberStatuses(input),
        buildRuntimeSpawnStatusRecord: (run) => this.buildRuntimeSpawnStatusRecord(run),
        getMembersMeta: (teamName) => this.membersMetaStore.getMembers(teamName),
        filterRemovedMembersFromLaunchSnapshot: (snapshot, metaMembers) =>
          snapshot
            ? this.filterRemovedMembersFromLaunchSnapshot(
                snapshot,
                metaMembers as Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>
              )
            : null,
        snapshotToMemberSpawnStatuses,
        getPersistedLaunchMemberNames: (snapshot) =>
          snapshot ? this.getPersistedLaunchMemberNames(snapshot) : [],
        deriveTeamLaunchAggregateState,
      },
      nowIso,
    };
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
    return resolveOpenCodeMemberIdentityFromDirectoryHelper({
      memberName,
      directory,
      secondaryRuntimeRuns: this.getSecondaryRuntimeRuns(teamName),
      runtimeAdapterProviderId: this.runtimeAdapterRunByTeam.get(teamName)?.providerId ?? null,
    });
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

  private async buildTeamRuntimeLaunchArgsPlan(input: {
    teamName: string;
    providerId: TeamProviderId;
    launchIdentity?: ProviderModelLaunchIdentity | null;
    envResolution: ProvisioningEnvResolution;
    extraArgs?: string[];
    inheritedProviderArgs?: string[];
    includeAnthropicHelper: boolean;
    contextLabel: string;
  }): Promise<TeamRuntimeLaunchArgsPlan> {
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
    return readRuntimeProviderLaunchFactsHelper(params, {
      execCli,
      getCodexModelCatalog: (input) => this.providerConnectionService.getCodexModelCatalog(input),
      warn: (message) => logger.warn(message),
    });
  }

  private buildProviderModelLaunchIdentity(params: {
    request: Pick<
      TeamCreateRequest,
      'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
    >;
    facts: RuntimeProviderLaunchFacts;
  }): ProviderModelLaunchIdentity {
    return buildProviderModelLaunchIdentityHelper({
      ...params,
      anthropicFastModeDefault: getAnthropicFastModeDefault(),
    });
  }

  private validateRuntimeLaunchSelection(params: {
    actorLabel: string;
    providerId: TeamProviderId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    limitContext?: boolean;
    facts: RuntimeProviderLaunchFacts;
  }): void {
    validateRuntimeLaunchSelectionHelper({
      ...params,
      anthropicFastModeDefault: getAnthropicFastModeDefault(),
      getProviderLabel: getTeamProviderLabel,
    });
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
    return resolveAndValidateLaunchIdentityHelper(params, {
      readRuntimeProviderLaunchFacts: (input) => this.readRuntimeProviderLaunchFacts(input),
      buildProviderModelLaunchIdentity: (input) => this.buildProviderModelLaunchIdentity(input),
      validateRuntimeLaunchSelection: (input) => this.validateRuntimeLaunchSelection(input),
    });
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
    return resolveDirectMemberLaunchIdentityHelper(
      {
        ...input,
        requestLimitContext: input.run.request.limitContext,
      },
      {
        readRuntimeProviderLaunchFacts: (params) => this.readRuntimeProviderLaunchFacts(params),
        buildProviderModelLaunchIdentity: (params) => this.buildProviderModelLaunchIdentity(params),
        validateRuntimeLaunchSelection: (params) => this.validateRuntimeLaunchSelection(params),
      }
    );
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
          this.readConfigForObservation(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
        readPersistedTeamProjectPath: (candidateTeamName) =>
          this.readPersistedTeamProjectPath(candidateTeamName),
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
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
        readMembersMeta: (candidateTeamName) => this.membersMetaStore.getMembers(candidateTeamName),
      }
    );
  }

  async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
    return isOpenCodeRuntimeRecipientHelper(
      { teamName, memberName },
      {
        readConfigSnapshot: (candidateTeamName) => this.readConfigSnapshot(candidateTeamName),
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

  private async isStaleOpenCodePromptDeliveryWatchdogError(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    error: unknown;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogCoordinator.isStaleError(input);
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
    const runtimePid = normalizeRuntimePositiveInteger(input.runtimePid);
    if (!runtimePid) {
      return;
    }

    const command = readOpenCodeRuntimeLaneProcessCommandByPid(runtimePid);
    if (!command || !isOpenCodeServeCommand(command)) {
      logger.debug(
        `[${input.teamName}] Ignoring OpenCode bridge runtime pid ${runtimePid} for ${input.memberName}: process identity is not an active opencode serve host.`
      );
      return;
    }

    const observedAt = nowIso();
    try {
      const changed = await this.enqueueLaunchStateStoreOperation(input.teamName, async () => {
        const previous = await this.launchStateStore.read(input.teamName).catch(() => null);
        const previousEntry = this.findPersistedLaunchMemberForLane({
          previousLaunchState: previous,
          laneId: input.laneId,
          memberName: input.memberName,
          runId: input.runId,
        });
        if (!previous || !previousEntry) {
          return false;
        }
        const previousMember = previousEntry.member;
        if (!isPersistedOpenCodeSecondaryLaneMember(previousMember)) {
          return false;
        }
        if (previousMember.laneId && previousMember.laneId !== input.laneId) {
          return false;
        }
        const previousRunId = previousMember.runtimeRunId?.trim();
        const incomingRunId = input.runId?.trim();
        if (previousRunId && incomingRunId && previousRunId !== incomingRunId) {
          return false;
        }
        const previousSessionId = previousMember.runtimeSessionId?.trim();
        const incomingSessionId = input.runtimeSessionId?.trim();
        if (previousSessionId && incomingSessionId && previousSessionId !== incomingSessionId) {
          return false;
        }
        if (
          previousMember.runtimePid === runtimePid &&
          previousMember.pidSource === 'opencode_bridge'
        ) {
          return false;
        }

        const nextMember: PersistedTeamLaunchMemberState = {
          ...previousMember,
          runtimePid,
          ...(incomingRunId ? { runtimeRunId: incomingRunId } : {}),
          ...(incomingSessionId ? { runtimeSessionId: incomingSessionId } : {}),
          pidSource: 'opencode_bridge',
          lastRuntimeAliveAt: observedAt,
          lastEvaluatedAt: observedAt,
          sources: {
            ...(previousMember.sources ?? {}),
            processAlive: true,
          },
          diagnostics: mergeRuntimeDiagnostics(
            previousMember.diagnostics,
            [`runtime pid: ${runtimePid}`, input.reason],
            previousMember.runtimeDiagnostic
          ),
        };
        const nextSnapshot = createPersistedLaunchSnapshot({
          teamName: previous.teamName,
          expectedMembers: previous.expectedMembers,
          bootstrapExpectedMembers: previous.bootstrapExpectedMembers,
          leadSessionId: previous.leadSessionId,
          launchPhase: previous.launchPhase,
          members: {
            ...previous.members,
            [previousEntry.key]: nextMember,
          },
          updatedAt: observedAt,
        });
        await this.writeLaunchStateSnapshotNow(input.teamName, nextSnapshot);
        return true;
      });
      if (changed) {
        this.invalidateRuntimeSnapshotCaches(input.teamName);
        this.teamChangeEmitter?.({
          type: 'member-spawn',
          teamName: input.teamName,
          ...(input.runId ? { runId: input.runId } : {}),
          detail: input.memberName,
        });
      }
    } catch (error) {
      logger.debug(
        `[${input.teamName}] Failed to persist OpenCode bridge runtime pid ${runtimePid} for ${input.memberName}: ${getErrorMessage(error)}`
      );
    }
  }

  private findPersistedLaunchMemberForLane(input: {
    previousLaunchState: PersistedTeamLaunchSnapshot | null | undefined;
    laneId: string;
    memberName: string;
    runId?: string | null;
  }): { key: string; member: PersistedTeamLaunchMemberState } | null {
    return findPersistedLaunchMemberForLaneHelper(input);
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

  private async handleOpenCodeRuntimeDeliveryUserFacingSideEffects(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.handleUserFacingSideEffects(record);
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

  private async scheduleOpenCodeProofMissingWorkSyncRecovery(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.scheduleProofMissingWorkSyncRecovery(
      record,
      decision
    );
  }

  private emitOpenCodeRuntimeDeliveryAdvisoryEvent(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision?: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    this.openCodeRuntimeDeliveryAdvisory.emitAdvisoryEvent(record, decision);
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

  private async notifyLeadAboutOpenCodeRuntimeDeliveryError(input: {
    record: OpenCodePromptDeliveryLedgerRecord;
    reason: string;
    taskLabel: string | null;
  }): Promise<void> {
    await this.openCodeRuntimeDeliveryAdvisory.notifyLeadAboutError(input);
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
    return createOpenCodeMemberMessageDeliveryServiceHelper({
      getOpenCodeRuntimeMessageAdapter: () => this.getOpenCodeRuntimeMessageAdapter(),
      readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
      stoppingSecondaryRuntimeTeams: this.stoppingSecondaryRuntimeTeams,
      readPersistedTeamProjectPath: (teamName) => this.readPersistedTeamProjectPath(teamName),
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        this.runTracking.resolveDeliverableTrackedRuntimeRunId(teamName),
      runs: this.runs,
      getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
      isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
        this.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
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
      resolveControlApiBaseUrl: () => this.providerRuntime.resolveControlApiBaseUrl(),
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
    });
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

  private createOpenCodeRuntimeLaneRecoveryPorts(): OpenCodeRuntimeLaneRecoveryPorts {
    return {
      teamsBasePath: getTeamsBasePath(),
      logger,
      canDeliverToOpenCodeRuntimeForTeam: (teamName) =>
        this.runTracking.canDeliverToOpenCodeRuntimeForTeam(teamName),
      canAttemptCommittedOpenCodeSessionRecovery: (teamName) =>
        this.runTracking.canAttemptCommittedOpenCodeSessionRecovery(teamName),
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
        this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      tryRecoverMissingOpenCodeSecondaryLaneFromRuntime: (recoverInput) =>
        this.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(recoverInput),
      tryRecoverActiveOpenCodeSecondaryLaneFromRuntime: (recoverInput) =>
        this.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(recoverInput),
      readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
      readConfigForObservation: (teamName) => this.readConfigForObservation(teamName),
      readTeamMeta: (teamName) => this.teamMetaStore.getMeta(teamName),
      readMetaMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      readPersistedTeamProjectPath: (teamName) => this.readPersistedTeamProjectPath(teamName),
      isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
        this.openCodeRuntimeRecoveryIdentity.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
    };
  }

  private async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean> {
    return tryRecoverOpenCodeRuntimeLaneBeforeDeliveryHelper(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  private async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  }): Promise<boolean> {
    return tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDeliveryHelper(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  private async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    return tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDeliveryHelper(
      input,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
    );
  }

  private async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(input: {
    teamName: string;
    memberName: string;
    laneId: string;
  }): Promise<boolean> {
    const recovered = await this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery({
      teamName: input.teamName,
      memberName: input.memberName,
    }).catch(() => false);
    if (!recovered) {
      return false;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), input.teamName).catch(
      () => null
    );
    return laneIndex?.lanes[input.laneId]?.state === 'active';
  }

  private async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    return tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdogHelper(
      teamName,
      options,
      this.createOpenCodeRuntimeLaneRecoveryPorts()
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

  private buildConfiguredProvisioningMember(
    configuredMember: NonNullable<
      ReturnType<TeamProvisioningService['resolveEffectiveConfiguredMember']>
    >
  ): TeamCreateRequest['members'][number] {
    return {
      name: configuredMember.name,
      ...(configuredMember.role ? { role: configuredMember.role } : {}),
      ...(configuredMember.workflow ? { workflow: configuredMember.workflow } : {}),
      ...(configuredMember.isolation === 'worktree' ? { isolation: 'worktree' as const } : {}),
      ...(configuredMember.cwd ? { cwd: configuredMember.cwd } : {}),
      ...(configuredMember.providerId ? { providerId: configuredMember.providerId } : {}),
      ...(configuredMember.providerBackendId
        ? { providerBackendId: configuredMember.providerBackendId }
        : {}),
      ...(configuredMember.model ? { model: configuredMember.model } : {}),
      ...(configuredMember.effort ? { effort: configuredMember.effort } : {}),
      ...(configuredMember.fastMode ? { fastMode: configuredMember.fastMode } : {}),
      ...(configuredMember.mcpPolicy
        ? { mcpPolicy: normalizeTeamMemberMcpPolicy(configuredMember.mcpPolicy) }
        : {}),
    };
  }

  private buildPrimaryOwnedMemberSpecForRuntime(input: {
    configuredMember: NonNullable<
      ReturnType<TeamProvisioningService['resolveEffectiveConfiguredMember']>
    >;
    run: ProvisioningRun;
  }): TeamCreateRequest['members'][number] {
    const configuredSpec = this.buildConfiguredProvisioningMember(input.configuredMember);
    const defaultProviderId = resolveTeamProviderId(input.run.request.providerId);
    const memberProviderId = normalizeTeamMemberProviderId(configuredSpec.providerId);
    const inheritsDefaultRuntime =
      memberProviderId == null || memberProviderId === defaultProviderId;
    const effectiveSpec = buildEffectiveTeamMemberSpec(configuredSpec, {
      providerId: defaultProviderId,
      model: input.run.request.model,
      effort: input.run.request.effort,
    });
    const effectiveProviderId = resolveTeamProviderId(effectiveSpec.providerId);
    const providerBackendId =
      migrateProviderBackendId(effectiveProviderId, configuredSpec.providerBackendId) ??
      (inheritsDefaultRuntime
        ? migrateProviderBackendId(effectiveProviderId, input.run.request.providerBackendId)
        : undefined);
    const fastMode =
      configuredSpec.fastMode ?? (inheritsDefaultRuntime ? input.run.request.fastMode : undefined);

    return {
      ...effectiveSpec,
      ...(providerBackendId ? { providerBackendId } : {}),
      ...(fastMode ? { fastMode } : {}),
      ...(input.configuredMember.agentType ? { agentType: input.configuredMember.agentType } : {}),
    };
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
    const members = Array.isArray(run.request?.members) ? run.request.members : [];
    return members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
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
    if (deliveredBlocks.length === 0) return [];

    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      return [];
    }

    return matchCrossTeamLeadInboxMessagesHelper(leadInboxMessages, deliveredBlocks);
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
    try {
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }).messages.appendSentMessage({
        from: message.from,
        to: message.to,
        text: message.text,
        timestamp: message.timestamp,
        summary: message.summary,
        messageId: message.messageId,
        relayOfMessageId: message.relayOfMessageId,
        source: message.source,
        leadSessionId: message.leadSessionId,
        conversationId: message.conversationId,
        replyToConversationId: message.replyToConversationId,
        taskRefs: message.taskRefs,
        attachments: message.attachments,
        color: message.color,
        toolSummary: message.toolSummary,
        toolCalls: message.toolCalls,
        messageKind: message.messageKind,
        workSyncIntent: message.workSyncIntent,
        workSyncIntentKey: message.workSyncIntentKey,
        workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
        slashCommand: message.slashCommand,
        commandOutput: message.commandOutput,
      });
    } catch (error) {
      logger.warn(`[${teamName}] sent-message persist failed: ${String(error)}`);
    }
  }

  private persistInboxMessage(teamName: string, recipient: string, message: InboxMessage): void {
    try {
      createController({
        teamName,
        claudeDir: getClaudeBasePath(),
      }).messages.sendMessage({
        member: recipient,
        from: message.from,
        text: message.text,
        timestamp: message.timestamp,
        summary: message.summary,
        messageId: message.messageId,
        relayOfMessageId: message.relayOfMessageId,
        source: message.source,
        leadSessionId: message.leadSessionId,
        conversationId: message.conversationId,
        replyToConversationId: message.replyToConversationId,
        taskRefs: message.taskRefs,
        attachments: message.attachments,
        color: message.color,
        toolSummary: message.toolSummary,
        toolCalls: message.toolCalls,
        messageKind: message.messageKind,
        workSyncIntent: message.workSyncIntent,
        workSyncIntentKey: message.workSyncIntentKey,
        workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
        slashCommand: message.slashCommand,
        commandOutput: message.commandOutput,
      });
      this.emitRuntimeDeliveryReplyAdvisoryRefresh(teamName, message);
    } catch (error) {
      logger.warn(`[${teamName}] inbox-message persist for ${recipient} failed: ${String(error)}`);
    }
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

  private toolApprovalEventEmitter: ((event: ToolApprovalEvent) => void) | null = null;
  private mainWindowRef: import('electron').BrowserWindow | null = null;
  private activeApprovalNotifications = new Map<string, TeamProvisioningToolApprovalNotification>();
  private readonly toolApprovalOsNotifications =
    new TeamProvisioningToolApprovalNotifications<ProvisioningRun>({
      getMainWindow: () => this.mainWindowRef,
      getNotificationSettings: () => ConfigManager.getInstance().getConfig().notifications,
      getNotificationConstructor: () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { Notification: ElectronNotification } = require('electron') as Partial<
          typeof import('electron')
        >;
        return (ElectronNotification ??
          null) as TeamProvisioningToolApprovalNotificationConstructor | null;
      },
      getAppIconPath,
      platform: process.platform,
      activeApprovalNotifications: this.activeApprovalNotifications,
      respondToToolApproval: (teamName, runId, requestId, allow, message) =>
        this.respondToToolApproval(teamName, runId, requestId, allow, message),
      logger: {
        info: (message) => logger.info(message),
        error: (message) => logger.error(message),
      },
      nowMs: () => Date.now(),
    });

  setToolApprovalEventEmitter(emitter: (event: ToolApprovalEvent) => void): void {
    this.toolApprovalEventEmitter = emitter;
  }

  setMainWindow(win: import('electron').BrowserWindow | null): void {
    this.mainWindowRef = win;
  }

  private getToolApprovalSettings(teamName: string): ToolApprovalSettings {
    return this.toolApprovalSettingsByTeam.get(teamName) ?? DEFAULT_TOOL_APPROVAL_SETTINGS;
  }

  updateToolApprovalSettings(teamName: string, settings: ToolApprovalSettings): void {
    this.toolApprovalSettingsByTeam.set(teamName, settings);
    this.reEvaluatePendingApprovals();
  }

  private emitToolApprovalEvent(event: ToolApprovalEvent): void {
    this.toolApprovalEventEmitter?.(event);
  }

  getLiveLeadProcessMessages(teamName: string): InboxMessage[] {
    return getLiveLeadProcessMessagesHelper(teamName, {
      liveLeadProcessMessages: this.liveLeadProcessMessages,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
    });
  }

  private pruneLiveLeadMessagesForCleanedRun(run: ProvisioningRun): void {
    pruneLiveLeadMessagesForCleanedRunHelper(run, this.liveLeadProcessMessages);
  }

  getCurrentLeadSessionId(teamName: string): string | null {
    return getCurrentLeadSessionIdHelper(teamName, {
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
    });
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
    return createTeamProvisioningOpenCodeRuntimeDeliveryBoundary<ProvisioningRun>({
      getTeamsBasePath,
      resolveOpenCodeRuntimeLaneId: (input) => this.resolveOpenCodeRuntimeLaneId(input),
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      writeLaunchState: async (teamName, snapshot) => {
        await this.writeLaunchStateSnapshot(teamName, snapshot);
      },
      readConfigForStrictDecision: (teamName) => this.readConfigForStrictDecision(teamName),
      readMetaMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      readPersistedRuntimeMembers: (teamName) => this.readPersistedRuntimeMembers(teamName),
      getTrackedRun: (teamName) => {
        const trackedRunId = this.runTracking.getTrackedRunId(teamName);
        return trackedRunId ? (this.runs.get(trackedRunId) ?? null) : null;
      },
      persistTrackedRunLaunchState: async (run) => {
        await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
      },
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      emitMemberSpawnChange: (run, memberName) => this.emitMemberSpawnChange(run, memberName),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      createOpenCodeRuntimeBootstrapEvidencePorts: () =>
        this.createOpenCodeRuntimeBootstrapEvidencePorts(),
      upsertOpenCodeTaskRecord: (teamName, record) =>
        this.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, record),
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
      getOpenCodeAgendaSyncRecoveryBypassMessageIds: (bypassInput) =>
        this.getOpenCodeAgendaSyncRecoveryBypassMessageIds(bypassInput),
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          teamName,
          memberName
        ),
      tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive: (recoverInput) =>
        this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(recoverInput),
      decideOpenCodeRuntimeDeliveryUserFacingAdvisory: (record) =>
        this.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record),
      isOpenCodePromptDeliveryWatchdogEnabled: () =>
        this.openCodePromptDeliveryWatchdogScheduler.isEnabled(),
      scheduleOpenCodePromptDeliveryWatchdog: (watchdogInput) =>
        this.scheduleOpenCodePromptDeliveryWatchdog(watchdogInput),
      readLaunchStateForDeliveryRecovery: (candidateTeamName) =>
        this.launchStateStore.read(candidateTeamName).catch(() => null),
      nowIso,
      logger,
    });
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
      getRuntimeAdapterProgress: (runId) =>
        this.runtimeAdapterProgressByRunId.get(runId) ?? null,
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

  private createLeadActivityPorts(): {
    syncedRunKeys: Set<string>;
    getRunLeadName: (run: ProvisioningRun) => string;
    resumeActiveIntervalsForMember: (
      teamName: string,
      memberName: string,
      at: string
    ) => { failed?: boolean };
    pauseActiveIntervalsForMember: (
      teamName: string,
      memberName: string,
      at: string
    ) => { failed?: boolean };
    isCurrentTrackedRun: (run: ProvisioningRun) => boolean;
    nowIso: () => string;
    emitTeamChange: (event: TeamChangeEvent) => void;
  } {
    return {
      syncedRunKeys: this.leadTaskActivitySyncedRunKeys,
      getRunLeadName: (run) => this.getRunLeadName(run),
      resumeActiveIntervalsForMember: (teamName, memberName, at) =>
        this.taskActivityIntervalService.resumeActiveIntervalsForMember(teamName, memberName, at),
      pauseActiveIntervalsForMember: (teamName, memberName, at) =>
        this.taskActivityIntervalService.pauseActiveIntervalsForMember(teamName, memberName, at),
      isCurrentTrackedRun: (run) => this.isCurrentTrackedRun(run),
      nowIso,
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
    };
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
      readConfigSnapshot: (targetTeamName) => this.readConfigSnapshot(targetTeamName),
      readPersistedRuntimeMembers: (targetTeamName) =>
        this.readPersistedRuntimeMembers(targetTeamName),
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
    const current = run.memberSpawnStatuses.get(memberName);
    if (!current) return;
    if (
      current.launchState === 'failed_to_start' ||
      current.launchState === 'confirmed_alive' ||
      !current.firstSpawnAcceptedAt
    ) {
      return;
    }
    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run, { force: true });
    const refreshed = run.memberSpawnStatuses.get(memberName);
    if (!refreshed) return;
    if (
      refreshed.launchState === 'failed_to_start' ||
      refreshed.launchState === 'confirmed_alive'
    ) {
      return;
    }
    const refreshedFirstSpawnAcceptedAt = refreshed.firstSpawnAcceptedAt;
    if (!refreshedFirstSpawnAcceptedAt) {
      return;
    }
    const restartPending = run.pendingMemberRestarts.has(memberName);
    const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(run.teamName);
    const metadata =
      runtimeByMember.get(memberName) ??
      [...runtimeByMember.entries()].find(([candidateName]) =>
        matchesObservedMemberNameForExpected(candidateName, memberName)
      )?.[1];
    const acceptedAtMs = Date.parse(refreshedFirstSpawnAcceptedAt);
    const elapsedMs = Number.isFinite(acceptedAtMs) ? Date.now() - acceptedAtMs : Infinity;
    const runtimeDiagnostic = metadata?.runtimeDiagnostic;
    if (metadata?.livenessKind === 'runtime_process') {
      if (this.isOpenCodeSecondaryLaneMemberInRun(run, memberName)) {
        const bootstrapStalled = elapsedMs >= MEMBER_BOOTSTRAP_STALL_MS;
        await reconcileOpenCodeRuntimeProcessBootstrapStatusHelper(
          {
            run,
            memberName,
            current: refreshed,
            bootstrapStalled,
            runtimeDiagnostic,
            runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity,
            runtimeSessionId: metadata.runtimeSessionId,
            firstSpawnAcceptedAt: refreshedFirstSpawnAcceptedAt,
            scheduleReevaluation: !bootstrapStalled,
          },
          this.getOpenCodeBootstrapStallReconciliationPorts()
        );
        return;
      }
      this.setMemberSpawnStatus(run, memberName, 'online', undefined, 'process');
      return;
    }
    if (metadata?.livenessKind === 'permission_blocked') {
      const next = {
        ...refreshed,
        livenessKind: metadata.livenessKind,
        runtimeDiagnostic: runtimeDiagnostic ?? 'waiting for permission approval',
        runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity ?? 'warning',
        livenessLastCheckedAt: nowIso(),
        launchState: 'runtime_pending_permission' as const,
      };
      run.memberSpawnStatuses.set(memberName, next);
      this.emitMemberSpawnChange(run, memberName);
      return;
    }
    if (
      metadata?.livenessKind === 'runtime_process_candidate' &&
      elapsedMs < MEMBER_BOOTSTRAP_STALL_MS
    ) {
      const next = {
        ...refreshed,
        livenessKind: metadata.livenessKind,
        runtimeDiagnostic:
          runtimeDiagnostic ?? 'Runtime process candidate detected, but bootstrap is unconfirmed.',
        runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity ?? 'warning',
        livenessLastCheckedAt: nowIso(),
      };
      run.memberSpawnStatuses.set(memberName, next);
      this.emitMemberSpawnChange(run, memberName);
      this.scheduleOpenCodeBootstrapStallReevaluation(
        run,
        memberName,
        refreshedFirstSpawnAcceptedAt
      );
      return;
    }
    if (
      await markOpenCodeSecondaryBootstrapStalledHelper(
        {
          run,
          memberName,
          current: refreshed,
          isOpenCodeSecondaryLaneMember: this.isOpenCodeSecondaryLaneMemberInRun(run, memberName),
          bootstrapStallWindowElapsed: elapsedMs >= MEMBER_BOOTSTRAP_STALL_MS,
          runtimeMetadata: metadata,
        },
        this.getOpenCodeBootstrapStallReconciliationPorts()
      )
    ) {
      return;
    }
    const strictReason = restartPending
      ? buildRestartGraceTimeoutReason(memberName)
      : (runtimeDiagnostic ??
        (metadata?.livenessKind === 'shell_only'
          ? 'Tmux pane is alive, but no teammate runtime process was found.'
          : 'Teammate did not join within the launch grace window.'));
    if (restartPending) {
      run.pendingMemberRestarts.delete(memberName);
    }
    const livenessObservedAt = nowIso();
    const nextRuntimeLostStatus: MemberSpawnStatusEntry = {
      ...refreshed,
      runtimeAlive: false,
      livenessSource: undefined,
      bootstrapConfirmed: false,
      ...(metadata?.livenessKind ? { livenessKind: metadata.livenessKind } : {}),
      ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
      ...(metadata?.runtimeDiagnosticSeverity
        ? { runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity }
        : {}),
      livenessLastCheckedAt: livenessObservedAt,
    };
    this.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      refreshed,
      nextRuntimeLostStatus,
      livenessObservedAt
    );
    run.memberSpawnStatuses.set(memberName, nextRuntimeLostStatus);
    this.setMemberSpawnStatus(run, memberName, 'error', strictReason);
  }

  private getOpenCodeBootstrapStallStatusPorts(): OpenCodeBootstrapStallStatusPorts {
    return {
      nowIso,
      syncMemberTaskActivityForRuntimeTransition: (targetRun, targetMember, previous, next, at) =>
        this.syncMemberTaskActivityForRuntimeTransition(
          targetRun as ProvisioningRun,
          targetMember,
          previous,
          next,
          at
        ),
      updateLaunchDiagnostics: (targetRun, observedAt) =>
        this.updateLaunchDiagnosticsForRun(targetRun as ProvisioningRun, observedAt),
      appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
        this.appendMemberBootstrapDiagnostic(targetRun as ProvisioningRun, targetMember, text),
      isCurrentTrackedRun: (targetRun) => this.isCurrentTrackedRun(targetRun as ProvisioningRun),
      emitMemberSpawnChange: (targetRun, targetMember) =>
        this.emitMemberSpawnChange(targetRun as ProvisioningRun, targetMember),
      persistLaunchStateSnapshot: (targetRun, phase) => {
        void this.persistLaunchStateSnapshot(targetRun as ProvisioningRun, phase);
      },
    };
  }

  private getOpenCodeBootstrapStallReconciliationPorts(): ReconcileOpenCodeRuntimeProcessBootstrapPorts &
    MarkOpenCodeSecondaryBootstrapStalledPorts {
    return {
      buildOpenCodeSecondaryBootstrapStallDiagnostic: (targetRun, targetMember, targetCurrent) =>
        buildOpenCodeSecondaryBootstrapStallDiagnosticHelper(
          { run: targetRun, memberName: targetMember, current: targetCurrent },
          {
            findBootstrapTranscriptOutcome: (teamName, memberName, acceptedAtMs) =>
              this.findBootstrapTranscriptOutcome(teamName, memberName, acceptedAtMs),
          }
        ),
      setOpenCodeRuntimePendingBootstrapStatus: (targetRun, targetMember, current, options) =>
        setOpenCodeRuntimePendingBootstrapStatusHelper(
          targetRun,
          targetMember,
          current,
          options,
          this.getOpenCodeBootstrapStallStatusPorts()
        ),
      setOpenCodeSecondaryBootstrapStalledStatus: (
        targetRun,
        targetMember,
        targetCurrent,
        runtimeDiagnostic
      ) =>
        setOpenCodeSecondaryBootstrapStalledStatusHelper(
          targetRun,
          targetMember,
          targetCurrent,
          runtimeDiagnostic,
          this.getOpenCodeBootstrapStallStatusPorts()
        ),
      maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt: (retryInput) =>
        maybeSendOpenCodeSecondaryBootstrapCheckinRetryPromptHelper(retryInput, {
          getOpenCodeRuntimeMessageAdapter: () => this.getOpenCodeRuntimeMessageAdapter(),
          sendOpenCodeMemberMessageToRuntimeSerialized: (sendInput) =>
            this.sendOpenCodeMemberMessageToRuntimeSerialized(sendInput),
          appendMemberBootstrapDiagnostic: (targetRun, targetMember, text) =>
            this.appendMemberBootstrapDiagnostic(targetRun as ProvisioningRun, targetMember, text),
          isCurrentTrackedRun: (targetRun) =>
            this.isCurrentTrackedRun(targetRun as ProvisioningRun),
        }),
      scheduleOpenCodeBootstrapStallReevaluation: (targetRun, targetMember, firstSpawnAcceptedAt) =>
        this.scheduleOpenCodeBootstrapStallReevaluation(
          targetRun as ProvisioningRun,
          targetMember,
          firstSpawnAcceptedAt
        ),
    };
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
  private static readonly LEAD_TEXT_EMIT_THROTTLE_MS = 2000;

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
    await this.prepareCoordinator.warmup();
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
    return this.prepareCoordinator.prepareForProvisioning(cwd, opts);
  }

  private createPrepareForProvisioningInFlightKey(
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
  ): string {
    return this.prepareCoordinator.createPrepareForProvisioningInFlightKey(cwd, opts);
  }

  private clonePrepareForProvisioningResult(
    result: TeamProvisioningPrepareResult
  ): TeamProvisioningPrepareResult {
    return this.prepareCoordinator.clonePrepareForProvisioningResult(result);
  }

  private async prepareForProvisioningOnce(
    cwd?: string,
    opts?: PrepareForProvisioningOptions
  ): Promise<TeamProvisioningPrepareResult> {
    return this.prepareCoordinator.prepareForProvisioningOnce(cwd, opts);
  }

  private async verifySelectedProviderModels(input: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    modelIds: string[];
    modelChecks?: { modelId: string; effort?: EffortLevel }[];
    limitContext: boolean;
  }): Promise<{
    details: string[];
    warnings: string[];
    blockingMessages: string[];
    issues?: TeamProvisioningPrepareIssue[];
  }> {
    return this.prepareCoordinator.verifySelectedProviderModels(input);
  }

  private async resolveProviderDefaultModel(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    return this.prepareCoordinator.resolveProviderDefaultModel(
      claudePath,
      cwd,
      providerId,
      env,
      providerArgs,
      limitContext
    );
  }

  private async resolveProviderDefaultModelFromRuntimeStatus(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    return this.prepareCoordinator.resolveProviderDefaultModelFromRuntimeStatus(
      claudePath,
      cwd,
      providerId,
      env,
      providerArgs,
      limitContext
    );
  }

  private async materializeEffectiveTeamMemberSpecs(params: {
    claudePath: string;
    cwd: string;
    members: TeamCreateRequest['members'];
    defaults: {
      providerId?: TeamProviderId;
      model?: string;
      effort?: TeamCreateRequest['effort'];
    };
    primaryProviderId?: TeamProviderId;
    primaryEnv?: ProvisioningEnvResolution;
    teamRuntimeAuth?: TeamRuntimeAuthContext;
    limitContext?: boolean;
    providerArgsResolver?: (input: {
      providerId: TeamProviderId;
      providerArgs: string[];
      phase: 'default-model-resolution';
    }) => string[];
  }): Promise<TeamCreateRequest['members']> {
    return this.prepareCoordinator.materializeEffectiveTeamMemberSpecs(params);
  }

  private getOpenCodeRuntimeLaunchCwd(
    fallbackCwd: string,
    members: TeamCreateRequest['members']
  ): string {
    return this.prepareCoordinator.getOpenCodeRuntimeLaunchCwd(fallbackCwd, members);
  }

  private async materializeOpenCodeRuntimeAdapterDefaults<
    TRequest extends TeamCreateRequest | TeamLaunchRequest,
  >(params: {
    request: TRequest;
    members: TeamCreateRequest['members'];
  }): Promise<{
    request: TRequest;
    members: TeamCreateRequest['members'];
  }> {
    return materializeOpenCodeRuntimeAdapterDefaultsHelper(params, {
      resolveClaudePath: () => ClaudeBinaryResolver.resolve(),
      buildProvisioningEnv: (providerId, providerBackendId) =>
        this.providerRuntime.buildProvisioningEnv(providerId, providerBackendId),
      resolveProviderDefaultModel: (claudePath, cwd, providerId, env, providerArgs, limitContext) =>
        this.resolveProviderDefaultModel(
          claudePath,
          cwd,
          providerId,
          env,
          providerArgs,
          limitContext
        ),
    });
  }

  private buildOpenCodeRuntimeAdapterLaunchMembers(
    request: TeamCreateRequest | TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    lanePlan?: TeamRuntimeLanePlan
  ): TeamCreateRequest['members'] {
    return this.prepareCoordinator.buildOpenCodeRuntimeAdapterLaunchMembers(
      request,
      members,
      lanePlan
    );
  }

  private async resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']> {
    return this.prepareCoordinator.resolveOpenCodeMemberWorkspacesForRuntime(params);
  }

  private getFreshCachedProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): CachedProbeResult | null {
    return this.prepareCoordinator.getFreshCachedProbeResult(cwd, providerId);
  }

  private clearProbeCache(cwd: string, providerId: TeamProviderId | undefined): void {
    this.prepareCoordinator.clearProbeCache(cwd, providerId);
  }

  private async validatePrepareCwd(cwd: string): Promise<void> {
    await this.prepareCoordinator.validatePrepareCwd(cwd);
  }

  private async getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<ProbeResult | null> {
    return this.prepareCoordinator.getCachedOrProbeResult(cwd, providerId);
  }

  private createOutputRecoveryHelper() {
    return createTeamProvisioningOutputRecoveryHelper<ProvisioningRun>(
      {
        logger,
        nowMs: () => Date.now(),
        nowIso,
        setInterval: (callback, ms) => setInterval(callback, ms),
        clearInterval: (handle) => clearInterval(handle),
        buildCombinedLogs,
        extractApiErrorSnippet,
        hasApiError,
        isAuthFailureWarning,
        buildStallWarningText,
        buildStallProgressMessage,
        boundStdoutParserCarry,
        looksLikeClaudeStdoutJsonFragment,
        boundRunProvisioningOutputParts,
        buildProvisioningLiveOutput,
        extractCliLogsFromRun,
        updateProgress,
        emitLogsProgress,
        killTeamProcess,
        cleanupRun: (run) => this.cleanupRun(run),
        respawnAfterAuthFailure: (run) => this.respawnAfterAuthFailure(run),
        appendCliLogs: (run, stream, text) => this.appendCliLogs(run, stream, text),
        handleStreamJsonMessage: (run, msg) => this.handleStreamJsonMessage(run, msg),
        shiftProvisioningOutputIndexesAfterRemoval: (run, removedIndex) =>
          this.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex),
      },
      {
        stderrRingLimit: STDERR_RING_LIMIT,
        stdoutRingLimit: STDOUT_RING_LIMIT,
        logProgressThrottleMs: LOG_PROGRESS_THROTTLE_MS,
        stallCheckIntervalMs: STALL_CHECK_INTERVAL_MS,
        stallWarningThresholdMs: STALL_WARNING_THRESHOLD_MS,
        preflightAuthRetryDelayMs: PREFLIGHT_AUTH_RETRY_DELAY_MS,
      }
    );
  }

  private failProvisioningWithApiError(run: ProvisioningRun, source: string): void {
    this.createOutputRecoveryHelper().failProvisioningWithApiError(run, source);
  }

  /**
   * Shows a non-fatal API error warning in the Live output section.
   * Unlike failProvisioningWithApiError, does NOT kill the process — lets the SDK retry.
   * Deduplicates: only the first warning per run is shown.
   */
  private emitApiErrorWarning(run: ProvisioningRun, text: string): void {
    this.createOutputRecoveryHelper().emitApiErrorWarning(run, text);
  }

  /**
   * Starts a periodic watchdog that detects when the CLI process has produced
   * no stdout/stderr data for an extended period. Pushes progressive warnings
   * into provisioningOutputParts so they appear in the Live output section.
   */
  private startStallWatchdog(run: ProvisioningRun): void {
    this.createOutputRecoveryHelper().startStallWatchdog(run);
  }

  private stopStallWatchdog(run: ProvisioningRun): void {
    this.createOutputRecoveryHelper().stopStallWatchdog(run);
  }

  /**
   * Detects auth failure keywords in stderr/stdout during provisioning.
   * On first detection: kills process, waits, and respawns automatically.
   * On second detection (after retry): fails fast with a clear error.
   */
  private handleAuthFailureInOutput(
    run: ProvisioningRun,
    text: string,
    source: AuthWarningSource
  ): void {
    this.createOutputRecoveryHelper().handleAuthFailureInOutput(run, text, source);
  }

  /**
   * Kills the current process, waits for lock release, and respawns with saved context.
   * Reattaches all stream listeners and resends the prompt.
   */
  private async respawnAfterAuthFailure(run: ProvisioningRun): Promise<void> {
    await respawnCliAfterAuthFailure(
      run,
      {
        logger,
        clearTimeout: (handle) => clearTimeout(handle),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        nowMs: () => Date.now(),
        sleep,
        pathExists: async (filePath) => {
          try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
          } catch {
            return false;
          }
        },
        mcpConfigBuilder: this.mcpConfigBuilder,
        readBootstrapRealTaskSubmissionState,
        writeDeterministicBootstrapUserPromptFile,
        validateAgentTeamsMcpRuntime: (claudePath, cwd, env, mcpConfigPath, options) =>
          this.providerRuntime.validateAgentTeamsMcpRuntime(
            claudePath,
            cwd,
            env,
            mcpConfigPath,
            options
          ),
        spawnCli,
        getStopAllTeamsGeneration: () => this.stopAllTeamsGeneration,
        isStopAllTeamsGenerationChanged: (stopAllGenerationAtStart) =>
          this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
        stopFilesystemMonitor: (provisioningRun) => this.stopFilesystemMonitor(provisioningRun),
        stopStallWatchdog: (provisioningRun) => this.stopStallWatchdog(provisioningRun),
        killTeamProcess,
        updateProgress,
        extractCliLogsFromRun,
        cleanupRun: (provisioningRun) => this.cleanupRun(provisioningRun),
        attachStdoutHandler: (provisioningRun) => this.attachStdoutHandler(provisioningRun),
        attachStderrHandler: (provisioningRun) => this.attachStderrHandler(provisioningRun),
        startStallWatchdog: (provisioningRun) => this.startStallWatchdog(provisioningRun),
        startFilesystemMonitor: (provisioningRun, request) =>
          this.startFilesystemMonitor(provisioningRun, request),
        tryCompleteAfterTimeout: (provisioningRun) => this.tryCompleteAfterTimeout(provisioningRun),
        getProvisioningRunTimeoutMs,
        handleProcessExit: (provisioningRun, code) => this.handleProcessExit(provisioningRun, code),
      },
      { preflightAuthRetryDelayMs: PREFLIGHT_AUTH_RETRY_DELAY_MS }
    );
  }

  /** Attaches the stdout stream-json parser to the current child process. */
  private attachStdoutHandler(run: ProvisioningRun): void {
    this.createOutputRecoveryHelper().attachStdoutHandler(run);
  }

  private updateStdoutParserCarry(run: ProvisioningRun, carry: string): void {
    this.createOutputRecoveryHelper().updateStdoutParserCarry(run, carry);
  }

  private flushStdoutParserCarry(run: ProvisioningRun): void {
    this.createOutputRecoveryHelper().flushStdoutParserCarry(run);
  }

  private buildStdoutCarryDiagnostic(run: ProvisioningRun): Record<string, unknown> {
    return this.createOutputRecoveryHelper().buildStdoutCarryDiagnostic(run);
  }

  private getUnconfirmedBootstrapMemberNames(run: ProvisioningRun): string[] {
    return this.createOutputRecoveryHelper().getUnconfirmedBootstrapMemberNames(run);
  }

  private handleStdoutParserLine(run: ProvisioningRun, trimmed: string): void {
    this.createOutputRecoveryHelper().handleStdoutParserLine(run, trimmed);
  }

  private handleParsedStdoutJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    this.createOutputRecoveryHelper().handleParsedStdoutJsonMessage(run, msg);
  }

  /** Attaches the stderr handler with auth failure detection. */
  private attachStderrHandler(run: ProvisioningRun): void {
    this.createOutputRecoveryHelper().attachStderrHandler(run);
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
      const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
      await assertCreateTeamDoesNotExist(request.teamName, teamsBasePathsToProbe, (filePath) =>
        this.pathExists(filePath)
      );

      await ensureCwdExists(request.cwd);

      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) {
        throw buildMissingCliError();
      }

      const runtimeAuthMaterialId = randomUUID();
      const teamRuntimeAuth: TeamRuntimeAuthContext = {
        teamName: request.teamName,
        authMaterialId: runtimeAuthMaterialId,
        allowAnthropicApiKeyHelper: true,
      };
      const provisioningEnv = await this.providerRuntime.buildProvisioningEnv(
        request.providerId,
        request.providerBackendId,
        { includeCodexTeammateAuth: teamRequestIncludesCodexMember(request), teamRuntimeAuth }
      );
      const {
        env: shellEnv,
        geminiRuntimeAuth,
        providerArgs = [],
        warning: envWarning,
      } = provisioningEnv;
      if (envWarning) {
        throw new Error(envWarning);
      }
      const workspaceTrustFeatureFlags = resolveWorkspaceTrustFeatureFlags();
      const workspaceTrustProviders = workspaceTrustFeatureFlags.enabled
        ? collectWorkspaceTrustProvidersHelper({
            leadProviderId: request.providerId,
            members: request.members,
          })
        : [];
      const workspaceTrustEarlyWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await collectWorkspaceTrustWorkspacesHelper({
            cwd: request.cwd,
            members: [],
            ports: this.workspaceTrustWorkspaceCollectionPorts,
          })
        : [];
      const workspaceTrustEarlyPlan = workspaceTrustFeatureFlags.enabled
        ? await planWorkspaceTrustArgsOnlySafelyHelper({
            coordinator: this.workspaceTrustCoordinator,
            request: {
              providers: workspaceTrustProviders,
              workspaces: workspaceTrustEarlyWorkspaces,
              targetSurfaces: ['default_model_probe'],
              featureFlags: workspaceTrustFeatureFlags,
            },
          })
        : { launchArgPatches: [] };
      const workspaceTrustProviderArgsResolver =
        createDefaultModelWorkspaceTrustProviderArgsResolverHelper(workspaceTrustEarlyPlan);
      const materializedMemberSpecs = await this.materializeEffectiveTeamMemberSpecs({
        claudePath,
        cwd: request.cwd,
        members: request.members,
        defaults: {
          providerId: request.providerId,
          model: request.model,
          effort: request.effort,
        },
        primaryProviderId: request.providerId,
        primaryEnv: provisioningEnv,
        teamRuntimeAuth,
        limitContext: request.limitContext,
        providerArgsResolver: workspaceTrustProviderArgsResolver,
      });
      const allEffectiveMemberSpecs = await this.resolveOpenCodeMemberWorkspacesForRuntime({
        teamName: request.teamName,
        baseCwd: request.cwd,
        leadProviderId: request.providerId,
        members: materializedMemberSpecs,
      });
      Object.assign(
        shellEnv,
        await buildRuntimeTurnSettledEnvironmentForMembersHelper(
          {
            primaryProviderId: request.providerId,
            memberSpecs: allEffectiveMemberSpecs,
          },
          {
            environmentProvider: this.runtimeTurnSettledEnvironmentProvider,
            logger,
          }
        )
      );
      const lanePlan = this.planRuntimeLanesOrThrow(
        request.providerId,
        allEffectiveMemberSpecs,
        request.cwd
      );
      const primaryMemberNames = new Set(lanePlan.primaryMembers.map((member) => member.name));
      const effectiveMemberSpecs = allEffectiveMemberSpecs.filter((member) =>
        primaryMemberNames.has(member.name)
      );
      assertDeterministicBootstrapPrimaryMemberLimit(effectiveMemberSpecs.length);
      const largeTeamWarning = buildLargeDeterministicBootstrapWarning(effectiveMemberSpecs.length);
      const resolvedProviderId = resolveTeamProviderId(request.providerId);
      const crossProviderMemberArgs = await this.providerRuntime.buildCrossProviderMemberArgs(
        resolvedProviderId,
        effectiveMemberSpecs,
        { teamRuntimeAuth }
      );
      const workspaceTrustFullWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await collectWorkspaceTrustWorkspacesHelper({
            cwd: request.cwd,
            members: allEffectiveMemberSpecs,
            ports: this.workspaceTrustWorkspaceCollectionPorts,
          })
        : [];
      const workspaceTrustFullPlan = workspaceTrustFeatureFlags.enabled
        ? await planWorkspaceTrustFullSafelyHelper({
            coordinator: this.workspaceTrustCoordinator,
            request: {
              providers: collectWorkspaceTrustProvidersHelper({
                leadProviderId: request.providerId,
                members: allEffectiveMemberSpecs,
              }),
              workspaces: workspaceTrustFullWorkspaces,
              featureFlags: workspaceTrustFeatureFlags,
            },
          })
        : null;
      const workspaceTrustPatches = workspaceTrustFullPlan?.launchArgPatches ?? [];
      const {
        providerArgsForLaunch,
        crossProviderMemberArgsForLaunch,
        providerArgsByProvider,
      } = buildWorkspaceTrustLaunchArgsHelper({
        providerArgs,
        resolvedProviderId,
        crossProviderMemberArgs,
        workspaceTrustPatches,
      });
      Object.assign(shellEnv, crossProviderMemberArgs.envPatch);
      if (crossProviderMemberArgs.usesAnthropicApiKeyHelper) {
        for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
          delete shellEnv[key];
        }
      }
      const launchIdentity = await this.resolveAndValidateLaunchIdentity({
        claudePath,
        cwd: request.cwd,
        env: shellEnv,
        request,
        effectiveMembers: effectiveMemberSpecs,
        providerArgsByProvider,
      });
      const runId = randomUUID();
      const startedAt = nowIso();
      const run: ProvisioningRun = {
        runId,
        teamName: request.teamName,
        startedAt,
        stdoutBuffer: '',
        stderrBuffer: '',
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        stdoutParserCarry: '',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: false,
        claudeLogsUpdatedAt: undefined,
        deterministicBootstrapStartedAt: undefined,
        lastDeterministicBootstrapEvent: undefined,
        lastDeterministicBootstrapPhase: undefined,
        deterministicBootstrapMemberSpawnSeen: false,
        deterministicBootstrapMemberResultSeen: false,
        processKilled: false,
        finalizingByTimeout: false,
        cancelRequested: false,
        teamsBasePathsToProbe,
        child: null,
        timeoutHandle: null,
        fsMonitorHandle: null,
        onProgress,
        expectedMembers: effectiveMemberSpecs.map((member) => member.name),
        request,
        allEffectiveMembers: allEffectiveMemberSpecs,
        effectiveMembers: effectiveMemberSpecs,
        launchIdentity,
        mixedSecondaryLanes: this.createMixedSecondaryLaneStates(lanePlan),
        lastLogProgressAt: 0,
        lastDataReceivedAt: 0, // intentionally 0 — real reset happens after spawn (see startStallWatchdog call sites)
        lastStdoutReceivedAt: 0,
        stallCheckHandle: null,
        stallWarningIndex: null,
        preStallMessage: null,
        lastRetryAt: 0,
        apiRetryWarningIndex: null,
        apiErrorWarningEmitted: false,
        waitingTasksSince: null,
        provisioningComplete: false,
        processClosed: false,
        requiresFirstRealTurnSuccess: false,
        firstRealTurnSucceeded: false,
        mcpConfigPath: null,
        memberMcpConfigPaths: [],
        bootstrapSpecPath: null,
        bootstrapUserPromptPath: null,
        isLaunch: false,
        launchStateClearedForRun: false,
        deterministicBootstrap: true,
        workspaceTrustPlan: workspaceTrustFullPlan,
        workspaceTrustExecution: null,
        workspaceTrustDiagnostics: null,
        workspaceTrustRetryAttempted: false,
        fsPhase: 'waiting_config',
        leadRelayCapture: null,
        activeCrossTeamReplyHints: [],
        leadMsgSeq: 0,
        liveLeadTextBuffer: null,
        pendingToolCalls: [],
        activeToolCalls: new Map(),
        pendingDirectCrossTeamSendRefresh: false,
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        pendingInboxRelayCandidates: [],
        provisioningOutputParts: [],
        provisioningTraceLines: [],
        lastProvisioningTraceKey: null,
        provisioningOutputIndexByMessageId: new Map(),
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        anthropicApiKeyHelper: provisioningEnv.anthropicApiKeyHelper ?? null,
        pendingApprovals: new Map(),
        processedPermissionRequestIds: new Set(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
        pendingGeminiPostLaunchHydration: false,
        geminiPostLaunchHydrationInFlight: false,
        geminiPostLaunchHydrationSent: false,
        suppressGeminiPostLaunchHydrationOutput: false,
        memberSpawnStatuses: new Map(
          effectiveMemberSpecs.map((member) => [member.name, createInitialMemberSpawnStatusEntry()])
        ),
        memberSpawnToolUseIds: new Map(),
        pendingMemberRestarts: new Map(),
        memberSpawnLeadInboxCursorByMember: new Map(),
        lastDeterministicBootstrapSeq: 0,
        lastMemberSpawnAuditAt: 0,
        lastMemberSpawnAuditConfigReadWarningAt: 0,
        lastMemberSpawnAuditMissingWarningAt: new Map(),
        progress: {
          runId,
          teamName: request.teamName,
          state: 'validating',
          message: 'Validating team provisioning request',
          startedAt,
          updatedAt: startedAt,
          warnings: largeTeamWarning ? [largeTeamWarning] : undefined,
          cliLogsTail: undefined,
        },
      };

      this.resetTeamScopedTransientStateForNewRun(request.teamName);
      this.runs.set(runId, run);
      this.provisioningRunByTeam.set(request.teamName, runId);
      initializeProvisioningTrace(run);
      run.onProgress(run.progress);
      await this.prepareWorkspaceTrustForDeterministicRun({
        mode: 'create',
        run,
        claudePath,
        shellEnv,
        stopAllGenerationAtStart,
        workspaceTrustPlan: workspaceTrustFullPlan,
        featureFlags: workspaceTrustFeatureFlags,
        provisioningEnv,
      });
      emitProvisioningCheckpoint(run, 'Clearing persisted launch state');
      await this.clearPersistedLaunchState(request.teamName, { expectedRunId: run.runId });
      run.launchStateClearedForRun = true;

      const initialUserPrompt = request.prompt?.trim() ?? '';
      const promptSize = getPromptSizeSummary(initialUserPrompt);
      let child: ReturnType<typeof spawn>;
      shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
      const teammateModeDecision = await resolveDesktopTeammateModeDecision(request.extraCliArgs);
      applyDesktopTeammateModeDecisionToEnv(shellEnv, teammateModeDecision);
      let mcpConfigPath: string;
      let bootstrapSpecPath: string;
      let bootstrapUserPromptPath: string | null = null;
      try {
        // Pre-save our meta files before native app-managed briefing generation.
        // member_briefing intentionally reads canonical team metadata/inboxes, so
        // createTeam must materialize those files before building the bootstrap spec.
        const materializedBootstrapFiles = await materializeDeterministicCreateTeamBootstrapFiles({
          request,
          run,
          effectiveMemberSpecs,
          allEffectiveMemberSpecs,
          launchIdentity,
          initialUserPrompt,
          promptSize,
          controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
          teamMetaStore: {
            writeMeta: (teamName, payload) =>
              this.teamMetaStore.writeMeta(
                teamName,
                payload as Parameters<typeof this.teamMetaStore.writeMeta>[1]
              ),
          },
          membersMetaStore: this.membersMetaStore,
          mcpConfigBuilder: this.mcpConfigBuilder,
          buildMemberMcpLaunchConfigs: () =>
            this.buildRuntimeBootstrapMemberMcpLaunchConfigs({
              controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
              cwd: request.cwd,
              members: effectiveMemberSpecs,
              run,
            }),
          validateAgentTeamsMcpRuntime: (createdMcpConfigPath) =>
            this.providerRuntime.validateAgentTeamsMcpRuntime(
              claudePath,
              request.cwd,
              shellEnv,
              createdMcpConfigPath,
              {
                isCancelled: () =>
                  run.cancelRequested ||
                  run.processKilled ||
                  this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
              }
            ),
        });
        mcpConfigPath = materializedBootstrapFiles.mcpConfigPath;
        bootstrapSpecPath = materializedBootstrapFiles.bootstrapSpecPath;
        bootstrapUserPromptPath = materializedBootstrapFiles.bootstrapUserPromptPath;
      } catch (error) {
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        if (provisioningEnv.anthropicApiKeyHelper) {
          await cleanupAnthropicTeamApiKeyHelperMaterial({
            directory: provisioningEnv.anthropicApiKeyHelper.directory,
          }).catch(() => undefined);
        }
        await this.teamMetaStore.deleteMeta(request.teamName).catch(() => {});
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        const tasksDir = path.join(getTasksBasePath(), request.teamName);
        await fs.promises.rm(teamDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.rm(tasksDir, { recursive: true, force: true }).catch(() => {});
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        await this.removeRunMemberMcpConfigFiles(run).catch(() => {});
        throw error;
      }
      const launchModelArg = getLaunchModelArg(
        resolveTeamProviderId(request.providerId),
        request.model,
        launchIdentity
      );
      const extraCliArgs = parseCliArgs(request.extraCliArgs);
      const runtimeArgsPlan = await this.buildTeamRuntimeLaunchArgsPlan({
        teamName: request.teamName,
        providerId: resolvedProviderId,
        launchIdentity,
        envResolution: { ...provisioningEnv, providerArgs: providerArgsForLaunch },
        extraArgs: extraCliArgs,
        inheritedProviderArgs: crossProviderMemberArgsForLaunch.args,
        includeAnthropicHelper: resolvedProviderId === 'anthropic',
        contextLabel: 'Team create launch',
      });
      const spawnArgs = buildDeterministicCreateSpawnArgs({
        mcpConfigPath,
        bootstrapSpecPath,
        bootstrapUserPromptPath,
        skipPermissions: request.skipPermissions,
        launchModelArg,
        resolvedEffort: launchIdentity.resolvedEffort ?? undefined,
        providerArgs: runtimeArgsPlan.providerArgs,
        fastModeArgs: runtimeArgsPlan.fastModeArgs,
        runtimeTurnSettledHookArgs: runtimeArgsPlan.runtimeTurnSettledHookArgs,
        runtimeExtraArgs: runtimeArgsPlan.extraArgs,
        settingsArgs: runtimeArgsPlan.settingsArgs,
        inheritedProviderArgs: runtimeArgsPlan.inheritedProviderArgs,
        worktree: request.worktree,
        teammateModeDecision,
        disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      });
      applyAppManagedRuntimeSettingsPathEnv(shellEnv, runtimeArgsPlan.appManagedSettingsPath);
      const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      logRuntimeLaunchSnapshot(logger, request.teamName, claudePath, spawnArgs, request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
        launchIdentity,
      });
      try {
        if (
          run.cancelRequested ||
          run.processKilled ||
          this.stopAllTeamsGeneration !== stopAllGenerationAtStart
        ) {
          throw new Error('Team launch cancelled by app shutdown');
        }
        if (request.skipPermissions === false) {
          emitProvisioningCheckpoint(run, 'Seeding lead bootstrap permission rules');
          await this.seedLeadBootstrapPermissionRules(request.teamName, request.cwd);
        }

        emitProvisioningCheckpoint(
          run,
          'Spawning Claude CLI process',
          `args=${spawnArgs.length} cwd=${request.cwd}`
        );
        child = spawnCli(claudePath, spawnArgs, {
          cwd: request.cwd,
          env: { ...shellEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        // Clean up pre-saved meta files if spawn failed (instant failure, not transient)
        await this.teamMetaStore.deleteMeta(request.teamName).catch(() => {});
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        const tasksDir = path.join(getTasksBasePath(), request.teamName);
        await fs.promises.rm(teamDir, { recursive: true, force: true }).catch(() => {});
        await fs.promises.rm(tasksDir, { recursive: true, force: true }).catch(() => {});
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        await this.removeRunMemberMcpConfigFiles(run).catch(() => {});
        if (provisioningEnv.anthropicApiKeyHelper) {
          await cleanupAnthropicTeamApiKeyHelperMaterial({
            directory: provisioningEnv.anthropicApiKeyHelper.directory,
          }).catch(() => undefined);
        }
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        throw error;
      }

      updateProgress(run, 'spawning', 'Starting Claude CLI process', {
        pid: child.pid ?? undefined,
        warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
      });
      run.onProgress(run.progress);
      run.child = child;
      run.processClosed = false;
      run.spawnContext = {
        claudePath,
        args: spawnArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt: initialUserPrompt,
      };

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

      // Reset AFTER spawn — not at run init — because async operations (buildProvisioningEnv,
      // writeConfigFile) between init and spawn can take seconds, causing false stall warnings.
      run.lastDataReceivedAt = Date.now();
      run.lastStdoutReceivedAt = Date.now();
      this.startStallWatchdog(run);

      // Filesystem-based progress monitor: actively polls team files instead
      // of relying on stdout (which only arrives at the end in text mode).
      // When config + members + tasks are all present, kill the process early
      // rather than waiting for it to deadlock on system-reminder shutdown.
      updateProgress(run, 'configuring', 'Waiting for team configuration...');
      run.onProgress(run.progress);
      this.startFilesystemMonitor(run, request);

      run.timeoutHandle = setTimeout(() => {
        if (!run.processKilled && !run.provisioningComplete) {
          run.processKilled = true;
          run.finalizingByTimeout = true;
          void (async () => {
            const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
            killTeamProcess(run.child);
            if (readyOnTimeout) {
              return; // cleanupRun already called inside tryCompleteAfterTimeout
            }

            const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI', {
              error:
                'Timed out waiting for CLI. Run `claude` once in terminal to complete onboarding and try again.',
              cliLogsTail: extractCliLogsFromRun(run),
            });
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, getProvisioningRunTimeoutMs(run));

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI', {
          error: error.message,
          cliLogsTail: extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        this.cleanupRun(run);
      });

      child.once('close', (code) => {
        void this.handleProcessExit(run, code);
      });

      return { runId };
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
    const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
    for (const probe of teamsBasePathsToProbe) {
      const configPath = path.join(probe.basePath, request.teamName, 'config.json');
      if (await this.pathExists(configPath)) {
        const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
        throw new Error(`Team already exists${suffix}`);
      }
    }

    await ensureCwdExists(request.cwd);
    const materialized = await this.materializeOpenCodeRuntimeAdapterDefaults({
      request,
      members: request.members,
    });
    const launchRequest = materialized.request;
    const effectiveMembers = await this.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: launchRequest.teamName,
      baseCwd: launchRequest.cwd,
      leadProviderId: launchRequest.providerId,
      members: materialized.members,
    });
    const lanePlan = this.planRuntimeLanesOrThrow(
      launchRequest.providerId,
      effectiveMembers,
      launchRequest.cwd
    );
    const runtimeLaunchMembers = this.buildOpenCodeRuntimeAdapterLaunchMembers(
      launchRequest,
      effectiveMembers,
      lanePlan
    );
    const teamDir = path.join(getTeamsBasePath(), launchRequest.teamName);
    const tasksDir = path.join(getTasksBasePath(), launchRequest.teamName);
    await fs.promises.mkdir(teamDir, { recursive: true });
    await fs.promises.mkdir(tasksDir, { recursive: true });
    await this.teamMetaStore.writeMeta(launchRequest.teamName, {
      displayName: launchRequest.displayName,
      description: launchRequest.description,
      color: launchRequest.color,
      cwd: launchRequest.cwd,
      prompt: launchRequest.prompt,
      providerId: launchRequest.providerId,
      providerBackendId: launchRequest.providerBackendId,
      model: launchRequest.model,
      effort: launchRequest.effort,
      skipPermissions: launchRequest.skipPermissions,
      worktree: launchRequest.worktree,
      extraCliArgs: launchRequest.extraCliArgs,
      limitContext: launchRequest.limitContext,
      createdAt: Date.now(),
    });
    const membersToWrite = buildMembersMetaWritePayload(effectiveMembers);
    await this.membersMetaStore.writeMembers(launchRequest.teamName, membersToWrite, {
      providerBackendId: launchRequest.providerBackendId,
    });
    await this.writeOpenCodeTeamConfig(launchRequest, effectiveMembers);
    if (isPureOpenCodeWorktreeRootLanePlan(lanePlan)) {
      return this.runOpenCodeWorktreeRootAggregateLaunch({
        request: launchRequest,
        members: effectiveMembers,
        lanePlan,
        prompt: launchRequest.prompt?.trim() ?? '',
        sourceWarning: undefined,
        onProgress,
      });
    }

    return this.runOpenCodeTeamRuntimeAdapterLaunch({
      request: launchRequest,
      members: runtimeLaunchMembers,
      prompt: launchRequest.prompt?.trim() ?? '',
      sourceWarning: undefined,
      onProgress,
    });
  }

  private async launchOpenCodeTeamThroughRuntimeAdapter(
    request: TeamLaunchRequest,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): Promise<TeamLaunchResponse> {
    const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
    const configRaw = await tryReadRegularFileUtf8(configPath, {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
    if (!configRaw) {
      throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
    }
    await ensureCwdExists(request.cwd);
    const { members, warning } = await this.resolveLaunchExpectedMembers(
      request.teamName,
      configRaw,
      request.providerId
    );
    const materialized = await this.materializeOpenCodeRuntimeAdapterDefaults({
      request,
      members,
    });
    const launchRequest = materialized.request;
    const effectiveMembers = await this.resolveOpenCodeMemberWorkspacesForRuntime({
      teamName: launchRequest.teamName,
      baseCwd: launchRequest.cwd,
      leadProviderId: launchRequest.providerId,
      members: materialized.members,
    });
    const lanePlan = this.planRuntimeLanesOrThrow(
      launchRequest.providerId,
      effectiveMembers,
      launchRequest.cwd
    );
    const runtimeLaunchMembers = this.buildOpenCodeRuntimeAdapterLaunchMembers(
      launchRequest,
      effectiveMembers,
      lanePlan
    );
    await this.updateConfigProjectPath(launchRequest.teamName, launchRequest.cwd);

    let existingTasks: TeamTask[] = [];
    try {
      existingTasks = await new TeamTaskReader().getTasks(request.teamName);
    } catch (error) {
      logger.warn(
        `[${request.teamName}] Failed to read tasks for OpenCode launch prompt: ${String(error)}`
      );
    }
    const prompt = buildDeterministicLaunchHydrationPrompt(
      launchRequest,
      effectiveMembers,
      existingTasks,
      false
    );
    if (isPureOpenCodeWorktreeRootLanePlan(lanePlan)) {
      return this.runOpenCodeWorktreeRootAggregateLaunch({
        request: launchRequest,
        members: effectiveMembers,
        lanePlan,
        prompt,
        sourceWarning: warning,
        onProgress,
      });
    }

    return this.runOpenCodeTeamRuntimeAdapterLaunch({
      request: launchRequest,
      members: runtimeLaunchMembers,
      prompt,
      sourceWarning: warning,
      onProgress,
    });
  }

  private createOpenCodeAggregateProvisioningRun(
    params: CreateOpenCodeAggregateProvisioningRunParams
  ): ProvisioningRun {
    return createOpenCodeAggregateProvisioningRunHelper(params);
  }

  private async launchOpenCodeAggregatePrimaryLane(params: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeLaunchResult | null> {
    if (params.run.effectiveMembers.length === 0) {
      return null;
    }

    const teamName = params.run.teamName;
    const runId = params.run.runId;
    const launchCwd = this.getOpenCodeRuntimeLaunchCwd(
      params.run.request.cwd,
      params.run.effectiveMembers
    );
    const migration = await migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      state: migration.degraded ? 'degraded' : 'active',
      diagnostics: migration.diagnostics,
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
      runId,
    });

    const expectedMembers: TeamRuntimeMemberSpec[] = params.run.effectiveMembers.map((member) => ({
      name: member.name,
      role: member.role,
      workflow: member.workflow,
      isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
      providerId: 'opencode',
      model: member.model ?? params.run.request.model,
      effort: member.effort ?? params.run.request.effort,
      cwd: member.cwd?.trim() || launchCwd,
    }));
    const launchInput: TeamRuntimeLaunchInput = {
      runId,
      laneId: 'primary',
      teamName,
      cwd: launchCwd,
      prompt: params.prompt,
      providerId: 'opencode',
      model: params.run.request.model,
      effort: params.run.request.effort,
      skipPermissions: params.run.request.skipPermissions !== false,
      expectedMembers,
      previousLaunchState: params.previousLaunchState,
    };
    const launchResult = await params.adapter.launch(launchInput);
    const { snapshot, result } = await this.persistOpenCodeRuntimeAdapterLaunchResult(
      launchResult,
      launchInput
    );
    const snapshotStatuses = snapshotToMemberSpawnStatuses(snapshot);
    for (const member of expectedMembers) {
      const status = snapshotStatuses[member.name];
      if (status) {
        params.run.memberSpawnStatuses.set(member.name, status);
      }
    }
    this.syncOpenCodeRuntimeToolApprovals({
      teamName,
      runId,
      laneId: 'primary',
      cwd: launchCwd,
      members: result.members,
      expectedMembers,
      teamColor: params.run.request.color,
      teamDisplayName: params.run.request.displayName,
    });
    if (result.teamLaunchState !== 'partial_failure') {
      this.runtimeAdapterRunByTeam.set(teamName, {
        runId,
        providerId: 'opencode',
        cwd: launchCwd,
        members: result.members,
      });
    }
    return result;
  }

  private summarizeOpenCodeAggregateLaunchState(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'] {
    const states = [
      input.primaryResult?.teamLaunchState,
      ...input.lanes.map((lane) => lane.result?.teamLaunchState),
    ].filter((state): state is TeamRuntimeLaunchResult['teamLaunchState'] => Boolean(state));
    if (states.length === 0 || states.some((state) => state === 'partial_failure')) {
      return 'partial_failure';
    }
    if (
      states.some((state) => state === 'partial_pending') ||
      input.lanes.some((lane) => !lane.result)
    ) {
      return 'partial_pending';
    }
    return 'clean_success';
  }

  private async runOpenCodeWorktreeRootAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_worktree_root_lanes' }>;
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is not registered');
    }

    const stopAllGenerationAtStart = this.stopAllTeamsGeneration;
    const previousRuntimeRun = this.runtimeAdapterRunByTeam.get(input.request.teamName);
    if (previousRuntimeRun?.providerId === 'opencode') {
      await this.stopOpenCodeRuntimeAdapterTeam(input.request.teamName, previousRuntimeRun.runId);
    }
    if (this.hasSecondaryRuntimeRuns(input.request.teamName)) {
      await this.stopMixedSecondaryRuntimeLanes(input.request.teamName);
    }
    const previousPendingRunId = this.provisioningRunByTeam.get(input.request.teamName);
    const previousRuntimeProgress = previousPendingRunId
      ? this.runtimeAdapterProgressByRunId.get(previousPendingRunId)
      : null;
    if (
      previousPendingRunId &&
      previousRuntimeProgress &&
      this.isCancellableRuntimeAdapterProgress(previousRuntimeProgress)
    ) {
      await this.cancelRuntimeAdapterProvisioning(previousPendingRunId, previousRuntimeProgress);
    }
    if (this.stopAllTeamsGeneration !== stopAllGenerationAtStart) {
      return this.recordCancelledOpenCodeRuntimeAdapterLaunch(
        input.request.teamName,
        input.sourceWarning,
        input.onProgress
      );
    }

    const runId = randomUUID();
    const startedAt = nowIso();
    const initialProgress: TeamProvisioningProgress = {
      runId,
      teamName: input.request.teamName,
      state: 'validating',
      message: 'Validating OpenCode worktree lane launch gate',
      startedAt,
      updatedAt: startedAt,
      warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
    };
    this.provisioningRunByTeam.set(input.request.teamName, runId);
    const initialRuntimeProgress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
      initialProgress,
      input.onProgress
    );
    this.resetTeamScopedTransientStateForNewRun(input.request.teamName);
    const previousLaunchState = await this.launchStateStore.read(input.request.teamName);
    await this.clearPersistedLaunchState(input.request.teamName);

    const run = this.createOpenCodeAggregateProvisioningRun({
      runId,
      startedAt,
      progress: initialRuntimeProgress,
      request: input.request,
      members: input.members,
      lanePlan: input.lanePlan,
      onProgress: input.onProgress,
    });
    this.runs.set(runId, run);
    this.invalidateRuntimeSnapshotCaches(input.request.teamName);

    const launching = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
      {
        ...initialRuntimeProgress,
        state: 'spawning',
        message: 'Starting OpenCode worktree runtime lanes',
        updatedAt: nowIso(),
      },
      input.onProgress
    );
    run.progress = launching;

    try {
      const primaryResult = await this.launchOpenCodeAggregatePrimaryLane({
        run,
        adapter,
        prompt: input.prompt,
        previousLaunchState,
      });
      for (const lane of run.mixedSecondaryLanes) {
        if (run.cancelRequested || run.processKilled) {
          break;
        }
        await this.launchSingleMixedSecondaryLane(run, lane);
      }

      run.provisioningComplete = true;
      const launchState = this.summarizeOpenCodeAggregateLaunchState({
        primaryResult,
        lanes: run.mixedSecondaryLanes,
      });
      const launchPhase = launchState === 'partial_pending' ? 'active' : 'finished';
      const snapshot = await this.persistLaunchStateSnapshot(run, launchPhase);
      if (snapshot) {
        this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
      }

      const success = launchState === 'clean_success';
      const pending = launchState === 'partial_pending';
      const failed = launchState === 'partial_failure';
      const finalProgress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
        {
          ...launching,
          state: success || pending ? 'ready' : 'failed',
          message: success
            ? 'OpenCode worktree lanes are ready'
            : pending
              ? 'OpenCode worktree lanes are waiting for runtime evidence or permissions'
              : 'OpenCode worktree lane launch failed readiness gate',
          messageSeverity: pending ? 'warning' : failed ? 'error' : undefined,
          updatedAt: nowIso(),
          error: failed
            ? run.mixedSecondaryLanes
                .flatMap((lane) => lane.diagnostics)
                .filter(Boolean)
                .join('\n') || 'OpenCode worktree lane launch failed'
            : undefined,
          cliLogsTail:
            run.mixedSecondaryLanes.flatMap((lane) => lane.diagnostics).join('\n') || undefined,
          configReady: true,
        },
        input.onProgress
      );
      run.progress = finalProgress;
      if (success || pending) {
        this.runTracking.setAliveRunId(input.request.teamName, runId);
      } else {
        this.runTracking.deleteAliveRunId(input.request.teamName);
        this.runtimeAdapterRunByTeam.delete(input.request.teamName);
      }
      if (this.provisioningRunByTeam.get(input.request.teamName) === runId) {
        this.provisioningRunByTeam.delete(input.request.teamName);
      }
      this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      this.teamChangeEmitter?.({
        type: 'process',
        teamName: input.request.teamName,
        runId,
        detail: finalProgress.state,
      });
      return { runId };
    } catch (error) {
      if (
        this.cancelledRuntimeAdapterRunIds.delete(runId) ||
        this.provisioningRunByTeam.get(input.request.teamName) !== runId
      ) {
        return { runId };
      }
      for (const lane of run.mixedSecondaryLanes) {
        await clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: getTeamsBasePath(),
          teamName: input.request.teamName,
          laneId: lane.laneId,
        }).catch(() => undefined);
        this.deleteSecondaryRuntimeRun(input.request.teamName, lane.laneId);
      }
      if (run.effectiveMembers.length > 0) {
        await clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: getTeamsBasePath(),
          teamName: input.request.teamName,
          laneId: 'primary',
        }).catch(() => undefined);
      }
      const message = error instanceof Error ? error.message : String(error);
      const failedProgress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
        {
          ...launching,
          state: 'failed',
          message: 'OpenCode worktree lane launch failed',
          messageSeverity: 'error',
          updatedAt: nowIso(),
          error: message,
          cliLogsTail: message,
        },
        input.onProgress
      );
      run.progress = failedProgress;
      if (this.provisioningRunByTeam.get(input.request.teamName) === runId) {
        this.provisioningRunByTeam.delete(input.request.teamName);
      }
      this.runtimeAdapterRunByTeam.delete(input.request.teamName);
      this.runTracking.deleteAliveRunId(input.request.teamName);
      this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      throw error;
    }
  }

  private async runOpenCodeTeamRuntimeAdapterLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    prompt: string;
    sourceWarning?: string;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): Promise<TeamLaunchResponse> {
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is not registered');
    }

    const stopAllGenerationAtStart = this.stopAllTeamsGeneration;
    const previousRuntimeRun = this.runtimeAdapterRunByTeam.get(input.request.teamName);
    if (previousRuntimeRun?.providerId === 'opencode') {
      await this.stopOpenCodeRuntimeAdapterTeam(input.request.teamName, previousRuntimeRun.runId);
    }
    const previousPendingRunId = this.provisioningRunByTeam.get(input.request.teamName);
    const previousRuntimeProgress = previousPendingRunId
      ? this.runtimeAdapterProgressByRunId.get(previousPendingRunId)
      : null;
    if (
      previousPendingRunId &&
      previousRuntimeProgress &&
      this.isCancellableRuntimeAdapterProgress(previousRuntimeProgress)
    ) {
      await this.cancelRuntimeAdapterProvisioning(previousPendingRunId, previousRuntimeProgress);
    }
    if (this.stopAllTeamsGeneration !== stopAllGenerationAtStart) {
      return this.recordCancelledOpenCodeRuntimeAdapterLaunch(
        input.request.teamName,
        input.sourceWarning,
        input.onProgress
      );
    }

    const runId = randomUUID();
    const startedAt = nowIso();
    const initialProgress: TeamProvisioningProgress = {
      runId,
      teamName: input.request.teamName,
      state: 'validating',
      message: 'Validating OpenCode team launch gate',
      startedAt,
      updatedAt: startedAt,
      warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
    };
    this.provisioningRunByTeam.set(input.request.teamName, runId);
    this.runtimeAdapterProgressState.setRuntimeAdapterProgress(initialProgress, input.onProgress);
    this.resetTeamScopedTransientStateForNewRun(input.request.teamName);
    const previousLaunchState = await this.launchStateStore.read(input.request.teamName);
    await this.clearPersistedLaunchState(input.request.teamName);
    await migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: getTeamsBasePath(),
      teamName: input.request.teamName,
      laneId: 'primary',
    });
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: input.request.teamName,
      laneId: 'primary',
      state: 'active',
    });
    const launchCwd = this.getOpenCodeRuntimeLaunchCwd(input.request.cwd, input.members);
    const launchInput: TeamRuntimeLaunchInput = {
      runId,
      laneId: 'primary',
      teamName: input.request.teamName,
      cwd: launchCwd,
      prompt: input.prompt,
      providerId: 'opencode',
      model: input.request.model,
      effort: input.request.effort,
      skipPermissions: input.request.skipPermissions !== false,
      expectedMembers: input.members.map((member) => ({
        name: member.name,
        role: member.role,
        workflow: member.workflow,
        isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
        providerId: 'opencode',
        model: member.model ?? input.request.model,
        effort: member.effort ?? input.request.effort,
        cwd: member.cwd?.trim() || launchCwd,
      })),
      previousLaunchState,
    };

    const launching = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
      {
        ...initialProgress,
        state: 'spawning',
        message: 'Starting OpenCode sessions through runtime adapter',
        updatedAt: nowIso(),
      },
      input.onProgress
    );

    try {
      await setOpenCodeRuntimeActiveRunManifest({
        teamsBasePath: getTeamsBasePath(),
        teamName: input.request.teamName,
        laneId: 'primary',
        runId,
      });
      const launchResult = await adapter.launch(launchInput);
      if (
        this.cancelledRuntimeAdapterRunIds.delete(runId) ||
        this.provisioningRunByTeam.get(input.request.teamName) !== runId
      ) {
        await this.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input.request.teamName, runId);
        return { runId };
      }
      const { result } = await this.persistOpenCodeRuntimeAdapterLaunchResult(
        launchResult,
        launchInput
      );
      const requestTeamColor = 'color' in input.request ? input.request.color : undefined;
      const requestTeamDisplayName =
        'displayName' in input.request ? input.request.displayName : undefined;
      this.syncOpenCodeRuntimeToolApprovals({
        teamName: input.request.teamName,
        runId,
        laneId: 'primary',
        cwd: launchCwd,
        members: result.members,
        expectedMembers: launchInput.expectedMembers,
        teamColor: requestTeamColor,
        teamDisplayName: requestTeamDisplayName,
      });
      const success = result.teamLaunchState === 'clean_success';
      const pending = result.teamLaunchState === 'partial_pending';
      const failed = result.teamLaunchState === 'partial_failure';
      const finalProgress = this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
        {
          ...launching,
          state: success || pending ? 'ready' : 'failed',
          message: success
            ? 'OpenCode team launch is ready'
            : pending
              ? 'OpenCode team launch is waiting for runtime evidence or permissions'
              : 'OpenCode team launch failed readiness gate',
          messageSeverity: pending
            ? 'warning'
            : result.teamLaunchState === 'partial_failure'
              ? 'error'
              : undefined,
          updatedAt: nowIso(),
          warnings: result.warnings.length > 0 ? result.warnings : launching.warnings,
          error:
            result.teamLaunchState === 'partial_failure'
              ? result.diagnostics.join('\n') || 'OpenCode launch failed'
              : undefined,
          cliLogsTail: result.diagnostics.join('\n') || undefined,
          configReady: true,
        },
        input.onProgress
      );
      if (failed) {
        await clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: getTeamsBasePath(),
          teamName: input.request.teamName,
          laneId: 'primary',
        }).catch(() => undefined);
        this.runtimeAdapterRunByTeam.delete(input.request.teamName);
        this.runTracking.deleteAliveRunId(input.request.teamName);
        this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      } else {
        this.runtimeAdapterRunByTeam.set(input.request.teamName, {
          runId,
          providerId: 'opencode',
          cwd: launchCwd,
          members: result.members,
        });
        this.runTracking.setAliveRunId(input.request.teamName, runId);
        this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      }
      if (this.provisioningRunByTeam.get(input.request.teamName) === runId) {
        this.provisioningRunByTeam.delete(input.request.teamName);
      }
      this.teamChangeEmitter?.({
        type: 'process',
        teamName: input.request.teamName,
        runId,
        detail: finalProgress.state,
      });
      return { runId };
    } catch (error) {
      if (
        this.cancelledRuntimeAdapterRunIds.delete(runId) ||
        this.provisioningRunByTeam.get(input.request.teamName) !== runId
      ) {
        await this.clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input.request.teamName, runId);
        return { runId };
      }
      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName: input.request.teamName,
        laneId: 'primary',
      }).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.runtimeAdapterProgressState.setRuntimeAdapterProgress(
        {
          ...launching,
          state: 'failed',
          message: 'OpenCode runtime adapter launch failed',
          messageSeverity: 'error',
          updatedAt: nowIso(),
          error: message,
          cliLogsTail: message,
        },
        input.onProgress
      );
      if (this.provisioningRunByTeam.get(input.request.teamName) === runId) {
        this.provisioningRunByTeam.delete(input.request.teamName);
      }
      throw error;
    }
  }

  private async writeOpenCodeTeamConfig(
    request: TeamCreateRequest,
    members: TeamCreateRequest['members']
  ): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
    const config: TeamConfig = {
      name: request.displayName?.trim() || request.teamName,
      description: request.description,
      color: request.color,
      projectPath: request.cwd,
      members: [
        {
          name: 'team-lead',
          role: 'Team Lead',
          agentType: 'team-lead',
          providerId: normalizeOptionalTeamProviderId(request.providerId),
          model: request.model,
          effort: request.effort,
          cwd: request.cwd,
        },
        ...members.map((member) => ({
          name: member.name,
          role: member.role,
          workflow: member.workflow,
          isolation: member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: normalizeOptionalTeamProviderId(member.providerId),
          model: member.model,
          effort: member.effort,
          mcpPolicy: normalizeTeamMemberMcpPolicy(member.mcpPolicy),
          cwd: member.cwd?.trim() || undefined,
        })),
      ],
    };
    await atomicWriteAsync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    TeamConfigReader.invalidateTeam(request.teamName);
  }

  private async persistOpenCodeRuntimeAdapterLaunchResult(
    result: TeamRuntimeLaunchResult,
    input: TeamRuntimeLaunchInput
  ): Promise<{
    snapshot: PersistedTeamLaunchSnapshot;
    result: TeamRuntimeLaunchResult;
  }> {
    const committedResult = await this.commitOpenCodeRuntimeAdapterLaunchSessionEvidence({
      teamName: input.teamName,
      laneId: input.laneId?.trim() || 'primary',
      result,
    });
    const members: Record<string, PersistedTeamLaunchMemberState> = {};
    for (const member of input.expectedMembers) {
      const evidence = committedResult.members[member.name];
      members[member.name] = this.toOpenCodePersistedLaunchMember(
        member,
        evidence,
        committedResult.runId
      );
    }
    const snapshot = createPersistedLaunchSnapshot({
      teamName: input.teamName,
      expectedMembers: input.expectedMembers.map((member) => member.name),
      bootstrapExpectedMembers: input.expectedMembers.map((member) => member.name),
      includeLeadMembers: true,
      leadSessionId: result.leadSessionId,
      launchPhase: committedResult.launchPhase,
      members,
    });
    return {
      snapshot: await this.writeLaunchStateSnapshot(input.teamName, snapshot),
      result: committedResult,
    };
  }

  private async commitOpenCodeRuntimeAdapterLaunchSessionEvidence(params: {
    teamName: string;
    laneId: string;
    result: TeamRuntimeLaunchResult;
  }): Promise<TeamRuntimeLaunchResult> {
    let changed = false;
    const members: Record<string, TeamRuntimeMemberLaunchEvidence> = { ...params.result.members };
    const bootstrapEvidencePorts = this.createOpenCodeRuntimeBootstrapEvidencePorts();
    for (const [memberName, evidence] of Object.entries(params.result.members)) {
      const runtimeSessionId = evidence.sessionId?.trim();
      const confirmed =
        evidence.launchState === 'confirmed_alive' ||
        evidence.bootstrapConfirmed === true ||
        evidence.livenessKind === 'confirmed_bootstrap';
      const appManagedCandidate =
        evidence.bootstrapEvidenceSource === 'app_managed_bootstrap' &&
        evidence.bootstrapMode === 'app_managed_context'
          ? evidence.appManagedBootstrapCandidate
          : undefined;
      const appManagedCandidateMatches =
        appManagedCandidate?.source === 'app_managed_bootstrap' &&
        appManagedCandidate.teamName === params.teamName &&
        appManagedCandidate.memberName === memberName &&
        appManagedCandidate.runId === params.result.runId &&
        appManagedCandidate.laneId === params.laneId &&
        appManagedCandidate.runtimeSessionId === runtimeSessionId;
      if ((!confirmed && !appManagedCandidateMatches) || !runtimeSessionId) {
        continue;
      }
      // For app-managed bootstrap, promotion is intentionally two-phase:
      // write the candidate as runtime evidence, then verify it using the same
      // reader path used by later reconciliation/restart flows.
      const source: OpenCodeBootstrapEvidenceSource = appManagedCandidateMatches
        ? 'app_managed_bootstrap'
        : (evidence.bootstrapEvidenceSource ?? 'runtime_bootstrap_checkin');
      await commitOpenCodeRuntimeBootstrapSessionEvidence(
        {
          teamName: params.teamName,
          runId: params.result.runId,
          laneId: params.laneId,
          memberName,
          runtimeSessionId,
          observedAt: nowIso(),
          source,
          appManagedBootstrapCandidate: appManagedCandidateMatches
            ? appManagedCandidate
            : evidence.appManagedBootstrapCandidate,
        },
        bootstrapEvidencePorts
      );
      const verified = await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
        {
          teamName: params.teamName,
          runId: params.result.runId,
          laneId: params.laneId,
          memberName,
          runtimeSessionId,
          source,
          appManagedBootstrapCandidate: appManagedCandidateMatches
            ? appManagedCandidate
            : evidence.appManagedBootstrapCandidate,
        },
        bootstrapEvidencePorts
      );
      if (appManagedCandidateMatches && verified && !confirmed) {
        members[memberName] = promoteCommittedOpenCodeAppManagedBootstrapEvidence(evidence);
        changed = true;
      }
    }
    if (!changed) {
      return params.result;
    }
    const teamLaunchState = summarizeRuntimeLaunchResultMembers(members);
    return {
      ...params.result,
      launchPhase: teamLaunchState === 'clean_success' ? 'finished' : params.result.launchPhase,
      teamLaunchState,
      members,
      diagnostics: appendDiagnosticOnce(
        params.result.diagnostics,
        'OpenCode app-managed bootstrap evidence was committed and read back before readiness promotion.'
      ),
    };
  }

  private toOpenCodePersistedLaunchMember(
    member: TeamRuntimeLaunchInput['expectedMembers'][number],
    evidence: TeamRuntimeMemberLaunchEvidence | undefined,
    runId?: string
  ): PersistedTeamLaunchMemberState {
    return toOpenCodePersistedLaunchMemberHelper(member, evidence, { runId, nowIso });
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
      // Verify config.json exists — team must already be provisioned
      const configPath = path.join(getTeamsBasePath(), request.teamName, 'config.json');
      const configRaw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!configRaw) {
        throw new Error(`Team "${request.teamName}" not found — config.json does not exist`);
      }
      const configProjectPath = parseLaunchConfigProjectPath(configRaw);

      const existingAliveRunId = this.runTracking.getAliveRunId(request.teamName);
      const existingRun = existingAliveRunId ? this.runs.get(existingAliveRunId) : null;
      const existingRunReuse = resolveExistingLaunchRunReuse({
        teamName: request.teamName,
        cwd: request.cwd,
        existingAliveRunId,
        existingRun,
        existingRunCwd: this.getRunTrackedCwd(existingRun),
        configProjectPath,
      });
      if (existingRunReuse.kind === 'blocked') {
        this.provisioningRunByTeam.delete(request.teamName);
        throw new Error(existingRunReuse.message);
      }
      if (existingRunReuse.kind === 'reuse') {
        this.provisioningRunByTeam.delete(request.teamName);
        return { runId: existingRunReuse.runId };
      }

      const launchCompatibility = await probeLaunchCompatibilityHelper(
        {
          teamName: request.teamName,
          configRaw,
          leadProviderId: request.providerId,
        },
        this.createLaunchExpectedMembersPorts()
      );
      if (launchCompatibility.level === 'unsafe') {
        this.provisioningRunByTeam.delete(request.teamName);
        throw new Error(launchCompatibility.blockers[0] ?? getMixedLaunchFallbackRecoveryError());
      }
      if (launchCompatibility.repairAction === 'materialize-members-meta') {
        await this.materializeLaunchCompatibilityRepair(request, launchCompatibility);
      }
      const {
        members: expectedMemberSpecs,
        source,
        warning,
      } = resolveLaunchExpectedMembersFromCompatibility(launchCompatibility);
      assertOpenCodeNotLaunchedThroughLegacyProvisioning({
        providerId: request.providerId,
        members: expectedMemberSpecs,
      });
      // Deterministic launch always sends --team-bootstrap-spec. The orchestrator
      // rejects combining that startup mode with --resume, so relaunch starts a
      // fresh lead runtime session and restores operational context from durable
      // team state instead of the previous transcript.
      if (request.clearContext) {
        logger.info(
          `[${request.teamName}] clearContext requested - starting fresh deterministic bootstrap session`
        );
      } else {
        logger.info(
          `[${request.teamName}] Starting fresh deterministic bootstrap session because ` +
            `--team-bootstrap-spec cannot be combined with --resume`
        );
      }

      // IMPORTANT: The CLI auto-suffixes teammate names when they already exist in config.json.
      // Normalize config.json to keep only the team-lead before spawning the CLI, so we get stable names.
      try {
        await this.normalizeTeamConfigForLaunch(request.teamName, configRaw);
        await this.assertConfigLeadOnlyForLaunch(request.teamName);

        // Update projectPath in config IMMEDIATELY so TeamDetailView shows the correct path
        // even if provisioning is interrupted or the user stops the team early.
        // If launch fails, restorePrelaunchConfig() will revert to the backup (old projectPath).
        await this.updateConfigProjectPath(request.teamName, request.cwd);
      } catch (error) {
        // Restore pre-launch backup so config.json is not left in normalized (lead-only) state.
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      let claudePath: string | null;
      try {
        await ensureCwdExists(request.cwd);

        claudePath = await ClaudeBinaryResolver.resolve();
        if (!claudePath) {
          throw buildMissingCliError();
        }
      } catch (error) {
        // Restore pre-launch backup so config.json is not left in normalized (lead-only) state
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      const teamsBasePathsToProbe = getTeamsBasePathsToProbe();
      const runId = randomUUID();
      const startedAt = nowIso();
      const teamRuntimeAuth: TeamRuntimeAuthContext = {
        teamName: request.teamName,
        authMaterialId: runId,
        allowAnthropicApiKeyHelper: true,
      };

      const provisioningEnv = await this.providerRuntime.buildProvisioningEnv(
        request.providerId,
        request.providerBackendId,
        { includeCodexTeammateAuth: teamRequestIncludesCodexMember(request), teamRuntimeAuth }
      );
      const {
        env: shellEnv,
        geminiRuntimeAuth,
        providerArgs = [],
        warning: envWarning,
      } = provisioningEnv;
      if (envWarning) {
        throw new Error(envWarning);
      }
      const workspaceTrustFeatureFlags = resolveWorkspaceTrustFeatureFlags();
      const workspaceTrustProviders = workspaceTrustFeatureFlags.enabled
        ? collectWorkspaceTrustProvidersHelper({
            leadProviderId: request.providerId,
            members: expectedMemberSpecs,
          })
        : [];
      const workspaceTrustEarlyWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await collectWorkspaceTrustWorkspacesHelper({
            cwd: request.cwd,
            members: [],
            ports: this.workspaceTrustWorkspaceCollectionPorts,
          })
        : [];
      const workspaceTrustEarlyPlan = workspaceTrustFeatureFlags.enabled
        ? await planWorkspaceTrustArgsOnlySafelyHelper({
            coordinator: this.workspaceTrustCoordinator,
            request: {
              providers: workspaceTrustProviders,
              workspaces: workspaceTrustEarlyWorkspaces,
              targetSurfaces: ['default_model_probe'],
              featureFlags: workspaceTrustFeatureFlags,
            },
          })
        : { launchArgPatches: [] };
      const workspaceTrustProviderArgsResolver =
        createDefaultModelWorkspaceTrustProviderArgsResolverHelper(workspaceTrustEarlyPlan);

      const materializedMemberSpecs = await this.materializeEffectiveTeamMemberSpecs({
        claudePath,
        cwd: request.cwd,
        members: expectedMemberSpecs,
        defaults: {
          providerId: request.providerId,
          model: request.model,
          effort: request.effort,
        },
        primaryProviderId: request.providerId,
        primaryEnv: provisioningEnv,
        teamRuntimeAuth,
        limitContext: request.limitContext,
        providerArgsResolver: workspaceTrustProviderArgsResolver,
      });
      const allEffectiveMemberSpecs = await this.resolveOpenCodeMemberWorkspacesForRuntime({
        teamName: request.teamName,
        baseCwd: request.cwd,
        leadProviderId: request.providerId,
        members: materializedMemberSpecs,
      });
      Object.assign(
        shellEnv,
        await buildRuntimeTurnSettledEnvironmentForMembersHelper(
          {
            primaryProviderId: request.providerId,
            memberSpecs: allEffectiveMemberSpecs,
          },
          {
            environmentProvider: this.runtimeTurnSettledEnvironmentProvider,
            logger,
          }
        )
      );
      const lanePlan = this.planRuntimeLanesOrThrow(
        request.providerId,
        allEffectiveMemberSpecs,
        request.cwd
      );
      const primaryMemberNames = new Set(lanePlan.primaryMembers.map((member) => member.name));
      const effectiveMemberSpecs = allEffectiveMemberSpecs.filter((member) =>
        primaryMemberNames.has(member.name)
      );
      assertDeterministicBootstrapPrimaryMemberLimit(effectiveMemberSpecs.length);
      const largeTeamWarning = buildLargeDeterministicBootstrapWarning(effectiveMemberSpecs.length);
      const initialLaunchWarnings = [warning, largeTeamWarning].filter((value): value is string =>
        Boolean(value)
      );
      const expectedMembers = effectiveMemberSpecs.map((member) => member.name);
      const resolvedProviderId = resolveTeamProviderId(request.providerId);
      const crossProviderMemberArgs = await this.providerRuntime.buildCrossProviderMemberArgs(
        resolvedProviderId,
        effectiveMemberSpecs,
        { teamRuntimeAuth }
      );
      const workspaceTrustFullWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await collectWorkspaceTrustWorkspacesHelper({
            cwd: request.cwd,
            members: allEffectiveMemberSpecs,
            ports: this.workspaceTrustWorkspaceCollectionPorts,
          })
        : [];
      const workspaceTrustFullPlan = workspaceTrustFeatureFlags.enabled
        ? await planWorkspaceTrustFullSafelyHelper({
            coordinator: this.workspaceTrustCoordinator,
            request: {
              providers: collectWorkspaceTrustProvidersHelper({
                leadProviderId: request.providerId,
                members: allEffectiveMemberSpecs,
              }),
              workspaces: workspaceTrustFullWorkspaces,
              featureFlags: workspaceTrustFeatureFlags,
            },
          })
        : null;
      const workspaceTrustPatches = workspaceTrustFullPlan?.launchArgPatches ?? [];
      const {
        providerArgsForLaunch,
        crossProviderMemberArgsForLaunch,
        providerArgsByProvider,
      } = buildWorkspaceTrustLaunchArgsHelper({
        providerArgs,
        resolvedProviderId,
        crossProviderMemberArgs,
        workspaceTrustPatches,
      });
      Object.assign(shellEnv, crossProviderMemberArgs.envPatch);
      if (crossProviderMemberArgs.usesAnthropicApiKeyHelper) {
        for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
          delete shellEnv[key];
        }
      }
      const launchIdentity = await this.resolveAndValidateLaunchIdentity({
        claudePath,
        cwd: request.cwd,
        env: shellEnv,
        request,
        effectiveMembers: effectiveMemberSpecs,
        providerArgsByProvider,
      });

      const syntheticRequest = buildLaunchSyntheticRequest({
        request,
        members: allEffectiveMemberSpecs,
        configRaw,
      });

      const run: ProvisioningRun = {
        runId,
        teamName: request.teamName,
        startedAt,
        stdoutBuffer: '',
        stderrBuffer: '',
        claudeLogLines: [],
        lastClaudeLogStream: null,
        stdoutLogLineBuf: '',
        stderrLogLineBuf: '',
        stdoutParserCarry: '',
        stdoutParserCarryIsCompleteJson: false,
        stdoutParserCarryLooksLikeClaudeJson: false,
        claudeLogsUpdatedAt: undefined,
        deterministicBootstrapStartedAt: undefined,
        lastDeterministicBootstrapEvent: undefined,
        lastDeterministicBootstrapPhase: undefined,
        deterministicBootstrapMemberSpawnSeen: false,
        deterministicBootstrapMemberResultSeen: false,
        processKilled: false,
        finalizingByTimeout: false,
        cancelRequested: false,
        teamsBasePathsToProbe,
        child: null,
        timeoutHandle: null,
        fsMonitorHandle: null,
        onProgress,
        expectedMembers,
        request: syntheticRequest,
        allEffectiveMembers: allEffectiveMemberSpecs,
        effectiveMembers: effectiveMemberSpecs,
        launchIdentity,
        mixedSecondaryLanes: this.createMixedSecondaryLaneStates(lanePlan),
        lastLogProgressAt: 0,
        lastDataReceivedAt: 0, // intentionally 0 — real reset happens after spawn (see startStallWatchdog call sites)
        lastStdoutReceivedAt: 0,
        stallCheckHandle: null,
        stallWarningIndex: null,
        preStallMessage: null,
        lastRetryAt: 0,
        apiRetryWarningIndex: null,
        apiErrorWarningEmitted: false,
        waitingTasksSince: null,
        provisioningComplete: false,
        processClosed: false,
        requiresFirstRealTurnSuccess: false,
        firstRealTurnSucceeded: false,
        mcpConfigPath: null,
        memberMcpConfigPaths: [],
        bootstrapSpecPath: null,
        bootstrapUserPromptPath: null,
        isLaunch: true,
        launchStateClearedForRun: false,
        deterministicBootstrap: true,
        workspaceTrustPlan: workspaceTrustFullPlan,
        workspaceTrustExecution: null,
        workspaceTrustDiagnostics: null,
        workspaceTrustRetryAttempted: false,
        fsPhase: 'waiting_members',
        leadRelayCapture: null,
        activeCrossTeamReplyHints: [],
        leadMsgSeq: 0,
        liveLeadTextBuffer: null,
        pendingToolCalls: [],
        activeToolCalls: new Map(),
        pendingDirectCrossTeamSendRefresh: false,
        lastLeadTextEmitMs: 0,
        silentUserDmForward: null,
        silentUserDmForwardClearHandle: null,
        pendingInboxRelayCandidates: [],
        provisioningOutputParts: [],
        provisioningTraceLines: [],
        lastProvisioningTraceKey: null,
        provisioningOutputIndexByMessageId: new Map(),
        detectedSessionId: null,
        leadActivityState: 'active',
        leadContextUsage: null,
        authFailureRetried: false,
        authRetryInProgress: false,
        spawnContext: null,
        anthropicApiKeyHelper: provisioningEnv.anthropicApiKeyHelper ?? null,
        pendingApprovals: new Map(),
        processedPermissionRequestIds: new Set(),
        pendingPostCompactReminder: false,
        postCompactReminderInFlight: false,
        suppressPostCompactReminderOutput: false,
        pendingGeminiPostLaunchHydration: false,
        geminiPostLaunchHydrationInFlight: false,
        geminiPostLaunchHydrationSent: false,
        suppressGeminiPostLaunchHydrationOutput: false,
        memberSpawnStatuses: new Map(
          expectedMembers.map((name) => [name, createInitialMemberSpawnStatusEntry()])
        ),
        memberSpawnToolUseIds: new Map(),
        pendingMemberRestarts: new Map(),
        memberSpawnLeadInboxCursorByMember: new Map(),
        lastDeterministicBootstrapSeq: 0,
        lastMemberSpawnAuditAt: 0,
        lastMemberSpawnAuditConfigReadWarningAt: 0,
        lastMemberSpawnAuditMissingWarningAt: new Map(),
        progress: {
          runId,
          teamName: request.teamName,
          state: 'validating',
          message: getInitialLaunchValidationMessage(source),
          startedAt,
          updatedAt: startedAt,
          warnings: initialLaunchWarnings.length > 0 ? initialLaunchWarnings : undefined,
          cliLogsTail: undefined,
        },
      };

      await prepareDeterministicLaunchRunState({
        teamName: request.teamName,
        run,
        prepareWorkspaceTrustForDeterministicRun: () =>
          this.prepareWorkspaceTrustForDeterministicRun({
            mode: 'launch',
            run,
            claudePath,
            shellEnv,
            stopAllGenerationAtStart,
            workspaceTrustPlan: workspaceTrustFullPlan,
            featureFlags: workspaceTrustFeatureFlags,
            provisioningEnv,
          }),
        resetTeamScopedTransientStateForNewRun: (teamName) =>
          this.resetTeamScopedTransientStateForNewRun(teamName),
        registerRun: (nextRunId, nextRun) => {
          this.runs.set(nextRunId, nextRun);
        },
        setProvisioningRunByTeam: (teamName, nextRunId) => {
          this.provisioningRunByTeam.set(teamName, nextRunId);
        },
        clearPersistedLaunchState: (teamName, options) =>
          this.clearPersistedLaunchState(teamName, options),
        publishMixedSecondaryLaneStatusChange: (nextRun, lane: MixedSecondaryRuntimeLaneState) =>
          this.publishMixedSecondaryLaneStatusChange(nextRun, lane),
      });

      // Read existing tasks to include in teammate prompts for work resumption
      emitProvisioningCheckpoint(run, 'Reading existing tasks for launch prompt');
      const taskReader = new TeamTaskReader();
      let existingTasks: TeamTask[] = [];
      try {
        existingTasks = await taskReader.getTasks(request.teamName);
      } catch (error) {
        logger.warn(
          `[${request.teamName}] Failed to read tasks for launch prompt: ${String(error)}`
        );
      }

      const prompt = buildDeterministicLaunchHydrationPrompt(
        request,
        effectiveMemberSpecs,
        existingTasks,
        false
      );
      const promptSize = getPromptSizeSummary(prompt);
      let child: ReturnType<typeof spawn>;
      shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
      const teammateModeDecision = await resolveDesktopTeammateModeDecision(request.extraCliArgs);
      applyDesktopTeammateModeDecisionToEnv(shellEnv, teammateModeDecision);
      let mcpConfigPath: string;
      let bootstrapSpecPath: string;
      let bootstrapUserPromptPath: string | null = null;
      try {
        emitProvisioningCheckpoint(
          run,
          'Building deterministic launch bootstrap spec',
          `expectedMembers=${effectiveMemberSpecs.length}`
        );
        const nativeBootstrapBuild = await buildNativeAppManagedBootstrapSpecsWithDiagnostics({
          teamName: request.teamName,
          cwd: request.cwd,
          members: effectiveMemberSpecs,
        });
        const memberMcpLaunchConfigs = await this.buildRuntimeBootstrapMemberMcpLaunchConfigs({
          controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
          cwd: request.cwd,
          members: effectiveMemberSpecs,
          run,
        });
        if (nativeBootstrapBuild.diagnostics.warning) {
          run.progress = {
            ...run.progress,
            warnings: mergeProvisioningWarnings(
              run.progress.warnings,
              nativeBootstrapBuild.diagnostics.warning
            ),
          };
          emitProvisioningCheckpoint(
            run,
            'Native bootstrap startup context is large',
            nativeBootstrapBuild.diagnostics.warning
          );
        }
        const bootstrapSpec = buildDeterministicLaunchBootstrapSpec(
          runId,
          request,
          effectiveMemberSpecs,
          nativeBootstrapBuild.specs,
          memberMcpLaunchConfigs
        );
        emitProvisioningCheckpoint(run, 'Writing deterministic bootstrap spec file');
        bootstrapSpecPath = await writeDeterministicBootstrapSpecFile(bootstrapSpec);
        run.bootstrapSpecPath = bootstrapSpecPath;
        emitProvisioningCheckpoint(
          run,
          'Writing launch hydration prompt file',
          `chars=${promptSize.chars} lines=${promptSize.lines}`
        );
        bootstrapUserPromptPath = await writeDeterministicBootstrapUserPromptFile(prompt);
        run.bootstrapUserPromptPath = bootstrapUserPromptPath;
        run.requiresFirstRealTurnSuccess = true;
        emitProvisioningCheckpoint(run, 'Writing MCP config file');
        mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(request.cwd, {
          controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
        });
        run.mcpConfigPath = mcpConfigPath;
        emitProvisioningCheckpoint(run, 'Validating agent-teams MCP runtime');
        await this.providerRuntime.validateAgentTeamsMcpRuntime(
          claudePath,
          request.cwd,
          shellEnv,
          mcpConfigPath,
          {
            isCancelled: () =>
              run.cancelRequested ||
              run.processKilled ||
              this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
          }
        );
      } catch (error) {
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        if (provisioningEnv.anthropicApiKeyHelper) {
          await cleanupAnthropicTeamApiKeyHelperMaterial({
            directory: provisioningEnv.anthropicApiKeyHelper.directory,
          }).catch(() => undefined);
        }
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        await this.removeRunMemberMcpConfigFiles(run).catch(() => {});
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }
      const extraCliArgs = parseCliArgs(request.extraCliArgs);
      const runtimeArgsPlan = await this.buildTeamRuntimeLaunchArgsPlan({
        teamName: request.teamName,
        providerId: resolvedProviderId,
        launchIdentity,
        envResolution: { ...provisioningEnv, providerArgs: providerArgsForLaunch },
        extraArgs: extraCliArgs,
        inheritedProviderArgs: crossProviderMemberArgsForLaunch.args,
        includeAnthropicHelper: resolvedProviderId === 'anthropic',
        contextLabel: 'Team launch',
      });
      // When the lead uses a different provider than some teammates (e.g., anthropic lead
      // with codex teammates), the lead needs the teammate provider's launch args so they
      // can be inherited by the teammate subprocess via buildInheritedCliFlags.
      // Without this, a codex teammate spawned from an anthropic lead has no way to learn
      // about the required forced_login_method (chatgpt/api) and fails to start.
      emitProvisioningCheckpoint(run, 'Resolving cross-provider member launch args');
      const finalLaunchArgs = buildDeterministicLaunchProcessArgs({
        mcpConfigPath,
        bootstrapSpecPath,
        bootstrapUserPromptPath,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        providerId: resolvedProviderId,
        model: request.model,
        launchIdentity,
        runtimeArgsPlan,
        teammateModeDecision,
        disallowedTools: APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
      });
      applyAppManagedRuntimeSettingsPathEnv(shellEnv, runtimeArgsPlan.appManagedSettingsPath);
      const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
        geminiRuntimeAuth,
        promptSize,
        expectedMembersCount: effectiveMemberSpecs.length,
      });
      logRuntimeLaunchSnapshot(
        logger,
        request.teamName,
        claudePath,
        finalLaunchArgs,
        request,
        shellEnv,
        {
          geminiRuntimeAuth,
          promptSize,
          expectedMembersCount: effectiveMemberSpecs.length,
          launchIdentity,
        }
      );
      // Deterministic bootstrap launches fresh because --team-bootstrap-spec and
      // --resume are not a supported orchestrator combination.
      emitProvisioningCheckpoint(run, 'Persisting team metadata before spawn');
      await this.teamMetaStore.writeMeta(request.teamName, {
        displayName: syntheticRequest.displayName,
        description: syntheticRequest.description,
        color: syntheticRequest.color,
        cwd: request.cwd,
        prompt: request.prompt,
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode,
        skipPermissions: request.skipPermissions,
        worktree: request.worktree,
        extraCliArgs: request.extraCliArgs,
        limitContext: request.limitContext,
        launchIdentity,
        createdAt: Date.now(),
      });
      await this.membersMetaStore.writeMembers(
        request.teamName,
        buildMembersMetaWritePayload(allEffectiveMemberSpecs),
        {
          providerBackendId: request.providerBackendId,
        }
      );

      try {
        if (
          run.cancelRequested ||
          run.processKilled ||
          this.stopAllTeamsGeneration !== stopAllGenerationAtStart
        ) {
          throw new Error('Team launch cancelled by app shutdown');
        }
        if (request.skipPermissions === false) {
          emitProvisioningCheckpoint(run, 'Seeding lead bootstrap permission rules');
          await this.seedLeadBootstrapPermissionRules(request.teamName, request.cwd);
        }
        emitProvisioningCheckpoint(
          run,
          'Spawning Claude CLI process for team launch',
          `args=${finalLaunchArgs.length} cwd=${request.cwd}`
        );
        child = spawnCli(claudePath, finalLaunchArgs, {
          cwd: request.cwd,
          env: { ...shellEnv },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        if (run.mcpConfigPath) {
          await this.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath).catch(() => {});
          run.mcpConfigPath = null;
        }
        await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
        run.bootstrapSpecPath = null;
        await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(
          () => {}
        );
        run.bootstrapUserPromptPath = null;
        await this.removeRunMemberMcpConfigFiles(run).catch(() => {});
        if (provisioningEnv.anthropicApiKeyHelper) {
          await cleanupAnthropicTeamApiKeyHelperMaterial({
            directory: provisioningEnv.anthropicApiKeyHelper.directory,
          }).catch(() => undefined);
        }
        this.runs.delete(runId);
        this.provisioningRunByTeam.delete(request.teamName);
        await this.restorePrelaunchConfig(request.teamName);
        throw error;
      }

      updateProgress(run, 'spawning', 'Starting Claude CLI process for team launch', {
        pid: child.pid ?? undefined,
        warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
      });
      run.onProgress(run.progress);
      run.child = child;
      run.processClosed = false;
      run.spawnContext = {
        claudePath,
        args: finalLaunchArgs,
        cwd: request.cwd,
        env: { ...shellEnv },
        prompt,
      };

      this.attachStdoutHandler(run);
      this.attachStderrHandler(run);

      // Reset AFTER spawn — not at run init — because async operations between init
      // and spawn can take seconds, causing false stall warnings.
      run.lastDataReceivedAt = Date.now();
      run.lastStdoutReceivedAt = Date.now();
      this.startStallWatchdog(run);

      // For launch, skip the filesystem monitor — files (config, inboxes, tasks)
      // already exist from the previous run and would trigger immediate false
      // completion on the first poll. Rely on stream-json result.success instead.
      updateProgress(run, 'configuring', 'CLI running - deterministic launch in progress');
      run.onProgress(run.progress);

      run.timeoutHandle = setTimeout(() => {
        if (!run.processKilled && !run.provisioningComplete) {
          run.processKilled = true;
          run.finalizingByTimeout = true;
          void (async () => {
            const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
            killTeamProcess(run.child);
            if (readyOnTimeout) {
              return;
            }

            const progress = updateProgress(run, 'failed', 'Timed out waiting for CLI (launch)', {
              error: 'Timed out waiting for CLI during team launch.',
              cliLogsTail: extractCliLogsFromRun(run),
            });
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, getProvisioningRunTimeoutMs(run));

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start Claude CLI (launch)', {
          error: error.message,
          cliLogsTail: extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        this.cleanupRun(run);
      });

      child.once('close', (code) => {
        void this.handleProcessExit(run, code);
      });

      return { runId };
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
    return [
      'validating',
      'spawning',
      'configuring',
      'assembling',
      'finalizing',
      'verifying',
    ].includes(progress.state);
  }

  private async cancelRuntimeAdapterProvisioning(
    runId: string,
    runtimeProgress: TeamProvisioningProgress
  ): Promise<void> {
    if (!this.isCancellableRuntimeAdapterProgress(runtimeProgress)) {
      throw new Error('Provisioning cannot be cancelled in current state');
    }

    const teamName = runtimeProgress.teamName;
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    this.cancelledRuntimeAdapterRunIds.add(runId);
    this.clearOpenCodeRuntimeToolApprovals(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    this.runtimeAdapterRunByTeam.delete(teamName);
    this.runTracking.deleteAliveRunId(teamName);
    if (this.provisioningRunByTeam.get(teamName) === runId) {
      this.provisioningRunByTeam.delete(teamName);
    }
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.runtimeAdapterProgressState.setRuntimeAdapterProgress({
      ...runtimeProgress,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
      updatedAt: nowIso(),
    });
    this.teamChangeEmitter?.({
      type: 'process',
      teamName,
      runId,
      detail: 'cancelled',
    });

    const previousLaunchState = await this.launchStateStore.read(teamName);
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (adapter) {
      try {
        await adapter.stop({
          runId,
          laneId: 'primary',
          teamName,
          cwd: runtimeRun?.cwd ?? this.readPersistedTeamProjectPath(teamName) ?? undefined,
          providerId: 'opencode',
          reason: 'user_requested',
          previousLaunchState,
          force: true,
        });
      } catch (error) {
        logger.warn(
          `[${teamName}] Failed to stop OpenCode runtime adapter launch during cancel: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    await clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
    }).catch(() => undefined);
  }

  private async clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(
    teamName: string,
    runId: string
  ): Promise<void> {
    const currentProvisioningRunId = this.provisioningRunByTeam.get(teamName);
    const currentAliveRunId = this.aliveRunByTeam.get(teamName);
    const currentRuntimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    const ownsPrimaryLane =
      currentProvisioningRunId === runId ||
      currentAliveRunId === runId ||
      currentRuntimeRun?.runId === runId ||
      (!currentProvisioningRunId && !currentAliveRunId && !currentRuntimeRun);
    if (!ownsPrimaryLane) {
      return;
    }

    await clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: getTeamsBasePath(),
      teamName,
      laneId: 'primary',
    }).catch(() => undefined);
    if (this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      this.runtimeAdapterRunByTeam.delete(teamName);
    }
    if (this.aliveRunByTeam.get(teamName) === runId) {
      this.runTracking.deleteAliveRunId(teamName);
    }
    if (this.provisioningRunByTeam.get(teamName) === runId) {
      this.provisioningRunByTeam.delete(teamName);
    }
    this.invalidateRuntimeSnapshotCaches(teamName);
  }

  private recordCancelledOpenCodeRuntimeAdapterLaunch(
    teamName: string,
    sourceWarning: string | undefined,
    onProgress: (progress: TeamProvisioningProgress) => void
  ): TeamLaunchResponse {
    const runId = randomUUID();
    const timestamp = nowIso();
    this.provisioningRunByTeam.delete(teamName);
    this.runtimeAdapterRunByTeam.delete(teamName);
    this.runTracking.deleteAliveRunId(teamName);
    this.invalidateRuntimeSnapshotCaches(teamName);
    const progress: TeamProvisioningProgress = {
      runId,
      teamName,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
      startedAt: timestamp,
      updatedAt: timestamp,
      warnings: sourceWarning ? [sourceWarning] : undefined,
    };
    this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress, onProgress);
    this.teamChangeEmitter?.({
      type: 'process',
      teamName,
      runId,
      detail: 'cancelled',
    });
    return { runId };
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
    if (!this.isCurrentTrackedRun(run)) {
      throw new Error(`Team "${run.teamName}" run "${run.runId}" is no longer current`);
    }
    if (run.processKilled || run.cancelRequested || !run.child?.stdin?.writable) {
      throw new Error(`Team "${run.teamName}" process stdin is not writable`);
    }

    const attachmentPayloads = toLeadAttachmentPayloads(attachments);
    const contentBlocks =
      normalizeOptionalTeamProviderId(run.request.providerId) === 'codex' &&
      attachmentPayloads.length > 0
        ? await this.buildCodexLeadAttachmentContentBlocks(run, message, attachmentPayloads)
        : (buildClaudeAttachmentDeliveryParts({
            text: message,
            attachments: attachmentPayloads,
          }).blocks as Record<string, unknown>[]);

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: contentBlocks,
      },
    });
    const stdin = run.child.stdin;
    await new Promise<void>((resolve, reject) => {
      stdin.write(payload + '\n', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    this.setLeadActivity(run, 'active');
  }

  private async buildCodexLeadAttachmentContentBlocks(
    run: ProvisioningRun,
    message: string,
    attachments: AttachmentPayload[]
  ): Promise<Record<string, unknown>[]> {
    const prepared = await buildCodexNativeAttachmentDeliveryParts({
      teamName: run.teamName,
      messageId: `lead_${run.runId}_${Date.now()}`,
      text: message,
      attachments,
    });
    return [
      { type: 'text', text: prepared.promptText },
      ...prepared.imageParts.map((part) => codexImagePartToContentBlock(part)),
    ];
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
    const existing = this.memberInboxRelayInFlight.get(relayKey);
    if (existing) {
      try {
        return await waitForInboxRelayInFlight({
          promise: existing,
          relayName: 'member_inbox_relay',
          relayKey,
        });
      } catch (error) {
        if (!isInboxRelayInFlightTimeoutError(error)) {
          throw error;
        }
        logger.warn(`[${teamName}] member_inbox_relay_timed_out: ${getErrorMessage(error)}`);
        return 0;
      } finally {
        if (this.memberInboxRelayInFlight.get(relayKey) === existing) {
          this.memberInboxRelayInFlight.delete(relayKey);
        }
      }
    }

    const work = (async (): Promise<number> => {
      const runId = this.runTracking.getAliveRunId(teamName);
      if (!runId) return 0;
      const run = this.runs.get(runId);
      if (!run?.child || run.processKilled || run.cancelRequested) return 0;
      if (!run.provisioningComplete) return 0;
      const isStaleRelayRun = (): boolean =>
        !this.isCurrentTrackedRun(run) || !run.child || run.processKilled || run.cancelRequested;

      const relayedIds = this.relayedMemberInboxMessageIds.get(relayKey) ?? new Set<string>();

      let memberInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        memberInboxMessages = await this.inboxReader.getMessagesFor(teamName, memberName);
      } catch {
        return 0;
      }
      if (isStaleRelayRun()) return 0;

      const unread = memberInboxMessages
        .filter((m): m is InboxMessage & { messageId: string } => {
          if (m.read) return false;
          if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
          if (!hasStableInboxMessageId(m)) return false;
          return !relayedIds.has(m.messageId);
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      if (unread.length === 0) return 0;

      const { passiveIdleUnread, actionableUnread, readOnlyIgnoredUnread } =
        splitMemberInboxRelayUnread(unread);
      if (isStaleRelayRun()) return 0;

      if (readOnlyIgnoredUnread.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, memberName, readOnlyIgnoredUnread);
          if (passiveIdleUnread.length > 0) {
            logger.debug(
              `[${teamName}] member relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay for ${memberName}`
            );
          }
        } catch (error) {
          logger.debug(
            `[${teamName}] member relay failed to mark ${readOnlyIgnoredUnread.length} ignored inbox message(s) read for ${memberName}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      if (actionableUnread.length === 0) return 0;

      const batch = selectMemberInboxRelayBatch(actionableUnread, DEFAULT_INBOX_RELAY_BATCH_SIZE);

      armSilentTeammateForward(run, memberName, 'member_inbox_relay', nowIso());
      const rememberedRelayIds = rememberPendingInboxRelayCandidates(run, memberName, batch);

      const message = buildMemberInboxRelayPrompt({ memberName, batch });

      try {
        await this.sendMessageToRun(run, message);
      } catch {
        forgetPendingInboxRelayCandidates(run, memberName, rememberedRelayIds);
        return 0;
      }

      const readCommitBatch: (InboxMessage & { messageId: string })[] = [];
      for (const m of batch) {
        if (m.messageKind !== 'member_work_sync_nudge') {
          readCommitBatch.push(m);
          relayedIds.add(m.messageId);
          continue;
        }
        if (await this.hasAcceptedMemberWorkSyncReport({ teamName, memberName })) {
          readCommitBatch.push(m);
          relayedIds.add(m.messageId);
        }
      }
      this.relayedMemberInboxMessageIds.set(relayKey, this.trimRelayedSet(relayedIds));

      if (readCommitBatch.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, memberName, readCommitBatch);
        } catch {
          // Best-effort: relay succeeded; marking read failed.
        }
      }

      return batch.length;
    })();

    this.memberInboxRelayInFlight.set(relayKey, work);
    try {
      return await waitForInboxRelayInFlight({
        promise: work,
        relayName: 'member_inbox_relay',
        relayKey,
      });
    } catch (error) {
      if (!isInboxRelayInFlightTimeoutError(error)) {
        throw error;
      }
      logger.warn(`[${teamName}] member_inbox_relay_timed_out: ${getErrorMessage(error)}`);
      return 0;
    } finally {
      if (this.memberInboxRelayInFlight.get(relayKey) === work) {
        this.memberInboxRelayInFlight.delete(relayKey);
      }
    }
  }

  async relayInboxFileToLiveRecipient(
    teamName: string,
    inboxName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<LiveInboxRelayResult> {
    if (isCrossTeamPseudoRecipientName(inboxName) || isCrossTeamToolRecipientName(inboxName)) {
      return { kind: 'ignored', relayed: 0 };
    }

    const [config, metaMembers] = await Promise.all([
      this.readConfigSnapshot(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    const leadName = config?.members?.find((member) => isLeadMember(member))?.name?.trim() || null;
    const isOpenCodeRecipient = this.isOpenCodeRuntimeRecipientFromSources(
      inboxName,
      config,
      metaMembers
    );
    if (inboxName.trim().toLowerCase() === leadName?.toLowerCase()) {
      if (isOpenCodeRecipient) {
        const relayOptions: OpenCodeMemberInboxRelayOptions = {
          source: options.source ?? 'watcher',
          ...(options.onlyMessageId ? { onlyMessageId: options.onlyMessageId } : {}),
          ...(options.deliveryMetadata ? { deliveryMetadata: options.deliveryMetadata } : {}),
        };
        const relay = await this.relayOpenCodeMemberInboxMessages(
          teamName,
          inboxName,
          relayOptions
        );
        return {
          kind: 'opencode_member',
          relayed: relay.relayed,
          diagnostics: relay.diagnostics,
          lastDelivery: relay.lastDelivery,
        };
      }
      return {
        kind: 'native_lead',
        relayed: this.isTeamAlive(teamName) ? await this.relayLeadInboxMessages(teamName) : 0,
      };
    }

    if (isOpenCodeRecipient) {
      const relayOptions: OpenCodeMemberInboxRelayOptions = {
        source: options.source ?? 'watcher',
        ...(options.onlyMessageId ? { onlyMessageId: options.onlyMessageId } : {}),
        ...(options.deliveryMetadata ? { deliveryMetadata: options.deliveryMetadata } : {}),
      };
      const relay = await this.relayOpenCodeMemberInboxMessages(teamName, inboxName, relayOptions);
      return {
        kind: 'opencode_member',
        relayed: relay.relayed,
        diagnostics: relay.diagnostics,
        lastDelivery: relay.lastDelivery,
      };
    }

    return { kind: 'native_member_noop', relayed: 0 };
  }

  private async resolveOpenCodeInboxAttachmentPayloads(input: {
    teamName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<
    | { ok: true; attachments?: AttachmentPayload[] }
    | { ok: false; reason: string; diagnostics: string[] }
  > {
    return resolveOpenCodeInboxAttachmentPayloadsHelper(input, {
      attachmentStore: this.attachmentStore,
    });
  }

  async relayOpenCodeMemberInboxMessages(
    teamName: string,
    memberName: string,
    options: OpenCodeMemberInboxRelayOptions = {}
  ): Promise<OpenCodeMemberInboxRelayResult> {
    const relayKey = this.getOpenCodeMemberRelayKey(teamName, memberName);
    const existing = this.openCodeMemberInboxRelayInFlight.get(relayKey);
    if (existing) {
      const onlyMessageId = options.onlyMessageId?.trim();
      if (!onlyMessageId) {
        try {
          return await waitForInboxRelayInFlight({
            promise: existing,
            relayName: 'opencode_member_inbox_relay',
            relayKey,
          });
        } catch (error) {
          if (!isInboxRelayInFlightTimeoutError(error)) {
            throw error;
          }
          const diagnostic = `opencode_member_inbox_relay_timed_out: ${getErrorMessage(error)}`;
          logger.warn(`[${teamName}] ${diagnostic}`);
          return buildOpenCodeMemberInboxRelayTimeoutResult({ diagnostic, attempted: 0 });
        } finally {
          if (this.openCodeMemberInboxRelayInFlight.get(relayKey) === existing) {
            this.openCodeMemberInboxRelayInFlight.delete(relayKey);
          }
        }
      }
      const inboxMessages = await this.inboxReader
        .getMessagesFor(teamName, memberName)
        .catch(() => []);
      const targetMessage = inboxMessages.find((message) => message.messageId === onlyMessageId);
      if (targetMessage?.read) {
        if (targetMessage.messageKind === 'member_work_sync_nudge') {
          this.scheduleOpenCodeMemberInboxDeliveryWake({
            teamName,
            memberName,
            messageId: onlyMessageId,
            delayMs: 500,
          });
          return buildOpenCodeMemberWorkSyncReadWaitingResult(onlyMessageId);
        }
        return buildOpenCodeMemberInboxAlreadyReadResult();
      }
      if (!targetMessage) {
        return buildOpenCodeMemberInboxMessageMissingResult({
          messageId: onlyMessageId,
          reason: 'opencode_inbox_message_missing_after_inflight_relay',
        });
      }

      this.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName,
        memberName,
        messageId: onlyMessageId,
        delayMs: 500,
      });
      return buildOpenCodeMemberInboxQueuedBehindResult({ relayKey, messageId: onlyMessageId });
    }

    const work = (async (): Promise<OpenCodeMemberInboxRelayResult> => {
      const result = createOpenCodeMemberInboxRelayResult();
      if (!(await this.isOpenCodeRuntimeRecipient(teamName, memberName))) {
        result.lastDelivery = { delivered: false, reason: 'recipient_is_not_opencode' };
        return result;
      }
      const memberIdentity =
        await this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          teamName,
          memberName
        );
      if (!memberIdentity.ok) {
        result.lastDelivery = { delivered: false, reason: memberIdentity.reason };
        return result;
      }
      const promptLedger = this.createOpenCodePromptDeliveryLedger(teamName, memberIdentity.laneId);

      let inboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        inboxMessages = await this.inboxReader.getMessagesFor(teamName, memberName);
      } catch (error) {
        const diagnostic = `opencode_inbox_read_failed: ${getErrorMessage(error)}`;
        return buildOpenCodeInboxReadFailedResult(diagnostic);
      }

      const onlyMessageId = options.onlyMessageId?.trim();
      if (onlyMessageId) {
        const targetMessage = inboxMessages.find((message) => message.messageId === onlyMessageId);
        if (targetMessage?.read && targetMessage.messageKind !== 'member_work_sync_nudge') {
          return buildOpenCodeMemberInboxAlreadyReadResult();
        }
        if (!targetMessage) {
          return buildOpenCodeMemberInboxMessageMissingResult({
            messageId: onlyMessageId,
            reason: 'opencode_inbox_message_missing',
          });
        }
      }
      const unread = selectOpenCodeMemberInboxRelayUnreadMessages({
        inboxMessages,
        onlyMessageId,
        maxRelay: DEFAULT_INBOX_RELAY_BATCH_SIZE,
      });

      let taskRefInferenceTasks: Promise<readonly TeamTask[]> | null = null;
      const readTaskRefInferenceTasks = (): Promise<readonly TeamTask[]> => {
        taskRefInferenceTasks ??= new TeamTaskReader().getTasks(teamName).catch(() => []);
        return taskRefInferenceTasks;
      };

      for (const message of unread) {
        let existingRecord = await promptLedger
          .getByInboxMessage({
            teamName,
            memberName: memberIdentity.canonicalMemberName,
            laneId: memberIdentity.laneId,
            inboxMessageId: message.messageId,
          })
          .catch(() => null);
        if (existingRecord?.status === 'failed_terminal') {
          const requeuedRecord = await this.requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(
            {
              ledger: promptLedger,
              ledgerRecord: existingRecord,
            }
          );
          if (requeuedRecord.status !== 'failed_terminal') {
            existingRecord = requeuedRecord;
          }
        }
        if (existingRecord?.status === 'failed_terminal') {
          const requeuedRecord = await this.requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded({
            ledger: promptLedger,
            ledgerRecord: existingRecord,
          });
          if (requeuedRecord.status !== 'failed_terminal') {
            existingRecord = requeuedRecord;
          }
        }
        if (existingRecord?.status === 'failed_terminal') {
          let recoveredRecord: OpenCodePromptDeliveryLedgerRecord | null = null;
          let recoveredVisibleReply: OpenCodeVisibleReplyProof | null = null;
          if (typeof promptLedger.applyDestinationProof === 'function') {
            try {
              const proof = await this.openCodeVisibleReplyProofService.applyDestinationProof({
                ledger: promptLedger,
                ledgerRecord: existingRecord,
                teamName,
                replyRecipient: existingRecord.replyRecipient,
                memberName: memberIdentity.canonicalMemberName,
              });
              recoveredRecord = proof.ledgerRecord;
              recoveredVisibleReply = proof.visibleReply;
            } catch {
              recoveredRecord = null;
              recoveredVisibleReply = null;
            }
          }
          const recoveredReadAllowed = recoveredRecord
            ? await this.isOpenCodeDeliveryResponseReadCommitAllowed({
                teamName,
                memberName: memberIdentity.canonicalMemberName,
                responseState: recoveredRecord.responseState,
                actionMode: recoveredRecord.actionMode ?? undefined,
                taskRefs: recoveredRecord.taskRefs,
                visibleReply: recoveredVisibleReply,
                ledgerRecord: recoveredRecord,
              })
            : false;
          if (recoveredRecord && recoveredReadAllowed) {
            try {
              await this.markInboxMessagesRead(teamName, memberName, [message]);
              const committed = await promptLedger.markInboxReadCommitted({
                id: recoveredRecord.id,
                committedAt: nowIso(),
              });
              this.logOpenCodePromptDeliveryEvent(
                'opencode_prompt_delivery_inbox_committed_read',
                committed,
                { recoveredTerminal: true }
              );
              result.delivered += 1;
              result.relayed += 1;
              result.lastDelivery = {
                delivered: true,
                accepted: true,
                responsePending: false,
                responseState: committed.responseState,
                ledgerStatus: committed.status,
                ledgerRecordId: committed.id,
                laneId: memberIdentity.laneId,
                visibleReplyMessageId: committed.visibleReplyMessageId ?? undefined,
                visibleReplyCorrelation: committed.visibleReplyCorrelation ?? undefined,
                diagnostics: committed.diagnostics,
              };
              break;
            } catch (error) {
              const diagnostic = `opencode_inbox_mark_read_failed_after_terminal_recovery: ${getErrorMessage(
                error
              )}`;
              result.failed += 1;
              result.lastDelivery = {
                delivered: false,
                reason: 'opencode_inbox_mark_read_failed_after_terminal_recovery',
                diagnostics: [diagnostic],
              };
              result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
              break;
            }
          }
          const diagnostic =
            existingRecord.lastReason ??
            `opencode_prompt_delivery_failed_terminal: ${message.messageId}`;
          result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
          if (onlyMessageId) {
            result.failed += 1;
            result.lastDelivery = {
              delivered: false,
              accepted: false,
              ledgerStatus: existingRecord.status,
              ledgerRecordId: existingRecord.id,
              laneId: memberIdentity.laneId,
              reason: existingRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
              diagnostics: existingRecord.diagnostics.length
                ? existingRecord.diagnostics
                : [diagnostic],
            };
          }
          continue;
        }
        const existingTaskRefs = existingRecord?.taskRefs?.length
          ? existingRecord.taskRefs
          : undefined;
        const metadataTaskRefs = options.deliveryMetadata?.taskRefs?.length
          ? options.deliveryMetadata.taskRefs
          : undefined;
        const messageTaskRefs = message.taskRefs?.length ? message.taskRefs : undefined;
        const inferredTaskRefs =
          existingTaskRefs || metadataTaskRefs || messageTaskRefs
            ? []
            : await inferOpenCodeInboxMessageTaskRefs({
                teamName,
                message,
                readTasks: readTaskRefInferenceTasks,
              });
        const deliveryDecision = resolveOpenCodeMemberInboxDeliveryDecision({
          memberName,
          message,
          existingRecord,
          deliveryMetadata: options.deliveryMetadata,
          inferredTaskRefs,
          source: options.source,
        });
        result.attempted += 1;
        const attachmentPayloads = await this.resolveOpenCodeInboxAttachmentPayloads({
          teamName,
          message,
        });
        if (!attachmentPayloads.ok) {
          const attachmentFailure = await handleOpenCodeInboxAttachmentFailure({
            teamName,
            canonicalMemberName: memberIdentity.canonicalMemberName,
            laneId: memberIdentity.laneId,
            message,
            existingRecord,
            decision: deliveryDecision,
            attachmentPayloads,
            ports: {
              ledger: promptLedger,
              resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
                this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
                  teamName,
                  laneId
                ),
              markFailedTerminal: (input) => this.markOpenCodePromptLedgerFailedTerminal(input),
              logPromptDeliveryEvent: (event, record, extra) =>
                this.logOpenCodePromptDeliveryEvent(event, record, extra),
              nowIso,
              getErrorMessage,
            },
          });
          result.failed += attachmentFailure.failed;
          result.diagnostics = [
            ...(result.diagnostics ?? []),
            ...(attachmentFailure.diagnostics ?? []),
          ];
          result.lastDelivery = attachmentFailure.lastDelivery;
          break;
        }
        const delivery = await this.deliverOpenCodeMemberMessage(teamName, {
          memberName,
          text: message.text,
          messageId: message.messageId,
          replyRecipient: deliveryDecision.replyRecipient,
          actionMode: deliveryDecision.actionMode ?? undefined,
          messageKind: message.messageKind,
          workSyncIntent: message.workSyncIntent,
          workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
          taskRefs: deliveryDecision.taskRefs,
          attachments: attachmentPayloads.attachments,
          source: deliveryDecision.source,
          inboxTimestamp: message.timestamp,
        });
        result.lastDelivery = delivery;
        if (!delivery.delivered) {
          const failureProjection = projectOpenCodeInboxDeliveryFailure({
            delivery,
            suppressRuntimeInactiveWarning:
              this.cleanedStoppedTeamOpenCodeRuntimeLanes.has(teamName),
          });
          result.failed += failureProjection.result.failed;
          result.diagnostics = [
            ...(result.diagnostics ?? []),
            ...(failureProjection.result.diagnostics ?? []),
          ];
          result.lastDelivery = failureProjection.result.lastDelivery;
          if (failureProjection.shouldLogWarning) {
            logger.warn(
              `[${teamName}] OpenCode inbox relay failed for ${memberName}/${message.messageId}: ${
                delivery.reason ?? 'unknown error'
              }`
            );
          }
          break;
        }
        if (delivery.responsePending) {
          result.diagnostics = [
            ...(result.diagnostics ?? []),
            ...(delivery.diagnostics ?? [delivery.reason ?? 'opencode_delivery_response_pending']),
          ];
          break;
        }
        const readCommit = await commitOpenCodeInboxRelayReadAfterDelivery({
          teamName,
          memberName,
          message,
          delivery,
          ports: {
            markInboxMessagesRead: (teamName, memberName, messages) =>
              this.markInboxMessagesRead(teamName, memberName, messages),
            createOpenCodePromptDeliveryLedger: (teamName, laneId) =>
              this.createOpenCodePromptDeliveryLedger(teamName, laneId),
            logPromptDeliveryEvent: (event, record, extra) =>
              this.logOpenCodePromptDeliveryEvent(event, record, extra),
            nowIso,
            getErrorMessage,
          },
        });
        if (!readCommit.ok) {
          result.failed += readCommit.result.failed;
          result.lastDelivery = readCommit.result.lastDelivery;
          result.diagnostics = [
            ...(result.diagnostics ?? []),
            ...(readCommit.result.diagnostics ?? []),
          ];
          logger.warn(`[${teamName}] ${readCommit.diagnostic}`);
          break;
        }
        result.delivered += 1;
        result.relayed += 1;
        break;
      }

      return dedupeOpenCodeMemberInboxRelayDiagnostics(result);
    })();

    this.openCodeMemberInboxRelayInFlight.set(relayKey, work);
    try {
      return await waitForInboxRelayInFlight({
        promise: work,
        relayName: 'opencode_member_inbox_relay',
        relayKey,
      });
    } catch (error) {
      if (!isInboxRelayInFlightTimeoutError(error)) {
        throw error;
      }
      const diagnostic = `opencode_member_inbox_relay_timed_out: ${getErrorMessage(error)}`;
      logger.warn(`[${teamName}] ${diagnostic}`);
      return buildOpenCodeMemberInboxRelayTimeoutResult({
        diagnostic,
        attempted: options.onlyMessageId ? 1 : 0,
      });
    } finally {
      if (this.openCodeMemberInboxRelayInFlight.get(relayKey) === work) {
        this.openCodeMemberInboxRelayInFlight.delete(relayKey);
      }
    }
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
      resolveOpenCodeMemberDeliveryIdentity: (teamName, memberName) =>
        this.openCodeRuntimeRecoveryIdentity.resolveOpenCodeMemberDeliveryIdentity(
          teamName,
          memberName
        ),
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

  private async hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    return hasAcceptedMemberWorkSyncReportHelper(input, this.memberWorkSyncAcceptedReportChecker, {
      logger,
      getErrorMessage,
    });
  }

  private async hasAcceptedLeadWorkSyncReport(input: {
    teamName: string;
    leadName: string;
  }): Promise<boolean> {
    return hasAcceptedLeadWorkSyncReportHelper(input, this.memberWorkSyncAcceptedReportChecker, {
      logger,
      getErrorMessage,
    });
  }

  private async scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean> {
    return scheduleLeadProofMissingWorkSyncRecoveryHelper(
      input,
      this.memberWorkSyncProofMissingRecoveryScheduler,
      { logger, getErrorMessage }
    );
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    const existing = this.leadInboxRelayInFlight.get(teamName);
    if (existing) {
      try {
        return await waitForInboxRelayInFlight({
          promise: existing,
          relayName: 'lead_inbox_relay',
          relayKey: teamName,
        });
      } catch (error) {
        if (!isInboxRelayInFlightTimeoutError(error)) {
          throw error;
        }
        logger.warn(`[${teamName}] lead_inbox_relay_timed_out: ${getErrorMessage(error)}`);
        return 0;
      } finally {
        if (this.leadInboxRelayInFlight.get(teamName) === existing) {
          this.leadInboxRelayInFlight.delete(teamName);
        }
      }
    }

    const work = (async (): Promise<number> => {
      const runId =
        this.runTracking.getAliveRunId(teamName) ?? this.runTracking.getProvisioningRunId(teamName);
      if (!runId) return 0;
      const run = this.runs.get(runId);
      if (!run?.child || run.processKilled || run.cancelRequested) return 0;
      const isStaleRelayRun = (): boolean =>
        !this.isCurrentTrackedRun(run) || !run.child || run.processKilled || run.cancelRequested;

      // Permission request scan runs even during provisioning — teammates may need
      // tool approval before the lead's first turn completes. CLI marks inbox messages
      // as read after native delivery, so we must scan ALL messages (including read).
      let config: Awaited<ReturnType<TeamConfigReader['getConfig']>> | null = null;
      try {
        config = await this.readConfigForObservation(teamName);
      } catch {
        // config not ready yet during early provisioning — skip scan
      }
      if (isStaleRelayRun()) return 0;
      if (config) {
        const leadName = config.members?.find((m) => isLeadMember(m))?.name?.trim() || 'team-lead';
        const permissionScanResult = await scanLeadInboxPermissionRequests(
          { teamName, leadName, run, isStaleRelayRun },
          {
            readLeadInboxMessages: (teamName, leadName) =>
              this.inboxReader.getMessagesFor(teamName, leadName),
            handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
              this.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
            markInboxMessagesRead: (teamName, leadName, messages) =>
              this.markInboxMessagesRead(teamName, leadName, messages),
          }
        );
        if (permissionScanResult === 'stale') return 0;
      }

      if (!run.provisioningComplete) return 0;

      const relayedIds = this.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();

      // Re-read config if needed (already fetched above but guard provisioningComplete path)
      if (!config) {
        try {
          config = await this.readConfigForObservation(teamName);
        } catch {
          return 0;
        }
      }
      if (isStaleRelayRun()) return 0;
      if (!config) return 0;

      const leadName = config.members?.find((m) => isLeadMember(m))?.name?.trim() || 'team-lead';
      let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
      try {
        leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
      } catch {
        return 0;
      }
      if (isStaleRelayRun()) return 0;

      await this.refreshMemberSpawnStatusesFromLeadInbox(run);
      if (isStaleRelayRun()) return 0;

      const unread = leadInboxMessages
        .filter((m): m is InboxMessage & { messageId: string } => {
          if (m.read) return false;
          if (typeof m.text !== 'string' || m.text.trim().length === 0) return false;
          if (!hasStableInboxMessageId(m)) return false;
          return !relayedIds.has(m.messageId);
        })
        .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

      if (unread.length === 0) return 0;

      const { silentIdleIds, passiveIdleIds, coarseNonIdleNoiseIds } =
        getLeadInboxRelayNoiseIds(unread);

      const crossTeamSuppression = createCrossTeamLeadSuppressionState({
        leadInboxMessages,
        pendingReplies: this.pendingCrossTeamFirstReplies,
        teamName,
        now: Date.now(),
        ttlMs: TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
      });

      const wasRecentlyDeliveredCrossTeam = (message: InboxMessage): boolean => {
        return wasRecentlyDeliveredCrossTeamLeadMessage({
          message,
          recentMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
          teamName,
          now: Date.now(),
          ttlMs: TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS,
        });
      };
      const isCrossTeamReplyToOwnOutbound = (message: InboxMessage): boolean => {
        return markCrossTeamReplyToOwnOutbound(message, crossTeamSuppression);
      };

      // Category 1: permanently ignored → mark as read.
      // Includes noise (idle/shutdown), cross-team sender copies, cross-team reply dedup.
      const { permanentlyIgnored, passiveIdleUnread, readOnlyIgnoredIds, remainingUnread } =
        planLeadInboxRelayReadOnlyMessages({
          unread,
          silentIdleIds,
          passiveIdleIds,
          coarseNonIdleNoiseIds,
          isPermanentlyIgnored: (message) =>
            message.source === CROSS_TEAM_SENT_SOURCE ||
            isCrossTeamReplyToOwnOutbound(message) ||
            wasRecentlyDeliveredCrossTeam(message),
        });
      if (permanentlyIgnored.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, permanentlyIgnored);
        } catch {
          // best-effort
        }
        for (const key of crossTeamSuppression.matchedTransientReplyKeys) {
          const [otherTeam, conversationId] = key.split('\0');
          if (otherTeam && conversationId) {
            this.clearPendingCrossTeamReplyExpectation(teamName, otherTeam, conversationId);
          }
        }
      }

      if (passiveIdleUnread.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, passiveIdleUnread);
          logger.debug(
            `[${teamName}] lead relay marked ${passiveIdleUnread.length} passive idle message(s) read without relay`
          );
        } catch (error) {
          logger.debug(
            `[${teamName}] lead relay failed to mark ${passiveIdleUnread.length} passive idle message(s) read: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      if (isStaleRelayRun()) return 0;

      // Category 2: same-team native delivery confirmation (one-to-one pairing).
      const { nativeMatchedMessageIds, persisted: sameTeamPersisted } =
        await this.confirmSameTeamNativeMatches(teamName, leadName, remainingUnread);

      // Category 3: deferred by age — source-less messages within grace window of CURRENT run.
      // NOT marked read (crash safety: if native delivery fails, retry will relay).
      const runStartedAtMs = Date.parse(run.startedAt);
      const deferredByAge = remainingUnread.filter(
        (message) =>
          !nativeMatchedMessageIds.has(message.messageId) &&
          shouldDeferSameTeamMessageHelper({
            message,
            leadName,
            runStartedAtMs,
            nowMs: Date.now(),
            runStartSkewMs: TeamProvisioningService.SAME_TEAM_RUN_START_SKEW_MS,
            nativeDeliveryGraceMs: TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS,
          })
      );
      const deferredIds = new Set(deferredByAge.map((m) => m.messageId));

      // Category 4: teammate permission requests — filter from actionable so they're
      // NOT relayed to the lead. The actual interception + ToolApprovalRequest emission
      // is handled by the early scan above (which checks processedPermissionRequestIds).
      const permissionRequestIds = new Set(
        remainingUnread
          .filter((m) => !deferredIds.has(m.messageId) && parsePermissionRequest(m.text) !== null)
          .map((m) => m.messageId)
      );

      // Actionable: everything not in any category.
      const actionableUnread = selectActionableLeadRelayUnread({
        remainingUnread,
        nativeMatchedMessageIds,
        deferredIds,
        permissionRequestIds,
      });

      // Layer 3: schedule retry timers.
      if (nativeMatchedMessageIds.size > 0 && !sameTeamPersisted) {
        this.scheduleSameTeamPersistRetry(teamName);
      }
      if (deferredByAge.length > 0) {
        this.scheduleSameTeamDeferredRetry(teamName);
      }

      if (actionableUnread.length === 0) return 0;

      const { batch, replyVisibility, hasPendingFollowUpRelay } = selectLeadInboxRelayBatch({
        actionableUnread,
        unread,
        readOnlyIgnoredIds,
        maxRelay: DEFAULT_INBOX_RELAY_BATCH_SIZE,
      });
      const teammateRoster = (config.members ?? [])
        .filter((member) => {
          const name = member.name?.trim();
          return name && name !== leadName;
        })
        .map((member) => ({
          name: member.name.trim(),
          ...(member.role?.trim() ? { role: member.role.trim() } : {}),
        }));
      const workSyncControlUrl = await this.providerRuntime.resolveControlApiBaseUrl();
      run.activeCrossTeamReplyHints = buildLeadActiveCrossTeamReplyHints(batch);
      const message = buildLeadInboxRelayPrompt({
        teamName,
        leadName,
        batch,
        replyVisibility,
        teammates: teammateRoster,
        workSyncControlUrl,
      });

      const captureTimeoutMs = 15_000;
      const captureIdleMs = 800;
      const capturePromise = new Promise<string>((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          reject(new Error('Timed out waiting for lead reply'));
        }, captureTimeoutMs);
        const capture = {
          leadName,
          startedAt: nowIso(),
          textParts: [] as string[],
          replyVisibility,
          hasVisibleSendMessage: false,
          hasUserVisibleSendMessage: false,
          settled: false,
          idleHandle: null as NodeJS.Timeout | null,
          idleMs: captureIdleMs,
          timeoutHandle,
          resolveOnce: (text: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            resolve(text);
          },
          rejectOnce: (error: string) => {
            if (capture.settled) return;
            capture.settled = true;
            if (capture.idleHandle) {
              clearTimeout(capture.idleHandle);
              capture.idleHandle = null;
            }
            clearTimeout(capture.timeoutHandle);
            reject(new Error(error));
          },
        };
        run.leadRelayCapture = capture;
      });

      try {
        await this.sendMessageToRun(run, message);
      } catch {
        if (run.leadRelayCapture) {
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
        return 0;
      }

      rememberRecentCrossTeamLeadDeliveryMessageIds(
        this.recentCrossTeamLeadDeliveryMessageIds,
        teamName,
        batch
          .filter((message) => message.source === CROSS_TEAM_SOURCE)
          .map((message) => message.messageId),
        Date.now(),
        TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS
      );

      let replyText: string | null = null;
      let capturedVisibleSendMessage = false;
      let capturedUserVisibleSendMessage = false;
      try {
        replyText = (await capturePromise).trim() || null;
      } catch {
        // Best-effort: if we captured some text but never got result.success, keep it.
        const partial = run.leadRelayCapture
          ? this.joinLeadRelayCaptureText(run.leadRelayCapture)
          : null;
        replyText = partial && partial.length > 0 ? partial : null;
      } finally {
        if (run.leadRelayCapture) {
          capturedVisibleSendMessage = run.leadRelayCapture.hasVisibleSendMessage === true;
          capturedUserVisibleSendMessage = run.leadRelayCapture.hasUserVisibleSendMessage === true;
          if (run.leadRelayCapture.idleHandle) {
            clearTimeout(run.leadRelayCapture.idleHandle);
            run.leadRelayCapture.idleHandle = null;
          }
          clearTimeout(run.leadRelayCapture.timeoutHandle);
          run.leadRelayCapture = null;
        }
      }

      const readCommitBatch = await this.getLeadRelayReadCommitBatch({
        teamName,
        leadName,
        batch,
      });
      for (const m of readCommitBatch) {
        relayedIds.add(m.messageId);
      }
      this.relayedLeadInboxMessageIds.set(teamName, this.trimRelayedSet(relayedIds));
      if (readCommitBatch.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, readCommitBatch);
        } catch {
          // Best-effort: relay succeeded; marking read failed.
        }
      }

      const replyProjection = projectLeadRelayReply({
        replyText,
        relayPrompt: message,
        replyVisibility,
        capturedVisibleSendMessage,
        capturedUserVisibleSendMessage,
        leadName,
        runId,
        nowIso: nowIso(),
        nowMs: Date.now(),
      });
      if (replyProjection.kind === 'suppressed') {
        if (replyProjection.reason === 'internal_control') {
          logger.debug(`[${teamName}] Suppressed internal lead relay echo`);
        } else if (replyProjection.reason === 'visible_duplicate') {
          logger.debug(`[${teamName}] Suppressed lead relay text duplicated by visible message`);
        } else if (replyProjection.reason === 'unverified_state') {
          logger.debug(`[${teamName}] Suppressed unverified lead relay state claim`);
        }
      } else if (replyProjection.kind === 'live_activity') {
        this.pushLiveLeadTextMessage(
          run,
          replyProjection.text,
          replyProjection.messageId,
          replyProjection.timestamp
        );
      } else {
        this.pushLiveLeadProcessMessage(teamName, replyProjection.message);
        // Persist to disk so relayed replies survive app restart and trigger FileWatcher
        this.persistSentMessage(teamName, replyProjection.message);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName,
          detail: 'lead-process-reply',
        });
      }
      if (hasPendingFollowUpRelay) {
        this.scheduleLeadInboxFollowUpRelay(teamName);
      }

      return batch.length;
    })();

    this.leadInboxRelayInFlight.set(teamName, work);
    try {
      return await waitForInboxRelayInFlight({
        promise: work,
        relayName: 'lead_inbox_relay',
        relayKey: teamName,
      });
    } catch (error) {
      if (!isInboxRelayInFlightTimeoutError(error)) {
        throw error;
      }
      logger.warn(`[${teamName}] lead_inbox_relay_timed_out: ${getErrorMessage(error)}`);
      return 0;
    } finally {
      if (this.leadInboxRelayInFlight.get(teamName) === work) {
        this.leadInboxRelayInFlight.delete(teamName);
      }
    }
  }

  /**
   * Check if a team has an active provisioning run (started but not yet finished).
   */
  hasProvisioningRun(teamName: string): boolean {
    return this.provisioningRunByTeam.has(teamName);
  }

  /**
   * Check if a team has a live process.
   */
  isTeamAlive(teamName: string): boolean {
    const runId = this.runTracking.getAliveRunId(teamName);
    if (!runId) return false;
    const run = this.runs.get(runId);
    if (!run && this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      return true;
    }
    if (run && this.hasSecondaryRuntimeRuns(teamName)) {
      return !run.processKilled && !run.cancelRequested;
    }
    return run?.child != null && !run.processKilled && !run.cancelRequested;
  }

  /**
   * Get list of teams with active processes.
   */
  getAliveTeams(): string[] {
    return Array.from(this.aliveRunByTeam.keys()).filter((name) => this.isTeamAlive(name));
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
    const runId = this.runTracking.getTrackedRunId(teamName);
    const run = runId ? (this.runs.get(runId) ?? null) : null;

    if (!run) {
      const recovered = await readBootstrapRuntimeState(teamName);
      if (recovered) {
        return recovered;
      }
    }

    return {
      teamName,
      isAlive: this.isTeamAlive(teamName),
      runId: run?.runId ?? runId ?? null,
      progress:
        run?.progress ??
        (runId
          ? (this.runtimeAdapterProgressByRunId.get(runId) ??
            this.retainedProvisioningProgressState
              .getRetainedProvisioningProgressMap()
              .get(runId) ??
            null)
          : null),
    };
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
      this.doNotifyLanguageChange(newLangCode)
    );
    return this.languageChangeInFlight;
  }

  private async doNotifyLanguageChange(newLangCode: string): Promise<void> {
    const aliveTeams = this.getAliveTeams();
    if (aliveTeams.length === 0) return;

    const systemLocale = getSystemLocale();
    const newResolved = resolveLanguageName(newLangCode, systemLocale);

    for (const teamName of aliveTeams) {
      try {
        const config = await this.readConfigForStrictDecision(teamName);
        if (!config) continue;

        const oldCode = config.language || 'system';
        if (oldCode === newLangCode) continue;

        // Compare resolved names to avoid spurious notifications
        // e.g. switching from 'ru' to 'system' when system locale is Russian
        const oldResolved = resolveLanguageName(oldCode, systemLocale);
        if (oldResolved === newResolved) {
          // Effective language unchanged — just update stored code silently
          await this.configReader.updateConfig(teamName, { language: newLangCode });
          continue;
        }

        const message =
          `The user has changed the preferred communication language from "${oldResolved}" to "${newResolved}". ` +
          `Please switch to ${newResolved} for all future responses and broadcast this change to all teammates ` +
          `so they also switch to ${newResolved}.`;

        await this.sendMessageToTeam(teamName, message);
        await this.configReader.updateConfig(teamName, { language: newLangCode });
        logger.info(`[${teamName}] Notified about language change: ${oldCode} → ${newLangCode}`);
      } catch (error) {
        logger.warn(
          `[${teamName}] Failed to notify language change: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
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
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        return null;
      }
      const config = JSON.parse(raw) as {
        members?: { name?: string; agentType?: string }[];
      };
      return new Set(
        (config.members ?? [])
          .map((m) => (typeof m.name === 'string' ? m.name.trim() : ''))
          .filter(Boolean)
      );
    } catch {
      return null;
    }
  }

  private async auditMemberSpawnStatuses(run: ProvisioningRun): Promise<void> {
    if (!run.expectedMembers || run.expectedMembers.length === 0) return;

    // Read config.json to get the actual registered members
    const registeredNames = await this.getRegisteredTeamMemberNames(run.teamName);
    if (!registeredNames) {
      try {
        await fs.promises.access(path.join(getTeamsBasePath(), run.teamName));
      } catch {
        return;
      }
      const now = Date.now();
      if (
        shouldWarnOnUnreadableMemberAuditConfig({
          nowMs: now,
          lastWarnAt: run.lastMemberSpawnAuditConfigReadWarningAt,
          expectedMembers: run.expectedMembers,
          memberSpawnStatuses: run.memberSpawnStatuses,
        })
      ) {
        run.lastMemberSpawnAuditConfigReadWarningAt = now;
        logger.debug(`[${run.teamName}] auditMemberSpawnStatuses: config.json not readable`);
      }
      return;
    }

    const liveAgentNames = await this.getLiveTeamAgentNames(run.teamName);

    // Flag any expected member not found in config.json (excluding the lead)
    for (const expected of run.expectedMembers) {
      const current = run.memberSpawnStatuses.get(expected);
      if (
        current?.launchState === 'failed_to_start' ||
        current?.launchState === 'confirmed_alive' ||
        current?.launchState === 'skipped_for_launch' ||
        current?.skippedForLaunch === true
      ) {
        continue;
      }

      const matchedRuntimeNames = [...registeredNames].filter((name) => {
        if (name === expected) return true;
        const parsed = parseNumericSuffixName(name);
        return parsed !== null && parsed.suffix >= 2 && parsed.base === expected;
      });

      const runtimeAlive =
        liveAgentNames.has(expected) ||
        matchedRuntimeNames.some((runtimeName) => liveAgentNames.has(runtimeName));

      // A teammate may intentionally stay silent after bootstrap. If Claude Code
      // registered the runtime and the OS process is still alive, treat it as
      // process-confirmed running. Keep this distinct from heartbeat-confirmed online.
      if (runtimeAlive) {
        if (this.isOpenCodeSecondaryLaneMemberInRun(run, expected)) {
          const base = current ?? createInitialMemberSpawnStatusEntry();
          const bootstrapStalled =
            base.bootstrapStalled === true ||
            this.isOpenCodeBootstrapStallWindowElapsed(base.firstSpawnAcceptedAt);
          await reconcileOpenCodeRuntimeProcessBootstrapStatusHelper(
            {
              run,
              memberName: expected,
              current: base,
              bootstrapStalled,
              runtimeDiagnostic: base.runtimeDiagnostic,
              runtimeDiagnosticSeverity: base.runtimeDiagnosticSeverity,
              scheduleReevaluation: false,
            },
            this.getOpenCodeBootstrapStallReconciliationPorts()
          );
          continue;
        }
        this.setMemberSpawnStatus(run, expected, 'online', undefined, 'process');
        continue;
      }

      if (matchedRuntimeNames.length > 0) {
        if (current?.agentToolAccepted) {
          if (
            await markOpenCodeSecondaryBootstrapStalledHelper(
              {
                run,
                memberName: expected,
                current,
                isOpenCodeSecondaryLaneMember: this.isOpenCodeSecondaryLaneMemberInRun(
                  run,
                  expected
                ),
                bootstrapStallWindowElapsed: this.isOpenCodeBootstrapStallWindowElapsed(
                  current.firstSpawnAcceptedAt
                ),
              },
              this.getOpenCodeBootstrapStallReconciliationPorts()
            )
          ) {
            continue;
          }
          this.setMemberSpawnStatus(run, expected, 'waiting');
        }
        continue;
      }

      if (run.pendingMemberRestarts?.has(expected) === true) {
        continue;
      }

      const acceptedAtMs =
        current?.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const graceExpired =
        current?.agentToolAccepted === true &&
        Number.isFinite(acceptedAtMs) &&
        Date.now() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;

      if (current?.agentToolAccepted && !graceExpired) {
        this.setMemberSpawnStatus(run, expected, 'waiting');
        continue;
      }

      const now = Date.now();
      const lastWarnAt = run.lastMemberSpawnAuditMissingWarningAt.get(expected) ?? 0;
      if (
        shouldWarnOnMissingRegisteredMember({
          nowMs: now,
          lastWarnAt,
          graceExpired,
        })
      ) {
        run.lastMemberSpawnAuditMissingWarningAt.set(expected, now);
        logger.warn(
          `[${run.teamName}] Member "${expected}" not found in config.json members after provisioning`
        );
      }
      if (graceExpired) {
        this.setMemberSpawnStatus(
          run,
          expected,
          'error',
          'Teammate not registered after provisioning within the launch grace window.'
        );
      }
    }
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

  private markUnconfirmedBootstrapMembersFailed(
    run: ProvisioningRun,
    reason: string,
    options?: { cleanupRequested?: boolean; preserveExistingFailure?: boolean }
  ): void {
    const failedAt = nowIso();
    const baseReason = reason.trim() || 'Deterministic bootstrap failed before teammate check-in.';
    for (const expected of run.expectedMembers) {
      const prev = run.memberSpawnStatuses.get(expected) ?? createInitialMemberSpawnStatusEntry();
      if (prev.bootstrapConfirmed || prev.skippedForLaunch) {
        continue;
      }
      if (this.isMemberLifecycleOperationActive(run.teamName, expected)) {
        continue;
      }
      if (run.pendingMemberRestarts?.has(expected) === true) {
        continue;
      }
      const hasExistingTerminalFailure =
        prev.status === 'error' ||
        prev.launchState === 'failed_to_start' ||
        prev.hardFailure === true ||
        Boolean(prev.hardFailureReason);
      const preservedFailureReason =
        options?.preserveExistingFailure && hasExistingTerminalFailure
          ? (prev.hardFailureReason ?? prev.error)?.trim()
          : undefined;

      const runtimeWasAlive = prev.runtimeAlive === true || prev.livenessSource === 'process';
      const fallbackFailureReason = runtimeWasAlive
        ? `${baseReason} Runtime process was alive after bootstrap failure${
            options?.cleanupRequested ? '; launch-owned cleanup requested.' : '.'
          }`
        : baseReason;
      const hardFailureReason = preservedFailureReason || fallbackFailureReason;
      const next: MemberSpawnStatusEntry = {
        ...prev,
        status: 'error',
        updatedAt: failedAt,
        error: hardFailureReason,
        hardFailure: true,
        hardFailureReason,
        bootstrapConfirmed: false,
        bootstrapStalled: undefined,
        runtimeAlive: options?.cleanupRequested ? false : prev.runtimeAlive,
        livenessSource: options?.cleanupRequested ? undefined : prev.livenessSource,
        runtimeDiagnostic: runtimeWasAlive
          ? options?.cleanupRequested
            ? 'Bootstrap failed before teammate check-in; launch-owned runtime cleanup requested.'
            : 'Bootstrap failed before teammate check-in while runtime process was still alive.'
          : prev.runtimeDiagnostic,
        runtimeDiagnosticSeverity: runtimeWasAlive ? 'warning' : prev.runtimeDiagnosticSeverity,
        launchState: 'failed_to_start',
      };

      this.syncMemberTaskActivityForRuntimeTransition(run, expected, prev, next, failedAt);
      run.memberSpawnStatuses.set(expected, next);
      this.appendMemberBootstrapDiagnostic(run, expected, hardFailureReason);
      if (this.isCurrentTrackedRun(run)) {
        this.emitMemberSpawnChange(run, expected);
      }
    }
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

  private findConfiguredMemberModel(
    configuredMembers: TeamConfig['members'] | undefined,
    memberName: string
  ): string | undefined {
    return findConfiguredMemberModel(configuredMembers, memberName);
  }

  private findMetaMemberModel(
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>,
    memberName: string
  ): string | undefined {
    return findMetaMemberModel(metaMembers, memberName);
  }

  private resolveEffectiveConfiguredMember(
    configuredMembers: TeamConfig['members'] | undefined,
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>,
    memberName: string
  ): {
    name: string;
    role?: string;
    workflow?: string;
    isolation?: 'worktree';
    providerId?: TeamProviderId;
    providerBackendId?: TeamProviderBackendId;
    model?: string;
    effort?: EffortLevel;
    fastMode?: TeamFastMode;
    mcpPolicy?: ReturnType<typeof normalizeTeamMemberMcpPolicy>;
    cwd?: string;
    agentType?: string;
    removedAt?: number | string;
  } | null {
    return resolveEffectiveConfiguredMember(configuredMembers, metaMembers, memberName);
  }

  private resolveLeadMemberName(
    configuredMembers: TeamConfig['members'] | undefined,
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>
  ): string {
    return resolveLeadMemberName(configuredMembers, metaMembers);
  }

  private isMemberRemovedInMeta(
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>,
    memberName: string
  ): boolean {
    return isMemberRemovedInMeta(metaMembers, memberName);
  }

  private filterRemovedMembersFromLaunchSnapshot(
    snapshot: PersistedTeamLaunchSnapshot,
    metaMembers: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>
  ): PersistedTeamLaunchSnapshot {
    return filterRemovedMembersFromLaunchSnapshot(
      snapshot,
      metaMembers,
      this.getPersistedLaunchMemberNames(snapshot)
    );
  }

  private findEffectiveRunMemberModel(
    run: ProvisioningRun | null,
    memberName: string
  ): string | undefined {
    return findEffectiveRunMemberModel(run, memberName);
  }

  private findEffectiveRunMember(
    run: ProvisioningRun | null,
    memberName: string
  ): TeamCreateRequest['members'][number] | undefined {
    return findEffectiveRunMember(run, memberName);
  }

  private findTrackedMemberSpawnStatus(
    run: ProvisioningRun | null,
    memberName: string
  ): MemberSpawnStatusEntry | undefined {
    return findTrackedMemberSpawnStatus(run, memberName);
  }

  private buildLaunchMemberSpawnStatus(
    member: PersistedTeamLaunchMemberState | undefined,
    runtimeModel?: string
  ): MemberSpawnStatusEntry | undefined {
    return buildLaunchMemberSpawnStatus(member, runtimeModel);
  }

  private shouldPreferCurrentLaunchMemberStatus(
    trackedStatus: MemberSpawnStatusEntry | undefined,
    launchStatus: MemberSpawnStatusEntry | undefined
  ): boolean {
    return shouldPreferCurrentLaunchMemberStatus(trackedStatus, launchStatus);
  }

  private isLaunchMemberStatusRelevantToRuntimeRun(
    member: PersistedTeamLaunchMemberState | undefined,
    activeRuntimeRunId: string
  ): boolean {
    return isLaunchMemberStatusRelevantToRuntimeRun(member, activeRuntimeRunId);
  }

  private async getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    const runId = this.runTracking.getTrackedRunId(teamName);
    const cached = this.liveTeamAgentRuntimeMetadataCache.get(teamName);
    if (cached && cached.expiresAtMs > Date.now() && cached.runId === runId) {
      return this.cloneLiveTeamAgentRuntimeMetadata(cached.metadata);
    }

    const generationAtStart = this.getRuntimeSnapshotCacheGeneration(teamName);
    const existingRequest = this.liveTeamAgentRuntimeMetadataInFlightByTeam.get(teamName);
    if (existingRequest?.runIdAtStart === runId) {
      return this.cloneLiveTeamAgentRuntimeMetadata(await existingRequest.promise);
    }

    const request = this.buildLiveTeamAgentRuntimeMetadata(
      teamName,
      runId,
      generationAtStart
    ).finally(() => {
      if (this.liveTeamAgentRuntimeMetadataInFlightByTeam.get(teamName)?.promise === request) {
        this.liveTeamAgentRuntimeMetadataInFlightByTeam.delete(teamName);
      }
    });
    this.liveTeamAgentRuntimeMetadataInFlightByTeam.set(teamName, {
      generationAtStart,
      runIdAtStart: runId,
      promise: request,
    });
    return this.cloneLiveTeamAgentRuntimeMetadata(await request);
  }

  private async buildLiveTeamAgentRuntimeMetadata(
    teamName: string,
    runId: string | null,
    generationAtStart: number
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return buildLiveTeamAgentRuntimeMetadataHelper({
      teamName,
      runId,
      generationAtStart,
      runs: this.runs,
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      teamMetaStore: this.teamMetaStore,
      membersMetaStore: this.membersMetaStore,
      launchStateStore: this.launchStateStore,
      readConfigSnapshot: (targetTeamName) => this.readConfigSnapshot(targetTeamName),
      readPersistedRuntimeMembers: (targetTeamName) =>
        this.readPersistedRuntimeMembers(targetTeamName),
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
  }

  private readRuntimeProcessRowsForUsageSnapshot(
    teamName: string,
    options: { includeWindowsHostRows?: boolean } = {}
  ): ReturnType<TeamProvisioningRuntimeResourceSampling['readRuntimeProcessRowsForUsageSnapshot']> {
    return this.runtimeResourceSampling.readRuntimeProcessRowsForUsageSnapshot(teamName, options);
  }

  private readProcessUsageStatsByPid(
    pids: readonly number[],
    cacheOptions: { ignoreCachedMisses?: boolean } = {}
  ): ReturnType<TeamProvisioningRuntimeResourceSampling['readProcessUsageStatsByPid']> {
    return this.runtimeResourceSampling.readProcessUsageStatsByPid(pids, cacheOptions);
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
    metaMembers?: Awaited<ReturnType<TeamMembersMetaStore['getMembers']>>;
  }): Promise<PersistedTeamLaunchSnapshot> {
    return applyOpenCodeSecondaryEvidenceOverlayHelper(
      params,
      createDefaultOpenCodeSecondaryEvidenceOverlayPorts({
        teamsBasePath: getTeamsBasePath(),
        hasBootstrapCheckinTombstone: ({ teamName, laneId, runId }) =>
          this.hasOpenCodeBootstrapCheckinTombstone(teamName, laneId, runId),
        nowIso,
      })
    );
  }

  private async hasOpenCodeBootstrapCheckinTombstone(
    teamName: string,
    laneId: string | undefined,
    runId: string
  ): Promise<boolean> {
    const tombstoneStore = createRuntimeRunTombstoneStore({
      filePath: getOpenCodeRuntimeRunTombstonesPath(getTeamsBasePath(), teamName, laneId),
    });
    const tombstone = await tombstoneStore
      .find({
        teamName,
        runId,
        evidenceKind: 'bootstrap_checkin',
      })
      .catch(() => null);
    return Boolean(tombstone);
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

  private buildPendingBootstrapStatusMessage(
    prefix: string,
    run: ProvisioningRun,
    launchSummary: {
      confirmedCount: number;
      pendingCount: number;
      runtimeAlivePendingCount: number;
      shellOnlyPendingCount?: number;
      runtimeProcessPendingCount?: number;
      runtimeCandidatePendingCount?: number;
      noRuntimePendingCount?: number;
      permissionPendingCount?: number;
    },
    snapshot?: PersistedTeamLaunchSnapshot | null
  ): string {
    return buildPendingBootstrapStatusMessageHelper({ prefix, run, launchSummary, snapshot });
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

  private projectPendingRestartStatusForSnapshot(
    run: ProvisioningRun,
    memberName: string,
    current: MemberSpawnStatusEntry
  ): MemberSpawnStatusEntry {
    return projectPendingRestartStatusForSnapshotHelper(
      memberName,
      current,
      run.pendingMemberRestarts
    );
  }

  private shouldOverlayPrimaryBootstrapTruth(run: ProvisioningRun): boolean {
    return shouldOverlayPrimaryBootstrapTruthHelper(run);
  }

  private async overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(
    run: ProvisioningRun
  ): Promise<void> {
    if (!this.shouldOverlayPrimaryBootstrapTruth(run)) {
      return;
    }

    let bootstrapSnapshot: PersistedTeamLaunchSnapshot | null = null;
    try {
      bootstrapSnapshot = await readBootstrapLaunchSnapshot(run.teamName);
    } catch {
      return;
    }
    if (!bootstrapSnapshot) {
      return;
    }

    const runStartedAtMs = Date.parse(run.startedAt);
    const bootstrapUpdatedAtMs = Date.parse(bootstrapSnapshot.updatedAt);
    if (
      !Number.isFinite(runStartedAtMs) ||
      !Number.isFinite(bootstrapUpdatedAtMs) ||
      bootstrapUpdatedAtMs < runStartedAtMs
    ) {
      return;
    }

    const primaryMemberNames = new Set(
      [...(run.effectiveMembers ?? []), ...(run.expectedMembers ?? []).map((name) => ({ name }))]
        .map((member) => member.name?.trim())
        .filter((name): name is string => Boolean(name))
    );
    if (primaryMemberNames.size === 0) {
      return;
    }

    const updatedAt = nowIso();
    for (const memberName of primaryMemberNames) {
      if (this.isOpenCodeSecondaryLaneMemberInRun(run, memberName)) {
        continue;
      }
      const bootstrapMember = bootstrapSnapshot.members[memberName];
      if (bootstrapMember?.bootstrapConfirmed !== true) {
        continue;
      }
      const current =
        run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
      if (
        !isBootstrapMemberEvidenceCurrentForMember(
          { ...current, runtimeRunId: run.runId },
          bootstrapMember,
          'confirmation'
        )
      ) {
        continue;
      }
      if (current.launchState === 'skipped_for_launch' || current.skippedForLaunch === true) {
        continue;
      }
      const failureReason = current.hardFailureReason ?? current.error ?? current.runtimeDiagnostic;
      const provisionedButNotAliveFailure = isProvisionedButNotAliveFailureReason(failureReason);
      if (
        provisionedButNotAliveFailure &&
        hasUnsafeProvisionedButNotAliveRuntimeEvidence(current)
      ) {
        continue;
      }
      if (
        current.launchState === 'failed_to_start' &&
        !isBootstrapProofClearableLaunchFailureReason(failureReason)
      ) {
        continue;
      }

      const observedAt =
        bootstrapMember.lastHeartbeatAt ??
        bootstrapMember.lastEvaluatedAt ??
        bootstrapSnapshot.updatedAt ??
        updatedAt;
      const next: MemberSpawnStatusEntry = {
        ...current,
        status: 'online',
        updatedAt,
        agentToolAccepted: true,
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
        bootstrapStalled: undefined,
        error: undefined,
        hardFailureReason: undefined,
        livenessSource: current.livenessSource ?? 'heartbeat',
        firstSpawnAcceptedAt:
          current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt ?? observedAt,
        lastHeartbeatAt: isMemberSpawnHeartbeatTimestampNewer(current.lastHeartbeatAt, observedAt)
          ? observedAt
          : current.lastHeartbeatAt,
        livenessLastCheckedAt: updatedAt,
        launchState: 'confirmed_alive',
      };
      this.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, updatedAt);
      run.memberSpawnStatuses.set(memberName, next);
      run.pendingMemberRestarts?.delete(memberName);
      this.syncMemberLaunchGraceCheck(run, memberName, next);
    }
  }

  private async applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
    run: ProvisioningRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    if (!this.shouldOverlayPrimaryBootstrapTruth(run) || !snapshot) {
      return snapshot;
    }

    let bootstrapSnapshot: PersistedTeamLaunchSnapshot | null = null;
    try {
      bootstrapSnapshot = await readBootstrapLaunchSnapshot(run.teamName);
    } catch {
      return snapshot;
    }
    if (!bootstrapSnapshot) {
      return snapshot;
    }

    const runStartedAtMs = Date.parse(run.startedAt);
    const bootstrapUpdatedAtMs = Date.parse(bootstrapSnapshot.updatedAt);
    if (
      !Number.isFinite(runStartedAtMs) ||
      !Number.isFinite(bootstrapUpdatedAtMs) ||
      bootstrapUpdatedAtMs < runStartedAtMs
    ) {
      return snapshot;
    }

    const primaryMemberNames = new Set(
      [
        ...(run.effectiveMembers ?? []).map((member) => member.name?.trim() ?? ''),
        ...(snapshot.bootstrapExpectedMembers ?? []),
      ].filter((name): name is string => name.length > 0)
    );
    if (primaryMemberNames.size === 0) {
      return snapshot;
    }

    let changed = false;
    const updatedAt = nowIso();
    const nextMembers: Record<string, PersistedTeamLaunchMemberState> = { ...snapshot.members };
    for (const memberName of primaryMemberNames) {
      const current = nextMembers[memberName];
      const bootstrapMember = bootstrapSnapshot.members[memberName];
      if (!current || bootstrapMember?.bootstrapConfirmed !== true) {
        continue;
      }
      if (
        !isBootstrapMemberEvidenceCurrentForMember(
          { ...current, runtimeRunId: run.runId },
          bootstrapMember,
          'confirmation'
        )
      ) {
        continue;
      }
      if (
        current.providerId === 'opencode' ||
        isPersistedOpenCodeSecondaryLaneMember(current) ||
        this.isOpenCodeSecondaryLaneMemberInRun(run, memberName)
      ) {
        continue;
      }
      if (current.launchState === 'skipped_for_launch' || current.skippedForLaunch === true) {
        continue;
      }

      const persistedError =
        typeof (current as { error?: unknown }).error === 'string'
          ? (current as { error?: string }).error
          : undefined;
      const failureReason =
        current.hardFailureReason ?? persistedError ?? current.runtimeDiagnostic;
      const provisionedButNotAliveFailure = isProvisionedButNotAliveFailureReason(failureReason);
      if (
        provisionedButNotAliveFailure &&
        hasUnsafeProvisionedButNotAliveRuntimeEvidence(current)
      ) {
        continue;
      }
      const hasFailure =
        current.launchState === 'failed_to_start' ||
        current.hardFailure === true ||
        typeof current.hardFailureReason === 'string' ||
        typeof persistedError === 'string';
      if (hasFailure && !isBootstrapProofClearableLaunchFailureReason(failureReason)) {
        continue;
      }

      const observedAt =
        bootstrapMember.lastHeartbeatAt ??
        bootstrapMember.lastEvaluatedAt ??
        bootstrapSnapshot.updatedAt ??
        updatedAt;
      nextMembers[memberName] = {
        ...current,
        launchState: 'confirmed_alive',
        agentToolAccepted: true,
        runtimeAlive:
          current.runtimeAlive === true ||
          bootstrapMember.runtimeAlive === true ||
          provisionedButNotAliveFailure,
        bootstrapConfirmed: true,
        hardFailure: false,
        hardFailureReason: undefined,
        runtimeDiagnostic: shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(
          current.runtimeDiagnostic
        )
          ? undefined
          : current.runtimeDiagnostic,
        runtimeDiagnosticSeverity: shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(
          current.runtimeDiagnostic
        )
          ? undefined
          : current.runtimeDiagnosticSeverity,
        bootstrapStalled: undefined,
        firstSpawnAcceptedAt:
          current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt ?? observedAt,
        lastHeartbeatAt: current.lastHeartbeatAt ?? bootstrapMember.lastHeartbeatAt ?? observedAt,
        lastRuntimeAliveAt:
          current.lastRuntimeAliveAt ?? bootstrapMember.lastRuntimeAliveAt ?? observedAt,
        lastEvaluatedAt: updatedAt,
        sources: {
          ...(current.sources ?? {}),
          nativeHeartbeat: true,
          hardFailureSignal: undefined,
        },
        diagnostics: undefined,
      };
      changed = true;
    }

    if (!changed) {
      return snapshot;
    }

    return createPersistedLaunchSnapshot({
      teamName: snapshot.teamName,
      expectedMembers: snapshot.expectedMembers,
      bootstrapExpectedMembers: snapshot.bootstrapExpectedMembers,
      leadSessionId: snapshot.leadSessionId,
      launchPhase: snapshot.launchPhase,
      members: nextMembers,
      updatedAt,
    });
  }

  private async reconcileFinalLaunchReportingSnapshot(
    run: ProvisioningRun,
    snapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    const reconciled = await this.applyPrimaryBootstrapTruthToLaunchReportingSnapshot(
      run,
      snapshot
    );
    if (!reconciled || reconciled === snapshot) {
      return reconciled;
    }
    this.syncRunMemberSpawnStatusesFromSnapshot(run, reconciled);
    try {
      return await this.writeLaunchStateSnapshot(run.teamName, reconciled);
    } catch (error) {
      logger.warn(
        `[${run.teamName}] Failed to persist reconciled launch reporting snapshot: ${getErrorMessage(
          error
        )}`
      );
      return reconciled;
    }
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
    if (
      !run.provisioningComplete ||
      run.cancelRequested ||
      run.processKilled ||
      isTerminalFailureProvisioningState(run.progress.state) ||
      this.isProvisioningRunPromotedToAlive(run) ||
      this.hasPendingDeterministicFirstRealTurn(run) ||
      !this.isProvisioningRunStillPromotable(run) ||
      this.provisioningRunByTeam.get(run.teamName) !== run.runId
    ) {
      return;
    }

    if ((run.mixedSecondaryLanes ?? []).length > 0) {
      return;
    }

    const snapshot = await readBootstrapLaunchSnapshot(run.teamName).catch(() => null);
    if (!this.isProvisioningRunStillPromotable(run)) {
      return;
    }
    if (
      !snapshot ||
      (snapshot.launchPhase !== 'finished' && snapshot.launchPhase !== 'reconciled')
    ) {
      return;
    }

    const runStartedAtMs = Date.parse(run.startedAt);
    const snapshotUpdatedAtMs = Date.parse(snapshot.updatedAt);
    if (
      Number.isFinite(runStartedAtMs) &&
      Number.isFinite(snapshotUpdatedAtMs) &&
      snapshotUpdatedAtMs < runStartedAtMs
    ) {
      return;
    }

    const memberNames = this.getPersistedLaunchMemberNames(snapshot);
    if (memberNames.length === 0) {
      return;
    }

    this.syncRunMemberSpawnStatusesFromSnapshot(run, snapshot);
    await this.writeLaunchStateSnapshot(run.teamName, snapshot).catch((error: unknown) => {
      logger.warn(
        `[${run.teamName}] Failed to persist recovered deterministic bootstrap snapshot: ${getErrorMessage(
          error
        )}`
      );
    });
    if (!this.isProvisioningRunStillPromotable(run)) {
      return;
    }

    const failedSpawnMembers = memberNames
      .filter((memberName) => snapshot.members[memberName]?.launchState === 'failed_to_start')
      .map((memberName) => ({
        name: memberName,
        error: snapshot.members[memberName]?.hardFailureReason,
        updatedAt: snapshot.members[memberName]?.lastEvaluatedAt ?? nowIso(),
      }));
    const launchSummary = snapshot.summary ?? this.getMemberLaunchSummary(run);
    const hasSpawnFailures = failedSpawnMembers.length > 0;
    const hasPendingBootstrap =
      !hasSpawnFailures && this.hasPendingLaunchMembers(run, launchSummary, snapshot);
    const messagePrefix = run.isLaunch ? 'Launch completed' : 'Team provisioned';
    const readyMessage = hasSpawnFailures
      ? `${messagePrefix} with teammate errors - ${failedSpawnMembers
          .map((member) => member.name)
          .join(', ')} failed to start`
      : hasPendingBootstrap
        ? this.buildAggregatePendingLaunchMessage(messagePrefix, run, launchSummary, snapshot)
        : run.isLaunch
          ? 'Team launched - process alive and ready'
          : 'Team provisioned - process alive and ready';

    const progress = updateProgress(run, 'ready', readyMessage, {
      cliLogsTail: extractCliLogsFromRun(run),
      messageSeverity: hasSpawnFailures || hasPendingBootstrap ? 'warning' : undefined,
    });
    run.onProgress(progress);
    this.provisioningRunByTeam.delete(run.teamName);
    this.runTracking.setAliveRunId(run.teamName, run.runId);
    logger.warn(
      `[${run.teamName}] Recovered ready state from completed deterministic bootstrap snapshot after post-bootstrap finalization delay.`
    );

    this.teamChangeEmitter?.({
      type: 'lead-message',
      teamName: run.teamName,
      runId: run.runId,
      detail: 'lead-session-sync',
    });

    if (!hasSpawnFailures && !hasPendingBootstrap) {
      void this.fireTeamLaunchedNotification(run);
    } else if (hasSpawnFailures) {
      void this.fireTeamLaunchIncompleteNotification(
        run,
        failedSpawnMembers,
        launchSummary,
        snapshot
      );
    }
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
    const memberNames = this.getPersistedLaunchMemberNames(snapshot);
    const snapshotStatuses = snapshotToMemberSpawnStatuses(snapshot);
    run.expectedMembers = memberNames;
    for (const memberName of memberNames) {
      if (run.pendingMemberRestarts?.has(memberName) === true) {
        continue;
      }
      const entry = snapshotStatuses[memberName];
      if (entry) {
        const previous =
          run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
        if (previous.runtimeAlive === true && entry.runtimeAlive !== true) {
          this.pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, entry.updatedAt);
        }
        run.memberSpawnStatuses.set(memberName, entry);
      }
    }
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

  private getPersistedLaunchMemberNames(snapshot: PersistedTeamLaunchSnapshot): string[] {
    return getPersistedLaunchMemberNames(snapshot);
  }

  private buildLiveLaunchSnapshotForRun(
    run: ProvisioningRun,
    launchPhase: PersistedTeamLaunchPhase = run.provisioningComplete ? 'finished' : 'active'
  ): PersistedTeamLaunchSnapshot | null {
    const mixedSnapshot = this.buildMixedPersistedLaunchSnapshotForRun(run, launchPhase);
    if (mixedSnapshot) {
      return mixedSnapshot;
    }

    if (!run.isLaunch || !run.expectedMembers || run.expectedMembers.length === 0) {
      return null;
    }

    return snapshotFromRuntimeMemberStatuses({
      teamName: run.teamName,
      expectedMembers: run.expectedMembers,
      leadSessionId: run.detectedSessionId ?? undefined,
      launchPhase,
      statuses: this.buildRuntimeSpawnStatusRecord(run),
    });
  }

  private emitMemberSpawnChange(
    run: Pick<ProvisioningRun, 'teamName' | 'runId'>,
    memberName: string
  ): void {
    this.invalidateMemberSpawnStatusesCache(run.teamName);
    this.teamChangeEmitter?.({
      type: 'member-spawn',
      teamName: run.teamName,
      runId: run.runId,
      detail: memberName,
    });
    const trackedRun = this.runs.get(run.runId);
    if (trackedRun?.teamName === run.teamName) {
      void this.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(trackedRun);
    }
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

  private hasLeadInboxLaunchReconcileHeartbeat(
    snapshot: PersistedTeamLaunchSnapshot,
    messages: readonly LeadInboxLaunchReconcileMessage[]
  ): boolean {
    const expectedMembers = this.getPersistedLaunchMemberNames(snapshot);
    return hasMixedSecondaryLaunchReconcileHeartbeatHelper({
      snapshot,
      messages,
      expectedMembers,
      ports: {
        resolveExpectedLaunchMemberName: (members, candidateName) =>
          this.resolveExpectedLaunchMemberName(members, candidateName),
        isMeaningfulBootstrapCheckInMessage,
      },
    });
  }

  private selectLatestLeadInboxLaunchReconcileMessage(
    messages: readonly LeadInboxLaunchReconcileMessage[],
    expectedMembers: readonly string[],
    expected: string,
    firstSpawnAcceptedAt?: string
  ): LeadInboxLaunchReconcileMessage | null {
    return selectLatestMixedSecondaryLaunchReconcileMessageHelper({
      messages,
      expectedMembers,
      expected,
      firstSpawnAcceptedAt,
      ports: {
        resolveExpectedLaunchMemberName: (members, candidateName) =>
          this.resolveExpectedLaunchMemberName(members, candidateName),
        isMeaningfulBootstrapCheckInMessage,
      },
    });
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
    await this.overlayPrimaryBootstrapTruthIntoRunStatusesFromBootstrapState(run);
    const snapshot = this.buildLiveLaunchSnapshotForRun(run, launchPhase);
    if (!snapshot) {
      if (run.isLaunch) {
        await this.clearPersistedLaunchStateNow(run.teamName, { expectedRunId: run.runId });
      }
      return null;
    }

    const metaMembers = await this.membersMetaStore.getMembers(run.teamName).catch(() => []);
    const filteredSnapshot = this.filterRemovedMembersFromLaunchSnapshot(snapshot, metaMembers);

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
    const setup = await setupMixedSecondaryLaneLaunch(run, lane, {
      nowMs: () => Date.now(),
      randomUuid: () => randomUUID(),
      teamsBasePath: () => getTeamsBasePath(),
      isStoppingSecondaryRuntimeTeam: (teamName) =>
        this.stoppingSecondaryRuntimeTeams.has(teamName),
      clearOpenCodeRuntimeLaneStorage,
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      migrateLegacyOpenCodeRuntimeState,
      upsertOpenCodeRuntimeLaneIndexEntry,
      buildOpenCodeSecondaryLaneTimingDiagnostic,
      publishMixedSecondaryLaneStatusChange: (nextRun, nextLane) =>
        this.publishMixedSecondaryLaneStatusChange(nextRun, nextLane),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      setSecondaryRuntimeRun: (input) => this.setSecondaryRuntimeRun(input),
    });
    if (setup.outcome !== 'ready') {
      return;
    }
    const {
      adapter,
      finishCancelledLane,
      laneCwd,
      laneRunId,
      migration,
      previousLaunchState,
      requestedDiagnostics,
      shouldAbortLaunch,
    } = setup;

    try {
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      await prepareOpenCodeRuntimeLaneForLaunchGeneration({
        teamsBasePath: getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        runId: laneRunId,
        reason: 'mixed_secondary_launch',
      });
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      const appManagedLaunchPrompt = await this.buildOpenCodeSecondaryAppManagedLaunchPrompt(
        run,
        lane
      );
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      const laneExpectedMembers: TeamRuntimeMemberSpec[] = [
        {
          name: lane.member.name,
          role: lane.member.role,
          workflow: lane.member.workflow,
          isolation: lane.member.isolation === 'worktree' ? ('worktree' as const) : undefined,
          providerId: 'opencode',
          model: lane.member.model,
          effort: lane.member.effort,
          cwd: laneCwd,
        },
      ];
      const launchOpenCodeLane = () =>
        adapter.launch({
          runId: laneRunId,
          laneId: lane.laneId,
          teamName: run.teamName,
          cwd: laneCwd,
          prompt: appManagedLaunchPrompt,
          providerId: 'opencode',
          model: lane.member.model,
          effort: lane.member.effort,
          runtimeOnly: true,
          skipPermissions: run.request.skipPermissions !== false,
          expectedMembers: laneExpectedMembers,
          previousLaunchState,
        });
      let rawResult: TeamRuntimeLaunchResult;
      try {
        rawResult = await launchOpenCodeLane();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const staleManifestMessage = 'Bridge server runtime manifest high watermark is stale';
        if (
          message !== staleManifestMessage &&
          message !== `OpenCode bridge failed: ${staleManifestMessage}`
        ) {
          throw error;
        }
        if (shouldAbortLaunch()) {
          await finishCancelledLane();
          return;
        }
        const recovery = await prepareOpenCodeRuntimeLaneForLaunchGeneration({
          teamsBasePath: getTeamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          runId: laneRunId,
          reason: 'mixed_secondary_launch_stale_manifest_recovery',
          forceReset: true,
        });
        lane.diagnostics = appendDiagnosticOnce(
          [...lane.diagnostics, ...recovery.diagnostics],
          'Retried OpenCode secondary launch after resetting stale runtime manifest.'
        );
        if (shouldAbortLaunch()) {
          await finishCancelledLane();
          return;
        }
        rawResult = await launchOpenCodeLane();
      }
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      // Treat the bridge result as provisional. The guard below is the single
      // promotion gate that turns app-managed OpenCode bootstrap into
      // confirmed_alive only after durable lane evidence exists on disk.
      const result = await this.guardCommittedOpenCodeSecondaryLaneEvidence({
        teamName: run.teamName,
        laneId: lane.laneId,
        memberName: lane.member.name,
        result: rawResult,
      });
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      lane.launchFinishedAtMs = Date.now();
      const timingDiagnostic = buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
      const memberEvidence = result.members[lane.member.name];
      const resultWithTiming: TeamRuntimeLaunchResult = timingDiagnostic
        ? {
            ...result,
            diagnostics: appendDiagnosticOnce(result.diagnostics, timingDiagnostic),
            members: {
              ...result.members,
              ...(memberEvidence
                ? {
                    [lane.member.name]: {
                      ...memberEvidence,
                      diagnostics: appendDiagnosticOnce(
                        memberEvidence.diagnostics ?? [],
                        timingDiagnostic
                      ),
                    },
                  }
                : {}),
            },
          }
        : result;
      const baseFailureDiagnostics = appendDiagnosticOnce(
        [...requestedDiagnostics, ...migration.diagnostics],
        timingDiagnostic
      );
      const recoverableBootstrapPending = isRecoverableOpenCodeBootstrapPendingLaunchResult(
        resultWithTiming,
        lane.member.name
      );
      const normalizedResult = recoverableBootstrapPending
        ? normalizeRecoverableOpenCodeBootstrapPendingLaunchResult(
            resultWithTiming,
            lane.member.name,
            baseFailureDiagnostics
          )
        : resultWithTiming;
      lane.result = normalizedResult;
      this.syncOpenCodeRuntimeToolApprovals({
        teamName: run.teamName,
        runId: laneRunId,
        laneId: lane.laneId,
        cwd: laneCwd,
        members: normalizedResult.members,
        expectedMembers: laneExpectedMembers,
        teamColor: run.request.color,
        teamDisplayName: run.request.displayName,
      });
      lane.warnings = [...normalizedResult.warnings];
      const launchDiagnostics = appendDiagnosticOnce(
        [...requestedDiagnostics, ...migration.diagnostics, ...normalizedResult.diagnostics],
        timingDiagnostic
      );
      lane.diagnostics = launchDiagnostics;

      if (recoverableBootstrapPending) {
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'active',
          diagnostics: collectOpenCodeSecondaryLaneFailureDiagnostics(
            normalizedResult,
            lane.member.name,
            baseFailureDiagnostics
          ),
        }).catch(() => undefined);
      } else if (
        isDefinitiveOpenCodePreLaunchFailure(normalizedResult, lane.member.name) ||
        normalizedResult.teamLaunchState === 'partial_failure'
      ) {
        const diagnostics = collectOpenCodeSecondaryLaneFailureDiagnostics(
          normalizedResult,
          lane.member.name,
          baseFailureDiagnostics
        );
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'degraded',
          diagnostics,
        }).catch(() => undefined);
        this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
      }
    } catch (error) {
      if (shouldAbortLaunch()) {
        await finishCancelledLane();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      lane.launchFinishedAtMs = Date.now();
      const timingDiagnostic = buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
      lane.result = {
        runId: laneRunId,
        teamName: run.teamName,
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          [lane.member.name]: {
            memberName: lane.member.name,
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: message,
            diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
          },
        },
        warnings: [],
        diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
      };
      lane.warnings = [];
      lane.diagnostics = appendDiagnosticOnce(
        [...requestedDiagnostics, ...migration.diagnostics, message],
        timingDiagnostic
      );
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
        state: 'degraded',
        diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
      }).catch(() => undefined);
      this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    }

    await this.publishMixedSecondaryLaneStatusChange(run, lane);
    lane.state = 'finished';
  }

  private async stopSingleMixedSecondaryRuntimeLane(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState,
    reason: TeamRuntimeStopInput['reason']
  ): Promise<void> {
    await stopSingleMixedSecondaryRuntimeLaneHelper(run, lane, reason, {
      teamsBasePath: getTeamsBasePath(),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      upsertOpenCodeRuntimeLaneIndexEntry,
      clearOpenCodeRuntimeLaneStorage,
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      logger,
    });
  }

  private launchQueuedMixedSecondaryLaneInBackground(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): void {
    launchQueuedMixedSecondaryLaneInBackgroundHelper(run, lane, {
      nowMs: () => Date.now(),
      randomUuid: () => randomUUID(),
      teamsBasePath: () => getTeamsBasePath(),
      clearOpenCodeRuntimeLaneStorage,
      upsertOpenCodeRuntimeLaneIndexEntry,
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      launchSingleMixedSecondaryLane: (nextRun, nextLane) =>
        this.launchSingleMixedSecondaryLane(nextRun, nextLane),
      publishMixedSecondaryLaneStatusChange: (nextRun, nextLane) =>
        this.publishMixedSecondaryLaneStatusChange(nextRun, nextLane),
      persistLaunchStateSnapshot: (nextRun, launchPhase) =>
        this.persistLaunchStateSnapshot(nextRun, launchPhase),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      getMixedSecondaryLaunchPhase: (nextRun) => this.getMixedSecondaryLaunchPhase(nextRun),
      createUnexpectedMixedSecondaryLaneFailureResult,
      logger,
    });
  }

  private async launchMixedSecondaryLaneIfNeeded(
    run: ProvisioningRun
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    return launchMixedSecondaryLaneIfNeededHelper(run, {
      nowMs: () => Date.now(),
      randomUuid: () => randomUUID(),
      teamsBasePath: () => getTeamsBasePath(),
      clearOpenCodeRuntimeLaneStorage,
      upsertOpenCodeRuntimeLaneIndexEntry,
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      launchSingleMixedSecondaryLane: (nextRun, nextLane) =>
        this.launchSingleMixedSecondaryLane(nextRun, nextLane),
      publishMixedSecondaryLaneStatusChange: (nextRun, nextLane) =>
        this.publishMixedSecondaryLaneStatusChange(nextRun, nextLane),
      persistLaunchStateSnapshot: (nextRun, launchPhase) =>
        this.persistLaunchStateSnapshot(nextRun, launchPhase),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      getMixedSecondaryLaunchPhase: (nextRun) => this.getMixedSecondaryLaunchPhase(nextRun),
      createUnexpectedMixedSecondaryLaneFailureResult,
      logger,
    });
  }

  private async recoverStaleMixedSecondaryLaunchSnapshot(
    teamName: string,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null,
    persistedSnapshot: PersistedTeamLaunchSnapshot | null
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    if (
      persistedSnapshot &&
      this.hasMixedSecondaryLaunchMetadata(persistedSnapshot) &&
      !this.shouldRecoverStalePersistedMixedLaunchSnapshot(persistedSnapshot)
    ) {
      return persistedSnapshot;
    }

    const teamMeta = await this.teamMetaStore.getMeta(teamName).catch(() => null);
    const leadLaunchIdentity = teamMeta?.launchIdentity;
    const leadProviderId =
      normalizeOptionalTeamProviderId(leadLaunchIdentity?.providerId) ??
      normalizeOptionalTeamProviderId(teamMeta?.providerId);
    if (!leadProviderId) {
      return null;
    }

    const membersMeta = await this.membersMetaStore.getMeta(teamName).catch(() => null);
    const activeMembers = (membersMeta?.members ?? []).filter(
      (member) => !member.removedAt && !isLeadMember({ name: member.name })
    );
    if (activeMembers.length === 0) {
      return null;
    }
    const projectPath = this.readPersistedTeamProjectPath(teamName);

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => ({
        version: 1 as const,
        updatedAt: nowIso(),
        lanes: {} as Record<
          string,
          {
            laneId: string;
            state: 'active' | 'stopped' | 'degraded';
            updatedAt: string;
            diagnostics?: string[];
          }
        >,
      })
    );
    const bootstrapStatuses = snapshotToMemberSpawnStatuses(bootstrapSnapshot);
    const leadDefaults = {
      providerId: leadProviderId,
      providerBackendId:
        migrateProviderBackendId(
          leadProviderId,
          leadLaunchIdentity
            ? (leadLaunchIdentity.providerBackendId ??
                teamMeta?.providerBackendId ??
                membersMeta?.providerBackendId)
            : (teamMeta?.providerBackendId ?? membersMeta?.providerBackendId)
        ) ?? null,
      selectedFastMode: leadLaunchIdentity?.selectedFastMode ?? teamMeta?.fastMode,
      resolvedFastMode:
        typeof teamMeta?.launchIdentity?.resolvedFastMode === 'boolean'
          ? teamMeta.launchIdentity.resolvedFastMode
          : null,
      launchIdentity: teamMeta?.launchIdentity ?? null,
    };
    const primaryMembers: TeamMember[] = [];
    const secondaryMembers: {
      laneId: string;
      runtimeRunId?: string | null;
      member: TeamMember;
      leadDefaults: typeof leadDefaults;
      evidence?: {
        launchState?: MemberLaunchState;
        agentToolAccepted?: boolean;
        runtimeAlive?: boolean;
        bootstrapConfirmed?: boolean;
        hardFailure?: boolean;
        hardFailureReason?: string;
        pendingPermissionRequestIds?: string[];
        runtimePid?: number;
        sessionId?: string;
        runtimeSessionId?: string;
        bootstrapEvidenceSource?: OpenCodeBootstrapEvidenceSource;
        bootstrapMode?: 'model_tool_checkin' | 'app_managed_context';
        appManagedBootstrapCandidate?: OpenCodeAppManagedBootstrapCandidate;
        livenessKind?: TeamAgentRuntimeLivenessKind;
        pidSource?: TeamAgentRuntimePidSource;
        runtimeDiagnostic?: string;
        runtimeDiagnosticSeverity?: TeamAgentRuntimeDiagnosticSeverity;
        firstSpawnAcceptedAt?: string;
        diagnostics?: string[];
      };
      pendingReason?: string;
    }[] = [];
    let recoveredAny = false;

    for (const member of activeMembers) {
      const persistedMember =
        persistedSnapshot?.members?.[member.name] ?? bootstrapSnapshot?.members?.[member.name];
      const laneIdentity =
        leadProviderId === 'opencode'
          ? (() => {
              const persistedLaneId = persistedMember?.laneId?.startsWith('secondary:opencode:')
                ? persistedMember.laneId
                : null;
              const generatedLaneId = buildOpenCodeSecondaryLaneId(member);
              const memberCwd = member.cwd?.trim();
              const projectRoot = projectPath?.trim();
              const hasWorktreeRoot =
                Boolean(memberCwd) && (!projectRoot || memberCwd !== projectRoot);
              if (!persistedLaneId && !laneIndex.lanes[generatedLaneId] && !hasWorktreeRoot) {
                return {
                  laneId: 'primary',
                  laneKind: 'primary',
                  laneOwnerProviderId: leadProviderId,
                } as const;
              }
              return {
                laneId: persistedLaneId ?? generatedLaneId,
                laneKind: 'secondary',
                laneOwnerProviderId: 'opencode',
              } as const;
            })()
          : buildPlannedMemberLaneIdentity({
              leadProviderId,
              member: {
                name: member.name,
                providerId: normalizeOptionalTeamProviderId(member.providerId),
              },
            });

      if (
        laneIdentity.laneKind !== 'secondary' ||
        laneIdentity.laneOwnerProviderId !== 'opencode'
      ) {
        primaryMembers.push(member);
        continue;
      }

      let laneEntry = laneIndex.lanes[laneIdentity.laneId];
      if (
        !laneEntry &&
        persistedMember &&
        isRecoverablePersistedOpenCodeRuntimeCandidate(persistedMember) &&
        persistedMember.laneId === laneIdentity.laneId
      ) {
        const runtimeEvidence = await this.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
          teamName,
          laneId: laneIdentity.laneId,
          member,
          projectPath,
          previousLaunchState: persistedSnapshot ?? bootstrapSnapshot,
          persistedMember,
        });
        if (runtimeEvidence) {
          recoveredAny = true;
          secondaryMembers.push({
            laneId: laneIdentity.laneId,
            runtimeRunId: persistedMember.runtimeRunId,
            member,
            leadDefaults,
            evidence: {
              launchState: runtimeEvidence.launchState,
              agentToolAccepted: runtimeEvidence.agentToolAccepted,
              runtimeAlive: runtimeEvidence.runtimeAlive,
              bootstrapConfirmed: runtimeEvidence.bootstrapConfirmed,
              hardFailure: runtimeEvidence.hardFailure,
              hardFailureReason: runtimeEvidence.hardFailureReason,
              pendingPermissionRequestIds: runtimeEvidence.pendingPermissionRequestIds,
              runtimePid: runtimeEvidence.runtimePid,
              sessionId: runtimeEvidence.sessionId,
              runtimeSessionId: runtimeEvidence.sessionId,
              bootstrapEvidenceSource: runtimeEvidence.bootstrapEvidenceSource,
              bootstrapMode: runtimeEvidence.bootstrapMode,
              appManagedBootstrapCandidate: runtimeEvidence.appManagedBootstrapCandidate,
              livenessKind: runtimeEvidence.livenessKind,
              pidSource: runtimeEvidence.pidSource,
              runtimeDiagnostic: runtimeEvidence.runtimeDiagnostic,
              runtimeDiagnosticSeverity: runtimeEvidence.runtimeDiagnosticSeverity,
              firstSpawnAcceptedAt: persistedMember.firstSpawnAcceptedAt,
              diagnostics: runtimeEvidence.diagnostics,
            },
          });
          continue;
        }
      }
      if (laneEntry?.state === 'active') {
        const runtimeEvidence = await this.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
          teamName,
          laneId: laneIdentity.laneId,
          member,
          projectPath,
          previousLaunchState: persistedSnapshot ?? bootstrapSnapshot,
        });
        if (isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
          recoveredAny = true;
          const runtimeRunId =
            runtimeEvidence.appManagedBootstrapCandidate?.runId ??
            (await this.openCodeRuntimeRecoveryIdentity.resolveCurrentOpenCodeRuntimeRunId(
              teamName,
              laneIdentity.laneId
            )) ??
            persistedMember?.runtimeRunId?.trim() ??
            undefined;
          secondaryMembers.push({
            laneId: laneIdentity.laneId,
            runtimeRunId,
            member,
            leadDefaults,
            evidence: {
              launchState: runtimeEvidence.launchState,
              agentToolAccepted: runtimeEvidence.agentToolAccepted,
              runtimeAlive: runtimeEvidence.runtimeAlive,
              bootstrapConfirmed: runtimeEvidence.bootstrapConfirmed,
              hardFailure: runtimeEvidence.hardFailure,
              hardFailureReason: runtimeEvidence.hardFailureReason,
              pendingPermissionRequestIds: runtimeEvidence.pendingPermissionRequestIds,
              runtimePid: runtimeEvidence.runtimePid,
              sessionId: runtimeEvidence.sessionId,
              bootstrapEvidenceSource: runtimeEvidence.bootstrapEvidenceSource,
              bootstrapMode: runtimeEvidence.bootstrapMode,
              appManagedBootstrapCandidate: runtimeEvidence.appManagedBootstrapCandidate,
              livenessKind: runtimeEvidence.livenessKind,
              pidSource: runtimeEvidence.pidSource,
              runtimeDiagnostic: runtimeEvidence.runtimeDiagnostic,
              runtimeDiagnosticSeverity: runtimeEvidence.runtimeDiagnosticSeverity,
              firstSpawnAcceptedAt: persistedMember?.firstSpawnAcceptedAt,
              diagnostics: runtimeEvidence.diagnostics,
            },
          });
          continue;
        }
        const recovery = await recoverStaleOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId: laneIdentity.laneId,
        });
        if (recovery.stale) {
          recoveredAny = true;
          laneEntry = {
            laneId: laneIdentity.laneId,
            state: 'degraded',
            updatedAt: nowIso(),
            diagnostics: recovery.diagnostics,
          };
        }
      }

      if (laneEntry?.state === 'degraded') {
        recoveredAny = true;
        const diagnostics = laneEntry.diagnostics?.length
          ? [...laneEntry.diagnostics]
          : [`OpenCode lane ${laneIdentity.laneId} is degraded and requires stop + relaunch.`];
        secondaryMembers.push({
          laneId: laneIdentity.laneId,
          member,
          leadDefaults,
          evidence: {
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: diagnostics[0],
            diagnostics,
          },
        });
        continue;
      }

      secondaryMembers.push({
        laneId: laneIdentity.laneId,
        member,
        leadDefaults,
        pendingReason: 'Waiting for OpenCode secondary lane recovery.',
      });
    }

    if (!recoveredAny) {
      return null;
    }

    const primaryStatuses = Object.fromEntries(
      primaryMembers.map((member) => [
        member.name,
        bootstrapStatuses[member.name] ?? createInitialMemberSpawnStatusEntry(),
      ])
    );
    const recoveredSnapshot = this.runtimeLaneCoordinator.buildAggregateLaunchSnapshot({
      teamName,
      leadSessionId: persistedSnapshot?.leadSessionId ?? bootstrapSnapshot?.leadSessionId,
      launchPhase:
        persistedSnapshot?.launchPhase === 'active'
          ? 'active'
          : bootstrapSnapshot?.launchPhase === 'active'
            ? 'active'
            : 'reconciled',
      leadDefaults,
      primaryMembers,
      primaryStatuses,
      secondaryMembers,
    });
    return this.writeLaunchStateSnapshot(teamName, recoveredSnapshot);
  }

  private async tryRecoverActiveOpenCodeSecondaryLaneFromRuntime(params: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null> {
    const adapter = this.getOpenCodeRuntimeAdapter();
    const runtimeProjectPath = params.member.cwd?.trim() || params.projectPath;
    if (!adapter || !runtimeProjectPath) {
      return null;
    }

    try {
      const reconcileResult = await adapter.reconcile({
        runId: randomUUID(),
        laneId: params.laneId,
        teamName: params.teamName,
        providerId: 'opencode',
        expectedMembers: [
          {
            name: params.member.name,
            role: params.member.role,
            workflow: params.member.workflow,
            isolation: params.member.isolation === 'worktree' ? ('worktree' as const) : undefined,
            providerId: 'opencode',
            model: params.member.model,
            effort: params.member.effort,
            cwd: runtimeProjectPath,
          },
        ],
        previousLaunchState: params.previousLaunchState,
        reason: 'startup_recovery',
      });
      return reconcileResult.members[params.member.name] ?? null;
    } catch (error) {
      logger.warn(
        `[${params.teamName}] Failed to recover stale OpenCode lane ${params.laneId} from runtime bridge: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
  }

  private async tryRecoverMissingOpenCodeSecondaryLaneFromRuntime(params: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    persistedMember: PersistedTeamLaunchMemberState;
  }): Promise<TeamRuntimeMemberLaunchEvidence | null> {
    const currentLaneIndex = await readOpenCodeRuntimeLaneIndex(
      getTeamsBasePath(),
      params.teamName
    ).catch(() => null);
    const currentEntry = currentLaneIndex?.lanes[params.laneId];
    if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
      return null;
    }
    if (!isRecoverablePersistedOpenCodeRuntimeCandidate(params.persistedMember)) {
      return null;
    }

    const runtimeEvidence = await this.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
      teamName: params.teamName,
      laneId: params.laneId,
      member: params.member,
      projectPath: params.projectPath,
      previousLaunchState: params.previousLaunchState,
    });
    if (!isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
      return null;
    }

    const diagnostics = Array.from(
      new Set([
        'Recovered missing OpenCode runtime lane index from persisted runtime evidence.',
        ...(runtimeEvidence.diagnostics ?? []),
      ])
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: params.teamName,
      laneId: params.laneId,
      state: 'active',
      diagnostics,
    }).catch((error: unknown) => {
      logger.warn(
        `[${params.teamName}] Failed to recover missing OpenCode lane index ${params.laneId}: ${getErrorMessage(error)}`
      );
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: getTeamsBasePath(),
      teamName: params.teamName,
      laneId: params.laneId,
      runId: params.persistedMember.runtimeRunId ?? null,
    }).catch((error: unknown) => {
      logger.warn(
        `[${params.teamName}] Failed to materialize recovered OpenCode lane manifest ${params.laneId}: ${getErrorMessage(error)}`
      );
    });

    return {
      ...runtimeEvidence,
      diagnostics,
    };
  }

  private async readLeadInboxMessagesForLaunchReconcile(
    teamName: string,
    leadName: string
  ): Promise<LeadInboxLaunchReconcileMessage[]> {
    return readLeadInboxMessagesForLaunchReconcileHelper({
      teamName,
      leadName,
      teamsBasePath: getTeamsBasePath(),
      readRegularFileUtf8: tryReadRegularFileUtf8,
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_INBOX_MAX_BYTES,
    });
  }

  private async hasBootstrapTranscriptLaunchReconcileOutcome(
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<boolean> {
    return hasBootstrapTranscriptLaunchReconcileOutcomeHelper({
      snapshot,
      expectedMembers: this.getPersistedLaunchMemberNames(snapshot),
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        this.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
    });
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

  private async readProcessBootstrapTransportSummary(input: {
    teamName: string;
    memberName: string;
    member: PersistedTeamLaunchMemberState;
  }): Promise<ProcessBootstrapTransportSummary | null> {
    return readProcessBootstrapTransportSummaryHelper({
      ...input,
      teamsBasePath: getTeamsBasePath(),
      runtimeMembers: this.readPersistedRuntimeMembers(input.teamName),
    });
  }

  private applyProcessBootstrapTransportOverlay(input: {
    member: PersistedTeamLaunchMemberState;
    summary: ProcessBootstrapTransportSummary | null;
    launchPhase: PersistedTeamLaunchPhase;
    finalTimeoutReached?: boolean;
  }): PersistedTeamLaunchMemberState {
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
      expectedMembers: snapshot ? this.getPersistedLaunchMemberNames(snapshot) : [],
      findBootstrapRuntimeProofObservedAt: (teamName, memberName, member) =>
        this.findBootstrapRuntimeProofObservedAt(teamName, memberName, member),
      findBootstrapTranscriptOutcome: (teamName, memberName, sinceMs) =>
        this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs),
      nowIso,
    });
  }

  private needsBootstrapAcceptanceReconcile(
    snapshot: PersistedTeamLaunchSnapshot | null,
    bootstrapSnapshot: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return needsBootstrapAcceptanceReconcileHelper({
      snapshot,
      bootstrapSnapshot,
      expectedMembers: snapshot ? this.getPersistedLaunchMemberNames(snapshot) : [],
    });
  }

  private needsConfirmedBootstrapDiagnosticReconcile(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return needsConfirmedBootstrapDiagnosticReconcileHelper(snapshot);
  }

  private cleanConfirmedBootstrapRuntimeDiagnostics(
    snapshot: PersistedTeamLaunchSnapshot | null
  ): PersistedTeamLaunchSnapshot | null {
    return cleanConfirmedBootstrapRuntimeDiagnosticsHelper({
      snapshot,
      expectedMembers: snapshot ? this.getPersistedLaunchMemberNames(snapshot) : [],
      nowIso,
    });
  }

  private async reconcilePersistedLaunchState(teamName: string): Promise<{
    snapshot: ReturnType<typeof createPersistedLaunchSnapshot> | null;
    statuses: Record<string, MemberSpawnStatusEntry>;
  }> {
    const bootstrapSnapshot = await readBootstrapLaunchSnapshot(teamName);
    const persisted = await this.launchStateStore.read(teamName);
    const metaMembers = await this.membersMetaStore.getMembers(teamName).catch(() => []);
    const recoveredMixedSnapshot = await this.recoverStaleMixedSecondaryLaunchSnapshot(
      teamName,
      bootstrapSnapshot,
      persisted
    );
    const filteredRecoveredMixedSnapshot = filterOptionalRemovedMembersFromLaunchSnapshot(
      recoveredMixedSnapshot,
      metaMembers
    );
    const overlaidRecoveredMixedSnapshot = filteredRecoveredMixedSnapshot
      ? await this.applyOpenCodeSecondaryEvidenceOverlay({
          teamName,
          snapshot: filteredRecoveredMixedSnapshot,
          previousSnapshot: persisted,
          metaMembers,
        })
      : null;
    const recoveredMixedSnapshotWithBootstrapStall =
      this.applyOpenCodeSecondaryBootstrapStallOverlay(overlaidRecoveredMixedSnapshot);
    const recoveredCommittedEvidenceWriteDecision = getCommittedEvidenceOverlayWriteDecision({
      snapshot: recoveredMixedSnapshotWithBootstrapStall,
      previousSnapshot: persisted,
      snapshotBeforeBootstrapStallOverlay: overlaidRecoveredMixedSnapshot,
    });
    const stableRecoveredMixedSnapshotWithCommittedEvidence =
      recoveredMixedSnapshotWithBootstrapStall &&
      recoveredCommittedEvidenceWriteDecision.shouldWrite
        ? await this.writeLaunchStateSnapshot(teamName, recoveredMixedSnapshotWithBootstrapStall)
        : recoveredMixedSnapshotWithBootstrapStall;
    const promotedRecoveredMixedSnapshot = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
      stableRecoveredMixedSnapshotWithCommittedEvidence
    );
    const cleanedRecoveredMixedSnapshot = this.cleanConfirmedBootstrapRuntimeDiagnostics(
      promotedRecoveredMixedSnapshot
    );
    const recoveredPromotionCleanupWriteDecision = getPromotionCleanupWriteDecision({
      baseSnapshot: stableRecoveredMixedSnapshotWithCommittedEvidence,
      promotedSnapshot: promotedRecoveredMixedSnapshot,
      cleanedSnapshot: cleanedRecoveredMixedSnapshot,
    });
    const stableRecoveredMixedSnapshot =
      cleanedRecoveredMixedSnapshot && recoveredPromotionCleanupWriteDecision.shouldWrite
        ? await this.writeLaunchStateSnapshot(teamName, cleanedRecoveredMixedSnapshot)
        : cleanedRecoveredMixedSnapshot;
    const filteredBootstrapSnapshot = filterOptionalRemovedMembersFromLaunchSnapshot(
      bootstrapSnapshot,
      metaMembers
    );
    const overlaidBootstrapSnapshot =
      await this.applyBootstrapTranscriptEvidenceOverlay(filteredBootstrapSnapshot);
    if (
      await shouldReturnSnapshotBeforeRuntimeReconcileFromPorts({
        snapshot: stableRecoveredMixedSnapshot,
        bootstrapSnapshot: overlaidBootstrapSnapshot,
        needsBootstrapAcceptanceReconcile: (snapshot, bootstrapSnapshot) =>
          this.needsBootstrapAcceptanceReconcile(snapshot, bootstrapSnapshot),
        needsConfirmedBootstrapDiagnosticReconcile: (snapshot) =>
          this.needsConfirmedBootstrapDiagnosticReconcile(snapshot),
        hasBootstrapTranscriptLaunchReconcileOutcome: (snapshot) =>
          this.hasBootstrapTranscriptLaunchReconcileOutcome(snapshot),
      })
    ) {
      return projectPersistedLaunchReconciliationResult(stableRecoveredMixedSnapshot);
    }
    const filteredPersistedBase =
      stableRecoveredMixedSnapshot ??
      filterOptionalRemovedMembersFromLaunchSnapshot(persisted, metaMembers);
    const filteredPersisted = filteredPersistedBase
      ? await this.applyOpenCodeSecondaryEvidenceOverlay({
          teamName,
          snapshot: filteredPersistedBase,
          previousSnapshot: persisted,
          metaMembers,
        })
      : null;
    const filteredPersistedWithBootstrapStall =
      this.applyOpenCodeSecondaryBootstrapStallOverlay(filteredPersisted);
    const committedEvidenceWriteDecision = getCommittedEvidenceOverlayWriteDecision({
      snapshot: filteredPersistedWithBootstrapStall,
      previousSnapshot: persisted,
      snapshotBeforeBootstrapStallOverlay: filteredPersisted,
    });
    const promotedPersisted = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
      filteredPersistedWithBootstrapStall
    );
    const cleanedPersisted = this.cleanConfirmedBootstrapRuntimeDiagnostics(promotedPersisted);
    const promotionCleanupWriteDecision = getPromotionCleanupWriteDecision({
      baseSnapshot: filteredPersistedWithBootstrapStall,
      promotedSnapshot: promotedPersisted,
      cleanedSnapshot: cleanedPersisted,
    });
    const persistedWriteDecision = combinePersistedLaunchSnapshotWriteDecisions(
      committedEvidenceWriteDecision,
      promotionCleanupWriteDecision
    );
    const persistedWithCommittedEvidence =
      cleanedPersisted && persistedWriteDecision.shouldWrite
        ? await this.writeLaunchStateSnapshot(teamName, cleanedPersisted)
        : cleanedPersisted;
    const preferredSnapshot = choosePreferredLaunchSnapshot(
      overlaidBootstrapSnapshot,
      persistedWithCommittedEvidence
    );
    const preferredBootstrapDecision = decidePreferredBootstrapSnapshot({
      preferredSnapshot,
      bootstrapSnapshot: overlaidBootstrapSnapshot,
      persistedSnapshot: persistedWithCommittedEvidence,
    });
    if (preferredSnapshot && preferredBootstrapDecision.kind !== 'ignore') {
      if (preferredBootstrapDecision.kind === 'clear_persisted_state') {
        await this.clearPersistedLaunchState(teamName);
        return projectPersistedLaunchReconciliationResult(preferredSnapshot);
      }
      if (preferredBootstrapDecision.kind === 'write_snapshot') {
        const writtenSnapshot = await this.writeLaunchStateSnapshot(teamName, preferredSnapshot);
        return projectPersistedLaunchReconciliationResult(writtenSnapshot);
      }
      return projectPersistedLaunchReconciliationResult(preferredSnapshot);
    }
    if (!persistedWithCommittedEvidence) {
      return projectEmptyPersistedLaunchReconciliationResult();
    }

    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    let configMembers = new Set<string>();
    let configBootstrapRunIds = new Map<string, string>();
    let leadName = 'team-lead';
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (raw) {
        const config = JSON.parse(raw) as {
          members?: { name?: string; agentType?: string; bootstrapRunId?: string }[];
        };
        const configuredMembers = config.members ?? [];
        leadName =
          configuredMembers.find((member) => isLeadMember(member))?.name?.trim() || leadName;
        configMembers = new Set(
          configuredMembers
            .map((member) => (typeof member?.name === 'string' ? member.name.trim() : ''))
            .filter((name) => name.length > 0 && !isLeadMember({ name }))
        );
        configBootstrapRunIds = new Map(
          configuredMembers.flatMap((member) => {
            const name = typeof member?.name === 'string' ? member.name.trim() : '';
            const runId =
              typeof member?.bootstrapRunId === 'string' ? member.bootstrapRunId.trim() : '';
            return name.length > 0 && runId.length > 0 && !isLeadMember({ name })
              ? [[name, runId] as const]
              : [];
          })
        );
      }
    } catch {
      // best-effort
    }

    const leadInboxMessages = await this.readLeadInboxMessagesForLaunchReconcile(
      teamName,
      leadName
    );

    if (
      await shouldReturnSnapshotBeforeRuntimeReconcileFromPorts({
        snapshot: persistedWithCommittedEvidence,
        bootstrapSnapshot: overlaidBootstrapSnapshot,
        requireMixedLaunchMetadata: true,
        hasLeadInboxLaunchReconcileHeartbeat: this.hasLeadInboxLaunchReconcileHeartbeat(
          persistedWithCommittedEvidence,
          leadInboxMessages
        ),
        needsBootstrapAcceptanceReconcile: (snapshot, bootstrapSnapshot) =>
          this.needsBootstrapAcceptanceReconcile(snapshot, bootstrapSnapshot),
        needsConfirmedBootstrapDiagnosticReconcile: (snapshot) =>
          this.needsConfirmedBootstrapDiagnosticReconcile(snapshot),
        hasBootstrapTranscriptLaunchReconcileOutcome: (snapshot) =>
          this.hasBootstrapTranscriptLaunchReconcileOutcome(snapshot),
      })
    ) {
      return projectPersistedLaunchReconciliationResult(persistedWithCommittedEvidence);
    }

    const liveRuntimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName);
    const nextMembers = { ...persistedWithCommittedEvidence.members };
    const persistedMemberNames = this.getPersistedLaunchMemberNames(persistedWithCommittedEvidence);
    const now = nowIso();
    for (const expected of persistedMemberNames) {
      const bootstrapMember = bootstrapSnapshot?.members[expected];
      let current = nextMembers[expected] ?? {
        name: expected,
        launchState: 'starting',
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
        lastEvaluatedAt: now,
      };
      const isOpenCodeSecondaryLaneMember = isPersistedOpenCodeSecondaryLaneMember(current);
      const matchedConfigNames = [...configMembers].filter((name) =>
        matchesObservedMemberNameForExpected(name, expected)
      );
      const configBootstrapRunId = matchedConfigNames
        .map((name) => configBootstrapRunIds.get(name))
        .find((runId): runId is string => typeof runId === 'string' && runId.length > 0);
      const currentBootstrapEvidenceBoundary = configBootstrapRunId
        ? { ...current, runtimeRunId: configBootstrapRunId }
        : current;
      if (
        bootstrapMember?.agentToolAccepted &&
        !current.agentToolAccepted &&
        isBootstrapMemberEvidenceCurrentForMember(
          currentBootstrapEvidenceBoundary,
          bootstrapMember,
          'acceptance'
        )
      ) {
        current.agentToolAccepted = true;
        current.firstSpawnAcceptedAt =
          current.firstSpawnAcceptedAt ?? bootstrapMember.firstSpawnAcceptedAt;
      }
      if (
        bootstrapMember?.bootstrapConfirmed &&
        !current.bootstrapConfirmed &&
        !isOpenCodeSecondaryLaneMember &&
        isBootstrapMemberEvidenceCurrentForMember(
          currentBootstrapEvidenceBoundary,
          bootstrapMember,
          'confirmation'
        )
      ) {
        current.bootstrapConfirmed = true;
        current.lastHeartbeatAt = current.lastHeartbeatAt ?? bootstrapMember.lastHeartbeatAt;
      }
      const runtimeMetadataCandidates = [...liveRuntimeByMember.entries()].filter(([name]) =>
        matchesObservedMemberNameForExpected(name, expected)
      );
      const runtimeMetadata =
        runtimeMetadataCandidates.find(([, metadata]) => metadata.alive) ??
        runtimeMetadataCandidates[0];
      const observedRuntimeAlive = runtimeMetadata?.[1].alive === true;
      const heartbeatMessage = this.selectLatestLeadInboxLaunchReconcileMessage(
        leadInboxMessages,
        persistedMemberNames,
        expected,
        current.firstSpawnAcceptedAt
      );
      const heartbeatReason = heartbeatMessage
        ? extractBootstrapFailureReason(heartbeatMessage.text)
        : null;
      const bootstrapFailureReason =
        bootstrapMember?.hardFailure === true &&
        !bootstrapMember.bootstrapConfirmed &&
        isBootstrapMemberEvidenceCurrentForMember(
          currentBootstrapEvidenceBoundary,
          bootstrapMember,
          'confirmation'
        )
          ? (bootstrapMember.hardFailureReason ?? bootstrapMember.runtimeDiagnostic)
          : null;
      const acceptedAtMs =
        current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const initialFailureReason = current.hardFailureReason ?? current.runtimeDiagnostic;
      const hasBootstrapCheckInTimeoutFailure =
        isBootstrapCheckInTimeoutFailureReason(initialFailureReason);
      const hadAutoClearableFailure = isAutoClearableLaunchFailureReason(initialFailureReason);
      const requiresConfirmedBootstrapToClearFailure =
        isCliProvisionedButNotAliveFailureReason(initialFailureReason);
      const metadataRuntimeDiagnostic = runtimeMetadata?.[1].runtimeDiagnostic;
      const metadataRuntimeDiagnosticSeverity = runtimeMetadata?.[1].runtimeDiagnosticSeverity;
      const metadataLivenessKind = runtimeMetadata?.[1].livenessKind;
      const refreshedRuntimeDiagnosticEvidence =
        metadataRuntimeDiagnostic &&
        current.runtimeDiagnostic &&
        metadataRuntimeDiagnostic !== current.runtimeDiagnostic
          ? `${metadataRuntimeDiagnostic}; ${current.runtimeDiagnostic}`
          : (metadataRuntimeDiagnostic ?? current.runtimeDiagnostic);
      const hasUnsafeProvisionedButNotAliveFailure =
        requiresConfirmedBootstrapToClearFailure &&
        hasUnsafeProvisionedButNotAliveRuntimeEvidence({
          ...current,
          runtimeDiagnostic: refreshedRuntimeDiagnosticEvidence,
          runtimeDiagnosticSeverity:
            metadataRuntimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity,
          livenessKind: metadataLivenessKind ?? current.livenessKind,
        });
      const shouldPreserveUnsafeMetadataLivenessKind =
        hasUnsafeProvisionedButNotAliveFailure &&
        (metadataLivenessKind === 'not_found' ||
          metadataLivenessKind === 'shell_only' ||
          metadataLivenessKind === 'runtime_process_candidate' ||
          ((metadataLivenessKind === 'registered_only' ||
            metadataLivenessKind === 'stale_metadata') &&
            (metadataRuntimeDiagnosticSeverity ?? current.runtimeDiagnosticSeverity) !== 'error' &&
            !mentionsProcessTableUnavailable(refreshedRuntimeDiagnosticEvidence) &&
            !mentionsProcessTableUnavailable(initialFailureReason)));
      const nextLivenessKind = current.bootstrapConfirmed
        ? metadataLivenessKind === 'runtime_process' ||
          metadataLivenessKind === 'confirmed_bootstrap' ||
          shouldPreserveUnsafeMetadataLivenessKind
          ? metadataLivenessKind
          : current.livenessKind === 'stale_metadata' || current.livenessKind === 'registered_only'
            ? 'confirmed_bootstrap'
            : (current.livenessKind ?? 'confirmed_bootstrap')
        : (metadataLivenessKind ?? current.livenessKind);
      current.runtimeAlive = observedRuntimeAlive;
      current.lastRuntimeAliveAt = observedRuntimeAlive ? now : current.lastRuntimeAliveAt;
      current.livenessKind = nextLivenessKind;
      current.pidSource = runtimeMetadata?.[1].pidSource;
      const shouldKeepUnsafeRuntimeDiagnostic =
        hasUnsafeProvisionedButNotAliveFailure &&
        (metadataRuntimeDiagnostic == null ||
          (current.runtimeDiagnosticSeverity === 'error' &&
            metadataRuntimeDiagnosticSeverity !== 'error'));
      current.runtimeDiagnostic = shouldKeepUnsafeRuntimeDiagnostic
        ? current.runtimeDiagnostic
        : metadataRuntimeDiagnostic;
      current.runtimeDiagnosticSeverity = shouldKeepUnsafeRuntimeDiagnostic
        ? current.runtimeDiagnosticSeverity
        : metadataRuntimeDiagnosticSeverity;
      current.sources = {
        ...(current.sources ?? {}),
        processAlive: observedRuntimeAlive || undefined,
        configRegistered: matchedConfigNames.length > 0 || undefined,
        configDrift:
          heartbeatMessage != null && matchedConfigNames.length === 0
            ? true
            : current.sources?.configDrift,
        inboxHeartbeat: heartbeatMessage != null ? true : current.sources?.inboxHeartbeat,
      };
      const bootstrapProvesSpawnAcceptance =
        bootstrapMember?.agentToolAccepted === true ||
        typeof bootstrapMember?.firstSpawnAcceptedAt === 'string';
      const currentProvesSpawnAcceptance =
        current.agentToolAccepted === true || typeof current.firstSpawnAcceptedAt === 'string';
      if (
        !bootstrapFailureReason &&
        !hasBootstrapCheckInTimeoutFailure &&
        hadAutoClearableFailure &&
        !requiresConfirmedBootstrapToClearFailure &&
        (bootstrapProvesSpawnAcceptance || currentProvesSpawnAcceptance)
      ) {
        current.hardFailure = false;
        current.hardFailureReason = undefined;
        if (current.sources) {
          current.sources.hardFailureSignal = undefined;
        }
      }
      if (
        current.bootstrapConfirmed &&
        !isOpenCodeSecondaryLaneMember &&
        !hasUnsafeProvisionedButNotAliveFailure &&
        isBootstrapProofClearableLaunchFailureReason(current.hardFailureReason)
      ) {
        if (isProvisionedButNotAliveFailureReason(current.hardFailureReason)) {
          current.runtimeAlive = true;
        }
        current.hardFailure = false;
        current.hardFailureReason = undefined;
        if (current.sources) {
          current.sources.hardFailureSignal = undefined;
        }
      }
      if (heartbeatReason) {
        current.hardFailure = true;
        current.hardFailureReason = heartbeatReason;
        current.runtimeDiagnostic = heartbeatReason;
        current.runtimeDiagnosticSeverity = 'error';
        current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [heartbeatReason]);
        current.sources.hardFailureSignal = true;
      } else if (bootstrapFailureReason) {
        current.hardFailure = true;
        current.hardFailureReason = bootstrapFailureReason;
        current.runtimeDiagnostic = bootstrapFailureReason;
        current.runtimeDiagnosticSeverity = 'error';
        current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [
          bootstrapFailureReason,
        ]);
        current.sources.hardFailureSignal = true;
      } else if (heartbeatMessage && !isOpenCodeSecondaryLaneMember) {
        current.bootstrapConfirmed = true;
        current.lastHeartbeatAt = heartbeatMessage.timestamp;
        current.hardFailure = false;
        current.hardFailureReason = undefined;
      }
      const canApplyBootstrapSuccess =
        !heartbeatReason &&
        !hasUnsafeProvisionedButNotAliveFailure &&
        (current.launchState !== 'failed_to_start' ||
          hadAutoClearableFailure ||
          isBootstrapProofClearableLaunchFailureReason(
            current.hardFailureReason ?? current.runtimeDiagnostic
          ));
      if (!current.bootstrapConfirmed && canApplyBootstrapSuccess) {
        const runtimeProofObservedAt = !isOpenCodeSecondaryLaneMember
          ? await this.findBootstrapRuntimeProofObservedAt(teamName, expected, current)
          : null;
        const transcriptOutcome = runtimeProofObservedAt
          ? null
          : await this.findBootstrapTranscriptOutcome(
              teamName,
              expected,
              Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
            );
        const bootstrapObservedAt =
          runtimeProofObservedAt ??
          (transcriptOutcome?.kind === 'success' ? transcriptOutcome.observedAt : null);
        if (bootstrapObservedAt && !isOpenCodeSecondaryLaneMember) {
          current.bootstrapConfirmed = true;
          current.lastHeartbeatAt = current.lastHeartbeatAt ?? bootstrapObservedAt;
          current.runtimeAlive = runtimeProofObservedAt
            ? true
            : current.runtimeAlive === true || requiresConfirmedBootstrapToClearFailure;
          current.lastRuntimeAliveAt = runtimeProofObservedAt
            ? (current.lastRuntimeAliveAt ?? bootstrapObservedAt)
            : current.lastRuntimeAliveAt;
          current.hardFailure = false;
          current.hardFailureReason = undefined;
          if (current.sources) {
            current.sources.hardFailureSignal = undefined;
          }
        } else if (transcriptOutcome?.kind === 'failure' && !current.hardFailure) {
          current.hardFailure = true;
          current.hardFailureReason = transcriptOutcome.reason;
          current.sources.hardFailureSignal = true;
        }
      }
      const graceExpired =
        Number.isFinite(acceptedAtMs) && Date.now() - acceptedAtMs >= MEMBER_LAUNCH_GRACE_MS;
      if (!isOpenCodeSecondaryLaneMember) {
        current = this.applyProcessBootstrapTransportOverlay({
          member: current,
          summary: await this.readProcessBootstrapTransportSummary({
            teamName,
            memberName: expected,
            member: current,
          }),
          launchPhase: persistedWithCommittedEvidence.launchPhase,
          finalTimeoutReached: graceExpired,
        });
      }
      if (current.bootstrapConfirmed && !current.hardFailure && !isOpenCodeSecondaryLaneMember) {
        current.livenessKind =
          current.livenessKind === 'stale_metadata' ||
          current.livenessKind === 'registered_only' ||
          current.livenessKind == null
            ? 'confirmed_bootstrap'
            : current.livenessKind;
        current.pidSource =
          current.pidSource === 'persisted_metadata' || current.pidSource == null
            ? 'runtime_bootstrap'
            : current.pidSource;
        if (shouldClearRuntimeDiagnosticAfterBootstrapConfirmation(current.runtimeDiagnostic)) {
          current.runtimeDiagnostic = undefined;
          current.runtimeDiagnosticSeverity = undefined;
        } else if (!current.runtimeDiagnostic) {
          current.runtimeDiagnosticSeverity = undefined;
        }
        current.bootstrapStalled = undefined;
      }
      if (
        isOpenCodeSecondaryLaneMember &&
        shouldMarkPersistedOpenCodeBootstrapStalled(current, Date.now())
      ) {
        const runtimeDiagnostic =
          getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted(current);
        current.launchState = 'runtime_pending_bootstrap';
        current.agentToolAccepted = true;
        current.runtimeAlive =
          current.runtimeAlive === true && current.livenessKind === 'runtime_process';
        current.bootstrapConfirmed = false;
        current.hardFailure = false;
        current.hardFailureReason = undefined;
        current.livenessKind = current.livenessKind ?? 'registered_only';
        current.runtimeDiagnostic = runtimeDiagnostic;
        current.runtimeDiagnosticSeverity = 'warning';
        current.bootstrapStalled = true;
        current.diagnostics = mergeRuntimeDiagnostics(current.diagnostics, [
          runtimeDiagnostic,
          'opencode_bootstrap_stalled',
        ]);
      }
      if (
        current.agentToolAccepted === true &&
        !current.bootstrapConfirmed &&
        !current.runtimeAlive &&
        !current.hardFailure &&
        current.bootstrapStalled !== true &&
        graceExpired
      ) {
        current.hardFailure = true;
        current.hardFailureReason =
          current.hardFailureReason ?? 'Teammate did not join within the launch grace window.';
      }
      current.launchState = deriveMemberLaunchState(current);
      current.lastEvaluatedAt = now;
      nextMembers[expected] = {
        ...current,
        diagnostics: undefined,
      };
    }

    const reconciled = createPersistedLaunchSnapshot({
      teamName,
      expectedMembers: persistedMemberNames,
      leadSessionId: persistedWithCommittedEvidence.leadSessionId,
      launchPhase: persistedWithCommittedEvidence.launchPhase,
      members: nextMembers,
      updatedAt: now,
    });

    const finalSnapshotDecision = decideFinalReconciledSnapshotWrite(reconciled);
    if (finalSnapshotDecision.kind === 'clear_persisted_state') {
      await this.clearPersistedLaunchState(teamName);
      return projectEmptyPersistedLaunchReconciliationResult();
    }

    const writtenSnapshot = await this.writeLaunchStateSnapshot(teamName, reconciled);
    return projectPersistedLaunchReconciliationResult(writtenSnapshot);
  }

  private async findBootstrapTranscriptFailureReason(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<string | null> {
    const outcome = await this.findBootstrapTranscriptOutcome(teamName, memberName, sinceMs);
    return outcome?.kind === 'failure' ? outcome.reason : null;
  }

  private async findBootstrapTranscriptOutcome(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome | null> {
    return findBootstrapTranscriptOutcomeHelper({
      teamName,
      memberName,
      sinceMs,
      lookupCache: this.bootstrapTranscriptOutcomeLookupCache,
      lookupCacheEnabled:
        !this.runTracking.getTrackedRunId(teamName) && !this.runtimeAdapterRunByTeam.has(teamName),
      findMemberLogs: (lookupTeamName, lookupMemberName, lookupSinceMs) =>
        this.memberLogsFinder.findMemberLogs(lookupTeamName, lookupMemberName, lookupSinceMs),
      readRecentBootstrapTranscriptOutcome: (
        filePath,
        lookupSinceMs,
        lookupMemberName,
        lookupTeamName,
        options
      ) =>
        this.readRecentBootstrapTranscriptOutcome(
          filePath,
          lookupSinceMs,
          lookupMemberName,
          lookupTeamName,
          options
        ),
      readBootstrapTranscriptOutcomesInProjectRoot: (
        lookupTeamName,
        lookupMemberName,
        lookupSinceMs
      ) =>
        this.readBootstrapTranscriptOutcomesInProjectRoot(
          lookupTeamName,
          lookupMemberName,
          lookupSinceMs
        ),
      maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
      lookupCacheTtlMs: PERSISTED_BOOTSTRAP_TRANSCRIPT_OUTCOME_LOOKUP_CACHE_TTL_MS,
    });
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
    return readRecentBootstrapTranscriptOutcomeHelper({
      filePath,
      sinceMs,
      memberName,
      teamName,
      options,
      outcomeCache: this.bootstrapTranscriptOutcomeCache,
      getParsedBootstrapTranscriptTail: (transcriptPath, stat) =>
        this.getParsedBootstrapTranscriptTail(transcriptPath, stat),
      nowIso,
      maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
    });
  }

  private async getParsedBootstrapTranscriptTail(
    filePath: string,
    stat: { mtimeMs: number; size: number }
  ): Promise<ParsedBootstrapTranscriptTailLine[]> {
    return getParsedBootstrapTranscriptTailHelper({
      filePath,
      stat,
      cache: this.parsedBootstrapTranscriptTailCache,
      tailBytes: BOOTSTRAP_FAILURE_TAIL_BYTES,
      maxCacheEntries: BOOTSTRAP_TRANSCRIPT_OUTCOME_CACHE_MAX_ENTRIES,
    });
  }

  private async readBootstrapTranscriptOutcomesInProjectRoot(
    teamName: string,
    memberName: string,
    sinceMs: number | null
  ): Promise<BootstrapTranscriptOutcome[]> {
    return readBootstrapTranscriptOutcomesInProjectRootHelper({
      teamName,
      memberName,
      sinceMs,
      readConfigSnapshot: (lookupTeamName) => this.readConfigSnapshot(lookupTeamName),
      readMetaMembers: (lookupTeamName) => this.membersMetaStore.getMembers(lookupTeamName),
      readRecentBootstrapTranscriptOutcome: (
        filePath,
        lookupSinceMs,
        lookupMemberName,
        lookupTeamName,
        options
      ) =>
        this.readRecentBootstrapTranscriptOutcome(
          filePath,
          lookupSinceMs,
          lookupMemberName,
          lookupTeamName,
          options
        ),
      mtimeSlackMs: BOOTSTRAP_TRANSCRIPT_MTIME_SLACK_MS,
    });
  }

  private captureSendMessages(run: ProvisioningRun, content: Record<string, unknown>[]): void {
    captureLeadSendMessages(run, content, {
      nowIso,
      nowMs: () => Date.now(),
      logger,
      crossTeamSender: this.crossTeamSender,
      resolveCrossTeamReplyMetadata: (teamName, toTeam) =>
        this.resolveCrossTeamReplyMetadata(teamName, toTeam),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      pushLiveLeadProcessMessage: (teamName, message) =>
        this.pushLiveLeadProcessMessage(teamName, message),
      persistSentMessage: (teamName, message) => this.persistSentMessage(teamName, message),
      persistInboxMessage: (teamName, recipient, message) =>
        this.persistInboxMessage(teamName, recipient, message),
      emitLeadMessageChange: (teamName, runId, detail) =>
        this.teamChangeEmitter?.({ type: 'lead-message', teamName, runId, detail }),
      emitInboxChange: (teamName, detail) =>
        this.teamChangeEmitter?.({ type: 'inbox', teamName, detail }),
    });
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    pushLiveLeadProcessMessageHelper(teamName, message, {
      liveLeadProcessMessages: this.liveLeadProcessMessages,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      cacheLimit: LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT,
    });
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    const runId = this.runTracking.getAliveRunId(teamName);
    if (!runId) return null;
    const run = this.runs.get(runId);
    const hints = run?.activeCrossTeamReplyHints ?? [];
    if (hints.length === 0) return null;

    const matches = hints.filter((hint) => hint.toTeam === toTeam);
    if (matches.length !== 1) return null;

    return {
      conversationId: matches[0].conversationId,
      replyToConversationId: matches[0].conversationId,
    };
  }

  /**
   * Create an InboxMessage from assistant text and push it into the live cache.
   * Used for both pre-ready (provisioning) and post-ready assistant text.
   * Emits a coalesced `lead-message` event for renderer refresh.
   */
  private joinLeadRelayCaptureText(
    capture: NonNullable<ProvisioningRun['leadRelayCapture']>
  ): string {
    return joinLeadRelayCaptureText(capture);
  }

  private resetLiveLeadTextBuffer(run: ProvisioningRun): void {
    resetLiveLeadTextBufferHelper(run);
  }

  private appendProvisioningAssistantText(
    run: ProvisioningRun,
    msg: Record<string, unknown>,
    text: string
  ): void {
    appendProvisioningAssistantTextHelper(run, msg, text);
  }

  private shiftProvisioningOutputIndexesAfterRemoval(
    run: ProvisioningRun,
    removedIndex: number
  ): void {
    shiftProvisioningOutputIndexesAfterRemovalHelper(run, removedIndex);
  }

  private pushLiveLeadTextMessage(
    run: ProvisioningRun,
    cleanText: string,
    stableMessageId?: string,
    messageTimestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void {
    pushLiveLeadTextMessageHelper(run, cleanText, stableMessageId, messageTimestamp, options, {
      nowMs: () => Date.now(),
      nowIso,
      getRunLeadName: (run) => this.getRunLeadName(run),
      pushLiveLeadProcessMessage: (teamName, message) =>
        this.pushLiveLeadProcessMessage(teamName, message),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      leadTextEmitThrottleMs: TeamProvisioningService.LEAD_TEXT_EMIT_THROTTLE_MS,
    });
  }

  /**
   * Stop the running process for a team. No-op if team is not running.
   * Always uses SIGKILL via killTeamProcess() to prevent CLI cleanup.
   */
  async stopTeam(teamName: string): Promise<void> {
    await stopTeamFlow(teamName, {
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      pauseActiveIntervalsForTeam: (teamName) =>
        this.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
      stopPersistentTeamMembers: (teamName) => this.stopPersistentTeamMembers(teamName),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getAliveRunId: (teamName) => this.runTracking.getAliveRunId(teamName),
      runs: this.runs,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      isCancellableRuntimeAdapterProgress: (progress) =>
        this.isCancellableRuntimeAdapterProgress(progress),
      cancelRuntimeAdapterProvisioning: (runId, progress) =>
        this.cancelRuntimeAdapterProvisioning(runId, progress),
      cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
        this.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      withTeamLock: (teamName, fn) => this.withTeamLock(teamName, fn),
      stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
        this.stopOpenCodeRuntimeAdapterTeam(teamName, runId),
      hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
      stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
      provisioningRunByTeam: this.provisioningRunByTeam,
      deleteAliveRunId: (teamName) => this.runTracking.deleteAliveRunId(teamName),
      killTeamProcess,
      updateProgress,
      cleanupRun: (run) => this.cleanupRun(run),
      logger,
    });
  }

  private async stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void> {
    await stopMixedSecondaryRuntimeLanesHelper(teamName, this.createOpenCodeRuntimeStopFlowPorts());
  }

  private async stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void> {
    await stopOpenCodeRuntimeAdapterTeamHelper(
      teamName,
      runId,
      this.createOpenCodeRuntimeStopFlowPorts()
    );
  }

  private createOpenCodeRuntimeStopFlowPorts() {
    return {
      teamsBasePath: getTeamsBasePath(),
      getSecondaryRuntimeRuns: (teamName: string) => this.getSecondaryRuntimeRuns(teamName),
      stoppingSecondaryRuntimeTeams: this.stoppingSecondaryRuntimeTeams,
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      readLaunchState: (teamName: string) => this.launchStateStore.read(teamName),
      writeLaunchStateSnapshot: (teamName: string, snapshot: PersistedTeamLaunchSnapshot) =>
        this.writeLaunchStateSnapshot(teamName, snapshot),
      readPersistedTeamProjectPath: (teamName: string) =>
        this.readPersistedTeamProjectPath(teamName),
      clearOpenCodeRuntimeLaneStorage,
      deleteSecondaryRuntimeRun: (teamName: string, laneId: string) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      clearSecondaryRuntimeRuns: (teamName: string) => this.clearSecondaryRuntimeRuns(teamName),
      runtimeAdapterRunByTeam: this.runtimeAdapterRunByTeam,
      runtimeAdapterProgressByRunId: this.runtimeAdapterProgressByRunId,
      setRuntimeAdapterProgress: (progress: TeamProvisioningProgress) =>
        this.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress),
      clearOpenCodeRuntimeToolApprovals: (
        teamName: string,
        options: { runId?: string; laneId?: string; emitDismiss?: boolean }
      ) => this.clearOpenCodeRuntimeToolApprovals(teamName, options),
      deleteAliveRunId: (teamName: string) => this.runTracking.deleteAliveRunId(teamName),
      provisioningRunByTeam: this.provisioningRunByTeam,
      invalidateRuntimeSnapshotCaches: (teamName: string) =>
        this.invalidateRuntimeSnapshotCaches(teamName),
      emitTeamChange: (event: TeamChangeEvent) => this.teamChangeEmitter?.(event),
      logger,
      nowIso,
    };
  }

  private stopPersistentTeamMembers(teamName: string): void {
    stopPersistentTeamMembersFlow(teamName, {
      readPersistedRuntimeMembers: (teamName) => this.readPersistedRuntimeMembers(teamName),
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

  private readPersistedTeamProjectPath(teamName: string): string | null {
    return readPersistedTeamProjectPathHelper(teamName, {
      teamsBasePath: getTeamsBasePath(),
      cache: this.persistedTeamConfigCache,
    });
  }

  private readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[] {
    return readPersistedRuntimeMembersHelper(teamName, {
      teamsBasePath: getTeamsBasePath(),
      cache: this.persistedTeamConfigCache,
    });
  }

  private listPersistedTeamNames(): string[] {
    return listPersistedTeamNamesHelper(getTeamsBasePath());
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
      listPersistedTeamNames: () => this.listPersistedTeamNames(),
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
    return {
      updateProgress,
      extractCliLogsFromRun,
      buildProvisioningLiveOutput,
      boundRunProvisioningOutputParts,
      boundProgressAssistantParts,
      appendProvisioningTrace,
      resetLiveLeadTextBuffer: (run) => this.resetLiveLeadTextBuffer(run),
      handleTeammatePermissionRequest: (run, permissionRequest, timestamp) =>
        this.handleTeammatePermissionRequest(run, permissionRequest, timestamp),
      finishRuntimeToolActivity: (run, toolUseId, resultContent, isError) =>
        this.finishRuntimeToolActivity(run, toolUseId, resultContent, isError),
      handleNativeTeammateUserMessage: (run, msg) => this.handleNativeTeammateUserMessage(run, msg),
      handleAuthFailureInOutput: (run, text, source) =>
        this.handleAuthFailureInOutput(run, text, source),
      hasApiError,
      isAuthFailureWarning,
      failProvisioningWithApiError: (run, text) => this.failProvisioningWithApiError(run, text),
      appendProvisioningAssistantText: (run, msg, text) =>
        this.appendProvisioningAssistantText(run, msg, text),
      pushLiveLeadTextMessage: (run, text, messageId, timestamp, options) =>
        this.pushLiveLeadTextMessage(run, text, messageId, timestamp, options),
      startRuntimeToolActivity: (run, memberName, block) =>
        this.startRuntimeToolActivity(run, memberName, block),
      getRunLeadName: (run) => this.getRunLeadName(run),
      captureTeamSpawnEvents: (run, content) => this.captureTeamSpawnEvents(run, content),
      captureSendMessages: (run, content) => this.captureSendMessages(run, content),
      updateLeadContextUsageFromUsage: (run, usage, modelName) =>
        updateLeadContextUsageFromUsageForRun(run, usage, modelName),
      emitLeadContextUsage: (run) => this.emitLeadContextUsage(run),
      resetRuntimeToolActivity: (run, memberName) => this.resetRuntimeToolActivity(run, memberName),
      setLeadActivity: (run, state) => this.setLeadActivity(run, state),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      pushLiveLeadProcessMessage: (teamName, message) =>
        this.pushLiveLeadProcessMessage(teamName, message),
      injectPostCompactReminder: (run) => this.injectPostCompactReminder(run),
      injectGeminiPostLaunchHydration: (run) => this.injectGeminiPostLaunchHydration(run),
      completeProvisioningFromSuccessfulResult: (run) =>
        this.completeProvisioningFromSuccessfulResult(run),
      handleControlRequest: (run, msg) => this.handleControlRequest(run, msg),
      handleProvisioningTurnComplete: (run) => this.handleProvisioningTurnComplete(run),
      cleanupRun: (run) => this.cleanupRun(run),
      killTeamProcess,
      normalizeApiRetryErrorMessage,
      isQuotaRetryMessage,
      toMarkdownCodeSafe,
      emitApiErrorWarning: (run, text) => this.emitApiErrorWarning(run, text),
      setMemberSpawnStatus: (run, memberName, status, error) =>
        this.setMemberSpawnStatus(run, memberName, status, error),
      appendMemberBootstrapDiagnostic: (run, memberName, detail) =>
        this.appendMemberBootstrapDiagnostic(run, memberName, detail),
      reevaluateMemberLaunchStatus: (run, memberName) =>
        this.reevaluateMemberLaunchStatus(run, memberName),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      markUnconfirmedBootstrapMembersFailed: (run, reason, options) =>
        this.markUnconfirmedBootstrapMembersFailed(run, reason, options),
      stopPersistentTeamMembers: (teamName) => this.stopPersistentTeamMembers(teamName),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
    };
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
    await injectPostCompactReminderHelper(run, {
      logger,
      readConfigForObservation: (teamName) => this.readConfigForObservation(teamName),
      readTasks: (teamName) => new TeamTaskReader().getTasks(teamName),
      isLeadMember,
      buildPersistentLeadContext,
      buildTaskBoardSnapshot,
      buildGeminiPostLaunchHydrationPrompt,
      getPromptSizeSummary,
      writeLeadStdin: (targetRun, payload) =>
        new Promise<void>((resolve, reject) => {
          targetRun.child!.stdin!.write(payload + '\n', (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
      setLeadActivity: (targetRun, state) => this.setLeadActivity(targetRun, state),
      resetRuntimeToolActivity: (targetRun, memberName) =>
        this.resetRuntimeToolActivity(targetRun, memberName),
      getRunLeadName: (targetRun) => this.getRunLeadName(targetRun),
    });
  }

  private async injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    await injectGeminiPostLaunchHydrationHelper(run, {
      logger,
      readConfigForObservation: (teamName) => this.readConfigForObservation(teamName),
      readTasks: (teamName) => new TeamTaskReader().getTasks(teamName),
      isLeadMember,
      buildPersistentLeadContext,
      buildTaskBoardSnapshot,
      buildGeminiPostLaunchHydrationPrompt,
      getPromptSizeSummary,
      writeLeadStdin: (targetRun, payload) =>
        new Promise<void>((resolve, reject) => {
          targetRun.child!.stdin!.write(payload + '\n', (err) => {
            if (err) reject(err);
            else resolve();
          });
        }),
      setLeadActivity: (targetRun, state) => this.setLeadActivity(targetRun, state),
      resetRuntimeToolActivity: (targetRun, memberName) =>
        this.resetRuntimeToolActivity(targetRun, memberName),
      getRunLeadName: (targetRun) => this.getRunLeadName(targetRun),
    });
  }

  /**
   * Handles a control_request message from CLI stream-json output.
   * `can_use_tool` → emits to renderer for manual approval.
   * All other subtypes (hook_callback, etc.) → auto-allowed to prevent deadlock.
   */
  private handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    handleLeadControlRequest(run, msg, this.getLeadToolApprovalPorts());
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
    handleTeammatePermissionRequestHelper(
      run,
      perm,
      messageTimestamp,
      this.getTeammatePermissionRequestPorts()
    );
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
    const entries = openCodeRuntimeApprovalProvider.collectPendingApprovals(input);
    this.runtimeToolApprovalCoordinator.sync(
      {
        teamName: input.teamName,
        runId: input.runId,
        laneId: input.laneId,
        memberNames: input.memberNames,
        providerId: 'opencode',
      },
      entries
    );
  }

  /**
   * Shows a native OS notification for a pending tool approval when the app
   * is not in focus. On macOS, adds Allow/Deny action buttons that respond
   * directly from the notification without switching to the app.
   */
  private maybeShowToolApprovalOsNotification(
    run: ProvisioningRun | undefined,
    approval: ToolApprovalRequest
  ): void {
    this.toolApprovalOsNotifications.maybeShow(run, approval);
  }

  /** Dismiss the OS notification for a resolved/dismissed approval. */
  dismissApprovalNotification(requestId: string): void {
    const notification = this.activeApprovalNotifications.get(requestId);
    if (notification) {
      notification.close();
      this.activeApprovalNotifications.delete(requestId);
    }
  }

  private clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean } = {}
  ): void {
    this.runtimeToolApprovalCoordinator.clear(teamName, {
      ...options,
      providerId: 'opencode',
    });
  }

  /**
   * Immediately sends an "allow" control_response for a non-tool control_request.
   * Prevents CLI deadlock for hook_callback and other non-`can_use_tool` subtypes.
   */
  private autoAllowControlRequest(run: ProvisioningRun, requestId: string): void {
    autoAllowLeadControlRequest(run, requestId, this.getLeadToolApprovalPorts());
  }

  private tryClaimResponse(requestId: string): boolean {
    return this.toolApprovalTimeouts.tryClaimResponse(requestId);
  }

  private startApprovalTimeout(run: ProvisioningRun, requestId: string): void {
    this.toolApprovalTimeouts.start(run, requestId);
  }

  private clearApprovalTimeout(requestId: string): void {
    this.toolApprovalTimeouts.clear(requestId);
  }

  private getLeadToolApprovalPorts(): TeamProvisioningLeadToolApprovalPorts<ProvisioningRun> {
    return createDefaultLeadToolApprovalPorts<ProvisioningRun>({
      logger,
      getSettings: (teamName) => this.getToolApprovalSettings(teamName),
      emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
      startApprovalTimeout: (run, requestId) => this.startApprovalTimeout(run, requestId),
      maybeShowToolApprovalOsNotification: (run, approval) =>
        this.maybeShowToolApprovalOsNotification(run, approval),
    });
  }

  private getLeadToolApprovalResponsePorts(): TeamProvisioningLeadToolApprovalResponsePorts<ProvisioningRun> {
    return {
      logger,
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      clearApprovalTimeout: (requestId) => this.clearApprovalTimeout(requestId),
      tryClaimResponse: (requestId) => this.tryClaimResponse(requestId),
      inFlightResponses: this.inFlightResponses,
      startApprovalTimeout: (run, requestId) => this.startApprovalTimeout(run, requestId),
      dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
      buildLeadToolApprovalDecisionPayload,
    };
  }

  private getTeammatePermissionRequestPorts(): TeamProvisioningTeammatePermissionRequestPorts<ProvisioningRun> {
    return {
      logger,
      getSettings: (teamName) => this.getToolApprovalSettings(teamName),
      shouldAutoAllow,
      buildTeammateToolApprovalRequest,
      respondToTeammatePermission: (input) =>
        respondToTeammatePermissionHelper(input, this.getTeammatePermissionResponsePorts()),
      buildToolApprovalAutoResolvedEvent,
      emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
      startApprovalTimeout: (run, requestId) => this.startApprovalTimeout(run, requestId),
      maybeShowToolApprovalOsNotification: (run, approval) =>
        this.maybeShowToolApprovalOsNotification(run, approval),
    };
  }

  private autoDenyControlRequest(run: ProvisioningRun, requestId: string): void {
    autoDenyLeadControlRequest(run, requestId, this.getLeadToolApprovalPorts());
  }

  private reEvaluatePendingApprovals(): void {
    this.toolApprovalTimeouts.reEvaluate(this.runs.values());
    this.runtimeToolApprovalCoordinator.reEvaluate();
  }

  private async answerRuntimeToolApproval(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    _message?: string
  ): Promise<void> {
    await answerOpenCodeRuntimeToolApproval(entry, allow, {
      getOpenCodeRuntimeAdapter: () => this.getOpenCodeRuntimeAdapter(),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      buildOpenCodeRuntimePermissionAnswerInput,
      buildOpenCodeRuntimePermissionLaunchInput,
      persistOpenCodeRuntimeAdapterLaunchResult: (result, input) =>
        this.persistOpenCodeRuntimeAdapterLaunchResult(result, input),
      deleteRuntimeAdapterRunByTeam: (teamName) => {
        this.runtimeAdapterRunByTeam.delete(teamName);
      },
      setRuntimeAdapterRunByTeam: (teamName, runtimeRun) => {
        this.runtimeAdapterRunByTeam.set(teamName, runtimeRun);
      },
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      getRun: (runId) => this.runs.get(runId),
      guardCommittedOpenCodeSecondaryLaneEvidence: (input) =>
        this.guardCommittedOpenCodeSecondaryLaneEvidence(input),
      publishMixedSecondaryLaneStatusChange: (run, lane) =>
        this.publishMixedSecondaryLaneStatusChange(run, lane),
      syncOpenCodeRuntimeToolApprovals: (input) => this.syncOpenCodeRuntimeToolApprovals(input),
      emitTeamChange: (event) => {
        this.teamChangeEmitter?.(event);
      },
    });
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
    const handledByRuntime = await this.runtimeToolApprovalCoordinator.respond(
      teamName,
      runId,
      requestId,
      allow,
      message
    );
    if (handledByRuntime) {
      return;
    }

    const leadResponse = await respondToLeadToolApproval(
      {
        teamName,
        runId,
        requestId,
        allow,
        message,
      },
      this.getLeadToolApprovalResponsePorts()
    );
    if (leadResponse.handled) {
      return;
    }

    const { run, approval } = leadResponse;

    // Teammate permission requests: apply permission_suggestions to project settings
    try {
      await respondToTeammatePermissionHelper(
        {
          run,
          agentId: approval.source,
          requestId,
          allow,
          message,
          permissionSuggestions: approval.permissionSuggestions,
          toolName: approval.toolName,
          toolInput: approval.toolInput,
        },
        this.getTeammatePermissionResponsePorts()
      );
      this.inFlightResponses.delete(requestId);
      run.pendingApprovals.delete(requestId);
      this.dismissApprovalNotification(requestId);
    } catch (error) {
      this.inFlightResponses.delete(requestId);
      if (run.pendingApprovals.has(requestId)) {
        this.startApprovalTimeout(run, requestId);
      }
      throw error;
    }
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

  private getProvisioningTurnCompletePorts(): TeamProvisioningTurnCompletePorts<
    ProvisioningRun,
    Awaited<ReturnType<TeamProvisioningService['launchMixedSecondaryLaneIfNeeded']>>
  > {
    return {
      hasPendingDeterministicFirstRealTurn: (run) => this.hasPendingDeterministicFirstRealTurn(run),
      isProvisioningRunStillPromotable: (run) => this.isProvisioningRunStillPromotable(run),
      getPreCompleteCliErrorText: (run) => this.getPreCompleteCliErrorText(run),
      hasApiError,
      isAuthFailureWarning,
      failProvisioningWithApiError: (run, text) => this.failProvisioningWithApiError(run, text),
      handleAuthFailureInOutput: (run, text, source) =>
        this.handleAuthFailureInOutput(run, text, source),
      scheduleDeterministicBootstrapCompletionRecovery: (run) =>
        this.scheduleDeterministicBootstrapCompletionRecovery(run),
      resetRuntimeToolActivity: (run, memberName) => this.resetRuntimeToolActivity(run, memberName),
      getRunLeadName: (run) => this.getRunLeadName(run),
      setLeadActivity: (run, state) => this.setLeadActivity(run, state),
      stopFilesystemMonitor: (run) => this.stopFilesystemMonitor(run),
      stopStallWatchdog: (run) => this.stopStallWatchdog(run),
      updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
        this.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
      cleanupPrelaunchBackup: (teamName) => this.cleanupPrelaunchBackup(teamName),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run, options) =>
        this.maybeAuditMemberSpawnStatuses(run, options),
      finalizeMissingRegisteredMembersAsFailed: (run) =>
        this.finalizeMissingRegisteredMembersAsFailed(run),
      launchMixedSecondaryLaneIfNeeded: (run) => this.launchMixedSecondaryLaneIfNeeded(run),
      reconcileFinalLaunchReportingSnapshot: (run, secondaryLaunchResult) =>
        this.reconcileFinalLaunchReportingSnapshot(run, secondaryLaunchResult),
      getFailedSpawnMembers: (run) => this.getFailedSpawnMembers(run),
      getMemberLaunchSummary: (run) => this.getMemberLaunchSummary(run),
      hasPendingLaunchMembers: (run, launchSummary, snapshot) =>
        this.hasPendingLaunchMembers(run, launchSummary, snapshot),
      isProvisioningRunPromotedToAlive: (run) => this.isProvisioningRunPromotedToAlive(run),
      buildAggregatePendingLaunchMessage: (prefix, run, launchSummary, snapshot) =>
        this.buildAggregatePendingLaunchMessage(prefix, run, launchSummary, snapshot),
      updateProgress,
      extractCliLogsFromRun,
      provisioningRunByTeam: this.provisioningRunByTeam,
      setAliveRunId: (teamName, runId) => this.runTracking.setAliveRunId(teamName, runId),
      emitTeamChange: (event) => this.teamChangeEmitter?.(event),
      fireTeamLaunchedNotification: (run) => this.fireTeamLaunchedNotification(run),
      fireTeamLaunchIncompleteNotification: (run, failedMembers, launchSummary, snapshot) =>
        this.fireTeamLaunchIncompleteNotification(run, failedMembers, launchSummary, snapshot),
      sendMessageToRun: (run, message) => this.sendMessageToRun(run, message),
      relayLeadInboxMessages: (teamName) => this.relayLeadInboxMessages(teamName),
      injectGeminiPostLaunchHydration: (run) => this.injectGeminiPostLaunchHydration(run),
      waitForValidConfig: (run, timeoutMs) => this.waitForValidConfig(run, timeoutMs),
      persistMembersMeta: (teamName, request) => this.persistMembersMeta(teamName, request),
      writeLaunchFailureArtifactPackBestEffort: (run, options) =>
        this.writeLaunchFailureArtifactPackBestEffort(run, options),
      killTeamProcess,
      cleanupRun: (run) => this.cleanupRun(run),
    };
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
      unconfirmedMembers: this.getUnconfirmedBootstrapMemberNames(run),
      ...this.buildStdoutCarryDiagnostic(run),
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
    if (!shouldFinalizeIncompleteLaunchStateHelper(run)) {
      return;
    }
    const cleanupReason = buildIncompleteLaunchCleanupReasonHelper(run, fallbackReason);
    this.markIncompleteLaunchStateFinalized(run, cleanupReason);
    try {
      await this.persistLaunchStateSnapshot(run, 'finished');
    } catch (error) {
      run.launchCleanupStateFinalized = false;
      logger.warn(
        `[${run.teamName}] Failed to finalize launch state before cleanup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Remove a run from tracking maps.
   */
  private cleanupRun(run: ProvisioningRun): void {
    cleanupProvisioningRun(run, {
      getTrackedRunId: (teamName) => this.runTracking.getTrackedRunId(teamName),
      isRunIdTracked: (runId) =>
        this.runs.has(runId) || this.runtimeAdapterProgressByRunId.has(runId),
      buildRetainedClaudeLogsSnapshot,
      shouldFinalizeIncompleteLaunchState: (run) => shouldFinalizeIncompleteLaunchStateHelper(run),
      buildIncompleteLaunchCleanupReason: (run) => buildIncompleteLaunchCleanupReasonHelper(run),
      markIncompleteLaunchStateFinalized: (run, cleanupReason) =>
        this.markIncompleteLaunchStateFinalized(run, cleanupReason),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      writeLaunchFailureArtifactPackBestEffort: (run, options) =>
        this.writeLaunchFailureArtifactPackBestEffort(run, options),
      resetRuntimeToolActivity: (run) => this.resetRuntimeToolActivity(run),
      setLeadActivity: (run, state) => this.setLeadActivity(run, state),
      stopStallWatchdog: (run) => this.stopStallWatchdog(run),
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
      relayedMemberInboxMessageIds: this.relayedMemberInboxMessageIds,
      liveLeadProcessMessages: this.liveLeadProcessMessages,
      pruneLiveLeadMessagesForCleanedRun: (run) => this.pruneLiveLeadMessagesForCleanedRun(run),
      clearApprovalTimeout: (requestId) => this.clearApprovalTimeout(requestId),
      inFlightResponses: this.inFlightResponses,
      dismissApprovalNotification: (requestId) => this.dismissApprovalNotification(requestId),
      emitToolApprovalEvent: (event) => this.emitToolApprovalEvent(event),
      mcpConfigBuilder: this.mcpConfigBuilder,
      removeRunMemberMcpConfigFilesLater: (run) => this.removeRunMemberMcpConfigFilesLater(run),
      retainedClaudeLogsByTeam: this.retainedClaudeLogsByTeam,
      retainProvisioningProgress: (runId, progress) =>
        this.retainProvisioningProgress(runId, progress),
      runs: this.runs,
    });
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
    await handleProvisioningProcessExit(run, code, {
      logger,
      buildStdoutCarryDiagnostic: (run) => this.buildStdoutCarryDiagnostic(run),
      flushStdoutParserCarry: (run) => this.flushStdoutParserCarry(run),
      stopStallWatchdog: (run) => this.stopStallWatchdog(run),
      hasSecondaryRuntimeRuns: (teamName) => this.hasSecondaryRuntimeRuns(teamName),
      stopMixedSecondaryRuntimeLanes: (teamName) => this.stopMixedSecondaryRuntimeLanes(teamName),
      waitForValidConfig: (run) => this.waitForValidConfig(run),
      waitForTeamInList: (teamName, run) => this.waitForTeamInList(teamName, run),
      waitForMissingInboxes: (run) => this.waitForMissingInboxes(run),
      persistMembersMeta: (teamName, request) => this.persistMembersMeta(teamName, request),
      updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
        this.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run, options) =>
        this.maybeAuditMemberSpawnStatuses(run, options),
      finalizeMissingRegisteredMembersAsFailed: (run) =>
        this.finalizeMissingRegisteredMembersAsFailed(run),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      updateProgress,
      cleanupRun: (run) => this.cleanupRun(run),
      getTeamsBasePath,
      getAutoDetectedClaudeBasePath,
      getConfiguredCliCommandLabel,
      getRunRuntimeFailureLabel,
      getVerificationTimeoutMs: () => VERIFY_TIMEOUT_MS,
      extractCliLogsFromRun,
      logsSuggestShutdownOrCleanup,
      finalizeIncompleteLaunchStateBeforeCleanup: (run, fallbackReason) =>
        this.finalizeIncompleteLaunchStateBeforeCleanup(run, fallbackReason),
    });
  }

  private async waitForValidConfig(
    run: ProvisioningRun,
    timeoutMs: number = VERIFY_TIMEOUT_MS
  ): Promise<ValidConfigProbeResult> {
    const probes = run.teamsBasePathsToProbe.map((probe) => ({
      ...probe,
      configPath: path.join(probe.basePath, run.teamName, 'config.json'),
    }));
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (run.cancelRequested) {
        return { ok: false };
      }
      for (const probe of probes) {
        try {
          const raw = await tryReadRegularFileUtf8(probe.configPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_CONFIG_MAX_BYTES,
          });
          if (!raw) {
            continue;
          }
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === 'object') {
            const candidate = parsed as { name?: unknown };
            if (typeof candidate.name === 'string' && candidate.name.trim().length > 0) {
              return { ok: true, location: probe.location, configPath: probe.configPath };
            }
          }
        } catch {
          // Best-effort polling until deadline.
        }
      }
      await sleep(VERIFY_POLL_MS);
    }

    return { ok: false };
  }

  private async waitForTeamInList(teamName: string, run?: ProvisioningRun): Promise<boolean> {
    return waitForTeamInListHelper(teamName, {
      listTeams: () => this.configReader.listTeams(),
      timeoutMs: VERIFY_TIMEOUT_MS,
      pollMs: VERIFY_POLL_MS,
      isCancelled: () => run?.cancelRequested === true,
      sleep,
    });
  }

  private async waitForMissingInboxes(run: ProvisioningRun): Promise<string[]> {
    return waitForMissingInboxesHelper(run, {
      getTeamsBasePath,
      pathExists: (filePath) => this.pathExists(filePath),
      timeoutMs: VERIFY_TIMEOUT_MS,
      pollMs: VERIFY_POLL_MS,
      sleep,
    });
  }

  private async tryCompleteAfterTimeout(run: ProvisioningRun): Promise<boolean> {
    return tryCompleteAfterTimeoutHelper(run, {
      waitForValidConfig: (run) => this.waitForValidConfig(run),
      waitForTeamInList: (teamName, run) => this.waitForTeamInList(teamName, run),
      waitForMissingInboxes: (run) => this.waitForMissingInboxes(run),
      persistMembersMeta: (teamName, request) => this.persistMembersMeta(teamName, request),
      updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
        this.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
      refreshMemberSpawnStatusesFromLeadInbox: (run) =>
        this.refreshMemberSpawnStatusesFromLeadInbox(run),
      maybeAuditMemberSpawnStatuses: (run, options) =>
        this.maybeAuditMemberSpawnStatuses(run, options),
      finalizeMissingRegisteredMembersAsFailed: (run) =>
        this.finalizeMissingRegisteredMembersAsFailed(run),
      persistLaunchStateSnapshot: (run, phase) => this.persistLaunchStateSnapshot(run, phase),
      updateProgress,
      cleanupRun: (run) => this.cleanupRun(run),
    });
  }

  private async pathExists(filePath: string): Promise<boolean> {
    return provisioningPathExists(filePath);
  }

  /**
   * Immediately update projectPath in config.json at launch start, before CLI spawn.
   * Ensures TeamDetailView shows the correct project path even if provisioning
   * is interrupted. On failure, restorePrelaunchConfig() reverts to the backup.
   */
  private async updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    await this.configMaintenance.updateConfigProjectPath(teamName, cwd);
  }

  /**
   * Single atomic read-mutate-write for post-launch config updates.
   * Combines session history append and projectPath update to avoid
   * race conditions with the CLI writing to the same file.
   */
  private async updateConfigPostLaunch(
    teamName: string,
    projectPath: string,
    detectedSessionId: string | null,
    color?: string,
    launchState?: TeamProvisioningEffectiveLaunchState
  ): Promise<void> {
    await this.configMaintenance.updateConfigPostLaunch(
      teamName,
      projectPath,
      detectedSessionId,
      color,
      launchState
    );
  }

  private async cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    await this.configMaintenance.cleanupCliAutoSuffixedMembers(teamName);
  }

  private async assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    await this.configMaintenance.assertConfigLeadOnlyForLaunch(teamName);
  }

  private async normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    await this.configMaintenance.normalizeTeamConfigForLaunch(teamName, configRaw);
  }

  /**
   * Restore config.json from prelaunch backup if launch fails after normalization.
   */
  private async restorePrelaunchConfig(teamName: string): Promise<void> {
    await this.configMaintenance.restorePrelaunchConfig(teamName);
  }

  /**
   * Remove the prelaunch backup file after a successful launch.
   */
  async cleanupPrelaunchBackup(teamName: string): Promise<void> {
    await this.configMaintenance.cleanupPrelaunchBackup(teamName);
  }

  private async persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    await this.configMaintenance.persistMembersMeta(teamName, request);
  }

  private async resolveLaunchExpectedMembers(
    teamName: string,
    configRaw: string,
    leadProviderId?: TeamProviderId
  ): Promise<{
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  }> {
    return resolveLaunchExpectedMembersHelper(
      { teamName, configRaw, leadProviderId },
      this.createLaunchExpectedMembersPorts()
    );
  }

  private createLaunchExpectedMembersPorts(): TeamProvisioningLaunchExpectedMembersPorts {
    return {
      readLaunchState: (teamName) => this.launchStateStore.read(teamName),
      readBootstrapLaunchSnapshot,
      getMembers: (teamName) => this.membersMetaStore.getMembers(teamName),
      listInboxNames: (teamName) => this.inboxReader.listInboxNames(teamName),
      warn: (message) => logger.warn(message),
    };
  }

  private async materializeLaunchCompatibilityRepair(
    request: TeamLaunchRequest,
    report: TeamLaunchCompatibilityReport
  ): Promise<void> {
    if (report.repairAction !== 'materialize-members-meta' || report.members.length === 0) {
      return;
    }
    const joinedAt = Date.now();
    const membersToWrite = buildMembersMetaWritePayload(
      report.members.map((member) => ({
        ...member,
        joinedAt,
      }))
    );
    await this.membersMetaStore.writeMembers(request.teamName, membersToWrite, {
      providerBackendId: request.providerBackendId,
    });
  }

  /**
   * Run `claude --help` and return the output. Cached for 5 minutes.
   * Used by the validateCliArgs IPC handler to check user-entered flags.
   */
  async getCliHelpOutput(cwd?: string): Promise<string> {
    const cache = {
      output: this.helpOutputCache,
      cachedAtMs: this.helpOutputCacheTime,
    };
    const output = await getCliHelpOutputForProvisioning({
      cwd,
      cache,
      ports: {
        getCachedOrProbeResult: (targetCwd, providerId) =>
          this.getCachedOrProbeResult(targetCwd, providerId),
        buildProvisioningEnv: () => this.providerRuntime.buildProvisioningEnv(),
        spawnProbe: (claudePath, args, targetCwd, env, timeoutMs) =>
          this.providerRuntime.spawnProbe(claudePath, args, targetCwd, env, timeoutMs),
      },
    });
    this.helpOutputCache = cache.output;
    this.helpOutputCacheTime = cache.cachedAtMs;
    return output;
  }
}
