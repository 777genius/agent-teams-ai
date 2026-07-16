import {
  buildClaudeAttachmentDeliveryParts,
  buildCodexNativeAttachmentDeliveryParts,
} from '@features/agent-attachments/main';
import { type RuntimeTurnSettledProvider } from '@features/member-work-sync/main';
import {
  buildOpenCodeSecondaryLaneId,
  buildPlannedMemberLaneIdentity,
  isOpenCodeSideLanePlan,
  isPureOpenCodeMemberLanePlan,
  isPureOpenCodeSoloLanePlan,
  OPEN_CODE_SOLO_MEMBER_NAME,
  OPEN_CODE_SOLO_MEMBER_ROLE,
  type TeamRuntimeLanePlan,
} from '@features/team-runtime-lanes';
import { createTeamRuntimeLaneCoordinator } from '@features/team-runtime-lanes/main';
import { killTmuxPaneForCurrentPlatformSync } from '@features/tmux-installer/main';
import {
  resolveWorkspaceTrustFeatureFlags,
  type WorkspaceTrustArgsOnlyPlanRequest,
  type WorkspaceTrustArgsOnlyPlanResult,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustDiagnosticsManifest,
  type WorkspaceTrustExecutionResult,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanRequest,
  type WorkspaceTrustFullPlanResult,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
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
import { isProcessAlive } from '@main/utils/processHealth';
import { killProcessByPid } from '@main/utils/processKill';
import { shouldAutoAllow } from '@main/utils/toolApprovalRules';
import { listWindowsProcessTableSync } from '@main/utils/windowsProcessTable';
import { stripAgentBlocks, wrapAgentBlock } from '@shared/constants/agentBlocks';
import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '@shared/constants/crossTeam';
import { type AttachmentPayload, DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { resolveLanguageName } from '@shared/utils/agentLanguage';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { isUsableCodexModelCatalog } from '@shared/utils/codexModelCatalog';
import { deriveContextMetrics } from '@shared/utils/contextMetrics';
import { getErrorMessage } from '@shared/utils/errorHandling';
import {
  isMeaningfulBootstrapCheckInMessage,
  type ParsedPermissionRequest,
  parsePermissionRequest,
} from '@shared/utils/inboxNoise';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { migrateProviderBackendId } from '@shared/utils/providerBackend';
import {
  isTeamInternalControlMessageText,
  stripExactInternalControlEchoPrefix,
} from '@shared/utils/teamInternalControlMessages';
import { hasUnsafeProvisionedButNotAliveRuntimeEvidence } from '@shared/utils/teamLaunchFailureReason';
import {
  parseAllTeammateMessages,
  type ParsedTeammateContent,
} from '@shared/utils/teammateMessageParser';
import {
  buildTeamMemberMcpSettingSources,
  normalizeTeamMemberMcpPolicy,
  requiresStrictTeamMemberMcpConfig,
} from '@shared/utils/teamMemberMcpPolicy';
import { parseNumericSuffixName } from '@shared/utils/teamMemberName';
import {
  inferTeamProviderIdFromModel,
  normalizeOptionalTeamProviderId,
} from '@shared/utils/teamProvider';
import {
  extractToolPreview,
  extractToolResultPreview,
  formatToolSummaryFromCalls,
  parseAgentToolResultStatus,
} from '@shared/utils/toolSummary';
import * as agentTeamsControllerModule from 'agent-teams-controller';
import { type ChildProcess, execFileSync, type spawn } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

import {
  ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS,
  type AnthropicTeamApiKeyHelperMaterial,
  cleanupAnthropicTeamApiKeyHelperForTeam,
  cleanupAnthropicTeamApiKeyHelperMaterial,
  cleanupStaleAnthropicTeamApiKeyHelpers,
} from '../runtime/anthropicTeamApiKeyHelper';
import { mergeJsonSettingsArgs } from '../runtime/cliSettingsArgs';
import { buildProviderControlPlaneCliCommandArgs } from '../runtime/providerCliCommandArgs';
import { ProviderConnectionService } from '../runtime/ProviderConnectionService';
import { resolveTeamProviderId } from '../runtime/providerRuntimeEnv';
import { type TeamRuntimeSettingsJson } from '../runtime/teamRuntimeSettingsBundle';

import { openCodeRuntimeApprovalProvider } from './approvals/OpenCodeRuntimeApprovalProvider';
import {
  RuntimeToolApprovalCoordinator,
  type RuntimeToolApprovalEntry,
} from './approvals/RuntimeToolApprovalCoordinator';
import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from './bootstrap/NativeAppManagedBootstrapContextBuilder';
import {
  type OpenCodeMemberDirectory,
  type OpenCodeMemberIdentityResolution,
  type OpenCodeMemberInboxDelivery,
  type OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryService,
  type OpenCodeMemberMessageDeliverySource,
  type OpenCodeRuntimeMessageAdapter,
} from './opencode/delivery/OpenCodeMemberMessageDeliveryService';
import {
  isOpenCodePromptDeliveryWatchdogRecordTerminal,
  isOpenCodeSessionRefreshRetryRecord,
  OpenCodePromptDeliveryFollowUpPolicy,
} from './opencode/delivery/OpenCodePromptDeliveryFollowUpPolicy';
import {
  createOpenCodePromptDeliveryLedgerStore,
  hashOpenCodePromptDeliveryPayload,
  type OpenCodePromptDeliveryLedgerRecord,
  type OpenCodePromptDeliveryLedgerStore,
} from './opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeDeliveryPendingReason,
  hasOpenCodeObservedMessageSendToolCall,
  isLegacyOpenCodeMemberWorkSyncReadCommitAllowed,
  isOpenCodeDeliveryResponseReadCommitAllowed,
  isOpenCodeDirectUserPromptDelivery,
  isOpenCodeNoAssistantTerminalDeliveryFailure,
  isOpenCodeRuntimeManifestWatermarkDeliveryFailure,
  normalizeOpenCodeDeliveryResponseObservation,
} from './opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy';
import {
  buildOpenCodePromptDeliveryActiveBusyStatus,
  OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS,
  type OpenCodeVisibleReplyProof,
} from './opencode/delivery/OpenCodePromptDeliveryWatchdog';
import { OpenCodePromptDeliveryWatchdogScheduler } from './opencode/delivery/OpenCodePromptDeliveryWatchdogScheduler';
import {
  buildOpenCodeRuntimeDeliveryUserVisibleImpact,
  decideOpenCodeRuntimeDeliveryAdvisory,
  getOpenCodeRuntimeDeliveryAdvisoryReasonKey,
  isOpenCodeAttachmentDeliveryFailureReason,
  isPotentialOpenCodeRuntimeDeliveryError,
  type OpenCodeRuntimeDeliveryAdvisoryDecision,
  toOpenCodeRuntimeDeliveryStatus,
} from './opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy';
import { createOpenCodeRuntimeDeliveryPorts } from './opencode/delivery/OpenCodeRuntimeDeliveryPorts';
import {
  normalizeOpenCodeTaskRefsForComparison as normalizeOpenCodeTaskRefsForComparisonValue,
  openCodeTaskRefsIncludeAll as openCodeTaskRefsIncludeAllValue,
} from './opencode/delivery/OpenCodeRuntimeDeliveryProofMatching';
import { OpenCodeRuntimeDeliveryProofReader } from './opencode/delivery/OpenCodeRuntimeDeliveryProofReader';
import { OpenCodeVisibleReplyProofService } from './opencode/delivery/OpenCodeVisibleReplyProofService';
import { createRuntimeDeliveryJournalStore } from './opencode/delivery/RuntimeDeliveryJournal';
import {
  RuntimeDeliveryDestinationRegistry,
  RuntimeDeliveryReconciler,
  RuntimeDeliveryService,
} from './opencode/delivery/RuntimeDeliveryService';
import {
  clearOpenCodeRuntimeLaneStorage,
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeRuntimeRunTombstonesPath,
  inspectOpenCodeRuntimeLaneStorage,
  migrateLegacyOpenCodeRuntimeState,
  OpenCodeRuntimeManifestEvidenceReader,
  prepareOpenCodeRuntimeLaneForLaunchGeneration,
  readCommittedOpenCodeBootstrapSessionEvidence,
  readOpenCodeRuntimeLaneIndex,
  recoverStaleOpenCodeRuntimeLaneIndexEntry,
  setOpenCodeRuntimeActiveRunManifest,
  upsertOpenCodeRuntimeLaneIndexEntry,
} from './opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import {
  createRuntimeRunTombstoneStore,
  type RuntimeEvidenceKind,
  RuntimeStaleEvidenceError,
} from './opencode/store/RuntimeRunTombstoneStore';
import { getSystemLocale } from './provisioning/TeamProvisioningAgentLanguage';
import {
  buildDeterministicCreateBootstrapSpec,
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
  buildIncompleteLaunchCleanupReason as buildIncompleteLaunchCleanupReasonHelper,
  cleanupProvisioningRun,
  clearPostCompactReminderState,
  shouldFinalizeIncompleteLaunchState as shouldFinalizeIncompleteLaunchStateHelper,
} from './provisioning/TeamProvisioningCleanup';
import { buildCombinedLogs } from './provisioning/TeamProvisioningCliExitPresentation';
import {
  assertConfigRawLeadOnlyForLaunch,
  buildMembersMetaWritePayload,
  collectConfigLaunchBaseNamesFromConfigMembers,
  collectConfigLaunchBaseNamesFromMetaMembers,
  getPrelaunchConfigBackupPath,
  mergeMembersMetaForLaunch,
  planCliAutoSuffixedConfigMemberCleanup,
  planCliAutoSuffixedMetaMemberCleanup,
  planTeamConfigLaunchNormalization,
  resolveLaunchExpectedMembersFromCompatibilityReport,
  selectMembersMetaTeammates,
} from './provisioning/TeamProvisioningConfigLaunchNormalization';
import {
  buildConfigLaunchCompatibilityReport,
  buildLaunchMembersFromMeta,
  extractTeammateSpecsFromConfig,
  hasIncompleteOpenCodeLaunchCompatibilityMember,
  isUnsafeMixedLaunchFallback,
  type TeamProvisioningEffectiveLaunchState,
  updateTeamConfigPostLaunch,
} from './provisioning/TeamProvisioningConfigMaterialization';
import {
  buildCrossTeamConversationKey as buildCrossTeamConversationKeyHelper,
  clearPendingCrossTeamReplyExpectation as clearPendingCrossTeamReplyExpectationHelper,
  extractCrossTeamPseudoTargetTeam as extractCrossTeamPseudoTargetTeamHelper,
  getCrossTeamSourceTeam as getCrossTeamSourceTeamHelper,
  getPendingCrossTeamReplyExpectationKeys as getPendingCrossTeamReplyExpectationKeysHelper,
  isCrossTeamPseudoRecipientName as isCrossTeamPseudoRecipientNameHelper,
  isCrossTeamToolRecipientName as isCrossTeamToolRecipientNameHelper,
  looksLikeQualifiedExternalRecipientName as looksLikeQualifiedExternalRecipientNameHelper,
  matchCrossTeamLeadInboxMessages as matchCrossTeamLeadInboxMessagesHelper,
  parseCrossTeamRecipient as parseCrossTeamRecipientHelper,
  parseCrossTeamTargetTeam as parseCrossTeamTargetTeamHelper,
  registerPendingCrossTeamReplyExpectation as registerPendingCrossTeamReplyExpectationHelper,
  rememberRecentCrossTeamLeadDeliveryMessageIds as rememberRecentCrossTeamLeadDeliveryMessageIdsHelper,
  resolveSingleActiveCrossTeamReplyHint as resolveSingleActiveCrossTeamReplyHintHelper,
  wasRecentlyDeliveredToLead as wasRecentlyDeliveredToLeadHelper,
} from './provisioning/TeamProvisioningCrossTeamRouting';
import {
  buildCrossProviderMemberArgs as buildCrossProviderMemberArgsHelper,
  buildProvisioningEnv as buildProvisioningEnvHelper,
  type CrossProviderMemberArgsResult,
  isAnthropicDirectCredentialAuthSource,
  type ProvisioningAuthSource,
  type ProvisioningEnvResolution,
  type TeamProvisioningEnvBuilderPorts,
  type TeamRuntimeAuthContext,
} from './provisioning/TeamProvisioningEnvBuilder';
import {
  startProvisioningFilesystemMonitor,
  stopProvisioningFilesystemMonitor,
} from './provisioning/TeamProvisioningFilesystemMonitor';
import { mergeAndRemoveDuplicateInboxes as mergeAndRemoveDuplicateInboxesHelper } from './provisioning/TeamProvisioningInboxDuplicateMerge';
import { markTeamInboxMessagesRead } from './provisioning/TeamProvisioningInboxPersistence';
import {
  buildLeadInboxRelayPrompt,
  buildMemberInboxRelayPrompt,
  collectConfirmedSameTeamPairs as collectConfirmedSameTeamPairsHelper,
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  getLeadInboxRelayNoiseIds,
  getLeadRelayReadCommitBatch,
  hasStableInboxMessageId,
  inferOpenCodeInboxMessageTaskRefs,
  isCurrentProofMissingRecoveryForegroundMessage,
  isCurrentReviewPickupRequestForegroundMessage,
  isOpenCodeProtocolProofMissingRecord,
  type NativeSameTeamFingerprint,
  normalizeSameTeamText,
  openCodeTaskRefsOverlap,
  selectLeadInboxRelayBatch,
  selectMemberInboxRelayBatch,
  selectOpenCodeInboxRelayBatch,
  shouldDeferSameTeamMessage as shouldDeferSameTeamMessageHelper,
  shouldSuppressUnverifiedLeadRelayStateLine,
  splitMemberInboxRelayUnread,
} from './provisioning/TeamProvisioningInboxRelayPolicy';
import {
  assertDeterministicBootstrapPrimaryMemberLimit,
  assertOpenCodeNotLaunchedThroughLegacyProvisioning,
  buildLargeDeterministicBootstrapWarning,
  getMixedLaunchFallbackRecoveryError,
  isPureOpenCodeProvisioningRequest,
  mergeProvisioningWarnings,
  type TeamLaunchCompatibilityReport,
} from './provisioning/TeamProvisioningLaunchCompatibility';
import {
  buildLaunchDiagnosticsFromRun,
  mentionsProcessTableUnavailable,
} from './provisioning/TeamProvisioningLaunchDiagnostics';
import {
  deriveMemberLaunchState,
  isAutoClearableLaunchFailureReason,
  isBootstrapCheckInTimeoutFailureReason,
  isCliProvisionedButNotAliveFailureReason,
  isProvisionedButNotAliveFailureReason,
} from './provisioning/TeamProvisioningLaunchFailurePolicy';
import { buildTeamLaunchIncompleteNotificationPayload } from './provisioning/TeamProvisioningLaunchIncompleteNotification';
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
  resolveOpenCodeSecondaryLaneMemberEvidence,
  shouldOverlayPrimaryBootstrapTruth as shouldOverlayPrimaryBootstrapTruthHelper,
} from './provisioning/TeamProvisioningLaunchStateProjection';
import {
  applyOpenCodeSecondaryEvidenceOverlay as applyOpenCodeSecondaryEvidenceOverlayHelper,
  createDefaultOpenCodeSecondaryEvidenceOverlayPorts,
  finalizeMissingRegisteredMembersAsFailed as finalizeMissingRegisteredMembersAsFailedHelper,
  guardCommittedOpenCodeSecondaryLaneEvidence as guardCommittedOpenCodeSecondaryLaneEvidenceHelper,
  hasCommittedOpenCodeSecondaryEvidenceOverlayDelta,
} from './provisioning/TeamProvisioningLaunchStateReconciliation';
import {
  codexImagePartToContentBlock,
  toLeadAttachmentPayloads,
} from './provisioning/TeamProvisioningLeadAttachments';
import {
  buildLeadContextUsagePayloadFromState,
  getInitialLeadContextWindowTokensForRequest,
} from './provisioning/TeamProvisioningLeadContextUsage';
import {
  matchesExactTeamMemberName,
  matchesObservedMemberNameForExpected,
  matchesTeamMemberIdentity,
} from './provisioning/TeamProvisioningMemberIdentity';
import {
  type LiveRosterAttachReason,
  type MemberLifecycleOperation,
  type MemberLifecycleOperationKind,
  TeamProvisioningMemberLifecycleController,
  type TeamProvisioningMemberLifecycleHost,
} from './provisioning/TeamProvisioningMemberLifecycle';
import {
  buildRestartDuplicateUnconfirmedReason,
  buildRestartGraceTimeoutReason,
  buildRestartStillRunningReason,
  createInitialMemberSpawnStatusEntry,
  deriveTaskActivityPauseAt,
  deriveTaskActivityResumeAt,
  MEMBER_LAUNCH_GRACE_MS,
  parseOptionalIsoMs,
  shouldWarnOnMissingRegisteredMember,
  shouldWarnOnUnreadableMemberAuditConfig,
  summarizeMemberSpawnStatusRecord,
} from './provisioning/TeamProvisioningMemberSpawnStatusPolicy';
import {
  buildEffectiveTeamMemberSpec,
  buildEffectiveTeamMemberSpecs,
  getExplicitLaunchModelSelection,
  normalizeTeamMemberProviderId,
  normalizeTeamProviderLike,
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
import { resolveOpenCodeInboxAttachmentPayloads as resolveOpenCodeInboxAttachmentPayloadsHelper } from './provisioning/TeamProvisioningOpenCodeAttachmentPayloads';
import {
  commitOpenCodeRuntimeBootstrapSessionEvidence,
  createDefaultOpenCodeRuntimeBootstrapEvidencePorts,
  findDeliverableOpenCodeRuntimeBootstrapSessionEvidence,
  getOpenCodeAppMcpTransportMismatchDiagnostic,
  hasCommittedOpenCodeRuntimeBootstrapSessionEvidence,
  type OpenCodeRuntimeBootstrapCheckinIdempotencyResult,
  type OpenCodeRuntimeBootstrapEvidencePorts,
  resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember,
  stampOpenCodeAppMcpTransportEvidenceIfMissing,
} from './provisioning/TeamProvisioningOpenCodeBootstrapEvidence';
import {
  boundOpenCodeAppManagedBriefingText,
  hasRealOpenCodeFailureDiagnostic,
  isPersistedOpenCodeSecondaryLaneMember,
  normalizeOpenCodePrepareDiagnostic,
  promoteOpenCodePersistedFailureReasonsFromDiagnostics,
  selectOpenCodePrepareProviderDiagnostic,
} from './provisioning/TeamProvisioningOpenCodeDiagnosticsPolicy';
import { resolveOpenCodeMemberIdentityFromDirectory as resolveOpenCodeMemberIdentityFromDirectoryHelper } from './provisioning/TeamProvisioningOpenCodeMemberIdentity';
import { prepareSelectedOpenCodeModelsForProvisioning } from './provisioning/TeamProvisioningOpenCodeModelPreparation';
import {
  appendDiagnosticOnce,
  applyOpenCodeSecondaryBootstrapStallOverlay as applyOpenCodeSecondaryBootstrapStallOverlayHelper,
  buildOpenCodeSecondaryLaneTimingDiagnostic,
  collectOpenCodeSecondaryLaneFailureDiagnostics,
  createUnexpectedMixedSecondaryLaneFailureResult,
  getOpenCodeSecondaryBootstrapPendingMemberNames as getOpenCodeSecondaryBootstrapPendingMemberNamesHelper,
  getOpenCodeSecondaryBootstrapStallDiagnosticFromPersisted,
  hasRetainableOpenCodeRuntimeMember,
  isBootstrapMemberEvidenceCurrentForMember,
  isDefinitiveOpenCodePreLaunchFailure,
  isExplicitLegacyOpenCodeBootstrap,
  isMaterializedOpenCodeSessionId,
  isRecoverableOpenCodeBootstrapPendingLaunchResult,
  isRecoverableOpenCodeRuntimeEvidence,
  isRecoverablePersistedOpenCodeRuntimeCandidate,
  isRecoverablePersistedOpenCodeTerminalRuntimeCandidate,
  MEMBER_BOOTSTRAP_STALL_MS,
  normalizeExpectedOpenCodeRuntimeLaunchMembers,
  normalizeIsoTimestamp,
  normalizeRecoverableOpenCodeBootstrapPendingLaunchResult,
  OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC,
  promoteCommittedOpenCodeAppManagedBootstrapEvidence,
  selectOpenCodeSecondaryBootstrapStallDiagnostic,
  shouldMarkPersistedOpenCodeBootstrapStalled,
  shouldRetainOpenCodeRuntimeLaunch,
  summarizeRuntimeLaunchResultMembers,
  toOpenCodePersistedLaunchMember as toOpenCodePersistedLaunchMemberHelper,
} from './provisioning/TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import { shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange as shouldEmitOpenCodeRuntimeLivenessMemberSpawnChangeHelper } from './provisioning/TeamProvisioningOpenCodeRuntimeLivenessPolicy';
import {
  buildOpenCodeRuntimePendingPermissionsLaunchSnapshot,
  extractOpenCodeRuntimeLaneMemberName,
  findPersistedLaunchMemberForLane as findPersistedLaunchMemberForLaneHelper,
  type OpenCodeRuntimePendingPermissionsPersistenceInput,
  type OpenCodeRuntimePermissionListingAdapter,
  type OpenCodeRuntimePermissionSpawnStatusSyncInput,
  type OpenCodeRuntimePermissionSyncInput,
  syncOpenCodeRuntimePermissionsAfterDelivery,
  syncOpenCodeRuntimePermissionSpawnStatuses as syncOpenCodeRuntimePermissionSpawnStatusesHelper,
} from './provisioning/TeamProvisioningOpenCodeRuntimePermissions';
import { resolveOpenCodeSoloRuntimeRecipientProviderId } from './provisioning/TeamProvisioningOpenCodeSoloRuntime';
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
import { resolvePersistedRuntimeMemberIdentity as resolvePersistedRuntimeMemberIdentityHelper } from './provisioning/TeamProvisioningPersistedRuntimeMemberIdentity';
import {
  handleProvisioningProcessExit,
  pathExists as provisioningPathExists,
  tryCompleteAfterTimeout as tryCompleteAfterTimeoutHelper,
  waitForMissingInboxes as waitForMissingInboxesHelper,
  waitForTeamInList as waitForTeamInListHelper,
} from './provisioning/TeamProvisioningProcessExit';
import {
  appendProvisioningTrace,
  boundLiveLeadProcessMessage,
  boundLiveLeadProcessText,
  boundPendingLogLineCarry,
  boundRunClaudeLogLines,
  boundRunProvisioningOutputParts,
  boundSingleRetainedLogLine,
  boundStdoutParserCarry,
  buildProvisioningLiveOutput,
  emitProvisioningCheckpoint,
  initializeProvisioningTrace,
} from './provisioning/TeamProvisioningProgressBuffers';
import {
  buildDeterministicLaunchHydrationPrompt,
  buildGeminiPostLaunchHydrationPrompt,
  buildPersistentLeadContext,
  buildTaskBoardSnapshot,
  extractBootstrapFailureReason,
  extractHeartbeatTimestamp,
  getCanonicalSendMessageFieldRule,
  getCanonicalSendMessageToolRule,
  normalizeMemberDiagnosticText,
} from './provisioning/TeamProvisioningPromptBuilders';
import {
  createDefaultTeamProvisioningProviderDiagnosticsPorts,
  PREFLIGHT_AUTH_RETRY_DELAY_MS,
  probeClaudeRuntime,
  probeProviderRuntimeControlPlane,
  runProviderOneShotDiagnostic,
  spawnProbe as spawnProbeDiagnostic,
  type SpawnProbeOptions,
  type SpawnProbeResult,
  type TeamProvisioningProviderDiagnosticsPorts,
  validateAgentTeamsMcpRuntime,
} from './provisioning/TeamProvisioningProviderDiagnostics';
import {
  appendPreflightDebugLog,
  createProbeCacheKey,
  getCliHelpOutputForProvisioning,
  PROVIDER_MODEL_LIST_TIMEOUT_MS,
  PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
  validatePrepareCwd,
  verifySelectedProviderModelsForProvisioning,
  warmupProviderPreflight,
} from './provisioning/TeamProvisioningProviderPreflight';
import {
  buildRuntimeLaunchWarning,
  getAnthropicFastModeDefault,
  getPromptSizeSummary,
  getTeamProviderLabel,
  logRuntimeLaunchSnapshot,
} from './provisioning/TeamProvisioningRuntimeDiagnostics';
import {
  addModelCatalogLaunchModels,
  buildProviderModelLaunchIdentity as buildProviderModelLaunchIdentityHelper,
  buildTeamRuntimeLaunchArgsPlan as buildTeamRuntimeLaunchArgsPlanHelper,
  extractJsonObjectFromCli,
  getLaunchModelArg,
  getTeamsBasePathsToProbe,
  logsSuggestShutdownOrCleanup,
  normalizeProviderModelListModels,
  normalizeProvisioningModelCheckRequests,
  type ProviderModelListCommandResponse,
  type RuntimeProviderLaunchFacts,
  type RuntimeStatusCommandResponse,
  type TeamRuntimeLaunchArgsPlan,
  type TeamsBaseLocation,
  validateRuntimeLaunchSelection as validateRuntimeLaunchSelectionHelper,
  type ValidConfigProbeResult,
} from './provisioning/TeamProvisioningRuntimeLaunchSelection';
import {
  type LiveTeamAgentRuntimeMetadata,
  readCachedRuntimeProcessRowsForLiveRuntimeMetadata,
  type RuntimeProcessRowsCacheEntry,
} from './provisioning/TeamProvisioningRuntimeMetadataPolicy';
import {
  attachLiveRuntimeMetadataToStatuses as attachLiveRuntimeMetadataToStatusesHelper,
  buildLiveTeamAgentRuntimeMetadata as buildLiveTeamAgentRuntimeMetadataHelper,
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
  readProcessUsageStatsByPid as readProcessUsageStatsByPidHelper,
  readRuntimeProcessRowsForUsageSnapshot as readRuntimeProcessRowsForUsageSnapshotHelper,
  type RuntimeProcessUsageStatsCacheEntry,
} from './provisioning/TeamProvisioningRuntimeSnapshot';
import {
  clearMemberSpawnToolTracking as clearMemberSpawnToolTrackingHelper,
  resetRuntimeToolActivity as resetRuntimeToolActivityHelper,
} from './provisioning/TeamProvisioningRuntimeToolActivity';
import { scanForNewestProjectSession } from './provisioning/TeamProvisioningSessionDiscovery';
import {
  stopAllTeamsFlow,
  stopPersistentTeamMembersFlow,
  stopTeamFlow,
} from './provisioning/TeamProvisioningStopFlow';
import {
  extractStreamUserText,
  getStableLeadThoughtMessageId,
  handleDeterministicBootstrapEvent,
  handleTeamProvisioningStreamJsonMessage,
  shouldAcceptDeterministicBootstrapEvent,
  type TeamProvisioningStreamEventPorts,
} from './provisioning/TeamProvisioningStreamEvents';
import {
  buildAllowControlResponsePayload,
  buildDenyControlResponsePayload,
  buildToolApprovalAutoResolvedEvent,
  formatToolApprovalBody,
  resolveToolApprovalTimeoutAutoResolution,
  TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE,
} from './provisioning/TeamProvisioningToolApprovalFlow';
import {
  handleTeamProvisioningTurnComplete,
  type TeamProvisioningTurnCompletePorts,
} from './provisioning/TeamProvisioningTurnComplete';
import {
  applyWorkspaceTrustArgPatches as applyWorkspaceTrustArgPatchesHelper,
  collectWorkspaceTrustProviders as collectWorkspaceTrustProvidersHelper,
  collectWorkspaceTrustWorkspaces as collectWorkspaceTrustWorkspacesHelper,
  createDefaultModelWorkspaceTrustProviderArgsResolver as createDefaultModelWorkspaceTrustProviderArgsResolverHelper,
  planWorkspaceTrustArgsOnlySafely as planWorkspaceTrustArgsOnlySafelyHelper,
  planWorkspaceTrustFullSafely as planWorkspaceTrustFullSafelyHelper,
  prepareWorkspaceTrustForDeterministicRun as prepareWorkspaceTrustForDeterministicRunHelper,
  resolveWorkspaceTrustGitRoot as resolveWorkspaceTrustGitRootHelper,
  toWorkspaceTrustProvider as toWorkspaceTrustProviderHelper,
  type WorkspaceTrustProviderArgsResolver,
} from './provisioning/TeamProvisioningWorkspaceTrust';
import { OpenCodeTaskLogAttributionStore } from './taskLogs/stream/OpenCodeTaskLogAttributionStore';
import { isAgentTeamsToolUse } from './agentTeamsToolNames';
import { atomicWriteAsync } from './atomicWrite';
import { peekAutoResumeService } from './AutoResumeService';
import { ClaudeBinaryResolver } from './ClaudeBinaryResolver';
import {
  getCliFlavorUiOptions,
  getConfiguredCliCommandLabel,
  getConfiguredCliFlavor,
} from './cliFlavor';
import { withFileLock } from './fileLock';
import { withInboxLock } from './inboxLock';
import { type ProcessBootstrapTransportSummary } from './ProcessBootstrapTransportEvidence';
import {
  boundLaunchDiagnostics,
  boundProgressAssistantParts,
  boundProgressLogLines,
  buildProgressLiveOutput,
  buildProgressLogsTail,
  buildProgressTraceLine,
} from './progressPayload';
import {
  applyDesktopTeammateModeDecisionToEnv,
  buildDesktopTeammateModeCliArgs,
  resolveDesktopTeammateModeDecision,
} from './runtimeTeammateMode';
import { TeamAgentRuntimeResourceHistory } from './TeamAgentRuntimeResourceHistory';
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
import {
  commandArgEquals,
  sanitizeProcessCommandForDiagnostics,
} from './TeamRuntimeLivenessResolver';
import {
  buildRuntimeProcessLoadStats,
  buildRuntimeUsageProcessTrees,
  type RuntimeProcessLoadStats,
  type RuntimeProcessUsageStats,
  type RuntimeTelemetryProcessTableRow,
  type RuntimeUsageProcessTree,
} from './TeamRuntimeTelemetry';
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

interface PersistedTeamConfigCacheEntry {
  path: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  projectPath: string | null;
  members: PersistedRuntimeMemberLike[];
}

interface OpenCodeRuntimeControlAck {
  ok: true;
  providerId: 'opencode';
  teamName: string;
  runId: string;
  state: 'accepted' | 'delivered' | 'duplicate' | 'recorded';
  memberName?: string;
  runtimeSessionId?: string;
  idempotencyKey?: string;
  location?: unknown;
  diagnostics: string[];
  observedAt: string;
}

interface LaunchStateWriteResult {
  snapshot: PersistedTeamLaunchSnapshot;
  wrote: boolean;
}

import type {
  ActiveToolCall,
  AgentActionMode,
  CliProviderModelCatalog,
  CliProviderRuntimeCapabilities,
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
  TeamAgentRuntimeResourceSample,
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
  TeamProvisioningSupportDiagnostic,
  TeamRuntimeState,
  TeamTask,
  ToolActivityEventPayload,
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

function asRuntimeRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('OpenCode runtime payload must be an object');
  }
  return value as Record<string, unknown>;
}

function requireRuntimeString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode runtime payload missing ${fieldName}`);
  }
  return value.trim();
}

function optionalRuntimeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRuntimeIso(value: unknown, fallback: string = nowIso()): string {
  const raw = optionalRuntimeString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeRuntimeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

interface RuntimeToolMetadata {
  runtimePid?: number;
  processCommand?: string;
  runtimeVersion?: string;
  hostPid?: number;
  cwd?: string;
}

function normalizeRuntimePositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function normalizeRuntimeMetadataString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim().slice(0, maxLength)
    : undefined;
}

function parseRuntimeToolMetadata(value: unknown): RuntimeToolMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  const raw = value as Record<string, unknown>;
  return {
    ...(normalizeRuntimePositiveInteger(raw.runtimePid)
      ? { runtimePid: normalizeRuntimePositiveInteger(raw.runtimePid) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.processCommand, 500)
      ? { processCommand: normalizeRuntimeMetadataString(raw.processCommand, 500) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.runtimeVersion, 80)
      ? { runtimeVersion: normalizeRuntimeMetadataString(raw.runtimeVersion, 80) }
      : {}),
    ...(normalizeRuntimePositiveInteger(raw.hostPid)
      ? { hostPid: normalizeRuntimePositiveInteger(raw.hostPid) }
      : {}),
    ...(normalizeRuntimeMetadataString(raw.cwd, 500)
      ? { cwd: normalizeRuntimeMetadataString(raw.cwd, 500) }
      : {}),
  };
}

function buildRuntimeToolMetadataDiagnostics(metadata: RuntimeToolMetadata | undefined): string[] {
  if (!metadata) {
    return [];
  }
  const diagnostics: string[] = [];
  if (metadata.runtimePid != null) {
    diagnostics.push(`runtime pid: ${metadata.runtimePid}`);
  }
  if (metadata.processCommand) {
    const processCommand = sanitizeProcessCommandForDiagnostics(metadata.processCommand);
    if (processCommand) {
      diagnostics.push(`runtime process command: ${processCommand}`);
    }
  }
  if (metadata.runtimeVersion) {
    diagnostics.push(`runtime version: ${metadata.runtimeVersion}`);
  }
  if (metadata.hostPid != null) {
    diagnostics.push(`runtime host pid: ${metadata.hostPid}`);
  }
  if (metadata.cwd) {
    diagnostics.push(`runtime cwd: ${metadata.cwd}`);
  }
  return diagnostics;
}

function runtimeTaskRefs(teamName: string, value: unknown): InboxMessage['taskRefs'] | undefined {
  const refs = normalizeRuntimeStringArray(value);
  return refs.length > 0
    ? refs.map((ref) => ({
        teamName,
        taskId: ref,
        displayId: ref,
      }))
    : undefined;
}

function structuredTaskRefs(value: unknown): TaskRef[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const refs = value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      taskId: typeof item.taskId === 'string' ? item.taskId.trim() : '',
      displayId: typeof item.displayId === 'string' ? item.displayId.trim() : '',
      teamName: typeof item.teamName === 'string' ? item.teamName.trim() : '',
    }))
    .filter(
      (item) => item.taskId.length > 0 && item.displayId.length > 0 && item.teamName.length > 0
    );

  return refs.length > 0 ? refs : undefined;
}

function teamToolTaskRefs(teamName: string, value: unknown): TaskRef[] | undefined {
  return structuredTaskRefs(value) ?? runtimeTaskRefs(teamName, value);
}

function mergeRuntimeDiagnostics(
  previous: string[] | undefined,
  incoming: unknown,
  fallback?: string
): string[] | undefined {
  const merged = [
    ...(previous ?? []),
    ...normalizeRuntimeStringArray(incoming),
    ...(fallback ? [fallback] : []),
  ].filter((value) => value.trim().length > 0);
  return merged.length > 0 ? [...new Set(merged)] : undefined;
}
const VERIFY_POLL_MS = 500;
const STDERR_RING_LIMIT = 64 * 1024;
const STDOUT_RING_LIMIT = 64 * 1024;
const LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT = 100;
const PROVISIONING_TRACE_STORAGE_LIMIT = 500;
// Progress emissions fan out the latest CLI tail + assistant output to the
// renderer over IPC. Under load the previous 300ms cadence combined with an
// unbounded payload (see `emitLogsProgress`) caused renderer OOM crashes
// (about 3 full-history serializations per second, each holding thousands of
// lines). The tail cap in `emitLogsProgress` bounds each payload; we also
// slow the cadence to ~1s so Zustand can keep up on large teams.
const LOG_PROGRESS_THROTTLE_MS = 1000;
const UI_LOGS_TAIL_LIMIT = 128 * 1024;
const PROBE_CACHE_TTL_MS = 36 * 60 * 60 * 1000;
function pushUniqueSupportDiagnostics(
  diagnostics: TeamProvisioningSupportDiagnostic[],
  incoming: readonly TeamProvisioningSupportDiagnostic[] | undefined
): void {
  for (const diagnostic of incoming ?? []) {
    if (!diagnostics.some((existing) => existing.id === diagnostic.id)) {
      diagnostics.push({ ...diagnostic });
    }
  }
}

const STALL_CHECK_INTERVAL_MS = 10_000;
const STALL_WARNING_THRESHOLD_MS = 20_000;
const APP_TEAM_RUNTIME_DISALLOWED_TOOLS =
  'TeamDelete,TodoWrite,TaskCreate,TaskUpdate,mcp__agent-teams__team_launch,mcp__agent-teams__team_stop';
const CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV = 'CLAUDE_TEAM_RUNTIME_SETTINGS_PATH';
const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;
const TEAM_INBOX_MAX_BYTES = 2 * 1024 * 1024;
const MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS = 1_500;
function assertAppDeterministicBootstrapEnabled(): void {
  if (process.env.CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the app rollout flag (CLAUDE_APP_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
  if (process.env.CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP === '1') {
    throw new Error(
      'Deterministic team bootstrap is disabled by the runtime kill switch (CLAUDE_DISABLE_DETERMINISTIC_TEAM_BOOTSTRAP=1).'
    );
  }
}

function getProviderRuntimeFailureLabel(providerId: TeamProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Claude CLI';
    case 'codex':
      return 'Codex runtime';
    case 'gemini':
      return 'Gemini runtime';
    case 'opencode':
      return 'OpenCode runtime';
  }
}

function getRunRuntimeFailureLabel(run: ProvisioningRun): string {
  const providerIds = new Set<TeamProviderId>();
  const addProvider = (providerId: TeamProviderId | undefined): void => {
    if (providerId) {
      providerIds.add(providerId);
    }
  };

  addProvider(normalizeOptionalTeamProviderId(run.request.providerId));
  addProvider(inferTeamProviderIdFromModel(run.request.model));
  for (const member of run.request.members) {
    addProvider(normalizeOptionalTeamProviderId(member.providerId));
    addProvider(inferTeamProviderIdFromModel(member.model));
  }

  if (providerIds.size === 1) {
    return getProviderRuntimeFailureLabel([...providerIds][0]);
  }

  return getCliFlavorUiOptions(getConfiguredCliFlavor()).displayName;
}

function buildMissingCliError(): Error {
  if (getConfiguredCliFlavor() === 'agent_teams_orchestrator') {
    return new Error(
      'Multimodel runtime not found. The packaged app must include resources/runtime/claude-multimodel, or development must provide CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH.'
    );
  }
  return new Error('Claude CLI not found; install it or provide a valid path');
}

function looksLikeClaudeStdoutJsonFragment(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return false;
  }
  return (
    /"type"\s*:/.test(trimmed) ||
    /"message"\s*:/.test(trimmed) ||
    /"content"\s*:/.test(trimmed) ||
    /"subtype"\s*:/.test(trimmed) ||
    /"session_id"\s*:/.test(trimmed)
  );
}

const DETERMINISTIC_BOOTSTRAP_COMPLETION_RECOVERY_MS = 12_000;

function isTerminalFailureProvisioningState(state: TeamProvisioningProgress['state']): boolean {
  return state === 'failed' || state === 'cancelled' || state === 'disconnected';
}

function shouldIgnoreProvisioningProgressRegression(
  currentState: TeamProvisioningProgress['state'],
  nextState: TeamProvisioningProgress['state']
): boolean {
  if (currentState === 'ready') {
    return nextState !== 'ready' && nextState !== 'disconnected';
  }
  if (isTerminalFailureProvisioningState(currentState)) {
    return nextState !== currentState;
  }
  return false;
}

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

interface MixedSecondaryRuntimeLaneState {
  laneId: string;
  providerId: 'opencode';
  member: TeamCreateRequest['members'][number];
  runId: string | null;
  state: 'queued' | 'launching' | 'finished';
  result: TeamRuntimeLaunchResult | null;
  warnings: string[];
  diagnostics: string[];
  launchScheduled?: boolean;
  queuedAtMs?: number;
  launchStartedAtMs?: number;
  launchFinishedAtMs?: number;
}

type LeadActivityState = 'active' | 'idle' | 'offline';

function applyAppManagedRuntimeSettingsPathEnv(
  env: NodeJS.ProcessEnv,
  settingsPath: string | null
): void {
  if (settingsPath) {
    env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV] = settingsPath;
  } else {
    delete env[CLAUDE_TEAM_RUNTIME_SETTINGS_PATH_ENV];
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

const OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX = 'opencode_bootstrap_checkin_retry_prompt_sent';

function getOpenCodeBootstrapCheckinRetryMarker(runId: string, runtimeSessionId: string): string {
  return `${OPENCODE_BOOTSTRAP_CHECKIN_RETRY_SENT_PREFIX}:${runId}:${runtimeSessionId}`;
}

interface PendingMemberRestartContext {
  requestedAt: string;
  desired: Pick<
    TeamCreateRequest['members'][number],
    'name' | 'role' | 'workflow' | 'isolation' | 'providerId' | 'model' | 'effort'
  >;
}

interface MemberSpawnInboxCursor {
  timestamp: string;
  messageId: string;
}

type LeadInboxMemberSpawnMessage = InboxMessage & { messageId: string };

function compareMemberSpawnInboxCursor(
  left: MemberSpawnInboxCursor,
  right: MemberSpawnInboxCursor
): number {
  const leftMs = Date.parse(left.timestamp);
  const rightMs = Date.parse(right.timestamp);
  const leftValid = Number.isFinite(leftMs);
  const rightValid = Number.isFinite(rightMs);

  if (leftValid && rightValid && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  if (leftValid !== rightValid) {
    return leftValid ? -1 : 1;
  }
  return left.messageId.localeCompare(right.messageId);
}

function toMemberSpawnInboxCursor(
  message: Pick<InboxMessage, 'timestamp' | 'messageId'>
): MemberSpawnInboxCursor | null {
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (!messageId) {
    return null;
  }
  return {
    timestamp: message.timestamp,
    messageId,
  };
}

function maxMemberSpawnInboxCursor(
  left: MemberSpawnInboxCursor | undefined,
  right: MemberSpawnInboxCursor
): MemberSpawnInboxCursor {
  if (!left) {
    return right;
  }
  return compareMemberSpawnInboxCursor(left, right) >= 0 ? left : right;
}

function isMemberSpawnHeartbeatTimestampNewer(
  previous: string | undefined,
  incoming: string | undefined
): boolean {
  const normalizedIncoming = incoming?.trim();
  if (!normalizedIncoming) {
    return false;
  }
  const normalizedPrevious = previous?.trim();
  if (!normalizedPrevious) {
    return true;
  }

  const previousMs = Date.parse(normalizedPrevious);
  const incomingMs = Date.parse(normalizedIncoming);
  if (Number.isFinite(previousMs) && Number.isFinite(incomingMs)) {
    return incomingMs > previousMs;
  }
  return normalizedIncoming > normalizedPrevious;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function ensureCwdExists(cwd: string): Promise<void> {
  await fs.promises.mkdir(cwd, { recursive: true });
  const stat = await fs.promises.stat(cwd);
  if (!stat.isDirectory()) {
    throw new Error('cwd must be a directory');
  }
}

/** @deprecated Use wrapAgentBlock from @shared/constants/agentBlocks instead. */
const wrapInAgentBlock = wrapAgentBlock;
function buildProvisioningTraceDetail(
  extras?: Pick<
    TeamProvisioningProgress,
    'pid' | 'error' | 'warnings' | 'configReady' | 'launchDiagnostics'
  >
): string | undefined {
  const parts = [
    extras?.pid != null ? `pid=${extras.pid}` : undefined,
    extras?.configReady === true ? 'configReady=true' : undefined,
    extras?.error ? `error=${extras.error}` : undefined,
    extras?.warnings?.length ? `warnings=${extras.warnings.join('; ')}` : undefined,
    extras?.launchDiagnostics?.length
      ? `launchDiagnostics=${extras.launchDiagnostics.length}`
      : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' | ') : undefined;
}

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

function extractLogsTail(
  stdoutBuffer: string | undefined,
  stderrBuffer: string | undefined
): string | undefined {
  const trimmed = buildCombinedLogs(stdoutBuffer, stderrBuffer).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.slice(-UI_LOGS_TAIL_LIMIT);
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
function extractCliLogsFromRun(run: ProvisioningRun): string | undefined {
  const claudeLogLines = Array.isArray(run.claudeLogLines) ? run.claudeLogLines : [];
  if (claudeLogLines.length > 0) {
    const joined = boundProgressLogLines(claudeLogLines).join('\n').trim();
    if (joined.length === 0) {
      return undefined;
    }
    return joined;
  }
  return extractLogsTail(run.stdoutBuffer, run.stderrBuffer);
}

interface RetainedClaudeLogsSnapshot {
  lines: string[];
  updatedAt?: string;
}

interface PersistedTranscriptClaudeLogsCacheEntry {
  transcriptPath: string;
  mtimeMs: number;
  size: number;
  snapshot: RetainedClaudeLogsSnapshot;
}

function buildRetainedClaudeLogsSnapshot(run: ProvisioningRun): RetainedClaudeLogsSnapshot | null {
  const claudeLogLines = Array.isArray(run.claudeLogLines) ? run.claudeLogLines : [];
  if (claudeLogLines.length > 0) {
    return {
      lines: boundProgressLogLines(claudeLogLines),
      updatedAt: run.claudeLogsUpdatedAt,
    };
  }

  const fallback = extractCliLogsFromRun(run);
  if (!fallback) {
    return null;
  }

  const lines = fallback
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return null;
  }

  return {
    lines: boundProgressLogLines(lines),
    updatedAt: run.claudeLogsUpdatedAt ?? run.progress.updatedAt,
  };
}

function sliceClaudeLogs(
  linesChronological: string[],
  updatedAt: string | undefined,
  query?: { offset?: number; limit?: number }
): { lines: string[]; total: number; hasMore: boolean; updatedAt?: string } {
  const offsetRaw = query?.offset ?? 0;
  const limitRaw = query?.limit ?? 100;
  const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.floor(offsetRaw)) : 0;
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(1000, Math.floor(limitRaw))) : 100;

  const total = linesChronological.length;
  if (total === 0) {
    return { lines: [], total: 0, hasMore: false, updatedAt };
  }

  const newestExclusive = Math.max(0, total - offset);
  const oldestInclusive = Math.max(0, newestExclusive - limit);
  const normalizeLine = (line: string): string => {
    // Back-compat: older builds prefixed every line with "[stdout] " / "[stderr] "
    if (line.startsWith('[stdout] ') && line !== '[stdout]') {
      return line.slice('[stdout] '.length);
    }
    if (line.startsWith('[stderr] ') && line !== '[stderr]') {
      return line.slice('[stderr] '.length);
    }
    return line;
  };

  const lines = linesChronological
    .slice(oldestInclusive, newestExclusive)
    .map(normalizeLine)
    .toReversed();

  return {
    lines,
    total,
    hasMore: oldestInclusive > 0,
    updatedAt,
  };
}

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

interface CachedProbeResult {
  cacheKey: string;
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
  cachedAtMs: number;
}

interface ProbeResult {
  claudePath: string;
  authSource: ProvisioningAuthSource;
  warning?: string;
}

const cachedProbeResults = new Map<string, CachedProbeResult>();
const probeInFlightByKey = new Map<string, Promise<ProbeResult | null>>();

function isTransientProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    lower.includes('timeout running:') ||
    lower.includes('did not complete') ||
    lower.includes('runtime status was unavailable') ||
    lower.includes('runtime status check did not complete') ||
    lower.includes('timed out') ||
    lower.includes('etimedout') ||
    lower.includes('econnreset') ||
    lower.includes('eai_again')
  );
}

function isBinaryProbeWarning(warning: string): boolean {
  const lower = warning.toLowerCase();
  return (
    (lower.includes('spawn ') && lower.includes(' enoent')) ||
    lower.includes('eacces') ||
    lower.includes('enoexec') ||
    lower.includes('bad cpu type in executable') ||
    lower.includes('image not found')
  );
}

interface PendingInboxRelayCandidate {
  recipient: string;
  sourceMessageId: string;
  normalizedText: string;
  normalizedSummary: string;
  queuedAtMs: number;
}

class InboxRelayInFlightTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InboxRelayInFlightTimeoutError';
  }
}

function isInboxRelayInFlightTimeoutError(error: unknown): error is InboxRelayInFlightTimeoutError {
  return error instanceof InboxRelayInFlightTimeoutError;
}

interface OpenCodeMemberInboxRelayResult {
  relayed: number;
  attempted: number;
  delivered: number;
  failed: number;
  lastDelivery?: OpenCodeMemberInboxDelivery;
  diagnostics?: string[];
}

interface LiveInboxRelayResult {
  kind: 'ignored' | 'native_lead' | 'native_member_noop' | 'opencode_member';
  relayed: number;
  diagnostics?: string[];
  lastDelivery?: OpenCodeMemberInboxDelivery;
}

interface OpenCodeMemberInboxRelayOptions {
  onlyMessageId?: string;
  source?: OpenCodeMemberMessageDeliverySource;
  deliveryMetadata?: {
    replyRecipient?: string;
    actionMode?: AgentActionMode;
    taskRefs?: TaskRef[];
  };
}

type MemberWorkSyncProofMissingRecoveryScheduler = (input: {
  teamName: string;
  memberName: string;
  originalMessageId: string;
  taskRefs?: TaskRef[];
  reason?: string;
}) => Promise<unknown> | unknown;

type MemberWorkSyncAcceptedReportChecker = (input: {
  teamName: string;
  memberName: string;
}) => Promise<boolean> | boolean;

export class TeamProvisioningService {
  private readonly runtimeLaneCoordinator = createTeamRuntimeLaneCoordinator();
  private readonly providerConnectionService = ProviderConnectionService.getInstance();

  private static readonly RECENT_CROSS_TEAM_DELIVERY_TTL_MS = 10 * 60 * 1000;
  private static readonly PENDING_INBOX_RELAY_TTL_MS = 2 * 60 * 1000;
  private static readonly SAME_TEAM_NATIVE_DELIVERY_GRACE_MS = 15_000;
  private static readonly SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS = 60_000;
  private static readonly SAME_TEAM_MATCH_WINDOW_MS = 30_000;
  private static readonly SAME_TEAM_RUN_START_SKEW_MS = 1_000;
  private static readonly SAME_TEAM_PERSIST_RETRY_MS = 2_000;
  private static readonly AGENT_RUNTIME_SNAPSHOT_CACHE_TTL_MS = 2_000;
  private static readonly PERSISTED_AGENT_RUNTIME_SNAPSHOT_CACHE_TTL_MS = 10_000;
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
  private static readonly RETAINED_PROVISIONING_PROGRESS_TTL_MS = 5 * 60_000;
  private static readonly OPENCODE_RUNTIME_DELIVERY_ADVISORY_EVENT_TTL_MS = 24 * 60 * 60_000;
  private static readonly OPENCODE_RUNTIME_DELIVERY_LEAD_NOTICE_TTL_MS = 24 * 60 * 60_000;
  private static readonly INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS = 2 * 60_000;
  /** Unreferenced runtime-adapter run state older than this is swept from memory. */
  private static readonly RUNTIME_ADAPTER_RUN_STATE_TTL_MS = 15 * 60_000;
  /** Minimum spacing between runtime-adapter run-state sweeps. */
  private static readonly RUNTIME_ADAPTER_RUN_STATE_SWEEP_INTERVAL_MS = 60_000;

  private readonly runs = new Map<string, ProvisioningRun>();
  private readonly provisioningRunByTeam = new Map<string, string>();
  private readonly aliveRunByTeam = new Map<string, string>();
  private readonly runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  private retainedProvisioningProgressByRunId: Map<string, TeamProvisioningProgress> | undefined =
    new Map<string, TeamProvisioningProgress>();
  private retainedProvisioningProgressTimersByRunId:
    | Map<string, ReturnType<typeof setTimeout>>
    | undefined = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly runtimeAdapterTraceLinesByRunId = new Map<string, string[]>();
  private readonly runtimeAdapterTraceKeyByRunId = new Map<string, string>();
  private lastRuntimeAdapterRunStateSweepAt = 0;
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
  private readonly cancelledRuntimeAdapterRunIds = new Set<string>();
  private stopAllTeamsGeneration = 0;
  private readonly transientProbeProcesses = new Set<ReturnType<typeof spawn>>();
  private readonly secondaryRuntimeRunByTeam = new Map<
    string,
    Map<
      string,
      { runId: string; providerId: 'opencode'; laneId: string; memberName: string; cwd?: string }
    >
  >();
  private readonly stoppingSecondaryRuntimeTeams = new Set<string>();
  private readonly retainedClaudeLogsByTeam = new Map<string, RetainedClaudeLogsSnapshot>();
  private readonly persistedTranscriptClaudeLogsCache = new Map<
    string,
    PersistedTranscriptClaudeLogsCacheEntry
  >();
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
  private readonly openCodeRuntimeDeliveryAdvisoryReviewTimers = new Map<string, NodeJS.Timeout>();
  private readonly openCodeRuntimeDeliveryAdvisoryEventSentAt = new Map<string, number>();
  private readonly openCodeRuntimeDeliveryLeadNoticeSentAt = new Map<string, number>();
  private readonly openCodeRuntimeDeliveryProofReader = new OpenCodeRuntimeDeliveryProofReader();
  private readonly openCodeVisibleReplyProofService: OpenCodeVisibleReplyProofService;
  private readonly openCodePromptDeliveryFollowUpPolicy = new OpenCodePromptDeliveryFollowUpPolicy({
    markFailedTerminal: (input) => this.markOpenCodePromptLedgerFailedTerminal(input),
    logEvent: (event, record, extra) => this.logOpenCodePromptDeliveryEvent(event, record, extra),
    scheduleWatchdog: (input) => this.scheduleOpenCodePromptDeliveryWatchdog(input),
    nowIso,
  });
  private readonly openCodePromptDeliveryWatchdogScheduler =
    new OpenCodePromptDeliveryWatchdogScheduler({
      canDeliverToTeamRuntime: (teamName) => this.canDeliverToOpenCodeRuntimeForTeam(teamName),
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
        this.resolveOpenCodeMemberDeliveryIdentity(input.teamName, input.memberName),
      isLaneActive: (input) => this.isOpenCodeRuntimeLaneIndexActive(input.teamName, input.laneId),
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
  private readonly recentSameTeamNativeFingerprints = new Map<
    string,
    NativeSameTeamFingerprint[]
  >();
  private readonly agentRuntimeSnapshotCache = new Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >();
  private readonly agentRuntimeResourceHistory = new TeamAgentRuntimeResourceHistory({
    historyLimit: TeamProvisioningService.AGENT_RUNTIME_RESOURCE_HISTORY_LIMIT,
    minSampleIntervalMs: TeamProvisioningService.RUNTIME_RESOURCE_SAMPLE_MIN_INTERVAL_MS,
  });
  private readonly runtimeProcessRowsForUsageSnapshotByTeam = new Map<
    string,
    RuntimeProcessRowsCacheEntry
  >();
  private readonly runtimeProcessUsageStatsCacheByPid = new Map<
    number,
    RuntimeProcessUsageStatsCacheEntry
  >();
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
  private readonly runtimeSnapshotCacheGenerationByTeam = new Map<string, number>();
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
  private readonly memberSpawnStatusesCacheGenerationByTeam = new Map<string, number>();
  private readonly launchStateStore = new TeamLaunchStateStore();
  private readonly launchFailureArtifactPackRunIds = new Set<string>();
  private readonly launchStateStoreQueue = new Map<string, Promise<unknown>>();
  private readonly launchStateWrittenRunIdByTeam = new Map<string, string>();
  private readonly failedOpenCodeSecondaryRetryInFlightByTeam = new Map<
    string,
    Promise<RetryFailedOpenCodeSecondaryLanesResult>
  >();
  private readonly memberLifecycleOperations = new Map<string, MemberLifecycleOperation>();
  private readonly memberLifecycleController = new TeamProvisioningMemberLifecycleController(
    this as unknown as TeamProvisioningMemberLifecycleHost
  );
  private memberRuntimeAdvisoryInvalidator:
    | ((teamName: string, memberName: string) => void)
    | null = null;
  private memberWorkSyncProofMissingRecoveryScheduler: MemberWorkSyncProofMissingRecoveryScheduler | null =
    null;
  private memberWorkSyncAcceptedReportChecker: MemberWorkSyncAcceptedReportChecker | null = null;
  private readonly memberLogsFinder: TeamMemberLogsFinder;
  private readonly transcriptProjectResolver: TeamTranscriptProjectResolver;
  private readonly taskActivityIntervalService = new TeamTaskActivityIntervalService();
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
  private inFlightResponses = new Set<string>();
  private readonly prepareForProvisioningInFlight = new Map<
    string,
    Promise<TeamProvisioningPrepareResult>
  >();
  private runtimeAdapterRegistry: TeamRuntimeAdapterRegistry | null = null;
  private controlApiBaseUrlResolver: (() => Promise<string | null>) | null = null;
  private workspaceTrustCoordinator: WorkspaceTrustCoordinator | null = null;
  private runtimeTurnSettledHookSettingsProvider:
    | ((input: { provider: RuntimeTurnSettledProvider }) => Promise<Record<string, unknown> | null>)
    | null = null;
  private runtimeTurnSettledEnvironmentProvider:
    | ((input: { provider: RuntimeTurnSettledProvider }) => Promise<Record<string, string> | null>)
    | null = null;
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
    this.memberLogsFinder = new TeamMemberLogsFinder(
      this.configReader,
      this.inboxReader,
      this.membersMetaStore
    );
    this.transcriptProjectResolver = new TeamTranscriptProjectResolver({
      getConfig: (teamName) => this.configReader.getConfigSnapshot(teamName),
    });
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
  ): ReturnType<typeof readCachedRuntimeProcessRowsForLiveRuntimeMetadata> {
    return readCachedRuntimeProcessRowsForLiveRuntimeMetadata({
      cached: this.runtimeProcessRowsForUsageSnapshotByTeam.get(teamName),
      runId,
      nowMs: Date.now(),
      processTableCacheTtlMs: TeamProvisioningService.RUNTIME_LIVENESS_PROCESS_TABLE_CACHE_TTL_MS,
      processTableFailureCacheTtlMs:
        TeamProvisioningService.RUNTIME_LIVENESS_PROCESS_TABLE_FAILURE_CACHE_TTL_MS,
    });
  }

  private buildRuntimeUsageProcessTrees(
    rootPids: readonly number[],
    processRows: readonly RuntimeTelemetryProcessTableRow[] | null,
    rootOwnersByPid?: ReadonlyMap<number, ReadonlySet<string>>
  ): Map<number, RuntimeUsageProcessTree> {
    return buildRuntimeUsageProcessTrees({
      rootPids,
      processRows,
      rootOwnersByPid,
      limits: {
        maxPidsPerRoot: TeamProvisioningService.MAX_RUNTIME_TREE_PIDS_PER_ROOT,
        maxPidsPerSnapshot: TeamProvisioningService.MAX_RUNTIME_USAGE_PIDS_PER_SNAPSHOT,
      },
      platform: process.platform,
    });
  }

  private buildRuntimeProcessLoadStats(
    input: Parameters<typeof buildRuntimeProcessLoadStats>[0]
  ): RuntimeProcessLoadStats | undefined {
    return buildRuntimeProcessLoadStats(input);
  }

  private recordAgentRuntimeResourceSample(
    input: Parameters<TeamAgentRuntimeResourceHistory['record']>[0]
  ): TeamAgentRuntimeResourceSample[] | undefined {
    return this.agentRuntimeResourceHistory.record(input);
  }

  private pruneAgentRuntimeResourceHistory(
    teamName: string,
    activeKeys: ReadonlySet<string>
  ): void {
    this.agentRuntimeResourceHistory.prune(teamName, activeKeys);
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

  private formatToolApprovalBody(
    ...args: Parameters<typeof formatToolApprovalBody>
  ): ReturnType<typeof formatToolApprovalBody> {
    return formatToolApprovalBody(...args);
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
    if (this.crashRepairedActivityIntervalsByTeam.has(teamName)) return true;
    const repairSnapshot = this.pendingCrashRepairSnapshotByTeam.has(teamName)
      ? this.pendingCrashRepairSnapshotByTeam.get(teamName)
      : (launchSnapshot ?? null);
    const result = this.taskActivityIntervalService.repairStaleIntervalsAfterCrash(
      teamName,
      repairSnapshot
    );
    if (result.failed) {
      if (!this.pendingCrashRepairSnapshotByTeam.has(teamName)) {
        this.pendingCrashRepairSnapshotByTeam.set(teamName, launchSnapshot ?? null);
      }
      return false;
    }
    this.pendingCrashRepairSnapshotByTeam.delete(teamName);
    this.crashRepairedActivityIntervalsByTeam.add(teamName);
    return true;
  }

  private async readTaskActivityRepairLaunchSnapshot(
    teamName: string
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    const [bootstrapSnapshot, launchSnapshot] = await Promise.all([
      readBootstrapLaunchSnapshot(teamName).catch(() => null),
      this.launchStateStore.read(teamName).catch(() => null),
    ]);
    return choosePreferredLaunchSnapshot(bootstrapSnapshot, launchSnapshot);
  }

  private writeLaunchFailureArtifactPackBestEffort(
    run: ProvisioningRun,
    options: {
      reason: string;
      launchSnapshot?: PersistedTeamLaunchSnapshot | null;
    }
  ): void {
    const key = `${run.teamName}:${run.runId}`;
    if (this.launchFailureArtifactPackRunIds.has(key)) return;
    this.launchFailureArtifactPackRunIds.add(key);

    const memberSpawnStatuses = Object.fromEntries(run.memberSpawnStatuses.entries());
    const request = run.request as Partial<TeamCreateRequest> | undefined;
    void writeTeamLaunchFailureArtifactPack({
      teamName: run.teamName,
      runId: run.runId,
      reason: options.reason,
      startedAt: run.startedAt,
      cwd: request?.cwd ?? '',
      pid: run.child?.pid ?? run.progress.pid ?? null,
      providerId: request?.providerId,
      providerBackendId: request?.providerBackendId,
      model: request?.model,
      expectedMembers: run.expectedMembers,
      effectiveMembers: run.allEffectiveMembers,
      progress: run.progress,
      launchSnapshot: options.launchSnapshot ?? null,
      launchDiagnostics: run.progress.launchDiagnostics ?? buildLaunchDiagnosticsFromRun(run),
      memberSpawnStatuses,
      cliLogs: extractCliLogsFromRun(run),
      progressTraceLines: run.provisioningTraceLines,
      runtimeAdapterTraceLines: this.runtimeAdapterTraceLinesByRunId.get(run.runId),
      flags: {
        isLaunch: run.isLaunch,
        provisioningComplete: run.provisioningComplete,
        deterministicBootstrap: run.deterministicBootstrap,
        workspaceTrustPreflight: run.workspaceTrustDiagnostics ?? null,
        processKilled: run.processKilled,
        finalizingByTimeout: run.finalizingByTimeout,
        cancelRequested: run.cancelRequested,
      },
    }).catch((error: unknown) => {
      this.launchFailureArtifactPackRunIds.delete(key);
      logger.warn(
        `[${run.teamName}] Failed to write launch failure artifact pack: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  async repairStaleTaskActivityIntervalsBeforeSnapshot(teamName: string): Promise<void> {
    if (this.crashRepairedActivityIntervalsByTeam.has(teamName)) {
      return;
    }

    const runId = this.getTrackedRunId(teamName);
    if (runId && this.runs.has(runId)) {
      return;
    }

    const repairSnapshot = await this.readTaskActivityRepairLaunchSnapshot(teamName);
    const repaired = this.repairStaleTaskActivityIntervalsOnce(teamName, repairSnapshot);
    if (!repaired) {
      throw new Error(`Task activity interval repair failed before snapshot for team ${teamName}`);
    }
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

  private async readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory> {
    const [config, teamMeta, metaMembers] = await Promise.all([
      this.readConfigForObservation(teamName).catch(() => null),
      this.teamMetaStore.getMeta(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    return { config, teamMeta, metaMembers };
  }

  private getRuntimeSnapshotCacheGeneration(teamName: string): number {
    return this.runtimeSnapshotCacheGenerationByTeam.get(teamName) ?? 0;
  }

  private getMemberSpawnStatusesCacheGeneration(teamName: string): number {
    return this.memberSpawnStatusesCacheGenerationByTeam.get(teamName) ?? 0;
  }

  private invalidateMemberSpawnStatusesCache(teamName: string): void {
    this.memberSpawnStatusesCacheGenerationByTeam.set(
      teamName,
      this.getMemberSpawnStatusesCacheGeneration(teamName) + 1
    );
    this.memberSpawnStatusesSnapshotCache.delete(teamName);
    this.memberSpawnStatusesInFlightByTeam.delete(teamName);
  }

  private invalidateRuntimeSnapshotCaches(teamName: string): void {
    this.runtimeSnapshotCacheGenerationByTeam.set(
      teamName,
      this.getRuntimeSnapshotCacheGeneration(teamName) + 1
    );
    this.agentRuntimeSnapshotCache.delete(teamName);
    this.liveTeamAgentRuntimeMetadataCache.delete(teamName);
    this.persistedTeamConfigCache.delete(teamName);
    // Keep in-flight runtime probes alive. Active teams can invalidate runtime
    // caches faster than expensive process-table/snapshot probes complete; the
    // generation guard in each builder prevents stale results from being cached.
    // Process table rows are TTL-bound. Resource telemetry can use the longer
    // TTL, while liveness only reuses rows through a short age gate.
  }

  private cloneMemberSpawnStatusesSnapshot(
    snapshot: MemberSpawnStatusesSnapshot
  ): MemberSpawnStatusesSnapshot {
    return {
      ...snapshot,
      statuses: Object.fromEntries(
        Object.entries(snapshot.statuses).map(([memberName, entry]) => [
          memberName,
          {
            ...entry,
            ...(entry.pendingPermissionRequestIds
              ? { pendingPermissionRequestIds: [...entry.pendingPermissionRequestIds] }
              : {}),
          },
        ])
      ),
      ...(snapshot.expectedMembers ? { expectedMembers: [...snapshot.expectedMembers] } : {}),
      ...(snapshot.summary ? { summary: { ...snapshot.summary } } : {}),
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
    provider:
      | ((input: {
          provider: RuntimeTurnSettledProvider;
        }) => Promise<Record<string, unknown> | null>)
      | null
  ): void {
    this.runtimeTurnSettledHookSettingsProvider = provider;
  }

  setRuntimeTurnSettledEnvironmentProvider(
    provider:
      | ((input: {
          provider: RuntimeTurnSettledProvider;
        }) => Promise<Record<string, string> | null>)
      | null
  ): void {
    this.runtimeTurnSettledEnvironmentProvider = provider;
  }

  private toWorkspaceTrustProvider(providerId: TeamProviderId): WorkspaceTrustProvider {
    return toWorkspaceTrustProviderHelper(providerId);
  }

  private collectWorkspaceTrustProviders(input: {
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): WorkspaceTrustProvider[] {
    return collectWorkspaceTrustProvidersHelper({
      leadProviderId: resolveTeamProviderId(input.leadProviderId),
      memberProviderIds: input.members.map(
        (member) =>
          normalizeTeamMemberProviderId(member.providerId) ??
          normalizeTeamMemberProviderId((member as { provider?: unknown }).provider)
      ),
    });
  }

  private async resolveWorkspaceTrustGitRoot(cwd: string): Promise<string | null> {
    return resolveWorkspaceTrustGitRootHelper(cwd);
  }

  private async collectWorkspaceTrustWorkspaces(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
  }): Promise<WorkspaceTrustWorkspace[]> {
    return collectWorkspaceTrustWorkspacesHelper(input);
  }

  private applyWorkspaceTrustArgPatches(input: {
    args: string[];
    patches: WorkspaceTrustLaunchArgPatch[];
    targetProvider: TeamProviderId;
    targetSurface: WorkspaceTrustLaunchArgTargetSurface;
  }): string[] {
    return applyWorkspaceTrustArgPatchesHelper(input);
  }

  private createDefaultModelWorkspaceTrustProviderArgsResolver(
    plan: Pick<WorkspaceTrustArgsOnlyPlanResult, 'launchArgPatches'>
  ): WorkspaceTrustProviderArgsResolver {
    return createDefaultModelWorkspaceTrustProviderArgsResolverHelper(plan);
  }

  private async planWorkspaceTrustArgsOnlySafely(
    request: WorkspaceTrustArgsOnlyPlanRequest
  ): Promise<WorkspaceTrustArgsOnlyPlanResult> {
    return planWorkspaceTrustArgsOnlySafelyHelper({
      coordinator: this.workspaceTrustCoordinator,
      request,
    });
  }

  private async planWorkspaceTrustFullSafely(
    request: WorkspaceTrustFullPlanRequest
  ): Promise<WorkspaceTrustFullPlanResult | null> {
    return planWorkspaceTrustFullSafelyHelper({
      coordinator: this.workspaceTrustCoordinator,
      request,
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

  private async buildRuntimeTurnSettledHookSettingsArgs(
    providerId: TeamProviderId
  ): Promise<string[]> {
    const settings = await this.buildRuntimeTurnSettledHookSettingsObject(providerId);
    return settings ? ['--settings', JSON.stringify(settings)] : [];
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

  private async buildRuntimeTurnSettledHookSettingsObject(
    providerId: TeamProviderId
  ): Promise<TeamRuntimeSettingsJson | null> {
    if (providerId !== 'anthropic' || !this.runtimeTurnSettledHookSettingsProvider) {
      return null;
    }

    try {
      const settings = await this.runtimeTurnSettledHookSettingsProvider({ provider: 'claude' });
      return settings ?? null;
    } catch (error) {
      logger.warn(
        `Failed to build member work sync Stop hook settings: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return null;
    }
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
        this.buildRuntimeTurnSettledHookSettingsArgs(providerId),
      buildRuntimeTurnSettledHookSettingsObject: (providerId) =>
        this.buildRuntimeTurnSettledHookSettingsObject(providerId),
    });
  }

  private async buildRuntimeTurnSettledEnvironment(
    providerId: TeamProviderId
  ): Promise<Record<string, string>> {
    if (providerId !== 'codex' || !this.runtimeTurnSettledEnvironmentProvider) {
      return {};
    }

    try {
      return (await this.runtimeTurnSettledEnvironmentProvider({ provider: 'codex' })) ?? {};
    } catch (error) {
      logger.warn(
        `Failed to build member work sync runtime turn-settled environment: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return {};
    }
  }

  private async buildRuntimeTurnSettledEnvironmentForMembers(
    primaryProviderId: TeamProviderId | undefined,
    memberSpecs: TeamCreateRequest['members']
  ): Promise<Record<string, string>> {
    const resolvedPrimaryProviderId = resolveTeamProviderId(primaryProviderId);
    const needsCodexTurnSettledEnv = memberSpecs.some((member) => {
      const configuredProviderId = normalizeTeamMemberProviderId(member.providerId);
      const inferredProviderId = inferTeamProviderIdFromModel(member.model);
      return (
        resolvedPrimaryProviderId === 'codex' ||
        configuredProviderId === 'codex' ||
        inferredProviderId === 'codex'
      );
    });

    if (!needsCodexTurnSettledEnv) {
      return {};
    }

    return this.buildRuntimeTurnSettledEnvironment('codex');
  }

  private async readRuntimeProviderLaunchFacts(params: {
    claudePath: string;
    cwd: string;
    providerId: TeamProviderId;
    env: NodeJS.ProcessEnv;
    providerArgs?: string[];
    limitContext?: boolean;
  }): Promise<RuntimeProviderLaunchFacts> {
    const providerArgs = params.providerArgs ?? [];
    const modelListPromise = execCli(
      params.claudePath,
      buildProviderControlPlaneCliCommandArgs(providerArgs, [
        'model',
        'list',
        '--json',
        '--provider',
        params.providerId,
      ]),
      {
        cwd: params.cwd,
        env: params.env,
        timeout: PROVIDER_MODEL_LIST_TIMEOUT_MS,
      }
    );
    const runtimeStatusPromise =
      params.providerId === 'codex' || params.providerId === 'anthropic'
        ? execCli(
            params.claudePath,
            buildProviderControlPlaneCliCommandArgs(providerArgs, [
              'runtime',
              'status',
              '--json',
              '--provider',
              params.providerId,
            ]),
            {
              cwd: params.cwd,
              env: params.env,
              timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
            }
          )
        : null;

    const [modelListResult, runtimeStatusResult] = await Promise.allSettled([
      modelListPromise,
      runtimeStatusPromise,
    ]);

    let defaultModel: string | null = null;
    let modelIds = new Set<string>();
    let modelListParsed = false;
    if (modelListResult.status === 'fulfilled') {
      try {
        const parsed = extractJsonObjectFromCli<ProviderModelListCommandResponse>(
          modelListResult.value.stdout
        );
        modelListParsed = true;
        const provider = parsed.providers?.[params.providerId];
        defaultModel =
          typeof provider?.defaultModel === 'string' && provider.defaultModel.trim().length > 0
            ? provider.defaultModel.trim()
            : null;
        modelIds = normalizeProviderModelListModels(provider);
      } catch (error) {
        logger.warn(
          `[${params.providerId}] Failed to parse runtime model list for launch validation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    let runtimeCapabilities: CliProviderRuntimeCapabilities | null = null;
    let modelCatalog: CliProviderModelCatalog | null = null;
    let providerStatus: RuntimeProviderLaunchFacts['providerStatus'] = null;
    if (
      runtimeStatusResult.status === 'fulfilled' &&
      runtimeStatusResult.value &&
      typeof runtimeStatusResult.value.stdout === 'string'
    ) {
      try {
        const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(
          runtimeStatusResult.value.stdout
        );
        const parsedProviderStatus = parsed.providers?.[params.providerId] ?? null;
        providerStatus = parsedProviderStatus
          ? {
              ...parsedProviderStatus,
              providerId: parsedProviderStatus.providerId ?? params.providerId,
            }
          : null;
        runtimeCapabilities = providerStatus?.runtimeCapabilities ?? null;
        modelCatalog =
          providerStatus?.modelCatalog?.providerId === params.providerId
            ? providerStatus.modelCatalog
            : null;
      } catch (error) {
        logger.warn(
          `[${params.providerId}] Failed to parse runtime capabilities for launch validation: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    if (modelCatalog) {
      addModelCatalogLaunchModels(modelIds, modelCatalog);
      defaultModel = modelCatalog.defaultLaunchModel?.trim() || defaultModel;
    }

    if (
      params.providerId === 'codex' &&
      !isUsableCodexModelCatalog(modelCatalog) &&
      runtimeCapabilities?.modelCatalog?.dynamic === true
    ) {
      const codexCatalog = await this.providerConnectionService.getCodexModelCatalog({
        cwd: params.cwd,
      });
      if (isUsableCodexModelCatalog(codexCatalog)) {
        addModelCatalogLaunchModels(modelIds, codexCatalog);

        modelCatalog = codexCatalog;
        defaultModel = codexCatalog.defaultLaunchModel?.trim() || defaultModel;
      }
    }

    return {
      defaultModel:
        params.providerId === 'anthropic'
          ? resolveAnthropicLaunchModel({
              limitContext: params.limitContext === true,
              availableLaunchModels:
                modelCatalog?.models.map((model) => model.launchModel) ?? modelIds,
              defaultLaunchModel: defaultModel,
            })
          : defaultModel,
      modelIds,
      modelListParsed,
      modelCatalog,
      runtimeCapabilities,
      providerStatus,
    };
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
    const leadProviderId = resolveTeamProviderId(params.request.providerId);
    const factsByProvider = new Map<TeamProviderId, RuntimeProviderLaunchFacts>();
    const getFacts = async (providerId: TeamProviderId): Promise<RuntimeProviderLaunchFacts> => {
      const cached = factsByProvider.get(providerId);
      if (cached) {
        return cached;
      }
      const facts = await this.readRuntimeProviderLaunchFacts({
        claudePath: params.claudePath,
        cwd: params.cwd,
        providerId,
        env: params.env,
        providerArgs: params.providerArgsByProvider?.get(providerId),
        limitContext: params.request.limitContext,
      });
      factsByProvider.set(providerId, facts);
      return facts;
    };

    const leadFacts = await getFacts(leadProviderId);
    this.validateRuntimeLaunchSelection({
      actorLabel: 'Team lead',
      providerId: leadProviderId,
      model: params.request.model,
      effort: params.request.effort,
      fastMode: params.request.fastMode,
      limitContext: params.request.limitContext,
      facts: leadFacts,
    });

    for (const member of params.effectiveMembers) {
      const memberProviderId = resolveTeamProviderId(member.providerId);
      const memberFacts = await getFacts(memberProviderId);
      this.validateRuntimeLaunchSelection({
        actorLabel: `Member ${member.name}`,
        providerId: memberProviderId,
        model: member.model,
        effort: member.effort,
        limitContext: params.request.limitContext,
        facts: memberFacts,
      });
    }

    return this.buildProviderModelLaunchIdentity({
      request: params.request,
      facts: leadFacts,
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
    const request: Pick<
      TeamCreateRequest,
      'providerId' | 'providerBackendId' | 'model' | 'effort' | 'fastMode' | 'limitContext'
    > = {
      providerId: input.providerId,
      ...(input.providerBackendId ? { providerBackendId: input.providerBackendId } : {}),
      ...(input.memberSpec.model ? { model: input.memberSpec.model } : {}),
      ...(input.memberSpec.effort ? { effort: input.memberSpec.effort } : {}),
      ...(input.memberSpec.fastMode ? { fastMode: input.memberSpec.fastMode } : {}),
      ...(input.run.request.limitContext ? { limitContext: input.run.request.limitContext } : {}),
    };
    const facts = await this.readRuntimeProviderLaunchFacts({
      claudePath: input.claudePath,
      cwd: input.cwd,
      providerId: input.providerId,
      env: input.provisioningEnv.env,
      providerArgs: input.provisioningEnv.providerArgs,
      limitContext: input.run.request.limitContext,
    });
    this.validateRuntimeLaunchSelection({
      actorLabel: `Member ${input.memberSpec.name}`,
      providerId: input.providerId,
      model: input.memberSpec.model,
      effort: input.memberSpec.effort,
      fastMode: input.memberSpec.fastMode,
      limitContext: input.run.request.limitContext,
      facts,
    });
    return this.buildProviderModelLaunchIdentity({
      request,
      facts,
    });
  }

  async getClaudeLogs(
    teamName: string,
    query?: { offset?: number; limit?: number }
  ): Promise<{ lines: string[]; total: number; hasMore: boolean; updatedAt?: string }> {
    const runId = this.getTrackedRunId(teamName);
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

  private getProvisioningRunId(teamName: string): string | null {
    return this.provisioningRunByTeam.get(teamName) ?? null;
  }

  private getResolvableProvisioningRunId(teamName: string): string | null {
    const runId = this.getProvisioningRunId(teamName);
    if (!runId) {
      return null;
    }
    if (this.runs.has(runId) || this.runtimeAdapterProgressByRunId.has(runId)) {
      return runId;
    }
    if (this.provisioningRunByTeam.get(teamName) === runId) {
      this.provisioningRunByTeam.delete(teamName);
    }
    logger.debug(`[${teamName}] Cleared stale provisioning run id before launch: ${runId}`);
    return null;
  }

  private getAliveRunId(teamName: string): string | null {
    return this.aliveRunByTeam.get(teamName) ?? null;
  }

  private setAliveRunId(teamName: string, runId: string): void {
    if (!teamName || !runId || this.aliveRunByTeam.get(teamName) === runId) {
      return;
    }
    this.aliveRunByTeam.set(teamName, runId);
    notifyTeamWatchScopeChanged();
  }

  private deleteAliveRunId(teamName: string): void {
    if (this.aliveRunByTeam.delete(teamName)) {
      notifyTeamWatchScopeChanged();
    }
  }

  /**
   * Snapshot of teams that currently have a live runtime run. Used to keep the
   * file-watch scope covering running teams (read-only; the map is maintained as
   * runs start and stop).
   */
  getAliveTeamNames(): string[] {
    return [...this.aliveRunByTeam.keys()];
  }

  private getTrackedRunId(teamName: string): string | null {
    return this.getProvisioningRunId(teamName) ?? this.getAliveRunId(teamName);
  }

  private getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number {
    if (runId || this.runtimeAdapterRunByTeam.has(teamName)) {
      return TeamProvisioningService.AGENT_RUNTIME_SNAPSHOT_CACHE_TTL_MS;
    }
    return TeamProvisioningService.PERSISTED_AGENT_RUNTIME_SNAPSHOT_CACHE_TTL_MS;
  }

  private canDeliverToTrackedRuntimeRun(teamName: string, runId: string): boolean {
    // Terminal adapter progress is evicted to the retained map, so consult
    // both: a residual team-map id pointing at a finished run must stay
    // non-deliverable.
    const runtimeProgress =
      this.runtimeAdapterProgressByRunId.get(runId) ??
      this.getRetainedProvisioningProgressMap().get(runId);
    if (
      runtimeProgress &&
      ['disconnected', 'failed', 'cancelled'].includes(runtimeProgress.state)
    ) {
      return false;
    }
    const run = this.runs.get(runId);
    if (
      run &&
      (run.processKilled ||
        run.cancelRequested ||
        ['disconnected', 'failed', 'cancelled'].includes(run.progress.state))
    ) {
      return false;
    }
    return (
      this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId ||
      this.provisioningRunByTeam.get(teamName) === runId ||
      this.aliveRunByTeam.get(teamName) === runId
    );
  }

  private resolveDeliverableTrackedRuntimeRunId(teamName: string): string | null {
    const candidates = Array.from(
      new Set(
        [
          this.provisioningRunByTeam.get(teamName),
          this.aliveRunByTeam.get(teamName),
          this.runtimeAdapterRunByTeam.get(teamName)?.runId,
        ].filter((runId): runId is string => typeof runId === 'string' && runId.trim() !== '')
      )
    );
    for (const runId of candidates) {
      if (this.canDeliverToTrackedRuntimeRun(teamName, runId)) {
        return runId;
      }
    }
    return null;
  }

  private canDeliverToOpenCodeRuntimeForTeam(teamName: string): boolean {
    if (this.isTeamAlive(teamName)) {
      return true;
    }
    return this.hasAlivePersistedTeamProcess(teamName);
  }

  private canAttemptCommittedOpenCodeSessionRecovery(teamName: string): boolean {
    if (this.canDeliverToOpenCodeRuntimeForTeam(teamName)) {
      return true;
    }
    return !this.hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName);
  }

  private hasAlivePersistedTeamProcess(teamName: string): boolean {
    const parsed = this.readPersistedTeamProcessRows(teamName);
    if (!Array.isArray(parsed)) {
      return false;
    }
    return parsed.some((row) => {
      if (!row || typeof row !== 'object') {
        return false;
      }
      const processRow = row as { pid?: unknown; stoppedAt?: unknown };
      return (
        typeof processRow.pid === 'number' &&
        Number.isFinite(processRow.pid) &&
        processRow.stoppedAt == null &&
        isProcessAlive(processRow.pid)
      );
    });
  }

  private hasOnlyExplicitlyStoppedPersistedTeamProcesses(teamName: string): boolean {
    const parsed = this.readPersistedTeamProcessRows(teamName);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return false;
    }
    return parsed.every((row) => {
      if (!row || typeof row !== 'object') {
        return false;
      }
      return (row as { stoppedAt?: unknown }).stoppedAt != null;
    });
  }

  private readPersistedTeamProcessRows(teamName: string): unknown[] | null {
    const processesPath = path.join(getTeamsBasePath(), teamName, 'processes.json');
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(processesPath, 'utf8')) as unknown;
    } catch {
      return null;
    }
    if (!Array.isArray(parsed)) {
      return null;
    }
    return parsed;
  }

  private cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName: string): void {
    void this.stopOpenCodeRuntimeLanesForStoppedTeam(teamName).catch((error) => {
      logger.warn(
        `[${teamName}] Failed to clean up stopped-team OpenCode runtime lanes: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
  }

  private stopOpenCodeRuntimeLanesForStoppedTeam(teamName: string): Promise<number> {
    const existing = this.stoppedTeamOpenCodeRuntimeCleanupInFlight.get(teamName);
    if (existing) {
      return existing;
    }
    const cleanup = this.stopOpenCodeRuntimeLanesForStoppedTeamInternal(teamName).finally(() => {
      if (this.stoppedTeamOpenCodeRuntimeCleanupInFlight.get(teamName) === cleanup) {
        this.stoppedTeamOpenCodeRuntimeCleanupInFlight.delete(teamName);
      }
    });
    this.stoppedTeamOpenCodeRuntimeCleanupInFlight.set(teamName, cleanup);
    return cleanup;
  }

  private async stopOpenCodeRuntimeLanesForStoppedTeamInternal(teamName: string): Promise<number> {
    if (this.canDeliverToOpenCodeRuntimeForTeam(teamName)) {
      return 0;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    const activeLaneIds = Object.entries(laneIndex?.lanes ?? {})
      .filter(([, entry]) => entry.state === 'active')
      .map(([laneId]) => laneId)
      .sort((left, right) => left.localeCompare(right));
    if (activeLaneIds.length === 0) {
      return 0;
    }

    const adapter = this.getOpenCodeRuntimeAdapter();
    const previousLaunchState = await this.launchStateStore.read(teamName).catch(() => null);
    const [config, metaMembers] = await Promise.all([
      this.readConfigForObservation(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    const evidenceReader = new OpenCodeRuntimeManifestEvidenceReader({
      teamsBasePath: getTeamsBasePath(),
    });
    let stopped = 0;
    let cleaned = 0;
    for (const laneId of activeLaneIds) {
      const evidence = await evidenceReader.read(teamName, laneId).catch(() => null);
      const runId = evidence?.activeRunId?.trim() || null;
      if (adapter && runId) {
        try {
          await adapter.stop({
            runId,
            laneId,
            teamName,
            cwd: this.resolveOpenCodeRuntimeLaneCleanupCwd(teamName, laneId, config, metaMembers),
            providerId: 'opencode',
            reason: 'cleanup',
            previousLaunchState,
            force: true,
          });
          stopped += 1;
        } catch (error) {
          logger.warn(
            `[${teamName}] Failed to stop orphaned OpenCode lane ${laneId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
          continue;
        }
      } else if (runId) {
        logger.warn(
          `[${teamName}] OpenCode lane ${laneId} belongs to stopped team, but runtime adapter is unavailable.`
        );
        continue;
      } else if (!runId) {
        const pidStopResult = this.tryStopPersistedOpenCodeRuntimePidForStoppedLane({
          teamName,
          laneId,
          previousLaunchState,
        });
        if (pidStopResult === 'unsafe') {
          continue;
        }
      }

      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId,
      }).catch(() => undefined);
      cleaned += 1;
      this.deleteSecondaryRuntimeRun(teamName, laneId);
      if (laneId === 'primary') {
        this.runtimeAdapterRunByTeam.delete(teamName);
        this.deleteAliveRunId(teamName);
        this.provisioningRunByTeam.delete(teamName);
        this.invalidateRuntimeSnapshotCaches(teamName);
      }
    }
    if (cleaned > 0) {
      this.cleanedStoppedTeamOpenCodeRuntimeLanes.add(teamName);
    }
    return stopped;
  }

  private tryStopPersistedOpenCodeRuntimePidForStoppedLane(input: {
    teamName: string;
    laneId: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): 'stopped' | 'no_pid' | 'unsafe' {
    const persistedMember = Object.values(input.previousLaunchState?.members ?? {}).find(
      (member) => member.providerId === 'opencode' && member.laneId === input.laneId
    );
    if (!persistedMember) {
      return 'no_pid';
    }
    const pid = persistedMember.runtimePid;
    if (typeof pid !== 'number' || !Number.isFinite(pid) || pid <= 0) {
      return 'no_pid';
    }
    const command = this.readProcessCommandByPid(pid);
    if (!command) {
      return 'no_pid';
    }
    const persistedProcessCommand = (persistedMember as { processCommand?: unknown })
      .processCommand;
    const expectedCommand =
      typeof persistedProcessCommand === 'string' ? persistedProcessCommand.trim() : '';
    if (expectedCommand && command !== expectedCommand) {
      logger.warn(
        `[${input.teamName}] Refusing to stop persisted OpenCode pid ${pid} for lane ${input.laneId}: process command changed.`
      );
      return 'unsafe';
    }
    if (!this.isOpenCodeServeCommand(command)) {
      logger.warn(
        `[${input.teamName}] Refusing to stop persisted OpenCode pid ${pid} for lane ${input.laneId}: process is not opencode serve.`
      );
      return 'unsafe';
    }
    try {
      killProcessByPid(pid);
      logger.info(
        `[${input.teamName}] Killed orphaned OpenCode runtime pid=${pid} for stopped lane ${input.laneId}`
      );
      return 'stopped';
    } catch (error) {
      logger.warn(
        `[${input.teamName}] Failed to kill orphaned OpenCode runtime pid=${pid} for stopped lane ${
          input.laneId
        }: ${error instanceof Error ? error.message : String(error)}`
      );
      return 'unsafe';
    }
  }

  private readProcessCommandByPid(pid: number): string | null {
    if (process.platform === 'win32') {
      try {
        return (
          listWindowsProcessTableSync()
            .find((row) => row.pid === pid)
            ?.command?.trim() || null
        );
      } catch {
        return null;
      }
    }
    try {
      return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      return null;
    }
  }

  private isOpenCodeServeCommand(command: string): boolean {
    return /(^|[/\\\s])opencode(?:\.exe)?(\s|$)/i.test(command) && /\sserve(\s|$)/i.test(command);
  }

  private resolveOpenCodeRuntimeLaneCleanupCwd(
    teamName: string,
    laneId: string,
    config: TeamConfig | null,
    metaMembers: readonly TeamMember[]
  ): string | undefined {
    const projectPath = config?.projectPath?.trim() || this.readPersistedTeamProjectPath(teamName);
    const memberName = this.extractOpenCodeRuntimeLaneMemberName(laneId);
    if (!memberName) {
      return projectPath || undefined;
    }
    const normalized = memberName.toLowerCase();
    const configMember = config?.members?.find(
      (member) => member.name?.trim().toLowerCase() === normalized
    );
    const metaMember = metaMembers.find(
      (member) => member.name?.trim().toLowerCase() === normalized
    );
    return metaMember?.cwd?.trim() || configMember?.cwd?.trim() || projectPath || undefined;
  }

  private extractOpenCodeRuntimeLaneMemberName(laneId: string): string | null {
    return extractOpenCodeRuntimeLaneMemberName(laneId);
  }

  private getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null {
    if (!this.runtimeAdapterRegistry?.has('opencode')) {
      return null;
    }
    return this.runtimeAdapterRegistry.get('opencode');
  }

  private getOpenCodeRuntimeMessageAdapter(): OpenCodeRuntimeMessageAdapter | null {
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter || !('sendMessageToMember' in adapter)) {
      return null;
    }
    return adapter as OpenCodeRuntimeMessageAdapter;
  }

  private getOpenCodeRuntimePermissionListingAdapter(): OpenCodeRuntimePermissionListingAdapter | null {
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter || typeof adapter.listRuntimePermissions !== 'function') {
      return null;
    }
    return adapter as OpenCodeRuntimePermissionListingAdapter;
  }

  private resolveRuntimeRecipientProviderIdFromSources(
    memberName: string,
    config: TeamConfig | null | undefined,
    metaMembers: readonly TeamMember[]
  ): TeamProviderId | undefined {
    const normalizedMemberName = memberName.trim().toLowerCase();
    if (!normalizedMemberName) {
      return undefined;
    }
    const configMember = config?.members?.find(
      (member) => member.name?.trim().toLowerCase() === normalizedMemberName
    );
    const metaMember = metaMembers.find(
      (member) => member.name?.trim().toLowerCase() === normalizedMemberName
    );
    const configProvider = (configMember as { provider?: unknown } | undefined)?.provider;
    const metaProvider = (metaMember as { provider?: unknown } | undefined)?.provider;
    if (
      !configMember &&
      !metaMember &&
      resolveOpenCodeSoloRuntimeRecipientProviderId({
        memberName: normalizedMemberName,
        config,
        metaMembers,
      }) === 'opencode'
    ) {
      return 'opencode';
    }
    return (
      normalizeTeamProviderLike(metaMember?.providerId) ??
      normalizeTeamProviderLike(metaProvider) ??
      normalizeTeamProviderLike(configMember?.providerId) ??
      normalizeTeamProviderLike(configProvider) ??
      inferTeamProviderIdFromModel(metaMember?.model ?? configMember?.model)
    );
  }

  private isOpenCodeRuntimeRecipientFromSources(
    memberName: string,
    config: TeamConfig | null | undefined,
    metaMembers: readonly TeamMember[]
  ): boolean {
    return (
      this.resolveRuntimeRecipientProviderIdFromSources(memberName, config, metaMembers) ===
      'opencode'
    );
  }

  async resolveRuntimeRecipientProviderId(
    teamName: string,
    memberName: string
  ): Promise<TeamProviderId | undefined> {
    const normalizedMemberName = memberName.trim().toLowerCase();
    if (!normalizedMemberName) {
      return undefined;
    }

    const [config, metaMembers] = await Promise.all([
      this.readConfigSnapshot(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    return this.resolveRuntimeRecipientProviderIdFromSources(
      normalizedMemberName,
      config,
      metaMembers
    );
  }

  async isOpenCodeRuntimeRecipient(teamName: string, memberName: string): Promise<boolean> {
    return (await this.resolveRuntimeRecipientProviderId(teamName, memberName)) === 'opencode';
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
    return isOpenCodeDeliveryResponseReadCommitAllowed({
      ...input,
      hasAcceptedMemberWorkSyncReport: (report) => this.hasAcceptedMemberWorkSyncReport(report),
      taskRefsIncludeAll: openCodeTaskRefsIncludeAllValue,
    });
  }

  private async isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input: {
    teamName: string;
    memberName: string;
    workSyncIntent?: OpenCodeTeamRuntimeMessageInput['workSyncIntent'];
    responseObservation?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>;
  }): Promise<boolean> {
    return isLegacyOpenCodeMemberWorkSyncReadCommitAllowed({
      ...input,
      hasAcceptedMemberWorkSyncReport: (report) => this.hasAcceptedMemberWorkSyncReport(report),
    });
  }

  private getOpenCodeDeliveryPendingReason(input: {
    responseState?: NonNullable<OpenCodeTeamRuntimeMessageResult['responseObservation']>['state'];
    actionMode?: AgentActionMode | null;
    taskRefs?: TaskRef[];
    visibleReply?: OpenCodeVisibleReplyProof | null;
    ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  }): string {
    return getOpenCodeDeliveryPendingReason({
      ...input,
      taskRefsIncludeAll: openCodeTaskRefsIncludeAllValue,
    });
  }

  private async markOpenCodeAcceptedDeliveryMissingPromptProofForRetry(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const reason = 'opencode_prompt_acceptance_unknown_missing_runtime_prompt_id';
    const now = nowIso();
    const ledgerRecord = await input.ledger.markAcceptanceUnknown({
      id: input.ledgerRecord.id,
      reason,
      nextAttemptAt: now,
      diagnostics: ['opencode_accepted_prompt_missing_runtime_prompt_id_recovered'],
      markedAt: now,
    });
    this.logOpenCodePromptDeliveryEvent('opencode_prompt_delivery_retry_scheduled', ledgerRecord, {
      acceptanceUnknown: true,
      recoveredLegacyAcceptedWithoutPromptProof: true,
      ...input.eventContext,
      reason,
    });
    return ledgerRecord;
  }

  private async requeueOpenCodeNoAssistantTerminalDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    if (!isOpenCodeNoAssistantTerminalDeliveryFailure(input.ledgerRecord)) {
      return input.ledgerRecord;
    }

    const scheduledAt = nowIso();
    const requeued = await input.ledger.markNextAttemptScheduled({
      id: input.ledgerRecord.id,
      status: 'retry_scheduled',
      nextAttemptAt: scheduledAt,
      reason: 'opencode_prompt_delivery_requeued_after_terminal_no_assistant_response',
      scheduledAt,
    });
    logger.info(
      'opencode_prompt_delivery_requeued_after_terminal_no_assistant_response',
      JSON.stringify({
        teamName: requeued.teamName,
        memberName: requeued.memberName,
        laneId: requeued.laneId,
        runId: requeued.runId,
        inboxMessageId: requeued.inboxMessageId,
        attempts: requeued.attempts,
        maxAttempts: requeued.maxAttempts,
      })
    );
    return requeued;
  }

  private async requeueOpenCodeRuntimeManifestWatermarkDeliveryIfNeeded(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    if (
      input.ledgerRecord.status !== 'failed_terminal' ||
      input.ledgerRecord.inboxReadCommittedAt ||
      !isOpenCodeRuntimeManifestWatermarkDeliveryFailure(input.ledgerRecord)
    ) {
      return input.ledgerRecord;
    }

    const scheduledAt = nowIso();
    const requeued = await input.ledger.markNextAttemptScheduled({
      id: input.ledgerRecord.id,
      status: 'retry_scheduled',
      nextAttemptAt: scheduledAt,
      reason: 'opencode_prompt_delivery_requeued_after_runtime_manifest_high_watermark_fix',
      scheduledAt,
    });
    logger.info(
      'opencode_prompt_delivery_requeued_after_runtime_manifest_high_watermark_fix',
      JSON.stringify({
        teamName: requeued.teamName,
        memberName: requeued.memberName,
        laneId: requeued.laneId,
        runId: requeued.runId,
        inboxMessageId: requeued.inboxMessageId,
        attempts: requeued.attempts,
      })
    );
    return requeued;
  }

  private async markOpenCodePromptLedgerFailedTerminal(input: {
    ledger: OpenCodePromptDeliveryLedgerStore;
    id: string;
    reason: string;
    diagnostics?: string[];
    failedAt: string;
    eventContext?: Record<string, unknown>;
  }): Promise<OpenCodePromptDeliveryLedgerRecord> {
    const failed = await input.ledger.markFailedTerminal({
      id: input.id,
      reason: input.reason,
      ...(input.diagnostics ? { diagnostics: input.diagnostics } : {}),
      failedAt: input.failedAt,
    });
    this.logOpenCodePromptDeliveryEvent('opencode_prompt_delivery_terminal_failure', failed, {
      reason: input.reason,
      ...(input.eventContext ?? {}),
    });
    return failed;
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
    let ledgerRecord = input.ledgerRecord;
    let visibleReply = input.visibleReply ?? null;
    const observeMessageDelivery = input.adapter.observeMessageDelivery;
    const readAllowed = await this.isOpenCodeDeliveryResponseReadCommitAllowed({
      teamName: input.teamName,
      memberName: input.memberName,
      responseState: ledgerRecord.responseState,
      actionMode: ledgerRecord.actionMode ?? undefined,
      taskRefs: ledgerRecord.taskRefs,
      visibleReply,
      ledgerRecord,
    });
    const shouldObserveInline =
      observeMessageDelivery &&
      input.promptAccepted &&
      isOpenCodeDirectUserPromptDelivery(ledgerRecord) &&
      (ledgerRecord.source === 'manual' ||
        (ledgerRecord.responseState === 'tool_error' &&
          hasOpenCodeObservedMessageSendToolCall(ledgerRecord))) &&
      !readAllowed &&
      !visibleReply &&
      !ledgerRecord.visibleReplyMessageId;

    if (!shouldObserveInline || !observeMessageDelivery) {
      return { ledgerRecord, visibleReply };
    }

    for (let inlineObserveAttempt = 1; inlineObserveAttempt <= 4; inlineObserveAttempt += 1) {
      await sleep(OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS);
      let observed: OpenCodeTeamRuntimeMessageResult;
      try {
        observed = await observeMessageDelivery.call(input.adapter, {
          ...(input.runtimeRunId ? { runId: input.runtimeRunId } : {}),
          teamName: input.teamName,
          laneId: input.laneId,
          memberName: input.memberName,
          cwd: input.cwd,
          text: input.text,
          messageId: input.messageId,
          replyRecipient: input.replyRecipient ?? undefined,
          actionMode: input.actionMode,
          messageKind: input.messageKind,
          workSyncIntent: input.workSyncIntent,
          workSyncReviewRequestEventIds: input.workSyncReviewRequestEventIds,
          taskRefs: input.taskRefs,
          prePromptCursor: ledgerRecord.prePromptCursor,
          sessionId: ledgerRecord.runtimeSessionId ?? undefined,
          runtimePromptMessageId:
            ledgerRecord.lastRuntimePromptMessageId ??
            ledgerRecord.runtimePromptMessageId ??
            undefined,
        });
      } catch (error) {
        const reason = `opencode_direct_user_delivery_inline_observe_failed: ${getErrorMessage(
          error
        )}`;
        await this.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
          teamName: input.teamName,
          runId: input.runtimeRunId,
          laneId: input.laneId,
          memberName: input.memberName,
          cwd: input.cwd,
          sessionId: ledgerRecord.runtimeSessionId,
          reason,
          diagnostics: [
            `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
            reason,
          ],
        });
        ledgerRecord = await input.ledger.applyObservation({
          id: ledgerRecord.id,
          responseObservation: {
            state: 'reconcile_failed',
            deliveredUserMessageId: null,
            assistantMessageId: null,
            toolCallNames: [],
            visibleMessageToolCallId: null,
            visibleReplyMessageId: null,
            visibleReplyCorrelation: null,
            latestAssistantPreview: null,
            reason,
          },
          diagnostics: [
            `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
            reason,
          ],
          observedAt: nowIso(),
        });
        break;
      }
      await this.rememberOpenCodeRuntimePidFromBridge({
        teamName: input.teamName,
        memberName: input.memberName,
        laneId: input.laneId,
        runId: input.runtimeRunId,
        runtimeSessionId: observed.sessionId,
        runtimePid: observed.runtimePid,
        reason: 'opencode_delivery_inline_observe_runtime_pid_observed',
      });
      const observedResponse = normalizeOpenCodeDeliveryResponseObservation(
        observed.responseObservation
      );
      await this.maybeSyncOpenCodeRuntimePermissionsAfterDelivery({
        teamName: input.teamName,
        runId: input.runtimeRunId,
        laneId: input.laneId,
        memberName: input.memberName,
        cwd: input.cwd,
        sessionId: observed.sessionId,
        responseState: observedResponse?.state,
        reason: observedResponse?.reason ?? observed.diagnostics[0],
        diagnostics: observed.diagnostics,
      });
      const hadMessageSendToolError = hasOpenCodeObservedMessageSendToolCall(ledgerRecord);
      ledgerRecord = await input.ledger.applyObservation({
        id: ledgerRecord.id,
        responseObservation: observedResponse ?? {
          state: observed.ok ? 'not_observed' : 'reconcile_failed',
          deliveredUserMessageId: null,
          assistantMessageId: null,
          toolCallNames: [],
          visibleMessageToolCallId: null,
          visibleReplyMessageId: null,
          visibleReplyCorrelation: null,
          latestAssistantPreview: null,
          reason: observed.diagnostics[0] ?? null,
        },
        sessionId: observed.sessionId,
        runtimePromptMessageId: observed.runtimePromptMessageId,
        diagnostics: [
          `opencode_direct_user_delivery_inline_observe_attempt_${inlineObserveAttempt}`,
          ...(hadMessageSendToolError ? ['opencode_message_send_tool_error_inline_observe'] : []),
          ...observed.diagnostics,
        ],
        observedAt: nowIso(),
      });
      const proof = await this.openCodeVisibleReplyProofService.applyDestinationProof({
        ledger: input.ledger,
        ledgerRecord,
        teamName: input.teamName,
        replyRecipient: input.replyRecipient,
        memberName: input.memberName,
      });
      ledgerRecord = proof.ledgerRecord;
      visibleReply = proof.visibleReply;
      const materialized =
        await this.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
          ledger: input.ledger,
          ledgerRecord,
          teamName: input.teamName,
          memberName: input.memberName,
          visibleReply,
        });
      ledgerRecord = materialized.ledgerRecord;
      visibleReply = materialized.visibleReply;
      const observedReadAllowed = await this.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: input.teamName,
        memberName: input.memberName,
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode ?? undefined,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply,
        ledgerRecord,
      });
      if (observedReadAllowed) {
        break;
      }
    }

    return { ledgerRecord, visibleReply };
  }

  private scheduleOpenCodePromptDeliveryWatchdog(input: {
    teamName: string;
    memberName: string;
    messageId?: string | null;
    delayMs: number;
  }): void {
    this.openCodePromptDeliveryWatchdogScheduler.schedule(input);
  }

  private async isStaleOpenCodePromptDeliveryWatchdogError(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    error: unknown;
  }): Promise<boolean> {
    return this.openCodePromptDeliveryWatchdogScheduler.isStaleError(input);
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

    const command = this.readProcessCommandByPid(runtimePid);
    if (!command || !this.isOpenCodeServeCommand(command)) {
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
      getTrackedRunId: (teamName) => this.getTrackedRunId(teamName),
      getPermissionListingAdapter: () => this.getOpenCodeRuntimePermissionListingAdapter(),
      readLaunchState: (teamName) => this.launchStateStore.read(teamName).catch(() => null),
      getTrackedRun: (teamName) => {
        const trackedRunId = this.getTrackedRunId(teamName);
        return trackedRunId ? (this.runs.get(trackedRunId) ?? null) : null;
      },
      getRuntimeAdapterRun: (teamName) => this.runtimeAdapterRunByTeam.get(teamName) ?? null,
      persistPendingPermissions: (params) => this.persistOpenCodeRuntimePendingPermissions(params),
      syncSpawnStatuses: (params) => this.syncOpenCodeRuntimePermissionSpawnStatuses(params),
      syncToolApprovals: (params) => this.syncOpenCodeRuntimeToolApprovals(params),
      logWarning: (message) => logger.warn(message),
    });
  }

  private async persistOpenCodeRuntimePendingPermissions(
    input: OpenCodeRuntimePendingPermissionsPersistenceInput
  ): Promise<void> {
    if (!input.previousLaunchState) {
      return;
    }
    const observedAt = nowIso();
    try {
      const changed = await this.enqueueLaunchStateStoreOperation(input.teamName, async () => {
        const incomingRunId = input.runId?.trim();
        if (incomingRunId && this.getTrackedRunId(input.teamName) !== incomingRunId) {
          return false;
        }
        const previous = await this.launchStateStore.read(input.teamName).catch(() => null);
        if (!previous) {
          return false;
        }
        const nextSnapshot = buildOpenCodeRuntimePendingPermissionsLaunchSnapshot({
          previous,
          runId: input.runId,
          laneId: input.laneId,
          sessionId: input.sessionId,
          permissionsByMember: input.permissionsByMember,
          observedAt,
        });
        if (!nextSnapshot) {
          return false;
        }
        await this.writeLaunchStateSnapshotNow(input.teamName, nextSnapshot);
        return true;
      });
      if (changed) {
        this.invalidateRuntimeSnapshotCaches(input.teamName);
        for (const memberName of input.permissionsByMember.keys()) {
          this.teamChangeEmitter?.({
            type: 'member-spawn',
            teamName: input.teamName,
            ...(input.runId ? { runId: input.runId } : {}),
            detail: memberName,
          });
        }
      }
    } catch (error) {
      logger.debug(
        `[${input.teamName}] Failed to persist OpenCode pending runtime permissions: ${getErrorMessage(error)}`
      );
    }
  }

  private syncOpenCodeRuntimePermissionSpawnStatuses(
    input: OpenCodeRuntimePermissionSpawnStatusSyncInput
  ): void {
    const trackedRunId = this.getTrackedRunId(input.teamName);
    const run = trackedRunId ? this.runs.get(trackedRunId) : null;
    const result = syncOpenCodeRuntimePermissionSpawnStatusesHelper({
      run: run ?? null,
      expectedRunId: input.runId,
      laneId: input.laneId,
      permissionsByMember: input.permissionsByMember,
      updatedAt: nowIso(),
      isCurrentTrackedRun: () => (run ? this.isCurrentTrackedRun(run) : false),
      emitMemberSpawnChange: (memberName) => {
        if (run) {
          this.emitMemberSpawnChange(run, memberName);
        }
      },
    });
    if (run && result.shouldPersistLaunchSnapshot) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  private logOpenCodePromptDeliveryEvent(
    event: string,
    record: OpenCodePromptDeliveryLedgerRecord,
    extra: Record<string, unknown> = {}
  ): void {
    logger.info(
      event,
      JSON.stringify({
        teamName: record.teamName,
        memberName: record.memberName,
        laneId: record.laneId,
        runId: record.runId,
        inboxMessageId: record.inboxMessageId,
        runtimeSessionId: record.runtimeSessionId,
        status: record.status,
        responseState: record.responseState,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt,
        visibleReplyCorrelation: record.visibleReplyCorrelation,
        reason: record.lastReason,
        ...extra,
      })
    );
    const shouldNotifyTerminalFailure =
      event === 'opencode_prompt_delivery_terminal_failure' && record.status === 'failed_terminal';
    const shouldNotifyActionRequiredRetry =
      !shouldNotifyTerminalFailure && isPotentialOpenCodeRuntimeDeliveryError(record);
    if (shouldNotifyTerminalFailure || shouldNotifyActionRequiredRetry) {
      void this.handleOpenCodeRuntimeDeliveryUserFacingSideEffects(record).catch((error) => {
        logger.warn(
          `[${record.teamName}] Failed to handle OpenCode runtime delivery advisory side effects for ${record.memberName}: ${getErrorMessage(error)}`
        );
      });
    }
  }

  private emitOpenCodePromptDeliveryTaskLogChange(
    record: OpenCodePromptDeliveryLedgerRecord,
    detail: string
  ): void {
    if (!record.runtimeSessionId?.trim() || record.taskRefs.length === 0) {
      return;
    }
    const taskIds = new Set(
      record.taskRefs
        .map((taskRef) => taskRef.taskId?.trim() || taskRef.displayId?.trim())
        .filter((taskId): taskId is string => Boolean(taskId))
    );
    for (const taskId of taskIds) {
      this.teamChangeEmitter?.({
        type: 'task-log-change',
        teamName: record.teamName,
        ...(record.runId ? { runId: record.runId } : {}),
        taskId,
        detail,
        taskSignalKind: 'log',
      });
    }
  }

  private async handleOpenCodeRuntimeDeliveryUserFacingSideEffects(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<void> {
    const { record: latestRecord, decision } =
      await this.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record);
    if (decision.action === 'defer') {
      this.emitOpenCodeRuntimeDeliveryAdvisoryEvent(latestRecord, decision);
      this.scheduleOpenCodeRuntimeDeliveryAdvisoryReview(latestRecord, decision);
      return;
    }
    if (decision.action === 'suppress') {
      this.emitOpenCodeRuntimeDeliveryAdvisoryEvent(latestRecord, decision);
      return;
    }

    this.emitOpenCodeRuntimeDeliveryAdvisoryEvent(latestRecord, decision);
    await this.scheduleOpenCodeProofMissingWorkSyncRecovery(latestRecord, decision);
    if (decision.severity !== 'error') {
      return;
    }

    await this.fireOpenCodeRuntimeDeliveryErrorNotification(latestRecord, decision);
  }

  private async decideOpenCodeRuntimeDeliveryUserFacingAdvisory(
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<{
    record: OpenCodePromptDeliveryLedgerRecord;
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision;
  }> {
    const memberKey = record.memberName.trim().toLowerCase();
    let recordsForMember: OpenCodePromptDeliveryLedgerRecord[] = [record];
    let ledgerReadSucceeded = false;
    try {
      const laneRecords = await this.createOpenCodePromptDeliveryLedger(
        record.teamName,
        record.laneId
      ).list();
      ledgerReadSucceeded = true;
      recordsForMember = laneRecords.filter(
        (candidate) => candidate.memberName.trim().toLowerCase() === memberKey
      );
    } catch {
      recordsForMember = [record];
    }
    const latestRecord = recordsForMember.find((candidate) => candidate.id === record.id) ?? null;
    if (!latestRecord && ledgerReadSucceeded) {
      return {
        record,
        decision: { action: 'suppress' },
      };
    }
    const recordForDecision = latestRecord ?? record;
    const recordsByMember = new Map<string, readonly OpenCodePromptDeliveryLedgerRecord[]>([
      [memberKey, recordsForMember.length > 0 ? recordsForMember : [recordForDecision]],
    ]);
    const activeMemberKeys = new Set([memberKey]);
    const proofIndex = await this.openCodeRuntimeDeliveryProofReader
      .readProofIndex({
        teamName: recordForDecision.teamName,
        activeMemberKeys,
        recordsByMember,
      })
      .catch(() => null);
    return {
      record: recordForDecision,
      decision: decideOpenCodeRuntimeDeliveryAdvisory({
        record: recordForDecision,
        proof: proofIndex?.getSnapshot(recordForDecision.memberName, recordForDecision),
      }),
    };
  }

  private async fireOpenCodeRuntimeDeliveryErrorNotification(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    const reason = decision.reason;
    if (!reason) {
      return;
    }

    const config = await this.readConfigSnapshot(record.teamName).catch(() => null);
    const teamDisplayName = config?.name?.trim() || record.teamName;
    const taskLabel = record.taskRefs[0]?.displayId?.trim()
      ? `#${record.taskRefs[0].displayId.trim()}`
      : null;
    const context = taskLabel ? ` while handling ${taskLabel}` : '';
    const body = `Team ${teamDisplayName}: @${record.memberName} hit an OpenCode runtime delivery error${context}. ${reason}`;

    try {
      await NotificationManager.getInstance().addTeamNotification({
        teamEventType: 'api_error',
        teamName: record.teamName,
        teamDisplayName,
        from: record.memberName,
        summary: taskLabel
          ? `OpenCode runtime error ${taskLabel}`
          : 'OpenCode runtime delivery error',
        body,
        dedupeKey: `opencode_runtime_delivery_error:${record.teamName}:${record.memberName}:${record.id}`,
        target: {
          kind: 'member',
          teamName: record.teamName,
          memberName: record.memberName,
          focus: 'messages',
        },
        projectPath: config?.projectPath,
      });
    } catch (error) {
      logger.warn(
        `[${record.teamName}] Failed to store OpenCode runtime delivery error notification for ${record.memberName}: ${getErrorMessage(error)}`
      );
    }

    await this.notifyLeadAboutOpenCodeRuntimeDeliveryError({
      record,
      reason,
      taskLabel,
    });
  }

  private async scheduleOpenCodeProofMissingWorkSyncRecovery(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): Promise<void> {
    if (decision.reasonCode !== 'protocol_proof_missing') {
      return;
    }
    const scheduler = this.memberWorkSyncProofMissingRecoveryScheduler;
    if (!scheduler) {
      return;
    }

    try {
      await scheduler({
        teamName: record.teamName,
        memberName: record.memberName,
        originalMessageId: record.inboxMessageId,
        taskRefs: record.taskRefs,
        ...(decision.reason ? { reason: decision.reason } : {}),
      });
    } catch (error) {
      logger.warn(
        `[${record.teamName}] Failed to schedule OpenCode proof-missing work sync recovery for ${record.memberName}: ${getErrorMessage(error)}`
      );
    }
  }

  private emitOpenCodeRuntimeDeliveryAdvisoryEvent(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision?: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    try {
      this.memberRuntimeAdvisoryInvalidator?.(record.teamName, record.memberName);
    } catch (error) {
      logger.warn(
        `[${record.teamName}] Failed to invalidate OpenCode runtime advisory cache for ${record.memberName}: ${getErrorMessage(error)}`
      );
    }

    const reasonKey = getOpenCodeRuntimeDeliveryAdvisoryReasonKey({ record, decision });
    const eventKey = `opencode_runtime_delivery_error:${record.teamName}:${record.memberName}:${record.id}:${reasonKey}`;
    const now = Date.now();
    this.pruneOpenCodeRuntimeDeliveryAdvisoryEventDedupe(now);
    if (this.openCodeRuntimeDeliveryAdvisoryEventSentAt.has(eventKey)) {
      return;
    }

    try {
      this.teamChangeEmitter?.({
        type: 'member-advisory',
        teamName: record.teamName,
        detail: `opencode-runtime-delivery-error:${record.memberName}:${record.id}`,
      });
      this.openCodeRuntimeDeliveryAdvisoryEventSentAt.set(eventKey, now);
    } catch (error) {
      logger.warn(
        `[${record.teamName}] Failed to emit member advisory refresh for ${record.memberName}: ${getErrorMessage(error)}`
      );
    }
  }

  private emitRuntimeDeliveryReplyAdvisoryRefresh(teamName: string, message: InboxMessage): void {
    if (
      message.source !== 'runtime_delivery' ||
      typeof message.relayOfMessageId !== 'string' ||
      message.relayOfMessageId.trim().length === 0
    ) {
      return;
    }

    const memberName = message.from?.trim();
    if (!memberName || memberName === 'user' || memberName === 'system') {
      return;
    }

    try {
      this.memberRuntimeAdvisoryInvalidator?.(teamName, memberName);
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to invalidate runtime advisory after runtime delivery reply for ${memberName}: ${getErrorMessage(error)}`
      );
    }

    try {
      this.teamChangeEmitter?.({
        type: 'member-advisory',
        teamName,
        detail: `runtime-delivery-reply:${memberName}:${message.relayOfMessageId.trim()}`,
      });
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to emit runtime advisory refresh after runtime delivery reply for ${memberName}: ${getErrorMessage(error)}`
      );
    }
  }

  private pruneOpenCodeRuntimeDeliveryAdvisoryEventDedupe(now: number): void {
    const ttlMs = TeamProvisioningService.OPENCODE_RUNTIME_DELIVERY_ADVISORY_EVENT_TTL_MS;
    for (const [key, sentAt] of this.openCodeRuntimeDeliveryAdvisoryEventSentAt) {
      if (now - sentAt > ttlMs) {
        this.openCodeRuntimeDeliveryAdvisoryEventSentAt.delete(key);
      }
    }
  }

  private scheduleOpenCodeRuntimeDeliveryAdvisoryReview(
    record: OpenCodePromptDeliveryLedgerRecord,
    decision: OpenCodeRuntimeDeliveryAdvisoryDecision
  ): void {
    const reviewAt = Date.parse(decision.nextReviewAt ?? '');
    if (!Number.isFinite(reviewAt)) {
      return;
    }
    const delayMs = Math.max(250, reviewAt - Date.now());
    const timerKey = `${record.teamName}:${record.laneId}:${record.id}`;
    const existing = this.openCodeRuntimeDeliveryAdvisoryReviewTimers.get(timerKey);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.openCodeRuntimeDeliveryAdvisoryReviewTimers.delete(timerKey);
      void this.handleOpenCodeRuntimeDeliveryUserFacingSideEffects(record).catch((error) => {
        logger.warn(
          `[${record.teamName}] Failed to refresh deferred OpenCode runtime delivery advisory for ${record.memberName}: ${getErrorMessage(error)}`
        );
      });
    }, delayMs);
    this.openCodeRuntimeDeliveryAdvisoryReviewTimers.set(timerKey, timer);
  }

  private async notifyLeadAboutOpenCodeRuntimeDeliveryError(input: {
    record: OpenCodePromptDeliveryLedgerRecord;
    reason: string;
    taskLabel: string | null;
  }): Promise<void> {
    const runId = this.getAliveRunId(input.record.teamName);
    const run = runId ? this.runs.get(runId) : null;
    if (!run || run.processKilled || run.cancelRequested) {
      return;
    }
    if (run.child && !run.child.stdin?.writable) {
      return;
    }

    const noticeKey = `opencode_runtime_delivery_error:${input.record.teamName}:${input.record.memberName}:${input.record.id}`;
    const now = Date.now();
    this.pruneOpenCodeRuntimeDeliveryLeadNoticeDedupe(now);
    if (this.openCodeRuntimeDeliveryLeadNoticeSentAt.has(noticeKey)) {
      return;
    }

    this.openCodeRuntimeDeliveryLeadNoticeSentAt.set(noticeKey, now);
    const taskContext = input.taskLabel ? ` while handling ${input.taskLabel}` : '';
    const message = [
      `System notice: OpenCode teammate @${input.record.memberName} hit a runtime delivery error${taskContext}.`,
      `Reason: ${input.reason}`,
      `Treat @${input.record.memberName} as unavailable for that work until retry or restart succeeds.`,
      `Do not message the human user solely because of this notice unless user action is required.`,
    ].join(' ');

    try {
      await this.sendMessageToRun(run, message);
    } catch (error) {
      this.openCodeRuntimeDeliveryLeadNoticeSentAt.delete(noticeKey);
      const errorMessage = getErrorMessage(error);
      if (errorMessage.includes('process stdin is not writable')) {
        return;
      }
      logger.warn(
        `[${input.record.teamName}] Failed to notify lead about OpenCode runtime delivery error for ${input.record.memberName}: ${errorMessage}`
      );
    }
  }

  private pruneOpenCodeRuntimeDeliveryLeadNoticeDedupe(now: number): void {
    const ttlMs = TeamProvisioningService.OPENCODE_RUNTIME_DELIVERY_LEAD_NOTICE_TTL_MS;
    for (const [key, sentAt] of this.openCodeRuntimeDeliveryLeadNoticeSentAt) {
      if (now - sentAt > ttlMs) {
        this.openCodeRuntimeDeliveryLeadNoticeSentAt.delete(key);
      }
    }
  }

  async scanOpenCodePromptDeliveryWatchdog(teamName: string): Promise<number> {
    if (!this.openCodePromptDeliveryWatchdogScheduler.isEnabled()) {
      return 0;
    }
    const canDeliverToTeamRuntime = this.canDeliverToOpenCodeRuntimeForTeam(teamName);
    const recoveredLaneIds = await this.tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
      teamName,
      { allowCommittedSessionRecoveryWithoutTeamRuntime: !canDeliverToTeamRuntime }
    );
    if (!canDeliverToTeamRuntime && recoveredLaneIds.length === 0) {
      await this.stopOpenCodeRuntimeLanesForStoppedTeam(teamName);
      return 0;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    if (!laneIndex && recoveredLaneIds.length === 0) {
      return 0;
    }
    let activeLaneIds = canDeliverToTeamRuntime
      ? Object.values(laneIndex?.lanes ?? {})
          .filter((lane) => lane.state === 'active')
          .map((lane) => lane.laneId)
      : [];
    activeLaneIds = [...new Set([...activeLaneIds, ...recoveredLaneIds])];
    return await this.scanOpenCodePromptDeliveryWatchdogForActiveLanes(teamName, activeLaneIds);
  }

  private async scanOpenCodePromptDeliveryWatchdogForActiveLanes(
    teamName: string,
    laneIds: string[]
  ): Promise<number> {
    if (!this.openCodePromptDeliveryWatchdogScheduler.isEnabled()) {
      return 0;
    }
    let scheduled = 0;
    for (const laneId of [...new Set(laneIds.map((laneId) => laneId.trim()).filter(Boolean))]) {
      const ledger = this.createOpenCodePromptDeliveryLedger(teamName, laneId);
      await ledger.pruneTerminalRecords({ now: new Date() }).catch((error: unknown) => {
        logger.warn(
          `[${teamName}] OpenCode prompt delivery ledger prune failed for ${laneId}: ${getErrorMessage(error)}`
        );
      });
      const records = await ledger.list().catch(() => []);
      for (const record of records) {
        if (isOpenCodePromptDeliveryWatchdogRecordTerminal(record)) {
          continue;
        }
        const nextAttemptMs = record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : NaN;
        const delayMs = Number.isFinite(nextAttemptMs)
          ? Math.max(500, nextAttemptMs - Date.now())
          : OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS;
        this.scheduleOpenCodePromptDeliveryWatchdog({
          teamName,
          memberName: record.memberName,
          messageId: record.inboxMessageId,
          delayMs,
        });
        scheduled += 1;
      }
      const members = await this.resolveOpenCodeMembersForRuntimeLane(teamName, laneId);
      for (const memberName of members) {
        const inboxMessages = await this.inboxReader
          .getMessagesFor(teamName, memberName)
          .catch(() => []);
        for (const message of inboxMessages) {
          if (
            message.read ||
            typeof message.text !== 'string' ||
            message.text.trim().length === 0 ||
            !hasStableInboxMessageId(message)
          ) {
            continue;
          }
          const existing = await ledger
            .getByInboxMessage({
              teamName,
              memberName,
              laneId,
              inboxMessageId: message.messageId,
            })
            .catch(() => null);
          if (existing) {
            continue;
          }
          const replyRecipient =
            typeof message.from === 'string' &&
            message.from.trim() &&
            message.from.trim().toLowerCase() !== memberName.trim().toLowerCase()
              ? message.from.trim()
              : 'user';
          const now = nowIso();
          const record = await ledger.ensurePending({
            teamName,
            memberName,
            laneId,
            runId: await this.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
            inboxMessageId: message.messageId,
            inboxTimestamp: message.timestamp,
            source: 'watchdog',
            replyRecipient,
            actionMode: message.actionMode ?? null,
            messageKind: message.messageKind ?? null,
            workSyncIntent: message.workSyncIntent ?? null,
            taskRefs: message.taskRefs ?? [],
            payloadHash: hashOpenCodePromptDeliveryPayload({
              text: message.text,
              replyRecipient,
              actionMode: message.actionMode ?? null,
              taskRefs: message.taskRefs ?? [],
              attachments: message.attachments,
              source: 'watchdog',
            }),
            now,
          });
          const recovered = await ledger.markAcceptanceUnknown({
            id: record.id,
            reason: 'opencode_prompt_delivery_ledger_rebuilt_from_unread_inbox',
            nextAttemptAt: now,
            markedAt: now,
          });
          this.logOpenCodePromptDeliveryEvent(
            'opencode_prompt_delivery_retry_scheduled',
            recovered,
            { acceptanceUnknown: true, reason: recovered.lastReason }
          );
          this.scheduleOpenCodePromptDeliveryWatchdog({
            teamName,
            memberName: recovered.memberName,
            messageId: recovered.inboxMessageId,
            delayMs: 500,
          });
          scheduled += 1;
        }
      }
    }
    return scheduled;
  }

  private createOpenCodeRuntimeBootstrapEvidencePorts(): OpenCodeRuntimeBootstrapEvidencePorts {
    return createDefaultOpenCodeRuntimeBootstrapEvidencePorts({
      teamsBasePath: getTeamsBasePath(),
      warn: (message) => logger.warn(message),
    });
  }

  private createOpenCodeMemberMessageDeliveryService(): OpenCodeMemberMessageDeliveryService {
    return new OpenCodeMemberMessageDeliveryService({
      getOpenCodeRuntimeMessageAdapter: () => this.getOpenCodeRuntimeMessageAdapter(),
      readOpenCodeMemberDirectory: (teamName) => this.readOpenCodeMemberDirectory(teamName),
      resolveOpenCodeMemberIdentityFromDirectory: (teamName, memberName, directory) =>
        this.resolveOpenCodeMemberIdentityFromDirectory(teamName, memberName, directory),
      stoppingSecondaryRuntimeTeams: this.stoppingSecondaryRuntimeTeams,
      readPersistedTeamProjectPath: (teamName) => this.readPersistedTeamProjectPath(teamName),
      resolveDeliverableTrackedRuntimeRunId: (teamName) =>
        this.resolveDeliverableTrackedRuntimeRunId(teamName),
      runs: this.runs,
      getCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.getCurrentOpenCodeRuntimeRunId(teamName, laneId),
      resolveCurrentOpenCodeRuntimeRunId: (teamName, laneId) =>
        this.resolveCurrentOpenCodeRuntimeRunId(teamName, laneId),
      isOpenCodeRuntimeLaneIndexActive: (teamName, laneId) =>
        this.isOpenCodeRuntimeLaneIndexActive(teamName, laneId),
      tryRecoverOpenCodeRuntimeLaneBeforeDelivery: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input),
      tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery: (input) =>
        this.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input),
      deleteSecondaryRuntimeRun: (teamName, laneId) =>
        this.deleteSecondaryRuntimeRun(teamName, laneId),
      cleanupStoppedTeamOpenCodeRuntimeLanesInBackground: (teamName) =>
        this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName),
      findDeliverableOpenCodeRuntimeBootstrapSessionEvidence: (input) =>
        findDeliverableOpenCodeRuntimeBootstrapSessionEvidence(
          input,
          this.createOpenCodeRuntimeBootstrapEvidencePorts()
        ),
      getOpenCodeAppMcpTransportMismatchDiagnostic: (session) =>
        getOpenCodeAppMcpTransportMismatchDiagnostic(session),
      stampOpenCodeAppMcpTransportEvidenceIfMissing: (session, options) =>
        stampOpenCodeAppMcpTransportEvidenceIfMissing(
          session,
          this.createOpenCodeRuntimeBootstrapEvidencePorts(),
          options
        ),
      resolveControlApiBaseUrl: () => this.resolveControlApiBaseUrl(),
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
    return await this.createOpenCodeMemberMessageDeliveryService().deliver(teamName, input);
  }

  private shouldRouteOpenCodeToRuntimeAdapter(request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  }): boolean {
    return isPureOpenCodeProvisioningRequest(request) && this.getOpenCodeRuntimeAdapter() !== null;
  }

  private planRuntimeLanesOrThrow(
    leadProviderId: TeamProviderId | undefined,
    leadModel: string | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ): TeamRuntimeLanePlan {
    return this.runtimeLaneCoordinator.planProvisioningMembers({
      leadProviderId,
      leadModel,
      members,
      baseCwd,
      hasOpenCodeRuntimeAdapter: this.getOpenCodeRuntimeAdapter() !== null,
    });
  }

  private createMixedSecondaryLaneStates(
    plan: TeamRuntimeLanePlan
  ): MixedSecondaryRuntimeLaneState[] {
    if (!isOpenCodeSideLanePlan(plan)) {
      return [];
    }
    return plan.sideLanes.map((sideLane) => ({
      laneId: sideLane.laneId,
      providerId: 'opencode',
      member: {
        ...sideLane.member,
      },
      runId: null,
      state: 'queued',
      result: null,
      warnings: [],
      diagnostics: [],
    }));
  }

  private createMixedSecondaryLaneStateForMember(
    run: Pick<ProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    const leadProviderId = resolveTeamProviderId(run.request.providerId);
    const existingLane = (run.mixedSecondaryLanes ?? []).find((lane) =>
      matchesTeamMemberIdentity(lane.member.name, member.name)
    );
    if (leadProviderId === 'opencode') {
      const memberCwd = member.cwd?.trim();
      const baseCwd = run.request.cwd?.trim();
      const laneId =
        existingLane?.laneId ??
        (memberCwd && (!baseCwd || memberCwd !== baseCwd)
          ? buildOpenCodeSecondaryLaneId(member)
          : null);
      if (!laneId) {
        throw new Error(
          `Member "${member.name}" is not eligible for an OpenCode secondary runtime lane`
        );
      }
      return {
        laneId,
        providerId: 'opencode',
        member: {
          ...member,
        },
        runId: null,
        state: 'queued',
        result: null,
        warnings: [],
        diagnostics: [],
      };
    }

    const laneIdentity = buildPlannedMemberLaneIdentity({
      leadProviderId,
      member: {
        name: member.name,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
      },
    });

    if (laneIdentity.laneKind !== 'secondary' || laneIdentity.laneOwnerProviderId !== 'opencode') {
      throw new Error(
        `Member "${member.name}" is not eligible for an OpenCode secondary runtime lane`
      );
    }

    return {
      laneId: laneIdentity.laneId,
      providerId: 'opencode',
      member: {
        ...member,
      },
      runId: null,
      state: 'queued',
      result: null,
      warnings: [],
      diagnostics: [],
    };
  }

  private getMixedSecondaryLaunchPhase(run: ProvisioningRun): PersistedTeamLaunchPhase {
    return (run.mixedSecondaryLanes ?? []).some(
      (lane) =>
        (!lane.result && lane.state !== 'finished') ||
        lane.result?.teamLaunchState === 'partial_pending'
    )
      ? 'active'
      : 'finished';
  }

  private async restartPureOpenCodeAggregatePrimaryMember(
    teamName: string,
    memberName: string
  ): Promise<boolean> {
    const runId = this.getAliveRunId(teamName);
    const run = runId ? this.runs.get(runId) : null;
    if (
      !run ||
      run.processKilled ||
      run.cancelRequested ||
      resolveTeamProviderId(run.request.providerId) !== 'opencode' ||
      run.mixedSecondaryLanes.length === 0
    ) {
      return false;
    }
    const normalizedMemberName = memberName.trim().toLowerCase();
    const primaryMember = run.effectiveMembers.find(
      (member) => member.name.trim().toLowerCase() === normalizedMemberName
    );
    if (!primaryMember) {
      return false;
    }
    if (run.pendingMemberRestarts.has(memberName)) {
      throw new Error(`Restart for teammate "${memberName}" is already in progress`);
    }
    if (!this.getOpenCodeRuntimeAdapter()) {
      throw new Error('OpenCode runtime adapter is not available for member restart.');
    }

    const currentPrimaryRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (currentPrimaryRun?.providerId === 'opencode' && currentPrimaryRun.runId === run.runId) {
      await this.stopOpenCodeRuntimeAdapterTeam(teamName, run.runId);
      this.setAliveRunId(teamName, run.runId);
    }

    run.effectiveMembers = run.effectiveMembers.filter(
      (member) => member.name.trim().toLowerCase() !== normalizedMemberName
    );
    run.expectedMembers = run.expectedMembers.filter(
      (name) => name.trim().toLowerCase() !== normalizedMemberName
    );
    const lane: MixedSecondaryRuntimeLaneState = {
      laneId: buildOpenCodeSecondaryLaneId(primaryMember),
      providerId: 'opencode',
      member: { ...primaryMember },
      runId: null,
      state: 'queued',
      result: null,
      warnings: [],
      diagnostics: ['controlled_reattach:manual_restart', 'migrated_from_failed_primary_lane'],
    };
    run.mixedSecondaryLanes.push(lane);
    this.persistOpenCodeMemberRestartSystemMessage({
      teamName,
      leadName: this.getRunLeadName(run),
      leadSessionId: run.detectedSessionId?.trim() || run.runId,
      displayName: run.request.displayName?.trim() || run.teamName,
      member: primaryMember,
      reason: 'manual_restart',
    });
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.resetRuntimeToolActivity(run, memberName);
    this.clearMemberSpawnToolTracking(run, memberName);
    await this.launchSingleMixedSecondaryLane(run, lane);
    await this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
    if (this.isTeamAlive(teamName)) {
      const memberRestartRetained =
        lane.result != null && hasRetainableOpenCodeRuntimeMember(lane.result);
      run.progress = this.setRuntimeAdapterProgress(
        {
          ...run.progress,
          state: 'ready',
          message: memberRestartRetained
            ? 'OpenCode member lane restart is ready'
            : 'OpenCode team is running with unavailable members',
          messageSeverity: memberRestartRetained ? undefined : 'warning',
          updatedAt: nowIso(),
          error: undefined,
        },
        run.onProgress
      );
    } else {
      this.deleteAliveRunId(teamName);
    }
    return true;
  }

  private upsertRunAllEffectiveMember(
    run: ProvisioningRun,
    member: TeamCreateRequest['members'][number]
  ): void {
    const normalizedName = member.name.trim().toLowerCase();
    const currentMembers = Array.isArray(run.allEffectiveMembers) ? run.allEffectiveMembers : [];
    const nextMembers = currentMembers.filter(
      (candidate) => candidate.name.trim().toLowerCase() !== normalizedName
    );
    nextMembers.push(member);
    run.allEffectiveMembers = nextMembers;
    run.request = {
      ...run.request,
      members: nextMembers,
    };

    const laneIdentity = buildPlannedMemberLaneIdentity({
      leadProviderId: resolveTeamProviderId(run.request.providerId),
      member: {
        name: member.name,
        providerId: normalizeOptionalTeamProviderId(member.providerId),
      },
    });
    const currentPrimaryMembers = Array.isArray(run.effectiveMembers) ? run.effectiveMembers : [];
    const nextPrimaryMembers = currentPrimaryMembers.filter(
      (candidate) => candidate.name.trim().toLowerCase() !== normalizedName
    );
    const currentExpectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
    const nextExpectedMembers = currentExpectedMembers.filter(
      (candidate) => candidate.trim().toLowerCase() !== normalizedName
    );
    if (laneIdentity.laneKind === 'primary') {
      run.effectiveMembers = [...nextPrimaryMembers, member];
      run.expectedMembers = [...nextExpectedMembers, member.name.trim()].filter(Boolean);
    } else {
      run.effectiveMembers = nextPrimaryMembers;
      run.expectedMembers = nextExpectedMembers;
    }
  }

  private removeRunAllEffectiveMember(run: ProvisioningRun, memberName: string): void {
    const normalizedName = memberName.trim().toLowerCase();
    const currentMembers = Array.isArray(run.allEffectiveMembers) ? run.allEffectiveMembers : [];
    const nextMembers = currentMembers.filter(
      (candidate) => candidate.name.trim().toLowerCase() !== normalizedName
    );
    run.allEffectiveMembers = nextMembers;
    run.request = {
      ...run.request,
      members: nextMembers,
    };
    const currentPrimaryMembers = Array.isArray(run.effectiveMembers) ? run.effectiveMembers : [];
    run.effectiveMembers = currentPrimaryMembers.filter(
      (candidate) => candidate.name.trim().toLowerCase() !== normalizedName
    );
    const currentExpectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
    run.expectedMembers = currentExpectedMembers.filter(
      (candidate) => candidate.trim().toLowerCase() !== normalizedName
    );
  }

  private hasSecondaryRuntimeRuns(teamName: string): boolean {
    const runs = this.secondaryRuntimeRunByTeam.get(teamName);
    return Boolean(runs && runs.size > 0);
  }

  private getSecondaryRuntimeRuns(teamName: string): {
    runId: string;
    providerId: 'opencode';
    laneId: string;
    memberName: string;
    cwd?: string;
  }[] {
    return Array.from(this.secondaryRuntimeRunByTeam.get(teamName)?.values() ?? []);
  }

  private setSecondaryRuntimeRun(input: {
    teamName: string;
    runId: string;
    providerId: 'opencode';
    laneId: string;
    memberName: string;
    cwd?: string;
  }): void {
    const runs = this.secondaryRuntimeRunByTeam.get(input.teamName) ?? new Map();
    runs.set(input.laneId, {
      runId: input.runId,
      providerId: input.providerId,
      laneId: input.laneId,
      memberName: input.memberName,
      cwd: input.cwd,
    });
    this.secondaryRuntimeRunByTeam.set(input.teamName, runs);
  }

  private deleteSecondaryRuntimeRun(teamName: string, laneId: string): void {
    this.clearOpenCodeRuntimeToolApprovals(teamName, { laneId, emitDismiss: true });
    const runs = this.secondaryRuntimeRunByTeam.get(teamName);
    if (!runs) {
      return;
    }
    runs.delete(laneId);
    if (runs.size === 0) {
      this.secondaryRuntimeRunByTeam.delete(teamName);
    }
  }

  private clearSecondaryRuntimeRuns(teamName: string): void {
    this.clearOpenCodeRuntimeToolApprovals(teamName, { emitDismiss: true });
    this.secondaryRuntimeRunByTeam.delete(teamName);
  }

  private getCurrentOpenCodeRuntimeRunId(teamName: string, laneId: string): string | null {
    if (laneId === 'primary') {
      const trackedRunId = this.getTrackedRunId(teamName);
      const trackedRun = trackedRunId ? this.runs.get(trackedRunId) : null;
      if (
        trackedRun &&
        this.shouldRouteOpenCodeToRuntimeAdapter(trackedRun.request) &&
        this.runtimeAdapterRunByTeam.get(teamName)?.runId === trackedRunId
      ) {
        return trackedRunId;
      }
      if (
        trackedRunId &&
        this.provisioningRunByTeam.get(teamName) === trackedRunId &&
        this.runtimeAdapterProgressByRunId.has(trackedRunId)
      ) {
        const runtimeProgress = this.runtimeAdapterProgressByRunId.get(trackedRunId);
        if (runtimeProgress && this.isCancellableRuntimeAdapterProgress(runtimeProgress)) {
          return trackedRunId;
        }
      }
      const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
      if (runtimeRun?.providerId === 'opencode') {
        return runtimeRun.runId;
      }
      return null;
    }

    const secondaryLaneRun = this.secondaryRuntimeRunByTeam.get(teamName)?.get(laneId);
    return secondaryLaneRun?.runId ?? null;
  }

  private async resolveCurrentOpenCodeRuntimeRunId(
    teamName: string,
    laneId: string
  ): Promise<string | null> {
    const inMemoryRunId = this.getCurrentOpenCodeRuntimeRunId(teamName, laneId);
    if (inMemoryRunId) {
      return inMemoryRunId;
    }

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    if (laneIndex?.lanes[laneId]?.state !== 'active') {
      return null;
    }

    const evidence = await new OpenCodeRuntimeManifestEvidenceReader({
      teamsBasePath: getTeamsBasePath(),
    })
      .read(teamName, laneId)
      .catch(() => null);
    const durableRunId = evidence?.activeRunId?.trim();
    return durableRunId || null;
  }

  private async resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<
    | {
        ok: true;
        canonicalMemberName: string;
        laneId: string;
      }
    | {
        ok: false;
        reason:
          | 'recipient_is_not_opencode'
          | 'recipient_removed'
          | 'opencode_recipient_unavailable';
      }
  > {
    const directory = await this.readOpenCodeMemberDirectory(teamName);
    const laneIdentity = this.resolveOpenCodeMemberIdentityFromDirectory(
      teamName,
      memberName,
      directory
    );
    if (!laneIdentity.ok) {
      return laneIdentity;
    }
    return {
      ok: true,
      canonicalMemberName: laneIdentity.canonicalMemberName,
      laneId: laneIdentity.laneId,
    };
  }

  private async resolveOpenCodeMembersForRuntimeLane(
    teamName: string,
    laneId: string
  ): Promise<string[]> {
    const directory = await this.readOpenCodeMemberDirectory(teamName);
    const names = new Set<string>();
    for (const member of directory.config?.members ?? []) {
      if (member.name?.trim()) {
        names.add(member.name.trim());
      }
    }
    for (const member of directory.metaMembers) {
      if (member.name?.trim()) {
        names.add(member.name.trim());
      }
    }
    const resolved: string[] = [];
    for (const name of names) {
      const identity = this.resolveOpenCodeMemberIdentityFromDirectory(teamName, name, directory);
      if (identity.ok && identity.laneId === laneId) {
        resolved.push(identity.canonicalMemberName);
      }
    }
    if (resolved.length > 0) {
      return [...new Set(resolved)];
    }
    const secondaryMatch = /^secondary:opencode:(.+)$/i.exec(laneId);
    const fallbackMember = secondaryMatch?.[1]?.trim();
    return fallbackMember ? [fallbackMember] : [];
  }

  private async isOpenCodeRuntimeLaneIndexActive(
    teamName: string,
    laneId: string
  ): Promise<boolean> {
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    return laneIndex?.lanes[laneId]?.state === 'active';
  }

  private async tryRecoverOpenCodeRuntimeLaneBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
  }): Promise<boolean> {
    if (!this.canDeliverToOpenCodeRuntimeForTeam(input.teamName)) {
      this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(input.teamName);
      return false;
    }
    const snapshot = await this.launchStateStore.read(input.teamName).catch(() => null);
    const persistedMember =
      snapshot?.members?.[input.member.name] ??
      Object.values(snapshot?.members ?? {}).find((member) => member.laneId === input.laneId);
    if (!persistedMember || !isRecoverablePersistedOpenCodeRuntimeCandidate(persistedMember)) {
      return false;
    }
    const runtimeEvidence = await this.tryRecoverMissingOpenCodeSecondaryLaneFromRuntime({
      teamName: input.teamName,
      laneId: input.laneId,
      member: input.member,
      projectPath: input.projectPath,
      previousLaunchState: snapshot,
      persistedMember,
    });
    if (!runtimeEvidence) {
      return false;
    }
    logger.info(
      `[${input.teamName}] Recovered OpenCode lane ${input.laneId} before message delivery.`
    );
    return true;
  }

  private async tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery(input: {
    teamName: string;
    laneId: string;
    member: TeamMember;
    projectPath: string | null;
    previousLaunchState?: PersistedTeamLaunchSnapshot | null;
  }): Promise<boolean> {
    if (!this.canAttemptCommittedOpenCodeSessionRecovery(input.teamName)) {
      this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(input.teamName);
      return false;
    }
    const currentLaneIndex = await readOpenCodeRuntimeLaneIndex(
      getTeamsBasePath(),
      input.teamName
    ).catch(() => null);
    const currentEntry = currentLaneIndex?.lanes[input.laneId];
    if (currentEntry?.state === 'active') {
      return true;
    }
    if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
      return false;
    }

    const committedSessionEvidence = await readCommittedOpenCodeBootstrapSessionEvidence({
      teamsBasePath: getTeamsBasePath(),
      teamName: input.teamName,
      laneId: input.laneId,
    }).catch(() => null);
    if (!committedSessionEvidence?.committed || committedSessionEvidence.sessions.length === 0) {
      return false;
    }
    const expectedMemberName = input.member.name.trim().toLowerCase();
    const matchingSession = committedSessionEvidence.sessions.find(
      (session) => session.memberName.trim().toLowerCase() === expectedMemberName
    );
    if (!matchingSession) {
      return false;
    }

    const runtimeEvidence = await this.tryRecoverActiveOpenCodeSecondaryLaneFromRuntime({
      teamName: input.teamName,
      laneId: input.laneId,
      member: input.member,
      projectPath: input.projectPath,
      previousLaunchState: input.previousLaunchState ?? null,
    });
    if (!isRecoverableOpenCodeRuntimeEvidence(runtimeEvidence)) {
      return false;
    }

    const diagnostics = Array.from(
      new Set([
        'Recovered missing OpenCode runtime lane index from committed session evidence.',
        ...committedSessionEvidence.diagnostics,
        ...(runtimeEvidence.diagnostics ?? []),
      ])
    );
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: input.teamName,
      laneId: input.laneId,
      state: 'active',
      diagnostics,
    }).catch((error: unknown) => {
      logger.warn(
        `[${input.teamName}] Failed to recover missing OpenCode lane index ${input.laneId} from committed session evidence: ${getErrorMessage(error)}`
      );
    });
    await setOpenCodeRuntimeActiveRunManifest({
      teamsBasePath: getTeamsBasePath(),
      teamName: input.teamName,
      laneId: input.laneId,
      runId: committedSessionEvidence.activeRunId ?? matchingSession.runId ?? null,
    }).catch((error: unknown) => {
      logger.warn(
        `[${input.teamName}] Failed to materialize committed-session recovered OpenCode lane manifest ${input.laneId}: ${getErrorMessage(error)}`
      );
    });
    logger.info(
      `[${input.teamName}] Recovered OpenCode lane ${input.laneId} from committed session evidence before message delivery.`
    );
    return true;
  }

  private buildOpenCodeRecoveryMember(input: {
    canonicalMemberName: string;
    configMember?: TeamMember;
    metaMember?: TeamMember;
  }): TeamMember {
    return {
      ...(input.configMember ?? {}),
      ...(input.metaMember ?? {}),
      name: input.canonicalMemberName,
      providerId: 'opencode',
      model: input.metaMember?.model ?? input.configMember?.model,
      role: input.metaMember?.role ?? input.configMember?.role,
      workflow: input.metaMember?.workflow ?? input.configMember?.workflow,
      effort: input.metaMember?.effort ?? input.configMember?.effort,
      cwd: input.metaMember?.cwd ?? input.configMember?.cwd,
      isolation: input.metaMember?.isolation ?? input.configMember?.isolation,
    };
  }

  private async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    const directory = await this.readOpenCodeMemberDirectory(input.teamName).catch(() => null);
    if (!directory) {
      return false;
    }
    const identity = this.resolveOpenCodeMemberIdentityFromDirectory(
      input.teamName,
      input.memberName,
      directory
    );
    if (!identity.ok) {
      return false;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), input.teamName).catch(
      () => null
    );
    const currentEntry = laneIndex?.lanes[identity.laneId];
    if (currentEntry?.state === 'active') {
      return true;
    }
    if (currentEntry?.state === 'degraded' || currentEntry?.state === 'stopped') {
      return false;
    }
    const previousLaunchState = await this.launchStateStore.read(input.teamName).catch(() => null);
    const projectPath =
      identity.memberRuntimeCwd ??
      directory.config?.projectPath?.trim() ??
      this.readPersistedTeamProjectPath(input.teamName);
    return this.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery({
      teamName: input.teamName,
      laneId: identity.laneId,
      member: this.buildOpenCodeRecoveryMember({
        canonicalMemberName: identity.canonicalMemberName,
        configMember: identity.configMember,
        metaMember: identity.metaMember,
      }),
      projectPath,
      previousLaunchState,
    });
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
    return this.isOpenCodeRuntimeLaneIndexActive(input.teamName, input.laneId).catch(() => false);
  }

  private async tryRecoverOpenCodeRuntimeLanesForDeliveryWatchdog(
    teamName: string,
    options: { allowCommittedSessionRecoveryWithoutTeamRuntime?: boolean } = {}
  ): Promise<string[]> {
    const canDeliverToTeamRuntime = this.canDeliverToOpenCodeRuntimeForTeam(teamName);
    if (!canDeliverToTeamRuntime && !options.allowCommittedSessionRecoveryWithoutTeamRuntime) {
      this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName);
      return [];
    }
    if (!canDeliverToTeamRuntime && !this.canAttemptCommittedOpenCodeSessionRecovery(teamName)) {
      this.cleanupStoppedTeamOpenCodeRuntimeLanesInBackground(teamName);
      return [];
    }
    const snapshot = await this.launchStateStore.read(teamName).catch(() => null);
    const candidates = canDeliverToTeamRuntime
      ? Object.values(snapshot?.members ?? {}).filter(
          isRecoverablePersistedOpenCodeRuntimeCandidate
        )
      : [];

    const [config, teamMeta, metaMembers, currentLaneIndex] = await Promise.all([
      this.readConfigForObservation(teamName).catch(() => null),
      this.teamMetaStore.getMeta(teamName).catch(() => null),
      this.membersMetaStore.getMembers(teamName).catch(() => []),
      readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(() => null),
    ]);
    const projectPath = config?.projectPath?.trim() || this.readPersistedTeamProjectPath(teamName);
    const leadMember = config?.members?.find((member) => isLeadMember(member));
    const leadProviderId =
      normalizeOptionalTeamProviderId(teamMeta?.launchIdentity?.providerId) ??
      normalizeOptionalTeamProviderId(teamMeta?.providerId) ??
      normalizeOptionalTeamProviderId(leadMember?.providerId);
    const recoveredLaneIds: string[] = [];
    for (const persistedMember of candidates) {
      const memberName = persistedMember.name.trim();
      const configMember = config?.members?.find(
        (member) => member.name?.trim().toLowerCase() === memberName.toLowerCase()
      );
      const metaMember = metaMembers.find(
        (member) => member.name?.trim().toLowerCase() === memberName.toLowerCase()
      );
      if (metaMember?.removedAt != null || configMember?.removedAt != null) {
        continue;
      }
      const laneIdentity = buildPlannedMemberLaneIdentity({
        leadProviderId,
        member: {
          name: memberName,
          providerId: 'opencode',
        },
      });
      if (laneIdentity.laneId !== persistedMember.laneId) {
        continue;
      }
      if (currentLaneIndex?.lanes[laneIdentity.laneId]) {
        continue;
      }
      const recovered = await this.tryRecoverOpenCodeRuntimeLaneBeforeDelivery({
        teamName,
        laneId: laneIdentity.laneId,
        member: {
          ...(configMember ?? {}),
          ...(metaMember ?? {}),
          name: memberName,
          providerId: 'opencode',
          model: metaMember?.model ?? configMember?.model ?? persistedMember.model,
          role: metaMember?.role ?? configMember?.role,
          workflow: metaMember?.workflow ?? configMember?.workflow,
          effort: metaMember?.effort ?? configMember?.effort ?? persistedMember.effort,
          cwd: metaMember?.cwd ?? configMember?.cwd ?? persistedMember.cwd,
          isolation: metaMember?.isolation ?? configMember?.isolation,
        },
        projectPath,
      });
      if (recovered) {
        recoveredLaneIds.push(laneIdentity.laneId);
      }
    }
    const directory: OpenCodeMemberDirectory = { config, teamMeta, metaMembers };
    const configuredNames = new Set<string>();
    for (const member of config?.members ?? []) {
      if (member.name?.trim()) {
        configuredNames.add(member.name.trim());
      }
    }
    for (const member of metaMembers) {
      if (member.name?.trim()) {
        configuredNames.add(member.name.trim());
      }
    }
    for (const memberName of configuredNames) {
      const identity = this.resolveOpenCodeMemberIdentityFromDirectory(
        teamName,
        memberName,
        directory
      );
      if (!identity.ok) {
        continue;
      }
      if (currentLaneIndex?.lanes[identity.laneId] || recoveredLaneIds.includes(identity.laneId)) {
        continue;
      }
      const recovered = await this.tryRecoverOpenCodeRuntimeLaneFromCommittedSessionBeforeDelivery({
        teamName,
        laneId: identity.laneId,
        member: this.buildOpenCodeRecoveryMember({
          canonicalMemberName: identity.canonicalMemberName,
          configMember: identity.configMember,
          metaMember: identity.metaMember,
        }),
        projectPath:
          identity.memberRuntimeCwd ??
          config?.projectPath?.trim() ??
          this.readPersistedTeamProjectPath(teamName),
        previousLaunchState: snapshot,
      });
      if (recovered) {
        recoveredLaneIds.push(identity.laneId);
      }
    }
    return [...new Set(recoveredLaneIds)];
  }

  private async resolveOpenCodeRuntimeLaneId(params: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string> {
    const runtimeRun = this.runtimeAdapterRunByTeam.get(params.teamName);
    if (runtimeRun?.providerId === 'opencode' && runtimeRun.runId === params.runId) {
      return 'primary';
    }

    for (const lane of this.getSecondaryRuntimeRuns(params.teamName)) {
      if (lane.runId === params.runId) {
        return lane.laneId;
      }
    }

    if (params.memberName) {
      const trackedRunId = this.getTrackedRunId(params.teamName);
      const trackedRun = trackedRunId ? this.runs.get(trackedRunId) : null;
      const plannedLane = trackedRun?.mixedSecondaryLanes.find(
        (lane) => lane.member.name.trim() === params.memberName
      );
      if (plannedLane) {
        return plannedLane.laneId;
      }

      const persisted = await this.launchStateStore.read(params.teamName).catch(() => null);
      const persistedMember = persisted?.members?.[params.memberName];
      if (
        persistedMember?.laneOwnerProviderId === 'opencode' &&
        typeof persistedMember.laneId === 'string' &&
        persistedMember.laneId.trim().length > 0
      ) {
        return persistedMember.laneId.trim();
      }
    }

    return 'primary';
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
    const configs = new Map<string, RuntimeBootstrapMemberMcpLaunchConfig>();
    for (const member of input.members) {
      const mcpPolicy = normalizeTeamMemberMcpPolicy(member.mcpPolicy);
      if (!mcpPolicy) {
        continue;
      }

      const memberCwd = member.cwd?.trim() || input.cwd;
      const mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(memberCwd, {
        mcpPolicy,
        controlApiBaseUrl: input.controlApiBaseUrl,
      });
      const memberMcpConfigPaths = input.run.memberMcpConfigPaths ?? [];
      input.run.memberMcpConfigPaths = memberMcpConfigPaths;
      memberMcpConfigPaths.push(mcpConfigPath);
      configs.set(member.name, {
        mcpConfigPath,
        mcpSettingSources: buildTeamMemberMcpSettingSources(mcpPolicy),
        strictMcpConfig: requiresStrictTeamMemberMcpConfig(mcpPolicy),
      });
    }
    return configs;
  }

  private async buildTrackedMemberMcpLaunchConfig(input: {
    cwd: string;
    mcpPolicy: unknown;
    run: ProvisioningRun;
    controlApiBaseUrl?: string | null;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    const mcpPolicy = normalizeTeamMemberMcpPolicy(input.mcpPolicy);
    if (!mcpPolicy) {
      return null;
    }

    const mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(input.cwd, {
      mcpPolicy,
      controlApiBaseUrl: input.controlApiBaseUrl,
    });
    const memberMcpConfigPaths = input.run.memberMcpConfigPaths ?? [];
    input.run.memberMcpConfigPaths = memberMcpConfigPaths;
    memberMcpConfigPaths.push(mcpConfigPath);
    return {
      mcpConfigPath,
      mcpSettingSources: buildTeamMemberMcpSettingSources(mcpPolicy),
      strictMcpConfig: requiresStrictTeamMemberMcpConfig(mcpPolicy),
    };
  }

  private async removeTrackedMemberMcpLaunchConfig(
    run: ProvisioningRun,
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined
  ): Promise<void> {
    if (!mcpLaunchConfig?.mcpConfigPath) {
      return;
    }
    const memberMcpConfigPaths = (run.memberMcpConfigPaths ??= []);
    const index = memberMcpConfigPaths.indexOf(mcpLaunchConfig.mcpConfigPath);
    if (index >= 0) {
      memberMcpConfigPaths.splice(index, 1);
    }
    await this.mcpConfigBuilder.removeConfigFile(mcpLaunchConfig.mcpConfigPath);
  }

  async prepareLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    cwd?: string;
    mcpPolicy?: unknown;
  }): Promise<RuntimeBootstrapMemberMcpLaunchConfig | null> {
    const mcpPolicy = normalizeTeamMemberMcpPolicy(input.mcpPolicy);
    if (!mcpPolicy) {
      return null;
    }

    const runId = this.getAliveRunId(input.teamName);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run || run.processKilled || run.cancelRequested) {
      throw new Error(`Team "${input.teamName}" is not currently running`);
    }

    const cwd = input.cwd?.trim() || run.request.cwd?.trim();
    if (!cwd) {
      throw new Error(`Team "${input.teamName}" project path is not available`);
    }
    await ensureCwdExists(cwd);

    return this.buildTrackedMemberMcpLaunchConfig({
      cwd,
      mcpPolicy,
      run,
      controlApiBaseUrl: await this.resolveControlApiBaseUrl().catch(() => null),
    });
  }

  async discardLiveMemberMcpLaunchConfig(input: {
    teamName: string;
    mcpLaunchConfig: RuntimeBootstrapMemberMcpLaunchConfig | null | undefined;
  }): Promise<void> {
    const runId = this.getAliveRunId(input.teamName);
    const run = runId ? this.runs.get(runId) : undefined;
    if (!run) {
      if (input.mcpLaunchConfig?.mcpConfigPath) {
        await this.mcpConfigBuilder.removeConfigFile(input.mcpLaunchConfig.mcpConfigPath);
      }
      return;
    }
    await this.removeTrackedMemberMcpLaunchConfig(run, input.mcpLaunchConfig);
  }

  private async removeRunMemberMcpConfigFiles(run: ProvisioningRun): Promise<void> {
    const paths = run.memberMcpConfigPaths?.splice(0) ?? [];
    await Promise.all(
      paths.map((configPath) => this.mcpConfigBuilder.removeConfigFile(configPath))
    );
  }

  private removeRunMemberMcpConfigFilesLater(run: ProvisioningRun): void {
    for (const configPath of run.memberMcpConfigPaths?.splice(0) ?? []) {
      void this.mcpConfigBuilder.removeConfigFile(configPath);
    }
  }

  private enrichRuntimeAdapterProgressTrace(
    progress: TeamProvisioningProgress
  ): TeamProvisioningProgress {
    const detail = buildProvisioningTraceDetail(progress);
    const key = `${progress.state}\u0000${progress.message}\u0000${detail ?? ''}`;
    const lines = this.runtimeAdapterTraceLinesByRunId.get(progress.runId) ?? [];
    if (this.runtimeAdapterTraceKeyByRunId.get(progress.runId) !== key) {
      this.runtimeAdapterTraceKeyByRunId.set(progress.runId, key);
      lines.push(
        buildProgressTraceLine({
          timestamp: progress.updatedAt,
          state: progress.state,
          message: progress.message,
          detail,
        })
      );
      if (lines.length > PROVISIONING_TRACE_STORAGE_LIMIT) {
        lines.splice(0, lines.length - PROVISIONING_TRACE_STORAGE_LIMIT);
      }
      this.runtimeAdapterTraceLinesByRunId.set(progress.runId, lines);
    }
    return {
      ...progress,
      assistantOutput: buildProgressLiveOutput(lines, []) ?? progress.assistantOutput,
    };
  }

  private setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress {
    const nextProgress = this.enrichRuntimeAdapterProgressTrace(progress);
    this.runtimeAdapterProgressByRunId.set(nextProgress.runId, nextProgress);
    if (
      nextProgress.state === 'disconnected' ||
      nextProgress.state === 'failed' ||
      nextProgress.state === 'cancelled'
    ) {
      // Terminal adapter progress stays live for the retained TTL (the stop
      // flow uses the live entry to dedupe a second manual stop while the
      // runtime stop is still pending, and it writes two terminal updates),
      // then the retention timer evicts it together with the trace maps.
      // Without that eviction these maps grow for the lifetime of the process
      // and a dead adapter run id counts as "tracked" in the cleanup
      // staleness guards forever.
      this.retainProvisioningProgress(nextProgress.runId, nextProgress);
    }
    this.sweepRuntimeAdapterRunState();
    onProgress?.(nextProgress);
    return nextProgress;
  }

  /**
   * Evict runtime-adapter run state (progress + trace) for runs that are no
   * longer referenced by any tracking map and have been quiet past the TTL.
   * Without this the per-runId maps grow by one entry per launch/retry for the
   * whole app lifetime. Referenced runs (alive, pending, or tracked by
   * runtimeAdapterRunByTeam) are never evicted, so message-delivery checks and
   * relaunch/recovery reads keep their exact behavior. Evicted progress is
   * retained via retainProvisioningProgress so getProvisioningStatus keeps
   * resolving the runId for the standard retention window.
   */
  private sweepRuntimeAdapterRunState(nowMs: number = Date.now()): void {
    if (
      nowMs - this.lastRuntimeAdapterRunStateSweepAt <
      TeamProvisioningService.RUNTIME_ADAPTER_RUN_STATE_SWEEP_INTERVAL_MS
    ) {
      return;
    }
    this.lastRuntimeAdapterRunStateSweepAt = nowMs;

    const referencedRunIds = new Set<string>();
    for (const runId of this.provisioningRunByTeam.values()) {
      referencedRunIds.add(runId);
    }
    for (const runId of this.aliveRunByTeam.values()) {
      referencedRunIds.add(runId);
    }
    for (const entry of this.runtimeAdapterRunByTeam.values()) {
      referencedRunIds.add(entry.runId);
    }

    const isEvictable = (runId: string): boolean =>
      !this.runs.has(runId) && !referencedRunIds.has(runId);

    for (const [runId, progress] of this.runtimeAdapterProgressByRunId) {
      if (!isEvictable(runId)) {
        continue;
      }
      const updatedAtMs = Date.parse(progress.updatedAt);
      if (
        Number.isFinite(updatedAtMs) &&
        nowMs - updatedAtMs < TeamProvisioningService.RUNTIME_ADAPTER_RUN_STATE_TTL_MS
      ) {
        continue;
      }
      this.retainProvisioningProgress(runId, progress);
      this.runtimeAdapterProgressByRunId.delete(runId);
      this.runtimeAdapterTraceLinesByRunId.delete(runId);
      this.runtimeAdapterTraceKeyByRunId.delete(runId);
    }

    // Trace entries whose progress record is already gone have no readers left.
    for (const runId of [...this.runtimeAdapterTraceLinesByRunId.keys()]) {
      if (!this.runtimeAdapterProgressByRunId.has(runId) && isEvictable(runId)) {
        this.runtimeAdapterTraceLinesByRunId.delete(runId);
        this.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }
    for (const runId of [...this.runtimeAdapterTraceKeyByRunId.keys()]) {
      if (!this.runtimeAdapterProgressByRunId.has(runId) && isEvictable(runId)) {
        this.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }
  }

  private async getPersistedTranscriptClaudeLogs(
    teamName: string
  ): Promise<RetainedClaudeLogsSnapshot | null> {
    const context = await this.transcriptProjectResolver.getContext(teamName);
    const leadSessionId =
      typeof context?.config.leadSessionId === 'string' ? context.config.leadSessionId.trim() : '';
    if (!context || leadSessionId.length === 0) {
      this.persistedTranscriptClaudeLogsCache.delete(teamName);
      return null;
    }

    const transcriptPath = path.join(context.projectDir, `${leadSessionId}.jsonl`);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(transcriptPath);
    } catch {
      this.persistedTranscriptClaudeLogsCache.delete(teamName);
      return null;
    }

    if (!stat.isFile()) {
      this.persistedTranscriptClaudeLogsCache.delete(teamName);
      return null;
    }

    const cached = this.persistedTranscriptClaudeLogsCache.get(teamName);
    if (
      cached?.transcriptPath === transcriptPath &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.size === stat.size
    ) {
      return cached.snapshot;
    }

    const lines = await this.readTranscriptClaudeLogLines(transcriptPath);
    if (lines.length === 0) {
      this.persistedTranscriptClaudeLogsCache.delete(teamName);
      return null;
    }

    const snapshot = {
      lines,
      updatedAt: stat.mtime.toISOString(),
    };
    this.persistedTranscriptClaudeLogsCache.set(teamName, {
      transcriptPath,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      snapshot,
    });
    return snapshot;
  }

  private async readTranscriptClaudeLogLines(filePath: string): Promise<string[]> {
    const lines: string[] = [];
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    try {
      for await (const rawLine of rl) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (!line.trim()) {
          continue;
        }
        lines.push(line);
        const bounded = boundProgressLogLines(lines);
        if (
          bounded.length !== lines.length ||
          bounded.some((boundedLine, index) => boundedLine !== lines[index])
        ) {
          lines.splice(0, lines.length, ...bounded);
        }
      }
    } finally {
      rl.close();
      stream.close();
    }

    return lines;
  }

  private clearSameTeamRetryTimers(teamName: string): void {
    for (const suffix of ['deferred', 'persist']) {
      const key = `same-team-${suffix}:${teamName}`;
      const timer = this.pendingTimeouts.get(key);
      if (timer) {
        clearTimeout(timer);
        this.pendingTimeouts.delete(key);
      }
    }
  }

  private clearLeadInboxFollowUpRelayTimer(teamName: string): void {
    const key = `lead-inbox-follow-up:${teamName}`;
    const timer = this.pendingTimeouts.get(key);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimeouts.delete(key);
    }
  }

  private scheduleLeadInboxFollowUpRelay(teamName: string): void {
    const key = `lead-inbox-follow-up:${teamName}`;
    if (this.pendingTimeouts.has(key)) return;

    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.relayLeadInboxMessages(teamName).catch((error: unknown) =>
        logger.warn(`[${teamName}] lead inbox follow-up relay failed: ${String(error)}`)
      );
    }, 50);
    timer.unref?.();
    this.pendingTimeouts.set(key, timer);
  }

  private resetTeamScopedTransientStateForNewRun(teamName: string): void {
    peekAutoResumeService()?.cancelPendingAutoResume(teamName);
    this.clearOpenCodeRuntimeToolApprovals(teamName, { emitDismiss: true });
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.runtimeProcessRowsForUsageSnapshotByTeam.delete(teamName);
    this.retainedClaudeLogsByTeam.delete(teamName);
    this.persistedTranscriptClaudeLogsCache.delete(teamName);
    this.leadInboxRelayInFlight.delete(teamName);
    this.relayedLeadInboxMessageIds.delete(teamName);
    this.pendingCrossTeamFirstReplies.delete(teamName);
    this.recentCrossTeamLeadDeliveryMessageIds.delete(teamName);
    this.recentSameTeamNativeFingerprints.delete(teamName);
    this.clearSameTeamRetryTimers(teamName);
    this.clearLeadInboxFollowUpRelayTimer(teamName);

    for (const key of Array.from(this.memberInboxRelayInFlight.keys())) {
      if (key.startsWith(`${teamName}:`)) {
        this.memberInboxRelayInFlight.delete(key);
      }
    }
    for (const key of Array.from(this.openCodeMemberInboxRelayInFlight.keys())) {
      if (key.startsWith(`opencode:${teamName}:`)) {
        this.openCodeMemberInboxRelayInFlight.delete(key);
      }
    }
    for (const key of Array.from(this.openCodeMemberSendInFlightByLane.keys())) {
      if (key.startsWith(`opencode-send:${teamName}:`)) {
        this.openCodeMemberSendInFlightByLane.delete(key);
      }
    }
    this.openCodePromptDeliveryWatchdogScheduler.cancelTeam(teamName);
    for (const key of Array.from(this.relayedMemberInboxMessageIds.keys())) {
      if (key.startsWith(`${teamName}:`)) {
        this.relayedMemberInboxMessageIds.delete(key);
      }
    }

    this.liveLeadProcessMessages.delete(teamName);
  }

  private appendCliLogs(run: ProvisioningRun, stream: 'stdout' | 'stderr', text: string): void {
    const nowMs = Date.now();
    run.claudeLogsUpdatedAt = new Date(nowMs).toISOString();

    const marker = stream === 'stdout' ? '[stdout]' : '[stderr]';
    if (run.lastClaudeLogStream !== stream) {
      run.lastClaudeLogStream = stream;
      run.claudeLogLines.push(marker);
    }

    if (stream === 'stdout') {
      run.stdoutLogLineBuf += text;
      const parts = run.stdoutLogLineBuf.split('\n');
      run.stdoutLogLineBuf = boundPendingLogLineCarry(parts.pop() ?? '');
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(boundSingleRetainedLogLine(normalized));
      }
    } else {
      run.stderrLogLineBuf += text;
      const parts = run.stderrLogLineBuf.split('\n');
      run.stderrLogLineBuf = boundPendingLogLineCarry(parts.pop() ?? '');
      for (const part of parts) {
        const normalized = part.endsWith('\r') ? part.slice(0, -1) : part;
        run.claudeLogLines.push(boundSingleRetainedLogLine(normalized));
      }
    }
    boundRunClaudeLogLines(run);
  }

  /**
   * Serializes operations per team name using promise-chaining.
   * Same pattern as withInboxLock / withTaskLock.
   * Prevents TOCTOU races between concurrent createTeam/launchTeam calls.
   */
  private async withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.teamOpLocks.get(teamName) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.teamOpLocks.set(teamName, mine);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.teamOpLocks.get(teamName) === mine) {
        this.teamOpLocks.delete(teamName);
      }
    }
  }

  setTeamChangeEmitter(emitter: ((event: TeamChangeEvent) => void) | null): void {
    this.teamChangeEmitter = emitter;
  }

  private parseCrossTeamRecipient(
    currentTeam: string,
    recipient: string,
    localRecipientNames: Set<string>
  ): { teamName: string; memberName: string } | null {
    return parseCrossTeamRecipientHelper(currentTeam, recipient, localRecipientNames);
  }

  private extractCrossTeamPseudoTargetTeam(value: string): string | null {
    return extractCrossTeamPseudoTargetTeamHelper(value);
  }

  private isCrossTeamToolRecipientName(name: string): boolean {
    return isCrossTeamToolRecipientNameHelper(name);
  }

  private isCrossTeamPseudoRecipientName(name: string): boolean {
    return isCrossTeamPseudoRecipientNameHelper(name);
  }

  private resolveSingleActiveCrossTeamReplyHint(
    run: ProvisioningRun
  ): { toTeam: string; conversationId: string } | null {
    return resolveSingleActiveCrossTeamReplyHintHelper(run.activeCrossTeamReplyHints);
  }

  private looksLikeQualifiedExternalRecipientName(name: string): boolean {
    return looksLikeQualifiedExternalRecipientNameHelper(name);
  }

  private buildCrossTeamConversationKey(otherTeam: string, conversationId: string): string {
    return buildCrossTeamConversationKeyHelper(otherTeam, conversationId);
  }

  registerPendingCrossTeamReplyExpectation(
    teamName: string,
    otherTeam: string,
    conversationId: string
  ): void {
    registerPendingCrossTeamReplyExpectationHelper(
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
    clearPendingCrossTeamReplyExpectationHelper(
      this.pendingCrossTeamFirstReplies,
      teamName,
      otherTeam,
      conversationId
    );
  }

  private getPendingCrossTeamReplyExpectationKeys(teamName: string): Set<string> {
    return getPendingCrossTeamReplyExpectationKeysHelper(
      this.pendingCrossTeamFirstReplies,
      teamName,
      Date.now(),
      TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS
    );
  }

  private getRunLeadName(run: ProvisioningRun): string {
    const members = Array.isArray(run.request?.members) ? run.request.members : [];
    return members.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
  }

  private rememberRecentCrossTeamLeadDeliveryMessageIds(
    teamName: string,
    messageIds: string[]
  ): void {
    rememberRecentCrossTeamLeadDeliveryMessageIdsHelper(
      this.recentCrossTeamLeadDeliveryMessageIds,
      teamName,
      messageIds,
      Date.now(),
      TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS
    );
  }

  private wasRecentlyDeliveredToLead(teamName: string, messageId: string): boolean {
    return wasRecentlyDeliveredToLeadHelper(
      this.recentCrossTeamLeadDeliveryMessageIds,
      teamName,
      messageId,
      Date.now(),
      TeamProvisioningService.RECENT_CROSS_TEAM_DELIVERY_TTL_MS
    );
  }

  private parseCrossTeamTargetTeam(value: string | undefined): string | null {
    return parseCrossTeamTargetTeamHelper(value);
  }

  private getCrossTeamSourceTeam(value: string | undefined): string | null {
    return getCrossTeamSourceTeamHelper(value);
  }

  private async matchCrossTeamLeadInboxMessages(
    teamName: string,
    leadName: string,
    deliveredBlocks: {
      teammateId: string;
      content: string;
      toTeam: string;
      conversationId: string;
    }[]
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
    const rawText = extractStreamUserText(msg);
    if (!rawText) return;

    const blocks = parseAllTeammateMessages(rawText);
    if (blocks.length === 0) return;

    // Intercept teammate permission_request messages delivered natively via stdout.
    // This runs even during provisioning (unlike relayLeadInboxMessages which waits
    // for provisioningComplete). The lead already received the message — we can't
    // prevent that — but we create a ToolApprovalRequest so the user sees the dialog.
    for (const block of blocks) {
      const perm = parsePermissionRequest(block.content);
      if (perm) {
        this.handleTeammatePermissionRequest(run, perm, new Date().toISOString());
      }
    }

    const crossTeamBlocks = blocks.flatMap((block) => {
      const origin = parseCrossTeamPrefix(block.content);
      const sourceTeam = origin?.from.includes('.') ? origin.from.split('.', 1)[0] : null;
      const conversationId =
        origin?.conversationId?.trim() || origin?.replyToConversationId?.trim();
      if (!sourceTeam || !conversationId) return [];
      return [
        {
          teammateId: block.teammateId,
          content: block.content,
          toTeam: sourceTeam,
          conversationId,
        },
      ];
    });
    // Cross-team reconciliation (existing logic)
    if (crossTeamBlocks.length > 0) {
      const leadName = this.getRunLeadName(run);
      void (async () => {
        const matches = await this.matchCrossTeamLeadInboxMessages(
          run.teamName,
          leadName,
          crossTeamBlocks
        );
        const unreadMatches = matches.filter((match) => !match.wasRead);
        if (unreadMatches.length > 0) {
          try {
            await this.markInboxMessagesRead(run.teamName, leadName, unreadMatches);
          } catch {
            // best-effort
          }
        }
        const freshMatches = matches.filter(
          (match) => !this.wasRecentlyDeliveredToLead(run.teamName, match.messageId)
        );
        this.rememberRecentCrossTeamLeadDeliveryMessageIds(
          run.teamName,
          freshMatches.map((match) => match.messageId)
        );
        run.activeCrossTeamReplyHints = freshMatches.map((match) => ({
          toTeam: match.toTeam,
          conversationId: match.conversationId,
        }));
      })();
    }

    // Same-team teammate messages are the canonical heartbeat signal: they prove the
    // runtime produced a real post-spawn message, unlike writes to inboxes/<member>.json
    // which may simply be user/lead messages addressed TO the teammate.
    const sameTeamBlocks = blocks.filter((block) => !parseCrossTeamPrefix(block.content));
    const meaningfulSameTeamBlocks = sameTeamBlocks.filter((block) =>
      isMeaningfulBootstrapCheckInMessage(block.content)
    );
    for (const block of meaningfulSameTeamBlocks) {
      this.setMemberSpawnStatus(run, block.teammateId, 'online', undefined, 'heartbeat');
    }
    for (const block of sameTeamBlocks) {
      const bootstrapFailureReason = extractBootstrapFailureReason(block.content);
      if (!bootstrapFailureReason) continue;
      this.setMemberSpawnStatus(run, block.teammateId, 'error', bootstrapFailureReason);
    }
    if (sameTeamBlocks.length > 0) {
      this.rememberSameTeamNativeFingerprints(run.teamName, sameTeamBlocks);
      const leadName = this.getRunLeadName(run);
      void this.reconcileSameTeamNativeDeliveries(run.teamName, leadName);
    }
  }

  private async refreshMemberSpawnStatusesFromLeadInbox(run: ProvisioningRun): Promise<void> {
    const leadName = this.getRunLeadName(run);
    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(run.teamName, leadName);
    } catch {
      return;
    }

    const runStartedAtMs = Date.parse(run.startedAt);
    const expectedMembers = Array.isArray(run.expectedMembers) ? run.expectedMembers : [];
    const teammateMessages = leadInboxMessages
      .filter((message): message is LeadInboxMemberSpawnMessage => {
        const from = typeof message.from === 'string' ? message.from.trim() : '';
        if (!from || from === leadName || from === 'user' || from === 'system') return false;
        if (!this.resolveExpectedLaunchMemberName(expectedMembers, from)) return false;
        if (typeof message.messageId !== 'string' || message.messageId.trim().length === 0) {
          return false;
        }
        const messageTs = Date.parse(message.timestamp);
        if (
          Number.isFinite(messageTs) &&
          Number.isFinite(runStartedAtMs) &&
          messageTs < runStartedAtMs
        ) {
          return false;
        }
        return typeof message.text === 'string' && message.text.trim().length > 0;
      })
      .sort((left, right) =>
        compareMemberSpawnInboxCursor(
          { timestamp: left.timestamp, messageId: left.messageId },
          { timestamp: right.timestamp, messageId: right.messageId }
        )
      );

    const messagesByMember = new Map<string, LeadInboxMemberSpawnMessage[]>();
    for (const message of teammateMessages) {
      const memberName = this.resolveExpectedLaunchMemberName(expectedMembers, message.from);
      if (!memberName) {
        continue;
      }
      const bucket = messagesByMember.get(memberName) ?? [];
      bucket.push(message);
      messagesByMember.set(memberName, bucket);
    }

    for (const [memberName, messages] of messagesByMember.entries()) {
      const currentCursor = run.memberSpawnLeadInboxCursorByMember.get(memberName);
      let nextCursor = currentCursor;

      for (const message of messages) {
        const messageCursor = toMemberSpawnInboxCursor(message);
        const effectiveCursor = nextCursor ?? currentCursor;
        if (messageCursor && effectiveCursor) {
          if (compareMemberSpawnInboxCursor(messageCursor, effectiveCursor) <= 0) {
            continue;
          }
        }

        this.applyLeadInboxSpawnSignal(run, memberName, message);
        if (messageCursor) {
          nextCursor = maxMemberSpawnInboxCursor(nextCursor, messageCursor);
        }
      }

      if (
        nextCursor &&
        (currentCursor == null || compareMemberSpawnInboxCursor(nextCursor, currentCursor) > 0)
      ) {
        run.memberSpawnLeadInboxCursorByMember.set(memberName, nextCursor);
      }
    }
  }

  private applyLeadInboxSpawnSignal(
    run: ProvisioningRun,
    memberName: string,
    message: LeadInboxMemberSpawnMessage
  ): void {
    const reason = extractBootstrapFailureReason(message.text);
    if (reason) {
      this.setMemberSpawnStatus(run, memberName, 'error', reason);
      return;
    }
    this.setMemberSpawnStatus(
      run,
      memberName,
      'online',
      undefined,
      'heartbeat',
      extractHeartbeatTimestamp(message.text, message.timestamp)
    );
  }

  private resolveExpectedLaunchMemberName(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null {
    const trimmedCandidate = candidateName.trim();
    if (!trimmedCandidate || !Array.isArray(expectedMembers) || expectedMembers.length === 0) {
      return null;
    }

    const exact = expectedMembers.find((memberName) =>
      matchesExactTeamMemberName(memberName, trimmedCandidate)
    );
    if (exact) {
      return exact;
    }

    const matches = expectedMembers.filter((memberName) =>
      matchesObservedMemberNameForExpected(trimmedCandidate, memberName)
    );
    return matches.length === 1 ? (matches[0] ?? null) : null;
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
    return `${teamName}:${memberName.trim()}`;
  }

  private getOpenCodeMemberRelayKey(teamName: string, memberName: string): string {
    return `opencode:${this.getMemberRelayKey(teamName, memberName)}`;
  }

  private getOpenCodeMemberSendLaneKey(teamName: string, laneId: string): string {
    return `opencode-send:${teamName}:${laneId.trim()}`;
  }

  private async sendOpenCodeMemberMessageToRuntimeSerialized(input: {
    teamName: string;
    laneId: string;
    send: () => Promise<OpenCodeTeamRuntimeMessageResult>;
  }): Promise<OpenCodeTeamRuntimeMessageResult> {
    const laneKey = this.getOpenCodeMemberSendLaneKey(input.teamName, input.laneId);
    const previous = this.openCodeMemberSendInFlightByLane.get(laneKey);
    const work = (async (): Promise<OpenCodeTeamRuntimeMessageResult> => {
      if (previous) {
        try {
          await previous;
        } catch {
          // A failed send must not permanently block later deliveries on the same lane.
        }
      }
      return await input.send();
    })();

    this.openCodeMemberSendInFlightByLane.set(laneKey, work);
    try {
      return await work;
    } finally {
      if (this.openCodeMemberSendInFlightByLane.get(laneKey) === work) {
        this.openCodeMemberSendInFlightByLane.delete(laneKey);
      }
    }
  }

  private async waitForInboxRelayInFlight<T>(input: {
    promise: Promise<T>;
    relayName: string;
    relayKey: string;
  }): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        input.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new InboxRelayInFlightTimeoutError(
                `${input.relayName} timed out after ${TeamProvisioningService.INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS}ms: ${input.relayKey}`
              )
            );
          }, TeamProvisioningService.INBOX_RELAY_IN_FLIGHT_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private normalizeRelayCandidateText(text: string): string {
    return stripAgentBlocks(String(text)).trim().replace(/\r\n/g, '\n');
  }

  private normalizeRelayCandidateSummary(summary?: string): string {
    return typeof summary === 'string' ? summary.trim() : '';
  }

  private prunePendingInboxRelayCandidates(run: ProvisioningRun): PendingInboxRelayCandidate[] {
    const cutoff = Date.now() - TeamProvisioningService.PENDING_INBOX_RELAY_TTL_MS;
    run.pendingInboxRelayCandidates = (run.pendingInboxRelayCandidates ?? []).filter(
      (candidate) => candidate.queuedAtMs >= cutoff
    );
    return run.pendingInboxRelayCandidates;
  }

  private rememberPendingInboxRelayCandidates(
    run: ProvisioningRun,
    recipient: string,
    messages: Pick<InboxMessage, 'messageId' | 'text' | 'summary'>[]
  ): string[] {
    const candidates = this.prunePendingInboxRelayCandidates(run);
    const queuedAtMs = Date.now();
    const rememberedIds: string[] = [];
    for (const message of messages) {
      const sourceMessageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      const normalizedText = this.normalizeRelayCandidateText(message.text);
      if (!sourceMessageId || !normalizedText) {
        continue;
      }
      candidates.push({
        recipient,
        sourceMessageId,
        normalizedText,
        normalizedSummary: this.normalizeRelayCandidateSummary(message.summary),
        queuedAtMs,
      });
      rememberedIds.push(sourceMessageId);
    }
    return rememberedIds;
  }

  private forgetPendingInboxRelayCandidates(
    run: ProvisioningRun,
    recipient: string,
    sourceMessageIds: readonly string[]
  ): void {
    if (sourceMessageIds.length === 0) {
      return;
    }
    const idSet = new Set(sourceMessageIds);
    run.pendingInboxRelayCandidates = this.prunePendingInboxRelayCandidates(run).filter(
      (candidate) => !(candidate.recipient === recipient && idSet.has(candidate.sourceMessageId))
    );
  }

  private consumePendingInboxRelayCandidate(
    run: ProvisioningRun,
    recipient: string,
    text: string,
    summary?: string
  ): string | undefined {
    const normalizedText = this.normalizeRelayCandidateText(text);
    if (!normalizedText) {
      return undefined;
    }
    const normalizedSummary = this.normalizeRelayCandidateSummary(summary);
    const candidates = this.prunePendingInboxRelayCandidates(run);
    const exactSummaryIdx = candidates.findIndex(
      (candidate) =>
        candidate.recipient === recipient &&
        candidate.normalizedText === normalizedText &&
        candidate.normalizedSummary === normalizedSummary
    );
    const fallbackIdx =
      exactSummaryIdx >= 0
        ? exactSummaryIdx
        : candidates.findIndex(
            (candidate) =>
              candidate.recipient === recipient && candidate.normalizedText === normalizedText
          );
    if (fallbackIdx < 0) {
      return undefined;
    }
    const [matched] = candidates.splice(fallbackIdx, 1);
    return matched?.sourceMessageId;
  }

  private armSilentTeammateForward(
    run: ProvisioningRun,
    teammateName: string,
    mode: 'user_dm' | 'member_inbox_relay'
  ): void {
    run.silentUserDmForward = { target: teammateName, startedAt: nowIso(), mode };
    if (run.silentUserDmForwardClearHandle) {
      clearTimeout(run.silentUserDmForwardClearHandle);
      run.silentUserDmForwardClearHandle = null;
    }
    run.silentUserDmForwardClearHandle = setTimeout(() => {
      run.silentUserDmForward = null;
      run.silentUserDmForwardClearHandle = null;
    }, 60_000);
    run.silentUserDmForwardClearHandle.unref();
  }

  private toolApprovalEventEmitter: ((event: ToolApprovalEvent) => void) | null = null;
  private mainWindowRef: import('electron').BrowserWindow | null = null;
  private activeApprovalNotifications = new Map<string, import('electron').Notification>();

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
    const runId = this.getTrackedRunId(teamName);
    const detectedSessionId = runId ? (this.runs.get(runId)?.detectedSessionId ?? null) : null;

    return (this.liveLeadProcessMessages.get(teamName) ?? []).map((message) =>
      !message.leadSessionId && detectedSessionId
        ? { ...message, leadSessionId: detectedSessionId }
        : { ...message }
    );
  }

  private pruneLiveLeadMessagesForCleanedRun(run: ProvisioningRun): void {
    const list = this.liveLeadProcessMessages.get(run.teamName);
    if (!list || list.length === 0) {
      return;
    }

    const runMessageIdPrefixes = [
      `lead-turn-${run.runId}-`,
      `lead-sendmsg-${run.runId}-`,
      `lead-process-${run.runId}-`,
      `compact-${run.runId}-`,
    ];

    const filtered = list.filter((message) => {
      const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      if (messageId && runMessageIdPrefixes.some((prefix) => messageId.startsWith(prefix))) {
        return false;
      }

      if (run.detectedSessionId && message.leadSessionId === run.detectedSessionId) {
        return false;
      }

      return true;
    });

    if (filtered.length === 0) {
      this.liveLeadProcessMessages.delete(run.teamName);
      return;
    }

    this.liveLeadProcessMessages.set(run.teamName, filtered);
  }

  getCurrentLeadSessionId(teamName: string): string | null {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) return null;
    return this.runs.get(runId)?.detectedSessionId ?? null;
  }

  getCurrentRunId(teamName: string): string | null {
    return this.getAliveRunId(teamName);
  }

  async recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    const payload = asRuntimeRecord(raw);
    const teamName = requireRuntimeString(payload.teamName, 'teamName');
    const runId = requireRuntimeString(payload.runId, 'runId');
    const memberName = requireRuntimeString(payload.memberName, 'memberName');
    const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
    const observedAt = normalizeRuntimeIso(payload.observedAt);
    const laneId = await this.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });

    await this.assertOpenCodeRuntimeEvidenceAccepted({
      teamName,
      runId,
      laneId,
      evidenceKind: 'bootstrap_checkin',
    });
    const idempotent = await this.resolveOpenCodeRuntimeBootstrapCheckinIdempotency({
      teamName,
      runId,
      memberName,
      runtimeSessionId,
    });
    const bootstrapEvidencePorts = this.createOpenCodeRuntimeBootstrapEvidencePorts();
    await this.assertOpenCodeRuntimeMemberCheckinAllowed({
      teamName,
      memberName,
      previousMember: idempotent.previousMember,
    });
    if (idempotent.state === 'duplicate') {
      const committed = await hasCommittedOpenCodeRuntimeBootstrapSessionEvidence(
        {
          teamName,
          runId,
          laneId,
          memberName,
          runtimeSessionId,
        },
        bootstrapEvidencePorts
      );
      if (!committed) {
        await commitOpenCodeRuntimeBootstrapSessionEvidence(
          {
            teamName,
            runId,
            laneId,
            memberName,
            runtimeSessionId,
            observedAt,
          },
          bootstrapEvidencePorts
        );
      }
      await this.updateOpenCodeRuntimeMemberLiveness({
        teamName,
        runId,
        memberName,
        runtimeSessionId,
        observedAt,
        diagnostics: payload.diagnostics,
        metadata: parseRuntimeToolMetadata(payload.metadata),
        reason: 'OpenCode runtime bootstrap check-in accepted',
      });
      return {
        ok: true,
        providerId: 'opencode',
        teamName,
        runId,
        state: 'accepted',
        memberName,
        runtimeSessionId,
        diagnostics: ['opencode_bootstrap_checkin_duplicate_accepted'],
        observedAt,
      };
    }
    if (idempotent.state === 'conflict') {
      throw new RuntimeStaleEvidenceError(
        `opencode_bootstrap_checkin_session_conflict: existing runtime session ${idempotent.existingRuntimeSessionId}, received ${runtimeSessionId} for ${memberName}`,
        'run_mismatch',
        'bootstrap_checkin',
        runId
      );
    }
    await commitOpenCodeRuntimeBootstrapSessionEvidence(
      {
        teamName,
        runId,
        laneId,
        memberName,
        runtimeSessionId,
        observedAt,
      },
      bootstrapEvidencePorts
    );
    await this.updateOpenCodeRuntimeMemberLiveness({
      teamName,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      diagnostics: payload.diagnostics,
      metadata: parseRuntimeToolMetadata(payload.metadata),
      reason: 'OpenCode runtime bootstrap check-in accepted',
    });

    return {
      ok: true,
      providerId: 'opencode',
      teamName,
      runId,
      state: 'accepted',
      memberName,
      runtimeSessionId,
      diagnostics: [],
      observedAt,
    };
  }

  private async resolveOpenCodeRuntimeBootstrapCheckinIdempotency(input: {
    teamName: string;
    runId: string;
    memberName: string;
    runtimeSessionId: string;
  }): Promise<OpenCodeRuntimeBootstrapCheckinIdempotencyResult> {
    const snapshot = await this.launchStateStore.read(input.teamName);
    const previousMember = snapshot?.members[input.memberName];
    return resolveOpenCodeRuntimeBootstrapCheckinIdempotencyFromMember({
      previousMember,
      runId: input.runId,
      runtimeSessionId: input.runtimeSessionId,
    });
  }

  private async assertOpenCodeRuntimeMemberCheckinAllowed(input: {
    teamName: string;
    memberName: string;
    previousMember?: PersistedTeamLaunchMemberState;
  }): Promise<void> {
    const config = await this.readConfigForStrictDecision(input.teamName).catch(() => null);
    const metaMembers = await this.membersMetaStore.getMembers(input.teamName).catch(() => []);
    const configuredMember = this.resolveEffectiveConfiguredMember(
      config?.members ?? [],
      metaMembers,
      input.memberName
    );

    if (configuredMember?.removedAt != null) {
      throw new RuntimeStaleEvidenceError(
        `Rejected OpenCode bootstrap check-in for removed member "${input.memberName}"`,
        'run_mismatch',
        'bootstrap_checkin',
        null
      );
    }

    if (!configuredMember && !input.previousMember) {
      throw new RuntimeStaleEvidenceError(
        `Rejected OpenCode bootstrap check-in for unconfigured member "${input.memberName}"`,
        'run_mismatch',
        'bootstrap_checkin',
        null
      );
    }
  }

  async deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    const payload = asRuntimeRecord(raw);
    const teamName = requireRuntimeString(payload.teamName, 'teamName');
    const runId = requireRuntimeString(payload.runId, 'runId');
    const fromMemberName = requireRuntimeString(payload.fromMemberName, 'fromMemberName');
    const laneId = await this.resolveOpenCodeRuntimeLaneId({
      teamName,
      runId,
      memberName: fromMemberName,
    });
    await this.assertOpenCodeRuntimeEvidenceAccepted({
      teamName,
      runId,
      laneId,
      evidenceKind: 'delivery_call',
    });

    const delivery = this.createOpenCodeRuntimeDeliveryService(teamName, laneId);
    const ack = await delivery.deliver({
      ...payload,
      teamName,
      runId,
      providerId: 'opencode',
      createdAt: normalizeRuntimeIso(payload.createdAt),
    });

    if (!ack.ok) {
      throw new Error(`OpenCode runtime delivery rejected: ${ack.reason}`);
    }

    return {
      ok: true,
      providerId: 'opencode',
      teamName,
      runId,
      state: ack.delivered ? 'delivered' : 'duplicate',
      idempotencyKey: ack.idempotencyKey,
      location: ack.location,
      diagnostics: ack.reason ? [ack.reason] : [],
      observedAt: normalizeRuntimeIso(payload.createdAt),
    };
  }

  async recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    const payload = asRuntimeRecord(raw);
    const teamName = requireRuntimeString(payload.teamName, 'teamName');
    const runId = requireRuntimeString(payload.runId, 'runId');
    const memberName = requireRuntimeString(payload.memberName, 'memberName');
    const taskId = requireRuntimeString(payload.taskId, 'taskId');
    const event = requireRuntimeString(payload.event, 'event');
    const idempotencyKey = requireRuntimeString(payload.idempotencyKey, 'idempotencyKey');
    const runtimeSessionId = optionalRuntimeString(payload.runtimeSessionId);
    const observedAt = normalizeRuntimeIso(payload.createdAt);
    const laneId = await this.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });

    await this.assertOpenCodeRuntimeEvidenceAccepted({
      teamName,
      runId,
      laneId,
      evidenceKind: 'delivery_call',
    });

    const writeResult = await this.openCodeTaskLogAttributionStore.upsertTaskRecord(teamName, {
      taskId,
      memberName,
      scope: 'member_session_window',
      ...(runtimeSessionId ? { sessionId: runtimeSessionId } : {}),
      since: observedAt,
      source: 'launch_runtime',
    });
    this.teamChangeEmitter?.({
      type: 'task-log-change',
      teamName,
      runId,
      taskId,
      detail: `opencode-runtime-task-event:${event}`,
      taskSignalKind: 'log',
    });

    return {
      ok: true,
      providerId: 'opencode',
      teamName,
      runId,
      state: 'recorded',
      memberName,
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
      idempotencyKey,
      diagnostics: [writeResult],
      observedAt,
    };
  }

  async recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck> {
    const payload = asRuntimeRecord(raw);
    const teamName = requireRuntimeString(payload.teamName, 'teamName');
    const runId = requireRuntimeString(payload.runId, 'runId');
    const memberName = requireRuntimeString(payload.memberName, 'memberName');
    const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
    const observedAt = normalizeRuntimeIso(payload.observedAt);
    const laneId = await this.resolveOpenCodeRuntimeLaneId({ teamName, runId, memberName });

    await this.assertOpenCodeRuntimeEvidenceAccepted({
      teamName,
      runId,
      laneId,
      evidenceKind: 'heartbeat',
    });
    await this.updateOpenCodeRuntimeMemberLiveness({
      teamName,
      runId,
      memberName,
      runtimeSessionId,
      observedAt,
      diagnostics: undefined,
      metadata: parseRuntimeToolMetadata(payload.metadata),
      reason: `OpenCode runtime heartbeat accepted${optionalRuntimeString(payload.status) ? ` (${optionalRuntimeString(payload.status)})` : ''}`,
    });

    return {
      ok: true,
      providerId: 'opencode',
      teamName,
      runId,
      state: 'accepted',
      memberName,
      runtimeSessionId,
      diagnostics: [],
      observedAt,
    };
  }

  private async assertOpenCodeRuntimeEvidenceAccepted(input: {
    teamName: string;
    runId: string;
    laneId: string;
    evidenceKind: RuntimeEvidenceKind;
  }): Promise<void> {
    const store = createRuntimeRunTombstoneStore({
      filePath: getOpenCodeRuntimeRunTombstonesPath(
        getTeamsBasePath(),
        input.teamName,
        input.laneId
      ),
    });
    await store.assertEvidenceAccepted({
      teamName: input.teamName,
      runId: input.runId,
      currentRunId: await this.resolveCurrentOpenCodeRuntimeRunId(input.teamName, input.laneId),
      evidenceKind: input.evidenceKind,
    });
  }

  private async updateOpenCodeRuntimeMemberLiveness(input: {
    teamName: string;
    runId: string;
    memberName: string;
    runtimeSessionId: string;
    observedAt: string;
    diagnostics: unknown;
    metadata?: RuntimeToolMetadata;
    reason: string;
  }): Promise<void> {
    const trackedUpdate = this.applyOpenCodeRuntimeBootstrapCheckinToTrackedRun(input);
    if (trackedUpdate) {
      await this.persistLaunchStateSnapshot(
        trackedUpdate.run,
        this.getMixedSecondaryLaunchPhase(trackedUpdate.run)
      );
      this.invalidateRuntimeSnapshotCaches(input.teamName);
      if (trackedUpdate.changed) {
        this.emitMemberSpawnChange(trackedUpdate.run, input.memberName);
      }
      return;
    }

    const previous = await this.launchStateStore.read(input.teamName);
    const expectedMembers = previous
      ? this.getPersistedLaunchMemberNames(previous)
      : this.readPersistedRuntimeMembers(input.teamName)
          .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
          .filter((name) => name.length > 0 && name !== 'user' && !isLeadMember({ name }));
    const previousMember = previous?.members[input.memberName];
    const previousRuntimeRunId =
      typeof previousMember?.runtimeRunId === 'string' ? previousMember.runtimeRunId.trim() : '';
    const sameRuntimeRun = previousRuntimeRunId.length > 0 && previousRuntimeRunId === input.runId;
    const shouldEmitMemberSpawnChange = this.shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange({
      previousMember,
      runtimeRunId: input.runId,
      runtimeSessionId: input.runtimeSessionId,
      runtimePid: input.metadata?.runtimePid,
    });
    const runtimePid =
      input.metadata?.runtimePid ?? (sameRuntimeRun ? previousMember?.runtimePid : undefined);
    const pidSource = input.metadata?.runtimePid
      ? ('runtime_bootstrap' as const)
      : sameRuntimeRun
        ? previousMember?.pidSource
        : undefined;
    const persistedIdentity = this.resolvePersistedRuntimeMemberIdentity({
      teamName: input.teamName,
      memberName: input.memberName,
      previousMember,
    });
    const nextMember: PersistedTeamLaunchMemberState = {
      ...persistedIdentity,
      ...(previousMember ?? {}),
      name: input.memberName,
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      bootstrapStalled: undefined,
      runtimePid,
      runtimeRunId: input.runId,
      runtimeSessionId: input.runtimeSessionId,
      livenessKind: 'confirmed_bootstrap',
      pidSource,
      runtimeDiagnostic: input.reason,
      runtimeDiagnosticSeverity: 'info',
      runtimeLastSeenAt: input.observedAt,
      firstSpawnAcceptedAt: previousMember?.firstSpawnAcceptedAt ?? input.observedAt,
      lastHeartbeatAt: input.observedAt,
      lastRuntimeAliveAt: input.observedAt,
      lastEvaluatedAt: input.observedAt,
      sources: {
        ...(previousMember?.sources ?? {}),
        nativeHeartbeat: true,
        processAlive: true,
      },
      diagnostics: mergeRuntimeDiagnostics(
        previousMember?.diagnostics,
        [
          ...normalizeRuntimeStringArray(input.diagnostics),
          ...buildRuntimeToolMetadataDiagnostics(input.metadata),
        ],
        input.reason
      ),
    };
    const snapshot = createPersistedLaunchSnapshot({
      teamName: input.teamName,
      expectedMembers: [...new Set([...expectedMembers, input.memberName])],
      leadSessionId: previous?.leadSessionId,
      launchPhase: previous?.launchPhase ?? 'active',
      members: {
        ...(previous?.members ?? {}),
        [input.memberName]: nextMember,
      },
      updatedAt: input.observedAt,
    });
    await this.writeLaunchStateSnapshot(input.teamName, snapshot);
    if (shouldEmitMemberSpawnChange) {
      this.teamChangeEmitter?.({
        type: 'member-spawn',
        teamName: input.teamName,
        runId: input.runId,
        detail: input.memberName,
      });
    }
  }

  private applyOpenCodeRuntimeBootstrapCheckinToTrackedRun(input: {
    teamName: string;
    runId: string;
    memberName: string;
    runtimeSessionId: string;
    observedAt: string;
    diagnostics: unknown;
    metadata?: RuntimeToolMetadata;
    reason: string;
  }): { run: ProvisioningRun; changed: boolean } | null {
    const trackedRunId = this.getTrackedRunId(input.teamName);
    const run = trackedRunId ? this.runs.get(trackedRunId) : undefined;
    if (!run || run.processKilled || run.cancelRequested) {
      return null;
    }

    const lane = (run.mixedSecondaryLanes ?? []).find((candidate) => {
      if (candidate.providerId !== 'opencode') {
        return false;
      }
      if (!matchesTeamMemberIdentity(candidate.member.name, input.memberName)) {
        return false;
      }
      return !candidate.runId || candidate.runId === input.runId;
    });
    if (!lane) {
      return null;
    }

    const runtimePid = input.metadata?.runtimePid;
    const runtimeDiagnostics = mergeRuntimeDiagnostics(
      lane.result?.members[input.memberName]?.diagnostics ?? lane.diagnostics,
      [
        ...normalizeRuntimeStringArray(input.diagnostics),
        ...buildRuntimeToolMetadataDiagnostics(input.metadata),
        'opencode_bootstrap_evidence_committed',
      ],
      input.reason
    );
    const evidence: TeamRuntimeMemberLaunchEvidence = {
      memberName: input.memberName,
      providerId: 'opencode',
      launchState: 'confirmed_alive',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      sessionId: input.runtimeSessionId,
      backendType: 'process',
      ...(runtimePid ? { runtimePid, pidSource: 'runtime_bootstrap' as const } : {}),
      livenessKind: 'confirmed_bootstrap',
      runtimeDiagnostic: input.reason,
      runtimeDiagnosticSeverity: 'info',
      diagnostics: runtimeDiagnostics ?? [input.reason],
    };

    const previousLaneState = lane.state;
    const previousLaneRunId = lane.runId;
    const previousLaneMember = lane.result?.members[input.memberName];
    lane.runId = input.runId;
    lane.state = 'finished';
    lane.diagnostics = runtimeDiagnostics ?? lane.diagnostics;
    lane.result = {
      ...(lane.result ?? {
        runId: input.runId,
        teamName: input.teamName,
        launchPhase: 'finished' as const,
        teamLaunchState: 'partial_pending' as const,
        members: {},
        warnings: lane.warnings,
        diagnostics: [],
      }),
      runId: input.runId,
      teamName: input.teamName,
      launchPhase: 'finished',
      members: {
        ...(lane.result?.members ?? {}),
        [input.memberName]: evidence,
      },
      warnings: lane.result?.warnings ?? lane.warnings,
      diagnostics: runtimeDiagnostics ?? lane.result?.diagnostics ?? lane.diagnostics,
    };
    lane.result.teamLaunchState = summarizeRuntimeLaunchResultMembers(lane.result.members);

    const previousStatus =
      run.memberSpawnStatuses.get(input.memberName) ?? createInitialMemberSpawnStatusEntry();
    const nextStatus: MemberSpawnStatusEntry = {
      ...previousStatus,
      status: 'online',
      launchState: 'confirmed_alive',
      error: undefined,
      hardFailureReason: undefined,
      skippedForLaunch: undefined,
      skipReason: undefined,
      skippedAt: undefined,
      livenessSource: 'heartbeat',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: true,
      hardFailure: false,
      bootstrapStalled: undefined,
      pendingPermissionRequestIds: undefined,
      firstSpawnAcceptedAt: previousStatus.firstSpawnAcceptedAt ?? input.observedAt,
      lastHeartbeatAt: input.observedAt,
      runtimeModel: lane.member.model,
      livenessKind: 'confirmed_bootstrap',
      runtimeDiagnostic: input.reason,
      runtimeDiagnosticSeverity: 'info',
      livenessLastCheckedAt: input.observedAt,
      updatedAt: input.observedAt,
    };
    this.syncMemberTaskActivityForRuntimeTransition(
      run,
      input.memberName,
      previousStatus,
      nextStatus,
      input.observedAt
    );
    run.memberSpawnStatuses.set(input.memberName, nextStatus);
    run.pendingMemberRestarts?.delete(input.memberName);
    this.syncMemberLaunchGraceCheck(run, input.memberName, nextStatus);

    const statusChanged =
      previousStatus.status !== nextStatus.status ||
      previousStatus.launchState !== nextStatus.launchState ||
      previousStatus.bootstrapConfirmed !== nextStatus.bootstrapConfirmed ||
      previousStatus.runtimeAlive !== nextStatus.runtimeAlive ||
      previousStatus.hardFailure !== nextStatus.hardFailure ||
      previousStatus.livenessKind !== nextStatus.livenessKind;
    const laneChanged =
      previousLaneState !== lane.state ||
      previousLaneRunId !== lane.runId ||
      previousLaneMember?.sessionId !== evidence.sessionId ||
      previousLaneMember?.launchState !== evidence.launchState ||
      previousLaneMember?.bootstrapConfirmed !== evidence.bootstrapConfirmed;

    return { run, changed: statusChanged || laneChanged };
  }

  private shouldEmitOpenCodeRuntimeLivenessMemberSpawnChange(input: {
    previousMember?: PersistedTeamLaunchMemberState;
    runtimeRunId: string;
    runtimeSessionId: string;
    runtimePid?: number;
  }): boolean {
    return shouldEmitOpenCodeRuntimeLivenessMemberSpawnChangeHelper(input);
  }

  private resolvePersistedRuntimeMemberIdentity(params: {
    teamName: string;
    memberName: string;
    previousMember?: PersistedTeamLaunchMemberState;
  }): Partial<PersistedTeamLaunchMemberState> {
    const trackedRunId = this.getTrackedRunId(params.teamName);
    const trackedRun = trackedRunId ? this.runs.get(trackedRunId) : null;
    return resolvePersistedRuntimeMemberIdentityHelper({
      memberName: params.memberName,
      previousMember: params.previousMember,
      trackedRun,
    });
  }

  private createOpenCodeRuntimeDeliveryService(
    teamName: string,
    laneId: string
  ): RuntimeDeliveryService {
    const journal = createRuntimeDeliveryJournalStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId,
        fileName: 'opencode-delivery-journal.json',
      }),
    });
    return new RuntimeDeliveryService(
      {
        getCurrentRunId: async (candidateTeamName) =>
          this.resolveCurrentOpenCodeRuntimeRunId(candidateTeamName, laneId),
      },
      journal,
      new RuntimeDeliveryDestinationRegistry(this.createOpenCodeRuntimeDeliveryPorts()),
      {
        append: async (event) => {
          logger.warn(`[${event.teamName}] ${event.message}`);
        },
      },
      {
        emit: (event) => {
          this.teamChangeEmitter?.({
            type: event.type as TeamChangeEvent['type'],
            teamName: event.teamName,
            detail: typeof event.data?.detail === 'string' ? event.data.detail : undefined,
          });
        },
      }
    );
  }

  private createOpenCodePromptDeliveryLedger(teamName: string, laneId: string) {
    return createOpenCodePromptDeliveryLedgerStore({
      filePath: getOpenCodeLaneScopedRuntimeFilePath({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId,
        fileName: 'opencode-prompt-delivery-ledger.json',
      }),
    });
  }

  async getOpenCodeRuntimeDeliveryStatus(
    teamName: string,
    messageId: string
  ): Promise<OpenCodeRuntimeDeliveryStatus | null> {
    const normalizedMessageId = messageId.trim();
    if (!normalizedMessageId) {
      return null;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => null
    );
    const laneIds = [
      ...new Set(
        Object.values(laneIndex?.lanes ?? {})
          .map((entry) => entry.laneId.trim())
          .filter(Boolean)
      ),
    ];
    for (const laneId of laneIds) {
      const records = await this.createOpenCodePromptDeliveryLedger(teamName, laneId)
        .list()
        .catch(() => []);
      const record = records.find((candidate) => candidate.inboxMessageId === normalizedMessageId);
      if (record) {
        const { record: latestRecord, decision } =
          await this.decideOpenCodeRuntimeDeliveryUserFacingAdvisory(record);
        return toOpenCodeRuntimeDeliveryStatus({ record: latestRecord, decision });
      }
    }
    return null;
  }

  private async tryGetActiveOpenCodePromptDeliveryRecord(input: {
    teamName: string;
    memberName: string;
  }): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
    const identity = await this.resolveOpenCodeMemberDeliveryIdentity(
      input.teamName,
      input.memberName
    ).catch(() => null);
    if (!identity?.ok) {
      return null;
    }
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), input.teamName).catch(
      () => null
    );
    if (laneIndex?.lanes[identity.laneId]?.state !== 'active') {
      const recovered = await this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      });
      if (!recovered) {
        return null;
      }
    }
    return await this.createOpenCodePromptDeliveryLedger(input.teamName, identity.laneId)
      .getActiveForMember({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      })
      .catch(() => null);
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
    if (!(await this.isOpenCodeRuntimeRecipient(input.teamName, input.memberName))) {
      return { busy: false };
    }

    const nowMs = Date.parse(input.nowIso);
    const retryAfterIso = new Date(
      (Number.isFinite(nowMs) ? nowMs : Date.now()) + 60_000
    ).toISOString();

    let inboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>>;
    try {
      inboxMessages = await this.inboxReader.getMessagesFor(input.teamName, input.memberName);
    } catch {
      return {
        busy: true,
        reason: 'opencode_inbox_read_failed',
        retryAfterIso,
      };
    }

    const foregroundMessages = inboxMessages.filter(
      (message) => message.messageKind !== 'member_work_sync_nudge'
    );
    const agendaSyncRecoveryBypassMessageIds =
      await this.getOpenCodeAgendaSyncRecoveryBypassMessageIds({
        teamName: input.teamName,
        memberName: input.memberName,
        workSyncIntent: input.workSyncIntent,
        taskRefs: input.taskRefs,
        foregroundMessages,
      });
    const blockingForegroundMessages = foregroundMessages.filter((message) => {
      const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
      return (
        !agendaSyncRecoveryBypassMessageIds.has(messageId) &&
        !isCurrentReviewPickupRequestForegroundMessage(message, input) &&
        !isCurrentProofMissingRecoveryForegroundMessage(message, input)
      );
    });
    const unreadForeground = blockingForegroundMessages.find(
      (message) =>
        !message.read &&
        typeof message.text === 'string' &&
        message.text.trim().length > 0 &&
        hasStableInboxMessageId(message)
    );
    if (unreadForeground?.messageId) {
      const activeRecord = await this.tryGetActiveOpenCodePromptDeliveryRecord({
        teamName: input.teamName,
        memberName: input.memberName,
      });
      if (activeRecord) {
        return buildOpenCodePromptDeliveryActiveBusyStatus({
          teamName: input.teamName,
          memberName: input.memberName,
          retryAfterIso,
          nowMs: Number.isFinite(nowMs) ? nowMs : undefined,
          activeRecord,
          scheduleWake: (wakeInput) => this.scheduleOpenCodeMemberInboxDeliveryWake(wakeInput),
        });
      }
      this.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName: input.teamName,
        memberName: input.memberName,
        messageId: unreadForeground.messageId,
        delayMs: 500,
      });
      return {
        busy: true,
        reason: 'opencode_foreground_inbox_unread',
        retryAfterIso,
        activeMessageId: unreadForeground.messageId,
        activeMessageKind: unreadForeground.messageKind ?? null,
      };
    }

    const recentForeground = blockingForegroundMessages.find((message) => {
      const timestampMs = Date.parse(message.timestamp);
      return Number.isFinite(timestampMs) && Number.isFinite(nowMs) && nowMs - timestampMs < 60_000;
    });
    if (recentForeground?.messageId) {
      return {
        busy: true,
        reason: 'opencode_foreground_inbox_recent',
        retryAfterIso,
        activeMessageId: recentForeground.messageId,
        activeMessageKind: recentForeground.messageKind ?? null,
      };
    }

    const identity = await this.resolveOpenCodeMemberDeliveryIdentity(
      input.teamName,
      input.memberName
    );
    if (!identity.ok) {
      return { busy: true, reason: identity.reason, retryAfterIso };
    }

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), input.teamName).catch(
      () => null
    );
    if (!laneIndex) {
      return { busy: true, reason: 'opencode_lane_index_unavailable', retryAfterIso };
    }
    if (
      laneIndex.lanes[identity.laneId]?.state !== 'active' &&
      !(await this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      }).catch(() => false))
    ) {
      return { busy: true, reason: 'opencode_no_active_lane', retryAfterIso };
    }

    let activeRecord: OpenCodePromptDeliveryLedgerRecord | null;
    try {
      activeRecord = await this.createOpenCodePromptDeliveryLedger(
        input.teamName,
        identity.laneId
      ).getActiveForMember({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      });
    } catch {
      return {
        busy: true,
        reason: 'opencode_prompt_ledger_unavailable',
        retryAfterIso,
      };
    }
    if (activeRecord) {
      return buildOpenCodePromptDeliveryActiveBusyStatus({
        teamName: input.teamName,
        memberName: input.memberName,
        retryAfterIso,
        nowMs: Number.isFinite(nowMs) ? nowMs : undefined,
        activeRecord,
        scheduleWake: (wakeInput) => this.scheduleOpenCodeMemberInboxDeliveryWake(wakeInput),
      });
    }

    return { busy: false };
  }

  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }): void {
    const teamName = input.teamName.trim();
    const memberName = input.memberName.trim();
    const messageId = input.messageId.trim();
    if (
      !teamName ||
      !memberName ||
      !messageId ||
      !this.openCodePromptDeliveryWatchdogScheduler.isEnabled()
    ) {
      return;
    }
    this.scheduleOpenCodePromptDeliveryWatchdog({
      teamName,
      memberName,
      messageId,
      delayMs: Math.max(0, input.delayMs ?? 500),
    });
  }

  private createOpenCodeRuntimeDeliveryPorts() {
    return createOpenCodeRuntimeDeliveryPorts({
      sentMessagesStore: this.sentMessagesStore,
      inboxReader: this.inboxReader,
      inboxWriter: this.inboxWriter,
      getCrossTeamSender: () => this.crossTeamSender,
    });
  }

  async recoverOpenCodeRuntimeDeliveryJournal(teamName: string): Promise<{ recovered: true }> {
    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), teamName).catch(
      () => ({
        version: 1 as const,
        updatedAt: nowIso(),
        lanes: {},
      })
    );
    const recoveryLaneIds = await this.getOpenCodeRuntimeRecoveryLaneIds(teamName, laneIndex.lanes);
    for (const laneId of recoveryLaneIds) {
      const journal = createRuntimeDeliveryJournalStore({
        filePath: getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: getTeamsBasePath(),
          teamName,
          laneId,
          fileName: 'opencode-delivery-journal.json',
        }),
      });
      const reconciler = new RuntimeDeliveryReconciler(
        journal,
        new RuntimeDeliveryDestinationRegistry(this.createOpenCodeRuntimeDeliveryPorts()),
        {
          append: async (event) => {
            logger.warn(`[${event.teamName}] ${event.message}`);
          },
        }
      );
      await reconciler.reconcileTeam(teamName);
    }
    return { recovered: true };
  }

  private async getOpenCodeRuntimeRecoveryLaneIds(
    teamName: string,
    laneIndexEntries?: Record<string, { laneId: string }>
  ): Promise<string[]> {
    const laneIds = Object.keys(laneIndexEntries ?? {});
    if (laneIds.length > 0) {
      return laneIds;
    }

    const snapshot = await this.launchStateStore.read(teamName).catch(() => null);
    const snapshotLaneIds = Array.from(
      new Set(
        Object.values(snapshot?.members ?? {})
          .map((member) =>
            member?.laneOwnerProviderId === 'opencode' && typeof member.laneId === 'string'
              ? member.laneId.trim()
              : ''
          )
          .filter((laneId) => laneId.length > 0)
      )
    );
    return snapshotLaneIds.length > 0 ? snapshotLaneIds : ['primary'];
  }

  getLeadActivityState(teamName: string): {
    state: 'active' | 'idle' | 'offline';
    runId: string | null;
  } {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) return { state: 'offline', runId: null };
    const run = this.runs.get(runId);
    if (!run) {
      const runtimeAdapterRun = this.runtimeAdapterRunByTeam.get(teamName);
      const runtimeProgress = this.runtimeAdapterProgressByRunId.get(runId);
      if (
        runtimeAdapterRun?.runId === runId &&
        !['cancelled', 'disconnected', 'failed'].includes(runtimeProgress?.state ?? '')
      ) {
        return { state: 'idle', runId };
      }
      return { state: 'offline', runId: null };
    }
    if (run.processKilled || run.cancelRequested) return { state: 'offline', runId: null };
    // Read-repair active lead task intervals for runs that were already active
    // before interval tracking was introduced or before the renderer polled state.
    this.syncLeadTaskActivityForState(run, run.leadActivityState, run.leadActivityState);
    return { state: run.leadActivityState, runId };
  }

  getLeadContextUsage(teamName: string): { usage: LeadContextUsage | null; runId: string | null } {
    const runId = this.getTrackedRunId(teamName);
    if (!runId) return { usage: null, runId: null };
    const run = this.runs.get(runId);
    if (!run?.leadContextUsage || run.processKilled || run.cancelRequested) {
      return { usage: null, runId: null };
    }
    return {
      usage: this.buildLeadContextUsagePayload(run),
      runId,
    };
  }

  private getInitialLeadContextWindowTokens(run: ProvisioningRun): number | null {
    return getInitialLeadContextWindowTokensForRequest(run.request);
  }

  private buildLeadContextUsagePayload(run: ProvisioningRun): LeadContextUsage {
    return buildLeadContextUsagePayloadFromState(run.leadContextUsage, new Date().toISOString());
  }

  private updateLeadContextUsageFromUsage(
    run: ProvisioningRun,
    usage: Record<string, unknown>,
    modelName: string | undefined
  ): void {
    const existingContextWindowTokens =
      run.leadContextUsage?.contextWindowTokens ?? this.getInitialLeadContextWindowTokens(run);
    const metrics = deriveContextMetrics({
      usage,
      providerId: normalizeOptionalTeamProviderId(run.request.providerId),
      modelName,
      contextWindowTokens: existingContextWindowTokens,
      limitContext: run.request.limitContext === true,
    });

    if (!run.leadContextUsage) {
      run.leadContextUsage = {
        promptInputTokens: metrics.promptInputTokens,
        outputTokens: metrics.outputTokens,
        contextUsedTokens: metrics.contextUsedTokens,
        contextWindowTokens: metrics.contextWindowTokens,
        promptInputSource: metrics.promptInputSource,
        lastUsageMessageId: null,
        lastEmittedAt: 0,
      };
      return;
    }

    run.leadContextUsage.promptInputTokens = metrics.promptInputTokens;
    run.leadContextUsage.outputTokens = metrics.outputTokens;
    run.leadContextUsage.contextUsedTokens = metrics.contextUsedTokens;
    run.leadContextUsage.contextWindowTokens =
      metrics.contextWindowTokens ?? run.leadContextUsage.contextWindowTokens;
    run.leadContextUsage.promptInputSource = metrics.promptInputSource;
  }

  private isCurrentTrackedRun(run: ProvisioningRun): boolean {
    return this.getTrackedRunId(run.teamName) === run.runId;
  }

  private getRunTrackedCwd(run: ProvisioningRun | null | undefined): string | null {
    const requestCwd = typeof run?.request?.cwd === 'string' ? run.request.cwd.trim() : '';
    if (requestCwd) return path.resolve(requestCwd);

    const spawnCwd = typeof run?.spawnContext?.cwd === 'string' ? run.spawnContext.cwd.trim() : '';
    if (spawnCwd) return path.resolve(spawnCwd);

    return null;
  }

  private getPreCompleteCliErrorText(run: ProvisioningRun): string {
    const parts: string[] = [];
    const stderrText = run.stderrBuffer.trim();
    if (stderrText) {
      parts.push(stderrText);
    }

    // Re-check only the parser-owned stdout carry that never became a newline-delimited message.
    // If it is complete JSON or clearly looks like Claude stream-json structure, ignore it here.
    // Otherwise treat it as trailing plaintext CLI output that should still participate in the
    // final auth/API failure guard.
    const trailingStdout = run.stdoutParserCarry.trim();
    if (
      trailingStdout &&
      !run.stdoutParserCarryIsCompleteJson &&
      !run.stdoutParserCarryLooksLikeClaudeJson
    ) {
      parts.push(trailingStdout);
    }

    return parts.join('\n').trim();
  }

  private getLeadTaskActivityRunKey(run: ProvisioningRun): string {
    return `${run.teamName}\u0000${run.runId}`;
  }

  private syncLeadTaskActivityForState(
    run: ProvisioningRun,
    state: 'active' | 'idle' | 'offline',
    previousState: 'active' | 'idle' | 'offline',
    at = nowIso()
  ): void {
    const key = this.getLeadTaskActivityRunKey(run);
    if (state === 'active') {
      if (this.leadTaskActivitySyncedRunKeys.has(key)) return;
      const result = this.taskActivityIntervalService.resumeActiveIntervalsForMember(
        run.teamName,
        this.getRunLeadName(run),
        at
      );
      if (result.failed) return;
      this.leadTaskActivitySyncedRunKeys.add(key);
      return;
    }

    const wasSynced = this.leadTaskActivitySyncedRunKeys.has(key);
    if (previousState !== 'active' && !wasSynced) return;
    const result = this.taskActivityIntervalService.pauseActiveIntervalsForMember(
      run.teamName,
      this.getRunLeadName(run),
      at
    );
    if (result.failed) {
      this.leadTaskActivitySyncedRunKeys.add(key);
      return;
    }
    this.leadTaskActivitySyncedRunKeys.delete(key);
  }

  private setLeadActivity(run: ProvisioningRun, state: 'active' | 'idle' | 'offline'): void {
    const previousState = run.leadActivityState;
    const isCurrentRun = this.isCurrentTrackedRun(run);
    if (isCurrentRun) {
      this.syncLeadTaskActivityForState(run, state, previousState);
    } else {
      this.leadTaskActivitySyncedRunKeys.delete(this.getLeadTaskActivityRunKey(run));
    }
    if (previousState === state) return;
    run.leadActivityState = state;
    if (!isCurrentRun) return;
    this.teamChangeEmitter?.({
      type: 'lead-activity',
      teamName: run.teamName,
      runId: run.runId,
      detail: state,
    });
  }

  private emitToolActivity(run: ProvisioningRun, payload: ToolActivityEventPayload): void {
    if (!this.isCurrentTrackedRun(run)) return;
    this.teamChangeEmitter?.({
      type: 'tool-activity',
      teamName: run.teamName,
      runId: run.runId,
      detail: JSON.stringify(payload),
    });
  }

  private startRuntimeToolActivity(
    run: ProvisioningRun,
    memberName: string,
    block: Record<string, unknown>
  ): void {
    const rawId = typeof block.id === 'string' ? block.id.trim() : '';
    if (!rawId) return;

    const toolUseId = rawId;
    if (run.activeToolCalls.has(toolUseId)) return;

    const toolName = typeof block.name === 'string' ? block.name : 'unknown';
    const input = (block.input ?? {}) as Record<string, unknown>;
    const activity: ActiveToolCall = {
      memberName,
      toolUseId,
      toolName,
      preview: extractToolPreview(toolName, input),
      startedAt: nowIso(),
      state: 'running',
      source: 'runtime',
    };

    run.activeToolCalls.set(toolUseId, activity);
    this.emitToolActivity(run, {
      action: 'start',
      activity: {
        memberName: activity.memberName,
        toolUseId: activity.toolUseId,
        toolName: activity.toolName,
        preview: activity.preview,
        startedAt: activity.startedAt,
        source: activity.source,
      },
    });
  }

  private finishRuntimeToolActivity(
    run: ProvisioningRun,
    toolUseId: string,
    resultContent: unknown,
    isError: boolean
  ): void {
    const active = run.activeToolCalls.get(toolUseId);
    if (!active) return;

    run.activeToolCalls.delete(toolUseId);
    this.emitToolActivity(run, {
      action: 'finish',
      memberName: active.memberName,
      toolUseId,
      finishedAt: nowIso(),
      resultPreview: extractToolResultPreview(resultContent),
      isError,
    });

    const spawnedMemberName = run.memberSpawnToolUseIds.get(toolUseId);
    if (spawnedMemberName) {
      run.memberSpawnToolUseIds.delete(toolUseId);
      const pendingRestart = run.pendingMemberRestarts.get(spawnedMemberName);
      if (isError) {
        const resultPreview = extractToolResultPreview(resultContent);
        this.handleMemberSpawnFailure(run, spawnedMemberName, resultPreview);
      } else if (active.toolName === 'Agent') {
        const parsedStatus = parseAgentToolResultStatus(resultContent);
        if (parsedStatus?.status === 'duplicate_skipped') {
          const detail =
            parsedStatus.reason === 'already_running'
              ? 'duplicate spawn skipped - already running'
              : parsedStatus.reason === 'bootstrap_pending'
                ? 'duplicate spawn skipped - teammate bootstrap still pending'
                : parsedStatus.rawReason
                  ? `duplicate spawn skipped - unrecognized reason: ${parsedStatus.rawReason}`
                  : 'duplicate spawn skipped - reason unavailable';
          this.appendMemberBootstrapDiagnostic(run, spawnedMemberName, detail);
          if (pendingRestart && !parsedStatus.reason) {
            logger.warn(
              `[${run.teamName}] Restart for teammate "${spawnedMemberName}" returned duplicate_skipped without a recognized reason`
            );
            run.pendingMemberRestarts.delete(spawnedMemberName);
            this.setMemberSpawnStatus(
              run,
              spawnedMemberName,
              'error',
              buildRestartDuplicateUnconfirmedReason(spawnedMemberName, parsedStatus.rawReason)
            );
            return;
          }
          if (parsedStatus.reason === 'already_running') {
            if (pendingRestart) {
              run.pendingMemberRestarts.delete(spawnedMemberName);
              this.setMemberSpawnStatus(
                run,
                spawnedMemberName,
                'error',
                buildRestartStillRunningReason(spawnedMemberName)
              );
              return;
            }
            this.invalidateRuntimeSnapshotCaches(run.teamName);
            this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
            this.appendMemberBootstrapDiagnostic(
              run,
              spawnedMemberName,
              'already_running requires strong runtime verification'
            );
            void this.reevaluateMemberLaunchStatus(run, spawnedMemberName);
          } else {
            this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
          }
          return;
        }

        // Agent tool_result only confirms that the runtime accepted the spawn.
        // The teammate becomes truly "online" only after the first inbox heartbeat.
        this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
      } else {
        this.setMemberSpawnStatus(run, spawnedMemberName, 'waiting');
      }
    }
  }

  private handleMemberSpawnFailure(
    run: ProvisioningRun,
    memberName: string,
    resultPreview?: string
  ): void {
    const pendingRestart = run.pendingMemberRestarts.get(memberName);
    const reason =
      (typeof resultPreview === 'string' && resultPreview.trim().length > 0
        ? resultPreview.trim()
        : 'Teammate spawn failed immediately after launch.') || 'Teammate spawn failed.';
    const message = pendingRestart
      ? `Failed to restart teammate "${memberName}": ${reason}`
      : `Teammate "${memberName}" failed to start: ${reason}`;

    run.pendingMemberRestarts.delete(memberName);

    this.setMemberSpawnStatus(run, memberName, 'error', message);

    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex < 0 || run.provisioningOutputParts[lastIndex]?.trim() !== message) {
      run.provisioningOutputParts.push(message);
      boundRunProvisioningOutputParts(run);
    }

    if (
      !run.provisioningComplete &&
      (run.progress.state === 'assembling' || run.progress.state === 'configuring')
    ) {
      const progress = updateProgress(run, 'assembling', `Failed to start member ${memberName}`);
      run.onProgress(progress);
    }
  }

  private appendMemberBootstrapDiagnostic(
    run: ProvisioningRun,
    memberName: string,
    text: string
  ): void {
    const line = normalizeMemberDiagnosticText(memberName, text);
    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === line) {
      return;
    }
    run.provisioningOutputParts.push(line);
    boundRunProvisioningOutputParts(run);
    logger.info(`[${run.teamName}] [bootstrap] ${line}`);
  }

  private resetRuntimeToolActivity(run: ProvisioningRun, memberName?: string): void {
    resetRuntimeToolActivityHelper(run, memberName, {
      emitToolActivity: (payload) => this.emitToolActivity(run, payload),
    });
  }

  private clearMemberSpawnToolTracking(run: ProvisioningRun, memberName: string): void {
    clearMemberSpawnToolTrackingHelper(run, memberName, {
      appendMemberBootstrapDiagnostic: (targetMemberName, text) =>
        this.appendMemberBootstrapDiagnostic(run, targetMemberName, text),
    });
  }

  private pauseMemberTaskActivityForRuntimeLoss(
    run: ProvisioningRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    if (previous.runtimeAlive !== true) return;
    this.taskActivityIntervalService.pauseActiveIntervalsForMember(
      run.teamName,
      memberName,
      deriveTaskActivityPauseAt(previous, observedAt)
    );
  }

  private syncMemberTaskActivityForRuntimeTransition(
    run: ProvisioningRun,
    memberName: string,
    previous: MemberSpawnStatusEntry,
    next: MemberSpawnStatusEntry,
    observedAt: string
  ): void {
    if (previous.runtimeAlive === true && next.runtimeAlive !== true) {
      this.pauseMemberTaskActivityForRuntimeLoss(run, memberName, previous, observedAt);
    } else if (previous.runtimeAlive !== true && next.runtimeAlive === true) {
      const nextUpdatedMs = parseOptionalIsoMs(next.updatedAt);
      const previousUpdatedMs = parseOptionalIsoMs(previous.updatedAt);
      const resumeFallbackAt =
        nextUpdatedMs > 0 && (previousUpdatedMs <= 0 || nextUpdatedMs > previousUpdatedMs)
          ? next.updatedAt
          : nowIso();
      this.taskActivityIntervalService.resumeActiveIntervalsForMember(
        run.teamName,
        memberName,
        deriveTaskActivityResumeAt(previous, observedAt, resumeFallbackAt)
      );
    }
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
    const prev = run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
    if (
      status === 'waiting' &&
      !prev.hardFailure &&
      (prev.bootstrapConfirmed || prev.runtimeAlive)
    ) {
      this.setMemberSpawnStatus(
        run,
        memberName,
        'online',
        undefined,
        prev.livenessSource,
        prev.lastHeartbeatAt
      );
      return;
    }
    const updatedAt = nowIso();
    const next: MemberSpawnStatusEntry = {
      ...prev,
      status,
      updatedAt,
    };

    if (status === 'spawning') {
      const pendingRestart = run.pendingMemberRestarts?.get(memberName);
      next.skippedForLaunch = false;
      next.skipReason = undefined;
      next.skippedAt = undefined;
      next.agentToolAccepted = false;
      next.runtimeAlive = false;
      next.bootstrapConfirmed = false;
      next.hardFailure = false;
      next.bootstrapStalled = undefined;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.livenessSource = undefined;
      next.livenessKind = undefined;
      next.runtimeDiagnostic = undefined;
      next.runtimeDiagnosticSeverity = undefined;
      next.livenessLastCheckedAt = undefined;
      next.firstSpawnAcceptedAt = pendingRestart?.requestedAt;
      next.lastHeartbeatAt = undefined;
      if (pendingRestart) {
        next.runtimeDiagnostic =
          'Manual restart is already in progress; waiting for teammate bootstrap.';
        next.runtimeDiagnosticSeverity = 'info';
      }
      next.launchState = 'starting';
    } else if (status === 'waiting') {
      next.skippedForLaunch = false;
      next.skipReason = undefined;
      next.skippedAt = undefined;
      next.agentToolAccepted = true;
      next.runtimeAlive = false;
      next.bootstrapConfirmed = false;
      next.hardFailure = false;
      next.bootstrapStalled = undefined;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.livenessSource = undefined;
      next.livenessKind = undefined;
      next.runtimeDiagnostic = undefined;
      next.runtimeDiagnosticSeverity = undefined;
      next.livenessLastCheckedAt = undefined;
      next.firstSpawnAcceptedAt = prev.firstSpawnAcceptedAt ?? updatedAt;
      next.lastHeartbeatAt = undefined;
      next.launchState = 'runtime_pending_bootstrap';
    } else if (status === 'online') {
      next.skippedForLaunch = false;
      next.skipReason = undefined;
      next.skippedAt = undefined;
      next.agentToolAccepted = true;
      next.runtimeAlive = true;
      next.livenessSource = livenessSource;
      next.firstSpawnAcceptedAt = prev.firstSpawnAcceptedAt ?? updatedAt;
      if (livenessSource === 'heartbeat') {
        const incomingHeartbeatAt = heartbeatAt?.trim() || updatedAt;
        next.bootstrapConfirmed = true;
        next.lastHeartbeatAt = isMemberSpawnHeartbeatTimestampNewer(
          prev.lastHeartbeatAt,
          incomingHeartbeatAt
        )
          ? incomingHeartbeatAt
          : prev.lastHeartbeatAt;
      }
      next.hardFailure = false;
      next.bootstrapStalled = undefined;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.launchState = deriveMemberLaunchState(next);
    } else if (status === 'error') {
      next.skippedForLaunch = false;
      next.skipReason = undefined;
      next.skippedAt = undefined;
      next.error = error;
      next.hardFailure = true;
      next.bootstrapStalled = undefined;
      next.hardFailureReason = error;
      next.launchState = 'failed_to_start';
    } else if (status === 'skipped') {
      next.skippedForLaunch = true;
      next.skipReason =
        error?.trim() || prev.hardFailureReason || prev.error || 'Skipped for this launch';
      next.skippedAt = updatedAt;
      next.agentToolAccepted = false;
      next.runtimeAlive = false;
      next.bootstrapConfirmed = false;
      next.hardFailure = false;
      next.bootstrapStalled = undefined;
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.livenessSource = undefined;
      next.livenessKind = undefined;
      next.runtimeDiagnostic = undefined;
      next.runtimeDiagnosticSeverity = undefined;
      next.livenessLastCheckedAt = undefined;
      next.firstSpawnAcceptedAt = undefined;
      next.lastHeartbeatAt = undefined;
      next.launchState = 'skipped_for_launch';
    } else if (status === 'offline') {
      Object.assign(next, createInitialMemberSpawnStatusEntry(), { updatedAt });
      next.error = undefined;
      next.hardFailureReason = undefined;
      next.skippedForLaunch = false;
      next.skipReason = undefined;
      next.skippedAt = undefined;
      next.livenessSource = undefined;
      next.livenessKind = undefined;
      next.runtimeDiagnostic = undefined;
      next.runtimeDiagnosticSeverity = undefined;
      next.livenessLastCheckedAt = undefined;
      next.firstSpawnAcceptedAt = undefined;
      next.lastHeartbeatAt = undefined;
    }

    next.launchState = deriveMemberLaunchState(next);
    if (
      prev.status === next.status &&
      prev.launchState === next.launchState &&
      prev.error === next.error &&
      prev.hardFailureReason === next.hardFailureReason &&
      (prev.skippedForLaunch === true) === (next.skippedForLaunch === true) &&
      prev.skipReason === next.skipReason &&
      prev.skippedAt === next.skippedAt &&
      prev.livenessSource === next.livenessSource &&
      prev.agentToolAccepted === next.agentToolAccepted &&
      prev.runtimeAlive === next.runtimeAlive &&
      prev.bootstrapConfirmed === next.bootstrapConfirmed &&
      prev.hardFailure === next.hardFailure &&
      prev.livenessKind === next.livenessKind &&
      prev.runtimeDiagnostic === next.runtimeDiagnostic &&
      prev.runtimeDiagnosticSeverity === next.runtimeDiagnosticSeverity &&
      prev.bootstrapStalled === next.bootstrapStalled &&
      prev.firstSpawnAcceptedAt === next.firstSpawnAcceptedAt &&
      prev.lastHeartbeatAt === next.lastHeartbeatAt
    ) {
      return;
    }

    const runtimeTransitionAt =
      status === 'online' && livenessSource === 'heartbeat'
        ? (normalizeIsoTimestamp(heartbeatAt) ?? updatedAt)
        : updatedAt;
    this.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      prev,
      next,
      runtimeTransitionAt
    );
    run.memberSpawnStatuses.set(memberName, next);
    if (
      (status === 'online' && (next.bootstrapConfirmed || livenessSource === 'process')) ||
      status === 'offline' ||
      status === 'error' ||
      status === 'skipped'
    ) {
      run.pendingMemberRestarts?.delete(memberName);
    }
    this.syncMemberLaunchGraceCheck(run, memberName, next);
    const launchDiagnostics = boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run));
    if (launchDiagnostics) {
      run.progress = {
        ...run.progress,
        updatedAt: nowIso(),
        launchDiagnostics,
      };
      run.onProgress(run.progress);
    }

    if (status === 'spawning') {
      this.appendMemberBootstrapDiagnostic(run, memberName, 'Agent tool invoked');
    } else if (status === 'waiting') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'spawn accepted, waiting for teammate check-in'
      );
    } else if (status === 'online' && livenessSource === 'heartbeat' && !prev.bootstrapConfirmed) {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'bootstrap confirmed via first heartbeat'
      );
    } else if (status === 'online' && livenessSource === 'process') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'runtime process is alive, teammate check-in not yet received'
      );
    } else if (status === 'error') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        error?.trim().length ? error.trim() : 'bootstrap failed'
      );
    } else if (status === 'skipped') {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        error?.trim().length
          ? `skipped for this launch: ${error.trim()}`
          : 'skipped for this launch'
      );
    }
    if (!this.isCurrentTrackedRun(run)) return;
    this.emitMemberSpawnChange(run, memberName);
    if (run.isLaunch) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  private confirmMemberSpawnStatusFromTranscript(
    run: ProvisioningRun,
    memberName: string,
    observedAt: string,
    source: 'transcript' | 'runtime-proof' = 'transcript'
  ): void {
    const prev = run.memberSpawnStatuses.get(memberName) ?? createInitialMemberSpawnStatusEntry();
    const updatedAt = nowIso();
    const next: MemberSpawnStatusEntry = {
      ...prev,
      status: 'online',
      updatedAt,
      agentToolAccepted: true,
      runtimeAlive: source === 'runtime-proof' ? true : prev.runtimeAlive,
      bootstrapConfirmed: true,
      hardFailure: false,
      bootstrapStalled: undefined,
      error: undefined,
      hardFailureReason: undefined,
      livenessSource:
        source === 'runtime-proof' ? (prev.livenessSource ?? 'process') : prev.livenessSource,
      firstSpawnAcceptedAt: prev.firstSpawnAcceptedAt ?? observedAt,
      lastHeartbeatAt: isMemberSpawnHeartbeatTimestampNewer(prev.lastHeartbeatAt, observedAt)
        ? observedAt
        : prev.lastHeartbeatAt,
    };
    next.launchState = deriveMemberLaunchState(next);

    if (
      prev.status === next.status &&
      prev.launchState === next.launchState &&
      prev.error === next.error &&
      prev.hardFailureReason === next.hardFailureReason &&
      prev.livenessSource === next.livenessSource &&
      prev.agentToolAccepted === next.agentToolAccepted &&
      prev.runtimeAlive === next.runtimeAlive &&
      prev.bootstrapConfirmed === next.bootstrapConfirmed &&
      prev.hardFailure === next.hardFailure &&
      prev.bootstrapStalled === next.bootstrapStalled &&
      prev.firstSpawnAcceptedAt === next.firstSpawnAcceptedAt &&
      prev.lastHeartbeatAt === next.lastHeartbeatAt
    ) {
      return;
    }

    const runtimeTransitionAt = source === 'runtime-proof' ? observedAt : updatedAt;
    this.syncMemberTaskActivityForRuntimeTransition(
      run,
      memberName,
      prev,
      next,
      runtimeTransitionAt
    );
    run.memberSpawnStatuses.set(memberName, next);
    run.pendingMemberRestarts?.delete(memberName);
    this.syncMemberLaunchGraceCheck(run, memberName, next);
    this.appendMemberBootstrapDiagnostic(
      run,
      memberName,
      source === 'runtime-proof'
        ? 'bootstrap confirmed via runtime proof'
        : 'bootstrap confirmed via transcript'
    );
    if (!this.isCurrentTrackedRun(run)) return;
    this.emitMemberSpawnChange(run, memberName);
    if (run.isLaunch) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
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
    const readPersistedStatuses = async (resolvedRunId: string | null) => {
      const generationAtStart = this.getMemberSpawnStatusesCacheGeneration(teamName);
      const cached = this.memberSpawnStatusesSnapshotCache.get(teamName);
      if (
        cached &&
        cached.expiresAtMs > Date.now() &&
        cached.runId === resolvedRunId &&
        cached.generation === generationAtStart
      ) {
        return this.cloneMemberSpawnStatusesSnapshot(cached.snapshot);
      }

      const repairSnapshot = await this.readTaskActivityRepairLaunchSnapshot(teamName);
      this.repairStaleTaskActivityIntervalsOnce(teamName, repairSnapshot);
      const { snapshot, statuses } = await this.reconcilePersistedLaunchState(teamName);
      const nextStatuses = await this.attachLiveRuntimeMetadataToStatuses(teamName, statuses, {
        openCodeSecondaryBootstrapPendingMembers:
          this.getOpenCodeSecondaryBootstrapPendingMemberNames(snapshot),
      });
      const runtimeObservedAt = nowIso();
      const aliveMemberNames = Object.entries(nextStatuses)
        .filter(([, entry]) => entry.runtimeAlive === true)
        .map(([memberName]) => memberName);
      if (aliveMemberNames.length > 0) {
        // Resume all alive members in a single locked task-file pass per cycle
        // instead of one synchronous lock + full task read per member.
        this.taskActivityIntervalService.resumeActiveIntervalsForMembers(
          teamName,
          aliveMemberNames,
          runtimeObservedAt
        );
      }
      const expectedMembers = snapshot ? this.getPersistedLaunchMemberNames(snapshot) : undefined;
      const summary = expectedMembers
        ? summarizeMemberSpawnStatusRecord(expectedMembers, nextStatuses)
        : undefined;
      const persistedSnapshot = {
        statuses: nextStatuses,
        runId: resolvedRunId,
        teamLaunchState: summary
          ? deriveTeamLaunchAggregateState(summary)
          : snapshot?.teamLaunchState,
        launchPhase: snapshot?.launchPhase,
        expectedMembers,
        updatedAt: snapshot?.updatedAt,
        summary: summary ?? snapshot?.summary,
        source: 'persisted' as const,
      };
      if (
        this.getMemberSpawnStatusesCacheGeneration(teamName) === generationAtStart &&
        this.getTrackedRunId(teamName) === resolvedRunId
      ) {
        this.memberSpawnStatusesSnapshotCache.set(teamName, {
          expiresAtMs:
            Date.now() +
            TeamProvisioningService.PERSISTED_MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
          generation: generationAtStart,
          runId: resolvedRunId,
          snapshot: this.cloneMemberSpawnStatusesSnapshot(persistedSnapshot),
        });
      }
      return persistedSnapshot;
    };

    const runId = this.getTrackedRunId(teamName);
    if (!runId) {
      return readPersistedStatuses(null);
    }
    const run = this.runs.get(runId);
    if (!run) {
      return readPersistedStatuses(runId);
    }

    if (!this.shouldCacheMemberSpawnStatusesSnapshot(run)) {
      return this.buildMemberSpawnStatusesSnapshotForRun(run);
    }

    const generationAtStart = this.getMemberSpawnStatusesCacheGeneration(teamName);
    const cached = this.memberSpawnStatusesSnapshotCache.get(teamName);
    if (
      cached &&
      cached.expiresAtMs > Date.now() &&
      cached.runId === run.runId &&
      cached.generation === generationAtStart
    ) {
      return this.cloneMemberSpawnStatusesSnapshot(cached.snapshot);
    }

    const existingRequest = this.memberSpawnStatusesInFlightByTeam.get(teamName);
    if (
      existingRequest?.generationAtStart === generationAtStart &&
      existingRequest.runIdAtStart === run.runId
    ) {
      const snapshot = await existingRequest.promise;
      if (
        this.getMemberSpawnStatusesCacheGeneration(teamName) === generationAtStart &&
        this.getTrackedRunId(teamName) === run.runId
      ) {
        return this.cloneMemberSpawnStatusesSnapshot(snapshot);
      }
      return this.getMemberSpawnStatuses(teamName);
    }

    const request = this.buildMemberSpawnStatusesSnapshotForRun(run, generationAtStart).finally(
      () => {
        if (this.memberSpawnStatusesInFlightByTeam.get(teamName)?.promise === request) {
          this.memberSpawnStatusesInFlightByTeam.delete(teamName);
        }
      }
    );
    this.memberSpawnStatusesInFlightByTeam.set(teamName, {
      generationAtStart,
      runIdAtStart: run.runId,
      promise: request,
    });
    const snapshot = await request;
    if (
      this.getMemberSpawnStatusesCacheGeneration(teamName) === generationAtStart &&
      this.getTrackedRunId(teamName) === run.runId
    ) {
      return this.cloneMemberSpawnStatusesSnapshot(snapshot);
    }
    return this.getMemberSpawnStatuses(teamName);
  }

  private shouldCacheMemberSpawnStatusesSnapshot(run: ProvisioningRun): boolean {
    return run.isLaunch === true && run.provisioningComplete !== true;
  }

  private async buildMemberSpawnStatusesSnapshotForRun(
    run: ProvisioningRun,
    generationAtStart?: number
  ): Promise<MemberSpawnStatusesSnapshot> {
    const teamName = run.teamName;
    await this.refreshMemberSpawnStatusesFromLeadInbox(run);
    await this.maybeAuditMemberSpawnStatuses(run);
    await this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');

    const persisted = await this.launchStateStore.read(teamName);
    if (persisted) {
      this.syncRunMemberSpawnStatusesFromSnapshot(run, persisted);
    }
    const liveSnapshot =
      this.buildLiveLaunchSnapshotForRun(run, run.provisioningComplete ? 'finished' : 'active') ??
      snapshotFromRuntimeMemberStatuses({
        teamName: run.teamName,
        expectedMembers: run.expectedMembers,
        leadSessionId: run.detectedSessionId ?? undefined,
        launchPhase: run.provisioningComplete ? 'finished' : 'active',
        statuses: this.buildRuntimeSpawnStatusRecord(run),
      });
    const rawSnapshot = liveSnapshot ?? persisted;
    const metaMembers = await this.membersMetaStore.getMembers(teamName).catch(() => []);
    const launchSnapshot = this.filterRemovedMembersFromLaunchSnapshot(rawSnapshot, metaMembers);
    const statuses = await this.attachLiveRuntimeMetadataToStatuses(
      teamName,
      snapshotToMemberSpawnStatuses(launchSnapshot),
      {
        openCodeSecondaryBootstrapPendingMembers:
          this.getOpenCodeSecondaryBootstrapPendingMemberNames(launchSnapshot),
      }
    );
    const expectedMembers = this.getPersistedLaunchMemberNames(launchSnapshot);
    const summary = summarizeMemberSpawnStatusRecord(expectedMembers, statuses);
    const spawnSnapshot: MemberSpawnStatusesSnapshot = {
      statuses,
      runId: run.runId,
      teamLaunchState: deriveTeamLaunchAggregateState(summary),
      launchPhase: launchSnapshot.launchPhase,
      expectedMembers,
      updatedAt: launchSnapshot.updatedAt,
      summary,
      source: persisted ? 'merged' : 'live',
    };
    if (
      generationAtStart != null &&
      this.shouldCacheMemberSpawnStatusesSnapshot(run) &&
      this.getMemberSpawnStatusesCacheGeneration(teamName) === generationAtStart &&
      this.getTrackedRunId(teamName) === run.runId
    ) {
      this.memberSpawnStatusesSnapshotCache.set(teamName, {
        expiresAtMs: Date.now() + TeamProvisioningService.MEMBER_SPAWN_STATUS_SNAPSHOT_CACHE_TTL_MS,
        generation: generationAtStart,
        runId: run.runId,
        snapshot: this.cloneMemberSpawnStatusesSnapshot(spawnSnapshot),
      });
    }
    return spawnSnapshot;
  }

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    const runId = this.getTrackedRunId(teamName);
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
      readRuntimeProcessRowsForUsageSnapshot: (targetTeamName, options) =>
        this.readRuntimeProcessRowsForUsageSnapshot(targetTeamName, options),
      readProcessUsageStatsByPid: (pids, cacheOptions) =>
        this.readProcessUsageStatsByPid(pids, cacheOptions),
      buildRuntimeUsageProcessTrees: (input) =>
        this.buildRuntimeUsageProcessTrees(
          input.rootPids,
          input.processRows,
          input.rootOwnersByPid
        ),
      buildRuntimeProcessLoadStats: (input) => this.buildRuntimeProcessLoadStats(input),
      agentRuntimeResourceHistory: {
        record: (input) => this.recordAgentRuntimeResourceSample(input),
        prune: (targetTeamName, activeKeys) =>
          this.pruneAgentRuntimeResourceHistory(targetTeamName, activeKeys),
      },
      agentRuntimeSnapshotCache: this.agentRuntimeSnapshotCache,
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      maxRuntimeTreePidsPerRoot: TeamProvisioningService.MAX_RUNTIME_TREE_PIDS_PER_ROOT,
      maxRuntimeUsagePidsPerSnapshot: TeamProvisioningService.MAX_RUNTIME_USAGE_PIDS_PER_SNAPSHOT,
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
        const stalledDiagnostic = bootstrapStalled
          ? await this.buildOpenCodeSecondaryBootstrapStallDiagnostic(run, memberName, refreshed)
          : null;
        const runtimeProcessStallDiagnostic =
          stalledDiagnostic ===
          'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.'
            ? 'Runtime process is alive, but no bootstrap check-in after 5 min.'
            : stalledDiagnostic;
        this.setOpenCodeRuntimePendingBootstrapStatus(run, memberName, refreshed, {
          bootstrapStalled,
          runtimeDiagnostic: bootstrapStalled
            ? (runtimeProcessStallDiagnostic ??
              'Runtime process is alive, but no bootstrap check-in after 5 min.')
            : (runtimeDiagnostic ??
              'OpenCode runtime process is alive, waiting for bootstrap check-in.'),
          runtimeDiagnosticSeverity: bootstrapStalled
            ? 'warning'
            : (metadata.runtimeDiagnosticSeverity ?? 'info'),
        });
        if (bootstrapStalled) {
          await this.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
            run,
            memberName,
            current: refreshed,
            runtimeDiagnostic:
              runtimeProcessStallDiagnostic ??
              'Runtime process is alive, but no bootstrap check-in after 5 min.',
            runtimeSessionId: metadata.runtimeSessionId,
          });
        }
        if (elapsedMs < MEMBER_BOOTSTRAP_STALL_MS) {
          this.scheduleOpenCodeBootstrapStallReevaluation(
            run,
            memberName,
            refreshedFirstSpawnAcceptedAt
          );
        }
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
      const stallDelayMs = Math.max(
        1_000,
        Date.parse(refreshedFirstSpawnAcceptedAt) + MEMBER_BOOTSTRAP_STALL_MS - Date.now()
      );
      const stallKey = `${this.getMemberLaunchGraceKey(run, memberName)}:bootstrap-stall`;
      if (!this.pendingTimeouts.has(stallKey)) {
        const timer = setTimeout(() => {
          this.pendingTimeouts.delete(stallKey);
          void this.reevaluateMemberLaunchStatus(run, memberName);
        }, stallDelayMs);
        timer.unref?.();
        this.pendingTimeouts.set(stallKey, timer);
      }
      return;
    }
    if (
      this.isOpenCodeSecondaryLaneMemberInRun(run, memberName) &&
      refreshed.launchState === 'runtime_pending_bootstrap' &&
      refreshed.bootstrapConfirmed !== true &&
      refreshed.hardFailure !== true &&
      elapsedMs >= MEMBER_BOOTSTRAP_STALL_MS
    ) {
      const enriched = {
        ...refreshed,
        ...(metadata?.livenessKind ? { livenessKind: metadata.livenessKind } : {}),
        ...(runtimeDiagnostic ? { runtimeDiagnostic } : {}),
        ...(metadata?.runtimeDiagnosticSeverity
          ? { runtimeDiagnosticSeverity: metadata.runtimeDiagnosticSeverity }
          : {}),
      };
      const diagnostic = await this.buildOpenCodeSecondaryBootstrapStallDiagnostic(
        run,
        memberName,
        enriched
      );
      this.setOpenCodeSecondaryBootstrapStalledStatus(run, memberName, enriched, diagnostic);
      await this.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
        run,
        memberName,
        current: enriched,
        runtimeDiagnostic: diagnostic,
        runtimeSessionId: metadata?.runtimeSessionId,
      });
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

  private setOpenCodeRuntimePendingBootstrapStatus(
    run: ProvisioningRun,
    memberName: string,
    current: MemberSpawnStatusEntry,
    options: {
      bootstrapStalled: boolean;
      runtimeDiagnostic: string;
      runtimeDiagnosticSeverity: TeamAgentRuntimeDiagnosticSeverity;
    }
  ): void {
    const observedAt = nowIso();
    const wasBootstrapStalled = current.bootstrapStalled === true;
    const next: MemberSpawnStatusEntry = {
      ...current,
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: true,
      bootstrapConfirmed: false,
      hardFailure: false,
      error: undefined,
      hardFailureReason: undefined,
      livenessSource: undefined,
      livenessKind: 'runtime_process',
      runtimeDiagnostic: options.runtimeDiagnostic,
      runtimeDiagnosticSeverity: options.runtimeDiagnosticSeverity,
      bootstrapStalled: options.bootstrapStalled ? true : undefined,
      livenessLastCheckedAt: observedAt,
      firstSpawnAcceptedAt: current.firstSpawnAcceptedAt ?? observedAt,
      updatedAt: observedAt,
    };

    this.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, observedAt);
    run.memberSpawnStatuses.set(memberName, next);
    const launchDiagnostics = boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run));
    if (launchDiagnostics) {
      run.progress = {
        ...run.progress,
        updatedAt: observedAt,
        launchDiagnostics,
      };
      run.onProgress(run.progress);
    }

    if (options.bootstrapStalled && !wasBootstrapStalled) {
      this.appendMemberBootstrapDiagnostic(run, memberName, 'opencode_bootstrap_stalled');
    } else if (
      !options.bootstrapStalled &&
      (current.status !== 'waiting' || current.livenessKind !== 'runtime_process')
    ) {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        'runtime process is alive, teammate check-in not yet received'
      );
    }
    if (!this.isCurrentTrackedRun(run)) return;
    this.emitMemberSpawnChange(run, memberName);
    if (run.isLaunch) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  private async buildOpenCodeSecondaryBootstrapStallDiagnostic(
    run: ProvisioningRun,
    memberName: string,
    current: MemberSpawnStatusEntry
  ): Promise<string> {
    const lane = (run.mixedSecondaryLanes ?? []).find(
      (candidate) =>
        candidate.providerId === 'opencode' &&
        matchesTeamMemberIdentity(candidate.member.name, memberName)
    );
    if (
      !isExplicitLegacyOpenCodeBootstrap(
        resolveOpenCodeSecondaryLaneMemberEvidence(lane, memberName)
      )
    ) {
      return OPENCODE_APP_MANAGED_BOOTSTRAP_STALLED_DIAGNOSTIC;
    }
    const selectedDiagnostic = selectOpenCodeSecondaryBootstrapStallDiagnostic([
      current.runtimeDiagnostic,
      ...(lane?.diagnostics ?? []),
      ...(lane?.result?.diagnostics ?? []),
      ...(lane?.result?.members[memberName]?.diagnostics ?? []),
      ...Object.values(lane?.result?.members ?? {})
        .filter((member) => matchesTeamMemberIdentity(member.memberName ?? '', memberName))
        .flatMap((member) => member.diagnostics ?? []),
    ]);
    if (selectedDiagnostic) {
      return selectedDiagnostic;
    }

    const acceptedAtMs =
      current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
    const transcriptOutcome = await this.findBootstrapTranscriptOutcome(
      run.teamName,
      memberName,
      Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
    );
    if (transcriptOutcome?.kind === 'success' && transcriptOutcome.source === 'member_briefing') {
      return 'OpenCode member_briefing completed, but runtime_bootstrap_checkin did not complete after 5 min.';
    }
    return 'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.';
  }

  private setOpenCodeSecondaryBootstrapStalledStatus(
    run: ProvisioningRun,
    memberName: string,
    current: MemberSpawnStatusEntry,
    runtimeDiagnostic: string
  ): void {
    const observedAt = nowIso();
    const wasBootstrapStalled = current.bootstrapStalled === true;
    const runtimeProcessAlive =
      current.runtimeAlive === true && current.livenessKind === 'runtime_process';
    const next: MemberSpawnStatusEntry = {
      ...current,
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      agentToolAccepted: true,
      runtimeAlive: runtimeProcessAlive,
      bootstrapConfirmed: false,
      hardFailure: false,
      error: undefined,
      hardFailureReason: undefined,
      livenessSource: undefined,
      livenessKind:
        current.livenessKind ?? (runtimeProcessAlive ? 'runtime_process' : 'registered_only'),
      runtimeDiagnostic,
      runtimeDiagnosticSeverity: 'warning',
      bootstrapStalled: true,
      livenessLastCheckedAt: observedAt,
      firstSpawnAcceptedAt: current.firstSpawnAcceptedAt ?? observedAt,
      updatedAt: observedAt,
    };

    this.syncMemberTaskActivityForRuntimeTransition(run, memberName, current, next, observedAt);
    run.memberSpawnStatuses.set(memberName, next);
    const launchDiagnostics = boundLaunchDiagnostics(buildLaunchDiagnosticsFromRun(run));
    if (launchDiagnostics) {
      run.progress = {
        ...run.progress,
        updatedAt: observedAt,
        launchDiagnostics,
      };
      run.onProgress(run.progress);
    }

    if (!wasBootstrapStalled) {
      this.appendMemberBootstrapDiagnostic(run, memberName, runtimeDiagnostic);
    }
    if (!this.isCurrentTrackedRun(run)) return;
    this.emitMemberSpawnChange(run, memberName);
    if (run.isLaunch) {
      void this.persistLaunchStateSnapshot(run, run.provisioningComplete ? 'finished' : 'active');
    }
  }

  private async maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt(input: {
    run: ProvisioningRun;
    memberName: string;
    current: MemberSpawnStatusEntry;
    runtimeDiagnostic: string;
    runtimeSessionId?: string;
  }): Promise<void> {
    const { run, memberName, current, runtimeDiagnostic } = input;
    if (
      !this.isCurrentTrackedRun(run) ||
      run.processKilled ||
      run.cancelRequested ||
      current.launchState !== 'runtime_pending_bootstrap' ||
      current.bootstrapConfirmed === true ||
      current.hardFailure === true ||
      current.skippedForLaunch === true ||
      (current.pendingPermissionRequestIds?.length ?? 0) > 0
    ) {
      return;
    }

    const lane = (run.mixedSecondaryLanes ?? []).find(
      (candidate) =>
        candidate.providerId === 'opencode' &&
        matchesTeamMemberIdentity(candidate.member.name, memberName)
    );
    const laneRunId = lane?.runId?.trim();
    const runtimeSessionId =
      input.runtimeSessionId?.trim() ||
      lane?.result?.members[memberName]?.sessionId?.trim() ||
      Object.values(lane?.result?.members ?? {})
        .find((member) => matchesTeamMemberIdentity(member.memberName ?? '', memberName))
        ?.sessionId?.trim() ||
      '';
    if (!lane || !laneRunId || !isMaterializedOpenCodeSessionId(runtimeSessionId)) {
      return;
    }
    if (
      !isExplicitLegacyOpenCodeBootstrap(
        resolveOpenCodeSecondaryLaneMemberEvidence(lane, memberName)
      )
    ) {
      return;
    }

    const diagnostics = [
      runtimeDiagnostic,
      current.runtimeDiagnostic,
      ...(lane.diagnostics ?? []),
      ...(lane.result?.diagnostics ?? []),
      ...(lane.result?.members[memberName]?.diagnostics ?? []),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    if (hasRealOpenCodeFailureDiagnostic(diagnostics.join('\n').toLowerCase())) {
      return;
    }

    const marker = getOpenCodeBootstrapCheckinRetryMarker(laneRunId, runtimeSessionId);
    if (
      run.provisioningOutputParts.some((line) => line.includes(marker)) ||
      diagnostics.some((line) => line.includes(marker))
    ) {
      return;
    }

    const adapter = this.getOpenCodeRuntimeMessageAdapter();
    if (!adapter) {
      return;
    }

    lane.diagnostics = [...new Set([...(lane.diagnostics ?? []), marker])];
    this.appendMemberBootstrapDiagnostic(run, memberName, marker);

    try {
      const result = await this.sendOpenCodeMemberMessageToRuntimeSerialized({
        teamName: run.teamName,
        laneId: lane.laneId,
        send: async () =>
          await adapter.sendMessageToMember({
            runId: laneRunId,
            teamName: run.teamName,
            laneId: lane.laneId,
            memberName,
            cwd: lane.member.cwd?.trim() || run.request.cwd,
            text: '',
            messageId: `bootstrap-checkin-retry-${run.runId}-${memberName}-${runtimeSessionId}`,
            bootstrapCheckinRetry: {
              runtimeSessionId,
              reason: runtimeDiagnostic,
            },
          }),
      });
      if (!result.ok) {
        this.appendMemberBootstrapDiagnostic(
          run,
          memberName,
          `opencode_bootstrap_checkin_retry_prompt_failed: ${
            result.diagnostics.join('; ') || 'OpenCode bridge did not accept retry prompt'
          }`
        );
      }
    } catch (error) {
      this.appendMemberBootstrapDiagnostic(
        run,
        memberName,
        `opencode_bootstrap_checkin_retry_prompt_failed: ${getErrorMessage(error)}`
      );
    }
  }

  private scheduleOpenCodeBootstrapStallReevaluation(
    run: ProvisioningRun,
    memberName: string,
    firstSpawnAcceptedAt: string
  ): void {
    const acceptedAtMs = Date.parse(firstSpawnAcceptedAt);
    if (!Number.isFinite(acceptedAtMs)) {
      return;
    }
    const stallDelayMs = Math.max(1_000, acceptedAtMs + MEMBER_BOOTSTRAP_STALL_MS - Date.now());
    const stallKey = `${this.getMemberLaunchGraceKey(run, memberName)}:bootstrap-stall`;
    if (this.pendingTimeouts.has(stallKey)) {
      return;
    }
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(stallKey);
      void this.reevaluateMemberLaunchStatus(run, memberName);
    }, stallDelayMs);
    timer.unref?.();
    this.pendingTimeouts.set(stallKey, timer);
  }

  private isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt: string | undefined): boolean {
    if (!firstSpawnAcceptedAt) {
      return false;
    }
    const acceptedAtMs = Date.parse(firstSpawnAcceptedAt);
    return Number.isFinite(acceptedAtMs) && Date.now() - acceptedAtMs >= MEMBER_BOOTSTRAP_STALL_MS;
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
    if (!run.expectedMembers || run.expectedMembers.length === 0) {
      return;
    }
    await this.reconcileBootstrapTranscriptFailures(run);
    await this.reconcileBootstrapTranscriptSuccesses(run);
    if (this.shouldSkipMemberSpawnAudit(run)) {
      return;
    }
    const now = Date.now();
    if (
      !options?.force &&
      run.lastMemberSpawnAuditAt > 0 &&
      now - run.lastMemberSpawnAuditAt < MEMBER_SPAWN_AUDIT_MIN_INTERVAL_MS
    ) {
      return;
    }
    run.lastMemberSpawnAuditAt = now;
    await this.auditMemberSpawnStatuses(run);
    await this.reconcileBootstrapTranscriptSuccesses(run);
  }

  private async reconcileBootstrapTranscriptFailures(run: ProvisioningRun): Promise<void> {
    for (const memberName of run.expectedMembers ?? []) {
      const current = run.memberSpawnStatuses.get(memberName);
      if (
        !current ||
        current.launchState === 'failed_to_start' ||
        current.launchState === 'confirmed_alive' ||
        current.hardFailure === true ||
        current.agentToolAccepted !== true
      ) {
        continue;
      }
      const acceptedAtMs =
        current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const transcriptFailureReason = await this.findBootstrapTranscriptFailureReason(
        run.teamName,
        memberName,
        Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
      );
      if (!transcriptFailureReason) {
        continue;
      }
      this.setMemberSpawnStatus(run, memberName, 'error', transcriptFailureReason);
    }
  }

  private async reconcileBootstrapTranscriptSuccesses(run: ProvisioningRun): Promise<void> {
    for (const memberName of run.expectedMembers ?? []) {
      const current = run.memberSpawnStatuses.get(memberName);
      if (this.isOpenCodeSecondaryLaneMemberInRun(run, memberName)) {
        continue;
      }
      const failureReason = current?.hardFailureReason ?? current?.error;
      const canClearFailedBootstrap =
        current?.launchState === 'failed_to_start' &&
        current.agentToolAccepted === true &&
        isBootstrapProofClearableLaunchFailureReason(failureReason);
      if (
        !current ||
        (current.launchState === 'failed_to_start' && !canClearFailedBootstrap) ||
        current.launchState === 'confirmed_alive' ||
        current.bootstrapConfirmed === true ||
        (current.agentToolAccepted !== true && !canClearFailedBootstrap)
      ) {
        continue;
      }
      const acceptedAtMs =
        current.firstSpawnAcceptedAt != null ? Date.parse(current.firstSpawnAcceptedAt) : NaN;
      const runtimeProofObservedAt = await this.findBootstrapRuntimeProofObservedAt(
        run.teamName,
        memberName,
        current
      );
      if (runtimeProofObservedAt) {
        this.confirmMemberSpawnStatusFromTranscript(
          run,
          memberName,
          runtimeProofObservedAt,
          'runtime-proof'
        );
        continue;
      }
      const transcriptOutcome = await this.findBootstrapTranscriptOutcome(
        run.teamName,
        memberName,
        Number.isFinite(acceptedAtMs) ? acceptedAtMs : null
      );
      if (transcriptOutcome?.kind !== 'success') {
        continue;
      }
      this.confirmMemberSpawnStatusFromTranscript(run, memberName, transcriptOutcome.observedAt);
    }
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
    const payload = this.buildLeadContextUsagePayload(run);
    this.teamChangeEmitter?.({
      type: 'lead-context',
      teamName: run.teamName,
      runId: run.runId,
      detail: JSON.stringify(payload),
    });
  }

  async warmup(): Promise<void> {
    await warmupProviderPreflight({
      ports: {
        getFreshCachedProbeResult: (cwd, providerId) =>
          this.getFreshCachedProbeResult(cwd, providerId),
        getCachedOrProbeResult: (cwd, providerId) => this.getCachedOrProbeResult(cwd, providerId),
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
      },
    });
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
    const inFlightKey = this.createPrepareForProvisioningInFlightKey(cwd, opts);
    const inFlight = this.prepareForProvisioningInFlight.get(inFlightKey);
    if (inFlight) {
      return this.clonePrepareForProvisioningResult(await inFlight);
    }

    const request = this.prepareForProvisioningOnce(cwd, opts).finally(() => {
      if (this.prepareForProvisioningInFlight.get(inFlightKey) === request) {
        this.prepareForProvisioningInFlight.delete(inFlightKey);
      }
    });
    this.prepareForProvisioningInFlight.set(inFlightKey, request);
    return this.clonePrepareForProvisioningResult(await request);
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
    const providerIds = Array.from(
      new Set(
        [opts?.providerId, ...(opts?.providerIds ?? [])]
          .map((providerId) => resolveTeamProviderId(providerId))
          .filter((providerId): providerId is TeamProviderId => Boolean(providerId))
      )
    );
    const modelIds = Array.from(
      new Set((opts?.modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
    );
    const modelChecks = normalizeProvisioningModelCheckRequests(opts?.modelChecks)
      .map((check) => ({
        providerId: check.providerId,
        model: check.model,
        effort: check.effort ?? null,
      }))
      .sort(
        (left, right) =>
          left.providerId.localeCompare(right.providerId) ||
          left.model.localeCompare(right.model) ||
          (left.effort ?? '').localeCompare(right.effort ?? '')
      );
    return JSON.stringify({
      cwd: cwd?.trim() || process.cwd(),
      forceFresh: opts?.forceFresh === true,
      providerIds,
      modelIds,
      modelChecks,
      limitContext: opts?.limitContext === true,
      modelVerificationMode: opts?.modelVerificationMode ?? null,
    });
  }

  private clonePrepareForProvisioningResult(
    result: TeamProvisioningPrepareResult
  ): TeamProvisioningPrepareResult {
    return {
      ...result,
      details: result.details ? [...result.details] : undefined,
      warnings: result.warnings ? [...result.warnings] : undefined,
      issues: result.issues?.map((issue) => ({ ...issue })),
      supportDiagnostics: result.supportDiagnostics?.map((diagnostic) => ({ ...diagnostic })),
    };
  }

  private async prepareForProvisioningOnce(
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
    const targetCwdForValidation = cwd?.trim() || process.cwd();
    await this.validatePrepareCwd(targetCwdForValidation);
    const providerIds = Array.from(
      new Set(
        [opts?.providerId, ...(opts?.providerIds ?? [])]
          .map((providerId) => resolveTeamProviderId(providerId))
          .filter((providerId): providerId is TeamProviderId => Boolean(providerId))
      )
    );
    if (providerIds.length === 0) {
      providerIds.push('anthropic');
    }

    // Allow callers (e.g. scheduler warm-up) to bypass the 36h probe cache
    if (opts?.forceFresh) {
      for (const providerId of providerIds) {
        this.clearProbeCache(targetCwdForValidation, providerId);
      }
    }

    const targetCwd = cwd?.trim() || process.cwd();
    if (!path.isAbsolute(targetCwd)) {
      throw new Error('cwd must be an absolute path');
    }

    const warnings: string[] = [];
    const details: string[] = [];
    const blockingMessages: string[] = [];
    const issues: TeamProvisioningPrepareIssue[] = [];
    const supportDiagnostics: TeamProvisioningSupportDiagnostic[] = [];
    const selectedModelIds = Array.from(
      new Set((opts?.modelIds ?? []).map((modelId) => modelId.trim()).filter(Boolean))
    );
    const selectedModelChecks = normalizeProvisioningModelCheckRequests(opts?.modelChecks);
    const useStructuredModelChecks = selectedModelChecks.length > 0;

    for (const providerId of providerIds) {
      const providerModelChecks = selectedModelChecks
        .filter((check) => check.providerId === providerId)
        .map((check) => ({
          modelId: check.model,
          ...(check.effort ? { effort: check.effort } : {}),
        }));
      const providerSelectedModelIds = useStructuredModelChecks
        ? Array.from(new Set(providerModelChecks.map((check) => check.modelId)))
        : selectedModelIds;

      if (providerId === 'opencode') {
        const adapter = this.getOpenCodeRuntimeAdapter();
        if (!adapter) {
          blockingMessages.push(
            'OpenCode team launch is not enabled yet. Production launch requires the gated OpenCode runtime adapter.'
          );
          continue;
        }

        if (providerSelectedModelIds.length === 0) {
          const prepare = await adapter.prepare({
            runId: `prepare-${randomUUID()}`,
            teamName: '__prepare_opencode__',
            cwd: targetCwd,
            providerId: 'opencode',
            model: undefined,
            runtimeOnly: true,
            skipPermissions: true,
            expectedMembers: [],
            previousLaunchState: null,
          });
          const prepareReason = prepare.ok ? undefined : prepare.reason;
          details.push(
            ...prepare.diagnostics.map((diagnostic) =>
              normalizeOpenCodePrepareDiagnostic(diagnostic, prepareReason)
            )
          );
          warnings.push(
            ...prepare.warnings.map((warning) =>
              normalizeOpenCodePrepareDiagnostic(warning, prepareReason)
            )
          );
          pushUniqueSupportDiagnostics(supportDiagnostics, prepare.supportDiagnostics);
          if (!prepare.ok) {
            const providerDiagnostic = selectOpenCodePrepareProviderDiagnostic(prepare);
            blockingMessages.push(
              providerDiagnostic
                ? normalizeOpenCodePrepareDiagnostic(providerDiagnostic, prepare.reason)
                : normalizeOpenCodePrepareDiagnostic(`OpenCode: ${prepare.reason}`, prepare.reason)
            );
          }
          continue;
        }

        const openCodeModelPrepare = await prepareSelectedOpenCodeModelsForProvisioning({
          adapter,
          cwd: targetCwd,
          modelIds: providerSelectedModelIds,
          verificationMode: opts?.modelVerificationMode ?? 'deep',
          appendPreflightDebugLog,
        });
        details.push(...openCodeModelPrepare.details);
        warnings.push(...openCodeModelPrepare.warnings);
        blockingMessages.push(...openCodeModelPrepare.blockingMessages);
        issues.push(...openCodeModelPrepare.issues);
        pushUniqueSupportDiagnostics(supportDiagnostics, openCodeModelPrepare.supportDiagnostics);
        continue;
      }

      const cached = this.getFreshCachedProbeResult(targetCwdForValidation, providerId);
      const probeResult = cached ?? (await this.getCachedOrProbeResult(targetCwd, providerId));
      if (!probeResult?.claudePath) {
        throw buildMissingCliError();
      }

      const providerLabel = getTeamProviderLabel(providerId);
      const { authSource } = probeResult;
      if (authSource === 'anthropic_api_key' || authSource === 'anthropic_api_key_helper') {
        logger.info(`Auth: using explicit ANTHROPIC_API_KEY for ${providerLabel}`);
      } else if (authSource === 'anthropic_auth_token') {
        logger.info(
          `Auth: using ANTHROPIC_AUTH_TOKEN mapped to ANTHROPIC_API_KEY for ${providerLabel}`
        );
      }

      const appendSelectedModelVerification = async (): Promise<void> => {
        if (providerSelectedModelIds.length === 0) {
          return;
        }

        const modelVerification = await this.verifySelectedProviderModels({
          claudePath: probeResult.claudePath,
          cwd: targetCwd,
          providerId,
          modelIds: providerSelectedModelIds,
          modelChecks: providerModelChecks,
          limitContext: opts?.limitContext === true,
        });
        details.push(...modelVerification.details);
        warnings.push(...modelVerification.warnings);
        blockingMessages.push(...modelVerification.blockingMessages);
        issues.push(...(modelVerification.issues ?? []));
      };

      const appendOneShotDiagnostic = async (): Promise<void> => {
        let envResolution: ProvisioningEnvResolution | null = null;
        const ensureEnvResolution = async (): Promise<ProvisioningEnvResolution> => {
          if (!envResolution) {
            envResolution = await this.buildProvisioningEnv(providerId);
          }
          return envResolution;
        };

        let shouldRequireRuntimePingForAnthropicDirectCredential =
          isAnthropicDirectCredentialAuthSource(authSource);
        if (
          resolveTeamProviderId(providerId) === 'anthropic' &&
          !shouldRequireRuntimePingForAnthropicDirectCredential
        ) {
          const resolvedEnv = await ensureEnvResolution();
          shouldRequireRuntimePingForAnthropicDirectCredential =
            isAnthropicDirectCredentialAuthSource(resolvedEnv.authSource);
          if (resolvedEnv.authSource === 'configured_api_key_missing' && resolvedEnv.warning) {
            blockingMessages.push(
              providerIds.length > 1
                ? `${providerLabel}: ${resolvedEnv.warning}`
                : resolvedEnv.warning
            );
            return;
          }
        }

        if (
          opts?.modelVerificationMode !== 'deep' &&
          !shouldRequireRuntimePingForAnthropicDirectCredential
        ) {
          return;
        }
        const resolvedEnv = await ensureEnvResolution();
        if (resolvedEnv.warning) {
          const prefixedWarning =
            providerIds.length > 1
              ? `${providerLabel}: ${resolvedEnv.warning}`
              : resolvedEnv.warning;
          if (resolvedEnv.authSource === 'configured_api_key_missing') {
            blockingMessages.push(prefixedWarning);
            return;
          }
          warnings.push(prefixedWarning);
          return;
        }
        const diagnostic = await this.runProviderOneShotDiagnostic(
          probeResult.claudePath,
          targetCwd,
          resolvedEnv.env,
          providerId,
          resolvedEnv.providerArgs
        );
        if (diagnostic.warning) {
          const prefixedWarning =
            providerIds.length > 1 ? `${providerLabel}: ${diagnostic.warning}` : diagnostic.warning;
          if (
            shouldRequireRuntimePingForAnthropicDirectCredential &&
            isAuthFailureWarning(diagnostic.warning, 'probe')
          ) {
            blockingMessages.push(prefixedWarning);
            return;
          }
          warnings.push(prefixedWarning);
        }
      };

      if (!probeResult.warning) {
        const blockingCountBeforeModelChecks = blockingMessages.length;
        await appendSelectedModelVerification();
        if (blockingMessages.length === blockingCountBeforeModelChecks) {
          await appendOneShotDiagnostic();
        }
        continue;
      }

      {
        const prefixedWarning =
          providerIds.length > 1 ? `${providerLabel}: ${probeResult.warning}` : probeResult.warning;
        const isAuthFailure = isAuthFailureWarning(probeResult.warning, 'probe');
        const isBlockingPreflightWarning =
          authSource === 'configured_api_key_missing' ||
          (isAnthropicDirectCredentialAuthSource(authSource) && isAuthFailure) ||
          ((authSource === 'none' ||
            authSource === 'codex_runtime' ||
            authSource === 'gemini_runtime') &&
            isAuthFailure) ||
          isBinaryProbeWarning(probeResult.warning);
        if (authSource === 'configured_api_key_missing') {
          blockingMessages.push(prefixedWarning);
        } else if (
          (authSource === 'none' ||
            authSource === 'codex_runtime' ||
            authSource === 'gemini_runtime') &&
          isAuthFailure
        ) {
          blockingMessages.push(prefixedWarning);
        } else if (isAnthropicDirectCredentialAuthSource(authSource) && isAuthFailure) {
          blockingMessages.push(prefixedWarning);
        } else if (isBinaryProbeWarning(probeResult.warning)) {
          blockingMessages.push(prefixedWarning);
        } else {
          // Preflight warnings (including timeouts) should not block provisioning.
          warnings.push(prefixedWarning);
          const blockingCountBeforeModelChecks = blockingMessages.length;
          if (!isBlockingPreflightWarning && providerSelectedModelIds.length > 0) {
            await appendSelectedModelVerification();
          }
          if (
            !isBlockingPreflightWarning &&
            blockingMessages.length === blockingCountBeforeModelChecks
          ) {
            await appendOneShotDiagnostic();
          }
        }
      }
    }

    if (blockingMessages.length > 0) {
      const failureWarnings = Array.from(new Set([...warnings, ...blockingMessages]));
      return {
        ready: false,
        details: details.length > 0 ? details : undefined,
        message:
          blockingMessages.length === 1
            ? blockingMessages[0]
            : 'Some provider runtimes are not ready',
        warnings: failureWarnings.length > 0 ? failureWarnings : undefined,
        issues: issues.length > 0 ? issues : undefined,
        supportDiagnostics:
          supportDiagnostics.length > 0
            ? supportDiagnostics.map((diagnostic) => ({ ...diagnostic }))
            : undefined,
      };
    }

    return {
      ready: true,
      details: details.length > 0 ? details : undefined,
      message:
        providerIds.length > 1
          ? warnings.length > 0
            ? `Validated ${providerIds.length}/${providerIds.length} provider runtimes (see notes)`
            : `Validated ${providerIds.length}/${providerIds.length} provider runtimes`
          : warnings.length > 0
            ? 'CLI is ready to launch (see notes)'
            : 'CLI is warmed up and ready to launch',
      warnings: warnings.length > 0 ? warnings : undefined,
      issues: issues.length > 0 ? issues : undefined,
      supportDiagnostics:
        supportDiagnostics.length > 0
          ? supportDiagnostics.map((diagnostic) => ({ ...diagnostic }))
          : undefined,
    };
  }

  private async verifySelectedProviderModels({
    claudePath,
    cwd,
    providerId,
    modelIds,
    modelChecks,
    limitContext,
  }: {
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
    return verifySelectedProviderModelsForProvisioning({
      claudePath,
      cwd,
      providerId,
      modelIds,
      modelChecks,
      limitContext,
      ports: {
        buildProvisioningEnv: (providerIdForEnv) => this.buildProvisioningEnv(providerIdForEnv),
        readRuntimeProviderLaunchFacts: (params) => this.readRuntimeProviderLaunchFacts(params),
        appendPreflightDebugLog,
      },
    });
  }

  private async resolveProviderDefaultModel(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    let parsed: ProviderModelListCommandResponse;
    try {
      const { stdout } = await execCli(
        claudePath,
        buildProviderControlPlaneCliCommandArgs(providerArgs, [
          'model',
          'list',
          '--json',
          '--provider',
          providerId,
        ]),
        {
          cwd,
          env,
          timeout: PROVIDER_MODEL_LIST_TIMEOUT_MS,
        }
      );
      parsed = extractJsonObjectFromCli<ProviderModelListCommandResponse>(stdout);
    } catch (error) {
      const fallbackDefaultModel = await this.resolveProviderDefaultModelFromRuntimeStatus(
        claudePath,
        cwd,
        providerId,
        env,
        providerArgs,
        limitContext
      ).catch(() => null);
      if (fallbackDefaultModel) {
        return fallbackDefaultModel;
      }
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to load runtime default model list for ${getTeamProviderLabel(providerId)} (${providerId}): ${message}`
      );
    }
    const defaultModel = parsed.providers?.[providerId]?.defaultModel;
    const normalizedDefaultModel =
      typeof defaultModel === 'string' && defaultModel.trim().length > 0
        ? defaultModel.trim()
        : null;
    const modelIds = normalizeProviderModelListModels(parsed.providers?.[providerId]);

    if (providerId === 'anthropic') {
      return resolveAnthropicLaunchModel({
        limitContext,
        availableLaunchModels: modelIds,
        defaultLaunchModel: normalizedDefaultModel,
      });
    }

    if (normalizedDefaultModel) {
      return normalizedDefaultModel;
    }

    return this.resolveProviderDefaultModelFromRuntimeStatus(
      claudePath,
      cwd,
      providerId,
      env,
      providerArgs,
      limitContext
    ).catch(() => null);
  }

  private async resolveProviderDefaultModelFromRuntimeStatus(
    claudePath: string,
    cwd: string,
    providerId: TeamProviderId,
    env: NodeJS.ProcessEnv,
    providerArgs: string[] = [],
    limitContext: boolean
  ): Promise<string | null> {
    const { stdout } = await execCli(
      claudePath,
      buildProviderControlPlaneCliCommandArgs(providerArgs, [
        'runtime',
        'status',
        '--json',
        '--provider',
        providerId,
      ]),
      {
        cwd,
        env,
        timeout: PROVIDER_RUNTIME_STATUS_TIMEOUT_MS,
      }
    );
    const parsed = extractJsonObjectFromCli<RuntimeStatusCommandResponse>(stdout);
    const providerStatus = parsed.providers?.[providerId] ?? null;
    const modelCatalog =
      providerStatus?.modelCatalog?.providerId === providerId ? providerStatus.modelCatalog : null;
    const defaultLaunchModel = modelCatalog?.defaultLaunchModel?.trim() || null;

    if (providerId === 'anthropic') {
      return resolveAnthropicLaunchModel({
        limitContext,
        availableLaunchModels: modelCatalog?.models.map((model) => model.launchModel) ?? [],
        defaultLaunchModel,
      });
    }

    return defaultLaunchModel;
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
    const envByProvider = new Map<TeamProviderId, Promise<ProvisioningEnvResolution>>();
    const defaultModelByProvider = new Map<TeamProviderId, Promise<string>>();
    const normalizedPrimaryProviderId = resolveTeamProviderId(params.primaryProviderId);

    const getProvisioningEnv = (providerId: TeamProviderId): Promise<ProvisioningEnvResolution> => {
      if (normalizedPrimaryProviderId === providerId && params.primaryEnv != null) {
        return Promise.resolve(params.primaryEnv);
      }

      const cached = envByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const created = this.buildProvisioningEnv(providerId, undefined, {
        teamRuntimeAuth: params.teamRuntimeAuth,
      });
      envByProvider.set(providerId, created);
      return created;
    };

    const getResolvedDefaultModel = (providerId: TeamProviderId): Promise<string> => {
      const cached = defaultModelByProvider.get(providerId);
      if (cached) {
        return cached;
      }

      const providerLabel = getTeamProviderLabel(providerId);
      const created = (async () => {
        const envResolution = await getProvisioningEnv(providerId);
        if (envResolution.warning) {
          throw new Error(envResolution.warning);
        }

        const resolvedDefaultModel = await this.resolveProviderDefaultModel(
          params.claudePath,
          params.cwd,
          providerId,
          envResolution.env,
          params.providerArgsResolver?.({
            providerId,
            providerArgs: envResolution.providerArgs ?? [],
            phase: 'default-model-resolution',
          }) ??
            envResolution.providerArgs ??
            [],
          params.limitContext === true
        );
        const normalized = resolvedDefaultModel?.trim();
        if (!normalized) {
          throw new Error(
            `Could not resolve the runtime default model for ${providerLabel} teammates. Select an explicit model and retry.`
          );
        }
        return normalized;
      })();

      defaultModelByProvider.set(providerId, created);
      return created;
    };

    const effectiveMembers: TeamCreateRequest['members'] = [];
    for (const member of params.members) {
      const effectiveMember = buildEffectiveTeamMemberSpec(member, params.defaults);
      const providerId = normalizeTeamMemberProviderId(effectiveMember.providerId) ?? 'anthropic';
      if (providerId === 'anthropic' || effectiveMember.model?.trim()) {
        effectiveMembers.push(effectiveMember);
        continue;
      }

      effectiveMembers.push({
        ...effectiveMember,
        model: await getResolvedDefaultModel(providerId),
      });
    }

    return effectiveMembers;
  }

  private getOpenCodeRuntimeLaunchCwd(
    fallbackCwd: string,
    members: TeamCreateRequest['members']
  ): string {
    if (members.length > 1 && members.some((member) => member.isolation === 'worktree')) {
      throw new Error(
        'OpenCode worktree isolation currently supports one isolated OpenCode member per runtime lane.'
      );
    }
    const memberCwds = [
      ...new Set(
        members.map((member) => member.cwd?.trim()).filter((cwd): cwd is string => Boolean(cwd))
      ),
    ];
    if (memberCwds.length === 0) {
      return fallbackCwd;
    }
    if (memberCwds.length === 1) {
      return memberCwds[0];
    }
    throw new Error(
      'OpenCode runtime lanes support exactly one project path per lane. Use separate OpenCode worktree-root lanes for per-teammate worktree isolation.'
    );
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
    const effectiveMembers = buildEffectiveTeamMemberSpecs(params.members, {
      providerId: params.request.providerId,
      model: params.request.model,
      effort: params.request.effort,
    });
    const explicitRootModel = getExplicitLaunchModelSelection(params.request.model);
    const memberModels = [
      ...new Set(
        effectiveMembers
          .map((member) => member.model?.trim())
          .filter((model): model is string => Boolean(model))
      ),
    ];
    if (!explicitRootModel && memberModels.length > 1) {
      throw new Error(
        'OpenCode runtime adapter launch supports one selected model per lane. Select one team model or align OpenCode teammate models.'
      );
    }
    const inheritedRootModel = explicitRootModel ? undefined : memberModels[0];
    const rootModel = explicitRootModel ?? inheritedRootModel;
    const needsMemberModel = effectiveMembers.some((member) => {
      const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
      return providerId === 'opencode' && !member.model?.trim();
    });
    if (rootModel && !needsMemberModel) {
      return {
        request: {
          ...params.request,
          model: rootModel,
        } as TRequest,
        members: effectiveMembers,
      };
    }
    if (rootModel) {
      return {
        request: {
          ...params.request,
          model: rootModel,
        } as TRequest,
        members: effectiveMembers.map((member) => {
          const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
          if (providerId !== 'opencode' || member.model?.trim()) {
            return member;
          }
          return {
            ...member,
            model: rootModel,
          };
        }),
      };
    }

    const claudePath = await ClaudeBinaryResolver.resolve();
    if (!claudePath) {
      throw buildMissingCliError();
    }
    const provisioningEnv = await this.buildProvisioningEnv(
      'opencode',
      params.request.providerBackendId
    );
    if (provisioningEnv.warning) {
      throw new Error(provisioningEnv.warning);
    }
    const resolvedDefaultModel = await this.resolveProviderDefaultModel(
      claudePath,
      params.request.cwd,
      'opencode',
      provisioningEnv.env,
      provisioningEnv.providerArgs ?? [],
      params.request.limitContext === true
    );
    const normalizedDefaultModel = resolvedDefaultModel?.trim();
    if (!normalizedDefaultModel) {
      throw new Error(
        'Could not resolve the runtime default model for OpenCode teammates. Select an explicit model and retry.'
      );
    }

    return {
      request: {
        ...params.request,
        model: normalizedDefaultModel,
      } as TRequest,
      members: effectiveMembers.map((member) => {
        const providerId = normalizeTeamMemberProviderId(member.providerId) ?? 'opencode';
        if (providerId !== 'opencode' || member.model?.trim()) {
          return member;
        }
        return {
          ...member,
          model: normalizedDefaultModel,
        };
      }),
    };
  }

  private buildOpenCodeRuntimeAdapterLaunchMembers(
    request: TeamCreateRequest | TeamLaunchRequest,
    members: TeamCreateRequest['members'],
    lanePlan?: TeamRuntimeLanePlan
  ): TeamCreateRequest['members'] {
    if (resolveTeamProviderId(request.providerId) !== 'opencode') {
      return members;
    }
    const runtimeMembers: TeamCreateRequest['members'] = [...members];
    if (
      lanePlan &&
      isPureOpenCodeSoloLanePlan(lanePlan) &&
      !runtimeMembers.some(
        (member) => member.name.trim().toLowerCase() === OPEN_CODE_SOLO_MEMBER_NAME
      )
    ) {
      runtimeMembers.push({
        name: lanePlan.soloMember.name,
        role: lanePlan.soloMember.role ?? OPEN_CODE_SOLO_MEMBER_ROLE,
        providerId: 'opencode',
        providerBackendId: request.providerBackendId,
        model: lanePlan.soloMember.model ?? request.model,
        effort: lanePlan.soloMember.effort ?? request.effort,
        fastMode: lanePlan.soloMember.fastMode ?? request.fastMode,
        cwd: lanePlan.soloMember.cwd?.trim() || request.cwd,
      });
    }
    if (runtimeMembers.some((member) => isLeadMember(member))) {
      return runtimeMembers;
    }

    return [
      {
        name: 'team-lead',
        role: 'Team Lead',
        providerId: 'opencode',
        model: request.model,
        effort: request.effort,
      },
      ...runtimeMembers,
    ];
  }

  private async resolveOpenCodeMemberWorkspacesForRuntime(params: {
    teamName: string;
    baseCwd: string;
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): Promise<TeamCreateRequest['members']> {
    const isolatedOpenCodeMembers = params.members.filter((member) => {
      const providerId = normalizeTeamMemberProviderId(member.providerId);
      return providerId === 'opencode' && member.isolation === 'worktree';
    });
    if (isolatedOpenCodeMembers.length === 0) {
      return params.members;
    }

    const nextMembers: TeamCreateRequest['members'] = [];
    for (const member of params.members) {
      const providerId = normalizeTeamMemberProviderId(member.providerId);
      if (providerId !== 'opencode' || member.isolation !== 'worktree') {
        nextMembers.push(member);
        continue;
      }

      const existingCwd = member.cwd?.trim();
      if (existingCwd) {
        if (!path.isAbsolute(existingCwd)) {
          throw new Error(
            `OpenCode worktree path for "${member.name}" must be absolute: ${existingCwd}`
          );
        }
        const existingCwdStat = await fs.promises.stat(existingCwd).catch(() => null);
        if (existingCwdStat) {
          if (!existingCwdStat.isDirectory()) {
            throw new Error(
              `OpenCode worktree path for "${member.name}" is not a directory: ${existingCwd}`
            );
          }
          nextMembers.push({ ...member, cwd: existingCwd });
          continue;
        }
      }

      const resolution = await this.memberWorktreeManager.ensureMemberWorktree({
        teamName: params.teamName,
        memberName: member.name,
        baseCwd: params.baseCwd,
      });
      nextMembers.push({ ...member, cwd: resolution.worktreePath });
    }

    return nextMembers;
  }

  private getFreshCachedProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): CachedProbeResult | null {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = cachedProbeResults.get(cacheKey);
    if (!cached) return null;
    const ageMs = Date.now() - cached.cachedAtMs;
    if (ageMs >= PROBE_CACHE_TTL_MS) {
      cachedProbeResults.delete(cacheKey);
      return null;
    }
    return cached;
  }

  private clearProbeCache(cwd: string, providerId: TeamProviderId | undefined): void {
    cachedProbeResults.delete(createProbeCacheKey(cwd, providerId));
  }

  private async validatePrepareCwd(cwd: string): Promise<void> {
    await validatePrepareCwd(cwd);
  }

  private async getCachedOrProbeResult(
    cwd: string,
    providerId: TeamProviderId | undefined
  ): Promise<ProbeResult | null> {
    const cacheKey = createProbeCacheKey(cwd, providerId);
    const cached = this.getFreshCachedProbeResult(cwd, providerId);
    if (cached) {
      return {
        claudePath: cached.claudePath,
        authSource: cached.authSource,
        warning: cached.warning,
      };
    }

    const existingProbe = probeInFlightByKey.get(cacheKey);
    if (existingProbe) {
      return await existingProbe;
    }

    const probePromise = (async () => {
      const claudePath = await ClaudeBinaryResolver.resolve();
      if (!claudePath) return null;

      const {
        env,
        authSource,
        providerArgs = [],
        warning,
      } = await this.buildProvisioningEnv(providerId);
      if (warning) {
        return {
          claudePath,
          authSource,
          warning,
        };
      }

      const probe = await this.probeClaudeRuntime(claudePath, cwd, env, providerId, providerArgs);
      const result = {
        claudePath,
        authSource,
        ...(probe.warning ? { warning: probe.warning } : {}),
      };

      const shouldCache =
        !probe.warning ||
        (!isAuthFailureWarning(probe.warning, 'probe') &&
          !isTransientProbeWarning(probe.warning) &&
          !isBinaryProbeWarning(probe.warning));

      if (shouldCache) {
        cachedProbeResults.set(cacheKey, { cacheKey, ...result, cachedAtMs: Date.now() });
      } else {
        // Don't pin auth failures / transient failures in cache — user may fix and retry.
        cachedProbeResults.delete(cacheKey);
      }

      return result;
    })();
    probeInFlightByKey.set(cacheKey, probePromise);

    try {
      return await probePromise;
    } finally {
      probeInFlightByKey.delete(cacheKey);
    }
  }

  private failProvisioningWithApiError(run: ProvisioningRun, source: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (run.progress.state === 'failed' || run.cancelRequested) return;

    const combined = [
      buildCombinedLogs(run.stdoutBuffer, run.stderrBuffer),
      run.provisioningOutputParts.length > 0 ? run.provisioningOutputParts.join('\n') : '',
    ]
      .filter(Boolean)
      .join('\n')
      .trim();

    const snippet = extractApiErrorSnippet(combined) ?? extractApiErrorSnippet(source) ?? null;
    const status =
      /api error:\s*(\d{3})\b/i.exec(combined)?.[1] ?? /api error:\s*(\d{3})\b/i.exec(source)?.[1];

    const hint = run.isLaunch ? 'Launch' : 'Provisioning';
    const statusLabel = status ? `API Error ${status}` : 'API Error';
    if (snippet) {
      run.provisioningOutputParts.push(
        `**${hint} failed: ${statusLabel} detected**\n\n\`\`\`\n${snippet}\n\`\`\``
      );
    } else {
      run.provisioningOutputParts.push(`**${hint} failed: ${statusLabel} detected**`);
    }
    boundRunProvisioningOutputParts(run);

    const progress = updateProgress(run, 'failed', `${hint} failed — ${statusLabel}`, {
      error: `${getRunRuntimeFailureLabel(run)} reported ${statusLabel} during startup. The team was not started.`,
      cliLogsTail: extractCliLogsFromRun(run),
    });
    run.onProgress(progress);

    run.processKilled = true;
    run.cancelRequested = true;
    // SIGKILL: newer Claude CLI versions handle SIGTERM gracefully and delete
    // team files during cleanup. SIGKILL is uncatchable — files are preserved.
    killTeamProcess(run.child);
    this.cleanupRun(run);
  }

  /**
   * Shows a non-fatal API error warning in the Live output section.
   * Unlike failProvisioningWithApiError, does NOT kill the process — lets the SDK retry.
   * Deduplicates: only the first warning per run is shown.
   */
  private emitApiErrorWarning(run: ProvisioningRun, text: string): void {
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (run.progress.state === 'failed' || run.cancelRequested) return;
    if (run.apiErrorWarningEmitted) return;

    run.apiErrorWarningEmitted = true;

    const snippet = extractApiErrorSnippet(text);
    const status = /api error:\s*(\d{3})\b/i.exec(text)?.[1] ?? null;
    const label = status ? `API Error ${status}` : 'API Error';

    const warningText = snippet
      ? `**${label} — SDK is retrying**\n\n\`\`\`\n${snippet}\n\`\`\`\n\nWaiting for retry...`
      : `**${label} — SDK is retrying**\n\nWaiting for retry...`;

    run.provisioningOutputParts.push(warningText);
    boundRunProvisioningOutputParts(run);
    run.progress.message = `${label} — SDK retrying...`;
    emitLogsProgress(run);
    // Prevent double-emit: the calling stderr/stdout handler will also try throttled emitLogsProgress
    // after this returns. Updating lastLogProgressAt ensures the throttle check rejects it.
    run.lastLogProgressAt = Date.now();
  }

  /**
   * Starts a periodic watchdog that detects when the CLI process has produced
   * no stdout/stderr data for an extended period. Pushes progressive warnings
   * into provisioningOutputParts so they appear in the Live output section.
   */
  private startStallWatchdog(run: ProvisioningRun): void {
    if (run.stallCheckHandle) return;

    run.stallCheckHandle = setInterval(() => {
      // try/catch: Node.js does NOT catch errors in setInterval callbacks —
      // without this, an exception would silently kill the watchdog.
      try {
        if (
          run.provisioningComplete ||
          run.processKilled ||
          run.cancelRequested ||
          run.authRetryInProgress
        ) {
          this.stopStallWatchdog(run);
          return;
        }

        const now = Date.now();
        const silenceMs = now - run.lastStdoutReceivedAt;

        if (silenceMs < STALL_WARNING_THRESHOLD_MS) return;

        // Instead of pushing new warnings (which bloats Live output),
        // replace the existing stall warning in-place so the displayed
        // silence duration stays current (20s → 30s → 1m → ...).
        const silenceSec = Math.round(silenceMs / 1000);
        const warningText = buildStallWarningText(silenceSec, run.request);

        if (run.stallWarningIndex != null) {
          run.provisioningOutputParts[run.stallWarningIndex] = warningText;
        } else {
          // Save current message ONLY if it's a normal provisioning message,
          // not a retry message (which has higher priority and its own lifecycle).
          if (run.progress.messageSeverity !== 'error') {
            run.preStallMessage = run.progress.message;
          }
          run.stallWarningIndex = run.provisioningOutputParts.length;
          run.provisioningOutputParts.push(warningText);
          boundRunProvisioningOutputParts(run);
        }

        const mins = Math.floor(silenceSec / 60);
        const secs = silenceSec % 60;
        const elapsed = mins > 0 ? (secs > 0 ? `${mins}m ${secs}s` : `${mins}m`) : `${secs}s`;

        // If retry messages are flowing, they are more informative than our
        // generic stall text — don't overwrite progress.message / severity.
        // Only update the Live output (assistantOutput) with the stall warning.
        const retryActive = run.lastRetryAt > 0 && now - run.lastRetryAt < 90_000;

        run.progress = {
          ...run.progress,
          updatedAt: nowIso(),
          ...(!retryActive && {
            message: buildStallProgressMessage(silenceSec, elapsed),
            messageSeverity: 'warning' as const,
          }),
          assistantOutput: buildProvisioningLiveOutput(run) ?? run.progress.assistantOutput,
        };
        run.onProgress(run.progress);
      } catch (err) {
        logger.error(
          `[${run.teamName}] Stall watchdog error: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }, STALL_CHECK_INTERVAL_MS);
  }

  private stopStallWatchdog(run: ProvisioningRun): void {
    if (run.stallCheckHandle) {
      clearInterval(run.stallCheckHandle);
      run.stallCheckHandle = null;
    }
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
    if (run.provisioningComplete || run.processKilled || run.authRetryInProgress) return;
    if (!isAuthFailureWarning(text, source)) return;

    if (!run.authFailureRetried) {
      logger.warn(
        `[${run.teamName}] Auth failure detected in ${source} during provisioning — ` +
          `will kill process and retry after ${PREFLIGHT_AUTH_RETRY_DELAY_MS}ms`
      );
      run.authRetryInProgress = true;
      void this.respawnAfterAuthFailure(run);
    } else {
      logger.error(`[${run.teamName}] Auth failure detected in ${source} after retry — giving up`);
      run.processKilled = true;
      killTeamProcess(run.child);
      const runtimeLabel = getRunRuntimeFailureLabel(run);
      const progress = updateProgress(
        run,
        'failed',
        `Authentication failed - ${runtimeLabel} requires sign-in`,
        {
          error: `${runtimeLabel} is not authenticated. Open the Dashboard, authenticate the required provider, and try again.`,
          cliLogsTail: extractCliLogsFromRun(run),
        }
      );
      run.onProgress(progress);
      this.cleanupRun(run);
    }
  }

  /**
   * Kills the current process, waits for lock release, and respawns with saved context.
   * Reattaches all stream listeners and resends the prompt.
   */
  private async respawnAfterAuthFailure(run: ProvisioningRun): Promise<void> {
    const ctx = run.spawnContext;
    const stopAllGenerationAtStart = this.stopAllTeamsGeneration;
    if (!ctx) {
      logger.error(`[${run.teamName}] Cannot respawn — no spawn context saved`);
      run.authRetryInProgress = false;
      return;
    }

    // Tear down current process without full cleanupRun (keep run alive)
    if (run.timeoutHandle) {
      clearTimeout(run.timeoutHandle);
      run.timeoutHandle = null;
    }
    this.stopFilesystemMonitor(run);
    this.stopStallWatchdog(run);
    if (run.child) {
      run.child.stdout?.removeAllListeners('data');
      run.child.stderr?.removeAllListeners('data');
      run.child.removeAllListeners('error');
      run.child.removeAllListeners('exit');
      run.child.removeAllListeners('close');
      killTeamProcess(run.child);
      run.child = null;
    }

    // Reset buffers for fresh attempt
    run.stdoutBuffer = '';
    run.stderrBuffer = '';
    run.claudeLogLines = [];
    run.lastClaudeLogStream = null;
    run.stdoutLogLineBuf = '';
    run.stderrLogLineBuf = '';
    run.claudeLogsUpdatedAt = undefined;
    run.authFailureRetried = true;
    run.apiErrorWarningEmitted = false;

    updateProgress(run, 'spawning', 'Auth failed — retrying after short delay');
    run.onProgress(run.progress);

    await sleep(PREFLIGHT_AUTH_RETRY_DELAY_MS);

    if (run.cancelRequested) {
      run.authRetryInProgress = false;
      return;
    }

    // Verify --mcp-config still exists; regenerate if deleted (e.g. by stale GC)
    const mcpFlagIdx = ctx.args.indexOf('--mcp-config');
    const bootstrapPromptFlagIdx = ctx.args.indexOf('--team-bootstrap-user-prompt-file');
    if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
      const existingConfigPath = ctx.args[mcpFlagIdx + 1];
      try {
        await fs.promises.access(existingConfigPath, fs.constants.F_OK);
      } catch {
        logger.warn(`[${run.teamName}] MCP config ${existingConfigPath} missing, regenerating`);
        try {
          const newConfigPath = await this.mcpConfigBuilder.writeConfigFile(ctx.cwd, {
            controlApiBaseUrl: ctx.env.CLAUDE_TEAM_CONTROL_URL,
          });
          ctx.args[mcpFlagIdx + 1] = newConfigPath;
          run.mcpConfigPath = newConfigPath;
          logger.info(`[${run.teamName}] Regenerated MCP config at ${newConfigPath}`);
        } catch (regenErr) {
          run.authRetryInProgress = false;
          const progress = updateProgress(run, 'failed', 'Failed to regenerate MCP config', {
            error: regenErr instanceof Error ? regenErr.message : String(regenErr),
            cliLogsTail: extractCliLogsFromRun(run),
          });
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        }
      }
    }

    if (bootstrapPromptFlagIdx !== -1 && bootstrapPromptFlagIdx + 1 < ctx.args.length) {
      const existingPromptPath = ctx.args[bootstrapPromptFlagIdx + 1];
      try {
        await fs.promises.access(existingPromptPath, fs.constants.F_OK);
      } catch {
        const submissionState = await readBootstrapRealTaskSubmissionState(run.teamName);
        if (submissionState === 'submitted') {
          ctx.args.splice(bootstrapPromptFlagIdx, 2);
          ctx.prompt = '';
          run.bootstrapUserPromptPath = null;
        } else if (submissionState === 'unknown') {
          run.authRetryInProgress = false;
          const progress = updateProgress(
            run,
            'failed',
            'Unable to safely retry first task after auth failure',
            {
              error:
                'deterministic bootstrap recorded the first real task as unknown, so retry would risk a duplicate submission',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        } else if (ctx.prompt.trim().length === 0) {
          run.authRetryInProgress = false;
          const progress = updateProgress(
            run,
            'failed',
            'Failed to restore deferred first task after auth retry',
            {
              error:
                'deterministic bootstrap user prompt file was missing and no prompt was available to regenerate it',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          this.cleanupRun(run);
          return;
        } else {
          logger.warn(
            `[${run.teamName}] Bootstrap user prompt file ${existingPromptPath} missing, regenerating`
          );
          try {
            const newPromptPath = await writeDeterministicBootstrapUserPromptFile(ctx.prompt);
            ctx.args[bootstrapPromptFlagIdx + 1] = newPromptPath;
            run.bootstrapUserPromptPath = newPromptPath;
          } catch (regenErr) {
            run.authRetryInProgress = false;
            const progress = updateProgress(
              run,
              'failed',
              'Failed to regenerate deferred first task for auth retry',
              {
                error: regenErr instanceof Error ? regenErr.message : String(regenErr),
                cliLogsTail: extractCliLogsFromRun(run),
              }
            );
            run.onProgress(progress);
            this.cleanupRun(run);
            return;
          }
        }
      }
    }

    // Respawn with saved context — CLI handles its own auth refresh.
    let child: ReturnType<typeof spawn>;
    try {
      if (mcpFlagIdx !== -1 && mcpFlagIdx + 1 < ctx.args.length) {
        await this.validateAgentTeamsMcpRuntime(
          ctx.claudePath,
          ctx.cwd,
          ctx.env,
          ctx.args[mcpFlagIdx + 1],
          {
            isCancelled: () =>
              run.cancelRequested ||
              run.processKilled ||
              this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
          }
        );
      }
      if (
        run.cancelRequested ||
        run.processKilled ||
        this.stopAllTeamsGeneration !== stopAllGenerationAtStart
      ) {
        throw new Error('Team launch cancelled by app shutdown');
      }
      child = spawnCli(ctx.claudePath, ctx.args, {
        cwd: ctx.cwd,
        env: { ...ctx.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      run.authRetryInProgress = false;
      const progress = updateProgress(run, 'failed', 'Failed to respawn agent runtime', {
        error: error instanceof Error ? error.message : String(error),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
      return;
    }

    logger.info(
      `[${run.teamName}] Respawned CLI process after auth failure (pid=${child.pid ?? '?'})`
    );
    run.child = child;
    run.processClosed = false;
    run.authRetryInProgress = false;

    updateProgress(run, 'spawning', 'CLI respawned — sending prompt', {
      pid: child.pid ?? undefined,
    });
    run.onProgress(run.progress);

    // Resend prompt only for legacy direct-stdin flows. Deterministic bootstrap
    // owns the first real task via --team-bootstrap-user-prompt-file.
    if (bootstrapPromptFlagIdx === -1 && child.stdin?.writable) {
      const message = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: ctx.prompt }],
        },
      });
      child.stdin.write(message + '\n');
    }

    // Reattach stdout handler
    this.attachStdoutHandler(run);

    // Reattach stderr handler
    this.attachStderrHandler(run);

    run.lastDataReceivedAt = Date.now();
    run.lastStdoutReceivedAt = Date.now();
    this.startStallWatchdog(run);

    // Restart filesystem monitor for createTeam (launch skips it)
    if (!run.isLaunch) {
      updateProgress(run, 'configuring', 'Waiting for team configuration...');
      run.onProgress(run.progress);
      this.startFilesystemMonitor(run, run.request);
    } else {
      updateProgress(
        run,
        'configuring',
        run.deterministicBootstrap
          ? 'CLI running - deterministic launch in progress'
          : 'CLI running - reconnecting with teammates'
      );
      run.onProgress(run.progress);
    }

    // Restart timeout
    run.timeoutHandle = setTimeout(() => {
      if (!run.processKilled && !run.provisioningComplete) {
        run.processKilled = true;
        run.finalizingByTimeout = true;
        void (async () => {
          const readyOnTimeout = await this.tryCompleteAfterTimeout(run);
          killTeamProcess(run.child);
          if (readyOnTimeout) return;

          const hint = run.isLaunch ? ' (launch)' : '';
          const progress = updateProgress(
            run,
            'failed',
            `Timed out waiting for agent runtime${hint}`,
            {
              error: `Timed out waiting for agent runtime${hint}.`,
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          this.cleanupRun(run);
        })();
      }
    }, getProvisioningRunTimeoutMs(run));

    child.once('error', (error) => {
      const hint = run.isLaunch ? ' (launch)' : '';
      const progress = updateProgress(run, 'failed', `Failed to start agent runtime${hint}`, {
        error: error.message,
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
      this.cleanupRun(run);
    });

    child.once('close', (code) => {
      void this.handleProcessExit(run, code);
    });
  }

  /** Attaches the stdout stream-json parser to the current child process. */
  private attachStdoutHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stdout) return;

    let stdoutLineBuf = '';
    child.stdout.on('data', (chunk: Buffer) => {
      // Reset generic data timestamp (used for other purposes, not stall detection).
      run.lastDataReceivedAt = Date.now();

      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stdout', text);
      run.stdoutBuffer += text;
      if (run.stdoutBuffer.length > STDOUT_RING_LIMIT) {
        run.stdoutBuffer = run.stdoutBuffer.slice(run.stdoutBuffer.length - STDOUT_RING_LIMIT);
      }

      // Parse stream-json lines (newline-delimited JSON)
      stdoutLineBuf += text;
      const lines = stdoutLineBuf.split('\n');
      stdoutLineBuf = boundStdoutParserCarry(lines.pop() ?? '');
      this.updateStdoutParserCarry(run, stdoutLineBuf);
      for (const line of lines) {
        const trimmed = line.trim();
        this.handleStdoutParserLine(run, trimmed);
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
  }

  private updateStdoutParserCarry(run: ProvisioningRun, carry: string): void {
    const boundedCarry = boundStdoutParserCarry(carry);
    run.stdoutParserCarry = boundedCarry;
    const trimmedCarry = boundedCarry.trim();
    if (!trimmedCarry) {
      run.stdoutParserCarryIsCompleteJson = false;
      run.stdoutParserCarryLooksLikeClaudeJson = false;
      return;
    }

    try {
      JSON.parse(trimmedCarry);
      run.stdoutParserCarryIsCompleteJson = true;
    } catch {
      run.stdoutParserCarryIsCompleteJson = false;
    }
    run.stdoutParserCarryLooksLikeClaudeJson = looksLikeClaudeStdoutJsonFragment(trimmedCarry);
  }

  private flushStdoutParserCarry(run: ProvisioningRun): void {
    const stdoutParserCarry =
      typeof run.stdoutParserCarry === 'string' ? run.stdoutParserCarry : '';
    const trimmed = stdoutParserCarry.trim();
    if (!trimmed || !run.stdoutParserCarryIsCompleteJson) {
      return;
    }

    logger.warn(
      `[${run.teamName}] Flushing final stream-json stdout carry before process close handling`,
      this.buildStdoutCarryDiagnostic(run)
    );
    this.handleStdoutParserLine(run, trimmed);
    this.updateStdoutParserCarry(run, '');
  }

  private buildStdoutCarryDiagnostic(run: ProvisioningRun): Record<string, unknown> {
    const stdoutParserCarry =
      typeof run.stdoutParserCarry === 'string' ? run.stdoutParserCarry : '';
    const diagnostic: Record<string, unknown> = {
      runId: run.runId,
      stdoutCarryLength: stdoutParserCarry.length,
      stdoutCarryCompleteJson: run.stdoutParserCarryIsCompleteJson === true,
      stdoutCarryLooksLikeClaudeJson: run.stdoutParserCarryLooksLikeClaudeJson === true,
    };

    if (run.stdoutParserCarryIsCompleteJson === true) {
      try {
        const parsed = JSON.parse(stdoutParserCarry.trim()) as Record<string, unknown>;
        diagnostic.messageType = typeof parsed.type === 'string' ? parsed.type : null;
        diagnostic.messageSubtype = typeof parsed.subtype === 'string' ? parsed.subtype : null;
        diagnostic.bootstrapEvent = typeof parsed.event === 'string' ? parsed.event : null;
        diagnostic.sequence = typeof parsed.seq === 'number' ? parsed.seq : null;
      } catch {
        diagnostic.messageType = null;
      }
    }

    return diagnostic;
  }

  private getUnconfirmedBootstrapMemberNames(run: ProvisioningRun): string[] {
    return run.expectedMembers.filter((expected) => {
      const status = run.memberSpawnStatuses.get(expected);
      return status?.bootstrapConfirmed !== true && status?.skippedForLaunch !== true;
    });
  }

  private handleStdoutParserLine(run: ProvisioningRun, trimmed: string): void {
    if (!trimmed) {
      return;
    }

    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      this.handleParsedStdoutJsonMessage(run, msg);
    } catch {
      // Not valid JSON - check for auth failure in raw text output.
      this.handleAuthFailureInOutput(run, trimmed, 'stdout');
      if (hasApiError(trimmed) && !isAuthFailureWarning(trimmed, 'stdout')) {
        // Show warning but do not kill - the SDK may be retrying internally (e.g. 429 model_cooldown).
        // If all retries fail, result.subtype="error" will catch it and kill then.
        this.emitApiErrorWarning(run, trimmed);
      }
    }
  }

  private handleParsedStdoutJsonMessage(run: ProvisioningRun, msg: Record<string, unknown>): void {
    // Only reset stall timer on messages that represent actual API progress
    // (assistant response or result). System messages like retry attempts
    // (type=system, subtype=attempt) are informational - the CLI is still
    // waiting for the API and the user should see the stall warning.
    const msgType = msg.type;
    if (msgType === 'assistant' || msgType === 'result') {
      run.lastStdoutReceivedAt = Date.now();
      if (run.stallWarningIndex != null) {
        const removedIndex = run.stallWarningIndex;
        run.provisioningOutputParts.splice(removedIndex, 1);
        this.shiftProvisioningOutputIndexesAfterRemoval(run, removedIndex);
        run.stallWarningIndex = null;
        if (run.preStallMessage != null) {
          run.progress.message = run.preStallMessage;
          run.preStallMessage = null;
          delete run.progress.messageSeverity;
        }
      }
    }
    this.handleStreamJsonMessage(run, msg);
  }

  /** Attaches the stderr handler with auth failure detection. */
  private attachStderrHandler(run: ProvisioningRun): void {
    const child = run.child;
    if (!child?.stderr) return;

    child.stderr.on('data', (chunk: Buffer) => {
      // Reset stall watchdog FIRST — any data (even partial JSON) means the CLI is alive.
      run.lastDataReceivedAt = Date.now();
      const text = chunk.toString('utf8');
      this.appendCliLogs(run, 'stderr', text);
      run.stderrBuffer += text;
      if (run.stderrBuffer.length > STDERR_RING_LIMIT) {
        run.stderrBuffer = run.stderrBuffer.slice(run.stderrBuffer.length - STDERR_RING_LIMIT);
      }

      // Detect auth failure early instead of waiting for 5-minute timeout
      this.handleAuthFailureInOutput(run, text, 'stderr');
      if (hasApiError(text) && !isAuthFailureWarning(text, 'stderr')) {
        // Show warning but do NOT kill — the SDK may be retrying internally (e.g. 429 model_cooldown).
        // If all retries fail, result.subtype="error" will catch it and kill then.
        this.emitApiErrorWarning(run, text);
      }

      const currentTs = Date.now();
      if (currentTs - run.lastLogProgressAt >= LOG_PROGRESS_THROTTLE_MS) {
        run.lastLogProgressAt = currentTs;
        emitLogsProgress(run);
      }
    });
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
    const existingProvisioningRunId = this.getResolvableProvisioningRunId(request.teamName);
    if (existingProvisioningRunId) {
      return {
        runId: existingProvisioningRunId,
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      };
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
      for (const probe of teamsBasePathsToProbe) {
        const configPath = path.join(probe.basePath, request.teamName, 'config.json');
        if (await this.pathExists(configPath)) {
          const suffix = probe.location === 'configured' ? '' : ` (found under ${probe.basePath})`;
          throw new Error(`Team already exists${suffix}`);
        }
      }

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
      const provisioningEnv = await this.buildProvisioningEnv(
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
        ? this.collectWorkspaceTrustProviders({
            leadProviderId: request.providerId,
            members: request.members,
          })
        : [];
      const workspaceTrustEarlyWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await this.collectWorkspaceTrustWorkspaces({
            cwd: request.cwd,
            members: [],
          })
        : [];
      const workspaceTrustEarlyPlan = workspaceTrustFeatureFlags.enabled
        ? await this.planWorkspaceTrustArgsOnlySafely({
            providers: workspaceTrustProviders,
            workspaces: workspaceTrustEarlyWorkspaces,
            targetSurfaces: ['default_model_probe'],
            featureFlags: workspaceTrustFeatureFlags,
          })
        : { launchArgPatches: [] };
      const workspaceTrustProviderArgsResolver =
        this.createDefaultModelWorkspaceTrustProviderArgsResolver(workspaceTrustEarlyPlan);
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
        await this.buildRuntimeTurnSettledEnvironmentForMembers(
          request.providerId,
          allEffectiveMemberSpecs
        )
      );
      const lanePlan = this.planRuntimeLanesOrThrow(
        request.providerId,
        request.model,
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
      const crossProviderMemberArgs = await this.buildCrossProviderMemberArgs(
        resolvedProviderId,
        effectiveMemberSpecs,
        { teamRuntimeAuth }
      );
      const workspaceTrustFullWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await this.collectWorkspaceTrustWorkspaces({
            cwd: request.cwd,
            members: allEffectiveMemberSpecs,
          })
        : [];
      const workspaceTrustFullPlan = workspaceTrustFeatureFlags.enabled
        ? await this.planWorkspaceTrustFullSafely({
            providers: this.collectWorkspaceTrustProviders({
              leadProviderId: request.providerId,
              members: allEffectiveMemberSpecs,
            }),
            workspaces: workspaceTrustFullWorkspaces,
            featureFlags: workspaceTrustFeatureFlags,
          })
        : null;
      const workspaceTrustPatches = workspaceTrustFullPlan?.launchArgPatches ?? [];
      const providerArgsForLaunch = this.applyWorkspaceTrustArgPatches({
        args: providerArgs,
        patches: workspaceTrustPatches,
        targetProvider: resolvedProviderId,
        targetSurface: 'primary_provider_args',
      });
      const crossProviderArgsForLaunch = crossProviderMemberArgs.providerArgsByProvider.has('codex')
        ? this.applyWorkspaceTrustArgPatches({
            args: crossProviderMemberArgs.args,
            patches: workspaceTrustPatches,
            targetProvider: 'codex',
            targetSurface: 'cross_provider_member_args',
          })
        : crossProviderMemberArgs.args;
      const crossProviderMemberArgsForLaunch = {
        ...crossProviderMemberArgs,
        args: crossProviderArgsForLaunch,
      };
      Object.assign(shellEnv, crossProviderMemberArgs.envPatch);
      if (crossProviderMemberArgs.usesAnthropicApiKeyHelper) {
        for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
          delete shellEnv[key];
        }
      }
      const providerArgsByProvider = new Map<TeamProviderId, string[]>();
      for (const [providerId, args] of new Map<TeamProviderId, string[]>([
        [resolvedProviderId, providerArgsForLaunch],
        ...crossProviderMemberArgs.providerArgsByProvider,
      ])) {
        providerArgsByProvider.set(
          providerId,
          this.applyWorkspaceTrustArgPatches({
            args,
            patches: workspaceTrustPatches,
            targetProvider: providerId,
            targetSurface: 'provider_facts_probe',
          })
        );
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
        emitProvisioningCheckpoint(run, 'Persisting team metadata before spawn');
        const teamDir = path.join(getTeamsBasePath(), request.teamName);
        const tasksDir = path.join(getTasksBasePath(), request.teamName);
        await fs.promises.mkdir(teamDir, { recursive: true });
        await fs.promises.mkdir(tasksDir, { recursive: true });
        await this.teamMetaStore.writeMeta(request.teamName, {
          displayName: request.displayName,
          description: request.description,
          color: request.color,
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
        const membersToWrite = buildMembersMetaWritePayload(allEffectiveMemberSpecs);
        await this.membersMetaStore.writeMembers(request.teamName, membersToWrite, {
          providerBackendId: request.providerBackendId,
        });
        emitProvisioningCheckpoint(
          run,
          'Building deterministic create bootstrap spec',
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
        const bootstrapSpec = buildDeterministicCreateBootstrapSpec(
          runId,
          request,
          effectiveMemberSpecs,
          nativeBootstrapBuild.specs,
          memberMcpLaunchConfigs
        );
        emitProvisioningCheckpoint(run, 'Writing deterministic bootstrap spec file');
        bootstrapSpecPath = await writeDeterministicBootstrapSpecFile(bootstrapSpec);
        run.bootstrapSpecPath = bootstrapSpecPath;
        if (initialUserPrompt) {
          emitProvisioningCheckpoint(
            run,
            'Writing deferred user prompt file',
            `chars=${promptSize.chars} lines=${promptSize.lines}`
          );
          bootstrapUserPromptPath =
            await writeDeterministicBootstrapUserPromptFile(initialUserPrompt);
          run.bootstrapUserPromptPath = bootstrapUserPromptPath;
          run.requiresFirstRealTurnSuccess = true;
        }
        emitProvisioningCheckpoint(run, 'Writing MCP config file');
        mcpConfigPath = await this.mcpConfigBuilder.writeConfigFile(request.cwd, {
          controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
        });
        run.mcpConfigPath = mcpConfigPath;
        emitProvisioningCheckpoint(run, 'Validating agent-teams MCP runtime');
        await this.validateAgentTeamsMcpRuntime(claudePath, request.cwd, shellEnv, mcpConfigPath, {
          isCancelled: () =>
            run.cancelRequested ||
            run.processKilled ||
            this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
        });
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
      const spawnArgs = mergeJsonSettingsArgs([
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user,project,local',
        '--mcp-config',
        mcpConfigPath,
        '--team-bootstrap-spec',
        bootstrapSpecPath,
        ...(bootstrapUserPromptPath
          ? ['--team-bootstrap-user-prompt-file', bootstrapUserPromptPath]
          : []),
        '--disallowedTools',
        APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        // Explicit --permission-mode overrides user's defaultMode in ~/.claude/settings.json
        // (e.g. "acceptEdits") which otherwise takes precedence over CLI flags
        ...(request.skipPermissions !== false
          ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
        ...(launchModelArg ? ['--model', launchModelArg] : []),
        ...(launchIdentity.resolvedEffort ? ['--effort', launchIdentity.resolvedEffort] : []),
        ...runtimeArgsPlan.providerArgs,
        ...runtimeArgsPlan.fastModeArgs,
        ...runtimeArgsPlan.runtimeTurnSettledHookArgs,
        ...(request.worktree ? ['--worktree', request.worktree] : []),
        ...buildDesktopTeammateModeCliArgs(teammateModeDecision),
        ...runtimeArgsPlan.extraArgs,
        ...runtimeArgsPlan.settingsArgs,
        ...runtimeArgsPlan.inheritedProviderArgs,
      ]);
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
          'Spawning agent runtime process',
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

      updateProgress(run, 'spawning', 'Starting agent runtime process', {
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

            const progress = updateProgress(run, 'failed', 'Timed out waiting for agent runtime', {
              error:
                'Timed out waiting for agent runtime. Open the Dashboard, verify the configured providers are ready, and try again.',
              cliLogsTail: extractCliLogsFromRun(run),
            });
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, getProvisioningRunTimeoutMs(run));

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start agent runtime', {
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
      launchRequest.model,
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
    if (isPureOpenCodeMemberLanePlan(lanePlan)) {
      return this.runOpenCodeMemberLaneAggregateLaunch({
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
      launchRequest.model,
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
    if (isPureOpenCodeMemberLanePlan(lanePlan)) {
      return this.runOpenCodeMemberLaneAggregateLaunch({
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

  private createOpenCodeAggregateProvisioningRun(params: {
    runId: string;
    startedAt: string;
    progress: TeamProvisioningProgress;
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
    onProgress: (progress: TeamProvisioningProgress) => void;
  }): ProvisioningRun {
    return {
      runId: params.runId,
      teamName: params.request.teamName,
      startedAt: params.startedAt,
      progress: params.progress,
      stdoutBuffer: '',
      stderrBuffer: '',
      claudeLogLines: [],
      lastClaudeLogStream: null,
      stdoutLogLineBuf: '',
      stderrLogLineBuf: '',
      stdoutParserCarry: '',
      stdoutParserCarryIsCompleteJson: false,
      stdoutParserCarryLooksLikeClaudeJson: false,
      deterministicBootstrapMemberSpawnSeen: false,
      deterministicBootstrapMemberResultSeen: false,
      processKilled: false,
      finalizingByTimeout: false,
      cancelRequested: false,
      teamsBasePathsToProbe: getTeamsBasePathsToProbe(),
      child: null,
      timeoutHandle: null,
      fsMonitorHandle: null,
      onProgress: params.onProgress,
      expectedMembers: params.members.map((member) => member.name),
      request: {
        ...params.request,
        members: params.members,
      } as TeamCreateRequest,
      allEffectiveMembers: params.members,
      effectiveMembers: params.lanePlan.primaryMembers,
      launchIdentity: null,
      mixedSecondaryLanes: this.createMixedSecondaryLaneStates(params.lanePlan),
      lastLogProgressAt: 0,
      lastDataReceivedAt: 0,
      lastStdoutReceivedAt: 0,
      stallCheckHandle: null,
      stallWarningIndex: null,
      preStallMessage: null,
      lastRetryAt: 0,
      apiRetryWarningIndex: null,
      apiErrorWarningEmitted: false,
      fsPhase: 'all_files_found',
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
      deterministicBootstrap: false,
      workspaceTrustPlan: null,
      workspaceTrustExecution: null,
      workspaceTrustDiagnostics: null,
      workspaceTrustRetryAttempted: false,
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
      authFailureRetried: false,
      authRetryInProgress: false,
      leadContextUsage: null,
      spawnContext: null,
      anthropicApiKeyHelper: null,
      pendingApprovals: new Map(),
      processedPermissionRequestIds: new Set(),
      pendingPostCompactReminder: false,
      postCompactReminderInFlight: false,
      suppressPostCompactReminderOutput: false,
      pendingGeminiPostLaunchHydration: false,
      geminiPostLaunchHydrationInFlight: false,
      geminiPostLaunchHydrationSent: false,
      suppressGeminiPostLaunchHydrationOutput: false,
      memberSpawnStatuses: new Map(),
      memberSpawnToolUseIds: new Map(),
      pendingMemberRestarts: new Map(),
      memberSpawnLeadInboxCursorByMember: new Map(),
      lastDeterministicBootstrapSeq: 0,
      lastMemberSpawnAuditAt: 0,
      lastMemberSpawnAuditConfigReadWarningAt: 0,
      lastMemberSpawnAuditMissingWarningAt: new Map(),
    };
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
    let launchResult: TeamRuntimeLaunchResult;
    try {
      launchResult = await params.adapter.launch(launchInput);
    } catch (error) {
      await this.stopUnretainableOpenCodeRuntimeLane({
        adapter: params.adapter,
        runId,
        laneId: 'primary',
        teamName,
        cwd: launchCwd,
        previousLaunchState: params.previousLaunchState,
      });
      throw error;
    }
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
    if (shouldRetainOpenCodeRuntimeLaunch(result)) {
      this.runtimeAdapterRunByTeam.set(teamName, {
        runId,
        providerId: 'opencode',
        cwd: launchCwd,
        members: result.members,
      });
    } else {
      await this.stopUnretainableOpenCodeRuntimeLane({
        adapter: params.adapter,
        runId,
        laneId: 'primary',
        teamName,
        cwd: launchCwd,
        previousLaunchState: params.previousLaunchState,
      });
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
        state: 'degraded',
        diagnostics: result.diagnostics,
      }).catch(() => undefined);
    }
    return result;
  }

  private async stopUnretainableOpenCodeRuntimeLane(params: {
    adapter: TeamLaunchRuntimeAdapter;
    runId: string;
    laneId: string;
    teamName: string;
    cwd: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<void> {
    this.clearOpenCodeRuntimeToolApprovals(params.teamName, {
      runId: params.runId,
      laneId: params.laneId,
      emitDismiss: true,
    });
    try {
      await params.adapter.stop({
        runId: params.runId,
        laneId: params.laneId,
        teamName: params.teamName,
        cwd: params.cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: params.previousLaunchState,
        force: true,
      });
    } catch (error) {
      logger.warn(
        `[${params.teamName}] Failed to clean up unavailable OpenCode lane ${params.laneId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
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

  private async runOpenCodeMemberLaneAggregateLaunch(input: {
    request: TeamCreateRequest | TeamLaunchRequest;
    members: TeamCreateRequest['members'];
    lanePlan: Extract<TeamRuntimeLanePlan, { mode: 'pure_opencode_member_lanes' }>;
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
      message: 'Validating OpenCode member lane launch gate',
      startedAt,
      updatedAt: startedAt,
      warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
    };
    this.provisioningRunByTeam.set(input.request.teamName, runId);
    const initialRuntimeProgress = this.setRuntimeAdapterProgress(
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

    const launching = this.setRuntimeAdapterProgress(
      {
        ...initialRuntimeProgress,
        state: 'spawning',
        message: 'Starting OpenCode member runtime lanes',
        updatedAt: nowIso(),
      },
      input.onProgress
    );
    run.progress = launching;
    const aggregateLaunchNoLongerCurrent = (): boolean =>
      run.cancelRequested ||
      run.processKilled ||
      this.stopAllTeamsGeneration !== stopAllGenerationAtStart ||
      this.provisioningRunByTeam.get(input.request.teamName) !== runId;
    const finishCancelledAggregateLaunch = async (): Promise<TeamLaunchResponse> => {
      run.cancelRequested = true;
      run.processKilled = true;
      await this.stopOpenCodeAggregateRuntimeLanes(input.request.teamName, runId);
      if (this.runs.get(runId) === run) {
        this.cleanupRun(run);
      }
      return { runId };
    };

    try {
      const primaryResult = await this.launchOpenCodeAggregatePrimaryLane({
        run,
        adapter,
        prompt: input.prompt,
        previousLaunchState,
      });
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      for (const lane of run.mixedSecondaryLanes) {
        if (run.cancelRequested || run.processKilled) {
          break;
        }
        await this.launchSingleMixedSecondaryLane(run, lane);
        if (aggregateLaunchNoLongerCurrent()) {
          return await finishCancelledAggregateLaunch();
        }
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
      const retainableResults = [
        primaryResult,
        ...run.mixedSecondaryLanes.map((lane) => lane.result),
      ].filter((result): result is TeamRuntimeLaunchResult => result !== null);
      const partialTeamCanContinue =
        failed && retainableResults.some((result) => hasRetainableOpenCodeRuntimeMember(result));
      const terminalFailure = failed && !partialTeamCanContinue;
      const finalProgress = this.setRuntimeAdapterProgress(
        {
          ...launching,
          state: terminalFailure ? 'failed' : 'ready',
          message: success
            ? 'OpenCode member lanes are ready'
            : pending
              ? 'OpenCode member lanes are waiting for runtime evidence or permissions'
              : partialTeamCanContinue
                ? 'OpenCode team is running with unavailable members'
                : 'OpenCode member lane launch failed readiness gate',
          messageSeverity:
            pending || partialTeamCanContinue ? 'warning' : failed ? 'error' : undefined,
          updatedAt: nowIso(),
          error: terminalFailure
            ? run.mixedSecondaryLanes
                .flatMap((lane) => lane.diagnostics)
                .filter(Boolean)
                .join('\n') || 'OpenCode member lane launch failed'
            : undefined,
          cliLogsTail:
            run.mixedSecondaryLanes.flatMap((lane) => lane.diagnostics).join('\n') || undefined,
          configReady: true,
        },
        input.onProgress
      );
      run.progress = finalProgress;
      if (!terminalFailure) {
        this.setAliveRunId(input.request.teamName, runId);
      } else {
        this.deleteAliveRunId(input.request.teamName);
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
      if (terminalFailure && this.runs.get(runId) === run) {
        this.cleanupRun(run);
      }
      return { runId };
    } catch (error) {
      if (aggregateLaunchNoLongerCurrent()) {
        return await finishCancelledAggregateLaunch();
      }
      await this.stopOpenCodeAggregateRuntimeLanes(input.request.teamName, runId);
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
      const failedProgress = this.setRuntimeAdapterProgress(
        {
          ...launching,
          state: 'failed',
          message: 'OpenCode member lane launch failed',
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
      this.deleteAliveRunId(input.request.teamName);
      this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      if (this.runs.get(runId) === run) {
        this.cleanupRun(run);
      }
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
    this.setRuntimeAdapterProgress(initialProgress, input.onProgress);
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

    const launching = this.setRuntimeAdapterProgress(
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
      const partialTeamCanContinue = failed && shouldRetainOpenCodeRuntimeLaunch(result);
      const terminalFailure = failed && !partialTeamCanContinue;
      const finalProgress = this.setRuntimeAdapterProgress(
        {
          ...launching,
          state: terminalFailure ? 'failed' : 'ready',
          message: success
            ? 'OpenCode team launch is ready'
            : pending
              ? 'OpenCode team launch is waiting for runtime evidence or permissions'
              : partialTeamCanContinue
                ? 'OpenCode team is running with unavailable members'
                : 'OpenCode team launch failed readiness gate',
          messageSeverity:
            pending || partialTeamCanContinue ? 'warning' : terminalFailure ? 'error' : undefined,
          updatedAt: nowIso(),
          warnings: result.warnings.length > 0 ? result.warnings : launching.warnings,
          error: terminalFailure
            ? result.diagnostics.join('\n') || 'OpenCode launch failed'
            : undefined,
          cliLogsTail: result.diagnostics.join('\n') || undefined,
          configReady: true,
        },
        input.onProgress
      );
      if (terminalFailure) {
        await clearOpenCodeRuntimeLaneStorage({
          teamsBasePath: getTeamsBasePath(),
          teamName: input.request.teamName,
          laneId: 'primary',
        }).catch(() => undefined);
        this.runtimeAdapterRunByTeam.delete(input.request.teamName);
        this.deleteAliveRunId(input.request.teamName);
        this.invalidateRuntimeSnapshotCaches(input.request.teamName);
      } else {
        this.runtimeAdapterRunByTeam.set(input.request.teamName, {
          runId,
          providerId: 'opencode',
          cwd: launchCwd,
          members: result.members,
        });
        this.setAliveRunId(input.request.teamName, runId);
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
      this.setRuntimeAdapterProgress(
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
    const normalizedResult = normalizeExpectedOpenCodeRuntimeLaunchMembers(
      committedResult,
      input.expectedMembers
    );
    const members: Record<string, PersistedTeamLaunchMemberState> = {};
    for (const member of input.expectedMembers) {
      const evidence = normalizedResult.members[member.name];
      members[member.name] = this.toOpenCodePersistedLaunchMember(
        member,
        evidence,
        normalizedResult.runId
      );
    }
    const snapshot = createPersistedLaunchSnapshot({
      teamName: input.teamName,
      expectedMembers: input.expectedMembers.map((member) => member.name),
      bootstrapExpectedMembers: input.expectedMembers.map((member) => member.name),
      includeLeadMembers: true,
      leadSessionId: result.leadSessionId,
      launchPhase: normalizedResult.launchPhase,
      members,
    });
    return {
      snapshot: await this.writeLaunchStateSnapshot(input.teamName, snapshot),
      result: normalizedResult,
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
    const existingProvisioningRunId = this.getResolvableProvisioningRunId(request.teamName);
    if (existingProvisioningRunId) {
      return {
        runId: existingProvisioningRunId,
        launchStatus: 'already_launching',
        alreadyLaunching: true,
      };
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
      let configProjectPath: string | null = null;
      try {
        const parsedConfig = JSON.parse(configRaw) as { projectPath?: unknown };
        configProjectPath =
          typeof parsedConfig.projectPath === 'string' && parsedConfig.projectPath.trim().length > 0
            ? path.resolve(parsedConfig.projectPath.trim())
            : null;
      } catch {
        configProjectPath = null;
      }

      const existingAliveRunId = this.getAliveRunId(request.teamName);
      if (existingAliveRunId) {
        const existingRun = this.runs.get(existingAliveRunId);
        const requestedCwd = path.resolve(request.cwd);
        const existingRunCwd = this.getRunTrackedCwd(existingRun) ?? configProjectPath;
        if (existingRun?.child && !existingRun.processKilled && !existingRun.cancelRequested) {
          if (!existingRunCwd) {
            this.provisioningRunByTeam.delete(request.teamName);
            throw new Error(
              `Team "${request.teamName}" is already running, but its cwd could not be determined. ` +
                'Stop it before launching again.'
            );
          }
          if (existingRunCwd && existingRunCwd !== requestedCwd) {
            this.provisioningRunByTeam.delete(request.teamName);
            throw new Error(
              `Team "${request.teamName}" is already running in "${existingRunCwd}". ` +
                `Stop it before launching with cwd "${request.cwd}".`
            );
          }
          this.provisioningRunByTeam.delete(request.teamName);
          return {
            runId: existingAliveRunId,
            launchStatus: 'already_running',
            alreadyRunning: true,
          };
        }
      }

      const launchCompatibility = await this.probeLaunchCompatibility(
        request.teamName,
        configRaw,
        request.providerId
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
      } = this.resolveLaunchExpectedMembersFromCompatibility(launchCompatibility);
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

      const provisioningEnv = await this.buildProvisioningEnv(
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
        ? this.collectWorkspaceTrustProviders({
            leadProviderId: request.providerId,
            members: expectedMemberSpecs,
          })
        : [];
      const workspaceTrustEarlyWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await this.collectWorkspaceTrustWorkspaces({
            cwd: request.cwd,
            members: [],
          })
        : [];
      const workspaceTrustEarlyPlan = workspaceTrustFeatureFlags.enabled
        ? await this.planWorkspaceTrustArgsOnlySafely({
            providers: workspaceTrustProviders,
            workspaces: workspaceTrustEarlyWorkspaces,
            targetSurfaces: ['default_model_probe'],
            featureFlags: workspaceTrustFeatureFlags,
          })
        : { launchArgPatches: [] };
      const workspaceTrustProviderArgsResolver =
        this.createDefaultModelWorkspaceTrustProviderArgsResolver(workspaceTrustEarlyPlan);

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
        await this.buildRuntimeTurnSettledEnvironmentForMembers(
          request.providerId,
          allEffectiveMemberSpecs
        )
      );
      const lanePlan = this.planRuntimeLanesOrThrow(
        request.providerId,
        request.model,
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
      const crossProviderMemberArgs = await this.buildCrossProviderMemberArgs(
        resolvedProviderId,
        effectiveMemberSpecs,
        { teamRuntimeAuth }
      );
      const workspaceTrustFullWorkspaces = workspaceTrustFeatureFlags.enabled
        ? await this.collectWorkspaceTrustWorkspaces({
            cwd: request.cwd,
            members: allEffectiveMemberSpecs,
          })
        : [];
      const workspaceTrustFullPlan = workspaceTrustFeatureFlags.enabled
        ? await this.planWorkspaceTrustFullSafely({
            providers: this.collectWorkspaceTrustProviders({
              leadProviderId: request.providerId,
              members: allEffectiveMemberSpecs,
            }),
            workspaces: workspaceTrustFullWorkspaces,
            featureFlags: workspaceTrustFeatureFlags,
          })
        : null;
      const workspaceTrustPatches = workspaceTrustFullPlan?.launchArgPatches ?? [];
      const providerArgsForLaunch = this.applyWorkspaceTrustArgPatches({
        args: providerArgs,
        patches: workspaceTrustPatches,
        targetProvider: resolvedProviderId,
        targetSurface: 'primary_provider_args',
      });
      const crossProviderArgsForLaunch = crossProviderMemberArgs.providerArgsByProvider.has('codex')
        ? this.applyWorkspaceTrustArgPatches({
            args: crossProviderMemberArgs.args,
            patches: workspaceTrustPatches,
            targetProvider: 'codex',
            targetSurface: 'cross_provider_member_args',
          })
        : crossProviderMemberArgs.args;
      const crossProviderMemberArgsForLaunch = {
        ...crossProviderMemberArgs,
        args: crossProviderArgsForLaunch,
      };
      Object.assign(shellEnv, crossProviderMemberArgs.envPatch);
      if (crossProviderMemberArgs.usesAnthropicApiKeyHelper) {
        for (const key of ANTHROPIC_HELPER_MODE_COMPETING_AUTH_ENV_KEYS) {
          delete shellEnv[key];
        }
      }
      const providerArgsByProvider = new Map<TeamProviderId, string[]>();
      for (const [providerId, args] of new Map<TeamProviderId, string[]>([
        [resolvedProviderId, providerArgsForLaunch],
        ...crossProviderMemberArgs.providerArgsByProvider,
      ])) {
        providerArgsByProvider.set(
          providerId,
          this.applyWorkspaceTrustArgPatches({
            args,
            patches: workspaceTrustPatches,
            targetProvider: providerId,
            targetSurface: 'provider_facts_probe',
          })
        );
      }
      const launchIdentity = await this.resolveAndValidateLaunchIdentity({
        claudePath,
        cwd: request.cwd,
        env: shellEnv,
        request,
        effectiveMembers: effectiveMemberSpecs,
        providerArgsByProvider,
      });

      // Build a synthetic TeamCreateRequest for reuse by shared infrastructure
      const syntheticRequest: TeamCreateRequest = {
        teamName: request.teamName,
        members: allEffectiveMemberSpecs,
        cwd: request.cwd,
        providerId: request.providerId,
        providerBackendId: request.providerBackendId,
        model: request.model,
        effort: request.effort,
        fastMode: request.fastMode,
        skipPermissions: request.skipPermissions,
      };

      // Enrich with color/displayName from config.json (always available for launched teams)
      try {
        const cfg = JSON.parse(configRaw) as Record<string, unknown>;
        if (typeof cfg.color === 'string' && cfg.color.trim().length > 0) {
          syntheticRequest.color = cfg.color.trim();
        }
        if (typeof cfg.name === 'string' && cfg.name.trim().length > 0) {
          syntheticRequest.displayName = cfg.name.trim();
        }
      } catch {
        // config already validated above — ignore parse errors here
      }

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
          message:
            source === 'members-meta'
              ? 'Validating team launch request (members from members.meta.json)'
              : source === 'inboxes'
                ? 'Validating team launch request (members from inboxes)'
                : 'Validating team launch request (fallback members from config.json)',
          startedAt,
          updatedAt: startedAt,
          warnings: initialLaunchWarnings.length > 0 ? initialLaunchWarnings : undefined,
          cliLogsTail: undefined,
        },
      };

      this.resetTeamScopedTransientStateForNewRun(request.teamName);
      this.runs.set(runId, run);
      this.provisioningRunByTeam.set(request.teamName, runId);
      initializeProvisioningTrace(run);
      run.onProgress(run.progress);
      await this.prepareWorkspaceTrustForDeterministicRun({
        mode: 'launch',
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
      emitProvisioningCheckpoint(run, 'Publishing mixed secondary lane status');
      for (const lane of run.mixedSecondaryLanes ?? []) {
        await this.publishMixedSecondaryLaneStatusChange(run, lane);
      }

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
        await this.validateAgentTeamsMcpRuntime(claudePath, request.cwd, shellEnv, mcpConfigPath, {
          isCancelled: () =>
            run.cancelRequested ||
            run.processKilled ||
            this.stopAllTeamsGeneration !== stopAllGenerationAtStart,
        });
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
      const launchArgs = [
        '--print',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--setting-sources',
        'user,project,local',
        '--mcp-config',
        mcpConfigPath,
        '--team-bootstrap-spec',
        bootstrapSpecPath,
        ...(bootstrapUserPromptPath
          ? ['--team-bootstrap-user-prompt-file', bootstrapUserPromptPath]
          : []),
        '--disallowedTools',
        APP_TEAM_RUNTIME_DISALLOWED_TOOLS,
        // Explicit --permission-mode overrides user's defaultMode in ~/.claude/settings.json
        // (e.g. "acceptEdits") which otherwise takes precedence over CLI flags
        ...(request.skipPermissions !== false
          ? ['--dangerously-skip-permissions', '--permission-mode', 'bypassPermissions']
          : ['--permission-prompt-tool', 'stdio', '--permission-mode', 'default']),
      ];
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
        contextLabel: 'Team launch',
      });
      if (launchModelArg) {
        launchArgs.push('--model', launchModelArg);
      }
      if (launchIdentity.resolvedEffort) {
        launchArgs.push('--effort', launchIdentity.resolvedEffort);
      }
      launchArgs.push(...runtimeArgsPlan.providerArgs);
      launchArgs.push(...runtimeArgsPlan.fastModeArgs);
      launchArgs.push(...runtimeArgsPlan.runtimeTurnSettledHookArgs);
      if (request.worktree) {
        launchArgs.push('--worktree', request.worktree);
      }
      launchArgs.push(...buildDesktopTeammateModeCliArgs(teammateModeDecision));
      launchArgs.push(...runtimeArgsPlan.extraArgs);
      launchArgs.push(...runtimeArgsPlan.settingsArgs);
      // When the lead uses a different provider than some teammates (e.g., anthropic lead
      // with codex teammates), the lead needs the teammate provider's launch args so they
      // can be inherited by the teammate subprocess via buildInheritedCliFlags.
      // Without this, a codex teammate spawned from an anthropic lead has no way to learn
      // about the required forced_login_method (chatgpt/api) and fails to start.
      emitProvisioningCheckpoint(run, 'Resolving cross-provider member launch args');
      launchArgs.push(...runtimeArgsPlan.inheritedProviderArgs);
      const finalLaunchArgs = mergeJsonSettingsArgs(launchArgs);
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
      const existingMeta = await this.membersMetaStore.getMeta(request.teamName);
      await this.membersMetaStore.writeMembers(
        request.teamName,
        mergeMembersMetaForLaunch(
          buildMembersMetaWritePayload(allEffectiveMemberSpecs),
          existingMeta?.members ?? []
        ),
        { providerBackendId: request.providerBackendId }
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
          'Spawning agent runtime process for team launch',
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

      updateProgress(run, 'spawning', 'Starting agent runtime process for team launch', {
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

            const progress = updateProgress(
              run,
              'failed',
              'Timed out waiting for agent runtime (launch)',
              {
                error: 'Timed out waiting for agent runtime during team launch.',
                cliLogsTail: extractCliLogsFromRun(run),
              }
            );
            run.onProgress(progress);
            this.cleanupRun(run);
          })();
        }
      }, getProvisioningRunTimeoutMs(run));

      child.once('error', (error) => {
        const progress = updateProgress(run, 'failed', 'Failed to start agent runtime (launch)', {
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
    const run = this.runs.get(runId);
    if (run) {
      return run.progress;
    }
    const runtimeProgress = this.runtimeAdapterProgressByRunId.get(runId);
    if (runtimeProgress) {
      return runtimeProgress;
    }
    const retainedProgress = this.getRetainedProvisioningProgressMap().get(runId);
    if (retainedProgress) {
      return retainedProgress;
    }
    throw new Error('Unknown runId');
  }

  private getRetainedProvisioningProgressMap(): Map<string, TeamProvisioningProgress> {
    this.retainedProvisioningProgressByRunId ??= new Map<string, TeamProvisioningProgress>();
    return this.retainedProvisioningProgressByRunId;
  }

  private getRetainedProvisioningProgressTimersMap(): Map<string, ReturnType<typeof setTimeout>> {
    this.retainedProvisioningProgressTimersByRunId ??= new Map<
      string,
      ReturnType<typeof setTimeout>
    >();
    return this.retainedProvisioningProgressTimersByRunId;
  }

  private retainProvisioningProgress(runId: string, progress: TeamProvisioningProgress): void {
    const retainedProgress = this.getRetainedProvisioningProgressMap();
    const retainedTimers = this.getRetainedProvisioningProgressTimersMap();
    const previousTimer = retainedTimers.get(runId);
    if (previousTimer) {
      clearTimeout(previousTimer);
    }

    retainedProgress.set(runId, {
      ...progress,
      warnings: progress.warnings ? [...progress.warnings] : undefined,
      launchDiagnostics: progress.launchDiagnostics ? [...progress.launchDiagnostics] : undefined,
    });

    const timer = setTimeout(() => {
      retainedProgress.delete(runId);
      retainedTimers.delete(runId);
      // Adapter-run live progress and trace history share the retention
      // window (native run ids are simply absent from these maps). Only a
      // still-terminal entry may be dropped — a relaunch may have reused the
      // run id for a live run in the meantime.
      const liveProgress = this.runtimeAdapterProgressByRunId.get(runId);
      if (liveProgress && ['disconnected', 'failed', 'cancelled'].includes(liveProgress.state)) {
        this.runtimeAdapterProgressByRunId.delete(runId);
        this.runtimeAdapterTraceLinesByRunId.delete(runId);
        this.runtimeAdapterTraceKeyByRunId.delete(runId);
      }
    }, TeamProvisioningService.RETAINED_PROVISIONING_PROGRESS_TTL_MS);
    timer.unref?.();
    retainedTimers.set(runId, timer);
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
    if (this.getTrackedRunId(run.teamName) === run.runId) {
      void this.stopOpenCodeAggregateRuntimeLanes(run.teamName, run.runId);
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
    this.deleteAliveRunId(teamName);
    if (this.provisioningRunByTeam.get(teamName) === runId) {
      this.provisioningRunByTeam.delete(teamName);
    }
    this.invalidateRuntimeSnapshotCaches(teamName);
    this.setRuntimeAdapterProgress({
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

  private getPendingRuntimeAdapterLaunchesForShutdown(): TeamProvisioningProgress[] {
    return Array.from(this.runtimeAdapterProgressByRunId.values()).filter((progress) =>
      this.isCancellableRuntimeAdapterProgress(progress)
    );
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
      this.deleteAliveRunId(teamName);
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
    this.deleteAliveRunId(teamName);
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
    this.setRuntimeAdapterProgress(progress, onProgress);
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
    const runId = this.getAliveRunId(teamName);
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
    const runId = this.getAliveRunId(teamName);
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

    this.armSilentTeammateForward(run, teammateName, 'user_dm');

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
    if (
      this.isCrossTeamPseudoRecipientName(memberName) ||
      this.isCrossTeamToolRecipientName(memberName)
    ) {
      return 0;
    }
    const relayKey = this.getMemberRelayKey(teamName, memberName);
    const existing = this.memberInboxRelayInFlight.get(relayKey);
    if (existing) {
      try {
        return await this.waitForInboxRelayInFlight({
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
      const runId = this.getAliveRunId(teamName);
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

      this.armSilentTeammateForward(run, memberName, 'member_inbox_relay');
      const rememberedRelayIds = this.rememberPendingInboxRelayCandidates(run, memberName, batch);

      const message = buildMemberInboxRelayPrompt({ memberName, batch });

      try {
        await this.sendMessageToRun(run, message);
      } catch {
        this.forgetPendingInboxRelayCandidates(run, memberName, rememberedRelayIds);
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
      return await this.waitForInboxRelayInFlight({
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
    if (
      this.isCrossTeamPseudoRecipientName(inboxName) ||
      this.isCrossTeamToolRecipientName(inboxName)
    ) {
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
          return await this.waitForInboxRelayInFlight({
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
          return {
            relayed: 0,
            attempted: 0,
            delivered: 0,
            failed: 1,
            lastDelivery: {
              delivered: false,
              accepted: false,
              responsePending: false,
              reason: 'opencode_member_inbox_relay_timed_out',
              diagnostics: [diagnostic],
            },
            diagnostics: [diagnostic],
          };
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
          const diagnostic = `opencode_work_sync_read_commit_waiting_for_active_relay: ${onlyMessageId}`;
          return {
            relayed: 0,
            attempted: 1,
            delivered: 0,
            failed: 0,
            lastDelivery: {
              delivered: true,
              accepted: false,
              responsePending: true,
              reason: 'opencode_work_sync_read_commit_waiting_for_active_relay',
              diagnostics: [diagnostic],
            },
            diagnostics: [diagnostic],
          };
        }
        return {
          relayed: 0,
          attempted: 1,
          delivered: 1,
          failed: 0,
          lastDelivery: { delivered: true },
        };
      }
      if (!targetMessage) {
        const diagnostic = `opencode_inbox_message_missing_after_inflight_relay: ${onlyMessageId}`;
        return {
          relayed: 0,
          attempted: 1,
          delivered: 0,
          failed: 1,
          lastDelivery: {
            delivered: false,
            reason: 'opencode_inbox_message_missing_after_inflight_relay',
            diagnostics: [diagnostic],
          },
          diagnostics: [diagnostic],
        };
      }

      const diagnostic = `opencode_inbox_relay_queued_behind_active_relay: ${relayKey}/${onlyMessageId}`;
      this.scheduleOpenCodeMemberInboxDeliveryWake({
        teamName,
        memberName,
        messageId: onlyMessageId,
        delayMs: 500,
      });
      return {
        relayed: 0,
        attempted: 1,
        delivered: 0,
        failed: 0,
        lastDelivery: {
          delivered: true,
          accepted: false,
          responsePending: true,
          queuedBehindMessageId: onlyMessageId,
          reason: 'opencode_inbox_relay_queued_behind_active_relay',
          diagnostics: [diagnostic],
        },
        diagnostics: [diagnostic],
      };
    }

    const work = (async (): Promise<OpenCodeMemberInboxRelayResult> => {
      const result: OpenCodeMemberInboxRelayResult = {
        relayed: 0,
        attempted: 0,
        delivered: 0,
        failed: 0,
      };
      if (!(await this.isOpenCodeRuntimeRecipient(teamName, memberName))) {
        result.lastDelivery = { delivered: false, reason: 'recipient_is_not_opencode' };
        return result;
      }
      const memberIdentity = await this.resolveOpenCodeMemberDeliveryIdentity(teamName, memberName);
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
        result.lastDelivery = {
          delivered: false,
          reason: 'opencode_inbox_read_failed',
          diagnostics: [diagnostic],
        };
        result.diagnostics = [diagnostic];
        return result;
      }

      const onlyMessageId = options.onlyMessageId?.trim();
      if (onlyMessageId) {
        const targetMessage = inboxMessages.find((message) => message.messageId === onlyMessageId);
        if (targetMessage?.read && targetMessage.messageKind !== 'member_work_sync_nudge') {
          return {
            relayed: 0,
            attempted: 1,
            delivered: 1,
            failed: 0,
            lastDelivery: { delivered: true },
          };
        }
        if (!targetMessage) {
          const diagnostic = `opencode_inbox_message_missing: ${onlyMessageId}`;
          return {
            relayed: 0,
            attempted: 1,
            delivered: 0,
            failed: 1,
            lastDelivery: {
              delivered: false,
              reason: 'opencode_inbox_message_missing',
              diagnostics: [diagnostic],
            },
            diagnostics: [diagnostic],
          };
        }
      }
      const unread = selectOpenCodeInboxRelayBatch(
        inboxMessages.filter((message): message is InboxMessage & { messageId: string } => {
          if (onlyMessageId && message.messageId !== onlyMessageId) return false;
          if (
            message.read &&
            (!onlyMessageId || message.messageKind !== 'member_work_sync_nudge')
          ) {
            return false;
          }
          if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
          return hasStableInboxMessageId(message);
        }),
        DEFAULT_INBOX_RELAY_BATCH_SIZE
      );

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
        const fallbackReplyRecipient =
          typeof message.from === 'string' &&
          message.from.trim() &&
          message.from.trim().toLowerCase() !== memberName.trim().toLowerCase()
            ? message.from.trim()
            : 'user';
        const effectiveReplyRecipient =
          existingRecord?.replyRecipient ??
          options.deliveryMetadata?.replyRecipient ??
          fallbackReplyRecipient;
        const effectiveActionMode =
          existingRecord?.actionMode ??
          options.deliveryMetadata?.actionMode ??
          message.actionMode ??
          null;
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
        const effectiveTaskRefs =
          existingTaskRefs ?? metadataTaskRefs ?? messageTaskRefs ?? inferredTaskRefs;
        const effectiveSource = existingRecord?.source ?? options.source ?? 'watcher';
        result.attempted += 1;
        const attachmentPayloads = await this.resolveOpenCodeInboxAttachmentPayloads({
          teamName,
          message,
        });
        if (!attachmentPayloads.ok) {
          let failedRecord: OpenCodePromptDeliveryLedgerRecord | null = null;
          try {
            const markedAt = nowIso();
            const pendingRecord =
              existingRecord ??
              (await promptLedger.ensurePending({
                teamName,
                memberName: memberIdentity.canonicalMemberName,
                laneId: memberIdentity.laneId,
                runId: await this.resolveCurrentOpenCodeRuntimeRunId(
                  teamName,
                  memberIdentity.laneId
                ),
                inboxMessageId: message.messageId,
                inboxTimestamp: message.timestamp,
                source: effectiveSource,
                replyRecipient: effectiveReplyRecipient,
                actionMode: effectiveActionMode ?? null,
                messageKind: message.messageKind ?? null,
                workSyncIntent: message.workSyncIntent ?? null,
                taskRefs: effectiveTaskRefs,
                payloadHash: hashOpenCodePromptDeliveryPayload({
                  text: message.text,
                  replyRecipient: effectiveReplyRecipient,
                  actionMode: effectiveActionMode ?? null,
                  taskRefs: effectiveTaskRefs,
                  attachments: message.attachments,
                  source: effectiveSource,
                }),
                now: markedAt,
              }));
            if (pendingRecord.createdAt === markedAt) {
              this.logOpenCodePromptDeliveryEvent(
                'opencode_prompt_delivery_ledger_created',
                pendingRecord
              );
            }
            failedRecord = await this.markOpenCodePromptLedgerFailedTerminal({
              ledger: promptLedger,
              id: pendingRecord.id,
              reason: attachmentPayloads.reason,
              diagnostics: attachmentPayloads.diagnostics,
              failedAt: nowIso(),
              eventContext: { attachmentPayloadUnavailable: true },
            });
          } catch (error) {
            const diagnostic = `opencode_inbox_attachment_terminal_ledger_failed: ${getErrorMessage(
              error
            )}`;
            result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
          }
          result.failed += 1;
          result.diagnostics = [...(result.diagnostics ?? []), ...attachmentPayloads.diagnostics];
          result.lastDelivery = {
            delivered: false,
            reason: attachmentPayloads.reason,
            accepted: false,
            ledgerStatus: failedRecord?.status,
            ledgerRecordId: failedRecord?.id,
            laneId: memberIdentity.laneId,
            diagnostics: attachmentPayloads.diagnostics,
          };
          break;
        }
        const delivery = await this.deliverOpenCodeMemberMessage(teamName, {
          memberName,
          text: message.text,
          messageId: message.messageId,
          replyRecipient: effectiveReplyRecipient,
          actionMode: effectiveActionMode ?? undefined,
          messageKind: message.messageKind,
          workSyncIntent: message.workSyncIntent,
          workSyncReviewRequestEventIds: message.workSyncReviewRequestEventIds,
          taskRefs: effectiveTaskRefs,
          attachments: attachmentPayloads.attachments,
          source: effectiveSource,
          inboxTimestamp: message.timestamp,
        });
        result.lastDelivery = delivery;
        if (!delivery.delivered) {
          if (delivery.accepted === true) {
            const diagnostics = delivery.diagnostics ?? [
              delivery.reason ?? 'opencode_delivery_response_pending',
            ];
            result.diagnostics = [...(result.diagnostics ?? []), ...diagnostics];
            result.lastDelivery = {
              ...delivery,
              diagnostics,
            };
            break;
          }
          result.failed += 1;
          result.diagnostics = [
            ...(result.diagnostics ?? []),
            ...(delivery.diagnostics ?? [delivery.reason ?? 'opencode_message_delivery_failed']),
          ];
          if (
            !isOpenCodeAttachmentDeliveryFailureReason(delivery.reason) &&
            (delivery.reason !== 'opencode_runtime_not_active' ||
              !this.cleanedStoppedTeamOpenCodeRuntimeLanes.has(teamName))
          ) {
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
        try {
          await this.markInboxMessagesRead(teamName, memberName, [message]);
          if (delivery.ledgerRecordId && delivery.laneId) {
            const committed = await this.createOpenCodePromptDeliveryLedger(
              teamName,
              delivery.laneId
            ).markInboxReadCommitted({
              id: delivery.ledgerRecordId,
              committedAt: nowIso(),
            });
            this.logOpenCodePromptDeliveryEvent(
              'opencode_prompt_delivery_inbox_committed_read',
              committed
            );
          }
        } catch (error) {
          const diagnostic = `opencode_inbox_mark_read_failed_after_delivery: ${getErrorMessage(
            error
          )}`;
          if (delivery.ledgerRecordId && delivery.laneId) {
            const failedCommit = await this.createOpenCodePromptDeliveryLedger(
              teamName,
              delivery.laneId
            ).markInboxReadCommitFailed({
              id: delivery.ledgerRecordId,
              error: diagnostic,
              failedAt: nowIso(),
            });
            this.logOpenCodePromptDeliveryEvent(
              'opencode_prompt_delivery_response_observed',
              failedCommit,
              { inboxReadCommitError: diagnostic }
            );
          }
          result.failed += 1;
          result.lastDelivery = {
            delivered: false,
            reason: 'opencode_inbox_mark_read_failed_after_delivery',
            diagnostics: [diagnostic],
          };
          result.diagnostics = [...(result.diagnostics ?? []), diagnostic];
          logger.warn(`[${teamName}] ${diagnostic}`);
          break;
        }
        result.delivered += 1;
        result.relayed += 1;
        break;
      }

      if (result.diagnostics?.length) {
        result.diagnostics = [...new Set(result.diagnostics)];
      }
      return result;
    })();

    this.openCodeMemberInboxRelayInFlight.set(relayKey, work);
    try {
      return await this.waitForInboxRelayInFlight({
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
      return {
        relayed: 0,
        attempted: options.onlyMessageId ? 1 : 0,
        delivered: 0,
        failed: 1,
        lastDelivery: {
          delivered: false,
          accepted: false,
          responsePending: false,
          reason: 'opencode_member_inbox_relay_timed_out',
          diagnostics: [diagnostic],
        },
        diagnostics: [diagnostic],
      };
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
    const bypassMessageIds = new Set<string>();
    if (input.workSyncIntent !== 'agenda_sync') {
      return bypassMessageIds;
    }

    const expectedRefs = normalizeOpenCodeTaskRefsForComparisonValue(input.taskRefs);
    if (expectedRefs.length === 0) {
      return bypassMessageIds;
    }

    const candidateMessages = input.foregroundMessages.filter(
      (message): message is InboxMessage & { messageId: string } => {
        if (!hasStableInboxMessageId(message)) {
          return false;
        }
        if (typeof message.text !== 'string' || message.text.trim().length === 0) {
          return false;
        }
        if (Array.isArray(message.attachments) && message.attachments.length > 0) {
          return false;
        }
        return true;
      }
    );
    if (candidateMessages.length === 0) {
      return bypassMessageIds;
    }

    const identity = await this.resolveOpenCodeMemberDeliveryIdentity(
      input.teamName,
      input.memberName
    ).catch(() => null);
    if (!identity?.ok) {
      return bypassMessageIds;
    }

    const laneIndex = await readOpenCodeRuntimeLaneIndex(getTeamsBasePath(), input.teamName).catch(
      () => null
    );
    if (!laneIndex) {
      return bypassMessageIds;
    }
    const laneActive =
      laneIndex.lanes[identity.laneId]?.state === 'active' ||
      (await this.tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive({
        teamName: input.teamName,
        memberName: identity.canonicalMemberName,
        laneId: identity.laneId,
      }).catch(() => false));
    if (!laneActive) {
      return bypassMessageIds;
    }

    const records = await this.createOpenCodePromptDeliveryLedger(input.teamName, identity.laneId)
      .list()
      .catch(() => null);
    const proofMissingRecords = (records ?? []).filter(
      (record) =>
        record.teamName.trim().toLowerCase() === input.teamName.trim().toLowerCase() &&
        record.memberName.trim().toLowerCase() ===
          identity.canonicalMemberName.trim().toLowerCase() &&
        record.laneId === identity.laneId &&
        record.status === 'failed_terminal' &&
        !record.inboxReadCommittedAt &&
        openCodeTaskRefsOverlap(record.taskRefs, expectedRefs) &&
        isOpenCodeProtocolProofMissingRecord(record)
    );
    if (proofMissingRecords.length === 0) {
      return bypassMessageIds;
    }

    const proofMissingMessageIds = new Set(
      proofMissingRecords.map((record) => record.inboxMessageId.trim()).filter(Boolean)
    );
    for (const message of candidateMessages) {
      const messageId = message.messageId.trim();
      if (proofMissingMessageIds.has(messageId)) {
        bypassMessageIds.add(messageId);
      }
    }

    return bypassMessageIds;
  }

  private async hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean> {
    const checker = this.memberWorkSyncAcceptedReportChecker;
    if (!checker) {
      return false;
    }

    try {
      return (
        (await checker({
          teamName: input.teamName,
          memberName: input.memberName,
        })) === true
      );
    } catch (error) {
      logger.warn(
        `[${input.teamName}] Failed to check accepted work sync report for ${input.memberName}: ${getErrorMessage(error)}`
      );
      return false;
    }
  }

  private async hasAcceptedLeadWorkSyncReport(input: {
    teamName: string;
    leadName: string;
  }): Promise<boolean> {
    return this.hasAcceptedMemberWorkSyncReport({
      teamName: input.teamName,
      memberName: input.leadName,
    });
  }

  private async scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean> {
    const scheduler = this.memberWorkSyncProofMissingRecoveryScheduler;
    if (!scheduler) {
      return false;
    }

    try {
      const result = (await scheduler({
        teamName: input.teamName,
        memberName: input.leadName,
        originalMessageId: input.message.messageId,
        taskRefs: input.message.taskRefs,
        reason: 'lead_member_work_sync_report_required',
      })) as { scheduled?: boolean; reason?: string } | null | undefined;
      return result?.scheduled === true || result?.reason === 'coalesced_recent';
    } catch (error) {
      logger.warn(
        `[${input.teamName}] Failed to schedule lead proof-missing work sync recovery for ${input.leadName}: ${getErrorMessage(error)}`
      );
      return false;
    }
  }

  async relayLeadInboxMessages(teamName: string): Promise<number> {
    const existing = this.leadInboxRelayInFlight.get(teamName);
    if (existing) {
      try {
        return await this.waitForInboxRelayInFlight({
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
      const runId = this.getAliveRunId(teamName) ?? this.getProvisioningRunId(teamName);
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
        try {
          const leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
          if (isStaleRelayRun()) return 0;
          const permMsgsToMarkRead: { messageId: string }[] = [];
          const runStartedAtMs = Date.parse(run.startedAt);
          for (const msg of leadInboxMessages) {
            if (typeof msg.text !== 'string') continue;
            const perm = parsePermissionRequest(msg.text);
            if (!perm) continue;
            // Skip permission_requests from previous runs — they're stale
            const msgTs = Date.parse(msg.timestamp);
            if (
              Number.isFinite(msgTs) &&
              Number.isFinite(runStartedAtMs) &&
              msgTs < runStartedAtMs
            ) {
              continue;
            }
            // Dedup is handled inside handleTeammatePermissionRequest via processedPermissionRequestIds
            this.handleTeammatePermissionRequest(run, perm, msg.timestamp);
            // Mark unread permission_request messages as read to prevent stale unread indicators
            if (!msg.read && hasStableInboxMessageId(msg)) {
              permMsgsToMarkRead.push({ messageId: msg.messageId });
            }
          }
          if (permMsgsToMarkRead.length > 0) {
            await this.markInboxMessagesRead(teamName, leadName, permMsgsToMarkRead).catch(
              () => {}
            );
          }
        } catch {
          // best-effort — inbox may not exist yet
        }
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

      const latestOutboundByConversation = new Map<string, number>();
      const latestReadInboundByConversation = new Map<string, number>();
      for (const message of leadInboxMessages) {
        const timestampMs = Date.parse(message.timestamp);
        if (!Number.isFinite(timestampMs)) continue;
        if (message.source === CROSS_TEAM_SENT_SOURCE) {
          const conversationId = message.conversationId?.trim();
          const targetTeam = this.parseCrossTeamTargetTeam(message.to);
          if (!conversationId || !targetTeam) continue;
          const key = this.buildCrossTeamConversationKey(targetTeam, conversationId);
          latestOutboundByConversation.set(
            key,
            Math.max(latestOutboundByConversation.get(key) ?? 0, timestampMs)
          );
          continue;
        }
        if (message.source === CROSS_TEAM_SOURCE && message.read) {
          const conversationId =
            message.replyToConversationId?.trim() ??
            message.conversationId?.trim() ??
            parseCrossTeamPrefix(message.text)?.conversationId;
          const sourceTeam = this.getCrossTeamSourceTeam(message.from);
          if (!conversationId || !sourceTeam) continue;
          const key = this.buildCrossTeamConversationKey(sourceTeam, conversationId);
          latestReadInboundByConversation.set(
            key,
            Math.max(latestReadInboundByConversation.get(key) ?? 0, timestampMs)
          );
        }
      }
      const pendingHistoricalReplies = new Set(
        Array.from(latestOutboundByConversation.entries())
          .filter(([key, sentAtMs]) => sentAtMs > (latestReadInboundByConversation.get(key) ?? 0))
          .map(([key]) => key)
      );
      const pendingTransientReplies = this.getPendingCrossTeamReplyExpectationKeys(teamName);
      const matchedTransientReplyKeys = new Set<string>();

      const wasRecentlyDeliveredCrossTeam = (message: InboxMessage): boolean => {
        if (message.source !== CROSS_TEAM_SOURCE) return false;
        if (!hasStableInboxMessageId(message)) return false;
        return this.wasRecentlyDeliveredToLead(teamName, message.messageId);
      };
      const isCrossTeamReplyToOwnOutbound = (message: InboxMessage): boolean => {
        if (message.source !== CROSS_TEAM_SOURCE) return false;
        const conversationId =
          message.replyToConversationId?.trim() ??
          message.conversationId?.trim() ??
          parseCrossTeamPrefix(message.text)?.conversationId;
        if (!conversationId) return false;
        const sourceTeam = this.getCrossTeamSourceTeam(message.from);
        if (!sourceTeam) return false;
        const key = this.buildCrossTeamConversationKey(sourceTeam, conversationId);
        if (pendingHistoricalReplies.has(key)) {
          return true;
        }
        if (pendingTransientReplies.has(key)) {
          matchedTransientReplyKeys.add(key);
          return true;
        }
        return false;
      };

      // Category 1: permanently ignored → mark as read.
      // Includes noise (idle/shutdown), cross-team sender copies, cross-team reply dedup.
      const permanentlyIgnored = unread.filter(
        (m) =>
          silentIdleIds.has(m.messageId) ||
          coarseNonIdleNoiseIds.has(m.messageId) ||
          m.source === CROSS_TEAM_SENT_SOURCE ||
          isCrossTeamReplyToOwnOutbound(m) ||
          wasRecentlyDeliveredCrossTeam(m)
      );
      if (permanentlyIgnored.length > 0) {
        try {
          await this.markInboxMessagesRead(teamName, leadName, permanentlyIgnored);
        } catch {
          // best-effort
        }
        for (const key of matchedTransientReplyKeys) {
          const [otherTeam, conversationId] = key.split('\0');
          if (otherTeam && conversationId) {
            this.clearPendingCrossTeamReplyExpectation(teamName, otherTeam, conversationId);
          }
        }
      }

      const passiveIdleUnread = unread.filter((m) => passiveIdleIds.has(m.messageId));
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

      const readOnlyIgnoredIds = new Set([
        ...permanentlyIgnored.map((m) => m.messageId),
        ...passiveIdleUnread.map((m) => m.messageId),
      ]);
      const remainingUnread = unread.filter((m) => !readOnlyIgnoredIds.has(m.messageId));
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
      const actionableUnread = remainingUnread.filter(
        (m) =>
          !nativeMatchedMessageIds.has(m.messageId) &&
          !deferredIds.has(m.messageId) &&
          !permissionRequestIds.has(m.messageId)
      );

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
      const workSyncControlUrl = await this.resolveControlApiBaseUrl();
      run.activeCrossTeamReplyHints = batch.flatMap((m) => {
        if (m.source !== 'cross_team') return [];
        const sourceTeam = m.from.includes('.') ? m.from.split('.', 1)[0] : '';
        const conversationId = m.conversationId ?? parseCrossTeamPrefix(m.text)?.conversationId;
        if (!sourceTeam || !conversationId) return [];
        return [{ toTeam: sourceTeam, conversationId }];
      });
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

      this.rememberRecentCrossTeamLeadDeliveryMessageIds(
        teamName,
        batch
          .filter((message) => message.source === CROSS_TEAM_SOURCE)
          .map((message) => message.messageId)
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

      const readCommitBatch = await getLeadRelayReadCommitBatch({
        teamName,
        leadName,
        batch,
        hasAcceptedLeadWorkSyncReport: (report) => this.hasAcceptedLeadWorkSyncReport(report),
        scheduleLeadProofMissingWorkSyncRecovery: (recoveryInput) =>
          this.scheduleLeadProofMissingWorkSyncRecovery(recoveryInput),
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

      // Strip agent-only blocks — lead may respond with pure coordination content
      // that is not meant for the human user.
      const cleanReply = replyText
        ? stripExactInternalControlEchoPrefix(
            stripAgentBlocks(replyText),
            stripAgentBlocks(message)
          )
        : null;
      if (cleanReply) {
        if (isTeamInternalControlMessageText(cleanReply)) {
          logger.debug(`[${teamName}] Suppressed internal lead relay echo`);
        } else if (
          (replyVisibility === 'internal_activity' && capturedVisibleSendMessage) ||
          (replyVisibility === 'user' && capturedUserVisibleSendMessage)
        ) {
          logger.debug(`[${teamName}] Suppressed lead relay text duplicated by visible message`);
        } else if (
          replyVisibility === 'internal_activity' &&
          shouldSuppressUnverifiedLeadRelayStateLine(cleanReply)
        ) {
          logger.debug(`[${teamName}] Suppressed unverified lead relay state claim`);
        } else if (replyVisibility === 'internal_activity') {
          this.pushLiveLeadTextMessage(
            run,
            cleanReply,
            `lead-relay-${runId}-${Date.now()}`,
            nowIso()
          );
        } else {
          const relayMsg: InboxMessage = {
            from: leadName,
            to: 'user',
            text: cleanReply,
            timestamp: nowIso(),
            read: true,
            summary: cleanReply.length > 60 ? cleanReply.slice(0, 57) + '...' : cleanReply,
            messageId: `lead-process-${runId}-${Date.now()}`,
            source: 'lead_process',
          };
          this.pushLiveLeadProcessMessage(teamName, relayMsg);
          // Persist to disk so relayed replies survive app restart and trigger FileWatcher
          this.persistSentMessage(teamName, relayMsg);
          this.teamChangeEmitter?.({
            type: 'inbox',
            teamName,
            detail: 'lead-process-reply',
          });
        }
      }
      if (hasPendingFollowUpRelay) {
        this.scheduleLeadInboxFollowUpRelay(teamName);
      }

      return batch.length;
    })();

    this.leadInboxRelayInFlight.set(teamName, work);
    try {
      return await this.waitForInboxRelayInFlight({
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
    const runId = this.getAliveRunId(teamName);
    if (!runId) return false;
    const run = this.runs.get(runId);
    if (!run) {
      return (
        this.runtimeAdapterRunByTeam.get(teamName)?.runId === runId ||
        this.hasSecondaryRuntimeRuns(teamName)
      );
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
    return this.getShutdownTrackedTeamNames().length > 0;
  }

  async getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    const runId = this.getTrackedRunId(teamName);
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
            this.getRetainedProvisioningProgressMap().get(runId) ??
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
    for (const part of content) {
      if (part.type !== 'tool_use' || part.name !== 'Agent') continue;
      const input = part.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;
      const teamName = typeof inp.team_name === 'string' ? inp.team_name.trim() : '';
      const memberName = typeof inp.name === 'string' ? inp.name.trim() : '';
      if (teamName && !memberName) {
        logger.warn(
          `[captureTeamSpawnEvents] Agent call for team "${run.teamName}" is missing name - ` +
            `runtime will spawn an ephemeral subagent instead of a persistent teammate`
        );
        continue;
      }
      if (!memberName) continue;
      if (!teamName) {
        logger.warn(
          `[captureTeamSpawnEvents] Agent call for "${memberName}" is missing team_name - ` +
            `teammate will be an ephemeral subagent, not a persistent member of "${run.teamName}"`
        );
        this.setMemberSpawnStatus(
          run,
          memberName,
          'error',
          `Agent spawn for "${memberName}" is missing team_name - spawned as ephemeral subagent instead of persistent teammate`
        );
        continue;
      }
      // Only track spawns for this team
      if (teamName !== run.teamName) continue;
      const existing = run.memberSpawnStatuses.get(memberName);
      if (
        existing &&
        !existing.hardFailure &&
        (existing.bootstrapConfirmed || existing.runtimeAlive || existing.agentToolAccepted)
      ) {
        this.appendMemberBootstrapDiagnostic(
          run,
          memberName,
          'respawn blocked as duplicate - teammate already online'
        );
        continue;
      }
      this.setMemberSpawnStatus(run, memberName, 'spawning');
      const toolUseId = typeof part.id === 'string' ? part.id.trim() : '';
      if (toolUseId) {
        run.memberSpawnToolUseIds.set(toolUseId, memberName);
      }

      // Advance stepper to "Members joining" when first member spawn is detected
      if (
        !run.provisioningComplete &&
        (run.progress.state === 'configuring' || run.progress.state === 'spawning')
      ) {
        const progress = updateProgress(run, 'assembling', `Spawning member ${memberName}...`);
        run.onProgress(progress);
      }
    }
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
          const stalledDiagnostic = bootstrapStalled
            ? await this.buildOpenCodeSecondaryBootstrapStallDiagnostic(run, expected, base)
            : null;
          const runtimeProcessStallDiagnostic =
            stalledDiagnostic ===
            'OpenCode bootstrap did not complete runtime_bootstrap_checkin after 5 min.'
              ? 'Runtime process is alive, but no bootstrap check-in after 5 min.'
              : stalledDiagnostic;
          this.setOpenCodeRuntimePendingBootstrapStatus(run, expected, base, {
            bootstrapStalled,
            runtimeDiagnostic: bootstrapStalled
              ? (runtimeProcessStallDiagnostic ??
                'Runtime process is alive, but no bootstrap check-in after 5 min.')
              : (base.runtimeDiagnostic ??
                'OpenCode runtime process is alive, waiting for bootstrap check-in.'),
            runtimeDiagnosticSeverity: bootstrapStalled
              ? 'warning'
              : (base.runtimeDiagnosticSeverity ?? 'info'),
          });
          if (bootstrapStalled) {
            await this.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
              run,
              memberName: expected,
              current: base,
              runtimeDiagnostic:
                runtimeProcessStallDiagnostic ??
                'Runtime process is alive, but no bootstrap check-in after 5 min.',
            });
          }
          continue;
        }
        this.setMemberSpawnStatus(run, expected, 'online', undefined, 'process');
        continue;
      }

      if (matchedRuntimeNames.length > 0) {
        if (current?.agentToolAccepted) {
          if (
            this.isOpenCodeSecondaryLaneMemberInRun(run, expected) &&
            current.launchState === 'runtime_pending_bootstrap' &&
            current.bootstrapConfirmed !== true &&
            current.hardFailure !== true &&
            this.isOpenCodeBootstrapStallWindowElapsed(current.firstSpawnAcceptedAt)
          ) {
            const diagnostic = await this.buildOpenCodeSecondaryBootstrapStallDiagnostic(
              run,
              expected,
              current
            );
            this.setOpenCodeSecondaryBootstrapStalledStatus(run, expected, current, diagnostic);
            await this.maybeSendOpenCodeSecondaryBootstrapCheckinRetryPrompt({
              run,
              memberName: expected,
              current,
              runtimeDiagnostic: diagnostic,
            });
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
    const runId = this.getTrackedRunId(teamName);
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
      runtimeProcessRowsForUsageSnapshotByTeam: this.runtimeProcessRowsForUsageSnapshotByTeam,
      liveTeamAgentRuntimeMetadataCache: this.liveTeamAgentRuntimeMetadataCache,
      cloneLiveTeamAgentRuntimeMetadata: (metadata) =>
        this.cloneLiveTeamAgentRuntimeMetadata(metadata),
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
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
      logDebug: (message) => logger.debug(message),
    });
  }

  private async readRuntimeProcessRowsForUsageSnapshot(
    teamName: string,
    options: { includeWindowsHostRows?: boolean } = {}
  ): Promise<RuntimeTelemetryProcessTableRow[] | null> {
    return readRuntimeProcessRowsForUsageSnapshotHelper({
      teamName,
      options,
      runtimeProcessRowsForUsageSnapshotByTeam: this.runtimeProcessRowsForUsageSnapshotByTeam,
      cacheAccess: {
        getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
          this.getRuntimeSnapshotCacheGeneration(targetTeamName),
        getTrackedRunId: (targetTeamName) => this.getTrackedRunId(targetTeamName),
        getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
          this.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      },
      processTableTimeoutMs: TeamProvisioningService.RUNTIME_PROCESS_TABLE_TIMEOUT_MS,
      windowsProcessTableTimeoutMs:
        TeamProvisioningService.RUNTIME_WINDOWS_PROCESS_TABLE_TIMEOUT_MS,
      resourceTelemetryCacheTtlMs: TeamProvisioningService.RUNTIME_RESOURCE_TELEMETRY_CACHE_TTL_MS,
      resourceTelemetryFailureCacheTtlMs:
        TeamProvisioningService.RUNTIME_RESOURCE_TELEMETRY_FAILURE_CACHE_TTL_MS,
      logDebug: (message) => logger.debug(message),
    });
  }

  private async readProcessUsageStatsByPid(
    pids: readonly number[],
    cacheOptions: { ignoreCachedMisses?: boolean } = {}
  ): Promise<Map<number, RuntimeProcessUsageStats>> {
    return readProcessUsageStatsByPidHelper({
      pids,
      cacheOptions,
      runtimeProcessUsageStatsCacheByPid: this.runtimeProcessUsageStatsCacheByPid,
      usageCacheTtlMs: TeamProvisioningService.RUNTIME_PROCESS_USAGE_CACHE_TTL_MS,
      usageCacheMaxEntries: TeamProvisioningService.RUNTIME_PROCESS_USAGE_CACHE_MAX_ENTRIES,
      batchTimeoutMs: TeamProvisioningService.RUNTIME_PIDUSAGE_BATCH_TIMEOUT_MS,
      singleTimeoutMs: TeamProvisioningService.RUNTIME_PIDUSAGE_SINGLE_TIMEOUT_MS,
      fallbackConcurrency: TeamProvisioningService.RUNTIME_PIDUSAGE_FALLBACK_CONCURRENCY,
      logDebug: (message) => logger.debug(message),
    });
  }

  private async clearPersistedLaunchState(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    await this.enqueueLaunchStateStoreOperation(teamName, () =>
      this.clearPersistedLaunchStateNow(teamName, options)
    );
  }

  private canClearPersistedLaunchStateForRun(
    teamName: string,
    expectedRunId: string | undefined
  ): boolean {
    if (!expectedRunId) {
      return true;
    }
    const trackedRunId = this.getTrackedRunId(teamName);
    if (trackedRunId !== expectedRunId) {
      return false;
    }
    const lastWrittenRunId = this.launchStateWrittenRunIdByTeam.get(teamName);
    if (lastWrittenRunId && lastWrittenRunId !== expectedRunId) {
      return false;
    }
    return true;
  }

  private async clearPersistedLaunchStateNow(
    teamName: string,
    options?: { expectedRunId?: string }
  ): Promise<void> {
    if (!this.canClearPersistedLaunchStateForRun(teamName, options?.expectedRunId)) {
      logger.debug(
        `[${teamName}] Skipping stale launch-state clear for run ${options?.expectedRunId}`
      );
      return;
    }
    await this.launchStateStore.clear(teamName);
    this.launchStateWrittenRunIdByTeam.delete(teamName);
    await clearBootstrapState(teamName);
    this.invalidateRuntimeSnapshotCaches(teamName);
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

  private hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(
    snapshot: PersistedTeamLaunchSnapshot | null,
    previousSnapshot: PersistedTeamLaunchSnapshot | null
  ): boolean {
    return hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(snapshot, previousSnapshot);
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
    const result = await this.enqueueLaunchStateStoreOperation(teamName, async () => {
      const writeResult = await this.writeLaunchStateSnapshotNow(teamName, snapshot);
      if (writeResult.wrote) {
        this.invalidateRuntimeSnapshotCaches(teamName);
      }
      return writeResult;
    });
    return result.snapshot;
  }

  private async writeLaunchStateSnapshotNow(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot,
    options?: { allowNoopSkip?: boolean; runId?: string }
  ): Promise<LaunchStateWriteResult> {
    const previousSnapshot = await this.launchStateStore.read(teamName).catch(() => null);
    const metaMembers = await this.membersMetaStore.getMembers(teamName).catch(() => []);
    const overlaidSnapshot = await this.applyOpenCodeSecondaryEvidenceOverlay({
      teamName,
      snapshot,
      previousSnapshot,
      metaMembers,
    });
    const normalizedSnapshot =
      this.applyOpenCodeSecondaryBootstrapStallOverlay(overlaidSnapshot) ?? overlaidSnapshot;
    if (
      options?.allowNoopSkip === true &&
      typeof options.runId === 'string' &&
      this.launchStateWrittenRunIdByTeam.get(teamName) === options.runId &&
      previousSnapshot &&
      this.areLaunchStateSnapshotsSemanticallyEqual(previousSnapshot, normalizedSnapshot) &&
      !this.isLaunchStateNoopRefreshDue(previousSnapshot)
    ) {
      return { snapshot: previousSnapshot, wrote: false };
    }
    await this.launchStateStore.write(teamName, normalizedSnapshot);
    if (typeof options?.runId === 'string') {
      this.launchStateWrittenRunIdByTeam.set(teamName, options.runId);
    }
    return { snapshot: normalizedSnapshot, wrote: true };
  }

  private isLaunchStateNoopRefreshDue(snapshot: PersistedTeamLaunchSnapshot): boolean {
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    return (
      !Number.isFinite(updatedAtMs) ||
      Date.now() - updatedAtMs >= TeamProvisioningService.LAUNCH_STATE_NOOP_REFRESH_MS
    );
  }

  private areLaunchStateSnapshotsSemanticallyEqual(
    left: PersistedTeamLaunchSnapshot,
    right: PersistedTeamLaunchSnapshot
  ): boolean {
    return areLaunchStateSnapshotsSemanticallyEqual(left, right);
  }

  private async enqueueLaunchStateStoreOperation<T>(
    teamName: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = this.launchStateStoreQueue.get(teamName);
    const queued = (previous ?? Promise.resolve()).catch(() => undefined).then(operation);
    this.launchStateStoreQueue.set(teamName, queued);
    try {
      return await queued;
    } finally {
      if (this.launchStateStoreQueue.get(teamName) === queued) {
        this.launchStateStoreQueue.delete(teamName);
      }
    }
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
    this.setAliveRunId(run.teamName, run.runId);
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

  private async applyOpenCodeSecondaryPermissionAnswerResult(
    entry: RuntimeToolApprovalEntry,
    result: TeamRuntimeLaunchResult
  ): Promise<void> {
    const trackedRunId = this.getTrackedRunId(entry.approval.teamName);
    const run = trackedRunId ? this.runs.get(trackedRunId) : null;
    if (!run) {
      throw new Error(`Run not found for team "${entry.approval.teamName}"`);
    }
    const lane = (run.mixedSecondaryLanes ?? []).find(
      (candidate) => candidate.laneId === entry.laneId
    );
    if (!lane) {
      throw new Error(
        `OpenCode secondary lane ${entry.laneId} was not found for team "${entry.approval.teamName}"`
      );
    }

    const expectedMembers =
      entry.expectedMembers && entry.expectedMembers.length > 0
        ? entry.expectedMembers
        : [
            {
              name: lane.member.name,
              role: lane.member.role,
              workflow: lane.member.workflow,
              isolation: lane.member.isolation === 'worktree' ? ('worktree' as const) : undefined,
              providerId: 'opencode' as const,
              model: lane.member.model,
              effort: lane.member.effort,
              cwd: entry.cwd?.trim() || lane.member.cwd?.trim() || run.request.cwd,
            },
          ];
    const guarded = await this.guardCommittedOpenCodeSecondaryLaneEvidence({
      teamName: entry.approval.teamName,
      laneId: entry.laneId,
      memberName: entry.memberName,
      result: normalizeExpectedOpenCodeRuntimeLaunchMembers(result, expectedMembers),
    });
    lane.result = guarded;
    lane.warnings = [...guarded.warnings];
    lane.diagnostics = [...guarded.diagnostics];
    lane.state = 'finished';
    const retainLane = shouldRetainOpenCodeRuntimeLaunch(guarded);
    if (!retainLane) {
      const adapter = this.getOpenCodeRuntimeAdapter();
      if (adapter) {
        await this.stopUnretainableOpenCodeRuntimeLane({
          adapter,
          runId: entry.approval.runId,
          laneId: entry.laneId,
          teamName: entry.approval.teamName,
          cwd: entry.cwd?.trim() || lane.member.cwd?.trim() || run.request.cwd,
          previousLaunchState: await this.launchStateStore.read(entry.approval.teamName),
        });
      }
      await upsertOpenCodeRuntimeLaneIndexEntry({
        teamsBasePath: getTeamsBasePath(),
        teamName: entry.approval.teamName,
        laneId: entry.laneId,
        state: 'degraded',
        diagnostics: guarded.diagnostics,
      }).catch(() => undefined);
      this.deleteSecondaryRuntimeRun(entry.approval.teamName, entry.laneId);
    }
    await this.publishMixedSecondaryLaneStatusChange(run, lane);
    this.syncOpenCodeRuntimeToolApprovals({
      teamName: entry.approval.teamName,
      runId: entry.approval.runId,
      laneId: entry.laneId,
      cwd: entry.cwd ?? '',
      members: guarded.members,
      expectedMembers,
      teamDisplayName: entry.approval.teamDisplayName,
      teamColor: entry.approval.teamColor,
    });
    if (!retainLane && !this.isTeamAlive(entry.approval.teamName)) {
      this.deleteAliveRunId(entry.approval.teamName);
    }
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
    const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
    if (mixedSecondaryLanes.length === 0) {
      return null;
    }

    return this.runtimeLaneCoordinator.buildAggregateLaunchSnapshot({
      teamName: run.teamName,
      leadSessionId: run.detectedSessionId ?? undefined,
      launchPhase,
      leadDefaults: {
        providerId: resolveTeamProviderId(run.request.providerId),
        providerBackendId:
          migrateProviderBackendId(run.request.providerId, run.request.providerBackendId) ?? null,
        selectedFastMode: run.request.fastMode,
        resolvedFastMode:
          typeof run.launchIdentity?.resolvedFastMode === 'boolean'
            ? run.launchIdentity.resolvedFastMode
            : null,
        launchIdentity: run.launchIdentity ?? null,
      },
      primaryMembers: run.effectiveMembers,
      primaryStatuses: this.buildRuntimeSpawnStatusRecord(run),
      secondaryMembers: mixedSecondaryLanes.map((secondaryLane) => {
        const evidenceEntry = secondaryLane.result?.members[secondaryLane.member.name];
        const currentSpawnStatus = run.memberSpawnStatuses.get(secondaryLane.member.name);
        const laneFirstSpawnAcceptedAt =
          currentSpawnStatus?.firstSpawnAcceptedAt ??
          (typeof secondaryLane.launchFinishedAtMs === 'number' &&
          Number.isFinite(secondaryLane.launchFinishedAtMs)
            ? new Date(secondaryLane.launchFinishedAtMs).toISOString()
            : undefined);
        const finishedWithoutRuntimeEvidence =
          secondaryLane.state === 'finished' && !secondaryLane.result;
        const missingEvidenceDiagnostics =
          secondaryLane.diagnostics.length > 0
            ? [...secondaryLane.diagnostics]
            : [
                'OpenCode secondary lane finished without committed runtime evidence.',
                'Retry the OpenCode teammate or relaunch the team.',
              ];
        return {
          laneId: secondaryLane.laneId,
          runtimeRunId: secondaryLane.runId,
          member: secondaryLane.member,
          leadDefaults: {
            providerId: resolveTeamProviderId(run.request.providerId),
            providerBackendId:
              migrateProviderBackendId(run.request.providerId, run.request.providerBackendId) ??
              null,
            selectedFastMode: run.request.fastMode,
            resolvedFastMode:
              typeof run.launchIdentity?.resolvedFastMode === 'boolean'
                ? run.launchIdentity.resolvedFastMode
                : null,
            launchIdentity: run.launchIdentity ?? null,
          },
          evidence: evidenceEntry
            ? {
                launchState: evidenceEntry.launchState,
                agentToolAccepted: evidenceEntry.agentToolAccepted,
                runtimeAlive: evidenceEntry.runtimeAlive,
                bootstrapConfirmed: evidenceEntry.bootstrapConfirmed,
                hardFailure: evidenceEntry.hardFailure,
                hardFailureReason: evidenceEntry.hardFailureReason,
                pendingPermissionRequestIds: evidenceEntry.pendingPermissionRequestIds,
                runtimePid: evidenceEntry.runtimePid,
                sessionId: evidenceEntry.sessionId,
                livenessKind: evidenceEntry.livenessKind,
                pidSource: evidenceEntry.pidSource,
                runtimeDiagnostic: evidenceEntry.runtimeDiagnostic,
                runtimeDiagnosticSeverity: evidenceEntry.runtimeDiagnosticSeverity,
                bootstrapStalled: currentSpawnStatus?.bootstrapStalled === true ? true : undefined,
                firstSpawnAcceptedAt: laneFirstSpawnAcceptedAt,
                diagnostics: evidenceEntry.diagnostics,
              }
            : finishedWithoutRuntimeEvidence
              ? {
                  launchState: 'runtime_pending_bootstrap',
                  agentToolAccepted: false,
                  runtimeAlive: false,
                  bootstrapConfirmed: false,
                  hardFailure: false,
                  runtimeDiagnostic:
                    'OpenCode secondary lane finished without committed runtime evidence.',
                  runtimeDiagnosticSeverity: 'warning',
                  bootstrapStalled:
                    currentSpawnStatus?.bootstrapStalled === true ? true : undefined,
                  diagnostics: missingEvidenceDiagnostics,
                }
              : null,
          pendingReason:
            secondaryLane.result || secondaryLane.state === 'finished'
              ? undefined
              : secondaryLane.state === 'launching'
                ? 'Launching through OpenCode secondary lane.'
                : 'Queued for OpenCode secondary lane launch.',
        };
      }),
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
    if (expectedMembers.length === 0 || messages.length === 0) {
      return false;
    }

    return messages.some((message) => {
      if (
        typeof message.from !== 'string' ||
        typeof message.text !== 'string' ||
        typeof message.timestamp !== 'string' ||
        !isMeaningfulBootstrapCheckInMessage(message.text)
      ) {
        return false;
      }

      const expected = this.resolveExpectedLaunchMemberName(expectedMembers, message.from);
      if (!expected) {
        return false;
      }

      const current = snapshot.members[expected];
      const firstAcceptedAt = current?.firstSpawnAcceptedAt
        ? Date.parse(current.firstSpawnAcceptedAt)
        : NaN;
      const messageTs = Date.parse(message.timestamp);
      return (
        !Number.isFinite(firstAcceptedAt) ||
        !Number.isFinite(messageTs) ||
        messageTs >= firstAcceptedAt
      );
    });
  }

  private selectLatestLeadInboxLaunchReconcileMessage(
    messages: readonly LeadInboxLaunchReconcileMessage[],
    expectedMembers: readonly string[],
    expected: string,
    firstSpawnAcceptedAt?: string
  ): LeadInboxLaunchReconcileMessage | null {
    const firstAcceptedAt = firstSpawnAcceptedAt ? Date.parse(firstSpawnAcceptedAt) : NaN;
    const candidates = messages.filter((message) => {
      if (
        typeof message.from !== 'string' ||
        this.resolveExpectedLaunchMemberName(expectedMembers, message.from) !== expected
      ) {
        return false;
      }
      if (typeof message.text !== 'string' || !isMeaningfulBootstrapCheckInMessage(message.text)) {
        return false;
      }
      const messageTs = Date.parse(message.timestamp);
      if (
        Number.isFinite(firstAcceptedAt) &&
        Number.isFinite(messageTs) &&
        messageTs < firstAcceptedAt
      ) {
        return false;
      }
      return true;
    });

    return (
      candidates.sort((left, right) => {
        const leftMs = Date.parse(left.timestamp);
        const rightMs = Date.parse(right.timestamp);
        const leftValid = Number.isFinite(leftMs);
        const rightValid = Number.isFinite(rightMs);
        if (leftValid && rightValid && leftMs !== rightMs) {
          return rightMs - leftMs;
        }
        if (leftValid !== rightValid) {
          return leftValid ? -1 : 1;
        }
        return (right.messageId ?? '').localeCompare(left.messageId ?? '');
      })[0] ?? null
    );
  }

  private shouldRecoverStalePersistedMixedLaunchSnapshot(
    snapshot: PersistedTeamLaunchSnapshot
  ): boolean {
    const hasRecoverableOpenCodeRuntimeCandidate = Object.values(snapshot.members).some((member) =>
      isRecoverablePersistedOpenCodeTerminalRuntimeCandidate(member)
    );
    if (hasRecoverableOpenCodeRuntimeCandidate) {
      return true;
    }

    if (snapshot.teamLaunchState !== 'partial_pending') {
      return false;
    }
    const updatedAtMs = Date.parse(snapshot.updatedAt);
    if (Number.isFinite(updatedAtMs) && Date.now() - updatedAtMs < MEMBER_LAUNCH_GRACE_MS) {
      return false;
    }

    return Object.values(snapshot.members).some((member) => {
      if (member.launchState === 'confirmed_alive' || member.launchState === 'failed_to_start') {
        return false;
      }
      return (
        member.laneKind === 'secondary' &&
        member.laneOwnerProviderId === 'opencode' &&
        typeof member.laneId === 'string'
      );
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
    lane.launchStartedAtMs = Date.now();
    lane.queuedAtMs = lane.queuedAtMs ?? lane.launchStartedAtMs;
    const requestedDiagnostics = [...lane.diagnostics];
    const shouldAbortLaunch = (): boolean =>
      run.cancelRequested ||
      run.processKilled ||
      this.stoppingSecondaryRuntimeTeams.has(run.teamName);
    const finishCancelledLane = async (): Promise<void> => {
      await this.stopSingleMixedSecondaryRuntimeLane(run, lane, 'cleanup');
    };
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      const message = 'OpenCode runtime adapter is not registered for mixed team launch.';
      lane.launchFinishedAtMs = Date.now();
      const timingDiagnostic = buildOpenCodeSecondaryLaneTimingDiagnostic(lane);
      lane.state = 'finished';
      lane.result = {
        runId: lane.runId ?? randomUUID(),
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
            hardFailureReason: 'opencode_runtime_adapter_missing',
            diagnostics: appendDiagnosticOnce([message], timingDiagnostic),
          },
        },
        warnings: [],
        diagnostics: appendDiagnosticOnce([...requestedDiagnostics, message], timingDiagnostic),
      };
      lane.warnings = [];
      lane.diagnostics = appendDiagnosticOnce([...requestedDiagnostics, message], timingDiagnostic);
      await this.publishMixedSecondaryLaneStatusChange(run, lane);
      lane.state = 'finished';
      return;
    }

    const migration = await migrateLegacyOpenCodeRuntimeState({
      teamsBasePath: getTeamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
    });
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
      state: migration.degraded ? 'degraded' : 'active',
      diagnostics: migration.diagnostics,
    });
    if (shouldAbortLaunch()) {
      await finishCancelledLane();
      return;
    }

    lane.state = 'launching';
    lane.runId = lane.runId ?? randomUUID();
    const laneRunId = lane.runId;
    lane.warnings = [];
    lane.diagnostics = [...requestedDiagnostics, ...migration.diagnostics];
    const laneCwd = lane.member.cwd?.trim() || run.request.cwd;
    this.setSecondaryRuntimeRun({
      teamName: run.teamName,
      runId: laneRunId,
      providerId: 'opencode',
      laneId: lane.laneId,
      memberName: lane.member.name,
      cwd: laneCwd,
    });
    await this.publishMixedSecondaryLaneStatusChange(run, lane);
    const previousLaunchState = await this.launchStateStore.read(run.teamName);

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
        result: normalizeExpectedOpenCodeRuntimeLaunchMembers(rawResult, laneExpectedMembers),
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
        await this.stopUnretainableOpenCodeRuntimeLane({
          adapter,
          runId: laneRunId,
          laneId: lane.laneId,
          teamName: run.teamName,
          cwd: laneCwd,
          previousLaunchState,
        });
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
      await this.stopUnretainableOpenCodeRuntimeLane({
        adapter,
        runId: laneRunId,
        laneId: lane.laneId,
        teamName: run.teamName,
        cwd: laneCwd,
        previousLaunchState,
      });
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
    const adapter = this.getOpenCodeRuntimeAdapter();
    const previousLaunchState = await this.launchStateStore.read(run.teamName);
    await upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: getTeamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
      state: 'stopped',
      diagnostics: [`OpenCode lane stop requested: ${reason}`],
    }).catch(() => undefined);

    try {
      if (adapter && lane.runId) {
        await adapter.stop({
          runId: lane.runId,
          laneId: lane.laneId,
          teamName: run.teamName,
          cwd: lane.member.cwd?.trim() || run.request.cwd,
          providerId: 'opencode',
          reason,
          previousLaunchState,
          force: true,
        });
      }
    } catch (error) {
      logger.warn(
        `[${run.teamName}] Failed to stop mixed OpenCode lane ${lane.laneId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    } finally {
      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName: run.teamName,
        laneId: lane.laneId,
      }).catch(() => undefined);
      this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
      lane.runId = null;
      lane.state = 'finished';
      lane.result = null;
      lane.warnings = [];
      lane.diagnostics = [];
    }
  }

  private launchQueuedMixedSecondaryLaneInBackground(
    run: ProvisioningRun,
    lane: MixedSecondaryRuntimeLaneState
  ): void {
    if (lane.state !== 'queued' || lane.launchScheduled) {
      return;
    }

    lane.queuedAtMs = lane.queuedAtMs ?? Date.now();
    lane.launchScheduled = true;
    lane.runId = lane.runId ?? randomUUID();

    const launch = async () => {
      try {
        if (run.cancelRequested || run.processKilled) {
          await clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: getTeamsBasePath(),
            teamName: run.teamName,
            laneId: lane.laneId,
          }).catch(() => undefined);
          this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
          lane.state = 'finished';
          return;
        }
        lane.state = 'launching';
        await this.launchSingleMixedSecondaryLane(run, lane);
      } catch (error) {
        if (run.cancelRequested || run.processKilled) {
          await clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: getTeamsBasePath(),
            teamName: run.teamName,
            laneId: lane.laneId,
          }).catch(() => undefined);
          this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
          return;
        }
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(
          `[${run.teamName}] OpenCode secondary lane ${lane.laneId} crashed during launch orchestration: ${message}`
        );
        lane.result = createUnexpectedMixedSecondaryLaneFailureResult({
          runId: lane.runId ?? randomUUID(),
          teamName: run.teamName,
          memberName: lane.member.name,
          message,
        });
        lane.warnings = [];
        lane.diagnostics = [...lane.diagnostics, message];
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'degraded',
          diagnostics: [message],
        }).catch(() => undefined);
        this.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
        await this.publishMixedSecondaryLaneStatusChange(run, lane).catch(() => undefined);
        lane.state = 'finished';
      }
    };

    const previousLaunch = run.mixedSecondaryLaneLaunchQueue ?? Promise.resolve();
    const nextLaunch = previousLaunch.catch(() => undefined).then(launch);
    run.mixedSecondaryLaneLaunchQueue = nextLaunch.catch((error) => {
      logger.warn(
        `[${run.teamName}] OpenCode secondary lane launch queue failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    void run.mixedSecondaryLaneLaunchQueue;
  }

  private async launchMixedSecondaryLaneIfNeeded(
    run: ProvisioningRun,
    options: { waitForCompletion?: boolean } = {}
  ): Promise<PersistedTeamLaunchSnapshot | null> {
    if (run.cancelRequested || run.processKilled) {
      return this.launchStateStore.read(run.teamName).catch(() => null);
    }

    const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
    if (mixedSecondaryLanes.length === 0) {
      return this.persistLaunchStateSnapshot(run, 'finished');
    }

    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      for (const lane of mixedSecondaryLanes) {
        lane.state = 'finished';
        lane.result = {
          runId: lane.runId ?? randomUUID(),
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
              hardFailureReason: 'opencode_runtime_adapter_missing',
              diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
            },
          },
          warnings: [],
          diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
        };
        lane.diagnostics = lane.result.diagnostics;
        await this.publishMixedSecondaryLaneStatusChange(run, lane);
      }
      return this.persistLaunchStateSnapshot(run, 'finished');
    }

    for (const lane of mixedSecondaryLanes) {
      this.launchQueuedMixedSecondaryLaneInBackground(run, lane);
    }

    if (options.waitForCompletion) {
      await run.mixedSecondaryLaneLaunchQueue;
      if (run.cancelRequested || run.processKilled) {
        return this.launchStateStore.read(run.teamName).catch(() => null);
      }
    }

    return this.persistLaunchStateSnapshot(run, this.getMixedSecondaryLaunchPhase(run));
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
            (await this.resolveCurrentOpenCodeRuntimeRunId(teamName, laneIdentity.laneId)) ??
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
    const filteredRecoveredMixedSnapshot = recoveredMixedSnapshot
      ? this.filterRemovedMembersFromLaunchSnapshot(recoveredMixedSnapshot, metaMembers)
      : null;
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
    const stableRecoveredMixedSnapshotWithCommittedEvidence =
      recoveredMixedSnapshotWithBootstrapStall &&
      (this.hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(
        recoveredMixedSnapshotWithBootstrapStall,
        persisted
      ) ||
        recoveredMixedSnapshotWithBootstrapStall !== overlaidRecoveredMixedSnapshot)
        ? await this.writeLaunchStateSnapshot(teamName, recoveredMixedSnapshotWithBootstrapStall)
        : recoveredMixedSnapshotWithBootstrapStall;
    const promotedRecoveredMixedSnapshot = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
      stableRecoveredMixedSnapshotWithCommittedEvidence
    );
    const cleanedRecoveredMixedSnapshot = this.cleanConfirmedBootstrapRuntimeDiagnostics(
      promotedRecoveredMixedSnapshot
    );
    const stableRecoveredMixedSnapshot =
      cleanedRecoveredMixedSnapshot &&
      (promotedRecoveredMixedSnapshot !== stableRecoveredMixedSnapshotWithCommittedEvidence ||
        cleanedRecoveredMixedSnapshot !== promotedRecoveredMixedSnapshot)
        ? await this.writeLaunchStateSnapshot(teamName, cleanedRecoveredMixedSnapshot)
        : cleanedRecoveredMixedSnapshot;
    const filteredBootstrapSnapshot = bootstrapSnapshot
      ? this.filterRemovedMembersFromLaunchSnapshot(bootstrapSnapshot, metaMembers)
      : null;
    const overlaidBootstrapSnapshot =
      await this.applyBootstrapTranscriptEvidenceOverlay(filteredBootstrapSnapshot);
    if (
      stableRecoveredMixedSnapshot &&
      !this.needsBootstrapAcceptanceReconcile(
        stableRecoveredMixedSnapshot,
        overlaidBootstrapSnapshot
      ) &&
      !this.needsConfirmedBootstrapDiagnosticReconcile(stableRecoveredMixedSnapshot) &&
      !(await this.hasBootstrapTranscriptLaunchReconcileOutcome(stableRecoveredMixedSnapshot))
    ) {
      return {
        snapshot: stableRecoveredMixedSnapshot,
        statuses: snapshotToMemberSpawnStatuses(stableRecoveredMixedSnapshot),
      };
    }
    const filteredPersistedBase =
      stableRecoveredMixedSnapshot ??
      (persisted ? this.filterRemovedMembersFromLaunchSnapshot(persisted, metaMembers) : null);
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
    const shouldPersistCommittedEvidenceOverlay =
      this.hasCommittedOpenCodeSecondaryEvidenceOverlayDelta(
        filteredPersistedWithBootstrapStall,
        persisted
      );
    const promotedPersisted = promoteOpenCodePersistedFailureReasonsFromDiagnostics(
      filteredPersistedWithBootstrapStall
    );
    const shouldPersistFailureReasonPromotion =
      promotedPersisted !== filteredPersistedWithBootstrapStall;
    const cleanedPersisted = this.cleanConfirmedBootstrapRuntimeDiagnostics(promotedPersisted);
    const shouldPersistConfirmedBootstrapDiagnosticCleanup = cleanedPersisted !== promotedPersisted;
    const shouldPersistBootstrapStallOverlay =
      filteredPersistedWithBootstrapStall !== filteredPersisted;
    const persistedWithCommittedEvidence =
      cleanedPersisted &&
      (shouldPersistCommittedEvidenceOverlay ||
        shouldPersistFailureReasonPromotion ||
        shouldPersistConfirmedBootstrapDiagnosticCleanup ||
        shouldPersistBootstrapStallOverlay)
        ? await this.writeLaunchStateSnapshot(teamName, cleanedPersisted)
        : cleanedPersisted;
    const preferredSnapshot = choosePreferredLaunchSnapshot(
      overlaidBootstrapSnapshot,
      persistedWithCommittedEvidence
    );
    const bootstrapSelectionWouldCollapseMixedLaunch =
      preferredSnapshot &&
      preferredSnapshot === overlaidBootstrapSnapshot &&
      preferredSnapshot.teamLaunchState === 'clean_success' &&
      !this.hasMixedLaunchMetadata(preferredSnapshot) &&
      this.hasMixedLaunchMetadata(persistedWithCommittedEvidence);
    if (
      preferredSnapshot &&
      preferredSnapshot === overlaidBootstrapSnapshot &&
      !bootstrapSelectionWouldCollapseMixedLaunch
    ) {
      if (persistedWithCommittedEvidence) {
        if (
          preferredSnapshot.teamLaunchState === 'clean_success' &&
          !this.hasMixedLaunchMetadata(preferredSnapshot)
        ) {
          await this.clearPersistedLaunchState(teamName);
          return {
            snapshot: preferredSnapshot,
            statuses: snapshotToMemberSpawnStatuses(preferredSnapshot),
          };
        }
        const writtenSnapshot = await this.writeLaunchStateSnapshot(teamName, preferredSnapshot);
        return {
          snapshot: writtenSnapshot,
          statuses: snapshotToMemberSpawnStatuses(writtenSnapshot),
        };
      }
      return {
        snapshot: preferredSnapshot,
        statuses: snapshotToMemberSpawnStatuses(preferredSnapshot),
      };
    }
    if (!persistedWithCommittedEvidence) {
      return { snapshot: null, statuses: {} };
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
      this.hasMixedLaunchMetadata(persistedWithCommittedEvidence) &&
      !this.hasLeadInboxLaunchReconcileHeartbeat(
        persistedWithCommittedEvidence,
        leadInboxMessages
      ) &&
      !this.needsBootstrapAcceptanceReconcile(
        persistedWithCommittedEvidence,
        overlaidBootstrapSnapshot
      ) &&
      !this.needsConfirmedBootstrapDiagnosticReconcile(persistedWithCommittedEvidence) &&
      !(await this.hasBootstrapTranscriptLaunchReconcileOutcome(persistedWithCommittedEvidence))
    ) {
      return {
        snapshot: persistedWithCommittedEvidence,
        statuses: snapshotToMemberSpawnStatuses(persistedWithCommittedEvidence),
      };
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

    if (
      reconciled.teamLaunchState === 'clean_success' &&
      !this.hasMixedLaunchMetadata(reconciled)
    ) {
      await this.clearPersistedLaunchState(teamName);
      return { snapshot: null, statuses: {} };
    }

    const writtenSnapshot = await this.writeLaunchStateSnapshot(teamName, reconciled);
    return {
      snapshot: writtenSnapshot,
      statuses: snapshotToMemberSpawnStatuses(writtenSnapshot),
    };
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
        !this.getTrackedRunId(teamName) && !this.runtimeAdapterRunByTeam.has(teamName),
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
    for (const part of content) {
      if (part.type !== 'tool_use' || typeof part.name !== 'string') continue;
      const isNativeSendMessage = part.name === 'SendMessage';
      const input = part.input;
      if (!input || typeof input !== 'object') continue;
      const inp = input as Record<string, unknown>;
      const isTeamMessageSendTool = isAgentTeamsToolUse({
        rawName: part.name,
        canonicalName: 'message_send',
        toolInput: inp,
        currentTeamName: run.teamName,
      });
      const isDirectCrossTeamSendTool = isAgentTeamsToolUse({
        rawName: part.name,
        canonicalName: 'cross_team_send',
        toolInput: inp,
        currentTeamName: run.teamName,
      });
      if (!isNativeSendMessage && !isTeamMessageSendTool && !isDirectCrossTeamSendTool) continue;

      if (isDirectCrossTeamSendTool) {
        const toTeam = typeof inp.toTeam === 'string' ? inp.toTeam.trim() : '';
        const text = typeof inp.text === 'string' ? stripAgentBlocks(inp.text).trim() : '';
        if (toTeam && text) {
          run.pendingDirectCrossTeamSendRefresh = true;
        }
        continue;
      }

      const rawRecipient = isNativeSendMessage
        ? typeof inp.recipient === 'string'
          ? inp.recipient
          : ''
        : typeof inp.to === 'string'
          ? inp.to
          : '';
      const trimmedRecipient = rawRecipient.trim();
      if (!trimmedRecipient) continue;
      const recipient = trimmedRecipient.toLowerCase() === 'user' ? 'user' : trimmedRecipient;

      const msgContent = isNativeSendMessage
        ? typeof inp.content === 'string'
          ? inp.content
          : ''
        : typeof inp.text === 'string'
          ? inp.text
          : '';
      if (msgContent.trim().length === 0) continue;

      const summary = typeof inp.summary === 'string' ? inp.summary : '';
      const leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';

      const cleanContent = stripAgentBlocks(msgContent);
      if (cleanContent.trim().length === 0) continue;
      const strippedCrossTeamContent = stripCrossTeamPrefix(cleanContent).trim();
      if (strippedCrossTeamContent.length === 0) continue;
      const localRecipientNames = new Set(
        (run.request.members ?? [])
          .map((member) => (typeof member.name === 'string' ? member.name.trim() : ''))
          .filter((name) => name.length > 0)
      );
      localRecipientNames.add('user');
      localRecipientNames.add('team-lead');

      const mistakenToolHint = this.isCrossTeamToolRecipientName(recipient)
        ? this.resolveSingleActiveCrossTeamReplyHint(run)
        : null;
      const crossTeamRecipient =
        this.parseCrossTeamRecipient(run.teamName, recipient, localRecipientNames) ??
        (mistakenToolHint ? { teamName: mistakenToolHint.toTeam, memberName: 'team-lead' } : null);
      if (crossTeamRecipient && this.crossTeamSender) {
        const inferredReplyMeta =
          mistakenToolHint?.toTeam === crossTeamRecipient.teamName
            ? {
                conversationId: mistakenToolHint.conversationId,
                replyToConversationId: mistakenToolHint.conversationId,
              }
            : this.resolveCrossTeamReplyMetadata(run.teamName, crossTeamRecipient.teamName);
        const crossTeamMeta = parseCrossTeamPrefix(cleanContent);
        const replyMeta = inferredReplyMeta;
        const timestamp = nowIso();
        const messageId = `lead-sendmsg-${run.runId}-${Date.now()}`;
        const taskRefs = teamToolTaskRefs(run.teamName, inp.taskRefs);

        void this.crossTeamSender({
          fromTeam: run.teamName,
          fromMember: leadName,
          toTeam: crossTeamRecipient.teamName,
          text: strippedCrossTeamContent,
          summary,
          ...(taskRefs ? { taskRefs } : {}),
          messageId,
          timestamp,
          conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
          replyToConversationId:
            replyMeta?.replyToConversationId ??
            crossTeamMeta?.conversationId ??
            replyMeta?.conversationId,
        })
          .then((result) => {
            if (result.deduplicated) {
              return;
            }
            if (this.getTrackedRunId(run.teamName) !== run.runId) {
              logger.debug(
                `[${run.teamName}] Skipping stale cross-team send result for old run ${run.runId}`
              );
              return;
            }
            const msg: InboxMessage = {
              from: leadName,
              to: recipient.startsWith('cross-team:')
                ? recipient
                : this.isCrossTeamToolRecipientName(recipient)
                  ? `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`
                  : `${crossTeamRecipient.teamName}.${crossTeamRecipient.memberName}`,
              text: strippedCrossTeamContent,
              timestamp,
              read: true,
              summary:
                (summary || strippedCrossTeamContent).length > 60
                  ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
                  : summary || strippedCrossTeamContent,
              messageId: result.messageId,
              source: 'cross_team_sent',
              conversationId: crossTeamMeta?.conversationId ?? replyMeta?.conversationId,
              replyToConversationId:
                replyMeta?.replyToConversationId ??
                crossTeamMeta?.conversationId ??
                replyMeta?.conversationId,
              ...(taskRefs ? { taskRefs } : {}),
            };
            this.pushLiveLeadProcessMessage(run.teamName, msg);
            this.teamChangeEmitter?.({
              type: 'lead-message',
              teamName: run.teamName,
              runId: run.runId,
              detail: 'cross-team-send',
            });
          })
          .catch((error: unknown) => {
            logger.warn(
              `[${run.teamName}] qualified SendMessage→${recipient} cross-team fallback failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          });
        continue;
      }

      if (this.isCrossTeamToolRecipientName(recipient)) {
        continue;
      }

      if (!isNativeSendMessage) {
        continue;
      }

      // Suppress SendMessage(to="user") during member_inbox_relay.
      // Context: when relaying inbox messages, the lead sometimes ignores the relay
      // instruction and responds to the user directly instead of forwarding to the
      // target teammate. This filter prevents that wrong response from appearing
      // in the UI and being persisted to sentMessages.json.
      // Note: teammate DM relay is currently disabled (see teams.ts handleSendMessage
      // and index.ts FileWatcher). This guard is kept as safety net in case relay
      // is re-enabled in the future.
      if (recipient === 'user' && run.silentUserDmForward?.mode === 'member_inbox_relay') {
        logger.debug(
          `[${run.teamName}] Suppressed SendMessage→user during member_inbox_relay to "${run.silentUserDmForward.target}"`
        );
        continue;
      }

      const relayOfMessageId =
        recipient !== 'user'
          ? this.consumePendingInboxRelayCandidate(
              run,
              recipient,
              strippedCrossTeamContent,
              summary
            )
          : undefined;

      const msg: InboxMessage = {
        from: leadName,
        to: recipient,
        text: strippedCrossTeamContent,
        timestamp: nowIso(),
        read: recipient !== 'user',
        summary:
          (summary || strippedCrossTeamContent).length > 60
            ? (summary || strippedCrossTeamContent).slice(0, 57) + '...'
            : summary || strippedCrossTeamContent,
        messageId: `lead-sendmsg-${run.runId}-${Date.now()}`,
        ...(relayOfMessageId ? { relayOfMessageId } : {}),
        source: 'lead_process',
      };

      this.pushLiveLeadProcessMessage(run.teamName, msg);

      if (recipient === 'user') {
        // User-directed messages go to sentMessages.json (canonical outbound store)
        this.persistSentMessage(run.teamName, msg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: 'sentMessages.json',
        });
      } else {
        // Non-user messages go to canonical recipient inbox for relay delivery
        this.persistInboxMessage(run.teamName, recipient, msg);
        this.teamChangeEmitter?.({
          type: 'inbox',
          teamName: run.teamName,
          detail: `inboxes/${recipient}.json`,
        });
      }

      logger.debug(
        `[${run.teamName}] Captured SendMessage→${recipient} from stdout: ${cleanContent.slice(0, 100)}`
      );
    }
  }

  pushLiveLeadProcessMessage(teamName: string, message: InboxMessage): void {
    let cacheMessage = message;
    // Enrich with leadSessionId if missing — needed for session boundary separators
    if (!cacheMessage.leadSessionId) {
      const runId = this.getTrackedRunId(teamName);
      if (runId) {
        const run = this.runs.get(runId);
        if (run?.detectedSessionId) {
          cacheMessage = { ...cacheMessage, leadSessionId: run.detectedSessionId };
        }
      }
    }
    cacheMessage = boundLiveLeadProcessMessage(cacheMessage);
    const list = this.liveLeadProcessMessages.get(teamName) ?? [];
    const id = typeof cacheMessage.messageId === 'string' ? cacheMessage.messageId.trim() : '';
    if (id) {
      const existingIdx = list.findIndex((m) => (m.messageId ?? '').trim() === id);
      if (existingIdx >= 0) {
        list[existingIdx] = cacheMessage;
      } else {
        list.push(cacheMessage);
      }
    } else {
      list.push(cacheMessage);
    }
    if (list.length > LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT) {
      list.splice(0, list.length - LIVE_LEAD_PROCESS_MESSAGE_CACHE_LIMIT);
    }
    this.liveLeadProcessMessages.set(teamName, list);
  }

  resolveCrossTeamReplyMetadata(
    teamName: string,
    toTeam: string
  ): { conversationId: string; replyToConversationId: string } | null {
    const runId = this.getAliveRunId(teamName);
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
    return capture.textParts.join(capture.textJoinMode === 'stream' ? '' : '\n').trim();
  }

  private resetLiveLeadTextBuffer(run: ProvisioningRun): void {
    run.liveLeadTextBuffer = null;
  }

  private appendProvisioningAssistantText(
    run: ProvisioningRun,
    msg: Record<string, unknown>,
    text: string
  ): void {
    const normalized = text.trim();
    if (normalized.length === 0) {
      return;
    }

    const stableMessageId = getStableLeadThoughtMessageId(msg);
    if (stableMessageId) {
      const existingIndex = run.provisioningOutputIndexByMessageId.get(stableMessageId);
      if (existingIndex != null) {
        run.provisioningOutputParts[existingIndex] = text;
        boundRunProvisioningOutputParts(run);
        return;
      }
    }

    const lastIndex = run.provisioningOutputParts.length - 1;
    if (lastIndex >= 0 && run.provisioningOutputParts[lastIndex]?.trim() === normalized) {
      return;
    }

    const newIndex = run.provisioningOutputParts.push(text) - 1;
    if (stableMessageId) {
      run.provisioningOutputIndexByMessageId.set(stableMessageId, newIndex);
    }
    boundRunProvisioningOutputParts(run);
  }

  private shiftProvisioningOutputIndexesAfterRemoval(
    run: ProvisioningRun,
    removedIndex: number
  ): void {
    for (const [messageId, index] of run.provisioningOutputIndexByMessageId.entries()) {
      if (index > removedIndex) {
        run.provisioningOutputIndexByMessageId.set(messageId, index - 1);
      }
    }
  }

  private pushLiveLeadTextMessage(
    run: ProvisioningRun,
    cleanText: string,
    stableMessageId?: string,
    messageTimestamp?: string,
    options?: { coalesceStreamChunk?: boolean }
  ): void {
    const leadName = this.getRunLeadName(run);
    const timestamp =
      typeof messageTimestamp === 'string' &&
      messageTimestamp.trim().length > 0 &&
      Number.isFinite(Date.parse(messageTimestamp))
        ? messageTimestamp
        : nowIso();
    const coalesceStreamChunk = options?.coalesceStreamChunk === true;
    let messageId = stableMessageId;
    let text = cleanText;
    let timestampForMessage = timestamp;
    let toolCalls: ToolCallMeta[] | undefined;
    let toolSummary: string | undefined;

    if (coalesceStreamChunk) {
      if (!run.liveLeadTextBuffer) {
        run.leadMsgSeq += 1;
        toolCalls = run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
        toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
        run.liveLeadTextBuffer = {
          messageId: `lead-turn-${run.runId}-${run.leadMsgSeq}`,
          text: boundLiveLeadProcessText(cleanText),
          timestamp,
          toolCalls,
          toolSummary,
        };
        run.pendingToolCalls = [];
      } else {
        run.liveLeadTextBuffer.text = boundLiveLeadProcessText(
          run.liveLeadTextBuffer.text + cleanText
        );
      }

      messageId = run.liveLeadTextBuffer.messageId;
      text = stripAgentBlocks(run.liveLeadTextBuffer.text).trim();
      timestampForMessage = run.liveLeadTextBuffer.timestamp;
      toolCalls = run.liveLeadTextBuffer.toolCalls;
      toolSummary = run.liveLeadTextBuffer.toolSummary;
    } else {
      this.resetLiveLeadTextBuffer(run);
      run.leadMsgSeq += 1;
      messageId = messageId || `lead-turn-${run.runId}-${run.leadMsgSeq}`;
      // Attach accumulated tool call details from preceding tool_use messages, then reset.
      toolCalls = run.pendingToolCalls.length > 0 ? [...run.pendingToolCalls] : undefined;
      toolSummary = toolCalls ? formatToolSummaryFromCalls(toolCalls) : undefined;
      run.pendingToolCalls = [];
    }

    const leadMsg: InboxMessage = {
      from: leadName,
      text,
      timestamp: timestampForMessage,
      read: true,
      summary: text.length > 60 ? text.slice(0, 57) + '...' : text,
      messageId,
      source: 'lead_process',
      toolSummary,
      toolCalls,
    };
    this.pushLiveLeadProcessMessage(run.teamName, leadMsg);

    // Coalesced refresh: at most one event per LEAD_TEXT_EMIT_THROTTLE_MS per team.
    const now = Date.now();
    if (now - run.lastLeadTextEmitMs >= TeamProvisioningService.LEAD_TEXT_EMIT_THROTTLE_MS) {
      run.lastLeadTextEmitMs = now;
      this.teamChangeEmitter?.({
        type: 'lead-message',
        teamName: run.teamName,
        runId: run.runId,
        detail: 'lead-text',
      });
    }
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
      getTrackedRunId: (teamName) => this.getTrackedRunId(teamName),
      getAliveRunId: (teamName) => this.getAliveRunId(teamName),
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
      deleteAliveRunId: (teamName) => this.deleteAliveRunId(teamName),
      killTeamProcess,
      updateProgress,
      cleanupRun: (run) => this.cleanupRun(run),
      logger,
    });
  }

  private getShutdownTrackedTeamNames(): string[] {
    const teamNames = new Set<string>();
    for (const teamName of this.provisioningRunByTeam.keys()) teamNames.add(teamName);
    for (const teamName of this.aliveRunByTeam.keys()) teamNames.add(teamName);
    for (const teamName of this.runtimeAdapterRunByTeam.keys()) teamNames.add(teamName);
    for (const teamName of this.secondaryRuntimeRunByTeam.keys()) teamNames.add(teamName);
    for (const teamName of this.teamOpLocks.keys()) teamNames.add(teamName);
    for (const progress of this.getPendingRuntimeAdapterLaunchesForShutdown()) {
      teamNames.add(progress.teamName);
    }
    return Array.from(teamNames);
  }

  private async stopTrackedTeamsForShutdown(label: string): Promise<string[]> {
    const teamNames = this.getShutdownTrackedTeamNames();
    if (teamNames.length === 0) {
      return teamNames;
    }

    logger.info(`${label}: stopping tracked team processes: ${teamNames.join(', ')}`);
    await Promise.all(
      teamNames.map((teamName) =>
        this.stopTeam(teamName).catch((error) => {
          logger.warn(
            `[${teamName}] Failed to stop team during shutdown: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
      )
    );
    return teamNames;
  }

  private async cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void> {
    const pendingRuntimeLaunches = this.getPendingRuntimeAdapterLaunchesForShutdown();
    if (pendingRuntimeLaunches.length === 0) {
      return;
    }

    logger.info(
      `Cancelling pending OpenCode runtime adapter launches on shutdown: ${pendingRuntimeLaunches
        .map((progress) => progress.teamName)
        .join(', ')}`
    );
    await Promise.all(
      pendingRuntimeLaunches.map((progress) =>
        this.cancelRuntimeAdapterProvisioning(progress.runId, progress).catch((error) => {
          logger.warn(
            `[${progress.teamName}] Failed to cancel pending OpenCode runtime adapter launch on shutdown: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        })
      )
    );
  }

  private async waitForInFlightTeamOperationsForShutdown(timeoutMs = 2_000): Promise<void> {
    const locks = Array.from(this.teamOpLocks.values());
    if (locks.length === 0) {
      return;
    }

    let timedOut = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    await Promise.race([
      Promise.allSettled(locks).then(() => undefined),
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          timedOut = true;
          resolve();
        }, timeoutMs);
        timeout.unref?.();
      }),
    ]);
    if (timeout) {
      clearTimeout(timeout);
    }
    if (timedOut) {
      logger.warn(
        `Timed out after ${timeoutMs}ms waiting for in-flight team operations during shutdown`
      );
    }
  }

  private killTransientProbeProcessesForShutdown(): void {
    for (const child of Array.from(this.transientProbeProcesses)) {
      try {
        killProcessTree(child);
      } catch (error) {
        logger.debug(
          `Failed to kill transient probe process during shutdown: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private async stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void> {
    const secondaryRuns = this.getSecondaryRuntimeRuns(teamName);
    if (secondaryRuns.length === 0) {
      return;
    }
    this.stoppingSecondaryRuntimeTeams.add(teamName);
    try {
      const adapter = this.getOpenCodeRuntimeAdapter();
      const previousLaunchState = await this.launchStateStore.read(teamName);
      if (!adapter) {
        await Promise.all(
          secondaryRuns.map((secondaryRun) =>
            clearOpenCodeRuntimeLaneStorage({
              teamsBasePath: getTeamsBasePath(),
              teamName,
              laneId: secondaryRun.laneId,
            }).catch(() => undefined)
          )
        );
        this.clearSecondaryRuntimeRuns(teamName);
        return;
      }
      try {
        for (const secondaryRun of secondaryRuns) {
          await clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: getTeamsBasePath(),
            teamName,
            laneId: secondaryRun.laneId,
          }).catch(() => undefined);
          try {
            await adapter.stop({
              runId: secondaryRun.runId,
              laneId: secondaryRun.laneId,
              teamName,
              cwd: secondaryRun.cwd ?? this.readPersistedTeamProjectPath(teamName) ?? undefined,
              providerId: 'opencode',
              reason: 'user_requested',
              previousLaunchState,
              force: true,
            });
          } catch (error) {
            logger.warn(
              `[${teamName}] Failed to stop mixed OpenCode secondary lane ${secondaryRun.laneId}: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          } finally {
            await clearOpenCodeRuntimeLaneStorage({
              teamsBasePath: getTeamsBasePath(),
              teamName,
              laneId: secondaryRun.laneId,
            }).catch(() => undefined);
            this.deleteSecondaryRuntimeRun(teamName, secondaryRun.laneId);
          }
        }
      } finally {
        this.clearSecondaryRuntimeRuns(teamName);
      }
    } finally {
      this.stoppingSecondaryRuntimeTeams.delete(teamName);
    }
  }

  private async stopOpenCodeAggregateRuntimeLanes(
    teamName: string,
    aggregateRunId: string
  ): Promise<void> {
    const stops: Promise<void>[] = [];
    const primaryRun = this.runtimeAdapterRunByTeam.get(teamName);
    if (primaryRun?.providerId === 'opencode' && primaryRun.runId === aggregateRunId) {
      stops.push(this.stopOpenCodeRuntimeAdapterTeam(teamName, aggregateRunId));
    }
    if (this.hasSecondaryRuntimeRuns(teamName)) {
      stops.push(this.stopMixedSecondaryRuntimeLanes(teamName));
    }
    await Promise.all(stops);
  }

  private async stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void> {
    const adapter = this.getOpenCodeRuntimeAdapter();
    const previousLaunchState = await this.launchStateStore.read(teamName);
    if (!adapter) {
      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
      }).catch(() => undefined);
      this.runtimeAdapterRunByTeam.delete(teamName);
      this.deleteAliveRunId(teamName);
      this.provisioningRunByTeam.delete(teamName);
      this.invalidateRuntimeSnapshotCaches(teamName);
      return;
    }
    const startedAt = nowIso();
    const previousProgress = this.runtimeAdapterProgressByRunId.get(runId);
    const runtimeRun = this.runtimeAdapterRunByTeam.get(teamName);
    this.setRuntimeAdapterProgress({
      runId,
      teamName,
      state: 'disconnected',
      message: 'Stopping OpenCode team through runtime adapter',
      startedAt: previousProgress?.startedAt ?? startedAt,
      updatedAt: startedAt,
    });
    this.clearOpenCodeRuntimeToolApprovals(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    this.runtimeAdapterRunByTeam.delete(teamName);
    this.deleteAliveRunId(teamName);
    if (this.provisioningRunByTeam.get(teamName) === runId) {
      this.provisioningRunByTeam.delete(teamName);
    }
    this.invalidateRuntimeSnapshotCaches(teamName);
    try {
      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
      }).catch(() => undefined);
      const result = await adapter.stop({
        runId,
        laneId: 'primary',
        teamName,
        cwd: runtimeRun?.cwd ?? this.readPersistedTeamProjectPath(teamName) ?? undefined,
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState,
        force: true,
      });
      await this.writeLaunchStateSnapshot(
        teamName,
        createPersistedLaunchSnapshot({
          teamName,
          expectedMembers: previousLaunchState?.expectedMembers ?? [],
          leadSessionId: previousLaunchState?.leadSessionId,
          launchPhase: 'reconciled',
          members: previousLaunchState?.members ?? {},
        })
      );
      this.setRuntimeAdapterProgress({
        runId,
        teamName,
        state: result.stopped ? 'disconnected' : 'failed',
        message: result.stopped ? 'OpenCode team stopped' : 'OpenCode team stop failed',
        messageSeverity: result.stopped ? undefined : 'error',
        startedAt: previousProgress?.startedAt ?? startedAt,
        updatedAt: nowIso(),
        cliLogsTail: result.diagnostics.join('\n') || undefined,
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setRuntimeAdapterProgress({
        runId,
        teamName,
        state: 'failed',
        message: 'OpenCode team stop failed',
        messageSeverity: 'error',
        startedAt: previousProgress?.startedAt ?? startedAt,
        updatedAt: nowIso(),
        error: message,
        cliLogsTail: message,
      });
    } finally {
      await clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: getTeamsBasePath(),
        teamName,
        laneId: 'primary',
      }).catch(() => undefined);
      this.runtimeAdapterRunByTeam.delete(teamName);
      this.deleteAliveRunId(teamName);
      this.provisioningRunByTeam.delete(teamName);
      this.teamChangeEmitter?.({
        type: 'process',
        teamName,
        runId,
        detail: 'stopped',
      });
    }
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

  private clonePersistedRuntimeMember(
    member: PersistedRuntimeMemberLike
  ): PersistedRuntimeMemberLike {
    return { ...member };
  }

  private isPersistedRuntimeMemberLike(member: unknown): member is PersistedRuntimeMemberLike {
    return !!member && typeof member === 'object';
  }

  private readPersistedTeamConfig(teamName: string): PersistedTeamConfigCacheEntry | null {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    let stat: fs.Stats;
    try {
      stat = fs.statSync(configPath);
    } catch {
      this.persistedTeamConfigCache.delete(teamName);
      return null;
    }

    const cached = this.persistedTeamConfigCache.get(teamName);
    if (
      cached &&
      cached.path === configPath &&
      cached.size === stat.size &&
      cached.mtimeMs === stat.mtimeMs &&
      cached.ctimeMs === stat.ctimeMs
    ) {
      return cached;
    }

    try {
      const raw = fs.readFileSync(configPath, 'utf8');
      const parsed = JSON.parse(raw) as { projectPath?: unknown; members?: unknown };
      const projectPath = typeof parsed.projectPath === 'string' ? parsed.projectPath.trim() : '';
      const members = Array.isArray(parsed.members)
        ? parsed.members
            .filter((member): member is PersistedRuntimeMemberLike =>
              this.isPersistedRuntimeMemberLike(member)
            )
            .map((member) => this.clonePersistedRuntimeMember(member))
        : [];
      const entry: PersistedTeamConfigCacheEntry = {
        path: configPath,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        projectPath: projectPath || null,
        members,
      };
      this.persistedTeamConfigCache.set(teamName, entry);
      return entry;
    } catch {
      this.persistedTeamConfigCache.delete(teamName);
      return null;
    }
  }

  private readPersistedTeamProjectPath(teamName: string): string | null {
    return this.readPersistedTeamConfig(teamName)?.projectPath ?? null;
  }

  private readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[] {
    return (
      this.readPersistedTeamConfig(teamName)?.members.map((member) =>
        this.clonePersistedRuntimeMember(member)
      ) ?? []
    );
  }

  private listPersistedTeamNames(): string[] {
    try {
      return fs
        .readdirSync(getTeamsBasePath(), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name.trim())
        .filter((name) => name.length > 0);
    } catch {
      return [];
    }
  }

  private killPersistedPaneMembers(teamName: string, members: PersistedRuntimeMemberLike[]): void {
    for (const member of members) {
      const name = typeof member.name === 'string' ? member.name.trim() : '';
      const paneId = typeof member.tmuxPaneId === 'string' ? member.tmuxPaneId.trim() : '';
      const backendType =
        typeof member.backendType === 'string' ? member.backendType.trim().toLowerCase() : '';
      if (!name || name === 'team-lead' || !paneId || backendType !== 'tmux') {
        continue;
      }
      try {
        killTmuxPaneForCurrentPlatformSync(paneId);
        logger.info(`[${teamName}] Killed teammate pane ${name} (${paneId}) during stop`);
      } catch (error) {
        logger.debug(
          `[${teamName}] Failed to kill teammate pane ${name} (${paneId}) during stop: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
  }

  private killOrphanedTeamAgentProcesses(teamName: string): void {
    const currentRunPid = this.getTrackedRunId(teamName)
      ? this.runs.get(this.getTrackedRunId(teamName)!)?.child?.pid
      : undefined;
    const pids = new Set<number>();
    const rows: { pid: number; command: string }[] = [];

    if (process.platform === 'win32') {
      try {
        rows.push(
          ...listWindowsProcessTableSync().map((row) => ({ pid: row.pid, command: row.command }))
        );
      } catch {
        return;
      }
    } else {
      let output = '';
      try {
        output = execFileSync('ps', ['-ax', '-o', 'pid=,command='], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        });
      } catch {
        return;
      }

      for (const line of output.split('\n')) {
        const trimmed = line.trim();
        const match = /^(\d+)\s+(.*)$/.exec(trimmed);
        if (!match) continue;
        const pid = Number.parseInt(match[1], 10);
        if (!Number.isFinite(pid) || pid <= 0) continue;
        rows.push({ pid, command: match[2] ?? '' });
      }
    }

    for (const row of rows) {
      if (
        !commandArgEquals(row.command, '--team-name', teamName) ||
        !row.command.includes('--agent-id')
      ) {
        continue;
      }
      if (currentRunPid && row.pid === currentRunPid) continue;
      pids.add(row.pid);
    }

    for (const pid of pids) {
      try {
        killProcessByPid(pid);
        logger.info(`[${teamName}] Killed orphaned teammate process pid=${pid} during stop`);
      } catch (error) {
        logger.debug(
          `[${teamName}] Failed to kill orphaned teammate process pid=${pid}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }
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
      getShutdownTrackedTeamNames: () => this.getShutdownTrackedTeamNames(),
      pauseActiveIntervalsForTeam: (teamName) =>
        this.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
      killTrackedCliProcesses,
      killTransientProbeProcessesForShutdown: () => this.killTransientProbeProcessesForShutdown(),
      stopTrackedTeamsForShutdown: (label) => this.stopTrackedTeamsForShutdown(label),
      cancelPendingRuntimeAdapterLaunchesForShutdown: () =>
        this.cancelPendingRuntimeAdapterLaunchesForShutdown(),
      waitForInFlightTeamOperationsForShutdown: () =>
        this.waitForInFlightTeamOperationsForShutdown(),
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
        this.updateLeadContextUsageFromUsage(run, usage, modelName),
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
    // Consume the pending flag immediately — strict one-shot policy.
    run.pendingPostCompactReminder = false;

    // Guard: process must be alive and writable.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder skipped — process not writable or killed`
      );
      return;
    }

    // Guard: don't inject if another turn is actively processing (race with user send / inbox relay).
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — lead is ${run.leadActivityState}, not idle`
      );
      // Re-arm so it triggers on next idle.
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a relay capture is in-flight.
    if (run.leadRelayCapture) {
      logger.info(`[${run.teamName}] post-compact reminder deferred — relay capture in-flight`);
      run.pendingPostCompactReminder = true;
      return;
    }

    // Guard: don't inject while a silent DM forward is in progress.
    if (run.silentUserDmForward) {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — silent DM forward in progress`
      );
      run.pendingPostCompactReminder = true;
      return;
    }

    // Read current team config for up-to-date members (may have changed since launch).
    let currentMembers: TeamCreateRequest['members'] = run.request.members;
    let leadName = 'team-lead';
    try {
      const config = await this.readConfigForObservation(run.teamName);
      if (config?.members) {
        const configLead = config.members.find((m) => isLeadMember(m));
        leadName = configLead?.name?.trim() || 'team-lead';
        // Convert config members (excluding lead) to TeamCreateRequest member format.
        const configTeammates = config.members
          .filter((m) => !isLeadMember(m) && m?.name)
          .map((m) => ({
            name: m.name,
            role: m.role ?? undefined,
          }));
        // When config.members only has the lead (pre-created config without
        // TeamCreate), fall back to run.request.members for the teammate list.
        if (configTeammates.length > 0) {
          currentMembers = configTeammates;
        }
      } else {
        leadName =
          run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
          'team-lead';
      }
    } catch {
      // Fallback to launch-time members if config is unavailable.
      leadName =
        run.request.members.find((m) => m.role?.toLowerCase().includes('lead'))?.name ||
        'team-lead';
      logger.warn(
        `[${run.teamName}] post-compact reminder: config unavailable, using launch-time members`
      );
    }
    const isSolo = currentMembers.length === 0;

    // Build persistent lead context.
    const persistentContext = buildPersistentLeadContext({
      teamName: run.teamName,
      leadName,
      isSolo,
      members: currentMembers,
      compact: true,
    });

    // Best-effort: fetch fresh task board snapshot.
    let taskBoardBlock = '';
    try {
      const taskReader = new TeamTaskReader();
      const tasks = await taskReader.getTasks(run.teamName);
      taskBoardBlock = buildTaskBoardSnapshot(tasks);
    } catch {
      // If tasks can't be read, inject without the snapshot.
      logger.warn(`[${run.teamName}] post-compact reminder: task board snapshot unavailable`);
    }

    // Re-check guards after async work.
    if (!run.child?.stdin?.writable || run.processKilled || run.cancelRequested) {
      logger.warn(
        `[${run.teamName}] post-compact reminder aborted — process state changed during preparation`
      );
      return;
    }
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] post-compact reminder deferred — lead activity changed to ${run.leadActivityState as string}`
      );
      // Re-arm so it triggers on next idle.
      run.pendingPostCompactReminder = true;
      return;
    }

    const message = [
      `Apply these standing rules and current team state before responding:`,
      ``,
      `You are "${leadName}", the team lead of team "${run.teamName}".`,
      `You are running in a non-interactive CLI session. Do not ask questions.`,
      `CRITICAL: Execute ALL steps directly yourself in sequence. Do NOT delegate any step to a sub-agent via the Agent tool. The ONLY valid use of the Agent tool is spawning individual teammates.`,
      ``,
      persistentContext,
      taskBoardBlock.trim() ? `\n${taskBoardBlock}` : '',
      ``,
      `Do NOT start new work or execute tasks in this turn. Reply with one concise user-facing team status line about board readiness and teammate availability. Only report board readiness and teammate availability.`,
    ]
      .filter(Boolean)
      .join('\n');

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });

    run.postCompactReminderInFlight = true;
    run.suppressPostCompactReminderOutput = true;
    this.setLeadActivity(run, 'active');

    try {
      const stdin = run.child.stdin;
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`[${run.teamName}] post-compact reminder injected`);
    } catch (error) {
      // Strict drop-after-attempt — do not re-arm.
      clearPostCompactReminderState(run);
      this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
      this.setLeadActivity(run, 'idle');
      logger.warn(
        `[${run.teamName}] post-compact reminder injection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  private async injectGeminiPostLaunchHydration(run: ProvisioningRun): Promise<void> {
    run.pendingGeminiPostLaunchHydration = false;

    if (
      run.geminiPostLaunchHydrationSent ||
      !run.child?.stdin?.writable ||
      run.processKilled ||
      run.cancelRequested
    ) {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration skipped — process not writable, killed, or already sent`
      );
      return;
    }

    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — lead is ${run.leadActivityState}, not idle`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    if (run.leadRelayCapture) {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — relay capture in-flight`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    if (run.silentUserDmForward) {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — silent DM forward in progress`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    let currentMembers: TeamCreateRequest['members'] = run.effectiveMembers;
    let leadName =
      run.effectiveMembers.find((m) => m.role?.toLowerCase().includes('lead'))?.name || 'team-lead';
    try {
      const config = await this.readConfigForObservation(run.teamName);
      if (config?.members) {
        const configLead = config.members.find((m) => isLeadMember(m));
        leadName = configLead?.name?.trim() || leadName;
        const configTeammates = config.members
          .filter((m) => !isLeadMember(m) && m?.name)
          .map((m) => ({
            name: m.name,
            role: m.role ?? undefined,
          }));
        if (configTeammates.length > 0) {
          const launchMembersByName = new Map(
            run.effectiveMembers.map((member) => [member.name, member] as const)
          );
          currentMembers = configTeammates.map((member) => ({
            ...launchMembersByName.get(member.name),
            ...member,
          }));
        }
      }
    } catch {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration: config unavailable, using launch-time members`
      );
    }

    let tasks: TeamTask[] = [];
    try {
      tasks = await new TeamTaskReader().getTasks(run.teamName);
    } catch {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration: task board snapshot unavailable`
      );
    }

    if (
      run.geminiPostLaunchHydrationSent ||
      !run.child?.stdin?.writable ||
      run.processKilled ||
      run.cancelRequested
    ) {
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration aborted — process state changed during preparation`
      );
      return;
    }
    if (run.leadActivityState !== 'idle') {
      logger.info(
        `[${run.teamName}] Gemini post-launch hydration deferred — lead activity changed to ${run.leadActivityState as string}`
      );
      run.pendingGeminiPostLaunchHydration = true;
      return;
    }

    const message = buildGeminiPostLaunchHydrationPrompt(run, leadName, currentMembers, tasks);
    const promptSize = getPromptSizeSummary(message);
    logger.info(
      `[${run.teamName}] Gemini post-launch hydration prepared (${promptSize.chars} chars / ${promptSize.lines} lines)`
    );

    const payload = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
    });

    run.geminiPostLaunchHydrationInFlight = true;
    run.geminiPostLaunchHydrationSent = true;
    run.suppressGeminiPostLaunchHydrationOutput = true;
    this.setLeadActivity(run, 'active');

    try {
      const stdin = run.child.stdin;
      await new Promise<void>((resolve, reject) => {
        stdin.write(payload + '\n', (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      logger.info(`[${run.teamName}] Gemini post-launch hydration injected`);
    } catch (error) {
      run.geminiPostLaunchHydrationInFlight = false;
      run.geminiPostLaunchHydrationSent = false;
      run.suppressGeminiPostLaunchHydrationOutput = false;
      this.resetRuntimeToolActivity(run, this.getRunLeadName(run));
      this.setLeadActivity(run, 'idle');
      logger.warn(
        `[${run.teamName}] Gemini post-launch hydration injection failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /**
   * Handles a control_request message from CLI stream-json output.
   * `can_use_tool` → emits to renderer for manual approval.
   * All other subtypes (hook_callback, etc.) → auto-allowed to prevent deadlock.
   */
  private handleControlRequest(run: ProvisioningRun, msg: Record<string, unknown>): void {
    const requestId = typeof msg.request_id === 'string' ? msg.request_id : null;
    if (!requestId) {
      logger.warn(`[${run.teamName}] control_request missing request_id, ignoring`);
      return;
    }

    const request = msg.request as Record<string, unknown> | undefined;
    const subtype = request?.subtype;

    // Non-`can_use_tool` subtypes (hook_callback, etc.) are auto-allowed to prevent
    // CLI deadlock — hooks are user-configured and should not block on manual approval.
    if (subtype !== 'can_use_tool') {
      logger.debug(
        `[${run.teamName}] control_request subtype=${String(subtype)}, auto-allowing to prevent deadlock`
      );
      this.autoAllowControlRequest(run, requestId);
      return;
    }

    const toolName = typeof request?.tool_name === 'string' ? request.tool_name : 'Unknown';
    const toolInput = (request?.input ?? {}) as Record<string, unknown>;
    const providerId = toolInput.provider === 'codex' ? 'codex' : undefined;

    const approval: ToolApprovalRequest = {
      requestId,
      runId: run.runId,
      teamName: run.teamName,
      ...(providerId ? { providerId } : {}),
      source: 'lead',
      toolName,
      toolInput,
      receivedAt: new Date().toISOString(),
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
    };

    // Check auto-allow rules before prompting user
    const autoResult = shouldAutoAllow(
      this.getToolApprovalSettings(run.teamName),
      toolName,
      toolInput
    );
    if (autoResult.autoAllow) {
      logger.info(`[${run.teamName}] Auto-allowing ${toolName} (${autoResult.reason})`);
      this.autoAllowControlRequest(run, requestId);
      this.emitToolApprovalEvent(
        buildToolApprovalAutoResolvedEvent({
          requestId,
          runId: run.runId,
          teamName: run.teamName,
          reason: 'auto_allow_category',
        })
      );
      return;
    }

    run.pendingApprovals.set(requestId, approval);
    this.emitToolApprovalEvent(approval);
    this.startApprovalTimeout(run, requestId);

    // Show OS notification when window is not focused
    this.maybeShowToolApprovalOsNotification(run, approval);
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
    // Skip if already tracked (idempotency — multiple paths can trigger this:
    // early inbox scan, stdout parsing, native message blocks, relay Category 4)
    if (run.processedPermissionRequestIds.has(perm.requestId)) return;
    if (run.pendingApprovals.has(perm.requestId)) return;
    run.processedPermissionRequestIds.add(perm.requestId);

    logger.warn(
      `[${run.teamName}] [PERM-TRACE] handleTeammatePermissionRequest: agent=${perm.agentId} tool=${perm.toolName} requestId=${perm.requestId}`
    );

    const approval: ToolApprovalRequest = {
      requestId: perm.requestId,
      runId: run.runId,
      teamName: run.teamName,
      source: perm.agentId,
      toolName: perm.toolName,
      toolInput: perm.input,
      receivedAt: messageTimestamp || new Date().toISOString(),
      teamColor: run.request.color,
      teamDisplayName: run.request.displayName,
      permissionSuggestions:
        perm.permissionSuggestions.length > 0 ? perm.permissionSuggestions : undefined,
    };

    const autoResult = shouldAutoAllow(
      this.getToolApprovalSettings(run.teamName),
      perm.toolName,
      perm.input
    );
    if (autoResult.autoAllow) {
      logger.info(
        `[${run.teamName}] Auto-allowing teammate ${perm.agentId} ${perm.toolName} (${autoResult.reason})`
      );
      void this.respondToTeammatePermission(
        run,
        perm.agentId,
        perm.requestId,
        true,
        undefined,
        perm.permissionSuggestions,
        perm.toolName,
        perm.input
      );
      this.emitToolApprovalEvent(
        buildToolApprovalAutoResolvedEvent({
          requestId: perm.requestId,
          runId: run.runId,
          teamName: run.teamName,
          reason: 'auto_allow_category',
        })
      );
      return;
    }

    run.pendingApprovals.set(perm.requestId, approval);
    this.emitToolApprovalEvent(approval);
    this.startApprovalTimeout(run, perm.requestId);
    this.maybeShowToolApprovalOsNotification(run, approval);
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
    const win = this.mainWindowRef;
    if (win && !win.isDestroyed() && win.isFocused()) return;

    const config = ConfigManager.getInstance().getConfig();
    if (!config.notifications.enabled || !config.notifications.notifyOnToolApproval) return;

    // Respect snooze — consistent with other notification types
    const snoozedUntil = config.notifications.snoozedUntil;
    if (snoozedUntil && Date.now() < snoozedUntil) return;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Notification: ElectronNotification } = require('electron') as Partial<
      typeof import('electron')
    >;
    if (!ElectronNotification?.isSupported?.()) return;

    const isMac = process.platform === 'darwin';
    const isLinux = process.platform === 'linux';
    const iconPath = isMac ? undefined : getAppIconPath();
    const teamLabel = approval.teamDisplayName ?? run?.request.displayName ?? approval.teamName;
    const body = formatToolApprovalBody(approval.toolName, approval.toolInput);

    // Actions (Allow/Deny buttons) supported on macOS and Windows.
    // Linux libnotify doesn't fire the 'action' event — users get click-to-focus.
    const supportsActions = !isLinux;

    const notification = new ElectronNotification({
      title: `Tool Approval — ${teamLabel}`,
      body,
      sound: config.notifications.soundEnabled ? 'default' : undefined,
      ...(iconPath ? { icon: iconPath } : {}),
      ...(supportsActions
        ? {
            actions: [
              { type: 'button' as const, text: 'Allow' },
              { type: 'button' as const, text: 'Deny' },
            ],
          }
        : {}),
    });

    // Track by requestId so we can close it when approval is resolved via UI
    this.activeApprovalNotifications.set(approval.requestId, notification);
    const cleanup = (): void => {
      this.activeApprovalNotifications.delete(approval.requestId);
    };

    notification.on('click', () => {
      cleanup();
      // Use current mainWindowRef (not captured `win`) in case window was recreated
      const currentWin = this.mainWindowRef;
      if (currentWin && !currentWin.isDestroyed()) {
        currentWin.show();
        currentWin.focus();
      }
    });

    notification.on('close', cleanup);

    // Action buttons: Allow (index 0) / Deny (index 1)
    // 'action' event fires on macOS and Windows (not Linux)
    if (supportsActions) {
      notification.on('action', (_event, index) => {
        cleanup();
        const allow = index === 0;
        logger.info(
          `[${approval.teamName}] Tool approval ${allow ? 'allowed' : 'denied'} via OS notification`
        );
        void this.respondToToolApproval(
          approval.teamName,
          approval.runId,
          approval.requestId,
          allow,
          allow ? undefined : 'Denied via notification'
        ).catch((err) => {
          logger.error(
            `[${approval.teamName}] Failed to respond via notification: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      });
    }

    notification.show();
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
    if (!run.child?.stdin?.writable) {
      logger.warn(`[${run.teamName}] Cannot auto-allow control_request: stdin not writable`);
      return;
    }

    const response = buildAllowControlResponsePayload(requestId);

    run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
      if (err) {
        logger.error(
          `[${run.teamName}] Failed to auto-allow control_request ${requestId}: ${err.message}`
        );
      }
    });
  }

  private tryClaimResponse(requestId: string): boolean {
    if (this.inFlightResponses.has(requestId)) return false;
    this.inFlightResponses.add(requestId);
    return true;
  }

  private startApprovalTimeout(run: ProvisioningRun, requestId: string): void {
    const { timeoutAction, timeoutSeconds } = this.getToolApprovalSettings(run.teamName);
    if (timeoutAction === 'wait') return;

    const timeoutMs = timeoutSeconds * 1000;
    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(requestId);
      if (!run.pendingApprovals.has(requestId)) return;
      if (!this.tryClaimResponse(requestId)) return;

      // Read CURRENT settings (not captured closure) in case user changed action
      const currentAction = this.getToolApprovalSettings(run.teamName).timeoutAction;
      const resolution = resolveToolApprovalTimeoutAutoResolution({
        timeoutAction: currentAction,
        requestId,
        runId: run.runId,
        teamName: run.teamName,
      });
      if (!resolution) {
        // Settings changed to 'wait' but timer fired before reEvaluatePendingApprovals cleared it
        this.inFlightResponses.delete(requestId);
        return;
      }
      const { allow } = resolution;
      logger.info(`[${run.teamName}] Timeout ${allow ? 'allowing' : 'denying'} ${requestId}`);

      const approval = run.pendingApprovals.get(requestId);
      if (approval && approval.source !== 'lead') {
        // Teammate request — apply permission_suggestions to project settings.
        this.respondToTeammatePermission(
          run,
          approval.source,
          requestId,
          allow,
          allow ? undefined : resolution.teammateDenyMessage,
          approval.permissionSuggestions,
          approval.toolName,
          approval.toolInput
        ).finally(() => {
          run.pendingApprovals.delete(requestId);
          this.inFlightResponses.delete(requestId);
          this.dismissApprovalNotification(requestId);
          this.emitToolApprovalEvent(resolution.event);
        });
        return;
      }

      if (allow) {
        this.autoAllowControlRequest(run, requestId);
      } else {
        this.autoDenyControlRequest(run, requestId);
      }
      run.pendingApprovals.delete(requestId);
      this.inFlightResponses.delete(requestId);
      this.dismissApprovalNotification(requestId);

      this.emitToolApprovalEvent(resolution.event);
    }, timeoutMs);

    this.pendingTimeouts.set(requestId, timer);
  }

  private clearApprovalTimeout(requestId: string): void {
    const timer = this.pendingTimeouts.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.pendingTimeouts.delete(requestId);
    }
  }

  private autoDenyControlRequest(run: ProvisioningRun, requestId: string): void {
    if (!run.child?.stdin?.writable) {
      logger.warn(`[${run.teamName}] Cannot auto-deny control_request: stdin not writable`);
      return;
    }

    const response = buildDenyControlResponsePayload(
      requestId,
      TOOL_APPROVAL_TIMEOUT_CONTROL_DENY_MESSAGE
    );

    run.child.stdin.write(JSON.stringify(response) + '\n', (err) => {
      if (err) {
        logger.error(
          `[${run.teamName}] Failed to auto-deny control_request ${requestId}: ${err.message}`
        );
      }
    });
  }

  private reEvaluatePendingApprovals(): void {
    for (const [, run] of this.runs) {
      const settings = this.getToolApprovalSettings(run.teamName);
      const toRemove: string[] = [];
      for (const [requestId, approval] of run.pendingApprovals) {
        const result = shouldAutoAllow(settings, approval.toolName, approval.toolInput);
        if (result.autoAllow) {
          this.clearApprovalTimeout(requestId);
          if (!this.tryClaimResponse(requestId)) continue;
          if (approval.source !== 'lead') {
            void this.respondToTeammatePermission(
              run,
              approval.source,
              requestId,
              true,
              undefined,
              approval.permissionSuggestions,
              approval.toolName,
              approval.toolInput
            );
          } else {
            this.autoAllowControlRequest(run, requestId);
          }
          this.dismissApprovalNotification(requestId);
          toRemove.push(requestId);
          this.emitToolApprovalEvent(
            buildToolApprovalAutoResolvedEvent({
              requestId,
              runId: run.runId,
              teamName: run.teamName,
              reason: 'auto_allow_category',
            })
          );
        } else if (settings.timeoutAction !== 'wait' && !this.pendingTimeouts.has(requestId)) {
          // Settings changed from 'wait' to allow/deny — start timer for already pending items
          this.startApprovalTimeout(run, requestId);
        } else if (settings.timeoutAction === 'wait' && this.pendingTimeouts.has(requestId)) {
          // Settings changed TO 'wait' — clear existing timers
          this.clearApprovalTimeout(requestId);
        }
      }
      for (const requestId of toRemove) {
        run.pendingApprovals.delete(requestId);
        this.inFlightResponses.delete(requestId);
      }
    }

    this.runtimeToolApprovalCoordinator.reEvaluate();
  }

  private async answerRuntimeToolApproval(
    entry: RuntimeToolApprovalEntry,
    allow: boolean,
    _message?: string
  ): Promise<void> {
    if (entry.providerId !== 'opencode') {
      throw new Error(`Runtime approval provider is not supported: ${entry.providerId}`);
    }
    const adapter = this.getOpenCodeRuntimeAdapter();
    if (!adapter?.answerRuntimePermission) {
      throw new Error('OpenCode runtime permission answer bridge is not available');
    }

    const previousLaunchState = await this.launchStateStore.read(entry.approval.teamName);
    const result = await adapter.answerRuntimePermission({
      runId: entry.approval.runId,
      laneId: entry.laneId,
      teamName: entry.approval.teamName,
      cwd: entry.cwd ?? '',
      providerId: 'opencode',
      memberName: entry.memberName,
      requestId: entry.providerRequestId,
      decision: allow ? 'allow' : 'reject',
      expectedMembers: entry.expectedMembers ?? [],
      previousLaunchState,
    });

    if (entry.laneId === 'primary') {
      const launchInput: TeamRuntimeLaunchInput = {
        runId: entry.approval.runId,
        laneId: entry.laneId,
        teamName: entry.approval.teamName,
        cwd: entry.cwd ?? '',
        providerId: 'opencode',
        skipPermissions: false,
        expectedMembers: entry.expectedMembers ?? [],
        previousLaunchState,
      };
      const { result: committed } = await this.persistOpenCodeRuntimeAdapterLaunchResult(
        result,
        launchInput
      );
      if (!shouldRetainOpenCodeRuntimeLaunch(committed)) {
        await this.stopUnretainableOpenCodeRuntimeLane({
          adapter,
          runId: entry.approval.runId,
          laneId: 'primary',
          teamName: entry.approval.teamName,
          cwd: entry.cwd ?? '',
          previousLaunchState,
        });
        this.runtimeAdapterRunByTeam.delete(entry.approval.teamName);
        await upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: getTeamsBasePath(),
          teamName: entry.approval.teamName,
          laneId: 'primary',
          state: 'degraded',
          diagnostics: committed.diagnostics,
        }).catch(() => undefined);
        if (!this.isTeamAlive(entry.approval.teamName)) {
          this.deleteAliveRunId(entry.approval.teamName);
        }
      } else {
        this.runtimeAdapterRunByTeam.set(entry.approval.teamName, {
          runId: entry.approval.runId,
          providerId: 'opencode',
          cwd: entry.cwd,
          members: committed.members,
        });
        this.setAliveRunId(entry.approval.teamName, entry.approval.runId);
      }
      this.syncOpenCodeRuntimeToolApprovals({
        teamName: entry.approval.teamName,
        runId: entry.approval.runId,
        laneId: entry.laneId,
        cwd: entry.cwd ?? '',
        members: committed.members,
        expectedMembers: entry.expectedMembers ?? [],
        teamDisplayName: entry.approval.teamDisplayName,
        teamColor: entry.approval.teamColor,
      });
    } else {
      await this.applyOpenCodeSecondaryPermissionAnswerResult(entry, result);
    }

    this.teamChangeEmitter?.({
      type: 'process',
      teamName: entry.approval.teamName,
      runId: entry.approval.runId,
      detail: allow ? 'permission-allowed' : 'permission-denied',
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

    // Look in both provisioning and alive runs — control_requests arrive during provisioning too
    const currentRunId = this.getTrackedRunId(teamName);
    if (!currentRunId) throw new Error(`No active process for team "${teamName}"`);
    const run = this.runs.get(currentRunId);
    if (!run) throw new Error(`Run not found for team "${teamName}"`);

    if (run.runId !== runId) {
      throw new Error(`Stale approval: runId mismatch (expected ${run.runId}, got ${runId})`);
    }

    // Clear timeout and claim response FIRST (before pendingApprovals check)
    // to handle the race where timeout already responded and deleted the approval
    this.clearApprovalTimeout(requestId);
    if (!this.tryClaimResponse(requestId)) {
      // Another response is already being written; leave the pending approval tracked
      // until that write succeeds or fails.
      return;
    }

    if (!run.pendingApprovals.has(requestId)) {
      // Approval was removed (e.g. by reEvaluatePendingApprovals) — clean up claim and exit
      this.inFlightResponses.delete(requestId);
      return;
    }

    const approval = run.pendingApprovals.get(requestId)!;

    // Teammate permission requests: apply permission_suggestions to project settings
    if (approval.source !== 'lead') {
      try {
        await this.respondToTeammatePermission(
          run,
          approval.source,
          requestId,
          allow,
          message,
          approval.permissionSuggestions,
          approval.toolName,
          approval.toolInput
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
      return;
    }

    if (!run.child?.stdin?.writable) {
      this.inFlightResponses.delete(requestId);
      this.startApprovalTimeout(run, requestId);
      throw new Error(`Team "${teamName}" process stdin is not writable`);
    }

    // IMPORTANT: request_id is NESTED inside response, NOT top-level
    // (asymmetry with control_request — confirmed by Python SDK, Elixir SDK and issue #29991)
    const allowResponse: Record<string, unknown> = { behavior: 'allow', updatedInput: {} };
    // For AskUserQuestion: pass user's answers via updatedInput so the CLI
    // can deliver them without re-prompting. Format follows --permission-prompt-tool spec.
    if (allow && message) {
      const pending = run.pendingApprovals.get(requestId);
      if (pending?.toolName === 'AskUserQuestion') {
        try {
          const answers = JSON.parse(message) as Record<string, string>;
          allowResponse.updatedInput = { ...pending.toolInput, answers };
        } catch {
          // If message isn't JSON, use as-is for the first question
          const questions = (pending.toolInput.questions as { question?: string }[]) ?? [];
          const answers: Record<string, string> = {};
          if (questions[0]?.question) answers[questions[0].question] = message;
          allowResponse.updatedInput = { ...pending.toolInput, answers };
        }
      }
    }
    const response = allow
      ? buildAllowControlResponsePayload(requestId, allowResponse)
      : buildDenyControlResponsePayload(requestId, message ?? 'User denied');

    const stdin = run.child.stdin;
    const responseJson = JSON.stringify(response) + '\n';
    logger.info(
      `[${teamName}] Writing control_response for ${requestId}: ${allow ? 'allow' : 'deny'}`
    );
    try {
      await new Promise<void>((resolve, reject) => {
        // Safety timeout — if stdin.write callback is never called (e.g. process died
        // between the writable check and the write), reject instead of hanging forever.
        const writeTimeout = setTimeout(() => {
          reject(new Error(`Timeout writing control_response to stdin (process may have exited)`));
        }, 5000);

        stdin.write(responseJson, (err) => {
          clearTimeout(writeTimeout);
          if (err) {
            logger.error(`[${teamName}] Failed to write control_response: ${err.message}`);
            reject(err);
          } else {
            logger.info(`[${teamName}] control_response written successfully for ${requestId}`);
            resolve();
          }
        });
      });
    } catch (error) {
      this.inFlightResponses.delete(requestId);
      if (run.pendingApprovals.has(requestId)) {
        this.startApprovalTimeout(run, requestId);
      }
      throw error;
    }
    run.pendingApprovals.delete(requestId);
    this.inFlightResponses.delete(requestId);
    this.dismissApprovalNotification(requestId);
  }

  /**
   * Respond to a teammate's permission_request by applying permission_suggestions.
   *
   * FACT: Claude Code teammate runtime sends permission_request via the inbox protocol.
   * FACT: Teammates wait for permission_response in their own inbox.
   * FACT: control_response via the lead stdin does not reliably reach teammate request ids.
   * FACT: permission_suggestions.destination "localSettings" refers to {cwd}/.claude/settings.local.json.
   * FACT: Claude Code CLI reads this file via --setting-sources user,project,local.
   *
   * When allow=true: applies permission_suggestions, then replies to the teammate.
   * When allow=false: replies with an error so the teammate does not hang.
   */
  private async respondToTeammatePermission(
    run: ProvisioningRun,
    agentId: string,
    requestId: string,
    allow: boolean,
    message?: string,
    permissionSuggestions?: import('@shared/utils/inboxNoise').PermissionSuggestion[],
    toolName?: string,
    toolInput?: Record<string, unknown>
  ): Promise<void> {
    if (!allow) {
      logger.info(`[${run.teamName}] Denied teammate ${agentId} permission ${requestId}`);
      this.sendTeammatePermissionResponse(run, agentId, requestId, {
        allow: false,
        message,
        toolName,
      });
      return;
    }

    const suggestions = permissionSuggestions ?? [];
    const sendSuccessResponse = (): void => {
      this.sendTeammatePermissionResponse(run, agentId, requestId, {
        allow: true,
        message,
        permissionUpdates: suggestions,
        toolName,
        toolInput,
      });
    };

    // Apply permission_suggestions: add tool rules to project settings file.
    if (suggestions.length === 0) {
      logger.info(
        `[${run.teamName}] No permission_suggestions for ${requestId}; sending allow responses only`
      );
    } else {
      // Resolve project cwd from team config
      let projectCwd: string | undefined;
      try {
        const config = await this.readConfigForStrictDecision(run.teamName);
        projectCwd = config?.projectPath ?? config?.members?.[0]?.cwd;
      } catch {
        // best-effort
      }

      if (!projectCwd) {
        logger.warn(
          `[${run.teamName}] Cannot resolve project cwd for permission rule; sending allow responses only`
        );
      } else {
        for (const suggestion of suggestions) {
          // Handle "setMode" suggestions (e.g. Write/Edit tools suggest acceptEdits mode)
          // FACT: Write/Edit permission_requests have permission_suggestions:
          //   { type: "setMode", mode: "acceptEdits", destination: "session" }
          // Since we can't change session mode of a subprocess, we translate to addRules.
          if (suggestion.type === 'setMode') {
            const mode = typeof suggestion.mode === 'string' ? suggestion.mode : '';
            let toolNames: string[] = [];
            if (mode === 'acceptEdits') {
              toolNames = ['Edit', 'Write', 'NotebookEdit'];
            } else if (mode === 'bypassPermissions') {
              // Broad approval - add common tools
              toolNames = ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob'];
            }
            if (toolNames.length > 0) {
              const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
              try {
                await this.addPermissionRulesToSettings(settingsPath, toolNames, 'allow');
                logger.info(
                  `[${run.teamName}] Applied setMode "${mode}" for ${agentId}: ${toolNames.join(', ')} in ${settingsPath}`
                );
              } catch (error) {
                logger.error(
                  `[${run.teamName}] Failed to apply setMode: ${
                    error instanceof Error ? error.message : String(error)
                  }`
                );
              }
            }
            continue;
          }

          if (suggestion.type !== 'addRules' || !Array.isArray(suggestion.rules)) continue;

          let toolNames = suggestion.rules
            .map((r) => r.toolName)
            .filter((name): name is string => typeof name === 'string' && name.length > 0);
          if (toolNames.length === 0) continue;

          // Expand teammate-safe operational tools only.
          // This removes the bootstrap/task workflow race without accidentally granting
          // admin/runtime tools like team_stop or kanban_clear.
          if (
            toolNames.some((name) =>
              AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES.includes(name)
            )
          ) {
            const merged = new Set([
              ...toolNames,
              ...AGENT_TEAMS_NAMESPACED_TEAMMATE_OPERATIONAL_TOOL_NAMES,
            ]);
            toolNames = Array.from(merged);
          }

          const behavior = suggestion.behavior ?? 'allow';
          // FACT: observed destinations are "localSettings" (project-level .claude/settings.local.json)
          const settingsPath =
            suggestion.destination === 'localSettings'
              ? path.join(projectCwd, '.claude', 'settings.local.json')
              : path.join(projectCwd, '.claude', 'settings.local.json'); // default to local

          try {
            await this.addPermissionRulesToSettings(settingsPath, toolNames, behavior);
            logger.info(
              `[${run.teamName}] Added permission rules for ${agentId}: ${toolNames.join(', ')} -> ${behavior} in ${settingsPath}`
            );
          } catch (error) {
            logger.error(
              `[${run.teamName}] Failed to add permission rules: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        }
      }
    }

    sendSuccessResponse();

    // Also attempt control_response via stdin - the lead runtime MAY forward it
    // to the teammate subprocess. This was broken before (missing updatedInput: {})
    // but is now fixed. Belt-and-suspenders: settings handle future calls,
    // control_response may unblock the CURRENT waiting prompt.
    if (allow && run.child?.stdin?.writable) {
      const updatedInput =
        this.buildTeammatePermissionUpdatedInput(toolName, toolInput, message) ?? {};
      const controlResponse = {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { behavior: 'allow', updatedInput },
        },
      };
      run.child.stdin.write(JSON.stringify(controlResponse) + '\n', (err) => {
        if (err) {
          logger.warn(
            `[${run.teamName}] control_response via stdin for teammate ${agentId} failed (non-critical): ${err.message}`
          );
        }
      });
    }
  }

  private sendTeammatePermissionResponse(
    run: ProvisioningRun,
    agentId: string,
    requestId: string,
    params: {
      allow: boolean;
      message?: string;
      permissionUpdates?: unknown[];
      toolName?: string;
      toolInput?: Record<string, unknown>;
    }
  ): void {
    const payload = params.allow
      ? {
          type: 'permission_response',
          request_id: requestId,
          subtype: 'success',
          response: {
            updated_input: this.buildTeammatePermissionUpdatedInput(
              params.toolName,
              params.toolInput,
              params.message
            ),
            permission_updates: params.permissionUpdates ?? [],
          },
        }
      : {
          type: 'permission_response',
          request_id: requestId,
          subtype: 'error',
          error: params.message ?? 'Permission denied',
        };

    this.persistInboxMessage(run.teamName, agentId, {
      from:
        run.request?.members.find((member) => member.role?.toLowerCase().includes('lead'))?.name ??
        'team-lead',
      to: agentId,
      text: JSON.stringify(payload),
      timestamp: nowIso(),
      read: false,
      summary: params.allow
        ? `Approved ${params.toolName ?? 'tool'} request`
        : `Denied ${params.toolName ?? 'tool'} request`,
      messageId: `permission-response-${run.runId}-${requestId}-${Date.now()}`,
      source: 'lead_process',
    });
    this.teamChangeEmitter?.({
      type: 'inbox',
      teamName: run.teamName,
      detail: `inboxes/${agentId}.json`,
    });
  }

  private buildTeammatePermissionUpdatedInput(
    toolName: string | undefined,
    toolInput: Record<string, unknown> | undefined,
    message: string | undefined
  ): Record<string, unknown> | undefined {
    if (!toolInput) return undefined;
    if (toolName !== 'AskUserQuestion' || message === undefined) return toolInput;

    const answers = this.parseAskUserQuestionAnswers(message, toolInput);
    return Object.keys(answers).length > 0 ? { ...toolInput, answers } : toolInput;
  }

  private parseAskUserQuestionAnswers(
    message: string,
    toolInput: Record<string, unknown>
  ): Record<string, string> {
    try {
      const parsed = JSON.parse(message) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return Object.fromEntries(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        );
      }
    } catch {
      // Fall back to using the raw message as the first answer.
    }

    const questions = Array.isArray(toolInput.questions)
      ? (toolInput.questions as { question?: unknown }[])
      : [];
    const firstQuestion = questions.find((question) => typeof question.question === 'string');
    return typeof firstQuestion?.question === 'string' ? { [firstQuestion.question]: message } : {};
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
    const dir = path.dirname(settingsPath);
    await fs.promises.mkdir(dir, { recursive: true });

    // Read existing settings (or start with empty object)
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.promises.readFile(settingsPath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // File doesn't exist or invalid JSON — start fresh
    }

    // Ensure permissions object exists
    if (!settings.permissions || typeof settings.permissions !== 'object') {
      settings.permissions = {};
    }
    const perms = settings.permissions as Record<string, unknown>;

    // Target array: "allow" or "deny" based on behavior
    const key = behavior === 'deny' ? 'deny' : 'allow';
    if (!Array.isArray(perms[key])) {
      perms[key] = [];
    }
    const list = perms[key] as string[];

    // Add tool names that aren't already in the list
    const existing = new Set(list);
    let added = 0;
    for (const name of toolNames) {
      if (!existing.has(name)) {
        list.push(name);
        added++;
      }
    }

    if (added === 0) return 0; // Nothing new to add

    await atomicWriteAsync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    return added;
  }

  private async seedLeadBootstrapPermissionRules(
    teamName: string,
    projectCwd: string
  ): Promise<void> {
    const settingsPath = path.join(projectCwd, '.claude', 'settings.local.json');
    try {
      const allTools = [
        ...AGENT_TEAMS_NAMESPACED_LEAD_BOOTSTRAP_TOOL_NAMES,
        'Edit',
        'Write',
        'NotebookEdit',
      ];
      const added = await this.addPermissionRulesToSettings(settingsPath, allTools, 'allow');
      logger.info(
        `[${teamName}] Seeded lead bootstrap MCP rules in ${settingsPath} (${added} added)`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to seed lead bootstrap MCP rules: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
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
      launchMixedSecondaryLaneIfNeeded: (run, options) =>
        this.launchMixedSecondaryLaneIfNeeded(run, options),
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
      setAliveRunId: (teamName, runId) => this.setAliveRunId(teamName, runId),
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
    if (run.teamLaunchedNotificationFired) {
      return;
    }

    try {
      const config = ConfigManager.getInstance().getConfig();
      const suppressToast = !config.notifications.notifyOnTeamLaunched;
      const displayName = run.request.displayName || run.teamName;
      const joinedCount = run.expectedMembers?.length ?? 0;
      const allJoined = joinedCount > 0 && this.areAllExpectedLaunchMembersConfirmed(run);
      if (run.isLaunch && joinedCount > 0 && !allJoined) {
        return;
      }
      run.teamLaunchedNotificationFired = true;
      const body = run.isLaunch
        ? allJoined
          ? `Team "${displayName}" has been launched - all ${joinedCount} teammates joined and are ready for tasks.`
          : `Team "${displayName}" has been launched and is ready for tasks.`
        : `Team "${displayName}" has been provisioned and is ready for tasks.`;

      await NotificationManager.getInstance().addTeamNotification({
        teamEventType: 'team_launched',
        teamName: run.teamName,
        teamDisplayName: displayName,
        from: 'system',
        summary: run.isLaunch ? 'Team launched' : 'Team provisioned',
        body,
        dedupeKey: `team_launched:${run.teamName}:${run.runId}`,
        target: { kind: 'team', teamName: run.teamName, section: 'overview' },
        projectPath: run.request.cwd,
        suppressToast,
      });
    } catch (error) {
      run.teamLaunchedNotificationFired = false;
      logger.warn(
        `[${run.teamName}] Failed to fire team_launched notification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
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
    try {
      const config = ConfigManager.getInstance().getConfig();
      const suppressToast = !config.notifications.notifyOnTeamLaunched;
      const payload = buildTeamLaunchIncompleteNotificationPayload({
        run,
        failedMembers,
        launchSummary,
        snapshot,
        suppressToast,
      });
      if (!payload) {
        return;
      }

      await NotificationManager.getInstance().addTeamNotification(payload);
    } catch (error) {
      logger.warn(
        `[${run.teamName}] Failed to fire team_launch_incomplete notification: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Same-team native delivery dedup (Layer 2)
  // ---------------------------------------------------------------------------

  private rememberSameTeamNativeFingerprints(
    teamName: string,
    blocks: ParsedTeammateContent[]
  ): void {
    const teamKey = teamName.trim();
    const existing = this.recentSameTeamNativeFingerprints.get(teamKey) ?? [];
    const now = Date.now();
    const cutoff = now - TeamProvisioningService.SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS;
    const fresh = existing.filter((fp) => fp.seenAt > cutoff);

    for (const block of blocks) {
      fresh.push({
        id: randomUUID(),
        from: block.teammateId.trim(),
        text: normalizeSameTeamText(block.content),
        summary: (block.summary ?? '').trim(),
        seenAt: now,
      });
    }

    this.recentSameTeamNativeFingerprints.set(teamKey, fresh);
  }

  private consumeMatchedSameTeamFingerprints(teamName: string, matchedIds: Set<string>): void {
    if (matchedIds.size === 0) return;
    const current = this.recentSameTeamNativeFingerprints.get(teamName.trim()) ?? [];
    if (current.length === 0) return;
    const remaining = current.filter((fp) => !matchedIds.has(fp.id));
    if (remaining.length > 0) {
      this.recentSameTeamNativeFingerprints.set(teamName.trim(), remaining);
    } else {
      this.recentSameTeamNativeFingerprints.delete(teamName.trim());
    }
  }

  private getFreshSameTeamNativeFingerprints(teamName: string): NativeSameTeamFingerprint[] {
    const all = this.recentSameTeamNativeFingerprints.get(teamName) ?? [];
    if (all.length === 0) return [];
    const cutoff = Date.now() - TeamProvisioningService.SAME_TEAM_NATIVE_FINGERPRINT_TTL_MS;
    const fresh = all.filter((fp) => fp.seenAt > cutoff);
    if (fresh.length !== all.length) {
      if (fresh.length > 0) {
        this.recentSameTeamNativeFingerprints.set(teamName, fresh);
      } else {
        this.recentSameTeamNativeFingerprints.delete(teamName);
      }
    }
    return fresh;
  }

  private async confirmSameTeamNativeMatches(
    teamName: string,
    leadName: string,
    messages: InboxMessage[]
  ): Promise<{ nativeMatchedMessageIds: Set<string>; persisted: boolean }> {
    const fingerprints = this.getFreshSameTeamNativeFingerprints(teamName);
    const { confirmedMessageIds, matchedFingerprintIds } = collectConfirmedSameTeamPairsHelper({
      messages,
      fingerprints,
      leadName,
      matchWindowMs: TeamProvisioningService.SAME_TEAM_MATCH_WINDOW_MS,
    });

    if (confirmedMessageIds.size === 0) {
      return { nativeMatchedMessageIds: confirmedMessageIds, persisted: true };
    }

    const toMarkRead = Array.from(confirmedMessageIds, (messageId) => ({ messageId }));
    let persisted = false;
    try {
      await this.markInboxMessagesRead(teamName, leadName, toMarkRead);
      persisted = true;
    } catch {
      // keep fingerprints alive for next attempt
    }

    if (persisted) {
      // Durable: inbox says read=true. Safe to add in-memory dedup and consume fingerprints.
      const relayedIds = this.relayedLeadInboxMessageIds.get(teamName) ?? new Set<string>();
      for (const messageId of confirmedMessageIds) {
        relayedIds.add(messageId);
      }
      this.relayedLeadInboxMessageIds.set(teamName, this.trimRelayedSet(relayedIds));
      this.consumeMatchedSameTeamFingerprints(teamName, matchedFingerprintIds);
    }
    // If NOT persisted: don't add to relayedIds, don't consume fingerprints.
    // Next relay cycle will see the message in unread, re-match, and retry persist.

    return { nativeMatchedMessageIds: confirmedMessageIds, persisted };
  }

  private async reconcileSameTeamNativeDeliveries(
    teamName: string,
    leadName: string
  ): Promise<void> {
    let leadInboxMessages: Awaited<ReturnType<TeamInboxReader['getMessagesFor']>> = [];
    try {
      leadInboxMessages = await this.inboxReader.getMessagesFor(teamName, leadName);
    } catch {
      return;
    }

    const { nativeMatchedMessageIds, persisted } = await this.confirmSameTeamNativeMatches(
      teamName,
      leadName,
      leadInboxMessages
    );
    // If native was matched but persist failed, schedule a quick retry
    // so we don't wait for the 16s deferred timer to retry the disk write.
    if (nativeMatchedMessageIds.size > 0 && !persisted) {
      this.scheduleSameTeamPersistRetry(teamName);
    }
  }

  private scheduleSameTeamDeferredRetry(teamName: string): void {
    const key = `same-team-deferred:${teamName}`;
    if (this.pendingTimeouts.has(key)) return;

    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.relayLeadInboxMessages(teamName).catch((e: unknown) =>
        logger.warn(`[${teamName}] same-team deferred retry failed: ${String(e)}`)
      );
    }, TeamProvisioningService.SAME_TEAM_NATIVE_DELIVERY_GRACE_MS + 1_000);

    this.pendingTimeouts.set(key, timer);
  }

  /**
   * Best-effort durable follow-up after native delivery was matched but inbox read-state
   * could not be persisted. If the run dies before this retry succeeds, a later reconnect
   * may still relay the row once because in-memory dedupe is not durable.
   */
  private scheduleSameTeamPersistRetry(teamName: string): void {
    const key = `same-team-persist:${teamName}`;
    if (this.pendingTimeouts.has(key)) return;

    const timer = setTimeout(() => {
      this.pendingTimeouts.delete(key);
      void this.relayLeadInboxMessages(teamName).catch((e: unknown) =>
        logger.warn(`[${teamName}] same-team persist retry failed: ${String(e)}`)
      );
    }, TeamProvisioningService.SAME_TEAM_PERSIST_RETRY_MS);

    this.pendingTimeouts.set(key, timer);
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
      getTrackedRunId: (teamName) => this.getTrackedRunId(teamName),
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
      deleteAliveRunId: (teamName) => this.deleteAliveRunId(teamName),
      clearSecondaryRuntimeRuns: (teamName) => this.clearSecondaryRuntimeRuns(teamName),
      invalidateRuntimeSnapshotCaches: (teamName) => this.invalidateRuntimeSnapshotCaches(teamName),
      invalidateMemberSpawnStatusesCache: (teamName) =>
        this.invalidateMemberSpawnStatusesCache(teamName),
      leadInboxRelayInFlight: this.leadInboxRelayInFlight,
      relayedLeadInboxMessageIds: this.relayedLeadInboxMessageIds,
      pendingCrossTeamFirstReplies: this.pendingCrossTeamFirstReplies,
      recentCrossTeamLeadDeliveryMessageIds: this.recentCrossTeamLeadDeliveryMessageIds,
      recentSameTeamNativeFingerprints: this.recentSameTeamNativeFingerprints,
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

  private isAuthFailureWarning(text: string, source: AuthWarningSource): boolean {
    return isAuthFailureWarning(text, source);
  }

  private normalizeApiRetryErrorMessage(text: string): string {
    return normalizeApiRetryErrorMessage(text);
  }

  private getProviderDiagnosticsBasePorts(): TeamProvisioningProviderDiagnosticsPorts {
    return createDefaultTeamProvisioningProviderDiagnosticsPorts({
      transientProbeProcesses: this.transientProbeProcesses,
      providerConnectionService: this.providerConnectionService,
      logger,
      isAuthFailureWarning: (text, source) => this.isAuthFailureWarning(text, source),
      normalizeApiRetryErrorMessage: (text) => this.normalizeApiRetryErrorMessage(text),
    });
  }

  private getProviderDiagnosticsPorts(): TeamProvisioningProviderDiagnosticsPorts {
    const ports = this.getProviderDiagnosticsBasePorts();
    return {
      ...ports,
      spawnProbe: (claudePath, args, cwd, env, timeoutMs, options) =>
        this.spawnProbe(claudePath, args, cwd, env, timeoutMs, options),
    };
  }

  private async probeClaudeRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined = 'anthropic',
    providerArgs: string[] = []
  ): Promise<{ warning?: string }> {
    return probeClaudeRuntime({
      claudePath,
      cwd,
      env,
      providerId,
      providerArgs,
      ports: this.getProviderDiagnosticsPorts(),
    });
  }

  private async probeProviderRuntimeControlPlane(input: {
    claudePath: string;
    cwd: string;
    env: NodeJS.ProcessEnv;
    providerId: TeamProviderId;
    providerArgs: string[];
  }): Promise<{ warning?: string }> {
    return probeProviderRuntimeControlPlane({
      ...input,
      ports: this.getProviderDiagnosticsPorts(),
    });
  }

  private async runProviderOneShotDiagnostic(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    providerId: TeamProviderId | undefined = 'anthropic',
    providerArgs: string[] = []
  ): Promise<{ warning?: string }> {
    return runProviderOneShotDiagnostic({
      claudePath,
      cwd,
      env,
      providerId,
      providerArgs,
      ports: this.getProviderDiagnosticsPorts(),
    });
  }

  private async validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    env: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options: { isCancelled?: () => boolean } = {}
  ): Promise<void> {
    await validateAgentTeamsMcpRuntime({
      claudePath,
      cwd,
      env,
      mcpConfigPath,
      options,
      ports: this.getProviderDiagnosticsPorts(),
    });
  }

  private async spawnProbe(
    claudePath: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    options?: SpawnProbeOptions
  ): Promise<SpawnProbeResult> {
    return spawnProbeDiagnostic({
      claudePath,
      args,
      cwd,
      env,
      timeoutMs,
      options,
      ports: this.getProviderDiagnosticsBasePorts(),
    });
  }

  private getProvisioningEnvBuilderPorts(): TeamProvisioningEnvBuilderPorts {
    return {
      providerConnectionService: this.providerConnectionService,
      buildRuntimeTurnSettledEnvironment: (providerId) =>
        this.buildRuntimeTurnSettledEnvironment(providerId),
      resolveControlApiBaseUrl: () => this.resolveControlApiBaseUrl(),
      logger,
    };
  }

  private async buildProvisioningEnv(
    providerId: TeamProviderId | undefined = 'anthropic',
    providerBackendId?: string | null,
    options?: {
      includeCodexTeammateAuth?: boolean;
      teamRuntimeAuth?: TeamRuntimeAuthContext;
    }
  ): Promise<ProvisioningEnvResolution> {
    return buildProvisioningEnvHelper({
      providerId,
      providerBackendId,
      options,
      ports: this.getProvisioningEnvBuilderPorts(),
    });
  }

  private async buildCrossProviderMemberArgs(
    primaryProviderId: TeamProviderId,
    memberSpecs: TeamCreateRequest['members'],
    options?: { teamRuntimeAuth?: TeamRuntimeAuthContext }
  ): Promise<CrossProviderMemberArgsResult> {
    return buildCrossProviderMemberArgsHelper({
      primaryProviderId,
      memberSpecs,
      options,
      ports: {
        buildProvisioningEnv: (providerIdForEnv, providerBackendId, buildOptions) =>
          this.buildProvisioningEnv(providerIdForEnv, providerBackendId, buildOptions),
        buildRuntimeTurnSettledHookSettingsArgs: (providerIdForArgs) =>
          this.buildRuntimeTurnSettledHookSettingsArgs(providerIdForArgs),
        logger,
      },
    });
  }

  private async resolveControlApiBaseUrl(): Promise<string | null> {
    if (!this.controlApiBaseUrlResolver) {
      return null;
    }

    try {
      const baseUrl = await this.controlApiBaseUrlResolver();
      if (!baseUrl) {
        throw new Error('Team control API resolver returned no base URL after startup.');
      }
      process.env.CLAUDE_TEAM_CONTROL_URL = baseUrl;
      return baseUrl;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to resolve team control API base URL: ${message}`);
      throw new Error(
        `Team control API failed to start or publish its base URL. Team runtime commands require the desktop Control API. ${message}`
      );
    }
  }

  /**
   * Immediately update projectPath in config.json at launch start, before CLI spawn.
   * Ensures TeamDetailView shows the correct project path even if provisioning
   * is interrupted. On failure, restorePrelaunchConfig() reverts to the backup.
   */
  private async updateConfigProjectPath(teamName: string, cwd: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!raw) {
        throw new Error('config.json unreadable');
      }
      const config = JSON.parse(raw) as Record<string, unknown>;

      config.projectPath = cwd;

      const pathHistory = Array.isArray(config.projectPathHistory)
        ? (config.projectPathHistory as string[]).filter((p) => typeof p === 'string' && p !== cwd)
        : [];
      pathHistory.push(cwd);
      config.projectPathHistory = pathHistory.slice(-500);

      await atomicWriteAsync(configPath, JSON.stringify(config, null, 2));
      TeamConfigReader.invalidateTeam(teamName);
      logger.info(`[${teamName}] Updated config.projectPath immediately: ${cwd}`);
    } catch (error) {
      // Non-fatal: updateConfigPostLaunch will update it later if provisioning succeeds.
      logger.warn(
        `[${teamName}] Failed to update projectPath early: ${error instanceof Error ? error.message : String(error)}`
      );
    }
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
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    await updateTeamConfigPostLaunch(
      { teamName, projectPath, detectedSessionId, color, launchState },
      {
        readConfig: () =>
          tryReadRegularFileUtf8(configPath, {
            timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
            maxBytes: TEAM_CONFIG_MAX_BYTES,
          }),
        writeConfig: (raw) => atomicWriteAsync(configPath, raw),
        invalidateTeam: (name) => TeamConfigReader.invalidateTeam(name),
        scanForNewestSession: (scanProjectPath, knownSessions) =>
          scanForNewestProjectSession({
            projectPath: scanProjectPath,
            knownSessions,
            projectsBasePath: getProjectsBasePath(),
            ports: {
              readDir: (dirPath) => fs.promises.readdir(dirPath),
              stat: (filePath) => fs.promises.stat(filePath),
            },
          }),
        getLanguage: () =>
          ConfigManager.getInstance().getConfig().general.agentLanguage || 'system',
        info: (message) => logger.info(message),
        warn: (message) => logger.warn(message),
      }
    );
  }

  private async cleanupCliAutoSuffixedMembers(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');

    try {
      const raw = await tryReadRegularFileUtf8(configPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (raw) {
        const cleanupPlan = planCliAutoSuffixedConfigMemberCleanup(raw);
        if (cleanupPlan) {
          cleanupPlan.config.members = cleanupPlan.nextMembers;
          await atomicWriteAsync(configPath, JSON.stringify(cleanupPlan.config, null, 2));
          TeamConfigReader.invalidateTeam(teamName);
          logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from config.json: ${cleanupPlan.removedNames.join(', ')}`
          );
        }
      }
    } catch {
      // best-effort
    }

    let activeNamesForInboxCleanup = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      if (metaMembers.length > 0) {
        const cleanupPlan = planCliAutoSuffixedMetaMemberCleanup(metaMembers);

        if (cleanupPlan.removedNames.length > 0) {
          await this.membersMetaStore.writeMembers(teamName, cleanupPlan.nextMembers);
          logger.warn(
            `[${teamName}] Removed CLI auto-suffixed members from members.meta.json: ${cleanupPlan.removedNames.join(', ')}`
          );
        }

        activeNamesForInboxCleanup = cleanupPlan.activeNamesForInboxCleanup;
      }
    } catch {
      // best-effort
    }

    // Also attempt inbox cleanup (merge alice-2.json into alice.json).
    if (activeNamesForInboxCleanup.size > 0) {
      try {
        await this.mergeAndRemoveDuplicateInboxes(teamName, activeNamesForInboxCleanup);
      } catch {
        // best-effort
      }
    }
  }

  private async assertConfigLeadOnlyForLaunch(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const raw = await tryReadRegularFileUtf8(configPath, {
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_CONFIG_MAX_BYTES,
    });
    assertConfigRawLeadOnlyForLaunch(raw);
  }

  private async normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = getPrelaunchConfigBackupPath(configPath);
    const normalizationPlan = planTeamConfigLaunchNormalization(configRaw);
    if (!normalizationPlan) return;

    // Try to determine base teammate names for inbox cleanup (prefer meta).
    let baseNames = new Set<string>();
    try {
      const metaMembers = await this.membersMetaStore.getMembers(teamName);
      baseNames = collectConfigLaunchBaseNamesFromMetaMembers(metaMembers);
    } catch {
      // ignore
    }
    if (baseNames.size === 0) {
      baseNames = collectConfigLaunchBaseNamesFromConfigMembers(normalizationPlan.members);
    }

    // Backup current config on disk for crash recovery / debugging.
    try {
      await atomicWriteAsync(backupPath, configRaw);
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to write config prelaunch backup: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    // Write normalized config atomically.
    normalizationPlan.config.members = normalizationPlan.leadMembers;
    try {
      await atomicWriteAsync(configPath, JSON.stringify(normalizationPlan.config, null, 2));
      TeamConfigReader.invalidateTeam(teamName);
      logger.info(
        `[${teamName}] Normalized config.json for launch: kept ${normalizationPlan.leadMembers.length} lead member(s)`
      );
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to normalize config.json for launch: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return;
    }

    // Best-effort: merge and remove suffixed inboxes like alice-2.json to avoid UI duplicates.
    await this.mergeAndRemoveDuplicateInboxes(teamName, baseNames);
  }

  /**
   * Restore config.json from prelaunch backup if launch fails after normalization.
   */
  private async restorePrelaunchConfig(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = getPrelaunchConfigBackupPath(configPath);
    try {
      const backupRaw = await tryReadRegularFileUtf8(backupPath, {
        timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
        maxBytes: TEAM_CONFIG_MAX_BYTES,
      });
      if (!backupRaw) {
        return;
      }
      await atomicWriteAsync(configPath, backupRaw);
      TeamConfigReader.invalidateTeam(teamName);
      logger.info(`[${teamName}] Restored config.json from prelaunch backup after launch failure`);
    } catch {
      logger.debug(`[${teamName}] No prelaunch backup to restore (or read failed)`);
    }
  }

  /**
   * Remove the prelaunch backup file after a successful launch.
   */
  async cleanupPrelaunchBackup(teamName: string): Promise<void> {
    const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
    const backupPath = getPrelaunchConfigBackupPath(configPath);
    try {
      await fs.promises.unlink(backupPath);
    } catch {
      // Backup may not exist — that's fine
    }
  }

  private async mergeAndRemoveDuplicateInboxes(
    teamName: string,
    baseNames: Set<string>
  ): Promise<void> {
    await mergeAndRemoveDuplicateInboxesHelper({
      inboxDir: path.join(getTeamsBasePath(), teamName, 'inboxes'),
      baseNames,
      timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
      maxBytes: TEAM_INBOX_MAX_BYTES,
      ports: {
        readDir: (dirPath) => fs.promises.readdir(dirPath),
        readRegularFileUtf8: tryReadRegularFileUtf8,
        writeFileUtf8: (filePath, contents) => atomicWriteAsync(filePath, contents),
        unlink: (filePath) => fs.promises.unlink(filePath),
        withCanonicalInboxLock: (filePath, fn) =>
          withFileLock(filePath, () => withInboxLock(filePath, fn)),
      },
    });
  }

  private async persistMembersMeta(teamName: string, request: TeamCreateRequest): Promise<void> {
    const teammateMembers = selectMembersMetaTeammates(request.members);

    const joinedAt = Date.now();

    try {
      const existingMeta = await this.membersMetaStore.getMeta(teamName);
      const membersToWrite = mergeMembersMetaForLaunch(
        buildMembersMetaWritePayload(
          teammateMembers.map((member) => ({
            ...member,
            joinedAt,
          }))
        ),
        existingMeta?.members ?? []
      );
      if (membersToWrite.length === 0 && existingMeta == null) {
        return;
      }
      await this.membersMetaStore.writeMembers(teamName, membersToWrite, {
        providerBackendId: request.providerBackendId,
      });
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to persist members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
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
    return this.resolveLaunchExpectedMembersFromCompatibility(
      await this.probeLaunchCompatibility(teamName, configRaw, leadProviderId)
    );
  }

  private resolveLaunchExpectedMembersFromCompatibility(report: TeamLaunchCompatibilityReport): {
    members: TeamCreateRequest['members'];
    source: 'members-meta' | 'inboxes' | 'config-fallback';
    warning?: string;
  } {
    return resolveLaunchExpectedMembersFromCompatibilityReport(report);
  }

  private async probeLaunchCompatibility(
    teamName: string,
    configRaw: string,
    leadProviderId?: TeamProviderId
  ): Promise<TeamLaunchCompatibilityReport> {
    // Keep this probe read-only: launch-state/bootstrap-state may inform existing resume guards,
    // but compatibility repair must not mutate or trust stale runtime projections.
    await Promise.allSettled([
      this.launchStateStore.read(teamName),
      readBootstrapLaunchSnapshot(teamName),
    ]);

    try {
      const membersMeta = await this.membersMetaStore.getMeta(teamName);
      if (membersMeta) {
        const members = buildLaunchMembersFromMeta(membersMeta.members);
        return {
          level: 'ready',
          rosterSource: 'members-meta',
          members,
          warnings: [],
          blockers: [],
        };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read members.meta.json: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    const configMembers = extractTeammateSpecsFromConfig(configRaw);
    if (configMembers.length === 0) {
      try {
        JSON.parse(configRaw);
      } catch {
        logger.warn(`[${teamName}] Failed to parse config.json for launch fallback members`);
      }
    }

    try {
      const allInboxNames = Array.from(
        new Set(
          (await this.inboxReader.listInboxNames(teamName))
            .map((name) => name.trim())
            .filter((name) => name.length > 0)
        )
      );
      const inboxNameSetLower = new Set(allInboxNames.map((n) => n.toLowerCase()));
      const inboxNames = allInboxNames
        .filter((name) => name !== 'team-lead' && name !== 'user')
        .filter((name) => !this.isCrossTeamPseudoRecipientName(name))
        .filter((name) => !this.isCrossTeamToolRecipientName(name))
        .filter((name) => !this.looksLikeQualifiedExternalRecipientName(name))
        .filter((name) => {
          const match = /^(.+)-(\d+)$/.exec(name);
          if (!match?.[1] || !match[2]) return true;
          const suffix = Number(match[2]);
          // Only filter CLI-suffixed names (alice-2) when the base name (alice) also exists.
          // Important: do NOT filter names like dev-1 (common intentional naming). Only consider -2+ as auto-suffix.
          if (!Number.isFinite(suffix) || suffix < 2) return true;
          return !inboxNameSetLower.has(match[1].toLowerCase());
        });
      if (inboxNames.length > 0) {
        const configHasOpenCodeMember = configMembers.some((member) => {
          const providerId = normalizeOptionalTeamProviderId(member.providerId);
          const model = typeof member.model === 'string' ? member.model.trim() : '';
          return providerId === 'opencode' || inferTeamProviderIdFromModel(model) === 'opencode';
        });
        if (configHasOpenCodeMember) {
          return buildConfigLaunchCompatibilityReport(teamName, configMembers, leadProviderId, {
            ignoredInboxNames: true,
          });
        }
        const configMembersByName = new Map(
          configMembers.map((member) => [member.name.toLowerCase(), member] as const)
        );
        const members = inboxNames.map((name) => {
          const configMember = configMembersByName.get(name.toLowerCase());
          return {
            name,
            role: configMember?.role,
            workflow: configMember?.workflow,
            isolation: configMember?.isolation,
            cwd: configMember?.cwd,
            providerId: configMember?.providerId,
            model: configMember?.model,
            effort: configMember?.effort,
            mcpPolicy: configMember?.mcpPolicy,
          };
        });
        const memberOverridesUsed = members.some(
          (member) => member.providerId || member.model || member.effort || member.isolation
        );
        if (
          hasIncompleteOpenCodeLaunchCompatibilityMember(members) ||
          isUnsafeMixedLaunchFallback({
            leadProviderId,
            members,
          })
        ) {
          return {
            level: 'unsafe',
            rosterSource: 'inboxes',
            members: [],
            warnings: [],
            blockers: [
              `[${teamName}] ${getMixedLaunchFallbackRecoveryError()} Fallback source: inboxes.`,
            ],
          };
        }
        return {
          level: 'ready',
          rosterSource: 'inboxes',
          members,
          warnings: memberOverridesUsed
            ? [
                'Launch roster was recovered from inboxes and merged with config.json provider/model/effort overrides. ' +
                  'Multimodel reconnect is best-effort in this fallback path.',
              ]
            : [],
          blockers: [],
        };
      }
    } catch (error) {
      logger.warn(
        `[${teamName}] Failed to read inbox member names: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }

    if (configMembers.length > 0) {
      return buildConfigLaunchCompatibilityReport(teamName, configMembers, leadProviderId);
    }

    let configParseFailed = false;
    try {
      JSON.parse(configRaw);
    } catch {
      configParseFailed = true;
    }

    return {
      level: 'ready',
      rosterSource: 'missing',
      members: [],
      warnings: configParseFailed
        ? [
            'Config could not be parsed during launch roster discovery. ' +
              'Launch will continue without explicit teammate names.',
          ]
        : [],
      blockers: [],
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
        buildProvisioningEnv: () => this.buildProvisioningEnv(),
        spawnProbe: (claudePath, args, targetCwd, env, timeoutMs) =>
          this.spawnProbe(claudePath, args, targetCwd, env, timeoutMs),
      },
    });
    this.helpOutputCache = cache.output;
    this.helpOutputCacheTime = cache.cachedAtMs;
    return output;
  }
}
