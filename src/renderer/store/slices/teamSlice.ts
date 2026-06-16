import { api } from '@renderer/api';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import {
  buildOpenCodeRuntimeDeliveryDiagnostics,
  isOpenCodeRuntimeDeliveryHardUxFailure,
} from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import { normalizePath } from '@renderer/utils/pathNormalize';
import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
  canDisplayTaskChangesForOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';
import { DEFAULT_TEAM_GRAPH_LAYOUT_MODE } from '@shared/constants/teamGraphLayoutMode';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { createLogger } from '@shared/utils/logger';
import { buildTeamGraphDefaultLayoutSeed } from '@shared/utils/teamGraphDefaultLayout';

import { areTeamAgentRuntimeSnapshotsEqual } from '../team/teamAgentRuntimeSnapshotEquality';
import { stabilizeTeamAgentRuntimeSnapshot } from '../team/teamAgentRuntimeSnapshotStabilizer';
import {
  clearAllLastResolvedTeamDataRefreshes,
  clearLastResolvedTeamDataRefreshAt,
  hasLastResolvedTeamDataRefreshAt,
  recordLastResolvedTeamDataRefresh,
} from '../team/teamDataRefreshTimestamps';
import {
  getFullTeamDataRequestKey,
  getTeamDataRequestKey,
  getTeamDataRequestLabel,
  getThinTeamDataRequestKey,
  isTeamDataRequestKeyForTeam,
  normalizeTeamGetDataOptions,
} from '../team/teamDataRequestKeys';
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
  areTeamGraphSlotAssignmentsEqual,
  DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS,
  GRAPH_STABLE_SLOT_LAYOUT_VERSION,
  migrateStableSlotAssignmentsForMembers,
  normalizeTeamGraphGridOwnerOrder,
  pruneTeamGraphSlotAssignmentsForVisibleOwners,
  seedStableSlotAssignmentsForMembers,
  type TeamGraphConfigMemberSeedInput,
  type TeamGraphLayoutSessionState,
  type TeamGraphMemberSeedInput,
  type TeamGraphSlotAssignments,
} from '../team/teamGraphLayout';
import {
  areTeamLaunchParamsEqual,
  buildLaunchParamsFromRuntimeRequest,
  type TeamLaunchParams,
} from '../team/teamLaunchParams';
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
  isActiveProvisioningState,
  isTerminalProvisioningState,
  shouldIgnoreProvisioningProgressRegression,
} from '../team/teamProvisioningStateRules';
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

