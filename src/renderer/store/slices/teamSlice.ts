import {
  buildTeamGraphDefaultLayoutSeed,
  createInitialTeamGraphLayoutState,
  createTeamGraphLayoutActions,
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
  type TeamGraphLayoutSlice,
} from '@features/agent-graph';
import {
  createTeamLifecycleMutationCleanup,
  createTeamLifecycleMutationSlice,
  type TeamLifecycleMutationSlice,
} from '@features/team-lifecycle/renderer';
import {
  createTeamMessageDeliveryRendererSlice,
  type TeamMessageDeliveryRendererSlice,
} from '@features/team-message-delivery/renderer';
import { isActiveProvisioningState } from '@features/team-provisioning';
import {
  createTeamProvisioningControlSlice,
  createTeamProvisioningLaunchSlice,
  createTeamProvisioningProgressSlice,
  createTeamRuntimeObservationSlice,
  saveTeamToolApprovalSettings,
  type TeamProvisioningControlSlice,
  type TeamProvisioningLaunchSlice,
  type TeamProvisioningProgressSlice,
  type TeamRuntimeObservationSlice,
} from '@features/team-provisioning/renderer';
import {
  clearTeamTaskBoardAnalytics,
  collectTaskChangeInvalidation,
  createTeamTaskArtifactsRendererSlice,
  createTeamTaskArtifactsTransport,
  createTeamTaskBoardRendererSlice,
  preserveKnownTaskChangePresence,
  recordTeamTaskBoardSnapshotTransitions,
  resetTeamTaskBoardAnalyticsForTests,
  type TeamTaskArtifactsRendererSlice,
  type TeamTaskBoardRendererSlice,
} from '@features/team-task-board/renderer';
import {
  createTeamMessageFeedRendererSlice,
  createTeamViewDataRendererSlice,
  defaultTeamMessageFeedCoordinator,
  defaultTeamViewDataCoordinator,
  type TeamMessageFeedRendererSlice,
  type TeamMessagesCacheEntry,
  type TeamViewDataRendererSlice,
} from '@features/team-view-read-model/renderer';
import {
  buildProviderMix,
  classifyAnalyticsError,
  elapsedMsBetweenIso,
  elapsedMsSince,
  recordTeamCreate,
  recordTeamLaunchEnd,
} from '@renderer/analytics/productAnalytics';
import * as productAnalytics from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import {
  buildOpenCodeRuntimeDeliveryDiagnostics,
  isOpenCodeRuntimeDeliveryHardUxFailure,
} from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';
import { createLogger } from '@shared/utils/logger';