import type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
} from '../team/teamMessagesCache';
import type { AppState } from '../types';
import type { GraphLayoutMode, GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type {
  ActiveToolCall,
  AddMemberRequest,
  AddTaskCommentRequest,
  CreateTaskRequest,
  CrossTeamSendRequest,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  NotificationTarget,
  RetryFailedOpenCodeSecondaryLanesResult,
  SendMessageRequest,
  SendMessageResult,
  TaskChangePresenceState,
  TaskComment,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamGetDataOptions,
  TeamLaunchDiagnosticItem,
  TeamLaunchRequest,
  TeamMemberActivityMeta,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  TeamViewSnapshot,
  ToolApprovalRequest,
  ToolApprovalSettings,
  UpdateKanbanPatch,
} from '@shared/types';
import type { StateCreator } from 'zustand';

export { getLastResolvedTeamDataRefreshAt } from '../team/teamDataRefreshTimestamps';
export {
  selectTeamDataForName,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
  selectTeamTasksForName,
} from '../team/teamDataSelectors';
export {
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
} from '../team/teamGraphLayout';
export type { TeamLaunchParams } from '../team/teamLaunchParams';
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

const logger = createLogger('teamSlice');

const TEAM_GET_DATA_TIMEOUT_MS = 30_000;
const TEAM_FETCH_TIMEOUT_MS = 30_000;
const MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS = 5_000;
const TEAM_REFRESH_BURST_WINDOW_MS = 4_000;
const MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS = 2_000;
const POST_PAINT_TEAM_ENRICHMENT_FALLBACK_MS = 500;
const GLOBAL_TASKS_FOLLOW_UP_REFRESH_DELAY_MS = 1_500;
const inFlightTeamDataRequests = new Map<string, Promise<TeamViewSnapshot>>();
const inFlightRefreshTeamDataCalls = new Map<string, Set<symbol>>();
const pendingFreshTeamDataRefreshes = new Set<string>();
const queuedFullTeamDataRefreshesAfterThin = new Set<string>();
interface PostPaintHandle {
  rafId?: number;
  timerId?: ReturnType<typeof setTimeout>;
  fallbackTimerId?: ReturnType<typeof setTimeout>;
  cancelled: boolean;
  ran: boolean;
}
const postPaintTeamEnrichmentTimers = new Map<string, PostPaintHandle>();
const inFlightTeamMessagesHeadRequests = new Map<string, Promise<RefreshTeamMessagesHeadResult>>();
const inFlightTeamMessagesOlderRequests = new Map<string, Promise<void>>();
const queuedTeamMessagesHeadRefreshesAfterOlder = new Map<
  string,
  Promise<RefreshTeamMessagesHeadResult>
>();
const pendingFreshTeamMessagesHeadRefreshes = new Set<string>();
const inFlightTeamMemberActivityMetaRequests = new Map<string, Promise<void>>();
const pendingFreshTeamMemberActivityMetaRefreshes = new Set<string>();
const pendingTeamPendingReplyRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
let latestTeamsFetchRequestId = 0;
let inFlightGlobalTasksRefresh: Promise<void> | null = null;
let inFlightGlobalTasksRefreshScope: ContextRequestScope | null = null;
let pendingFreshGlobalTasksRefresh = false;

type GlobalTaskNotificationParams = Parameters<typeof processGlobalTaskNotifications>[0];

interface RefreshTeamDataOptions {
  withDedup?: boolean;
}

function hasFullTeamDataRequestForTeam(teamName: string): boolean {
  return inFlightTeamDataRequests.has(getFullTeamDataRequestKey(teamName));
}

function hasThinTeamDataRequestForTeam(teamName: string): boolean {
  return inFlightTeamDataRequests.has(getThinTeamDataRequestKey(teamName));
}

function clearTeamDataRequestsForTeam(teamName: string): void {
  for (const key of inFlightTeamDataRequests.keys()) {
    if (isTeamDataRequestKeyForTeam(key, teamName)) {
      inFlightTeamDataRequests.delete(key);
    }
  }
}

export function isTeamDataRefreshPending(teamName: string): boolean {
  return (
    hasFullTeamDataRequestForTeam(teamName) ||
    (inFlightRefreshTeamDataCalls.get(teamName)?.size ?? 0) > 0 ||
    pendingFreshTeamDataRefreshes.has(teamName) ||
    queuedFullTeamDataRefreshesAfterThin.has(teamName)
  );
}

export function __resetTeamSliceModuleStateForTests(): void {
  inFlightTeamDataRequests.clear();
  inFlightRefreshTeamDataCalls.clear();
  pendingFreshTeamDataRefreshes.clear();
  queuedFullTeamDataRefreshesAfterThin.clear();
  for (const teamName of postPaintTeamEnrichmentTimers.keys()) {
    cancelPostPaintTeamEnrichments(teamName);
  }
  postPaintTeamEnrichmentTimers.clear();
  inFlightTeamMessagesHeadRequests.clear();
  inFlightTeamMessagesOlderRequests.clear();
  queuedTeamMessagesHeadRefreshesAfterOlder.clear();
  pendingFreshTeamMessagesHeadRefreshes.clear();
  inFlightTeamMemberActivityMetaRequests.clear();
  pendingFreshTeamMemberActivityMetaRefreshes.clear();
  for (const timer of pendingTeamPendingReplyRefreshTimers.values()) {
    clearTimeout(timer);
  }
  pendingTeamPendingReplyRefreshTimers.clear();
  latestTeamsFetchRequestId = 0;
  inFlightGlobalTasksRefresh = null;
  pendingFreshGlobalTasksRefresh = false;
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
  clearTeamDataRequestsForTeam(teamName);
  inFlightRefreshTeamDataCalls.delete(teamName);
  pendingFreshTeamDataRefreshes.delete(teamName);
  queuedFullTeamDataRefreshesAfterThin.delete(teamName);
  cancelPostPaintTeamEnrichments(teamName);
  inFlightTeamMessagesHeadRequests.delete(teamName);
  inFlightTeamMessagesOlderRequests.delete(teamName);
  queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
  pendingFreshTeamMessagesHeadRefreshes.delete(teamName);
  inFlightTeamMemberActivityMetaRequests.delete(teamName);
  pendingFreshTeamMemberActivityMetaRefreshes.delete(teamName);
  clearLastResolvedTeamDataRefreshAt(teamName);
  clearMemberSpawnStatusesIpcBackoff(teamName);
  clearTeamRefreshBurstDiagnostics(teamName);
  clearMemberSpawnUiEqualLastWarn(teamName);
  clearTeamScopedSelectorCaches(teamName);
}

function beginInFlightTeamDataRefresh(teamName: string): symbol {
  const token = Symbol(teamName);
  const existing = inFlightRefreshTeamDataCalls.get(teamName);
  if (existing) {
    existing.add(token);
    return token;
  }
  inFlightRefreshTeamDataCalls.set(teamName, new Set([token]));
  return token;
}

function endInFlightTeamDataRefresh(teamName: string, token: symbol): void {
  const existing = inFlightRefreshTeamDataCalls.get(teamName);
  if (!existing) {
    return;
  }
  existing.delete(token);
  if (existing.size === 0) {
    inFlightRefreshTeamDataCalls.delete(teamName);
  }
}

function cancelPostPaintTeamEnrichments(teamName: string): void {
  const handle = postPaintTeamEnrichmentTimers.get(teamName);
  if (!handle) {
    return;
  }

  handle.cancelled = true;
  if (
    handle.rafId !== undefined &&
    typeof window !== 'undefined' &&
    typeof window.cancelAnimationFrame === 'function'
  ) {
    window.cancelAnimationFrame(handle.rafId);
  }
  if (handle.timerId !== undefined) {
    clearTimeout(handle.timerId);
  }
  if (handle.fallbackTimerId !== undefined) {
    clearTimeout(handle.fallbackTimerId);
  }
  postPaintTeamEnrichmentTimers.delete(teamName);
}

function scheduleAfterPaint(run: () => void): PostPaintHandle {
  const handle: PostPaintHandle = {
    cancelled: false,
    ran: false,
  };

  const runOnce = (): void => {
    if (handle.cancelled || handle.ran) {
      return;
    }
    handle.ran = true;

    if (
      handle.rafId !== undefined &&
      typeof window !== 'undefined' &&
      typeof window.cancelAnimationFrame === 'function'
    ) {
      window.cancelAnimationFrame(handle.rafId);
      handle.rafId = undefined;
    }
    if (handle.timerId !== undefined) {
      clearTimeout(handle.timerId);
      handle.timerId = undefined;
    }
    if (handle.fallbackTimerId !== undefined) {
      clearTimeout(handle.fallbackTimerId);
      handle.fallbackTimerId = undefined;
    }

    run();
  };

  const scheduleTimer = (): void => {
    handle.timerId = setTimeout(runOnce, 0);
  };

  handle.fallbackTimerId = setTimeout(runOnce, POST_PAINT_TEAM_ENRICHMENT_FALLBACK_MS);

  if (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function') {
    handle.rafId = window.requestAnimationFrame(() => {
      handle.rafId = undefined;
      scheduleTimer();
    });
    return handle;
  }

  scheduleTimer();
  return handle;
}

function drainQueuedFullRefreshAfterThinSettles(teamName: string, get: () => TeamSlice): void {
  if (!queuedFullTeamDataRefreshesAfterThin.delete(teamName)) {
    return;
  }
  void get().refreshTeamData(teamName, { withDedup: true });
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

function isSelectedTeamLoadStillCurrent(
  get: () => AppState,
  teamName: string,
  requestNonce: number,
  requestScope: TeamRequestScope
): boolean {
  const state = get();
  return (
    isTeamRequestScopeCurrent(get, teamName, requestScope) &&
    state.selectedTeamName === teamName &&
    state.selectedTeamLoadNonce === requestNonce &&
    state.selectedTeamData?.teamName === teamName
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

function schedulePostPaintTeamEnrichments(params: {
  teamName: string;
  requestNonce: number;
  requestScope: TeamRequestScope;
  get: () => AppState;
}): void {
  const { teamName, requestNonce, requestScope, get } = params;

  cancelPostPaintTeamEnrichments(teamName);

  const handle = scheduleAfterPaint(() => {
    if (postPaintTeamEnrichmentTimers.get(teamName) !== handle) {
      return;
    }
    postPaintTeamEnrichmentTimers.delete(teamName);

    void (async () => {
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        queuedFullTeamDataRefreshesAfterThin.delete(teamName);
        return;
      }

      const state = get();
      if (state.selectedTeamName !== teamName) {
        drainQueuedFullRefreshAfterThinSettles(teamName, get);
        return;
      }

      if (state.selectedTeamLoadNonce !== requestNonce) {
        return;
      }

      if (state.selectedTeamData?.teamName !== teamName) {
        queuedFullTeamDataRefreshesAfterThin.delete(teamName);
        return;
      }

      if (queuedFullTeamDataRefreshesAfterThin.delete(teamName)) {
        void get().refreshTeamData(teamName, { withDedup: true });
      }

      try {
        const headResult = await get().refreshTeamMessagesHead(teamName);
        if (!isSelectedTeamLoadStillCurrent(get, teamName, requestNonce, requestScope)) {
          return;
        }
        if (headResult.feedChanged || isMemberActivityMetaStale(get(), teamName)) {
          await get().refreshMemberActivityMeta(teamName);
        }
      } catch (error) {
        logger.debug(
          `post-paint team enrichments skipped team=${teamName} error=${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    })();
  });

  postPaintTeamEnrichmentTimers.set(teamName, handle);
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

  return {
    hasResolvedMembersSelector: resolvedMemberSelectorCacheSnapshot.hasResolvedMembersSelector,
    resolvedMemberSelectorCount: resolvedMemberSelectorCacheSnapshot.resolvedMemberSelectorCount,
    hasMergedMessagesSelector: messageSelectorCache.hasMergedMessagesSelector,
    memberMessagesSelectorCount: messageSelectorCache.memberMessagesSelectorCount,
    hasPendingFreshTeamDataRefresh: pendingFreshTeamDataRefreshes.has(teamName),
    hasQueuedFullTeamDataRefreshAfterThin: queuedFullTeamDataRefreshesAfterThin.has(teamName),
    hasPostPaintTeamEnrichmentTimer: postPaintTeamEnrichmentTimers.has(teamName),
    hasQueuedHeadRefreshAfterOlder: queuedTeamMessagesHeadRefreshesAfterOlder.has(teamName),
    hasPendingFreshMessagesHeadRefresh: pendingFreshTeamMessagesHeadRefreshes.has(teamName),
    hasPendingFreshMemberActivityMetaRefresh:
      pendingFreshTeamMemberActivityMetaRefreshes.has(teamName),
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

function isPendingProvisioningRunId(runId: string): boolean {
  return runId.startsWith('pending:');
}

function isUnknownProvisioningRunError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('Unknown runId');
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

function fetchTeamDataDeduped(
  teamName: string,
  options?: TeamGetDataOptions
): Promise<TeamViewSnapshot> {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  const key = getTeamDataRequestKey(teamName, normalizedOptions);
  const existing = inFlightTeamDataRequests.get(key);
  if (existing) {
    return existing;
  }

  const request = withTimeout(
    unwrapIpc('team:getData', () =>
      normalizedOptions === undefined
        ? api.teams.getData(teamName)
        : api.teams.getData(teamName, normalizedOptions)
    ),
    TEAM_GET_DATA_TIMEOUT_MS,
    getTeamDataRequestLabel(teamName, normalizedOptions)
  ).finally(() => {
    if (inFlightTeamDataRequests.get(key) === request) {
      inFlightTeamDataRequests.delete(key);
    }
  });

  inFlightTeamDataRequests.set(key, request);
  return request;
}

function fetchTeamDataFresh(
  teamName: string,
  options?: TeamGetDataOptions
): Promise<TeamViewSnapshot> {
  const normalizedOptions = normalizeTeamGetDataOptions(options);
  return withTimeout(
    unwrapIpc('team:getData', () =>
      normalizedOptions === undefined
        ? api.teams.getData(teamName)
        : api.teams.getData(teamName, normalizedOptions)
    ),
    TEAM_GET_DATA_TIMEOUT_MS,
    getTeamDataRequestLabel(teamName, normalizedOptions)
  );
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

function clearPendingReplyRefreshTimer(teamName: string): void {
  const existingTimer = pendingTeamPendingReplyRefreshTimers.get(teamName);
  if (existingTimer == null) {
    return;
  }
  clearTimeout(existingTimer);
  pendingTeamPendingReplyRefreshTimers.delete(teamName);
}

async function refreshTaskChangePresenceForUpdatedTask(
  getState: () => AppState,
  teamName: string,
  taskId: string
): Promise<void> {
  const state = getState();
  if (state.selectedTeamName !== teamName || !state.selectedTeamData) {
    return;
  }

  const task = state.selectedTeamData.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return;
  }

  const options = buildTaskChangeRequestOptions(task);
  if (!canDisplayTaskChangesForOptions(options)) {
    return;
  }

  if (
    typeof state.invalidateTaskChangePresence !== 'function' ||
    typeof state.checkTaskHasChanges !== 'function'
  ) {
    return;
  }

  const cacheKey = buildTaskChangePresenceKey(teamName, taskId, options);
  state.invalidateTaskChangePresence([cacheKey]);

  try {
    await state.checkTaskHasChanges(teamName, taskId, options);
  } catch {
    // Best-effort refresh after explicit task transition.
  }
}

async function pollProvisioningStatus(
  getState: () => TeamSlice,
  runId: string,
  opts?: { maxAttempts?: number; initialDelayMs?: number }
): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 12;
  let delayMs = opts?.initialDelayMs ?? 150;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const state = getState();
    const current = state.provisioningRuns[runId];
    if (current && isTerminalProvisioningState(current.state)) {
      return;
    }
    try {
      const progress = await state.getProvisioningStatus(runId);
      if (isTerminalProvisioningState(progress.state)) {
        return;
      }
    } catch (error) {
      if (isUnknownProvisioningRunError(error)) {
        state.clearMissingProvisioningRun(runId);
        return;
      }
      // best-effort polling; don't fail launch because status fetch is flaky
    }
    await sleep(delayMs);
    delayMs = Math.min(1500, Math.round(delayMs * 1.5));
  }
}

function collectTaskChangeInvalidationState(
  teamName: string,
  prevTasks: TeamViewSnapshot['tasks'],
  nextTasks: TeamViewSnapshot['tasks']
): { cacheKeys: string[]; taskIds: string[] } {
  const nextKeys = new Set(
    nextTasks.map((task) =>
      buildTaskChangePresenceKey(teamName, task.id, buildTaskChangeRequestOptions(task))
    )
  );
  const invalidationKeys: string[] = [];
  const invalidationTaskIds = new Set<string>();
  for (const task of prevTasks) {
    const previousKey = buildTaskChangePresenceKey(
      teamName,
      task.id,
      buildTaskChangeRequestOptions(task)
    );
    if (!nextKeys.has(previousKey)) {
      invalidationKeys.push(previousKey);
      invalidationTaskIds.add(task.id);
    }
  }
  return {
    cacheKeys: invalidationKeys,
    taskIds: [...invalidationTaskIds],
  };
}

function preserveKnownTaskChangePresence(
  teamName: string,
  prevTasks: TeamViewSnapshot['tasks'] | null | undefined,
  nextTasks: TeamViewSnapshot['tasks']
): TeamViewSnapshot['tasks'] {
  if (!Array.isArray(prevTasks) || prevTasks.length === 0 || nextTasks.length === 0) {
    return nextTasks;
  }

  const prevTaskById = new Map(prevTasks.map((task) => [task.id, task]));
  let changed = false;

  const mergedTasks = nextTasks.map((task) => {
    if (task.changePresence && task.changePresence !== 'unknown') {
      return task;
    }

    const previousTask = prevTaskById.get(task.id);
    if (!previousTask?.changePresence || previousTask.changePresence === 'unknown') {
      return task;
    }

    const previousKey = buildTaskChangePresenceKey(
      teamName,
      previousTask.id,
      buildTaskChangeRequestOptions(previousTask)
    );
    const nextKey = buildTaskChangePresenceKey(
      teamName,
      task.id,
      buildTaskChangeRequestOptions(task)
    );
    if (previousKey !== nextKey) {
      return task;
    }

    changed = true;
    return {
      ...task,
      changePresence: previousTask.changePresence,
    };
  });

  return changed ? mergedTasks : nextTasks;
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

export interface TeamSlice {
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
  selectedTeamName: string | null;
  selectedTeamData: TeamViewSnapshot | null;
  /** Team-scoped detailed cache used by multi-pane views like agent graph. */
  teamDataCacheByName: Record<string, TeamViewSnapshot>;
  slotLayoutVersion: string;
  graphLayoutModeByTeam: Record<string, GraphLayoutMode>;
  gridOwnerOrderByTeam: Record<string, string[]>;
  slotAssignmentsByTeam: Record<string, TeamGraphSlotAssignments>;
  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;
  graphLayoutSessionByTeam: Record<string, TeamGraphLayoutSessionState>;
  selectedTeamLoading: boolean;
  selectedTeamLoadNonce: number;
  selectedTeamError: string | null;
  sendingMessage: boolean;
  sendMessageError: string | null;
  sendMessageWarning: string | null;
  sendMessageDebugDetails: OpenCodeRuntimeDeliveryDebugDetails | null;
  lastSendMessageResult: SendMessageResult | null;
  clearSendMessageRuntimeDiagnostics: (messageId?: string | null) => void;
  refreshSendMessageRuntimeDeliveryStatus: (
    teamName: string,
    input: string | { messageId: string; statusMessageId?: string | null }
  ) => Promise<void>;
  reviewActionError: string | null;
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
  fetchMemberSpawnStatuses: (teamName: string) => Promise<void>;
  fetchTeamAgentRuntime: (teamName: string) => Promise<void>;
  provisioningErrorByTeam: Record<string, string | null>;
  clearProvisioningError: (teamName?: string) => void;
  /** Per-team launch parameters (model, effort, extended context) — persisted in localStorage. */
  launchParamsByTeam: Record<string, TeamLaunchParams>;
  kanbanFilterQuery: string | null;
  provisioningProgressUnsubscribe: (() => void) | null;
  fetchBranches: (paths: string[]) => Promise<void>;
  fetchTeams: () => Promise<void>;
  fetchAllTasks: () => Promise<void>;
  openTeamsTab: () => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
  ensureTeamGraphSlotAssignments: (
    teamName: string,
    members: readonly TeamGraphMemberSeedInput[],
    configMembers?: readonly TeamGraphConfigMemberSeedInput[]
  ) => void;
  setTeamGraphOwnerSlotAssignment: (
    teamName: string,
    stableOwnerId: string,
    assignment: GraphOwnerSlotAssignment
  ) => void;
  commitTeamGraphOwnerSlotDrop: (
    teamName: string,
    stableOwnerId: string,
    assignment: GraphOwnerSlotAssignment,
    displacedStableOwnerId?: string,
    displacedAssignment?: GraphOwnerSlotAssignment
  ) => void;
  setTeamGraphLayoutMode: (teamName: string, mode: GraphLayoutMode) => void;
  swapTeamGraphGridOwners: (
    teamName: string,
    stableOwnerId: string,
    targetStableOwnerId: string
  ) => void;
  swapTeamGraphOwnerSlots: (
    teamName: string,
    stableOwnerId: string,
    otherStableOwnerId: string
  ) => void;
  clearTeamGraphSlotAssignments: (teamName?: string) => void;
  resetTeamGraphSlotAssignmentsToDefaults: (teamName: string) => void;
  setSelectedTeamTaskChangePresence: (
    teamName: string,
    taskId: string,
    presence: TaskChangePresenceState
  ) => void;
  setSelectedTeamTaskChangePresences: (
    teamName: string,
    presencesByTaskId: Record<string, TaskChangePresenceState>
  ) => void;
  refreshTeamChangePresence: (teamName: string) => Promise<void>;
  selectTeam: (
    teamName: string,
    opts?: { skipProjectAutoSelect?: boolean; allowReloadWhileProvisioning?: boolean }
  ) => Promise<void>;
  refreshTeamData: (teamName: string, opts?: RefreshTeamDataOptions) => Promise<void>;
  refreshTeamMessagesHead: (teamName: string) => Promise<RefreshTeamMessagesHeadResult>;
  loadOlderTeamMessages: (teamName: string) => Promise<void>;
  refreshMemberActivityMeta: (teamName: string) => Promise<void>;
  syncTeamPendingReplyRefresh: (
    teamName: string,
    sourceId: string,
    enabled: boolean,
    delayMs?: number
  ) => void;
  sendTeamMessage: (teamName: string, request: SendMessageRequest) => Promise<SendMessageResult>;
  crossTeamTargets: {
    teamName: string;
    displayName: string;
    description?: string;
    color?: string;
    leadName?: string;
    leadColor?: string;
    isOnline?: boolean;
  }[];
  crossTeamTargetsLoading: boolean;
  fetchCrossTeamTargets: () => Promise<boolean>;
  sendCrossTeamMessage: (request: CrossTeamSendRequest) => Promise<void>;
  requestReview: (teamName: string, taskId: string) => Promise<void>;
  updateKanban: (teamName: string, taskId: string, patch: UpdateKanbanPatch) => Promise<void>;
  updateKanbanColumnOrder: (
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ) => Promise<void>;
  createTeamTask: (teamName: string, request: CreateTaskRequest) => Promise<TeamTask>;
  startTask: (teamName: string, taskId: string) => Promise<{ notifiedOwner: boolean }>;
  startTaskByUser: (teamName: string, taskId: string) => Promise<{ notifiedOwner: boolean }>;
  updateTaskStatus: (teamName: string, taskId: string, status: TeamTaskStatus) => Promise<void>;
  updateTaskOwner: (teamName: string, taskId: string, owner: string | null) => Promise<void>;
  updateTaskFields: (
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ) => Promise<void>;
  addingComment: boolean;
  addCommentError: string | null;
  addTaskComment: (
    teamName: string,
    taskId: string,
    request: AddTaskCommentRequest
  ) => Promise<TaskComment>;
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
  addTaskRelationship: (
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ) => Promise<void>;
  removeTaskRelationship: (
    teamName: string,
    taskId: string,
    targetId: string,
    type: 'blockedBy' | 'blocks' | 'related'
  ) => Promise<void>;
  setTaskNeedsClarification: (
    teamName: string,
    taskId: string,
    value: 'lead' | 'user' | null
  ) => Promise<void>;
  saveTaskAttachment: (
    teamName: string,
    taskId: string,
    file: { name: string; type: string; base64: string }
  ) => Promise<void>;
  deleteTaskAttachment: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<void>;
  getTaskAttachmentData: (
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: string
  ) => Promise<string | null>;
  deletedTasks: TeamTask[];
  deletedTasksLoading: boolean;
  softDeleteTask: (teamName: string, taskId: string) => Promise<void>;
  restoreTask: (teamName: string, taskId: string) => Promise<void>;
  fetchDeletedTasks: (teamName: string) => Promise<void>;
  deleteTeam: (teamName: string) => Promise<void>;
  restoreTeam: (teamName: string) => Promise<void>;
  permanentlyDeleteTeam: (teamName: string) => Promise<void>;
  createTeam: (request: TeamCreateRequest) => Promise<string>;
  launchTeam: (request: TeamLaunchRequest) => Promise<string>;
  cancelProvisioning: (runId: string) => Promise<void>;
  getProvisioningStatus: (runId: string) => Promise<TeamProvisioningProgress>;
  clearMissingProvisioningRun: (runId: string) => void;
  onProvisioningProgress: (progress: TeamProvisioningProgress) => void;
  subscribeProvisioningProgress: () => void;
  unsubscribeProvisioningProgress: () => void;
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

// --- Per-team launch params persistence ---
const LAUNCH_PARAMS_PREFIX = 'team:launchParams:';

export function getCurrentProvisioningProgressForTeam(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): TeamProvisioningProgress | null {
  const currentRunId = state.currentProvisioningRunIdByTeam[teamName];
  return currentRunId ? (state.provisioningRuns[currentRunId] ?? null) : null;
}

function stringArraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function launchDiagnosticsEqual(
  a: readonly TeamLaunchDiagnosticItem[] | undefined,
  b: readonly TeamLaunchDiagnosticItem[] | undefined
): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const left = a[i];
    const right = b[i];
    if (
      !left ||
      !right ||
      left.id !== right.id ||
      left.memberName !== right.memberName ||
      left.severity !== right.severity ||
      left.code !== right.code ||
      left.label !== right.label ||
      left.detail !== right.detail ||
      left.observedAt !== right.observedAt
    ) {
      return false;
    }
  }
  return true;
}

function provisioningProgressPayloadEqual(
  a: TeamProvisioningProgress,
  b: TeamProvisioningProgress
): boolean {
  return (
    a.runId === b.runId &&
    a.teamName === b.teamName &&
    a.state === b.state &&
    a.message === b.message &&
    a.messageSeverity === b.messageSeverity &&
    a.startedAt === b.startedAt &&
    a.pid === b.pid &&
    a.error === b.error &&
    a.cliLogsTail === b.cliLogsTail &&
    a.assistantOutput === b.assistantOutput &&
    a.configReady === b.configReady &&
    stringArraysEqual(a.warnings, b.warnings) &&
    launchDiagnosticsEqual(a.launchDiagnostics, b.launchDiagnostics)
  );
}

export function isTeamProvisioningActive(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const current = getCurrentProvisioningProgressForTeam(state, teamName);
  return current != null && isActiveProvisioningState(current.state);
}

function loadAllLaunchParams(): Record<string, TeamLaunchParams> {
  const result: Record<string, TeamLaunchParams> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LAUNCH_PARAMS_PREFIX)) {
        const teamName = key.slice(LAUNCH_PARAMS_PREFIX.length);
        const parsed = JSON.parse(localStorage.getItem(key)!) as TeamLaunchParams;
        if (parsed && typeof parsed === 'object') {
          result[teamName] = parsed;
        }
      }
    }
  } catch {
    // ignore — best-effort restore
  }
  return result;
}

function saveLaunchParams(teamName: string, params: TeamLaunchParams): void {
  try {
    localStorage.setItem(LAUNCH_PARAMS_PREFIX + teamName, JSON.stringify(params));
  } catch {
    // ignore — best-effort persist
  }
}

const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

function loadToolApprovalSettingsForTeam(teamName: string): ToolApprovalSettings {
  return parseToolApprovalSettings(localStorage.getItem(TOOL_APPROVAL_PREFIX + teamName));
}

function saveToolApprovalSettingsForTeam(teamName: string, settings: ToolApprovalSettings): void {
  try {
    localStorage.setItem(TOOL_APPROVAL_PREFIX + teamName, JSON.stringify(settings));
  } catch {
    // best-effort
  }
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
  selectedTeamName: null,
  selectedTeamData: null,
  teamDataCacheByName: {},
  slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
  graphLayoutModeByTeam: {},
  gridOwnerOrderByTeam: {},
  slotAssignmentsByTeam: {},
  teamMessagesByName: {},
  memberActivityMetaByTeam: {},
  graphLayoutSessionByTeam: {},
  selectedTeamLoading: false,
  selectedTeamLoadNonce: 0,
  selectedTeamError: null,
  sendingMessage: false,
  sendMessageError: null,
  sendMessageWarning: null,
  sendMessageDebugDetails: null,
  lastSendMessageResult: null,
  crossTeamTargets: [],
  crossTeamTargetsLoading: false,
  reviewActionError: null,
  provisioningRuns: {},
  provisioningSnapshotByTeam: {},
  currentProvisioningRunIdByTeam: {},
  currentRuntimeRunIdByTeam: {},
  ignoredProvisioningRunIds: {},
  ignoredRuntimeRunIds: {},
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
  launchParamsByTeam: loadAllLaunchParams(),
  fetchMemberSpawnStatuses: async (teamName: string) => {
    if (!api.teams?.getMemberSpawnStatuses) return;
    if (isMemberSpawnStatusesIpcBackoffActive(teamName)) {
      return;
    }
    const requestScope = captureTeamRequestScope(get, teamName);
    try {
      const snapshot = await api.teams.getMemberSpawnStatuses(teamName);
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }
      clearMemberSpawnStatusesIpcBackoff(teamName);
      set((prev) => {
        if (snapshot.runId != null && prev.ignoredRuntimeRunIds[snapshot.runId] === teamName) {
          return {};
        }

        if (
          prev.currentRuntimeRunIdByTeam[teamName] == null &&
          prev.leadActivityByTeam[teamName] === 'offline' &&
          snapshot.runId != null
        ) {
          return {};
        }

        if (
          snapshot.runId != null &&
          prev.currentRuntimeRunIdByTeam[teamName] != null &&
          prev.currentRuntimeRunIdByTeam[teamName] !== snapshot.runId
        ) {
          return {};
        }

        const nextCurrentRuntimeRunIdByTeam =
          snapshot.runId == null || prev.currentRuntimeRunIdByTeam[teamName] != null
            ? prev.currentRuntimeRunIdByTeam
            : {
                ...prev.currentRuntimeRunIdByTeam,
                [teamName]: snapshot.runId,
              };
        // Keep same-team ignored runtime tombstones intact here.
        // Member-spawn snapshots do not carry a run start time, so clearing older
        // ignored ids can reopen stale zombie snapshots during create/launch churn.
        const previousSnapshot = prev.memberSpawnSnapshotsByTeam[teamName];
        const snapshotChanged = !areMemberSpawnSnapshotsSemanticallyEqual(
          previousSnapshot,
          snapshot
        );

        if (!snapshotChanged) {
          maybeLogMemberSpawnUiEqualSuppressed(teamName, snapshot.runId);
          if (nextCurrentRuntimeRunIdByTeam === prev.currentRuntimeRunIdByTeam) {
            return {};
          }

          return {
            currentRuntimeRunIdByTeam: nextCurrentRuntimeRunIdByTeam,
          };
        }

        return {
          currentRuntimeRunIdByTeam: nextCurrentRuntimeRunIdByTeam,
          memberSpawnStatusesByTeam: {
            ...prev.memberSpawnStatusesByTeam,
            [teamName]: snapshot.statuses,
          },
          memberSpawnSnapshotsByTeam: {
            ...prev.memberSpawnSnapshotsByTeam,
            [teamName]: snapshot,
          },
        };
      });
    } catch (error) {
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No handler registered for 'team:memberSpawnStatuses'")) {
        recordMemberSpawnStatusesIpcRetryBackoff(
          teamName,
          MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS
        );
      }
      // ignore — spawn statuses are best-effort
    }
  },
  fetchTeamAgentRuntime: async (teamName: string) => {
    if (!api.teams?.getTeamAgentRuntime) return;
    const requestScope = captureTeamRequestScope(get, teamName);
    try {
      const snapshot = await api.teams.getTeamAgentRuntime(teamName);
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }
      set((prev) => {
        if (snapshot.runId != null && prev.ignoredRuntimeRunIds[snapshot.runId] === teamName) {
          return {};
        }
        if (
          snapshot.runId != null &&
          prev.currentRuntimeRunIdByTeam[teamName] != null &&
          prev.currentRuntimeRunIdByTeam[teamName] !== snapshot.runId
        ) {
          return {};
        }
        const previousSnapshot = prev.teamAgentRuntimeByTeam[teamName];
        const stabilizedSnapshot = stabilizeTeamAgentRuntimeSnapshot(previousSnapshot, snapshot);
        if (areTeamAgentRuntimeSnapshotsEqual(previousSnapshot, stabilizedSnapshot)) {
          return {};
        }
        return {
          teamAgentRuntimeByTeam: {
            ...prev.teamAgentRuntimeByTeam,
            [teamName]: stabilizedSnapshot,
          },
        };
      });
    } catch {
      // ignore — runtime snapshots are best-effort
    }
  },
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
  addingComment: false,
  addCommentError: null,
  provisioningProgressUnsubscribe: null,
  deletedTasks: [],
  deletedTasksLoading: false,
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

  openTeamsTab: () => {
    const state = get();
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

  ensureTeamGraphSlotAssignments: (teamName, members, configMembers = []) => {
    set((state) => {
      const nextState: Partial<TeamSlice> = {};
      let changed = false;

      let nextSlotAssignmentsByTeam = state.slotAssignmentsByTeam;
      let nextGraphLayoutSessionByTeam = state.graphLayoutSessionByTeam;
      if (state.slotLayoutVersion !== GRAPH_STABLE_SLOT_LAYOUT_VERSION) {
        nextState.slotLayoutVersion = GRAPH_STABLE_SLOT_LAYOUT_VERSION;
        nextSlotAssignmentsByTeam = {};
        nextGraphLayoutSessionByTeam = {};
        changed = true;
      }

      const defaultSeed = buildTeamGraphDefaultLayoutSeed(members, configMembers);
      const visibleAssignments = pruneTeamGraphSlotAssignmentsForVisibleOwners(
        nextSlotAssignmentsByTeam[teamName],
        defaultSeed.orderedVisibleOwnerIds
      );
      const currentSession = nextGraphLayoutSessionByTeam[teamName];

      if (DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS) {
        if (currentSession?.mode === 'manual') {
          if (
            !areTeamGraphSlotAssignmentsEqual(
              nextSlotAssignmentsByTeam[teamName],
              visibleAssignments
            )
          ) {
            nextSlotAssignmentsByTeam = { ...nextSlotAssignmentsByTeam };
            if (visibleAssignments) {
              nextSlotAssignmentsByTeam[teamName] = visibleAssignments;
            } else {
              delete nextSlotAssignmentsByTeam[teamName];
            }
            changed = true;
          }
        } else {
          if (
            !areTeamGraphSlotAssignmentsEqual(
              nextSlotAssignmentsByTeam[teamName],
              visibleAssignments
            ) ||
            !areTeamGraphSlotAssignmentsEqual(visibleAssignments, defaultSeed.assignments)
          ) {
            nextSlotAssignmentsByTeam = { ...nextSlotAssignmentsByTeam };
            if (Object.keys(defaultSeed.assignments).length === 0) {
              delete nextSlotAssignmentsByTeam[teamName];
            } else {
              nextSlotAssignmentsByTeam[teamName] = defaultSeed.assignments;
            }
            changed = true;
          }
          if (
            currentSession?.mode !== 'default' ||
            currentSession?.signature !== defaultSeed.signature
          ) {
            nextGraphLayoutSessionByTeam = {
              ...nextGraphLayoutSessionByTeam,
              [teamName]: {
                mode: 'default',
                signature: defaultSeed.signature,
              },
            };
            changed = true;
          }
        }

        if (!changed) {
          return {};
        }

        nextState.slotAssignmentsByTeam = nextSlotAssignmentsByTeam;
        nextState.graphLayoutSessionByTeam = nextGraphLayoutSessionByTeam;
        return nextState;
      }

      const currentAssignments = nextSlotAssignmentsByTeam[teamName];
      const migrated = migrateStableSlotAssignmentsForMembers(currentAssignments, members);
      const seeded = seedStableSlotAssignmentsForMembers(
        migrated.assignments,
        members,
        configMembers
      );
      if (migrated.changed || seeded.changed) {
        nextSlotAssignmentsByTeam = {
          ...nextSlotAssignmentsByTeam,
          [teamName]: seeded.assignments,
        };
        changed = true;
      }

      if (!changed) {
        return {};
      }

      nextState.slotAssignmentsByTeam = nextSlotAssignmentsByTeam;
      if (nextGraphLayoutSessionByTeam !== state.graphLayoutSessionByTeam) {
        nextState.graphLayoutSessionByTeam = nextGraphLayoutSessionByTeam;
      }
      return nextState;
    });
  },

  setTeamGraphOwnerSlotAssignment: (teamName, stableOwnerId, assignment) => {
    set((state) => {
      const currentAssignments = state.slotAssignmentsByTeam[teamName] ?? {};
      const existing = currentAssignments[stableOwnerId];
      const occupiedByOther = Object.entries(currentAssignments).find(
        ([otherStableOwnerId, otherAssignment]) =>
          otherStableOwnerId !== stableOwnerId &&
          otherAssignment.ringIndex === assignment.ringIndex &&
          otherAssignment.sectorIndex === assignment.sectorIndex
      );
      if (
        existing?.ringIndex === assignment.ringIndex &&
        existing?.sectorIndex === assignment.sectorIndex &&
        state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION
      ) {
        return {};
      }
      if (occupiedByOther) {
        logger.warn(
          `[graph-layout] refusing occupied slot assignment team=${teamName} owner=${stableOwnerId} target=${assignment.ringIndex}:${assignment.sectorIndex} occupiedBy=${occupiedByOther[0]}`
        );
        return {};
      }

      return {
        slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
        slotAssignmentsByTeam: {
          ...state.slotAssignmentsByTeam,
          [teamName]: {
            ...currentAssignments,
            [stableOwnerId]: assignment,
          },
        },
        graphLayoutSessionByTeam: {
          ...state.graphLayoutSessionByTeam,
          [teamName]: {
            mode: 'manual',
            signature: state.graphLayoutSessionByTeam[teamName]?.signature ?? null,
          },
        },
      };
    });
  },

  commitTeamGraphOwnerSlotDrop: (
    teamName,
    stableOwnerId,
    assignment,
    displacedStableOwnerId,
    displacedAssignment
  ) => {
    set((state) => {
      const currentAssignments = state.slotAssignmentsByTeam[teamName] ?? {};
      const existing = currentAssignments[stableOwnerId];
      const nextAssignments: TeamGraphSlotAssignments = {
        ...currentAssignments,
        [stableOwnerId]: assignment,
      };

      if (
        existing?.ringIndex === assignment.ringIndex &&
        existing?.sectorIndex === assignment.sectorIndex &&
        !displacedStableOwnerId &&
        state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION
      ) {
        return {};
      }

      if (displacedStableOwnerId && displacedAssignment) {
        nextAssignments[displacedStableOwnerId] = displacedAssignment;
      }

      const occupiedByConflict = Object.entries(nextAssignments).find(
        ([ownerId, nextAssignment]) => {
          if (ownerId === stableOwnerId || ownerId === displacedStableOwnerId) {
            return false;
          }
          return (
            (nextAssignment.ringIndex === assignment.ringIndex &&
              nextAssignment.sectorIndex === assignment.sectorIndex) ||
            (nextAssignment.ringIndex === displacedAssignment?.ringIndex &&
              nextAssignment.sectorIndex === displacedAssignment.sectorIndex)
          );
        }
      );

      if (occupiedByConflict) {
        logger.warn(
          `[graph-layout] refusing slot drop team=${teamName} owner=${stableOwnerId} target=${assignment.ringIndex}:${assignment.sectorIndex} conflict=${occupiedByConflict[0]}`
        );
        return {};
      }

      return {
        slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
        slotAssignmentsByTeam: {
          ...state.slotAssignmentsByTeam,
          [teamName]: nextAssignments,
        },
        graphLayoutSessionByTeam: {
          ...state.graphLayoutSessionByTeam,
          [teamName]: {
            mode: 'manual',
            signature: state.graphLayoutSessionByTeam[teamName]?.signature ?? null,
          },
        },
      };
    });
  },

  setTeamGraphLayoutMode: (teamName, mode) => {
    set((state) => {
      if ((state.graphLayoutModeByTeam[teamName] ?? DEFAULT_TEAM_GRAPH_LAYOUT_MODE) === mode) {
        return {};
      }

      return {
        graphLayoutModeByTeam: {
          ...state.graphLayoutModeByTeam,
          [teamName]: mode,
        },
      };
    });
  },

  swapTeamGraphGridOwners: (teamName, stableOwnerId, targetStableOwnerId) => {
    if (stableOwnerId === targetStableOwnerId) {
      return;
    }

    set((state) => {
      const teamData = selectTeamDataForName(state, teamName);
      const fallbackVisibleOwnerIds = [...(state.gridOwnerOrderByTeam[teamName] ?? [])];
      for (const ownerId of [stableOwnerId, targetStableOwnerId]) {
        if (!fallbackVisibleOwnerIds.includes(ownerId)) {
          fallbackVisibleOwnerIds.push(ownerId);
        }
      }
      const visibleOwnerIds = teamData
        ? buildTeamGraphDefaultLayoutSeed(teamData.members, teamData.config.members ?? [])
            .orderedVisibleOwnerIds
        : fallbackVisibleOwnerIds;
      const normalizedOrder = normalizeTeamGraphGridOwnerOrder(
        state.gridOwnerOrderByTeam[teamName],
        visibleOwnerIds
      );
      const stableOwnerIndex = normalizedOrder.indexOf(stableOwnerId);
      const targetOwnerIndex = normalizedOrder.indexOf(targetStableOwnerId);

      if (stableOwnerIndex < 0 || targetOwnerIndex < 0) {
        return {};
      }

      const nextOrder = [...normalizedOrder];
      nextOrder[stableOwnerIndex] = targetStableOwnerId;
      nextOrder[targetOwnerIndex] = stableOwnerId;

      return {
        gridOwnerOrderByTeam: {
          ...state.gridOwnerOrderByTeam,
          [teamName]: nextOrder,
        },
      };
    });
  },

  swapTeamGraphOwnerSlots: (teamName, stableOwnerId, otherStableOwnerId) => {
    if (stableOwnerId === otherStableOwnerId) {
      return;
    }

    set((state) => {
      const currentAssignments = state.slotAssignmentsByTeam[teamName] ?? {};
      const left = currentAssignments[stableOwnerId];
      const right = currentAssignments[otherStableOwnerId];
      if (!left || !right) {
        return {};
      }

      return {
        slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
        slotAssignmentsByTeam: {
          ...state.slotAssignmentsByTeam,
          [teamName]: {
            ...currentAssignments,
            [stableOwnerId]: right,
            [otherStableOwnerId]: left,
          },
        },
        graphLayoutSessionByTeam: {
          ...state.graphLayoutSessionByTeam,
          [teamName]: {
            mode: 'manual',
            signature: state.graphLayoutSessionByTeam[teamName]?.signature ?? null,
          },
        },
      };
    });
  },

  clearTeamGraphSlotAssignments: (teamName) => {
    set((state) => {
      if (!teamName) {
        if (
          Object.keys(state.slotAssignmentsByTeam).length === 0 &&
          state.slotLayoutVersion === GRAPH_STABLE_SLOT_LAYOUT_VERSION &&
          Object.keys(state.graphLayoutSessionByTeam).length === 0
        ) {
          return {};
        }
        return {
          slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
          slotAssignmentsByTeam: {},
          graphLayoutSessionByTeam: {},
        };
      }

      if (
        !(teamName in state.slotAssignmentsByTeam) &&
        !(teamName in state.graphLayoutSessionByTeam)
      ) {
        return {};
      }

      const nextAssignmentsByTeam = { ...state.slotAssignmentsByTeam };
      const nextGraphLayoutSessionByTeam = { ...state.graphLayoutSessionByTeam };
      delete nextAssignmentsByTeam[teamName];
      delete nextGraphLayoutSessionByTeam[teamName];
      return {
        slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
        slotAssignmentsByTeam: nextAssignmentsByTeam,
        graphLayoutSessionByTeam: nextGraphLayoutSessionByTeam,
      };
    });
  },

  resetTeamGraphSlotAssignmentsToDefaults: (teamName) => {
    set((state) => {
      if (!DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS) {
        const currentAssignments = state.slotAssignmentsByTeam[teamName];
        if (!currentAssignments || Object.keys(currentAssignments).length === 0) {
          return {};
        }

        const nextAssignmentsByTeam = { ...state.slotAssignmentsByTeam };
        delete nextAssignmentsByTeam[teamName];
        return {
          slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
          slotAssignmentsByTeam: nextAssignmentsByTeam,
        };
      }

      const teamData = selectTeamDataForName(state, teamName);
      const defaultSeed = teamData
        ? buildTeamGraphDefaultLayoutSeed(teamData.members, teamData.config.members ?? [])
        : { orderedVisibleOwnerIds: [], signature: null, assignments: {} };
      const currentAssignments = state.slotAssignmentsByTeam[teamName];
      const currentSession = state.graphLayoutSessionByTeam[teamName];

      if (
        areTeamGraphSlotAssignmentsEqual(currentAssignments, defaultSeed.assignments) &&
        currentSession?.mode === 'default' &&
        currentSession.signature === defaultSeed.signature
      ) {
        return {};
      }

      const nextAssignmentsByTeam = { ...state.slotAssignmentsByTeam };
      if (Object.keys(defaultSeed.assignments).length === 0) {
        delete nextAssignmentsByTeam[teamName];
      } else {
        nextAssignmentsByTeam[teamName] = defaultSeed.assignments;
      }

      return {
        slotLayoutVersion: GRAPH_STABLE_SLOT_LAYOUT_VERSION,
        slotAssignmentsByTeam: nextAssignmentsByTeam,
        graphLayoutSessionByTeam: {
          ...state.graphLayoutSessionByTeam,
          [teamName]: {
            mode: 'default',
            signature: defaultSeed.signature,
          },
        },
      };
    });
  },

  setSelectedTeamTaskChangePresence: (teamName, taskId, presence) => {
    get().setSelectedTeamTaskChangePresences(teamName, { [taskId]: presence });
  },

  setSelectedTeamTaskChangePresences: (teamName, presencesByTaskId) => {
    set((state) => {
      const updates = Object.entries(presencesByTaskId);
      if (updates.length === 0) {
        return {};
      }
      const presenceByTaskId = new Map(updates);
      const currentTeamData = selectTeamDataForName(state, teamName);
      let cacheChanged = false;
      const nextTeamData = currentTeamData
        ? {
            ...currentTeamData,
            tasks: currentTeamData.tasks.map((task) => {
              const presence = presenceByTaskId.get(task.id);
              if (!presence || task.changePresence === presence) {
                return task;
              }
              cacheChanged = true;
              return { ...task, changePresence: presence };
            }),
          }
        : null;

      let globalChanged = false;
      const nextGlobalTasks = state.globalTasks.map((task) => {
        if (task.teamName !== teamName) {
          return task;
        }
        const presence = presenceByTaskId.get(task.id);
        if (!presence || task.changePresence === presence) {
          return task;
        }
        globalChanged = true;
        return { ...task, changePresence: presence };
      });

      if (!cacheChanged && !globalChanged) {
        return {};
      }

      return {
        ...(cacheChanged && nextTeamData
          ? {
              teamDataCacheByName: {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              },
            }
          : {}),
        ...(cacheChanged && state.selectedTeamName === teamName && nextTeamData
          ? { selectedTeamData: nextTeamData }
          : {}),
        ...(globalChanged ? { globalTasks: nextGlobalTasks } : {}),
      };
    });
  },

  refreshTeamChangePresence: async (teamName: string) => {
    const requestScope = captureTeamRequestScope(get, teamName);
    const currentTeamData = selectTeamDataForName(get(), teamName);
    if (!currentTeamData) {
      return;
    }

    try {
      const presenceByTaskId = await unwrapIpc('team:getTaskChangePresence', () =>
        api.teams.getTaskChangePresence(teamName)
      );
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }

      set((state) => {
        const teamData = selectTeamDataForName(state, teamName);
        if (!teamData) {
          return {};
        }

        let changed = false;
        const nextTasks = teamData.tasks.map((task) => {
          const nextPresence = presenceByTaskId[task.id] ?? 'unknown';
          if (
            nextPresence === 'unknown' &&
            task.changePresence &&
            task.changePresence !== 'unknown'
          ) {
            return task;
          }
          if (task.changePresence === nextPresence) {
            return task;
          }
          changed = true;
          return { ...task, changePresence: nextPresence };
        });

        if (!changed) {
          return {};
        }

        const nextTeamData = {
          ...teamData,
          tasks: nextTasks,
        };

        return {
          teamDataCacheByName: {
            ...state.teamDataCacheByName,
            [teamName]: nextTeamData,
          },
          ...(state.selectedTeamName === teamName ? { selectedTeamData: nextTeamData } : {}),
        };
      });
    } catch {
      // best-effort lightweight refresh; keep current UI state on failure
    }
  },

  selectTeam: async (teamName: string, opts) => {
    const requestScope = captureTeamRequestScope(get, teamName);
    const allowReloadWhileProvisioning = opts?.allowReloadWhileProvisioning === true;
    // Guard: prevent duplicate in-flight fetches for the same team.
    // GlobalTaskDetailDialog + tab navigation can call selectTeam() in quick succession.
    if (
      get().selectedTeamLoading &&
      get().selectedTeamName === teamName &&
      !allowReloadWhileProvisioning
    ) {
      return;
    }
    const requestNonce = get().selectedTeamLoadNonce + 1;
    const previousData = selectTeamDataForName(get(), teamName);

    cancelPostPaintTeamEnrichments(teamName);

    // Repoint selection synchronously to the new team's cached snapshot when available.
    // Never keep the previous team's snapshot attached to a newly selected team.
    set({
      selectedTeamName: teamName,
      selectedTeamData: previousData,
      selectedTeamLoading: true,
      selectedTeamLoadNonce: requestNonce,
      selectedTeamError: null,
      reviewActionError: null,
      // Load per-team tool approval settings
      toolApprovalSettings: loadToolApprovalSettingsForTeam(teamName),
    });

    try {
      const data = await fetchTeamDataDeduped(teamName, {
        includeMemberBranches: false,
      });
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        queuedFullTeamDataRefreshesAfterThin.delete(teamName);
        return;
      }
      // Stale check: user may have switched to another team during the async call
      const stateAfterLoad = get();
      if (stateAfterLoad.selectedTeamName !== teamName) {
        drainQueuedFullRefreshAfterThinSettles(teamName, get);
        return;
      }
      if (stateAfterLoad.selectedTeamLoadNonce !== requestNonce) {
        return;
      }
      // Eagerly patch teamByName with color/displayName from detailed data
      // so that tab color renders immediately without waiting for fetchTeams()
      const prevByName = get().teamByName;
      const existingEntry = prevByName[teamName];
      const configColor = data.config.color;
      if (configColor && (!existingEntry || existingEntry?.color !== configColor)) {
        const patched: TeamSummary = existingEntry
          ? { ...existingEntry, color: configColor, displayName: data.config.name || teamName }
          : {
              teamName,
              displayName: data.config.name || teamName,
              description: data.config.description ?? '',
              color: configColor,
              memberCount: data.members.length,
              taskCount: 0,
              lastActivity: null,
            };
        set({ teamByName: { ...prevByName, [teamName]: patched } });
      }

      let committedTeamData: TeamViewSnapshot = data;
      let projectedGlobalTaskNotifications: GlobalTaskNotificationParams | null = null;
      set((state) => {
        if (
          state.selectedTeamName === teamName &&
          shouldPreserveSelectedTeamSnapshot(
            state.selectedTeamData,
            previousData,
            data,
            state.teamByName[teamName]
          )
        ) {
          const preservedTeamData = state.selectedTeamData;
          committedTeamData = preservedTeamData ?? data;
          const nextCache =
            preservedTeamData && state.teamDataCacheByName[teamName] !== preservedTeamData
              ? {
                  ...state.teamDataCacheByName,
                  [teamName]: preservedTeamData,
                }
              : state.teamDataCacheByName;
          const nextGlobalTasks = preservedTeamData
            ? projectTeamSnapshotOntoGlobalTasks(state.globalTasks, teamName, preservedTeamData)
            : state.globalTasks;
          projectedGlobalTaskNotifications = buildGlobalTaskProjectionNotification(
            state,
            nextGlobalTasks
          );

          return {
            selectedTeamName: teamName,
            selectedTeamData: preservedTeamData,
            teamDataCacheByName: nextCache,
            selectedTeamLoading: false,
            selectedTeamError: null,
            ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
          };
        }

        const previousForProjection = selectTeamDataForName(state, teamName) ?? previousData;
        const projectedTeamData = previousForProjection
          ? {
              ...data,
              tasks: preserveKnownTaskChangePresence(
                teamName,
                previousForProjection.tasks,
                data.tasks
              ),
            }
          : data;
        const nextTeamData = structurallyShareTeamSnapshot(
          previousForProjection,
          projectedTeamData
        );
        committedTeamData = nextTeamData;
        const nextCache =
          state.teamDataCacheByName[teamName] === nextTeamData
            ? state.teamDataCacheByName
            : {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              };
        const nextGlobalTasks = projectTeamSnapshotOntoGlobalTasks(
          state.globalTasks,
          teamName,
          nextTeamData
        );
        projectedGlobalTaskNotifications = buildGlobalTaskProjectionNotification(
          state,
          nextGlobalTasks
        );

        return {
          selectedTeamName: teamName,
          selectedTeamData: nextTeamData,
          teamDataCacheByName: nextCache,
          selectedTeamLoading: false,
          selectedTeamError: null,
          ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
        };
      });
      if (projectedGlobalTaskNotifications) {
        processGlobalTaskNotifications(projectedGlobalTaskNotifications);
      }
      recordLastResolvedTeamDataRefresh(teamName);

      try {
        const invalidationState = previousData
          ? collectTaskChangeInvalidationState(
              teamName,
              previousData.tasks,
              committedTeamData.tasks
            )
          : { cacheKeys: [], taskIds: [] };
        if (invalidationState.cacheKeys.length > 0) {
          get().invalidateTaskChangePresence(invalidationState.cacheKeys);
        }
        if (invalidationState.taskIds.length > 0) {
          void api.review
            .invalidateTaskChangeSummaries(teamName, invalidationState.taskIds)
            .catch(() => undefined);
        }

        // Sync tab label with the team's display name from config.
        const displayName = committedTeamData.config.name || teamName;
        const allTabs = get().getAllPaneTabs();
        const relatedTabs = allTabs.filter(
          (tab) => (tab.type === 'team' || tab.type === 'graph') && tab.teamName === teamName
        );
        for (const tab of relatedTabs) {
          const nextLabel = tab.type === 'graph' ? `${displayName} Graph` : displayName;
          if (tab.label !== nextLabel) {
            get().updateTabLabel(tab.id, nextLabel);
          }
        }

        // Auto-select the project associated with this team's cwd/projectPath.
        // Must search both flat projects and grouped repositoryGroups/worktrees
        // because the default viewMode is 'grouped' and flat projects may be empty.
        const projectPath = committedTeamData.config.projectPath;
        if (
          !opts?.skipProjectAutoSelect &&
          projectPath &&
          isSelectedTeamLoadStillCurrent(get, teamName, requestNonce, requestScope)
        ) {
          const state = get();
          const normalizedTeamPath = normalizePath(projectPath);

          // 1. Try flat projects list
          const matchingProject = state.projects.find(
            (p) => normalizePath(p.path) === normalizedTeamPath
          );
          if (matchingProject && state.selectedProjectId !== matchingProject.id) {
            state.selectProject(matchingProject.id);
          } else if (!matchingProject) {
            // 2. Try grouped view: search worktrees across all repository groups
            for (const repo of state.repositoryGroups) {
              const matchingWorktree = repo.worktrees.find(
                (wt) => normalizePath(wt.path) === normalizedTeamPath
              );
              if (matchingWorktree) {
                if (state.selectedWorktreeId !== matchingWorktree.id) {
                  set(getWorktreeNavigationState(repo.id, matchingWorktree.id));
                  void get().fetchSessionsInitial(matchingWorktree.id);
                }
                break;
              }
            }
          }
        }
      } catch (error) {
        logger.debug(
          `selectTeam(${teamName}) post-structural sync work failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      try {
        schedulePostPaintTeamEnrichments({
          teamName,
          requestNonce,
          requestScope,
          get,
        });
      } catch (error) {
        logger.debug(
          `selectTeam(${teamName}) failed to schedule post-paint enrichments: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    } catch (error) {
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        queuedFullTeamDataRefreshesAfterThin.delete(teamName);
        return;
      }
      // If provisioning is in progress for this team, stay in loading state;
      // file watcher / progress callback will refresh once config is written.
      const currentState = get();
      if (currentState.selectedTeamName !== teamName) {
        queuedFullTeamDataRefreshesAfterThin.delete(teamName);
        return;
      }
      if (currentState.selectedTeamLoadNonce !== requestNonce) {
        return;
      }
      queuedFullTeamDataRefreshesAfterThin.delete(teamName);
      const isProvisioning = isTeamProvisioningActive(currentState, teamName);
      const existingSelectedTeamData =
        currentState.selectedTeamData?.teamName === teamName ? currentState.selectedTeamData : null;

      const msg = error instanceof Error ? error.message : String(error);
      // IPC can report provisioning state explicitly.
      if (msg === 'TEAM_PROVISIONING' || (msg.includes('TEAM_PROVISIONING') && isProvisioning)) {
        if (existingSelectedTeamData) {
          set({
            selectedTeamLoading: false,
            selectedTeamData: existingSelectedTeamData,
            selectedTeamError: null,
          });
          return;
        }
        set({
          selectedTeamLoading: true,
          selectedTeamData: null,
          selectedTeamError: null,
        });
        return;
      }

      // Draft team: team.meta.json exists but config.json doesn't (provisioning failed)
      if (msg === 'TEAM_DRAFT' || msg.includes('TEAM_DRAFT')) {
        set({
          selectedTeamLoading: false,
          selectedTeamData: null,
          selectedTeamError: 'TEAM_DRAFT',
        });
        return;
      }

      const message =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to fetch team data';
      if (existingSelectedTeamData) {
        set({
          selectedTeamLoading: false,
          selectedTeamData: existingSelectedTeamData,
          selectedTeamError: null,
        });
        return;
      }
      set({
        selectedTeamLoading: false,
        selectedTeamData: null,
        selectedTeamError: message,
      });
    }
  },

  refreshTeamData: async (teamName: string, opts?: RefreshTeamDataOptions) => {
    const fullKey = getFullTeamDataRequestKey(teamName);
    const reusedInFlightRequest = opts?.withDedup === true && inFlightTeamDataRequests.has(fullKey);
    const queuedBehindThinRequest =
      opts?.withDedup === true && !reusedInFlightRequest && hasThinTeamDataRequestForTeam(teamName);

    if (queuedBehindThinRequest) {
      queuedFullTeamDataRefreshesAfterThin.add(teamName);
      logger.debug(`refreshTeamData(${teamName}) queued behind thin team:getData`);
      return;
    }

    const requestScope = captureTeamRequestScope(get, teamName);
    const refreshToken = beginInFlightTeamDataRefresh(teamName);
    // Silent refresh — update data without showing loading skeleton.
    // Only selectTeam() sets loading: true (for initial load).
    noteTeamRefreshBurst(teamName, TEAM_REFRESH_BURST_WINDOW_MS);
    if (reusedInFlightRequest) {
      pendingFreshTeamDataRefreshes.add(teamName);
    }
    try {
      const previousData = selectTeamDataForName(get(), teamName);
      const data = opts?.withDedup
        ? await fetchTeamDataDeduped(teamName)
        : await fetchTeamDataFresh(teamName);
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }
      const projectedTeamData = previousData
        ? {
            ...data,
            tasks: preserveKnownTaskChangePresence(teamName, previousData.tasks, data.tasks),
          }
        : data;
      const nextTeamData = structurallyShareTeamSnapshot(previousData, projectedTeamData);
      let projectedGlobalTaskNotifications: GlobalTaskNotificationParams | null = null;
      set((state) => {
        const nextCache =
          state.teamDataCacheByName[teamName] === nextTeamData
            ? state.teamDataCacheByName
            : {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              };

        const selectedState =
          state.selectedTeamName === teamName
            ? {
                selectedTeamData: nextTeamData,
                selectedTeamError: null,
              }
            : {};
        const nextGlobalTasks = projectTeamSnapshotOntoGlobalTasks(
          state.globalTasks,
          teamName,
          nextTeamData
        );
        projectedGlobalTaskNotifications = buildGlobalTaskProjectionNotification(
          state,
          nextGlobalTasks
        );

        if (
          nextCache === state.teamDataCacheByName &&
          nextGlobalTasks === state.globalTasks &&
          (state.selectedTeamName !== teamName ||
            (state.selectedTeamData === nextTeamData && state.selectedTeamError == null))
        ) {
          return {};
        }

        return {
          teamDataCacheByName: nextCache,
          ...(nextGlobalTasks !== state.globalTasks ? { globalTasks: nextGlobalTasks } : {}),
          ...selectedState,
        };
      });
      if (projectedGlobalTaskNotifications) {
        processGlobalTaskNotifications(projectedGlobalTaskNotifications);
      }
      recordLastResolvedTeamDataRefresh(teamName);
      const invalidationState = previousData
        ? collectTaskChangeInvalidationState(teamName, previousData.tasks, data.tasks)
        : { cacheKeys: [], taskIds: [] };
      if (invalidationState.cacheKeys.length > 0) {
        get().invalidateTaskChangePresence(invalidationState.cacheKeys);
      }
      if (invalidationState.taskIds.length > 0) {
        await api.review.invalidateTaskChangeSummaries(teamName, invalidationState.taskIds);
      }
    } catch (error) {
      if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
        return;
      }
      const msg =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to refresh team data';

      // During provisioning, team:getData may not be readable yet.
      // Preserve existing data instead of showing a fatal error.
      if (msg === 'TEAM_PROVISIONING' || msg.includes('TEAM_PROVISIONING')) {
        logger.debug(`refreshTeamData(${teamName}) skipped: team is still provisioning`);
        if (get().selectedTeamName === teamName) {
          set({ selectedTeamError: null });
        }
        return;
      }

      if (shouldInvalidateCachedTeamDataForError(teamName, msg)) {
        set((state) => {
          const nextCache = state.teamDataCacheByName[teamName]
            ? { ...state.teamDataCacheByName }
            : null;
          if (nextCache) {
            delete nextCache[teamName];
          }
          if (state.selectedTeamName !== teamName && !nextCache) {
            return {};
          }
          return {
            ...(nextCache ? { teamDataCacheByName: nextCache } : {}),
            ...(state.selectedTeamName === teamName
              ? {
                  selectedTeamLoading: false,
                  selectedTeamData: null,
                  selectedTeamError:
                    msg === 'TEAM_DRAFT' || msg.includes('TEAM_DRAFT') ? 'TEAM_DRAFT' : msg,
                }
              : {}),
          };
        });
        return;
      }

      if (get().selectedTeamName !== teamName) {
        return;
      }

      logger.warn(`refreshTeamData(${teamName}) failed: ${msg}`);

      // Non-destructive: if we already have data, keep it visible.
      // Only set error when there's nothing to show.
      if (get().selectedTeamData) {
        logger.debug(`refreshTeamData(${teamName}) preserving existing data after transient error`);
        set({ selectedTeamError: null });
        return;
      }
      set({ selectedTeamError: msg });
    } finally {
      endInFlightTeamDataRefresh(teamName, refreshToken);
      if (
        reusedInFlightRequest &&
        pendingFreshTeamDataRefreshes.delete(teamName) &&
        isTeamRequestScopeCurrent(get, teamName, requestScope)
      ) {
        void get().refreshTeamData(teamName);
      }
    }
  },

  refreshTeamMessagesHead: async (teamName: string) => {
    const existingRequest = inFlightTeamMessagesHeadRequests.get(teamName);
    if (existingRequest) {
      pendingFreshTeamMessagesHeadRefreshes.add(teamName);
      return existingRequest;
    }
    const queuedAfterOlder = queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName);
    if (queuedAfterOlder) {
      return queuedAfterOlder;
    }

    const existingOlderRequest = inFlightTeamMessagesOlderRequests.get(teamName);
    if (existingOlderRequest) {
      const queuedScope = captureTeamRequestScope(get, teamName);
      const queuedRequest: Promise<RefreshTeamMessagesHeadResult> = existingOlderRequest
        .then(() => {
          if (!isTeamRequestScopeCurrent(get, teamName, queuedScope)) {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }
          if (queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) === queuedRequest) {
            queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
          } else {
            return {
              feedChanged: false,
              headChanged: false,
              feedRevision: null,
            };
          }
          return get().refreshTeamMessagesHead(teamName);
        })
        .finally(() => {
          if (queuedTeamMessagesHeadRefreshesAfterOlder.get(teamName) === queuedRequest) {
            queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
          }
        });
      queuedTeamMessagesHeadRefreshesAfterOlder.set(teamName, queuedRequest);
      return queuedRequest;
    }

    const requestRef: { current: Promise<RefreshTeamMessagesHeadResult> | null } = {
      current: null,
    };
    requestRef.current = (async (): Promise<RefreshTeamMessagesHeadResult> => {
      const requestScope = captureTeamRequestScope(get, teamName);
      set((state) => ({
        teamMessagesByName: {
          ...state.teamMessagesByName,
          [teamName]: {
            ...getTeamMessagesCacheEntry(state, teamName),
            loadingHead: true,
          },
        },
      }));

      try {
        const page = await unwrapIpc('team:getMessagesPage', () =>
          api.teams.getMessagesPage(teamName, { limit: 50 })
        );
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return {
            feedChanged: false,
            headChanged: false,
            feedRevision: null,
          };
        }

        const previousEntry = getTeamMessagesCacheEntry(get(), teamName);
        const feedChanged =
          !previousEntry.headHydrated || previousEntry.feedRevision !== page.feedRevision;
        const previousHeadSlice = getCanonicalHeadSlice(
          previousEntry.canonicalMessages,
          page.messages.length
        );
        const headChanged = !areInboxMessageArraysEquivalent(previousHeadSlice, page.messages);

        set((state) => {
          const current = getTeamMessagesCacheEntry(state, teamName);
          const retainedOlderTail = extractRetainedCanonicalOlderTail(
            current.canonicalMessages,
            page.messages
          );
          const preserveLoadedOlderTail =
            Array.isArray(retainedOlderTail) && retainedOlderTail.length > 0;
          const nextCanonical = headChanged
            ? preserveLoadedOlderTail
              ? mergeTeamMessages(retainedOlderTail, page.messages)
              : page.messages
            : current.canonicalMessages;
          const nextOptimistic = pruneOptimisticMessages(current.optimisticMessages, nextCanonical);
          const nextEntry: TeamMessagesCacheEntry = {
            ...current,
            canonicalMessages: nextCanonical,
            optimisticMessages: nextOptimistic,
            feedRevision: page.feedRevision,
            nextCursor: preserveLoadedOlderTail ? current.nextCursor : page.nextCursor,
            hasMore: preserveLoadedOlderTail ? current.hasMore : page.hasMore,
            lastFetchedAt: Date.now(),
            loadingHead: false,
            headHydrated: true,
          };
          return {
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: nextEntry,
            },
          };
        });

        return {
          feedChanged,
          headChanged,
          feedRevision: page.feedRevision,
        };
      } catch (error) {
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return {
            feedChanged: false,
            headChanged: false,
            feedRevision: null,
          };
        }
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingHead: false,
            },
          },
        }));
        throw error;
      } finally {
        if (inFlightTeamMessagesHeadRequests.get(teamName) === requestRef.current) {
          inFlightTeamMessagesHeadRequests.delete(teamName);
          if (
            pendingFreshTeamMessagesHeadRefreshes.delete(teamName) &&
            isTeamRequestScopeCurrent(get, teamName, requestScope)
          ) {
            void get().refreshTeamMessagesHead(teamName);
          }
        }
      }
    })();

    const request = requestRef.current;
    inFlightTeamMessagesHeadRequests.set(teamName, request);
    return request;
  },

  loadOlderTeamMessages: async (teamName: string) => {
    const requestedScope = captureTeamRequestScope(get, teamName);
    const existingRequest = inFlightTeamMessagesOlderRequests.get(teamName);
    if (existingRequest) {
      return existingRequest;
    }

    const existingHeadRequest = inFlightTeamMessagesHeadRequests.get(teamName);
    if (existingHeadRequest) {
      await existingHeadRequest;
      if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
        return;
      }
    }

    let entry = getTeamMessagesCacheEntry(get(), teamName);
    if (!entry.headHydrated) {
      await get().refreshTeamMessagesHead(teamName);
      if (!isTeamRequestScopeCurrent(get, teamName, requestedScope)) {
        return;
      }
      entry = getTeamMessagesCacheEntry(get(), teamName);
    }

    if (!entry.headHydrated || !entry.nextCursor || entry.loadingOlder || entry.loadingHead) {
      return;
    }

    const requestRef: { current: Promise<void> | null } = { current: null };
    requestRef.current = (async (): Promise<void> => {
      const requestScope = captureTeamRequestScope(get, teamName);
      set((state) => ({
        teamMessagesByName: {
          ...state.teamMessagesByName,
          [teamName]: {
            ...getTeamMessagesCacheEntry(state, teamName),
            loadingOlder: true,
          },
        },
      }));

      try {
        const baseFeedRevision = entry.feedRevision;
        const page = await unwrapIpc('team:getMessagesPage', () =>
          api.teams.getMessagesPage(teamName, {
            cursor: entry.nextCursor,
            limit: 50,
          })
        );
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return;
        }

        const current = getTeamMessagesCacheEntry(get(), teamName);
        if (current.feedRevision !== baseFeedRevision) {
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingOlder: false,
              },
            },
          }));
          await get().refreshTeamMessagesHead(teamName);
          return;
        }

        if (current.feedRevision && current.feedRevision !== page.feedRevision) {
          set((state) => ({
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...getTeamMessagesCacheEntry(state, teamName),
                loadingOlder: false,
              },
            },
          }));
          await get().refreshTeamMessagesHead(teamName);
          return;
        }

        set((state) => {
          const liveEntry = getTeamMessagesCacheEntry(state, teamName);
          const mergedCanonical = mergeTeamMessages(liveEntry.canonicalMessages, page.messages);
          return {
            teamMessagesByName: {
              ...state.teamMessagesByName,
              [teamName]: {
                ...liveEntry,
                canonicalMessages: mergedCanonical,
                nextCursor: page.nextCursor,
                hasMore: page.hasMore,
                feedRevision: page.feedRevision,
                loadingOlder: false,
              },
            },
          };
        });
      } catch {
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return;
        }
        set((state) => ({
          teamMessagesByName: {
            ...state.teamMessagesByName,
            [teamName]: {
              ...getTeamMessagesCacheEntry(state, teamName),
              loadingOlder: false,
            },
          },
        }));
      } finally {
        if (inFlightTeamMessagesOlderRequests.get(teamName) === requestRef.current) {
          inFlightTeamMessagesOlderRequests.delete(teamName);
        }
      }
    })();

    const request = requestRef.current;
    inFlightTeamMessagesOlderRequests.set(teamName, request);
    return request;
  },

  refreshMemberActivityMeta: async (teamName: string) => {
    const entry = getTeamMessagesCacheEntry(get(), teamName);
    if (!entry.headHydrated) {
      return;
    }

    const existingRequest = inFlightTeamMemberActivityMetaRequests.get(teamName);
    if (existingRequest) {
      pendingFreshTeamMemberActivityMetaRefreshes.add(teamName);
      return existingRequest;
    }

    const requestRef: { current: Promise<void> | null } = { current: null };
    requestRef.current = (async (): Promise<void> => {
      const requestScope = captureTeamRequestScope(get, teamName);
      try {
        const meta = await unwrapIpc('team:getMemberActivityMeta', () =>
          api.teams.getMemberActivityMeta(teamName)
        );
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return;
        }

        set((state) => {
          const currentFeedRevision = getTeamMessagesCacheEntry(state, teamName).feedRevision;
          if (currentFeedRevision && meta.feedRevision !== currentFeedRevision) {
            return {};
          }
          const existing = state.memberActivityMetaByTeam[teamName];
          if (existing?.feedRevision === meta.feedRevision) {
            return {};
          }
          const sharedMembers = structurallyShareMemberActivityFacts(
            existing?.members,
            meta.members
          );
          const nextMeta =
            existing?.members === sharedMembers &&
            existing.feedRevision === meta.feedRevision &&
            existing.computedAt === meta.computedAt
              ? existing
              : {
                  ...meta,
                  members: sharedMembers,
                };
          return {
            memberActivityMetaByTeam: {
              ...state.memberActivityMetaByTeam,
              [teamName]: nextMeta,
            },
          };
        });
      } catch (error) {
        if (!isTeamRequestScopeCurrent(get, teamName, requestScope)) {
          return;
        }
        throw error;
      } finally {
        if (inFlightTeamMemberActivityMetaRequests.get(teamName) === requestRef.current) {
          inFlightTeamMemberActivityMetaRequests.delete(teamName);
          if (
            pendingFreshTeamMemberActivityMetaRefreshes.delete(teamName) &&
            isTeamRequestScopeCurrent(get, teamName, requestScope)
          ) {
            void get().refreshMemberActivityMeta(teamName);
          }
        }
      }
    })();

    const request = requestRef.current;
    inFlightTeamMemberActivityMetaRequests.set(teamName, request);
    return request;
  },

  syncTeamPendingReplyRefresh: (
    teamName: string,
    sourceId: string,
    enabled: boolean,
    delayMs = 10_000
  ) => {
    clearPendingReplyRefreshTimer(teamName);
    const shouldKeepRefreshActive = setPendingReplyRefreshEnabled(teamName, sourceId, enabled);
    if (!shouldKeepRefreshActive) {
      return;
    }

    const timer = setTimeout(() => {
      if (pendingTeamPendingReplyRefreshTimers.get(teamName) !== timer) {
        return;
      }
      pendingTeamPendingReplyRefreshTimers.delete(teamName);
      void (async () => {
        try {
          const headResult = await get().refreshTeamMessagesHead(teamName);
          if (headResult.feedChanged || isMemberActivityMetaStale(get(), teamName)) {
            await get().refreshMemberActivityMeta(teamName);
          }
        } catch {
          // Best-effort delayed refresh while waiting for replies.
        }
      })();
    }, delayMs);

    pendingTeamPendingReplyRefreshTimers.set(teamName, timer);
  },

  updateKanban: async (teamName: string, taskId: string, patch: UpdateKanbanPatch) => {
    try {
      set({ reviewActionError: null });
      await unwrapIpc('team:updateKanban', () => api.teams.updateKanban(teamName, taskId, patch));
      await get().refreshTeamData(teamName);
    } catch (error) {
      set({
        reviewActionError: mapReviewError(error),
      });
      throw error;
    }
  },

  updateKanbanColumnOrder: async (
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ) => {
    await unwrapIpc('team:updateKanbanColumnOrder', () =>
      api.teams.updateKanbanColumnOrder(teamName, columnId, orderedTaskIds)
    );
    await get().refreshTeamData(teamName);
  },

  sendTeamMessage: async (teamName: string, request: SendMessageRequest) => {
    set({
      sendingMessage: true,
      sendMessageError: null,
      sendMessageWarning: null,
      sendMessageDebugDetails: null,
      lastSendMessageResult: null,
    });
    try {
      const result = await unwrapIpc('team:sendMessage', () =>
        api.teams.sendMessage(teamName, request)
      );
      const runtimeDeliveryFailed = isOpenCodeRuntimeDeliveryHardUxFailure(result.runtimeDelivery);
      const runtimeDeliveryDiagnostics = buildOpenCodeRuntimeDeliveryDiagnostics(result);
      const optimisticMessage: InboxMessage = {
        from: request.from ?? 'user',
        to: request.to ?? request.member,
        text: request.text,
        timestamp: request.timestamp ?? nowIso(),
        read: true,
        taskRefs: request.taskRefs?.length ? request.taskRefs : undefined,
        actionMode: request.actionMode,
        summary: request.summary,
        color: request.color,
        messageId: result.messageId,
        relayOfMessageId: request.relayOfMessageId,
        source: request.source ?? 'user_sent',
        attachments: request.attachments?.length ? request.attachments : undefined,
        leadSessionId: request.leadSessionId,
        conversationId: request.conversationId,
        replyToConversationId: request.replyToConversationId,
        toolSummary: request.toolSummary,
        toolCalls: request.toolCalls,
        messageKind: request.messageKind,
        slashCommand: request.slashCommand,
        commandOutput: request.commandOutput,
      };
      set((state) => ({
        sendingMessage: false,
        sendMessageError: null,
        sendMessageWarning: runtimeDeliveryDiagnostics.warning,
        sendMessageDebugDetails: runtimeDeliveryDiagnostics.debugDetails,
        lastSendMessageResult: runtimeDeliveryFailed ? null : result,
        teamMessagesByName: {
          ...state.teamMessagesByName,
          [teamName]: upsertOptimisticTeamMessage(
            getTeamMessagesCacheEntry(state, teamName),
            optimisticMessage
          ),
        },
      }));
      await get().refreshTeamMessagesHead(teamName);
      return result;
    } catch (error) {
      set({
        sendingMessage: false,
        lastSendMessageResult: null,
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
        sendMessageError: mapSendMessageError(error),
      });
      throw error;
    }
  },

  clearSendMessageRuntimeDiagnostics: (messageId?: string | null) => {
    set((state) => {
      if (messageId && state.sendMessageDebugDetails?.messageId !== messageId) {
        return {};
      }
      if (!state.sendMessageWarning && !state.sendMessageDebugDetails) {
        return {};
      }
      return {
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
      };
    });
  },

  refreshSendMessageRuntimeDeliveryStatus: async (teamName, input) => {
    const normalizedMessageId = typeof input === 'string' ? input.trim() : input.messageId.trim();
    const statusMessageId =
      typeof input === 'string'
        ? normalizedMessageId
        : input.statusMessageId?.trim() || normalizedMessageId;
    if (!normalizedMessageId) return;
    if (get().sendMessageDebugDetails?.messageId !== normalizedMessageId) return;
    let status = await unwrapIpc('team:getOpenCodeRuntimeDeliveryStatus', () =>
      api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, statusMessageId)
    );
    if (!status) return;
    if (statusMessageId !== normalizedMessageId) {
      const blockerUserVisibleState = status.userVisibleImpact?.state;
      const blockerStillChecking =
        blockerUserVisibleState !== undefined
          ? blockerUserVisibleState === 'checking'
          : status.responsePending === true;
      if (!blockerStillChecking) {
        const ownStatus = await unwrapIpc('team:getOpenCodeRuntimeDeliveryStatus', () =>
          api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, normalizedMessageId)
        );
        if (!ownStatus) return;
        status = ownStatus;
      }
    }
    const diagnostics = buildOpenCodeRuntimeDeliveryDiagnostics({
      deliveredToInbox: true,
      messageId: normalizedMessageId,
      runtimeDelivery: status,
    });
    set((state) => {
      if (state.sendMessageDebugDetails?.messageId !== normalizedMessageId) {
        return {};
      }
      return {
        sendMessageWarning: diagnostics.warning,
        sendMessageDebugDetails: diagnostics.debugDetails,
      };
    });
  },

  fetchCrossTeamTargets: async () => {
    const requestScope = captureContextRequestScope(get);
    set({ crossTeamTargetsLoading: true });
    try {
      const targets = await api.crossTeam.listTargets();
      if (!isContextRequestScopeCurrent(get, requestScope)) {
        return false;
      }
      set({ crossTeamTargets: targets, crossTeamTargetsLoading: false });
      return true;
    } catch (error) {
      if (!isContextRequestScopeCurrent(get, requestScope)) {
        return false;
      }
      logger.error('fetchCrossTeamTargets failed', error);
      set({ crossTeamTargets: [], crossTeamTargetsLoading: false });
      return false;
    }
  },

  sendCrossTeamMessage: async (request: CrossTeamSendRequest) => {
    set({
      sendingMessage: true,
      sendMessageError: null,
      sendMessageWarning: null,
      sendMessageDebugDetails: null,
      lastSendMessageResult: null,
    });
    try {
      const result = await api.crossTeam.send(request);
      set({
        sendingMessage: false,
        sendMessageError: null,
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
        lastSendMessageResult: {
          messageId: result.messageId,
          deliveredToInbox: result.deliveredToInbox,
          deduplicated: result.deduplicated,
        },
      });
      await get().refreshTeamMessagesHead(request.fromTeam);
    } catch (error) {
      set({
        sendingMessage: false,
        lastSendMessageResult: null,
        sendMessageWarning: null,
        sendMessageDebugDetails: null,
        sendMessageError: mapSendMessageError(error),
      });
    }
  },

  requestReview: async (teamName: string, taskId: string) => {
    try {
      set({ reviewActionError: null });
      await unwrapIpc('team:requestReview', () => api.teams.requestReview(teamName, taskId));
      await get().refreshTeamData(teamName);
      void refreshTaskChangePresenceForUpdatedTask(get, teamName, taskId);
    } catch (error) {
      set({
        reviewActionError: mapReviewError(error),
      });
      throw error;
    }
  },

  createTeamTask: async (teamName: string, request: CreateTaskRequest) => {
    const task = await unwrapIpc('team:createTask', () => api.teams.createTask(teamName, request));
    await get().refreshTeamData(teamName);
    return task;
  },

  startTask: async (teamName: string, taskId: string) => {
    const result = await unwrapIpc('team:startTask', () => api.teams.startTask(teamName, taskId));
    await get().refreshTeamData(teamName);
    void refreshTaskChangePresenceForUpdatedTask(get, teamName, taskId);
    return result;
  },

  startTaskByUser: async (teamName: string, taskId: string) => {
    const result = await unwrapIpc('team:startTaskByUser', () =>
      api.teams.startTaskByUser(teamName, taskId)
    );
    await get().refreshTeamData(teamName);
    void refreshTaskChangePresenceForUpdatedTask(get, teamName, taskId);
    return result;
  },

  updateTaskStatus: async (teamName: string, taskId: string, status: TeamTaskStatus) => {
    await unwrapIpc('team:updateTaskStatus', () =>
      api.teams.updateTaskStatus(teamName, taskId, status)
    );
    await get().refreshTeamData(teamName);
    void refreshTaskChangePresenceForUpdatedTask(get, teamName, taskId);
  },

  updateTaskOwner: async (teamName: string, taskId: string, owner: string | null) => {
    await unwrapIpc('team:updateTaskOwner', () =>
      api.teams.updateTaskOwner(teamName, taskId, owner)
    );
    await get().refreshTeamData(teamName);
  },

  updateTaskFields: async (
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ) => {
    await unwrapIpc('team:updateTaskFields', () =>
      api.teams.updateTaskFields(teamName, taskId, fields)
    );
    await get().refreshTeamData(teamName);
  },

  addTaskRelationship: async (teamName, taskId, targetId, type) => {
    await unwrapIpc('team:addTaskRelationship', () =>
      api.teams.addTaskRelationship(teamName, taskId, targetId, type)
    );
    await get().refreshTeamData(teamName);
  },

  removeTaskRelationship: async (teamName, taskId, targetId, type) => {
    await unwrapIpc('team:removeTaskRelationship', () =>
      api.teams.removeTaskRelationship(teamName, taskId, targetId, type)
    );
    await get().refreshTeamData(teamName);
  },

  setTaskNeedsClarification: async (teamName, taskId, value) => {
    await unwrapIpc('team:setTaskClarification', () =>
      api.teams.setTaskClarification(teamName, taskId, value)
    );
    await get().refreshTeamData(teamName);
    await get().fetchAllTasks();
  },

  saveTaskAttachment: async (teamName, taskId, file) => {
    const id = crypto.randomUUID();
    await unwrapIpc('team:saveTaskAttachment', () =>
      api.teams.saveTaskAttachment(teamName, taskId, id, file.name, file.type, file.base64)
    );
    await get().refreshTeamData(teamName);
  },

  deleteTaskAttachment: async (teamName, taskId, attachmentId, mimeType) => {
    await unwrapIpc('team:deleteTaskAttachment', () =>
      api.teams.deleteTaskAttachment(teamName, taskId, attachmentId, mimeType)
    );
    await get().refreshTeamData(teamName);
  },

  getTaskAttachmentData: async (teamName, taskId, attachmentId, mimeType) => {
    return unwrapIpc('team:getTaskAttachment', () =>
      api.teams.getTaskAttachment(teamName, taskId, attachmentId, mimeType)
    );
  },

  addTaskComment: async (teamName, taskId, request) => {
    set({ addingComment: true, addCommentError: null });
    try {
      const comment = await unwrapIpc('team:addTaskComment', () =>
        api.teams.addTaskComment(teamName, taskId, request)
      );
      set({ addingComment: false });
      await get().refreshTeamData(teamName);
      return comment;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to add comment';
      set({ addingComment: false, addCommentError: msg });
      throw error;
    }
  },

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

  softDeleteTask: async (teamName: string, taskId: string) => {
    await unwrapIpc('team:softDeleteTask', () => api.teams.softDeleteTask(teamName, taskId));
    await get().refreshTeamData(teamName);
    await get().fetchDeletedTasks(teamName);
  },

  restoreTask: async (teamName: string, taskId: string) => {
    await unwrapIpc('team:restoreTask', () => api.teams.restoreTask(teamName, taskId));
    await get().refreshTeamData(teamName);
    await get().fetchDeletedTasks(teamName);
  },

  fetchDeletedTasks: async (teamName: string) => {
    set({ deletedTasksLoading: true });
    try {
      const tasks = await unwrapIpc('team:getDeletedTasks', () =>
        api.teams.getDeletedTasks(teamName)
      );
      set({ deletedTasks: tasks, deletedTasksLoading: false });
    } catch (error) {
      logger.error('Failed to fetch deleted tasks:', error);
      set({ deletedTasks: [], deletedTasksLoading: false });
    }
  },

  deleteTeam: async (teamName: string) => {
    await unwrapIpc('team:deleteTeam', () => api.teams.deleteTeam(teamName));
    invalidateTeamLocalStateEpoch(teamName);
    clearPendingReplyRefreshTimer(teamName);
    clearPendingReplyRefreshWaits(teamName);
    clearTeamScopedTransientState(teamName);
    set((state) => {
      const clearedState = collectTeamScopedStateRemovals(state, teamName);
      const tombstones = buildTeamScopedProgressTombstones(state, teamName, nowIso());
      if (state.selectedTeamName === teamName) {
        return {
          selectedTeamName: null,
          selectedTeamData: null,
          selectedTeamLoading: false,
          selectedTeamError: null,
          ...clearedState,
          ...tombstones,
        };
      }
      return {
        ...clearedState,
        ...tombstones,
      };
    });
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  restoreTeam: async (teamName: string) => {
    await unwrapIpc('team:restoreTeam', () => api.teams.restoreTeam(teamName));
    invalidateTeamLocalStateEpoch(teamName);
    clearPendingReplyRefreshTimer(teamName);
    clearPendingReplyRefreshWaits(teamName);
    clearTeamScopedTransientState(teamName);
    set((state) => {
      const clearedState = collectTeamScopedStateRemovals(state, teamName);
      const tombstones = buildTeamScopedProgressTombstones(state, teamName, nowIso());
      if (Object.keys(clearedState).length === 0) {
        return tombstones;
      }
      return {
        ...clearedState,
        ...tombstones,
      };
    });
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  permanentlyDeleteTeam: async (teamName: string) => {
    await unwrapIpc('team:permanentlyDeleteTeam', () => api.teams.permanentlyDeleteTeam(teamName));
    invalidateTeamLocalStateEpoch(teamName);
    clearPendingReplyRefreshTimer(teamName);
    clearPendingReplyRefreshWaits(teamName);
    clearTeamScopedTransientState(teamName);
    const state = get();
    const clearedState = collectTeamScopedStateRemovals(state, teamName);
    const tombstones = buildTeamScopedProgressTombstones(state, teamName, nowIso());
    if (state.selectedTeamName === teamName) {
      set({
        selectedTeamName: null,
        selectedTeamData: null,
        selectedTeamError: null,
        ...clearedState,
        ...tombstones,
      });
    } else if (Object.keys(clearedState).length > 0) {
      set({
        ...clearedState,
        ...tombstones,
      });
    } else {
      set(tombstones);
    }
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  createTeam: async (request: TeamCreateRequest) => {
    // Ensure provisioning progress subscription is active (defensive).
    get().subscribeProvisioningProgress();
    invalidateTeamLocalStateEpoch(request.teamName);
    clearPendingReplyRefreshTimer(request.teamName);
    clearPendingReplyRefreshWaits(request.teamName);
    clearTeamScopedTransientState(request.teamName);

    // Establish a per-team floor so late events from a previous run can't override UI.
    const floor = nowIso();
    set((state) => ({
      provisioningStartedAtFloorByTeam: {
        ...state.provisioningStartedAtFloorByTeam,
        [request.teamName]: floor,
      },
    }));

    // Clear stale provisioning runs for this team so the banner starts fresh
    set((state) => {
      const cleaned = { ...state.provisioningRuns };
      for (const [runId, run] of Object.entries(cleaned)) {
        if (run.teamName === request.teamName) {
          delete cleaned[runId];
        }
      }
      const nextErrors = { ...state.provisioningErrorByTeam };
      delete nextErrors[request.teamName];
      const nextSpawnStatuses = { ...state.memberSpawnStatusesByTeam };
      delete nextSpawnStatuses[request.teamName];
      const nextSpawnSnapshots = { ...state.memberSpawnSnapshotsByTeam };
      delete nextSpawnSnapshots[request.teamName];
      const nextRuntime = { ...state.teamAgentRuntimeByTeam };
      delete nextRuntime[request.teamName];
      const nextActiveTools = { ...state.activeToolsByTeam };
      delete nextActiveTools[request.teamName];
      const nextFinishedVisible = { ...state.finishedVisibleByTeam };
      delete nextFinishedVisible[request.teamName];
      const nextToolHistory = { ...state.toolHistoryByTeam };
      delete nextToolHistory[request.teamName];
      const nextRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
      const previousRuntimeRunId = nextRuntimeRunIdByTeam[request.teamName];
      delete nextRuntimeRunIdByTeam[request.teamName];
      const nextIgnoredRuntimeRunIds = previousRuntimeRunId
        ? {
            ...state.ignoredRuntimeRunIds,
            [previousRuntimeRunId]: request.teamName,
          }
        : state.ignoredRuntimeRunIds;
      const visibleLoadingResets = collectTeamScopedVisibleLoadingResets(state, request.teamName);
      return {
        provisioningRuns: cleaned,
        provisioningErrorByTeam: nextErrors,
        memberSpawnStatusesByTeam: nextSpawnStatuses,
        memberSpawnSnapshotsByTeam: nextSpawnSnapshots,
        teamAgentRuntimeByTeam: nextRuntime,
        activeToolsByTeam: nextActiveTools,
        finishedVisibleByTeam: nextFinishedVisible,
        toolHistoryByTeam: nextToolHistory,
        currentRuntimeRunIdByTeam: nextRuntimeRunIdByTeam,
        ignoredProvisioningRunIds: state.ignoredProvisioningRunIds,
        ignoredRuntimeRunIds: nextIgnoredRuntimeRunIds,
        ...visibleLoadingResets,
      };
    });

    // Optimistic progress entry: ensures banner shows even if IPC progress is delayed/missed.
    const pendingRunId = `pending:${request.teamName}:${Date.now()}`;
    set((state) => ({
      provisioningRuns: {
        ...state.provisioningRuns,
        [pendingRunId]: {
          runId: pendingRunId,
          teamName: request.teamName,
          state: 'spawning',
          message: 'Starting Claude CLI process...',
          startedAt: floor,
          updatedAt: floor,
        },
      },
      currentProvisioningRunIdByTeam: {
        ...state.currentProvisioningRunIdByTeam,
        [request.teamName]: pendingRunId,
      },
      // Synthetic card for the team list — visible until fetchTeams() picks up the real team.
      provisioningSnapshotByTeam: {
        ...state.provisioningSnapshotByTeam,
        [request.teamName]: {
          teamName: request.teamName,
          displayName: request.displayName || request.teamName,
          description: request.description || '',
          color: request.color,
          memberCount: request.members.length,
          members: request.members.map((m) => ({
            name: m.name,
            role: m.role,
            mcpPolicy: m.mcpPolicy,
          })),
          taskCount: 0,
          lastActivity: null,
          projectPath: request.cwd || undefined,
        },
      },
    }));
    const optimisticLaunchParams = buildLaunchParamsFromRuntimeRequest(request);
    const previousLaunchParams = get().launchParamsByTeam[request.teamName];
    set((state) => ({
      launchParamsByTeam: {
        ...state.launchParamsByTeam,
        [request.teamName]: optimisticLaunchParams,
      },
    }));
    // Initialize per-team tool approval settings based on skipPermissions flag
    const initialSettings: ToolApprovalSettings =
      request.skipPermissions === false
        ? DEFAULT_TOOL_APPROVAL_SETTINGS
        : { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };
    saveToolApprovalSettingsForTeam(request.teamName, initialSettings);
    set({ toolApprovalSettings: initialSettings });
    try {
      if (typeof api.teams.createTeam !== 'function') {
        throw new Error(
          'Current preload version does not support team:create. Restart the dev app.'
        );
      }
      const response = await unwrapIpc('team:create', () => api.teams.createTeam(request));

      saveLaunchParams(request.teamName, optimisticLaunchParams);
      set((state) => ({
        launchParamsByTeam: {
          ...state.launchParamsByTeam,
          [request.teamName]: optimisticLaunchParams,
        },
      }));

      set((state) => {
        const nextRuns = { ...state.provisioningRuns };
        const pendingRun = nextRuns[pendingRunId];
        const realProgressAlreadyExists = response.runId in nextRuns;
        if (pendingRun) {
          delete nextRuns[pendingRunId];
          // Only use pending data as fallback if real progress events haven't arrived yet.
          // This prevents overwriting real progress (e.g. 'assembling') with stale pending data ('spawning')
          // when the invoke response arrives before IPC progress events.
          if (!realProgressAlreadyExists) {
            nextRuns[response.runId] = { ...pendingRun, runId: response.runId };
          }
        }
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: {
            ...state.currentProvisioningRunIdByTeam,
            [request.teamName]: response.runId,
          },
          currentRuntimeRunIdByTeam: {
            ...state.currentRuntimeRunIdByTeam,
            [request.teamName]: response.runId,
          },
        };
      });
      try {
        await get().getProvisioningStatus(response.runId);
      } catch {
        // ignore — polling below will retry
      }
      void pollProvisioningStatus(get, response.runId);
      return response.runId;
    } catch (error) {
      const message =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to create team';
      set((state) => {
        const nextRuns = { ...state.provisioningRuns };
        delete nextRuns[pendingRunId];
        const nextCurrentRunIdByTeam = { ...state.currentProvisioningRunIdByTeam };
        if (nextCurrentRunIdByTeam[request.teamName] === pendingRunId) {
          delete nextCurrentRunIdByTeam[request.teamName];
        }
        const nextLaunchParamsByTeam = { ...state.launchParamsByTeam };
        if (
          areTeamLaunchParamsEqual(nextLaunchParamsByTeam[request.teamName], optimisticLaunchParams)
        ) {
          if (previousLaunchParams) {
            nextLaunchParamsByTeam[request.teamName] = previousLaunchParams;
          } else {
            delete nextLaunchParamsByTeam[request.teamName];
          }
        }
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
          launchParamsByTeam: nextLaunchParamsByTeam,
          provisioningErrorByTeam: {
            ...state.provisioningErrorByTeam,
            [request.teamName]: message,
          },
        };
      });
      throw error;
    }
  },

  launchTeam: async (request: TeamLaunchRequest) => {
    // Ensure provisioning progress subscription is active (defensive).
    get().subscribeProvisioningProgress();
    invalidateTeamLocalStateEpoch(request.teamName);
    clearPendingReplyRefreshTimer(request.teamName);
    clearPendingReplyRefreshWaits(request.teamName);
    clearTeamScopedTransientState(request.teamName);

    // Establish a per-team floor so late events from a previous run can't override UI.
    const floor = nowIso();
    set((state) => ({
      provisioningStartedAtFloorByTeam: {
        ...state.provisioningStartedAtFloorByTeam,
        [request.teamName]: floor,
      },
    }));

    // Clear stale provisioning runs for this team so the banner starts fresh
    set((state) => {
      const cleaned = { ...state.provisioningRuns };
      for (const [runId, run] of Object.entries(cleaned)) {
        if (run.teamName === request.teamName) {
          delete cleaned[runId];
        }
      }
      const nextErrors = { ...state.provisioningErrorByTeam };
      delete nextErrors[request.teamName];
      const nextSpawnStatuses = { ...state.memberSpawnStatusesByTeam };
      delete nextSpawnStatuses[request.teamName];
      const nextSpawnSnapshots = { ...state.memberSpawnSnapshotsByTeam };
      delete nextSpawnSnapshots[request.teamName];
      const nextRuntime = { ...state.teamAgentRuntimeByTeam };
      delete nextRuntime[request.teamName];
      const nextActiveTools = { ...state.activeToolsByTeam };
      delete nextActiveTools[request.teamName];
      const nextFinishedVisible = { ...state.finishedVisibleByTeam };
      delete nextFinishedVisible[request.teamName];
      const nextToolHistory = { ...state.toolHistoryByTeam };
      delete nextToolHistory[request.teamName];
      const nextRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
      const previousRuntimeRunId = nextRuntimeRunIdByTeam[request.teamName];
      delete nextRuntimeRunIdByTeam[request.teamName];
      const nextIgnoredRuntimeRunIds = previousRuntimeRunId
        ? {
            ...state.ignoredRuntimeRunIds,
            [previousRuntimeRunId]: request.teamName,
          }
        : state.ignoredRuntimeRunIds;
      const visibleLoadingResets = collectTeamScopedVisibleLoadingResets(state, request.teamName);
      return {
        provisioningRuns: cleaned,
        provisioningErrorByTeam: nextErrors,
        memberSpawnStatusesByTeam: nextSpawnStatuses,
        memberSpawnSnapshotsByTeam: nextSpawnSnapshots,
        teamAgentRuntimeByTeam: nextRuntime,
        activeToolsByTeam: nextActiveTools,
        finishedVisibleByTeam: nextFinishedVisible,
        toolHistoryByTeam: nextToolHistory,
        currentRuntimeRunIdByTeam: nextRuntimeRunIdByTeam,
        ignoredProvisioningRunIds: state.ignoredProvisioningRunIds,
        ignoredRuntimeRunIds: nextIgnoredRuntimeRunIds,
        ...visibleLoadingResets,
      };
    });

    // Optimistic progress entry: ensures banner shows even if IPC progress is delayed/missed.
    const pendingRunId = `pending:${request.teamName}:${Date.now()}`;
    set((state) => ({
      provisioningRuns: {
        ...state.provisioningRuns,
        [pendingRunId]: {
          runId: pendingRunId,
          teamName: request.teamName,
          state: 'spawning',
          message: 'Starting Claude CLI process...',
          startedAt: floor,
          updatedAt: floor,
        },
      },
      currentProvisioningRunIdByTeam: {
        ...state.currentProvisioningRunIdByTeam,
        [request.teamName]: pendingRunId,
      },
    }));
    const previousLaunchParams = get().launchParamsByTeam[request.teamName];
    const optimisticLaunchParams = buildLaunchParamsFromRuntimeRequest(
      request,
      previousLaunchParams
    );
    set((state) => ({
      launchParamsByTeam: {
        ...state.launchParamsByTeam,
        [request.teamName]: optimisticLaunchParams,
      },
    }));
    // Initialize per-team tool approval settings based on skipPermissions flag
    {
      const launchSettings: ToolApprovalSettings =
        request.skipPermissions === false
          ? DEFAULT_TOOL_APPROVAL_SETTINGS
          : { ...DEFAULT_TOOL_APPROVAL_SETTINGS, autoAllowAll: true };
      saveToolApprovalSettingsForTeam(request.teamName, launchSettings);
      set({ toolApprovalSettings: launchSettings });
    }
    try {
      const response = await unwrapIpc('team:launch', () => api.teams.launchTeam(request));

      saveLaunchParams(request.teamName, optimisticLaunchParams);
      set((state) => ({
        launchParamsByTeam: {
          ...state.launchParamsByTeam,
          [request.teamName]: optimisticLaunchParams,
        },
      }));

      set((state) => {
        const nextRuns = { ...state.provisioningRuns };
        const pendingRun = nextRuns[pendingRunId];
        const realProgressAlreadyExists = response.runId in nextRuns;
        if (pendingRun) {
          delete nextRuns[pendingRunId];
          // Only use pending data as fallback if real progress events haven't arrived yet.
          // This prevents overwriting real progress (e.g. 'assembling') with stale pending data ('spawning')
          // when the invoke response arrives before IPC progress events.
          if (!realProgressAlreadyExists) {
            nextRuns[response.runId] = { ...pendingRun, runId: response.runId };
          }
        }
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: {
            ...state.currentProvisioningRunIdByTeam,
            [request.teamName]: response.runId,
          },
          currentRuntimeRunIdByTeam: {
            ...state.currentRuntimeRunIdByTeam,
            [request.teamName]: response.runId,
          },
        };
      });
      try {
        await get().getProvisioningStatus(response.runId);
      } catch {
        // ignore — polling below will retry
      }
      void pollProvisioningStatus(get, response.runId);
      return response.runId;
    } catch (error) {
      const message =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to launch team';
      set((state) => {
        const nextRuns = { ...state.provisioningRuns };
        delete nextRuns[pendingRunId];
        const nextCurrentRunIdByTeam = { ...state.currentProvisioningRunIdByTeam };
        if (nextCurrentRunIdByTeam[request.teamName] === pendingRunId) {
          delete nextCurrentRunIdByTeam[request.teamName];
        }
        const nextLaunchParamsByTeam = { ...state.launchParamsByTeam };
        if (
          areTeamLaunchParamsEqual(nextLaunchParamsByTeam[request.teamName], optimisticLaunchParams)
        ) {
          if (previousLaunchParams) {
            nextLaunchParamsByTeam[request.teamName] = previousLaunchParams;
          } else {
            delete nextLaunchParamsByTeam[request.teamName];
          }
        }
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
          launchParamsByTeam: nextLaunchParamsByTeam,
          provisioningErrorByTeam: {
            ...state.provisioningErrorByTeam,
            [request.teamName]: message,
          },
        };
      });
      throw error;
    }
  },

  getProvisioningStatus: async (runId: string) => {
    const progress = await unwrapIpc('team:provisioningStatus', () =>
      api.teams.getProvisioningStatus(runId)
    );
    get().onProvisioningProgress(progress);
    return progress;
  },

  clearMissingProvisioningRun: (runId: string) => {
    set((state) => {
      const existing = state.provisioningRuns[runId];
      if (!existing) {
        return {};
      }

      const nextRuns = { ...state.provisioningRuns };
      delete nextRuns[runId];

      const nextCurrentRunIdByTeam = { ...state.currentProvisioningRunIdByTeam };
      const isCanonicalRun = nextCurrentRunIdByTeam[existing.teamName] === runId;
      if (isCanonicalRun) {
        delete nextCurrentRunIdByTeam[existing.teamName];
      }
      const nextRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
      if (nextRuntimeRunIdByTeam[existing.teamName] === runId) {
        delete nextRuntimeRunIdByTeam[existing.teamName];
      }
      const nextIgnoredRunIds = {
        ...state.ignoredProvisioningRunIds,
        [runId]: existing.teamName,
      };
      const nextIgnoredRuntimeRunIds =
        state.currentRuntimeRunIdByTeam[existing.teamName] === runId
          ? {
              ...state.ignoredRuntimeRunIds,
              [runId]: existing.teamName,
            }
          : state.ignoredRuntimeRunIds;

      const nextSpawnStatuses = { ...state.memberSpawnStatusesByTeam };
      const nextSpawnSnapshots = { ...state.memberSpawnSnapshotsByTeam };
      const nextRuntime = { ...state.teamAgentRuntimeByTeam };
      if (isCanonicalRun) {
        delete nextSpawnStatuses[existing.teamName];
        delete nextSpawnSnapshots[existing.teamName];
        delete nextRuntime[existing.teamName];
      }
      const nextActiveTools = { ...state.activeToolsByTeam };
      const nextFinishedVisible = { ...state.finishedVisibleByTeam };
      const nextToolHistory = { ...state.toolHistoryByTeam };
      if (isCanonicalRun) {
        delete nextActiveTools[existing.teamName];
        delete nextFinishedVisible[existing.teamName];
        delete nextToolHistory[existing.teamName];
      }

      return {
        provisioningRuns: nextRuns,
        currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
        currentRuntimeRunIdByTeam: nextRuntimeRunIdByTeam,
        memberSpawnStatusesByTeam: nextSpawnStatuses,
        memberSpawnSnapshotsByTeam: nextSpawnSnapshots,
        teamAgentRuntimeByTeam: nextRuntime,
        activeToolsByTeam: nextActiveTools,
        finishedVisibleByTeam: nextFinishedVisible,
        toolHistoryByTeam: nextToolHistory,
        ignoredProvisioningRunIds: nextIgnoredRunIds,
        ignoredRuntimeRunIds: nextIgnoredRuntimeRunIds,
      };
    });
  },

  cancelProvisioning: async (runId: string) => {
    await unwrapIpc('team:cancelProvisioning', () => api.teams.cancelProvisioning(runId));
  },

  onProvisioningProgress: (progress: TeamProvisioningProgress) => {
    if (get().ignoredProvisioningRunIds[progress.runId] === progress.teamName) {
      return;
    }
    if (get().ignoredRuntimeRunIds[progress.runId] === progress.teamName) {
      return;
    }

    const floor = get().provisioningStartedAtFloorByTeam[progress.teamName];
    if (floor && progress.startedAt < floor) {
      // Ignore late progress from a previous run (common after stop→launch).
      return;
    }

    const currentRunId = get().currentProvisioningRunIdByTeam[progress.teamName];
    const existingProgress = get().provisioningRuns[progress.runId];
    const becameConfigReady =
      progress.configReady === true && existingProgress?.configReady !== true;
    const isDuplicateProgress =
      existingProgress !== undefined &&
      provisioningProgressPayloadEqual(existingProgress, progress);
    if (isDuplicateProgress && currentRunId === progress.runId) {
      return;
    }
    if (
      existingProgress &&
      currentRunId === progress.runId &&
      shouldIgnoreProvisioningProgressRegression(existingProgress.state, progress.state)
    ) {
      return;
    }

    set((state) => {
      const nextRuns: Record<string, TeamProvisioningProgress> = {
        ...state.provisioningRuns,
      };
      const nextCurrentRunIdByTeam = { ...state.currentProvisioningRunIdByTeam };
      const previousCurrentRunId = nextCurrentRunIdByTeam[progress.teamName];
      let isCanonicalRun = false;
      if (!previousCurrentRunId || previousCurrentRunId === progress.runId) {
        nextCurrentRunIdByTeam[progress.teamName] = progress.runId;
        isCanonicalRun = true;
      } else if (
        isPendingProvisioningRunId(previousCurrentRunId) &&
        !isPendingProvisioningRunId(progress.runId)
      ) {
        delete nextRuns[previousCurrentRunId];
        nextCurrentRunIdByTeam[progress.teamName] = progress.runId;
        isCanonicalRun = true;
      }
      if (!previousCurrentRunId) {
        isCanonicalRun = true;
      }
      if (!isCanonicalRun) {
        if (!(progress.runId in state.provisioningRuns)) {
          return {};
        }
        delete nextRuns[progress.runId];
        return { provisioningRuns: nextRuns };
      }

      nextRuns[progress.runId] = progress;
      for (const [runId, run] of Object.entries(nextRuns)) {
        if (runId !== progress.runId && run.teamName === progress.teamName) {
          delete nextRuns[runId];
        }
      }

      const nextErrors = { ...state.provisioningErrorByTeam };
      if (progress.state === 'failed') {
        nextErrors[progress.teamName] = progress.error ?? progress.message;
      } else {
        delete nextErrors[progress.teamName];
      }
      // Clean up provisioning snapshot on terminal failure states
      const nextSnapshots =
        progress.state === 'failed' || progress.state === 'cancelled'
          ? (() => {
              const s = { ...state.provisioningSnapshotByTeam };
              delete s[progress.teamName];
              return s;
            })()
          : state.provisioningSnapshotByTeam;
      return {
        provisioningRuns: nextRuns,
        currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
        currentRuntimeRunIdByTeam: {
          ...state.currentRuntimeRunIdByTeam,
          [progress.teamName]: progress.runId,
        },
        provisioningErrorByTeam: nextErrors,
        provisioningSnapshotByTeam: nextSnapshots,
      };
    });

    const isCanonicalRun =
      get().currentProvisioningRunIdByTeam[progress.teamName] === progress.runId;
    let hydratedVisibleTeam = false;

    if (isCanonicalRun && becameConfigReady) {
      const state = get();
      if (isVisibleInActiveTeamSurface(state, progress.teamName)) {
        const willSelectTeam =
          state.selectedTeamName === progress.teamName && state.selectedTeamData == null;
        noteTeamRefreshFanout({
          teamName: progress.teamName,
          surface: 'provisioning-progress',
          phase: 'scheduled',
          reason: 'provisioning:config-ready',
          operation: willSelectTeam ? 'selectTeam' : 'refreshTeamData',
          selected: state.selectedTeamName === progress.teamName,
          visible: true,
        });
        if (state.selectedTeamName === progress.teamName && state.selectedTeamData == null) {
          void state.selectTeam(progress.teamName, { allowReloadWhileProvisioning: true });
        } else {
          void state.refreshTeamData(progress.teamName, { withDedup: true });
        }
        hydratedVisibleTeam = true;
      }
    }

    if (isCanonicalRun && isTerminalProvisioningState(progress.state)) {
      set((prev) => {
        const next = { ...prev.memberSpawnStatusesByTeam };
        const nextSnapshots = { ...prev.memberSpawnSnapshotsByTeam };
        const nextRuntime = { ...prev.teamAgentRuntimeByTeam };
        const currentStatuses = next[progress.teamName];
        if (!currentStatuses) {
          if (progress.state !== 'ready') {
            delete nextRuntime[progress.teamName];
          }
          return {
            memberSpawnStatusesByTeam: next,
            memberSpawnSnapshotsByTeam: nextSnapshots,
            teamAgentRuntimeByTeam: nextRuntime,
          };
        }
        if (progress.state === 'ready') {
          next[progress.teamName] = currentStatuses;
          return {
            memberSpawnStatusesByTeam: next,
            memberSpawnSnapshotsByTeam: nextSnapshots,
            teamAgentRuntimeByTeam: nextRuntime,
          };
        }
        const retainedStatuses = Object.fromEntries(
          Object.entries(currentStatuses).filter(([, entry]) => entry.status === 'error')
        );
        if (Object.keys(retainedStatuses).length > 0) {
          next[progress.teamName] = retainedStatuses;
        } else {
          delete next[progress.teamName];
          delete nextSnapshots[progress.teamName];
        }
        delete nextRuntime[progress.teamName];
        return {
          memberSpawnStatusesByTeam: next,
          memberSpawnSnapshotsByTeam: nextSnapshots,
          teamAgentRuntimeByTeam: nextRuntime,
        };
      });
    }

    if (isCanonicalRun && (progress.state === 'ready' || progress.state === 'disconnected')) {
      const terminalReason =
        progress.state === 'ready'
          ? 'provisioning:terminal-ready'
          : 'provisioning:terminal-disconnected';
      noteTeamRefreshFanout({
        teamName: progress.teamName,
        surface: 'provisioning-progress',
        phase: 'scheduled',
        reason: terminalReason,
        operation: 'fetchTeams',
      });
      void get().fetchTeams();
      const terminalRefreshState = get();
      if (isVisibleInActiveTeamSurface(terminalRefreshState, progress.teamName)) {
        noteTeamRefreshFanout({
          teamName: progress.teamName,
          surface: 'provisioning-progress',
          phase: 'scheduled',
          reason: terminalReason,
          operation: 'fetchMemberSpawnStatuses',
          visible: true,
        });
        void terminalRefreshState.fetchMemberSpawnStatuses(progress.teamName);
        noteTeamRefreshFanout({
          teamName: progress.teamName,
          surface: 'provisioning-progress',
          phase: 'scheduled',
          reason: terminalReason,
          operation: 'fetchTeamAgentRuntime',
          visible: true,
        });
        void terminalRefreshState.fetchTeamAgentRuntime(progress.teamName);
      }
      if (hydratedVisibleTeam) {
        noteTeamRefreshFanout({
          teamName: progress.teamName,
          surface: 'provisioning-progress',
          phase: 'skipped',
          reason: 'provisioning:already-hydrated-visible-team',
          operation: 'refreshTeamData',
          visible: true,
        });
        return;
      }

      const state = get();
      if (!isVisibleInActiveTeamSurface(state, progress.teamName)) {
        return;
      }

      // If the user already opened the team tab, reload team data now that
      // config.json is guaranteed to exist.
      noteTeamRefreshFanout({
        teamName: progress.teamName,
        surface: 'provisioning-progress',
        phase: 'scheduled',
        reason: terminalReason,
        operation: state.selectedTeamName === progress.teamName ? 'selectTeam' : 'refreshTeamData',
        selected: state.selectedTeamName === progress.teamName,
        visible: true,
      });
      if (state.selectedTeamName === progress.teamName) {
        void state.selectTeam(progress.teamName);
      } else {
        void state.refreshTeamData(progress.teamName, { withDedup: true });
      }
    }
  },

  subscribeProvisioningProgress: () => {
    const existing = get().provisioningProgressUnsubscribe;
    if (existing) {
      return;
    }
    if (!api.teams?.onProvisioningProgress) {
      return;
    }
    const unsubscribe = api.teams.onProvisioningProgress((_event, progress) => {
      get().onProvisioningProgress(progress);
    });
    set({ provisioningProgressUnsubscribe: unsubscribe });
  },

  updateToolApprovalSettings: async (patch, forTeam) => {
    const teamName = forTeam ?? get().selectedTeamName;
    const current = get().toolApprovalSettings;
    const merged = { ...current, ...patch };
    set({ toolApprovalSettings: merged });
    // Save per-team if a team is selected, otherwise global fallback
    if (teamName) {
      saveToolApprovalSettingsForTeam(teamName, merged);
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

  unsubscribeProvisioningProgress: () => {
    const unsubscribe = get().provisioningProgressUnsubscribe;
    if (unsubscribe) {
      unsubscribe();
      set({ provisioningProgressUnsubscribe: null });
    }
  },
});