import { areTeamAgentRuntimeSnapshotsEqual } from '../team/teamAgentRuntimeSnapshotEquality';
import { stabilizeTeamAgentRuntimeSnapshot } from '../team/teamAgentRuntimeSnapshotStabilizer';
import {
  clearAllLastResolvedTeamDataRefreshes,
  clearLastResolvedTeamDataRefreshAt,
  hasLastResolvedTeamDataRefreshAt,
  recordLastResolvedTeamDataRefresh,
} from '../team/teamDataRefreshTimestamps';
import { selectTeamDataForName } from '../team/teamDataSelectors';
import {
  mapReviewError,
  mapSendMessageError,
  shouldInvalidateCachedTeamDataForError,
} from '../team/teamErrorPolicies';
import {
  consumeFirstGlobalTasksFetchFlag,
  processGlobalTaskNotifications,
  resetGlobalTaskNotificationTrackerForTests,
} from '../team/teamGlobalTaskNotifications';
import { projectTeamSnapshotOntoGlobalTasks } from '../team/teamGlobalTaskProjection';
import {
  captureTeamLocalStateEpoch,
  clearAllTeamLocalStateEpochs,
  hasTeamLocalStateEpoch,
  invalidateTeamLocalStateEpoch,
  isTeamLocalStateEpochCurrent,
} from '../team/teamLocalStateEpoch';
import {
  isMemberActivityMetaStale,
  structurallyShareMemberActivityFacts,
} from '../team/teamMemberActivityMeta';
import { areMemberSpawnSnapshotsSemanticallyEqual } from '../team/teamMemberSpawnSnapshotEquality';
import {
  clearAllMemberSpawnStatusesIpcBackoffs,
  clearMemberSpawnStatusesIpcBackoff,
  hasMemberSpawnStatusesIpcBackoff,
  isMemberSpawnStatusesIpcBackoffActive,
  recordMemberSpawnStatusesIpcRetryBackoff,
} from '../team/teamMemberSpawnStatusBackoff';
import {
  clearAllMemberSpawnUiEqualLastWarns,
  clearMemberSpawnUiEqualLastWarn,
  hasMemberSpawnUiEqualLastWarn,
  shouldLogMemberSpawnUiEqualSuppressed,
} from '../team/teamMemberSpawnUiEqualWarningThrottle';
import {
  areInboxMessageArraysEquivalent,
  clearTeamMessageSelectorCaches,
  clearTeamMessageSelectorCachesForTeam,
  extractRetainedCanonicalOlderTail,
  getCanonicalHeadSlice,
  getTeamMessagesCacheEntry,
  getTeamMessageSelectorCacheSnapshotForTeam,
  pruneOptimisticMessages,
  upsertOptimisticTeamMessage,
} from '../team/teamMessagesCache';
import {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../team/teamMessagesPanelModePersistence';
import {
  clearAllPendingReplyRefreshWaits,
  clearPendingReplyRefreshWaits,
  setPendingReplyRefreshEnabled,
} from '../team/teamPendingReplyWaits';
import {
  clearAllTeamRefreshBurstDiagnostics,
  clearTeamRefreshBurstDiagnostics,
  hasTeamRefreshBurstDiagnostics,
  noteTeamRefreshBurst,
} from '../team/teamRefreshBurstDiagnostics';
import {
  clearResolvedMemberSelectorCaches,
  clearResolvedMemberSelectorCachesForTeam,
  getResolvedMemberSelectorCacheSnapshotForTeam,
  shouldPreserveSelectedTeamSnapshot,
} from '../team/teamResolvedMembers';
import {
  buildTeamScopedProgressTombstones,
  collectTeamScopedStateRemovals,
  collectTeamScopedVisibleLoadingResets,
} from '../team/teamScopedStateCleanup';
import {
  structurallySharePlainValue,
  structurallyShareTeamSnapshot,
} from '../team/teamSnapshotStructuralSharing';
import { parseToolApprovalSettings } from '../team/teamToolApprovalSettings';
import { noteTeamRefreshFanout } from '../teamRefreshFanoutDiagnostics';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  resetContextScopedRequestEpochForTests,
} from '../utils/contextScopedRequestEpoch';
import { getWorktreeNavigationState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  ActiveToolCall,
  AddMemberRequest,
  GlobalTask,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  NotificationTarget,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamSummary,
  TeamViewSnapshot,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

interface CurrentDevProductAnalytics {
  recordAttachmentAttachEnd(input: Record<string, unknown>): void;
  recordCrossTeamMessageSend(input: Record<string, unknown>): void;
  recordTeamDelete(input: Record<string, unknown>): void;
  recordTeamLaunchStepEnd(input: Record<string, unknown>): void;
}

const currentDevProductAnalytics =
  productAnalytics as unknown as Partial<CurrentDevProductAnalytics>;
const recordAttachmentAttachEnd =
  currentDevProductAnalytics.recordAttachmentAttachEnd ?? (() => undefined);
const recordCrossTeamMessageSend =
  currentDevProductAnalytics.recordCrossTeamMessageSend ?? (() => undefined);
const recordTeamDelete = currentDevProductAnalytics.recordTeamDelete ?? (() => undefined);
const recordTeamLaunchStepEnd =
  currentDevProductAnalytics.recordTeamLaunchStepEnd ?? (() => undefined);
import type { StateCreator } from 'zustand';

export { getLastResolvedTeamDataRefreshAt } from '../team/teamDataRefreshTimestamps';
export {
  selectTeamDataForName,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
  selectTeamTasksForName,
} from '../team/teamDataSelectors';
export { getDefaultTeamGraphSlotAssignmentsForMembers, isTeamGraphSlotPersistenceDisabled };
export type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
} from '../team/teamMessagesCache';
export { selectMemberMessagesForTeamMember, selectTeamMessages } from '../team/teamMessagesCache';
export {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../team/teamMessagesPanelModePersistence';
export {
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
} from '../team/teamPendingReplyWaits';
export {
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
} from '../team/teamResolvedMembers';
export type { TeamLaunchParams } from '@features/team-provisioning/renderer';

const logger = createLogger('teamSlice');

const TEAM_FETCH_TIMEOUT_MS = 30_000;
const MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS = 5_000;
const TEAM_REFRESH_BURST_WINDOW_MS = 4_000;
const MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS = 2_000;
const GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS = 1_500;
let latestTeamsFetchRequestId = 0;
let inFlightGlobalTasksRefresh: Promise<void> | null = null;
let inFlightGlobalTasksRefreshScope: ContextRequestScope | null = null;
let pendingFreshGlobalTasksRefresh = false;
const reportedTeamLaunchEndRunIds = new Set<string>();
const reportedTeamLaunchStepKeys = new Set<string>();
const teamLaunchAnalyticsByRunId = new Map<string, TeamLaunchAnalyticsContext>();
const teamLaunchStepStartedAtByKey = new Map<string, number>();
const teamAgentRuntimeFreshnessSnapshotsByTeamAndRun = new Map<
  string,
  Map<string | null, TeamAgentRuntimeSnapshot>
>();

type GlobalTaskNotificationParams = Parameters<typeof processGlobalTaskNotifications>[0];

interface TeamLaunchAnalyticsContext {
  startedAtMs: number;
  memberCount: number | null;
  providerIds: (string | null)[];
}

function parseRuntimeFreshnessTimestampMs(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function doesRuntimeFreshnessTimestampExtendVisible(
  visibleTimestamp: string | undefined,
  cachedTimestamp: string | undefined
): boolean {
  if (!visibleTimestamp) return true;
  if (!cachedTimestamp) return false;

  const visibleMs = parseRuntimeFreshnessTimestampMs(visibleTimestamp);
  const cachedMs = parseRuntimeFreshnessTimestampMs(cachedTimestamp);
  if (visibleMs === null || cachedMs === null) {
    return cachedTimestamp === visibleTimestamp;
  }
  return cachedMs >= visibleMs;
}

function doesTeamAgentRuntimeFreshnessSnapshotExtendVisible(
  visibleSnapshot: TeamAgentRuntimeSnapshot,
  cachedSnapshot: TeamAgentRuntimeSnapshot
): boolean {
  if (!areTeamAgentRuntimeSnapshotsEqual(visibleSnapshot, cachedSnapshot)) {
    return false;
  }
  if (
    !doesRuntimeFreshnessTimestampExtendVisible(visibleSnapshot.updatedAt, cachedSnapshot.updatedAt)
  ) {
    return false;
  }

  for (const [memberName, visibleEntry] of Object.entries(visibleSnapshot.members)) {
    const cachedEntry = cachedSnapshot.members[memberName];
    if (
      !cachedEntry ||
      !doesRuntimeFreshnessTimestampExtendVisible(visibleEntry.updatedAt, cachedEntry.updatedAt) ||
      !doesRuntimeFreshnessTimestampExtendVisible(
        visibleEntry.runtimeLastSeenAt,
        cachedEntry.runtimeLastSeenAt
      )
    ) {
      return false;
    }
  }

  return true;
}

function getTeamAgentRuntimeFreshnessSnapshot(
  teamName: string,
  visibleSnapshot: TeamAgentRuntimeSnapshot | undefined,
  incomingSnapshot: TeamAgentRuntimeSnapshot
): TeamAgentRuntimeSnapshot | undefined {
  if (
    !visibleSnapshot ||
    visibleSnapshot.teamName !== incomingSnapshot.teamName ||
    visibleSnapshot.runId !== incomingSnapshot.runId
  ) {
    return visibleSnapshot;
  }

  const cachedSnapshot = teamAgentRuntimeFreshnessSnapshotsByTeamAndRun
    .get(teamName)
    ?.get(incomingSnapshot.runId);
  // The module cache may only extend the visible snapshot's freshness, never seed a reset scope.
  if (
    !cachedSnapshot ||
    cachedSnapshot.teamName !== incomingSnapshot.teamName ||
    cachedSnapshot.runId !== incomingSnapshot.runId ||
    !doesTeamAgentRuntimeFreshnessSnapshotExtendVisible(visibleSnapshot, cachedSnapshot)
  ) {
    return visibleSnapshot;
  }
  return cachedSnapshot;
}

function rememberTeamAgentRuntimeFreshnessSnapshot(
  teamName: string,
  snapshot: TeamAgentRuntimeSnapshot
): void {
  let snapshotsByRun = teamAgentRuntimeFreshnessSnapshotsByTeamAndRun.get(teamName);
  if (!snapshotsByRun) {
    snapshotsByRun = new Map<string | null, TeamAgentRuntimeSnapshot>();
    teamAgentRuntimeFreshnessSnapshotsByTeamAndRun.set(teamName, snapshotsByRun);
  }
  snapshotsByRun.set(snapshot.runId, snapshot);
}

function clearTeamAgentRuntimeFreshnessSnapshot(teamName: string): void {
  teamAgentRuntimeFreshnessSnapshotsByTeamAndRun.delete(teamName);
}

export function isTeamDataRefreshPending(teamName: string): boolean {
  return defaultTeamViewDataCoordinator.isRefreshPending(teamName);
}

export function __resetTeamSliceModuleStateForTests(): void {
  defaultTeamViewDataCoordinator.reset();
  defaultTeamMessageFeedCoordinator.reset();
  latestTeamsFetchRequestId = 0;
  inFlightGlobalTasksRefresh = null;
  pendingFreshGlobalTasksRefresh = false;
  reportedTeamLaunchEndRunIds.clear();
  reportedTeamLaunchStepKeys.clear();
  teamLaunchStepStartedAtByKey.clear();
  teamLaunchAnalyticsByRunId.clear();
  resetTeamTaskBoardAnalyticsForTests();
  teamAgentRuntimeFreshnessSnapshotsByTeamAndRun.clear();
  clearAllPendingReplyRefreshWaits();
  clearAllLastResolvedTeamDataRefreshes();
  clearAllTeamLocalStateEpochs();
  resetContextScopedRequestEpochForTests();
  clearAllMemberSpawnStatusesIpcBackoffs();
  clearAllTeamRefreshBurstDiagnostics();
  clearAllMemberSpawnUiEqualLastWarns();
  clearResolvedMemberSelectorCaches();
  clearTeamMessageSelectorCaches();
  resetGlobalTaskNotificationTrackerForTests();
}

function clearTeamScopedSelectorCaches(teamName: string): void {
  clearResolvedMemberSelectorCachesForTeam(teamName);
  clearTeamMessageSelectorCachesForTeam(teamName);
}

function clearTeamScopedTransientState(teamName: string): void {
  defaultTeamViewDataCoordinator.clearTeam(teamName);
  defaultTeamMessageFeedCoordinator.clearTeam(teamName);
  clearLastResolvedTeamDataRefreshAt(teamName);
  clearMemberSpawnStatusesIpcBackoff(teamName);
  clearTeamRefreshBurstDiagnostics(teamName);
  clearMemberSpawnUiEqualLastWarn(teamName);
  clearTeamAgentRuntimeFreshnessSnapshot(teamName);
  clearTeamScopedSelectorCaches(teamName);
}

interface ContextRequestScope {
  contextId: string;
  contextEpoch: number;
}

interface TeamRequestScope extends ContextRequestScope {
  teamStateEpoch: number;
}

function captureContextRequestScope(get: () => AppState): ContextRequestScope {
  return {
    contextId: get().activeContextId,
    contextEpoch: captureContextScopedRequestEpoch(),
  };
}

function isContextRequestScopeCurrent(get: () => AppState, scope: ContextRequestScope): boolean {
  return (
    get().activeContextId === scope.contextId &&
    isContextScopedRequestEpochCurrent(scope.contextEpoch)
  );
}

function captureTeamRequestScope(get: () => AppState, teamName: string): TeamRequestScope {
  return {
    ...captureContextRequestScope(get),
    teamStateEpoch: captureTeamLocalStateEpoch(teamName),
  };
}

function isTeamRequestScopeCurrent(
  get: () => AppState,
  teamName: string,
  scope: TeamRequestScope
): boolean {
  return (
    isContextRequestScopeCurrent(get, scope) &&
    isTeamLocalStateEpochCurrent(teamName, scope.teamStateEpoch)
  );
}

function buildTeamSummaryIndexes(teams: readonly TeamSummary[]): {
  teamByName: Record<string, TeamSummary>;
  teamBySessionId: Record<string, TeamSummary>;
} {
  const teamByName: Record<string, TeamSummary> = {};
  const teamBySessionId: Record<string, TeamSummary> = {};
  for (const team of teams) {
    teamByName[team.teamName] = team;
    if (team.leadSessionId) {
      teamBySessionId[team.leadSessionId] = team;
    }
    if (Array.isArray(team.sessionHistory)) {
      for (const sid of team.sessionHistory) {
        if (typeof sid === 'string' && sid) {
          teamBySessionId[sid] = team;
        }
      }
    }
  }
  return { teamByName, teamBySessionId };
}

function removeProvisioningSnapshotsForTeams(
  snapshots: Record<string, TeamSummary>,
  teams: readonly TeamSummary[]
): Record<string, TeamSummary> {
  let nextSnapshots = snapshots;
  for (const team of teams) {
    if (!Object.prototype.hasOwnProperty.call(nextSnapshots, team.teamName)) {
      continue;
    }
    if (nextSnapshots === snapshots) {
      nextSnapshots = { ...snapshots };
    }
    delete nextSnapshots[team.teamName];
  }
  return nextSnapshots;
}

export function __getTeamScopedTransientStateForTests(teamName: string): {
  hasResolvedMembersSelector: boolean;
  resolvedMemberSelectorCount: number;
  hasMergedMessagesSelector: boolean;
  memberMessagesSelectorCount: number;
  hasPendingFreshTeamDataRefresh: boolean;
  hasQueuedFullTeamDataRefreshAfterThin: boolean;
  hasPostPaintTeamEnrichmentTimer: boolean;
  hasQueuedHeadRefreshAfterOlder: boolean;
  hasPendingFreshMessagesHeadRefresh: boolean;
  hasPendingFreshMemberActivityMetaRefresh: boolean;
  hasLastResolvedTeamDataRefresh: boolean;
  hasCurrentLocalStateEpoch: boolean;
  hasMemberSpawnStatusesIpcBackoff: boolean;
  hasTeamRefreshBurstDiagnostics: boolean;
  hasMemberSpawnUiEqualLastWarn: boolean;
} {
  const messageSelectorCache = getTeamMessageSelectorCacheSnapshotForTeam(teamName);
  const resolvedMemberSelectorCacheSnapshot =
    getResolvedMemberSelectorCacheSnapshotForTeam(teamName);
  const messageFeedCoordinatorSnapshot = defaultTeamMessageFeedCoordinator.snapshot(teamName);
  const viewDataCoordinatorSnapshot = defaultTeamViewDataCoordinator.snapshot(teamName);

  return {
    hasResolvedMembersSelector: resolvedMemberSelectorCacheSnapshot.hasResolvedMembersSelector,
    resolvedMemberSelectorCount: resolvedMemberSelectorCacheSnapshot.resolvedMemberSelectorCount,
    hasMergedMessagesSelector: messageSelectorCache.hasMergedMessagesSelector,
    memberMessagesSelectorCount: messageSelectorCache.memberMessagesSelectorCount,
    hasPendingFreshTeamDataRefresh: viewDataCoordinatorSnapshot.hasPendingFreshTeamDataRefresh,
    hasQueuedFullTeamDataRefreshAfterThin:
      viewDataCoordinatorSnapshot.hasQueuedFullTeamDataRefreshAfterThin,
    hasPostPaintTeamEnrichmentTimer: viewDataCoordinatorSnapshot.hasPostPaintTeamEnrichmentTimer,
    hasQueuedHeadRefreshAfterOlder: messageFeedCoordinatorSnapshot.hasQueuedHeadRefreshAfterOlder,
    hasPendingFreshMessagesHeadRefresh: messageFeedCoordinatorSnapshot.hasPendingFreshHeadRefresh,
    hasPendingFreshMemberActivityMetaRefresh:
      messageFeedCoordinatorSnapshot.hasPendingFreshMemberActivityRefresh,
    hasLastResolvedTeamDataRefresh: hasLastResolvedTeamDataRefreshAt(teamName),
    hasCurrentLocalStateEpoch: hasTeamLocalStateEpoch(teamName),
    hasMemberSpawnStatusesIpcBackoff: hasMemberSpawnStatusesIpcBackoff(teamName),
    hasTeamRefreshBurstDiagnostics: hasTeamRefreshBurstDiagnostics(teamName),
    hasMemberSpawnUiEqualLastWarn: hasMemberSpawnUiEqualLastWarn(teamName),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Timeout after ${ms}ms: ${label}`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function maybeLogMemberSpawnUiEqualSuppressed(
  teamName: string,
  runId: string | null | undefined
): void {
  if (!shouldLogMemberSpawnUiEqualSuppressed(teamName, MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS)) {
    return;
  }
  logger.debug(
    `[perf] member-spawn snapshot suppressed team=${teamName} runId=${runId ?? 'none'} reason=member-spawn-ui-equal`
  );
}

function getProviderIdsFromTeamCreateRequest(
  request: Pick<TeamCreateRequest, 'providerId' | 'members'>
): (string | null)[] {
  return request.members.map((member) => member.providerId ?? request.providerId ?? null);
}

function getProviderIdsFromTeamData(data: TeamViewSnapshot | null | undefined): (string | null)[] {
  if (!data) return [];
  return data.members.map((member) => member.providerId ?? null);
}

function isMultimodelTeamRequest(
  request: Pick<TeamCreateRequest, 'providerId' | 'members'>
): boolean {
  return buildProviderMix(getProviderIdsFromTeamCreateRequest(request)).hasMixedProviders;
}

function buildTeamCreateLaunchAnalyticsContext(
  request: TeamCreateRequest,
  startedAtMs: number
): TeamLaunchAnalyticsContext {
  return {
    startedAtMs,
    memberCount: request.members.length,
    providerIds: getProviderIdsFromTeamCreateRequest(request),
  };
}

function buildTeamLaunchAnalyticsContext(
  request: TeamLaunchRequest,
  data: TeamViewSnapshot | null,
  startedAtMs: number
): TeamLaunchAnalyticsContext {
  const providerIds = getProviderIdsFromTeamData(data);
  return {
    startedAtMs,
    memberCount: data?.members.length ?? null,
    providerIds: providerIds.length > 0 ? providerIds : [request.providerId ?? null],
  };
}

function getProgressTimestampMs(value: string | undefined): number | null {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getLaunchStepForState(
  state: TeamProvisioningProgress['state']
): 'config_validation' | 'runtime_prepare' | 'member_spawn' | 'bootstrap' | 'ready_check' {
  if (state === 'validating') return 'config_validation';
  if (state === 'spawning') return 'runtime_prepare';
  if (state === 'configuring' || state === 'assembling') return 'member_spawn';
  if (state === 'finalizing') return 'bootstrap';
  return 'ready_check';
}

function isTerminalLaunchState(state: TeamProvisioningProgress['state']): boolean {
  return (
    state === 'ready' || state === 'disconnected' || state === 'failed' || state === 'cancelled'
  );
}

function recordTeamLaunchStepTransition(
  existingProgress: TeamProvisioningProgress | undefined,
  progress: TeamProvisioningProgress,
  data: TeamViewSnapshot | null
): void {
  const step = getLaunchStepForState(progress.state);
  const stepKey = `${progress.runId}:${step}`;
  const progressStartedAtMs = getProgressTimestampMs(progress.startedAt) ?? Date.now();
  if (!teamLaunchStepStartedAtByKey.has(stepKey) && !isTerminalLaunchState(progress.state)) {
    teamLaunchStepStartedAtByKey.set(stepKey, progressStartedAtMs);
  }
  if (!existingProgress || existingProgress.state === progress.state) return;

  const previousStep = getLaunchStepForState(existingProgress.state);
  const previousStepKey = `${progress.runId}:${previousStep}`;
  if (reportedTeamLaunchStepKeys.has(previousStepKey)) return;

  const endedAtMs =
    getProgressTimestampMs(progress.updatedAt) ??
    getProgressTimestampMs(existingProgress.updatedAt) ??
    Date.now();
  const startedAtMs =
    teamLaunchStepStartedAtByKey.get(previousStepKey) ??
    getProgressTimestampMs(existingProgress.updatedAt) ??
    getProgressTimestampMs(existingProgress.startedAt) ??
    progressStartedAtMs;
  const analyticsContext = teamLaunchAnalyticsByRunId.get(progress.runId) ?? null;
  const providerIds = analyticsContext?.providerIds.length
    ? analyticsContext.providerIds
    : getProviderIdsFromTeamData(data);
  const failedTransition =
    progress.state === 'failed' ||
    progress.state === 'cancelled' ||
    progress.state === 'disconnected';

  reportedTeamLaunchStepKeys.add(previousStepKey);
  teamLaunchStepStartedAtByKey.delete(previousStepKey);
  recordTeamLaunchStepEnd({
    step: previousStep,
    success: !failedTransition,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    memberCount: analyticsContext?.memberCount ?? data?.members.length ?? null,
    providerIds,
    errorClass: failedTransition
      ? classifyAnalyticsError(progress.error ?? progress.message)
      : 'none',
    partialFailure:
      progress.state === 'disconnected' ||
      progress.launchDiagnostics?.some((item) => item.severity === 'error') === true,
  });

  if (!isTerminalLaunchState(progress.state)) {
    teamLaunchStepStartedAtByKey.set(stepKey, endedAtMs);
  }
}

function estimateBase64Bytes(base64: string | null | undefined): number | null {
  if (typeof base64 !== 'string' || !base64) return null;
  const normalized = base64.includes(',') ? (base64.split(',').pop() ?? '') : base64;
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((normalized.length * 3) / 4) - padding);
}

function getAttachmentTotalSizeBytes(
  attachments:
    | readonly { size?: number; data?: string; base64Data?: string; base64?: string }[]
    | undefined
): number | null {
  if (!attachments?.length) return null;
  let total = 0;
  let hasKnownSize = false;
  for (const attachment of attachments) {
    const size =
      typeof attachment.size === 'number'
        ? attachment.size
        : estimateBase64Bytes(attachment.data ?? attachment.base64Data ?? attachment.base64);
    if (typeof size === 'number' && Number.isFinite(size) && size >= 0) {
      total += size;
      hasKnownSize = true;
    }
  }
  return hasKnownSize ? total : null;
}

function getAttachmentMimeTypes(
  attachments: readonly { mimeType?: string; type?: string }[] | undefined
): (string | null)[] {
  return attachments?.map((attachment) => attachment.mimeType ?? attachment.type ?? null) ?? [];
}

function getTeamLifecycleAnalyticsContext(data: TeamViewSnapshot | null): {
  memberCount: number | null;
  providerIds: (string | null)[];
  runtimeActive: boolean | null;
  hadRunningTasks: boolean | null;
} {
  return {
    memberCount: data?.members.length ?? null,
    providerIds: getProviderIdsFromTeamData(data),
    runtimeActive: typeof data?.isAlive === 'boolean' ? data.isAlive : null,
    hadRunningTasks: data ? data.tasks.some((task) => task.status === 'in_progress') : null,
  };
}

function clearTeamLaunchStepTracking(runId: string): void {
  for (const key of teamLaunchStepStartedAtByKey.keys()) {
    if (key.startsWith(`${runId}:`)) {
      teamLaunchStepStartedAtByKey.delete(key);
    }
  }
}

function recordTeamLaunchTerminalProgress(
  progress: TeamProvisioningProgress,
  data: TeamViewSnapshot | null
): void {
  if (reportedTeamLaunchEndRunIds.has(progress.runId)) return;
  reportedTeamLaunchEndRunIds.add(progress.runId);
  const analyticsContext = teamLaunchAnalyticsByRunId.get(progress.runId) ?? null;
  teamLaunchAnalyticsByRunId.delete(progress.runId);
  const success = progress.state === 'ready';
  const partialFailure =
    progress.state === 'disconnected' ||
    progress.launchDiagnostics?.some((item) => item.severity === 'error') === true;
  const fallbackProviderIds = getProviderIdsFromTeamData(data);

  recordTeamLaunchEnd({
    success,
    durationMs: elapsedMsBetweenIso(progress.startedAt, progress.updatedAt),
    memberCount: analyticsContext?.memberCount ?? data?.members.length ?? null,
    providerIds: analyticsContext?.providerIds.length
      ? analyticsContext.providerIds
      : fallbackProviderIds,
    failureReasonClass: success
      ? 'none'
      : classifyAnalyticsError(progress.error ?? progress.message),
    partialFailure,
  });
  clearTeamLaunchStepTracking(progress.runId);
}

function recordTeamLaunchIpcFailure(
  analyticsContext: TeamLaunchAnalyticsContext,
  error: unknown
): void {
  recordTeamLaunchEnd({
    success: false,
    durationMs: elapsedMsSince(analyticsContext.startedAtMs),
    memberCount: analyticsContext.memberCount,
    providerIds: analyticsContext.providerIds,
    failureReasonClass: classifyAnalyticsError(error),
    partialFailure: false,
  });
}

function buildGlobalTaskProjectionNotification(
  state: Pick<AppState, 'appConfig' | 'globalTasks' | 'globalTasksInitialized' | 'teamByName'>,
  nextGlobalTasks: GlobalTask[]
): GlobalTaskNotificationParams | null {
  if (!state.globalTasksInitialized || nextGlobalTasks === state.globalTasks) {
    return null;
  }

  return {
    oldTasks: state.globalTasks,
    newTasks: nextGlobalTasks,
    appConfig: state.appConfig,
    teamByName: state.teamByName,
    isInitialFetch: false,
  };
}

export interface GlobalTaskDetailState {
  teamName: string;
  taskId: string;
  commentId?: string;
}

export interface PendingMemberProfileState {
  teamName?: string;
  memberName: string;
  focus?: 'profile' | 'messages' | 'logs';
}

type TeamSectionTarget = NonNullable<Extract<NotificationTarget, { kind: 'team' }>['section']>;

export interface PendingTeamSectionFocusState {
  teamName: string;
  section: TeamSectionTarget;
}

function isVisibleInActiveTeamSurface(
  state: Pick<AppState, 'paneLayout'>,
  teamName: string | null | undefined
): boolean {
  if (!teamName) {
    return false;
  }
  return state.paneLayout.panes.some((pane) => {
    if (!pane.activeTabId) {
      return false;
    }
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return (
      (activeTab?.type === 'team' || activeTab?.type === 'graph') && activeTab.teamName === teamName
    );
  });
}

export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningControlSlice,
    TeamProvisioningLaunchSlice,
    TeamProvisioningProgressSlice,
    TeamRuntimeObservationSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
  teams: TeamSummary[];
  /** O(1) lookup to avoid array scans in render-hot paths */
  teamByName: Record<string, TeamSummary>;
  /** O(1) lookup: sessionId -> owning team (lead + history) */
  teamBySessionId: Record<string, TeamSummary>;
  /** Centralized git branch cache: normalizedPath → branch name | null */
  branchByPath: Record<string, string | null>;
  teamsLoading: boolean;
  teamsError: string | null;
  globalTasks: GlobalTask[];
  globalTasksLoading: boolean;
  globalTasksInitialized: boolean;
  globalTasksError: string | null;
  globalTaskDetail: GlobalTaskDetailState | null;
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => void;
  closeGlobalTaskDetail: () => void;
  /** Set by MemberHoverCard to signal TeamDetailView to open MemberDetailDialog */
  pendingMemberProfile: PendingMemberProfileState | null;
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => void;
  closeMemberProfile: () => void;
  pendingTeamSectionFocus: PendingTeamSectionFocusState | null;
  focusTeamSection: (teamName: string, section: TeamSectionTarget) => void;
  clearTeamSectionFocus: () => void;
  /** Set by GlobalTaskDetailDialog to signal TeamDetailView to open ChangeReviewDialog */
  pendingReviewRequest: {
    taskId: string;
    filePath?: string;
    requestOptions: TaskChangeRequestOptions;
  } | null;
  setPendingReviewRequest: (
    req: { taskId: string; filePath?: string; requestOptions: TaskChangeRequestOptions } | null
  ) => void;
  teamsProjectNavigationIntent: {
    projectId: string;
    projectPath: string;
  } | null;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  /** Synthetic TeamSummary snapshots for teams currently being provisioned (before config.json exists). */
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  /** Runs explicitly cleared after Unknown runId polling; late events/progress for them are ignored. */
  ignoredProvisioningRunIds: Record<string, string>;
  /** Runtime runs explicitly tombstoned after stop/offline so late events cannot resurrect UI state. */
  ignoredRuntimeRunIds: Record<string, string>;
  /**
   * Per-team lower bound for provisioning progress timestamps.
   * Used to ignore late progress events from a previous run after stop→launch.
   */
  provisioningStartedAtFloorByTeam: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  leadContextByTeam: Record<string, LeadContextUsage>;
  activeTaskLogActivityByTeam: Record<string, Record<string, true>>;
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
  /** Per-team per-member spawn statuses during team provisioning/launch. */
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  provisioningErrorByTeam: Record<string, string | null>;
  clearProvisioningError: (teamName?: string) => void;
  kanbanFilterQuery: string | null;
  fetchBranches: (paths: string[]) => Promise<void>;
  fetchTeams: () => Promise<void>;
  fetchAllTasks: () => Promise<void>;
  openTeamsTab: (projectPath?: string) => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
  restartMember: (teamName: string, memberName: string) => Promise<void>;
  skipMemberForLaunch: (teamName: string, memberName: string) => Promise<void>;
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  restoreMember: (teamName: string, memberName: string) => Promise<void>;
  updateMemberRole: (
    teamName: string,
    memberName: string,
    role: string | undefined
  ) => Promise<void>;
  retryFailedOpenCodeSecondaryLanes: (
    teamName: string
  ) => Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  pendingApprovals: ToolApprovalRequest[];
  /** Resolved permission approvals: request_id → allowed (true/false). Used for noise row icons. */
  resolvedApprovals: Map<string, boolean>;
  toolApprovalSettings: ToolApprovalSettings;
  updateToolApprovalSettings: (
    patch: Partial<ToolApprovalSettings>,
    forTeam?: string
  ) => Promise<void>;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;

  // Messages panel UI state
  messagesPanelMode: TeamMessagesPanelMode;
  messagesPanelWidth: number;
  sidebarLogsHeight: number;
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => void;
  setMessagesPanelWidth: (width: number) => void;
  setSidebarLogsHeight: (height: number) => void;
}

export function getCurrentProvisioningProgressForTeam(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): TeamProvisioningProgress | null {
  const currentRunId = state.currentProvisioningRunIdByTeam[teamName];
  return currentRunId ? (state.provisioningRuns[currentRunId] ?? null) : null;
}

export function isTeamProvisioningActive(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const current = getCurrentProvisioningProgressForTeam(state, teamName);
  return current != null && isActiveProvisioningState(current.state);
}

const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

function loadToolApprovalSettingsForTeam(teamName: string): ToolApprovalSettings {
  return parseToolApprovalSettings(localStorage.getItem(TOOL_APPROVAL_PREFIX + teamName));
}

/** Load global settings (legacy fallback for first load / no team selected). */
function loadToolApprovalSettings(): ToolApprovalSettings {
  return parseToolApprovalSettings(localStorage.getItem('team:toolApprovalSettings'));
}

export const createTeamSlice: StateCreator<AppState, [], [], TeamSlice> = (set, get) => ({
  teams: [],
  teamByName: {},
  teamBySessionId: {},
  branchByPath: {},
  teamsLoading: false,
  teamsError: null,
  globalTasks: [],
  globalTasksLoading: false,
  globalTasksInitialized: false,
  globalTasksError: null,
  ...createTeamViewDataRendererSlice<TeamRequestScope, GlobalTaskNotificationParams>({
    actions: {
      getActions: () => get(),
    },
    coordinator: defaultTeamViewDataCoordinator,
    diagnostics: {
      debug: (message) => logger.debug(message),
      noteRefreshBurst: (teamName) => noteTeamRefreshBurst(teamName, TEAM_REFRESH_BURST_WINDOW_MS),
      warn: (message) => logger.warn(message),
    },
    globalTasks: {
      buildNotification: buildGlobalTaskProjectionNotification,
      notify: processGlobalTaskNotifications,
      project: projectTeamSnapshotOntoGlobalTasks,
    },
    lifecycle: {
      isMemberActivityMetaStale: (teamName) => isMemberActivityMetaStale(get(), teamName),
      isProvisioningActive: (teamName) => isTeamProvisioningActive(get(), teamName),
      recordLastResolvedRefresh: recordLastResolvedTeamDataRefresh,
      recordTaskBoardTransitions: recordTeamTaskBoardSnapshotTransitions,
      shouldInvalidateCachedData: shouldInvalidateCachedTeamDataForError,
    },
    requestScope: {
      capture: (teamName) => captureTeamRequestScope(get, teamName),
      isCurrent: (teamName, scope) => isTeamRequestScopeCurrent(get, teamName, scope),
    },
    selectionEffects: {
      autoSelectProject: (projectPath) => {
        const state = get();
        const normalizedTeamPath = normalizePath(projectPath);
        const matchingProject = state.projects.find(
          (project) => normalizePath(project.path) === normalizedTeamPath
        );
        if (matchingProject && state.selectedProjectId !== matchingProject.id) {
          state.selectProject(matchingProject.id);
          return;
        }
        if (matchingProject) return;

        for (const repository of state.repositoryGroups) {
          const matchingWorktree = repository.worktrees.find(
            (worktree) => normalizePath(worktree.path) === normalizedTeamPath
          );
          if (!matchingWorktree) continue;
          if (state.selectedWorktreeId !== matchingWorktree.id) {
            set(getWorktreeNavigationState(repository.id, matchingWorktree.id));
            void get().fetchSessionsInitial(matchingWorktree.id);
          }
          break;
        }
      },
      loadToolApprovalSettings: loadToolApprovalSettingsForTeam,
      syncTabLabels: (teamName, displayName) => {
        const relatedTabs = get()
          .getAllPaneTabs()
          .filter(
            (tab) => (tab.type === 'team' || tab.type === 'graph') && tab.teamName === teamName
          );
        for (const tab of relatedTabs) {
          const nextLabel = tab.type === 'graph' ? `${displayName} Graph` : displayName;
          if (tab.label !== nextLabel) {
            get().updateTabLabel(tab.id, nextLabel);
          }
        }
      },
    },
    snapshots: {
      getForTeam: selectTeamDataForName,
      preserveKnownTaskChangePresence,
      shouldPreserveSelectedSnapshot: shouldPreserveSelectedTeamSnapshot,
      structurallyShare: structurallyShareTeamSnapshot,
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
    tasks: {
      collectInvalidation: collectTaskChangeInvalidation,
    },
  }),
  teamsProjectNavigationIntent: null,
  ...createInitialTeamGraphLayoutState(),
  ...createTeamMessageFeedRendererSlice<TeamRequestScope>({
    actions: {
      getActions: () => get(),
    },
    activityPolicy: {
      isStale: isMemberActivityMetaStale,
      structurallyShareMembers: structurallyShareMemberActivityFacts,
    },
    cachePolicy: {
      areMessageArraysEquivalent: areInboxMessageArraysEquivalent,
      extractRetainedOlderTail: extractRetainedCanonicalOlderTail,
      getCanonicalHeadSlice,
      getEntry: getTeamMessagesCacheEntry,
      mergeMessages: mergeTeamMessages,
      pruneOptimisticMessages,
    },
    coordinator: defaultTeamMessageFeedCoordinator,
    pendingReplyPolicy: {
      setEnabled: setPendingReplyRefreshEnabled,
    },
    requestScope: {
      capture: (teamName) => captureTeamRequestScope(get, teamName),
      isCurrent: (teamName, scope) => isTeamRequestScopeCurrent(get, teamName, scope),
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  ...createTeamMessageDeliveryRendererSlice<AppState, ContextRequestScope>({
    analytics: {
      classifyError: classifyAnalyticsError,
      recordAttachment: ({ attachments, success, errorClass }) =>
        recordAttachmentAttachEnd({
          source: 'message',
          success,
          fileCount: attachments.length,
          totalSizeBytes: getAttachmentTotalSizeBytes(attachments),
          mimeTypes: getAttachmentMimeTypes(attachments),
          errorClass,
        }),
      recordCrossTeamMessage: (input) => recordCrossTeamMessageSend({ ...input }),
    },
    clock: {
      nowIso,
    },
    crossTeamTransport: {
      listTargets: () => api.crossTeam.listTargets(),
      send: (request) => api.crossTeam.send(request),
    },
    diagnostics: {
      build: buildOpenCodeRuntimeDeliveryDiagnostics,
      isHardFailure: isOpenCodeRuntimeDeliveryHardUxFailure,
    },
    errors: {
      mapSendError: mapSendMessageError,
    },
    log: {
      recordCrossTeamTargetsFailure: (error) => logger.error('fetchCrossTeamTargets failed', error),
    },
    optimisticMessages: {
      project: (state, teamName, message) => ({
        teamMessagesByName: {
          ...state.teamMessagesByName,
          [teamName]: upsertOptimisticTeamMessage(
            getTeamMessagesCacheEntry(state, teamName),
            message
          ),
        },
      }),
    },
    refresh: {
      refreshMessageHead: (teamName) => get().refreshTeamMessagesHead(teamName),
    },
    requestScope: {
      capture: () => captureContextRequestScope(get),
      isCurrent: (scope) => isContextRequestScopeCurrent(get, scope),
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
    transport: {
      getRuntimeDeliveryStatus: (teamName, messageId) =>
        unwrapIpc('team:getOpenCodeRuntimeDeliveryStatus', () =>
          api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, messageId)
        ),
      send: (teamName, request) =>
        unwrapIpc('team:sendMessage', () => api.teams.sendMessage(teamName, request)),
    },
  }),
  ...createTeamTaskBoardRendererSlice({
    getState: () => {
      const state = get();
      return {
        checkTaskHasChanges: state.checkTaskHasChanges,
        fetchAllTasks: state.fetchAllTasks,
        getTeamData: (teamName) => selectTeamDataForName(state, teamName),
        invalidateTaskChangePresence: state.invalidateTaskChangePresence,
        refreshTeamData: state.refreshTeamData,
        selectedTeamData: state.selectedTeamData,
        selectedTeamName: state.selectedTeamName,
      };
    },
    mapReviewError,
    setState: (state) => set(state),
  }),
  ...createTeamTaskArtifactsRendererSlice<AppState, TeamRequestScope>({
    analytics: {
      classifyError: classifyAnalyticsError,
      recordAttachment: ({ attachments, source, success, errorClass }) =>
        recordAttachmentAttachEnd({
          source,
          success,
          fileCount: attachments.length,
          totalSizeBytes: getAttachmentTotalSizeBytes(attachments),
          mimeTypes: getAttachmentMimeTypes(attachments),
          errorClass,
        }),
    },
    ids: {
      randomUUID: () => crypto.randomUUID(),
    },
    refresh: {
      refreshTeamData: (teamName) => get().refreshTeamData(teamName),
    },
    requestScope: {
      capture: (teamName) => captureTeamRequestScope(get, teamName),
      isCurrent: (teamName, scope) => isTeamRequestScopeCurrent(get, teamName, scope),
    },
    state: {
      getState: () => get(),
      selectTeamData: (state, teamName) => selectTeamDataForName(state, teamName),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
    transport: createTeamTaskArtifactsTransport(),
  }),
  ...createTeamLifecycleMutationSlice<
    AppState,
    ReturnType<typeof getTeamLifecycleAnalyticsContext>
  >({
    analytics: {
      captureSoftDelete: (teamName) =>
        getTeamLifecycleAnalyticsContext(selectTeamDataForName(get(), teamName)),
      recordSoftDeleteFailure: (context, error) =>
        recordTeamDelete({
          source: 'store',
          success: false,
          ...context,
          errorClass: classifyAnalyticsError(error),
        }),
      recordSoftDeleteSuccess: (context) =>
        recordTeamDelete({
          source: 'store',
          success: true,
          ...context,
          errorClass: 'none',
        }),
    },
    cleanup: createTeamLifecycleMutationCleanup<AppState>({
      buildProgressTombstones: (state, teamName, floor) =>
        buildTeamScopedProgressTombstones(state, teamName, floor),
      collectStateRemovals: (state, teamName) => collectTeamScopedStateRemovals(state, teamName),
      resetScope: (teamName, mutation) => {
        invalidateTeamLocalStateEpoch(teamName);
        if (mutation === 'soft-delete') {
          clearTeamTaskBoardAnalytics(teamName);
        }
        defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
        clearPendingReplyRefreshWaits(teamName);
        clearTeamScopedTransientState(teamName);
      },
    }),
    clock: {
      nowIso,
    },
    refresh: {
      fetchAllTasks: () => get().fetchAllTasks(),
      fetchTeams: () => get().fetchTeams(),
    },
    state: {
      setState: (update) => set((state) => update(state)),
    },
    transport: {
      permanentlyDelete: (teamName) =>
        unwrapIpc('team:permanentlyDeleteTeam', () => api.teams.permanentlyDeleteTeam(teamName)),
      restore: (teamName) => unwrapIpc('team:restoreTeam', () => api.teams.restoreTeam(teamName)),
      softDelete: (teamName) => unwrapIpc('team:deleteTeam', () => api.teams.deleteTeam(teamName)),
    },
  }),
  provisioningRuns: {},
  provisioningSnapshotByTeam: {},
  currentProvisioningRunIdByTeam: {},
  currentRuntimeRunIdByTeam: {},
  ignoredProvisioningRunIds: {},
  ignoredRuntimeRunIds: {},
  ...createTeamProvisioningControlSlice({
    effects: {
      applyProgress: (progress) => get().onProvisioningProgress(progress),
      clearLaunchTracking: (runId) => {
        teamLaunchAnalyticsByRunId.delete(runId);
        clearTeamLaunchStepTracking(runId);
      },
      clearRuntimeFreshness: clearTeamAgentRuntimeFreshnessSnapshot,
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  ...createTeamProvisioningLaunchSlice<TeamMessagesCacheEntry, TeamLaunchAnalyticsContext>({
    analytics: {
      createContext: buildTeamCreateLaunchAnalyticsContext,
      launchContext: buildTeamLaunchAnalyticsContext,
      recordCreateAccepted: (request, runId, context) => {
        teamLaunchAnalyticsByRunId.set(runId, context);
        recordTeamCreate({
          source: 'dialog',
          memberCount: request.members.length,
          providerIds: getProviderIdsFromTeamCreateRequest(request),
          multimodelEnabled: isMultimodelTeamRequest(request),
        });
      },
      recordIpcFailure: recordTeamLaunchIpcFailure,
      recordLaunchAccepted: (runId, context) => {
        teamLaunchAnalyticsByRunId.set(runId, context);
      },
    },
    control: {
      clearMissingRun: (runId) => get().clearMissingProvisioningRun(runId),
      getStatus: (runId) => get().getProvisioningStatus(runId),
      subscribe: () => get().subscribeProvisioningProgress(),
    },
    scope: {
      collectVisibleLoadingResets: (state, teamName) =>
        collectTeamScopedVisibleLoadingResets(state, teamName),
      getTeamData: (teamName) => selectTeamDataForName(get(), teamName),
      reset: (teamName) => {
        invalidateTeamLocalStateEpoch(teamName);
        defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
        clearPendingReplyRefreshWaits(teamName);
        clearTeamScopedTransientState(teamName);
      },
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  ...createTeamProvisioningProgressSlice({
    analytics: {
      noteRefreshFanout: (note) =>
        noteTeamRefreshFanout({
          ...note,
          surface: 'provisioning-progress',
        }),
      recordStepTransition: (existingProgress, progress) =>
        recordTeamLaunchStepTransition(
          existingProgress,
          progress,
          selectTeamDataForName(get(), progress.teamName)
        ),
      recordTerminalProgress: (progress) =>
        recordTeamLaunchTerminalProgress(progress, selectTeamDataForName(get(), progress.teamName)),
    },
    refresh: {
      fetchMemberSpawnStatuses: (teamName) => get().fetchMemberSpawnStatuses(teamName),
      fetchTeamAgentRuntime: (teamName) => get().fetchTeamAgentRuntime(teamName),
      fetchTeams: () => get().fetchTeams(),
      getSurface: (teamName) => {
        const state = get();
        return {
          hasSelectedTeamData: state.selectedTeamData != null,
          selected: state.selectedTeamName === teamName,
          visible: isVisibleInActiveTeamSurface(state, teamName),
        };
      },
      refreshTeamData: (teamName, options) => get().refreshTeamData(teamName, options),
      selectTeam: (teamName, options) => get().selectTeam(teamName, options),
    },
    runtime: {
      clearFreshness: clearTeamAgentRuntimeFreshnessSnapshot,
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  provisioningStartedAtFloorByTeam: {},
  leadActivityByTeam: {},
  leadContextByTeam: {},
  activeTaskLogActivityByTeam: {},
  activeToolsByTeam: {},
  finishedVisibleByTeam: {},
  toolHistoryByTeam: {},
  memberSpawnStatusesByTeam: {},
  memberSpawnSnapshotsByTeam: {},
  teamAgentRuntimeByTeam: {},
  ...createTeamRuntimeObservationSlice<TeamRequestScope>({
    backoff: {
      clearMemberSpawnBackoff: clearMemberSpawnStatusesIpcBackoff,
      isMemberSpawnBackoffActive: isMemberSpawnStatusesIpcBackoffActive,
      recordMissingMemberSpawnHandler: (teamName) =>
        recordMemberSpawnStatusesIpcRetryBackoff(
          teamName,
          MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS
        ),
    },
    memberSpawnPolicy: {
      areSnapshotsEqual: areMemberSpawnSnapshotsSemanticallyEqual,
      recordEquivalentSnapshot: maybeLogMemberSpawnUiEqualSuppressed,
    },
    requestScope: {
      capture: (teamName) => captureTeamRequestScope(get, teamName),
      isCurrent: (teamName, scope) => isTeamRequestScopeCurrent(get, teamName, scope),
    },
    runtimeSnapshotPolicy: {
      areVisibleSnapshotsEqual: areTeamAgentRuntimeSnapshotsEqual,
      getFreshnessSnapshot: getTeamAgentRuntimeFreshnessSnapshot,
      rememberFreshnessSnapshot: rememberTeamAgentRuntimeFreshnessSnapshot,
      stabilizeSnapshot: stabilizeTeamAgentRuntimeSnapshot,
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  provisioningErrorByTeam: {},
  clearProvisioningError: (teamName?: string) =>
    set((state) => {
      if (!teamName) {
        return { provisioningErrorByTeam: {} };
      }

      if (!(teamName in state.provisioningErrorByTeam)) {
        return {};
      }

      const nextErrors = { ...state.provisioningErrorByTeam };
      delete nextErrors[teamName];
      return { provisioningErrorByTeam: nextErrors };
    }),
  kanbanFilterQuery: null,
  globalTaskDetail: null,
  pendingMemberProfile: null,
  pendingTeamSectionFocus: null,
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => set({ pendingMemberProfile: { memberName, teamName, focus } }),
  closeMemberProfile: () => set({ pendingMemberProfile: null }),
  focusTeamSection: (teamName: string, section: TeamSectionTarget) =>
    set({ pendingTeamSectionFocus: { teamName, section } }),
  clearTeamSectionFocus: () => set({ pendingTeamSectionFocus: null }),
  pendingReviewRequest: null,
  setPendingReviewRequest: (req) => set({ pendingReviewRequest: req }),
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => {
    set({ globalTaskDetail: { teamName, taskId, commentId } });
  },
  closeGlobalTaskDetail: () => set({ globalTaskDetail: null }),
  pendingApprovals: [],
  resolvedApprovals: new Map(),
  toolApprovalSettings: loadToolApprovalSettings(),

  // Messages panel UI state
  messagesPanelMode: loadPersistedMessagesPanelMode(),
  messagesPanelWidth: 340,
  sidebarLogsHeight: 213,
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => {
    savePersistedMessagesPanelMode(mode);
    set({ messagesPanelMode: mode });
  },
  setMessagesPanelWidth: (width: number) => set({ messagesPanelWidth: width }),
  setSidebarLogsHeight: (height: number) => set({ sidebarLogsHeight: height }),

  fetchBranches: async (paths: string[]) => {
    const entries = await Promise.all(
      paths.map(async (p) => {
        try {
          const branch = await api.teams.getProjectBranch(p);
          return [normalizePath(p), branch] as const;
        } catch {
          return [normalizePath(p), null] as const;
        }
      })
    );
    const results: Record<string, string | null> = Object.fromEntries(entries);
    if (Object.keys(results).length > 0) {
      set((state) => {
        let changed = false;
        for (const [key, value] of Object.entries(results)) {
          if (state.branchByPath[key] !== value) {
            changed = true;
            break;
          }
        }
        if (!changed) {
          return {};
        }
        return { branchByPath: { ...state.branchByPath, ...results } };
      });
    }
  },

  fetchTeams: async () => {
    // Guard: prevent concurrent fetches (component mount + centralized init chain).
    // Only effective during initial load (when teamsLoading is set to true below).
    // Refreshes are already serialized by the throttle timer in onTeamChange.
    if (get().teamsLoading) return;
    const requestScope = captureContextRequestScope(get);
    const requestId = ++latestTeamsFetchRequestId;
    // Only show loading spinner on initial load — avoids flickering when refreshing
    const isInitialLoad = get().teams.length === 0;
    if (isInitialLoad) {
      set({ teamsLoading: true, teamsError: null });
    }
    try {
      const teams = await withTimeout(
        unwrapIpc('team:list', () => api.teams.list()),
        TEAM_FETCH_TIMEOUT_MS,
        'fetchTeams'
      );
      if (
        !isContextRequestScopeCurrent(get, requestScope) ||
        latestTeamsFetchRequestId !== requestId
      ) {
        return;
      }
      // Atomic update: set teams AND clean up provisioning snapshots in one call
      // to prevent any render cycle with duplicate cards.
      set((state) => {
        const nextTeams = structurallySharePlainValue(state.teams, teams);
        const indexes = buildTeamSummaryIndexes(nextTeams);
        const nextTeamByName = structurallySharePlainValue(state.teamByName, indexes.teamByName);
        const nextTeamBySessionId = structurallySharePlainValue(
          state.teamBySessionId,
          indexes.teamBySessionId
        );
        const nextSnapshots = removeProvisioningSnapshotsForTeams(
          state.provisioningSnapshotByTeam,
          nextTeams
        );

        if (
          nextTeams === state.teams &&
          nextTeamByName === state.teamByName &&
          nextTeamBySessionId === state.teamBySessionId &&
          nextSnapshots === state.provisioningSnapshotByTeam &&
          state.teamsLoading === false &&
          state.teamsError === null
        ) {
          return {};
        }

        return {
          teams: nextTeams,
          teamByName: nextTeamByName,
          teamBySessionId: nextTeamBySessionId,
          teamsLoading: false,
          teamsError: null,
          provisioningSnapshotByTeam: nextSnapshots,
        };
      });
    } catch (error) {
      if (
        !isContextRequestScopeCurrent(get, requestScope) ||
        latestTeamsFetchRequestId !== requestId
      ) {
        return;
      }
      // On refresh failure, keep existing teams visible
      set({
        teamsLoading: false,
        teamsError: isInitialLoad
          ? error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to fetch teams'
          : null,
      });
    }
  },

  fetchAllTasks: async () => {
    if (inFlightGlobalTasksRefresh) {
      const inFlightScope = inFlightGlobalTasksRefreshScope;
      if (
        get().globalTasksInitialized ||
        (inFlightScope && !isContextRequestScopeCurrent(get, inFlightScope))
      ) {
        pendingFreshGlobalTasksRefresh = true;
      }
      await inFlightGlobalTasksRefresh;
      return;
    }

    const runRefresh = async (): Promise<void> => {
      do {
        const isFollowUpRefresh = pendingFreshGlobalTasksRefresh;
        if (isFollowUpRefresh) {
          await sleep(GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS);
        }
        pendingFreshGlobalTasksRefresh = false;

        // Show skeleton only on the very first fetch — not on subsequent refreshes
        // even when the task list is empty (avoids flickering skeleton on every watcher event).
        const isInitialLoad = !get().globalTasksInitialized;
        if (isInitialLoad) {
          set({ globalTasksLoading: true, globalTasksError: null });
        }
        const requestScope = captureContextRequestScope(get);
        inFlightGlobalTasksRefreshScope = requestScope;
        const oldTasks = get().globalTasks;
        try {
          const tasks = await withTimeout(
            unwrapIpc('team:getAllTasks', () => api.teams.getAllTasks()),
            TEAM_FETCH_TIMEOUT_MS,
            'fetchAllTasks'
          );
          if (!isContextRequestScopeCurrent(get, requestScope)) {
            continue;
          }
          const notificationState = get();
          const wasFirst = consumeFirstGlobalTasksFetchFlag();
          processGlobalTaskNotifications({
            oldTasks,
            newTasks: tasks,
            appConfig: notificationState.appConfig,
            teamByName: notificationState.teamByName,
            isInitialFetch: wasFirst,
          });

          set((state) => ({
            globalTasks: structurallySharePlainValue(state.globalTasks, tasks),
            globalTasksLoading: false,
            globalTasksInitialized: true,
            globalTasksError: null,
          }));
        } catch (error) {
          if (!isContextRequestScopeCurrent(get, requestScope)) {
            continue;
          }
          set({
            globalTasksLoading: false,
            globalTasksInitialized: true,
            globalTasksError: isInitialLoad
              ? error instanceof IpcError
                ? error.message
                : error instanceof Error
                  ? error.message
                  : 'Failed to fetch tasks'
              : null,
          });
        }
      } while (pendingFreshGlobalTasksRefresh);
    };

    const request = runRefresh().finally(() => {
      if (inFlightGlobalTasksRefresh === request) {
        inFlightGlobalTasksRefresh = null;
        inFlightGlobalTasksRefreshScope = null;
      }
    });
    inFlightGlobalTasksRefresh = request;
    await request;
  },

  openTeamsTab: (projectPath?: string) => {
    const state = get();
    const normalizedProjectPath = projectPath?.trim() ?? '';
    set({
      teamsProjectNavigationIntent:
        normalizedProjectPath && state.selectedProjectId
          ? {
              projectId: state.selectedProjectId,
              projectPath: normalizedProjectPath,
            }
          : null,
    });
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const teamsTab = focusedPane?.tabs.find((tab) => tab.type === 'teams');
    if (teamsTab) {
      state.setActiveTab(teamsTab.id);
      return;
    }

    state.openTab({
      type: 'teams',
      label: 'Teams',
    });
  },

  openTeamTab: (teamName: string, projectPath?: string, _taskId?: string) => {
    if (!teamName.trim()) {
      return;
    }

    // If projectPath is provided, immediately select the matching project in the sidebar.
    // This avoids a race condition where config.json hasn't been updated with projectPath yet.
    if (projectPath) {
      const stateForProject = get();
      const normalizedPath = normalizePath(projectPath);
      const matchingProject = stateForProject.projects.find(
        (p) => normalizePath(p.path) === normalizedPath
      );
      if (matchingProject && stateForProject.selectedProjectId !== matchingProject.id) {
        stateForProject.selectProject(matchingProject.id);
      }
    }

    const state = get();
    // Use display name from teams list or selected team data if available
    const teamSummary = state.teamByName[teamName];
    const selectedTeamDisplayName =
      state.selectedTeamName === teamName ? state.selectedTeamData?.config.name : undefined;
    const displayName = teamSummary?.displayName || selectedTeamDisplayName || teamName;

    const allTabs = state.getAllPaneTabs();
    const existing = allTabs.find((tab) => tab.type === 'team' && tab.teamName === teamName);
    if (existing) {
      state.setActiveTab(existing.id);
      // Sync label in case display name changed
      if (existing.label !== displayName) {
        state.updateTabLabel(existing.id, displayName);
      }
    } else {
      state.openTab({
        type: 'team',
        label: displayName,
        teamName,
      });
    }
  },

  clearKanbanFilter: () => {
    set({ kanbanFilterQuery: null });
  },

  ...createTeamGraphLayoutActions<AppState>({
    setState: (updater) => set((state) => updater(state) ?? state),
    selectDefaultLayoutSeed: (state, teamName) => {
      const teamData = selectTeamDataForName(state, teamName);
      return teamData
        ? buildTeamGraphDefaultLayoutSeed(teamData.members, teamData.config.members ?? [])
        : null;
    },
    warn: (message) => logger.warn(message),
  }),
  addMember: async (teamName: string, request: AddMemberRequest) => {
    await unwrapIpc('team:addMember', () => api.teams.addMember(teamName, request));
    await get().refreshTeamData(teamName);
  },

  restartMember: async (teamName: string, memberName: string) => {
    try {
      await unwrapIpc('team:restartMember', () => api.teams.restartMember(teamName, memberName));
    } finally {
      await Promise.allSettled([
        get().refreshTeamMessagesHead(teamName),
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  },

  retryFailedOpenCodeSecondaryLanes: async (teamName: string) => {
    try {
      return await unwrapIpc('team:retryFailedOpenCodeSecondaryLanes', () =>
        api.teams.retryFailedOpenCodeSecondaryLanes(teamName)
      );
    } finally {
      await Promise.allSettled([
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  },

  skipMemberForLaunch: async (teamName: string, memberName: string) => {
    try {
      await unwrapIpc('team:skipMemberForLaunch', () =>
        api.teams.skipMemberForLaunch(teamName, memberName)
      );
    } finally {
      await Promise.allSettled([
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
        get().fetchTeams(),
      ]);
    }
  },

  removeMember: async (teamName: string, memberName: string) => {
    await unwrapIpc('team:removeMember', () => api.teams.removeMember(teamName, memberName));
    await get().refreshTeamData(teamName);
  },

  restoreMember: async (teamName: string, memberName: string) => {
    await unwrapIpc('team:restoreMember', () => api.teams.restoreMember(teamName, memberName));
    await get().refreshTeamData(teamName);
    await Promise.allSettled([
      get().fetchMemberSpawnStatuses(teamName),
      get().fetchTeamAgentRuntime(teamName),
    ]);
  },

  updateMemberRole: async (teamName: string, memberName: string, role: string | undefined) => {
    await unwrapIpc('team:updateMemberRole', () =>
      api.teams.updateMemberRole(teamName, memberName, role)
    );
    await get().refreshTeamData(teamName);
  },

  updateToolApprovalSettings: async (patch, forTeam) => {
    const teamName = forTeam ?? get().selectedTeamName;
    const current = get().toolApprovalSettings;
    const merged = { ...current, ...patch };
    set({ toolApprovalSettings: merged });
    // Save per-team if a team is selected, otherwise global fallback
    if (teamName) {
      saveTeamToolApprovalSettings(teamName, merged);
    } else {
      localStorage.setItem('team:toolApprovalSettings', JSON.stringify(merged));
    }
    try {
      await api.teams.updateToolApprovalSettings(teamName ?? '__global__', merged);
    } catch (err) {
      logger.warn('Failed to sync tool approval settings to main:', err);
    }
  },

  respondToToolApproval: async (teamName, runId, requestId, allow, message) => {
    try {
      await api.teams.respondToToolApproval(teamName, runId, requestId, allow, message);
      // Remove ONLY after successful IPC, by runId+requestId pair
      set((s) => {
        const next = new Map(s.resolvedApprovals);
        next.set(requestId, allow);
        return {
          pendingApprovals: s.pendingApprovals.filter(
            (a) => !(a.runId === runId && a.requestId === requestId)
          ),
          resolvedApprovals: next,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`respondToToolApproval failed for ${teamName}/${requestId}: ${msg}`);
      // Surface the error so ToolApprovalSheet can show feedback
      throw err;
    }
  },
});
