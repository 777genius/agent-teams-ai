import { api } from '@renderer/api';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { normalizePath } from '@renderer/utils/pathNormalize';
import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
  canDisplayTaskChangesForOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { toMessageKey } from '@renderer/utils/teamMessageKey';
import { extractProviderScopedBaseModel } from '@renderer/utils/teamModelContext';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';
import { stripAgentBlocks } from '@shared/constants/agentBlocks';
import { DEFAULT_TOOL_APPROVAL_SETTINGS } from '@shared/types/team';
import { isLeadMember } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { getTaskKanbanColumn } from '@shared/utils/reviewState';
import { formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import { buildTeamGraphDefaultLayoutSeed } from '@shared/utils/teamGraphDefaultLayout';
import { getStableTeamOwnerId } from '@shared/utils/teamStableOwnerId';

import { getWorktreeNavigationState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { GraphOwnerSlotAssignment } from '@claude-teams/agent-graph';
import type { AppConfig } from '@renderer/types/data';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type {
  ActiveToolCall,
  AddMemberRequest,
  AddTaskCommentRequest,
  CreateTaskRequest,
  CrossTeamSendRequest,
  EffortLevel,
  GlobalTask,
  InboxMessage,
  KanbanColumnId,
  LeadActivityState,
  LeadContextUsage,
  MemberActivityMetaEntry,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSummary,
  ResolvedTeamMember,
  SendMessageRequest,
  SendMessageResult,
  TaskChangePresenceState,
  TaskComment,
  TeamAgentRuntimeEntry,
  TeamAgentRuntimeSnapshot,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamMemberActivityMeta,
  TeamMemberSnapshot,
  TeamProviderId,
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

const GRAPH_STABLE_SLOT_LAYOUT_VERSION = 'stable-slots-v1' as const;
const DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS = true;
const logger = createLogger('teamSlice');

const TEAM_GET_DATA_TIMEOUT_MS = 30_000;
const TEAM_FETCH_TIMEOUT_MS = 30_000;
const MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS = 5_000;
const TEAM_DATA_IPC_WARN_MS = 350;
const TEAM_DATA_SET_WARN_MS = 12;
const TEAM_DATA_POST_WARN_MS = 24;
const TEAM_DATA_LARGE_MESSAGES = 150;
const TEAM_DATA_LARGE_TASKS = 80;
const TEAM_REFRESH_BURST_WINDOW_MS = 4_000;
const TEAM_REFRESH_BURST_WARN_COUNT = 5;
const TEAM_REFRESH_WARN_THROTTLE_MS = 2_000;
const MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS = 2_000;
const inFlightTeamDataRequests = new Map<string, Promise<TeamViewSnapshot>>();
const inFlightRefreshTeamDataCalls = new Map<string, Set<symbol>>();
const pendingFreshTeamDataRefreshes = new Set<string>();
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
const activeTeamPendingReplyWaitSourceIdsByTeam = new Map<string, Set<string>>();
const lastResolvedTeamDataRefreshAtByTeam = new Map<string, number>();
const teamLocalStateEpochByTeam = new Map<string, number>();
let inFlightGlobalTasksRefresh: Promise<void> | null = null;
let pendingFreshGlobalTasksRefresh = false;
const memberSpawnStatusesIpcBackoffUntilByTeam = new Map<string, number>();
const teamRefreshBurstDiagnostics = new Map<
  string,
  { windowStartedAt: number; count: number; lastWarnAt: number }
>();
const memberSpawnUiEqualLastWarnAtByTeam = new Map<string, number>();
interface RefreshTeamDataOptions {
  withDedup?: boolean;
}

type TeamGraphSlotAssignments = Record<string, GraphOwnerSlotAssignment>;
type TeamGraphMemberSeedInput = Pick<TeamMemberSnapshot, 'name' | 'agentId' | 'removedAt'>;
type TeamGraphConfigMemberSeedInput = Pick<
  NonNullable<TeamViewSnapshot['config']['members']>[number],
  'name' | 'agentId' | 'removedAt'
>;
interface TeamGraphLayoutSessionState {
  mode: 'default' | 'manual';
  signature: string | null;
}

export function isTeamDataRefreshPending(teamName: string): boolean {
  return (
    inFlightTeamDataRequests.has(teamName) ||
    (inFlightRefreshTeamDataCalls.get(teamName)?.size ?? 0) > 0 ||
    pendingFreshTeamDataRefreshes.has(teamName)
  );
}

export function getLastResolvedTeamDataRefreshAt(teamName: string): number | undefined {
  return lastResolvedTeamDataRefreshAtByTeam.get(teamName);
}

export function hasActiveTeamPendingReplyWait(teamName: string): boolean {
  return (activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName)?.size ?? 0) > 0;
}

export function getActiveTeamPendingReplyWaits(): Set<string> {
  return new Set(
    Array.from(activeTeamPendingReplyWaitSourceIdsByTeam.entries())
      .filter(([, sourceIds]) => sourceIds.size > 0)
      .map(([teamName]) => teamName)
  );
}

export function __resetTeamSliceModuleStateForTests(): void {
  inFlightTeamDataRequests.clear();
  inFlightRefreshTeamDataCalls.clear();
  pendingFreshTeamDataRefreshes.clear();
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
  activeTeamPendingReplyWaitSourceIdsByTeam.clear();
  lastResolvedTeamDataRefreshAtByTeam.clear();
  teamLocalStateEpochByTeam.clear();
  memberSpawnStatusesIpcBackoffUntilByTeam.clear();
  teamRefreshBurstDiagnostics.clear();
  memberSpawnUiEqualLastWarnAtByTeam.clear();
  resolvedMembersSelectorCache.clear();
  resolvedMemberSelectorCache.clear();
  mergedMessagesSelectorCache.clear();
  memberMessagesSelectorCache.clear();
}

function clearTeamScopedSelectorCaches(teamName: string): void {
  resolvedMembersSelectorCache.delete(teamName);
  mergedMessagesSelectorCache.delete(teamName);

  const teamScopedPrefix = `${teamName}:`;
  for (const key of resolvedMemberSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      resolvedMemberSelectorCache.delete(key);
    }
  }
  for (const key of memberMessagesSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      memberMessagesSelectorCache.delete(key);
    }
  }
}

function clearTeamScopedTransientState(teamName: string): void {
  inFlightTeamDataRequests.delete(teamName);
  inFlightRefreshTeamDataCalls.delete(teamName);
  pendingFreshTeamDataRefreshes.delete(teamName);
  inFlightTeamMessagesHeadRequests.delete(teamName);
  inFlightTeamMessagesOlderRequests.delete(teamName);
  queuedTeamMessagesHeadRefreshesAfterOlder.delete(teamName);
  pendingFreshTeamMessagesHeadRefreshes.delete(teamName);
  inFlightTeamMemberActivityMetaRequests.delete(teamName);
  pendingFreshTeamMemberActivityMetaRefreshes.delete(teamName);
  lastResolvedTeamDataRefreshAtByTeam.delete(teamName);
  memberSpawnStatusesIpcBackoffUntilByTeam.delete(teamName);
  teamRefreshBurstDiagnostics.delete(teamName);
  memberSpawnUiEqualLastWarnAtByTeam.delete(teamName);
  clearTeamScopedSelectorCaches(teamName);
}

function collectTeamScopedVisibleLoadingResets(
  state: Pick<
    TeamSlice,
    'teamMessagesByName' | 'selectedTeamName' | 'selectedTeamLoading' | 'selectedTeamError'
  >,
  teamName: string
): Partial<TeamSlice> {
  const nextTeamMessagesEntry = state.teamMessagesByName[teamName];
  const nextTeamMessagesByName =
    nextTeamMessagesEntry &&
    (nextTeamMessagesEntry.loadingHead || nextTeamMessagesEntry.loadingOlder)
      ? {
          ...state.teamMessagesByName,
          [teamName]: {
            ...nextTeamMessagesEntry,
            loadingHead: false,
            loadingOlder: false,
          },
        }
      : null;

  const shouldResetSelectedSurface =
    state.selectedTeamName === teamName &&
    (state.selectedTeamLoading || state.selectedTeamError != null);

  return {
    ...(nextTeamMessagesByName ? { teamMessagesByName: nextTeamMessagesByName } : {}),
    ...(shouldResetSelectedSurface
      ? {
          selectedTeamLoading: false,
          selectedTeamError: null,
        }
      : {}),
  };
}

function omitTeamKey<T>(record: Record<string, T>, teamName: string): Record<string, T> | null {
  if (!(teamName in record)) {
    return null;
  }
  const next = { ...record };
  delete next[teamName];
  return next;
}

function collectTeamScopedStateRemovals(
  state: Pick<
    TeamSlice,
    | 'provisioningRuns'
    | 'teamDataCacheByName'
    | 'teamAgentRuntimeByTeam'
    | 'teamMessagesByName'
    | 'memberActivityMetaByTeam'
    | 'provisioningSnapshotByTeam'
    | 'currentProvisioningRunIdByTeam'
    | 'currentRuntimeRunIdByTeam'
    | 'provisioningStartedAtFloorByTeam'
    | 'leadActivityByTeam'
    | 'leadContextByTeam'
    | 'activeToolsByTeam'
    | 'finishedVisibleByTeam'
    | 'toolHistoryByTeam'
    | 'memberSpawnStatusesByTeam'
    | 'memberSpawnSnapshotsByTeam'
    | 'provisioningErrorByTeam'
  >,
  teamName: string
): Partial<TeamSlice> {
  const nextProvisioningRuns = Object.fromEntries(
    Object.entries(state.provisioningRuns).filter(([, run]) => run.teamName !== teamName)
  ) as Record<string, TeamProvisioningProgress>;
  const nextTeamDataCache = omitTeamKey(state.teamDataCacheByName, teamName);
  const nextTeamAgentRuntime = omitTeamKey(state.teamAgentRuntimeByTeam, teamName);
  const nextTeamMessages = omitTeamKey(state.teamMessagesByName, teamName);
  const nextMemberActivityMeta = omitTeamKey(state.memberActivityMetaByTeam, teamName);
  const nextProvisioningSnapshot = omitTeamKey(state.provisioningSnapshotByTeam, teamName);
  const nextCurrentProvisioningRunId = omitTeamKey(state.currentProvisioningRunIdByTeam, teamName);
  const nextCurrentRuntimeRunId = omitTeamKey(state.currentRuntimeRunIdByTeam, teamName);
  const nextProvisioningStartedAtFloor = omitTeamKey(
    state.provisioningStartedAtFloorByTeam,
    teamName
  );
  const nextLeadActivity = omitTeamKey(state.leadActivityByTeam, teamName);
  const nextLeadContext = omitTeamKey(state.leadContextByTeam, teamName);
  const nextActiveTools = omitTeamKey(state.activeToolsByTeam, teamName);
  const nextFinishedVisible = omitTeamKey(state.finishedVisibleByTeam, teamName);
  const nextToolHistory = omitTeamKey(state.toolHistoryByTeam, teamName);
  const nextMemberSpawnStatuses = omitTeamKey(state.memberSpawnStatusesByTeam, teamName);
  const nextMemberSpawnSnapshots = omitTeamKey(state.memberSpawnSnapshotsByTeam, teamName);
  const nextProvisioningErrors = omitTeamKey(state.provisioningErrorByTeam, teamName);

  return {
    ...(Object.keys(nextProvisioningRuns).length !== Object.keys(state.provisioningRuns).length
      ? { provisioningRuns: nextProvisioningRuns }
      : {}),
    ...(nextTeamDataCache ? { teamDataCacheByName: nextTeamDataCache } : {}),
    ...(nextTeamAgentRuntime ? { teamAgentRuntimeByTeam: nextTeamAgentRuntime } : {}),
    ...(nextTeamMessages ? { teamMessagesByName: nextTeamMessages } : {}),
    ...(nextMemberActivityMeta ? { memberActivityMetaByTeam: nextMemberActivityMeta } : {}),
    ...(nextProvisioningSnapshot ? { provisioningSnapshotByTeam: nextProvisioningSnapshot } : {}),
    ...(nextCurrentProvisioningRunId
      ? { currentProvisioningRunIdByTeam: nextCurrentProvisioningRunId }
      : {}),
    ...(nextCurrentRuntimeRunId ? { currentRuntimeRunIdByTeam: nextCurrentRuntimeRunId } : {}),
    ...(nextProvisioningStartedAtFloor
      ? { provisioningStartedAtFloorByTeam: nextProvisioningStartedAtFloor }
      : {}),
    ...(nextLeadActivity ? { leadActivityByTeam: nextLeadActivity } : {}),
    ...(nextLeadContext ? { leadContextByTeam: nextLeadContext } : {}),
    ...(nextActiveTools ? { activeToolsByTeam: nextActiveTools } : {}),
    ...(nextFinishedVisible ? { finishedVisibleByTeam: nextFinishedVisible } : {}),
    ...(nextToolHistory ? { toolHistoryByTeam: nextToolHistory } : {}),
    ...(nextMemberSpawnStatuses ? { memberSpawnStatusesByTeam: nextMemberSpawnStatuses } : {}),
    ...(nextMemberSpawnSnapshots ? { memberSpawnSnapshotsByTeam: nextMemberSpawnSnapshots } : {}),
    ...(nextProvisioningErrors ? { provisioningErrorByTeam: nextProvisioningErrors } : {}),
  };
}

function buildTeamScopedProgressTombstones(
  state: Pick<
    TeamSlice,
    | 'currentProvisioningRunIdByTeam'
    | 'currentRuntimeRunIdByTeam'
    | 'ignoredProvisioningRunIds'
    | 'ignoredRuntimeRunIds'
    | 'provisioningStartedAtFloorByTeam'
  >,
  teamName: string,
  floor: string
): Pick<
  TeamSlice,
  'ignoredProvisioningRunIds' | 'ignoredRuntimeRunIds' | 'provisioningStartedAtFloorByTeam'
> {
  const nextIgnoredProvisioningRunIds = { ...state.ignoredProvisioningRunIds };
  const nextIgnoredRuntimeRunIds = { ...state.ignoredRuntimeRunIds };

  const currentProvisioningRunId = state.currentProvisioningRunIdByTeam[teamName];
  const currentRuntimeRunId = state.currentRuntimeRunIdByTeam[teamName];
  if (currentProvisioningRunId) {
    nextIgnoredProvisioningRunIds[currentProvisioningRunId] = teamName;
  }
  if (currentRuntimeRunId) {
    nextIgnoredRuntimeRunIds[currentRuntimeRunId] = teamName;
  }

  return {
    ignoredProvisioningRunIds: nextIgnoredProvisioningRunIds,
    ignoredRuntimeRunIds: nextIgnoredRuntimeRunIds,
    provisioningStartedAtFloorByTeam: {
      ...state.provisioningStartedAtFloorByTeam,
      [teamName]: floor,
    },
  };
}

function captureTeamLocalStateEpoch(teamName: string): number {
  return teamLocalStateEpochByTeam.get(teamName) ?? 0;
}

function isTeamLocalStateEpochCurrent(teamName: string, epoch: number): boolean {
  return captureTeamLocalStateEpoch(teamName) === epoch;
}

function invalidateTeamLocalStateEpoch(teamName: string): void {
  teamLocalStateEpochByTeam.set(teamName, captureTeamLocalStateEpoch(teamName) + 1);
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

export function __getTeamScopedTransientStateForTests(teamName: string): {
  hasResolvedMembersSelector: boolean;
  resolvedMemberSelectorCount: number;
  hasMergedMessagesSelector: boolean;
  memberMessagesSelectorCount: number;
  hasPendingFreshTeamDataRefresh: boolean;
  hasQueuedHeadRefreshAfterOlder: boolean;
  hasPendingFreshMessagesHeadRefresh: boolean;
  hasPendingFreshMemberActivityMetaRefresh: boolean;
  hasLastResolvedTeamDataRefresh: boolean;
  hasCurrentLocalStateEpoch: boolean;
  hasMemberSpawnStatusesIpcBackoff: boolean;
  hasTeamRefreshBurstDiagnostics: boolean;
  hasMemberSpawnUiEqualLastWarn: boolean;
} {
  const teamScopedPrefix = `${teamName}:`;
  let resolvedMemberSelectorCount = 0;
  let memberMessagesSelectorCount = 0;

  for (const key of resolvedMemberSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      resolvedMemberSelectorCount += 1;
    }
  }
  for (const key of memberMessagesSelectorCache.keys()) {
    if (key.startsWith(teamScopedPrefix)) {
      memberMessagesSelectorCount += 1;
    }
  }

  return {
    hasResolvedMembersSelector: resolvedMembersSelectorCache.has(teamName),
    resolvedMemberSelectorCount,
    hasMergedMessagesSelector: mergedMessagesSelectorCache.has(teamName),
    memberMessagesSelectorCount,
    hasPendingFreshTeamDataRefresh: pendingFreshTeamDataRefreshes.has(teamName),
    hasQueuedHeadRefreshAfterOlder: queuedTeamMessagesHeadRefreshesAfterOlder.has(teamName),
    hasPendingFreshMessagesHeadRefresh: pendingFreshTeamMessagesHeadRefreshes.has(teamName),
    hasPendingFreshMemberActivityMetaRefresh:
      pendingFreshTeamMemberActivityMetaRefreshes.has(teamName),
    hasLastResolvedTeamDataRefresh: lastResolvedTeamDataRefreshAtByTeam.has(teamName),
    hasCurrentLocalStateEpoch: teamLocalStateEpochByTeam.has(teamName),
    hasMemberSpawnStatusesIpcBackoff: memberSpawnStatusesIpcBackoffUntilByTeam.has(teamName),
    hasTeamRefreshBurstDiagnostics: teamRefreshBurstDiagnostics.has(teamName),
    hasMemberSpawnUiEqualLastWarn: memberSpawnUiEqualLastWarnAtByTeam.has(teamName),
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value == null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function structurallySharePlainValue<T>(previous: T, next: T): T {
  if (Object.is(previous, next)) {
    return previous;
  }

  if (Array.isArray(previous) && Array.isArray(next)) {
    let changed = previous.length !== next.length;
    const result = next.map((nextItem, index) => {
      const sharedItem = structurallySharePlainValue(previous[index], nextItem);
      if (!Object.is(sharedItem, previous[index])) {
        changed = true;
      }
      return sharedItem;
    });
    return changed ? (result as T) : previous;
  }

  if (isPlainObject(previous) && isPlainObject(next)) {
    const previousRecord = previous as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const previousKeys = Object.keys(previousRecord);
    const nextKeys = Object.keys(nextRecord);
    let changed = previousKeys.length !== nextKeys.length;
    const result: Record<string, unknown> = {};

    for (const key of nextKeys) {
      if (!Object.prototype.hasOwnProperty.call(previousRecord, key)) {
        changed = true;
      }
      const sharedValue = structurallySharePlainValue(previousRecord[key], nextRecord[key]);
      if (!Object.is(sharedValue, previousRecord[key])) {
        changed = true;
      }
      result[key] = sharedValue;
    }

    return changed ? (result as T) : previous;
  }

  return next;
}

function structurallyShareTeamSnapshot(
  previous: TeamViewSnapshot | null | undefined,
  next: TeamViewSnapshot
): TeamViewSnapshot {
  if (!previous) {
    return next;
  }
  return structurallySharePlainValue(previous, next);
}

const ACTIVE_PROVISIONING_STATES = new Set([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);
const TERMINAL_PROVISIONING_STATES = new Set(['ready', 'failed', 'disconnected', 'cancelled']);

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

function fetchTeamDataDeduped(teamName: string): Promise<TeamViewSnapshot> {
  const existing = inFlightTeamDataRequests.get(teamName);
  if (existing) {
    return existing;
  }

  const request = withTimeout(
    unwrapIpc('team:getData', () => api.teams.getData(teamName)),
    TEAM_GET_DATA_TIMEOUT_MS,
    `team:getData(${teamName})`
  ).finally(() => {
    if (inFlightTeamDataRequests.get(teamName) === request) {
      inFlightTeamDataRequests.delete(teamName);
    }
  });

  inFlightTeamDataRequests.set(teamName, request);
  return request;
}

function fetchTeamDataFresh(teamName: string): Promise<TeamViewSnapshot> {
  return withTimeout(
    unwrapIpc('team:getData', () => api.teams.getData(teamName)),
    TEAM_GET_DATA_TIMEOUT_MS,
    `team:getData(${teamName})`
  );
}

function summarizeTeamDataCounts(data: TeamViewSnapshot | null | undefined): {
  tasks: number;
  members: number;
  activeMembers: number;
  processes: number;
} {
  if (!data) {
    return { tasks: 0, members: 0, activeMembers: 0, processes: 0 };
  }

  return {
    tasks: data.tasks.length,
    members: data.members.length,
    activeMembers: data.members.filter((member) => !member.removedAt).length,
    processes: data.processes.length,
  };
}

function estimateTeamPayloadWeight(data: TeamViewSnapshot): {
  taskComments: number;
  taskHistoryEvents: number;
  taskDescriptionChars: number;
} {
  let taskComments = 0;
  let taskHistoryEvents = 0;
  let taskDescriptionChars = 0;
  for (const task of data.tasks) {
    taskComments += task.comments?.length ?? 0;
    taskHistoryEvents += task.historyEvents?.length ?? 0;
    taskDescriptionChars += task.description?.length ?? 0;
  }

  return {
    taskComments,
    taskHistoryEvents,
    taskDescriptionChars,
  };
}

function noteTeamRefreshBurst(teamName: string): number {
  const now = Date.now();
  const diagnostic = teamRefreshBurstDiagnostics.get(teamName) ?? {
    windowStartedAt: now,
    count: 0,
    lastWarnAt: 0,
  };

  if (now - diagnostic.windowStartedAt > TEAM_REFRESH_BURST_WINDOW_MS) {
    diagnostic.windowStartedAt = now;
    diagnostic.count = 0;
  }

  diagnostic.count += 1;

  if (
    diagnostic.count >= TEAM_REFRESH_BURST_WARN_COUNT &&
    now - diagnostic.lastWarnAt >= TEAM_REFRESH_WARN_THROTTLE_MS
  ) {
    diagnostic.lastWarnAt = now;
    logger.warn(
      `[perf] refreshTeamData burst team=${teamName} count=${diagnostic.count} windowMs=${
        now - diagnostic.windowStartedAt
      }`
    );
  }

  teamRefreshBurstDiagnostics.set(teamName, diagnostic);
  return diagnostic.count;
}

function maybeLogTeamDataPerf(params: {
  phase: 'selectTeam' | 'refreshTeamData';
  teamName: string;
  ipcMs: number;
  setMs: number;
  postMs: number;
  totalMs: number;
  previousData: TeamViewSnapshot | null | undefined;
  nextData: TeamViewSnapshot;
  deduped: boolean;
  reusedInFlightRequest: boolean;
  burstCount?: number;
}): void {
  const {
    phase,
    teamName,
    ipcMs,
    setMs,
    postMs,
    totalMs,
    previousData,
    nextData,
    deduped,
    reusedInFlightRequest,
    burstCount,
  } = params;

  const nextCounts = summarizeTeamDataCounts(nextData);
  const previousCounts = summarizeTeamDataCounts(previousData);
  const largePayload = nextCounts.tasks >= TEAM_DATA_LARGE_TASKS;
  const slow =
    ipcMs >= TEAM_DATA_IPC_WARN_MS ||
    setMs >= TEAM_DATA_SET_WARN_MS ||
    postMs >= TEAM_DATA_POST_WARN_MS;

  if (!slow && !largePayload && !reusedInFlightRequest) {
    return;
  }

  const payloadWeight = estimateTeamPayloadWeight(nextData);
  logger.warn(
    `[perf] ${phase} team=${teamName} ipc=${ipcMs.toFixed(1)}ms set=${setMs.toFixed(
      1
    )}ms post=${postMs.toFixed(1)}ms total=${totalMs.toFixed(1)}ms deduped=${deduped} reusedInFlight=${
      reusedInFlightRequest ? 'yes' : 'no'
    } burst=${burstCount ?? 1} counts=tasks:${previousCounts.tasks}->${nextCounts.tasks},members:${
      previousCounts.members
    }->${nextCounts.members},activeMembers:${
      previousCounts.activeMembers
    }->${nextCounts.activeMembers},processes:${previousCounts.processes}->${nextCounts.processes} payload=textChars:${
      payloadWeight.taskDescriptionChars
    },taskComments=${payloadWeight.taskComments},historyEvents=${payloadWeight.taskHistoryEvents}`
  );
}

function areLaunchSummaryCountsEqual(
  left: PersistedTeamLaunchSummary | undefined,
  right: PersistedTeamLaunchSummary | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.confirmedCount === right.confirmedCount &&
    left.pendingCount === right.pendingCount &&
    left.failedCount === right.failedCount &&
    left.runtimeAlivePendingCount === right.runtimeAlivePendingCount
  );
}

function areExpectedMembersEqual(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

function areMemberSpawnStatusEntriesEqual(
  left: MemberSpawnStatusEntry | undefined,
  right: MemberSpawnStatusEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  // Renderer equality intentionally ignores raw timing fields that do not change
  // visible member status. This suppresses heartbeat-only churn in TeamDetailView.
  return (
    left.status === right.status &&
    left.launchState === right.launchState &&
    left.error === right.error &&
    left.livenessSource === right.livenessSource &&
    left.runtimeAlive === right.runtimeAlive &&
    left.runtimeModel === right.runtimeModel &&
    left.bootstrapConfirmed === right.bootstrapConfirmed &&
    left.hardFailure === right.hardFailure
  );
}

function areMemberSpawnStatusesEqual(
  left: Record<string, MemberSpawnStatusEntry>,
  right: Record<string, MemberSpawnStatusEntry>
): boolean {
  if (left === right) return true;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!(key in right)) {
      return false;
    }
    if (!areMemberSpawnStatusEntriesEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function areMemberSpawnSnapshotsSemanticallyEqual(
  left: MemberSpawnStatusesSnapshot | undefined,
  right: MemberSpawnStatusesSnapshot
): boolean {
  if (!left) return false;
  return (
    left.runId === right.runId &&
    left.teamLaunchState === right.teamLaunchState &&
    left.launchPhase === right.launchPhase &&
    left.source === right.source &&
    areExpectedMembersEqual(left.expectedMembers, right.expectedMembers) &&
    areLaunchSummaryCountsEqual(left.summary, right.summary) &&
    areMemberSpawnStatusesEqual(left.statuses, right.statuses)
  );
}

function maybeLogMemberSpawnUiEqualSuppressed(
  teamName: string,
  runId: string | null | undefined
): void {
  const now = Date.now();
  const lastWarnAt = memberSpawnUiEqualLastWarnAtByTeam.get(teamName) ?? 0;
  if (now - lastWarnAt < MEMBER_SPAWN_UI_EQUAL_WARN_THROTTLE_MS) {
    return;
  }
  memberSpawnUiEqualLastWarnAtByTeam.set(teamName, now);
  logger.debug(
    `[perf] member-spawn snapshot suppressed team=${teamName} runId=${runId ?? 'none'} reason=member-spawn-ui-equal`
  );
}

function areTeamAgentRuntimeEntriesEqual(
  left: TeamAgentRuntimeEntry | undefined,
  right: TeamAgentRuntimeEntry | undefined
): boolean {
  if (left === right) return true;
  if (!left || !right) return left === right;
  return (
    left.memberName === right.memberName &&
    left.alive === right.alive &&
    left.restartable === right.restartable &&
    left.backendType === right.backendType &&
    left.pid === right.pid &&
    left.runtimeModel === right.runtimeModel &&
    left.rssBytes === right.rssBytes
  );
}

function areTeamAgentRuntimeSnapshotsEqual(
  left: TeamAgentRuntimeSnapshot | undefined,
  right: TeamAgentRuntimeSnapshot
): boolean {
  if (!left) return false;
  if (left.teamName !== right.teamName || left.runId !== right.runId) {
    return false;
  }
  const leftKeys = Object.keys(left.members);
  const rightKeys = Object.keys(right.members);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  for (const key of leftKeys) {
    if (!(key in right.members)) {
      return false;
    }
    if (!areTeamAgentRuntimeEntriesEqual(left.members[key], right.members[key])) {
      return false;
    }
  }
  return true;
}

function compareInboxMessagesByTimestamp(a: InboxMessage, b: InboxMessage): number {
  const aTime = Date.parse(a.timestamp);
  const bTime = Date.parse(b.timestamp);
  const aValid = Number.isFinite(aTime);
  const bValid = Number.isFinite(bTime);
  if (aValid && bValid && aTime !== bTime) {
    return aTime - bTime;
  }
  if (aValid !== bValid) {
    return aValid ? -1 : 1;
  }
  const aId = typeof a.messageId === 'string' ? a.messageId : '';
  const bId = typeof b.messageId === 'string' ? b.messageId : '';
  return aId.localeCompare(bId);
}

export interface TeamMessagesCacheEntry {
  canonicalMessages: InboxMessage[];
  optimisticMessages: InboxMessage[];
  feedRevision: string | null;
  nextCursor: string | null;
  hasMore: boolean;
  lastFetchedAt: number | null;
  loadingHead: boolean;
  loadingOlder: boolean;
  headHydrated: boolean;
}

export interface RefreshTeamMessagesHeadResult {
  feedChanged: boolean;
  headChanged: boolean;
  feedRevision: string | null;
}

const EMPTY_TEAM_MESSAGES_CACHE_ENTRY: TeamMessagesCacheEntry = {
  canonicalMessages: [],
  optimisticMessages: [],
  feedRevision: null,
  nextCursor: null,
  hasMore: false,
  lastFetchedAt: null,
  loadingHead: false,
  loadingOlder: false,
  headHydrated: false,
};

function createEmptyTeamMessagesCacheEntry(): TeamMessagesCacheEntry {
  return {
    canonicalMessages: [],
    optimisticMessages: [],
    feedRevision: null,
    nextCursor: null,
    hasMore: false,
    lastFetchedAt: null,
    loadingHead: false,
    loadingOlder: false,
    headHydrated: false,
  };
}

function getTeamMessagesCacheEntry(
  state: Pick<TeamSlice, 'teamMessagesByName'>,
  teamName: string
): TeamMessagesCacheEntry {
  return state.teamMessagesByName[teamName] ?? EMPTY_TEAM_MESSAGES_CACHE_ENTRY;
}

function upsertOptimisticTeamMessage(
  entry: TeamMessagesCacheEntry,
  message: InboxMessage
): TeamMessagesCacheEntry {
  const nextOptimistic = [...entry.optimisticMessages];
  const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
  if (messageId.length > 0) {
    const existingIndex = nextOptimistic.findIndex(
      (candidate) =>
        typeof candidate.messageId === 'string' && candidate.messageId.trim() === messageId
    );
    if (existingIndex >= 0) {
      nextOptimistic[existingIndex] = {
        ...nextOptimistic[existingIndex],
        ...message,
      };
    } else {
      nextOptimistic.push(message);
    }
  } else {
    nextOptimistic.push(message);
  }
  nextOptimistic.sort(compareInboxMessagesByTimestamp);
  return {
    ...entry,
    optimisticMessages: nextOptimistic,
  };
}

function areInboxMessageArraysEquivalent(
  left: readonly InboxMessage[],
  right: readonly InboxMessage[]
): boolean {
  if (left === right) return true;
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftItem = left[index];
    const rightItem = right[index];
    if (
      leftItem.messageId !== rightItem.messageId ||
      leftItem.timestamp !== rightItem.timestamp ||
      leftItem.from !== rightItem.from ||
      leftItem.to !== rightItem.to ||
      leftItem.text !== rightItem.text ||
      leftItem.summary !== rightItem.summary ||
      leftItem.read !== rightItem.read ||
      leftItem.relayOfMessageId !== rightItem.relayOfMessageId ||
      leftItem.source !== rightItem.source ||
      leftItem.leadSessionId !== rightItem.leadSessionId ||
      leftItem.messageKind !== rightItem.messageKind
    ) {
      return false;
    }
  }
  return true;
}

function pruneOptimisticMessages(
  optimistic: readonly InboxMessage[],
  canonical: readonly InboxMessage[]
): InboxMessage[] {
  if (optimistic.length === 0) {
    return [];
  }

  const canonicalIds = new Set(
    canonical
      .map((message) => (typeof message.messageId === 'string' ? message.messageId.trim() : ''))
      .filter((messageId) => messageId.length > 0)
  );

  return optimistic.filter((message) => {
    const messageId = typeof message.messageId === 'string' ? message.messageId.trim() : '';
    return !messageId || !canonicalIds.has(messageId);
  });
}

function clearPendingReplyRefreshTimer(teamName: string): void {
  const existingTimer = pendingTeamPendingReplyRefreshTimers.get(teamName);
  if (existingTimer == null) {
    return;
  }
  clearTimeout(existingTimer);
  pendingTeamPendingReplyRefreshTimers.delete(teamName);
}

function clearPendingReplyRefreshWaits(teamName: string): void {
  activeTeamPendingReplyWaitSourceIdsByTeam.delete(teamName);
}

function setPendingReplyRefreshEnabled(
  teamName: string,
  sourceId: string,
  enabled: boolean
): boolean {
  if (enabled) {
    const existing = activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName) ?? new Set<string>();
    existing.add(sourceId);
    activeTeamPendingReplyWaitSourceIdsByTeam.set(teamName, existing);
    return true;
  }

  const existing = activeTeamPendingReplyWaitSourceIdsByTeam.get(teamName);
  if (!existing) {
    return false;
  }
  existing.delete(sourceId);
  if (existing.size === 0) {
    activeTeamPendingReplyWaitSourceIdsByTeam.delete(teamName);
    return false;
  }
  return true;
}

function getCanonicalHeadSlice(
  canonicalMessages: readonly InboxMessage[],
  headLength: number
): readonly InboxMessage[] {
  if (headLength <= 0) {
    return [];
  }
  return canonicalMessages.slice(0, headLength);
}

function extractRetainedCanonicalOlderTail(
  canonicalMessages: readonly InboxMessage[],
  freshHeadMessages: readonly InboxMessage[]
): InboxMessage[] | null {
  if (canonicalMessages.length === 0) {
    return [];
  }
  if (freshHeadMessages.length === 0) {
    return null;
  }

  const freshHeadKeys = new Set(freshHeadMessages.map((message) => toMessageKey(message)));
  let hasMessagesOutsideFreshHead = false;
  for (const message of canonicalMessages) {
    if (!freshHeadKeys.has(toMessageKey(message))) {
      hasMessagesOutsideFreshHead = true;
      break;
    }
  }
  if (!hasMessagesOutsideFreshHead) {
    return [];
  }

  const anchorKey = toMessageKey(freshHeadMessages[freshHeadMessages.length - 1]);
  const anchorIndex = canonicalMessages.findIndex((message) => toMessageKey(message) === anchorKey);
  if (anchorIndex < 0) {
    return null;
  }

  return canonicalMessages
    .slice(anchorIndex + 1)
    .filter((message) => !freshHeadKeys.has(toMessageKey(message)));
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
    if (current && TERMINAL_PROVISIONING_STATES.has(current.state)) {
      return;
    }
    try {
      const progress = await state.getProvisioningStatus(runId);
      if (TERMINAL_PROVISIONING_STATES.has(progress.state)) {
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

// --- Clarification notification tracking ---
// Native OS notifications for new inbox messages are handled in main process
// (main/index.ts → notifyNewInboxMessages). This renderer-side tracking only
// handles clarification-specific logic (e.g., marking tasks as needing user input).
const notifiedClarificationTaskKeys = new Set<string>();
const notifiedStatusChangeKeys = new Set<string>();
const notifiedCommentKeys = new Set<string>();
const notifiedCreatedTaskKeys = new Set<string>();
const notifiedAllCompletedTeams = new Set<string>();

let isFirstFetchAllTasks = true;

function detectClarificationNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  for (const task of newTasks) {
    const key = `${task.teamName}:${task.id}`;
    if (task.needsClarification === 'user') {
      const oldTask = oldTasks.find((t) => t.teamName === task.teamName && t.id === task.id);
      if (oldTask?.needsClarification !== 'user' && !notifiedClarificationTaskKeys.has(key)) {
        notifiedClarificationTaskKeys.add(key);
        // Always store in-app; suppress OS toast when per-type toggle is off
        fireClarificationNotification(task, !notifyEnabled);
      }
    } else {
      notifiedClarificationTaskKeys.delete(key);
    }
  }
}

function fireClarificationNotification(task: GlobalTask, suppressToast: boolean): void {
  // Delegate to main process for native OS notification (cross-platform, no permission needed)
  const latestComment = task.comments?.length ? task.comments[task.comments.length - 1] : undefined;
  const rawBody =
    latestComment?.text || task.description || `${formatTaskDisplayLabel(task)}: ${task.subject}`;
  const body = stripAgentBlocks(rawBody).trim();

  void api.teams
    ?.showMessageNotification({
      teamName: task.teamName,
      teamDisplayName: task.teamDisplayName,
      from: latestComment?.author || 'team-lead',
      to: 'user',
      summary: `Clarification needed — Task ${formatTaskDisplayLabel(task)}`,
      body,
      teamEventType: 'task_clarification',
      dedupeKey: `clarification:${task.teamName}:${task.id}:${task.updatedAt ?? Date.now()}`,
      suppressToast,
    })
    .catch(() => undefined);
}

function detectStatusChangeNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  config: AppConfig | null,
  teamByName: Record<string, TeamSummary>
): void {
  const statusChangeEnabled =
    !!config?.notifications?.notifyOnStatusChange && !!config.notifications.enabled;
  const statuses = config?.notifications?.statusChangeStatuses ?? ['in_progress', 'completed'];
  if (statuses.length === 0) return;

  const onlySolo = config?.notifications?.statusChangeOnlySolo ?? true;

  for (const task of newTasks) {
    const oldTask = oldTasks.find((t) => t.teamName === task.teamName && t.id === task.id);
    if (!oldTask) continue;

    // Detect kanbanColumn change to 'approved' (status stays 'completed', column changes)
    const taskKanbanColumn = getTaskKanbanColumn(task);
    const oldTaskKanbanColumn = getTaskKanbanColumn(oldTask);
    const becameApproved = taskKanbanColumn === 'approved' && oldTaskKanbanColumn !== 'approved';
    const becameReview = taskKanbanColumn === 'review' && oldTaskKanbanColumn !== 'review';
    const becameNeedsFix = task.reviewState === 'needsFix' && oldTask.reviewState !== 'needsFix';

    const statusChanged = oldTask.status !== task.status;
    if (!statusChanged && !becameApproved && !becameReview && !becameNeedsFix) continue;

    if (onlySolo) {
      const team = teamByName[task.teamName];
      if (team && team.memberCount > 0) continue;
    }

    // Resolve the effective status for notification matching
    const effectiveStatus = becameApproved
      ? 'approved'
      : becameReview
        ? 'review'
        : becameNeedsFix
          ? 'needsFix'
          : task.status;
    if (!statuses.includes(effectiveStatus)) continue;

    const key = `${task.teamName}:${task.id}:${effectiveStatus}`;
    if (notifiedStatusChangeKeys.has(key)) continue;
    notifiedStatusChangeKeys.add(key);

    const fromLabel = becameApproved ? 'Completed' : becameReview ? 'Completed' : oldTask.status;
    fireStatusChangeNotification(
      task,
      fromLabel,
      becameApproved
        ? 'approved'
        : becameReview
          ? 'review'
          : becameNeedsFix
            ? 'needsFix'
            : undefined,
      !statusChangeEnabled
    );
  }
}

function fireStatusChangeNotification(
  task: GlobalTask,
  fromStatus: string,
  overrideToStatus?: string,
  suppressToast?: boolean
): void {
  const statusLabels: Record<string, string> = {
    pending: 'Pending',
    in_progress: 'In Progress',
    completed: 'Completed',
    deleted: 'Deleted',
    review: 'Review',
    needsFix: 'Needs Fixes',
    approved: 'Approved',
  };
  const from = statusLabels[fromStatus] ?? fromStatus;
  const toStatus = overrideToStatus ?? task.status;
  const to = statusLabels[toStatus] ?? toStatus;

  void api.teams
    ?.showMessageNotification({
      teamName: task.teamName,
      teamDisplayName: task.teamDisplayName,
      from: task.owner ?? 'system',
      to: 'user',
      summary: `Task ${formatTaskDisplayLabel(task)}: ${from} → ${to}`,
      body: task.subject,
      teamEventType: 'task_status_change',
      dedupeKey: `status:${task.teamName}:${task.id}:${fromStatus}:${toStatus}:${task.updatedAt ?? Date.now()}`,
      suppressToast,
    })
    .catch(() => undefined);
}

function detectTaskCommentNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const oldTaskMap = new Map(oldTasks.map((t) => [`${t.teamName}:${t.id}`, t]));

  for (const task of newTasks) {
    const mapKey = `${task.teamName}:${task.id}`;
    const oldTask = oldTaskMap.get(mapKey);
    const oldCommentCount = oldTask?.comments?.length ?? 0;
    const newCommentCount = task.comments?.length ?? 0;

    if (newCommentCount <= oldCommentCount) continue;

    const newComments = (task.comments ?? []).slice(oldCommentCount);
    for (const comment of newComments) {
      // Don't notify about user's own comments
      if (comment.author === 'user') continue;
      // Skip review-related comment types (already covered by status change notifications)
      if (comment.type === 'review_request' || comment.type === 'review_approved') continue;

      const key = `${task.teamName}:${task.id}:${comment.id}`;
      if (notifiedCommentKeys.has(key)) continue;
      notifiedCommentKeys.add(key);

      fireTaskCommentNotification(task, comment, !notifyEnabled);
    }
  }
}

function fireTaskCommentNotification(
  task: GlobalTask,
  comment: { author: string; text: string; id: string },
  suppressToast: boolean
): void {
  // Double-check: never notify about user's own comments
  if (comment.author === 'user') return;

  const stripped = stripAgentBlocks(comment.text).trim();
  const preview = stripped.length > 100 ? stripped.slice(0, 100) + '...' : stripped;

  void api.teams
    ?.showMessageNotification({
      teamName: task.teamName,
      teamDisplayName: task.teamDisplayName,
      from: comment.author,
      to: 'user',
      summary: `Comment on ${formatTaskDisplayLabel(task)}: ${task.subject}`,
      body: preview,
      teamEventType: 'task_comment',
      dedupeKey: `comment:${task.teamName}:${task.id}:${comment.id}`,
      suppressToast,
    })
    .catch(() => undefined);
}

function detectTaskCreatedNotifications(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  const oldTaskKeys = new Set(oldTasks.map((t) => `${t.teamName}:${t.id}`));

  for (const task of newTasks) {
    const key = `${task.teamName}:${task.id}`;
    if (oldTaskKeys.has(key)) continue;
    if (notifiedCreatedTaskKeys.has(key)) continue;
    notifiedCreatedTaskKeys.add(key);

    fireTaskCreatedNotification(task, !notifyEnabled);
  }
}

function fireTaskCreatedNotification(task: GlobalTask, suppressToast: boolean): void {
  void api.teams
    ?.showMessageNotification({
      teamName: task.teamName,
      teamDisplayName: task.teamDisplayName,
      from: task.owner ?? 'system',
      to: 'user',
      summary: `New task ${formatTaskDisplayLabel(task)}: ${task.subject}`,
      body: stripAgentBlocks(task.description || task.subject).trim(),
      teamEventType: 'task_created',
      dedupeKey: `created:${task.teamName}:${task.id}`,
      suppressToast,
    })
    .catch(() => undefined);
}

function detectAllTasksCompletedNotification(
  oldTasks: GlobalTask[],
  newTasks: GlobalTask[],
  notifyEnabled: boolean
): void {
  // Group tasks by team
  const teamTasks = new Map<string, GlobalTask[]>();
  for (const task of newTasks) {
    const list = teamTasks.get(task.teamName) ?? [];
    list.push(task);
    teamTasks.set(task.teamName, list);
  }

  for (const [teamName, tasks] of teamTasks) {
    if (tasks.length === 0) continue;
    const allCompleted = tasks.every((t) => t.status === 'completed' || t.status === 'deleted');
    if (!allCompleted) {
      // Reset so we can notify again if tasks become all-completed later
      notifiedAllCompletedTeams.delete(teamName);
      continue;
    }
    if (notifiedAllCompletedTeams.has(teamName)) continue;

    // Check that at least one task was NOT completed before (real transition)
    const oldTeamTasks = oldTasks.filter((t) => t.teamName === teamName);
    const wasAlreadyAllCompleted =
      oldTeamTasks.length > 0 &&
      oldTeamTasks.every((t) => t.status === 'completed' || t.status === 'deleted');
    if (wasAlreadyAllCompleted) {
      notifiedAllCompletedTeams.add(teamName);
      continue;
    }

    notifiedAllCompletedTeams.add(teamName);
    fireAllTasksCompletedNotification(tasks[0], tasks.length, !notifyEnabled);
  }
}

function fireAllTasksCompletedNotification(
  sampleTask: GlobalTask,
  taskCount: number,
  suppressToast: boolean
): void {
  void api.teams
    ?.showMessageNotification({
      teamName: sampleTask.teamName,
      teamDisplayName: sampleTask.teamDisplayName,
      from: 'system',
      to: 'user',
      summary: `All ${taskCount} tasks completed`,
      body: `All tasks in team "${sampleTask.teamDisplayName}" are done`,
      teamEventType: 'all_tasks_completed',
      dedupeKey: `all-done:${sampleTask.teamName}:${Date.now()}`,
      suppressToast,
    })
    .catch(() => undefined);
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

function mapSendMessageError(error: unknown): string {
  const message =
    error instanceof IpcError ? error.message : error instanceof Error ? error.message : '';
  if (message.includes('Failed to verify inbox write')) {
    return 'Message was written but not verified (race). Please try again.';
  }
  return message || 'Failed to send message';
}

function mapReviewError(error: unknown): string {
  const message =
    error instanceof IpcError ? error.message : error instanceof Error ? error.message : '';
  if (message.includes('Task status update verification failed')) {
    return 'Failed to update task status (possible agent conflict).';
  }
  return message || 'Failed to perform review action';
}

export interface GlobalTaskDetailState {
  teamName: string;
  taskId: string;
}

/** Per-team launch parameters shown in the header badge. */
export interface TeamLaunchParams {
  providerId?: 'anthropic' | 'codex' | 'gemini';
  providerBackendId?: string;
  model?: string; // 'opus' | 'sonnet' | 'haiku'
  effort?: EffortLevel;
  limitContext?: boolean;
}

const resolvedMembersSelectorCache = new Map<
  string,
  {
    snapshotRef: TeamViewSnapshot['members'];
    metaMembersRef: TeamMemberActivityMeta['members'] | undefined;
    result: ResolvedTeamMember[];
  }
>();
const resolvedMemberSelectorCache = new Map<
  string,
  {
    snapshotMemberRef: TeamMemberSnapshot | undefined;
    metaEntryRef: MemberActivityMetaEntry | undefined;
    result: ResolvedTeamMember | null;
  }
>();
const mergedMessagesSelectorCache = new Map<
  string,
  {
    canonicalRef: InboxMessage[];
    optimisticRef: InboxMessage[];
    result: InboxMessage[];
  }
>();
const EMPTY_TEAM_MEMBER_SNAPSHOTS: TeamMemberSnapshot[] = [];
const EMPTY_TEAM_TASKS: TeamViewSnapshot['tasks'] = [];
const memberMessagesSelectorCache = new Map<
  string,
  {
    messagesRef: InboxMessage[];
    result: InboxMessage[];
  }
>();

function resolveMemberStatus(
  snapshot: TeamMemberSnapshot,
  activity: MemberActivityMetaEntry | undefined
): ResolvedTeamMember['status'] {
  if (activity?.latestAuthoredMessageSignalsTermination) {
    return 'terminated';
  }

  if (!activity?.lastAuthoredMessageAt) {
    return snapshot.currentTaskId ? 'active' : 'idle';
  }

  const ageMs = Date.now() - Date.parse(activity.lastAuthoredMessageAt);
  if (Number.isNaN(ageMs)) {
    return 'unknown';
  }
  if (ageMs < 5 * 60 * 1000) {
    return 'active';
  }
  return 'idle';
}

function buildResolvedMembers(
  snapshots: readonly TeamMemberSnapshot[],
  meta: TeamMemberActivityMeta | undefined
): ResolvedTeamMember[] {
  return snapshots.map((member) => buildResolvedMember(member, meta?.members[member.name]));
}

function buildResolvedMember(
  snapshot: TeamMemberSnapshot,
  activity: MemberActivityMetaEntry | undefined
): ResolvedTeamMember {
  return {
    ...snapshot,
    status: resolveMemberStatus(snapshot, activity),
    messageCount: activity?.messageCountExact ?? 0,
    lastActiveAt: activity?.lastAuthoredMessageAt ?? null,
  };
}

function areMemberActivityMetaEntriesEqual(
  left: MemberActivityMetaEntry | undefined,
  right: MemberActivityMetaEntry
): boolean {
  if (!left) {
    return false;
  }
  return (
    left.memberName === right.memberName &&
    left.lastAuthoredMessageAt === right.lastAuthoredMessageAt &&
    left.messageCountExact === right.messageCountExact &&
    left.latestAuthoredMessageSignalsTermination === right.latestAuthoredMessageSignalsTermination
  );
}

function structurallyShareMemberActivityFacts(
  previous: Record<string, MemberActivityMetaEntry> | undefined,
  next: Record<string, MemberActivityMetaEntry>
): Record<string, MemberActivityMetaEntry> {
  if (!previous) {
    return next;
  }

  const nextKeys = Object.keys(next);
  const previousKeys = Object.keys(previous);
  let changed = nextKeys.length !== previousKeys.length;
  const shared: Record<string, MemberActivityMetaEntry> = {};

  for (const key of nextKeys) {
    const nextEntry = next[key];
    const previousEntry = previous[key];
    if (!areMemberActivityMetaEntriesEqual(previousEntry, nextEntry)) {
      changed = true;
      shared[key] = nextEntry;
      continue;
    }
    shared[key] = previousEntry;
  }

  return changed ? shared : previous;
}

export function selectTeamDataForName(
  state: Pick<TeamSlice, 'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData'>,
  teamName: string | null | undefined
): TeamViewSnapshot | null {
  if (!teamName) {
    return null;
  }
  return (
    state.teamDataCacheByName[teamName] ??
    (state.selectedTeamName === teamName ? state.selectedTeamData : null)
  );
}

function migrateStableSlotAssignmentsForMembers(
  assignments: TeamGraphSlotAssignments | undefined,
  members: readonly TeamGraphMemberSeedInput[]
): { assignments: TeamGraphSlotAssignments; changed: boolean } {
  const nextAssignments: TeamGraphSlotAssignments = { ...(assignments ?? {}) };
  let changed = false;

  for (const member of members) {
    const fallbackKey = member.name.trim();
    const stableOwnerId = getStableTeamOwnerId(member);
    const fallbackAssignment = nextAssignments[fallbackKey];
    const stableAssignment = nextAssignments[stableOwnerId];

    if (stableOwnerId !== fallbackKey && fallbackAssignment && !stableAssignment) {
      nextAssignments[stableOwnerId] = fallbackAssignment;
      delete nextAssignments[fallbackKey];
      changed = true;
      continue;
    }

    if (stableOwnerId !== fallbackKey && fallbackAssignment && stableAssignment) {
      delete nextAssignments[fallbackKey];
      changed = true;
    }
  }

  return { assignments: nextAssignments, changed };
}

export function selectResolvedMembersForTeamName(
  state: Pick<
    TeamSlice,
    'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData' | 'memberActivityMetaByTeam'
  >,
  teamName: string | null | undefined
): ResolvedTeamMember[] {
  const snapshot = selectTeamDataForName(state, teamName);
  if (!snapshot || !teamName) {
    return [];
  }

  const meta = state.memberActivityMetaByTeam[teamName];
  const metaMembers = meta?.members;
  const cached = resolvedMembersSelectorCache.get(teamName);
  if (cached?.snapshotRef === snapshot.members && cached.metaMembersRef === metaMembers) {
    return cached.result;
  }

  const result = buildResolvedMembers(snapshot.members, meta);
  resolvedMembersSelectorCache.set(teamName, {
    snapshotRef: snapshot.members,
    metaMembersRef: metaMembers,
    result,
  });
  return result;
}

export function selectResolvedMemberForTeamName(
  state: Pick<
    TeamSlice,
    'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData' | 'memberActivityMetaByTeam'
  >,
  teamName: string | null | undefined,
  memberName: string | null | undefined
): ResolvedTeamMember | null {
  const snapshot = selectTeamDataForName(state, teamName);
  if (!snapshot || !teamName || !memberName) {
    return null;
  }

  const snapshotMember = snapshot.members.find((member) => member.name === memberName);
  if (!snapshotMember) {
    return null;
  }

  const metaEntry = state.memberActivityMetaByTeam[teamName]?.members[memberName];
  const cacheKey = `${teamName}:${memberName}`;
  const cached = resolvedMemberSelectorCache.get(cacheKey);
  if (cached?.snapshotMemberRef === snapshotMember && cached.metaEntryRef === metaEntry) {
    return cached.result;
  }

  const result = buildResolvedMember(snapshotMember, metaEntry);
  resolvedMemberSelectorCache.set(cacheKey, {
    snapshotMemberRef: snapshotMember,
    metaEntryRef: metaEntry,
    result,
  });
  return result;
}

export function selectTeamMemberSnapshotsForName(
  state: Pick<TeamSlice, 'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData'>,
  teamName: string | null | undefined
): TeamViewSnapshot['members'] {
  return selectTeamDataForName(state, teamName)?.members ?? EMPTY_TEAM_MEMBER_SNAPSHOTS;
}

export function selectTeamTasksForName(
  state: Pick<TeamSlice, 'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData'>,
  teamName: string | null | undefined
): TeamViewSnapshot['tasks'] {
  return selectTeamDataForName(state, teamName)?.tasks ?? EMPTY_TEAM_TASKS;
}

export function selectTeamIsAliveForName(
  state: Pick<TeamSlice, 'teamDataCacheByName' | 'selectedTeamName' | 'selectedTeamData'>,
  teamName: string | null | undefined
): boolean | undefined {
  return selectTeamDataForName(state, teamName)?.isAlive;
}

export function selectTeamMessages(
  state: Pick<TeamSlice, 'teamMessagesByName'>,
  teamName: string | null | undefined
): InboxMessage[] {
  if (!teamName) {
    return [];
  }

  const entry = getTeamMessagesCacheEntry(state, teamName);
  const cached = mergedMessagesSelectorCache.get(teamName);
  if (
    cached?.canonicalRef === entry.canonicalMessages &&
    cached.optimisticRef === entry.optimisticMessages
  ) {
    return cached.result;
  }

  const result = mergeTeamMessages(entry.canonicalMessages, entry.optimisticMessages);
  mergedMessagesSelectorCache.set(teamName, {
    canonicalRef: entry.canonicalMessages,
    optimisticRef: entry.optimisticMessages,
    result,
  });
  return result;
}

export function selectMemberMessagesForTeamMember(
  state: Pick<TeamSlice, 'teamMessagesByName'>,
  teamName: string | null | undefined,
  memberName: string | null | undefined
): InboxMessage[] {
  if (!teamName || !memberName) {
    return [];
  }

  const messages = selectTeamMessages(state, teamName);
  const cacheKey = `${teamName}:${memberName}`;
  const cached = memberMessagesSelectorCache.get(cacheKey);
  if (cached?.messagesRef === messages) {
    return cached.result;
  }

  const result = messages.filter(
    (message) => message.from === memberName || message.to === memberName
  );
  memberMessagesSelectorCache.set(cacheKey, {
    messagesRef: messages,
    result,
  });
  return result;
}

function isMemberActivityMetaStale(
  state: Pick<TeamSlice, 'memberActivityMetaByTeam' | 'teamMessagesByName'>,
  teamName: string
): boolean {
  const meta = state.memberActivityMetaByTeam[teamName];
  const feedRevision = getTeamMessagesCacheEntry(state, teamName).feedRevision;
  if (!meta) {
    return true;
  }
  if (!feedRevision) {
    return false;
  }
  return meta.feedRevision !== feedRevision;
}

function seedStableSlotAssignmentsForMembers(
  assignments: TeamGraphSlotAssignments,
  members: readonly TeamGraphMemberSeedInput[],
  configMembers: readonly TeamGraphConfigMemberSeedInput[] = []
): { assignments: TeamGraphSlotAssignments; changed: boolean } {
  const defaultSeed = buildTeamGraphDefaultLayoutSeed(members, configMembers);
  if (
    defaultSeed.orderedVisibleOwnerIds.length === 0 ||
    Object.keys(defaultSeed.assignments).length === 0
  ) {
    return { assignments, changed: false };
  }

  const visibleStableOwnerIds = defaultSeed.orderedVisibleOwnerIds;
  const hasAnyVisibleAssignments = visibleStableOwnerIds.some(
    (stableOwnerId) => assignments[stableOwnerId] != null
  );
  if (hasAnyVisibleAssignments) {
    return { assignments, changed: false };
  }

  const nextAssignments: TeamGraphSlotAssignments = { ...assignments };
  visibleStableOwnerIds.forEach((stableOwnerId) => {
    nextAssignments[stableOwnerId] = defaultSeed.assignments[stableOwnerId]!;
  });

  return { assignments: nextAssignments, changed: true };
}

function areTeamGraphSlotAssignmentsEqual(
  left: TeamGraphSlotAssignments | undefined,
  right: TeamGraphSlotAssignments | undefined
): boolean {
  const leftEntries = Object.entries(left ?? {});
  const rightEntries = Object.entries(right ?? {});
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }

  for (const [stableOwnerId, leftAssignment] of leftEntries) {
    const rightAssignment = right?.[stableOwnerId];
    if (
      rightAssignment?.ringIndex !== leftAssignment.ringIndex ||
      rightAssignment.sectorIndex !== leftAssignment.sectorIndex
    ) {
      return false;
    }
  }

  return true;
}

function normalizeTeamGraphSlotAssignmentsForVisibleOwners(
  assignments: TeamGraphSlotAssignments | undefined,
  visibleOwnerIds: readonly string[]
): TeamGraphSlotAssignments {
  if (visibleOwnerIds.length === 0 || !assignments) {
    return {};
  }

  const normalizedAssignments: TeamGraphSlotAssignments = {};
  for (const stableOwnerId of visibleOwnerIds) {
    const assignment = assignments[stableOwnerId];
    if (!assignment) {
      continue;
    }
    normalizedAssignments[stableOwnerId] = assignment;
  }
  return normalizedAssignments;
}

function pruneTeamGraphSlotAssignmentsForVisibleOwners(
  assignments: TeamGraphSlotAssignments | undefined,
  visibleOwnerIds: readonly string[]
): TeamGraphSlotAssignments | undefined {
  const normalizedAssignments = normalizeTeamGraphSlotAssignmentsForVisibleOwners(
    assignments,
    visibleOwnerIds
  );
  return Object.keys(normalizedAssignments).length > 0 ? normalizedAssignments : undefined;
}

export function getDefaultTeamGraphSlotAssignmentsForMembers(
  members: readonly TeamGraphMemberSeedInput[],
  configMembers: readonly TeamGraphConfigMemberSeedInput[] = []
): TeamGraphSlotAssignments {
  return buildTeamGraphDefaultLayoutSeed(members, configMembers).assignments;
}

export function isTeamGraphSlotPersistenceDisabled(): boolean {
  return DISABLE_PERSISTED_TEAM_GRAPH_SLOT_ASSIGNMENTS;
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

function shouldInvalidateCachedTeamDataForError(teamName: string, message: string): boolean {
  return (
    message === 'TEAM_DRAFT' ||
    message.includes('TEAM_DRAFT') ||
    message === `Team not found: ${teamName}` ||
    message === 'Team config not found'
  );
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
  openGlobalTaskDetail: (teamName: string, taskId: string) => void;
  closeGlobalTaskDetail: () => void;
  /** Set by MemberHoverCard to signal TeamDetailView to open MemberDetailDialog */
  pendingMemberProfile: string | null;
  openMemberProfile: (memberName: string) => void;
  closeMemberProfile: () => void;
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
  slotAssignmentsByTeam: Record<string, TeamGraphSlotAssignments>;
  teamMessagesByName: Record<string, TeamMessagesCacheEntry>;
  memberActivityMetaByTeam: Record<string, TeamMemberActivityMeta>;
  graphLayoutSessionByTeam: Record<string, TeamGraphLayoutSessionState>;
  selectedTeamLoading: boolean;
  selectedTeamLoadNonce: number;
  selectedTeamError: string | null;
  sendingMessage: boolean;
  sendMessageError: string | null;
  lastSendMessageResult: SendMessageResult | null;
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
  sendTeamMessage: (teamName: string, request: SendMessageRequest) => Promise<void>;
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
  fetchCrossTeamTargets: () => Promise<void>;
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
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  updateMemberRole: (
    teamName: string,
    memberName: string,
    role: string | undefined
  ) => Promise<void>;
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

export function isTeamProvisioningActive(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const current = getCurrentProvisioningProgressForTeam(state, teamName);
  return current != null && ACTIVE_PROVISIONING_STATES.has(current.state);
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

/**
 * Extract the base model name from the raw model string sent to CLI.
 * E.g. 'opus[1m]' → 'opus', 'sonnet' → 'sonnet', undefined → undefined.
 */
function extractBaseModel(raw?: string, providerId?: TeamProviderId): string | undefined {
  return extractProviderScopedBaseModel(raw, providerId);
}

const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

function parseToolApprovalSettings(raw: string | null): ToolApprovalSettings {
  if (!raw) return DEFAULT_TOOL_APPROVAL_SETTINGS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const d = DEFAULT_TOOL_APPROVAL_SETTINGS;
    return {
      autoAllowAll: typeof parsed.autoAllowAll === 'boolean' ? parsed.autoAllowAll : d.autoAllowAll,
      autoAllowFileEdits:
        typeof parsed.autoAllowFileEdits === 'boolean'
          ? parsed.autoAllowFileEdits
          : d.autoAllowFileEdits,
      autoAllowSafeBash:
        typeof parsed.autoAllowSafeBash === 'boolean'
          ? parsed.autoAllowSafeBash
          : d.autoAllowSafeBash,
      timeoutAction:
        typeof parsed.timeoutAction === 'string' &&
        ['allow', 'deny', 'wait'].includes(parsed.timeoutAction)
          ? (parsed.timeoutAction as ToolApprovalSettings['timeoutAction'])
          : d.timeoutAction,
      timeoutSeconds:
        typeof parsed.timeoutSeconds === 'number' &&
        Number.isFinite(parsed.timeoutSeconds) &&
        parsed.timeoutSeconds >= 5 &&
        parsed.timeoutSeconds <= 300
          ? parsed.timeoutSeconds
          : d.timeoutSeconds,
    };
  } catch {
    return DEFAULT_TOOL_APPROVAL_SETTINGS;
  }
}

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
  slotAssignmentsByTeam: {},
  teamMessagesByName: {},
  memberActivityMetaByTeam: {},
  graphLayoutSessionByTeam: {},
  selectedTeamLoading: false,
  selectedTeamLoadNonce: 0,
  selectedTeamError: null,
  sendingMessage: false,
  sendMessageError: null,
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
    const backoffUntil = memberSpawnStatusesIpcBackoffUntilByTeam.get(teamName) ?? 0;
    if (backoffUntil > Date.now()) {
      return;
    }
    try {
      const snapshot = await api.teams.getMemberSpawnStatuses(teamName);
      memberSpawnStatusesIpcBackoffUntilByTeam.delete(teamName);
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
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("No handler registered for 'team:memberSpawnStatuses'")) {
        memberSpawnStatusesIpcBackoffUntilByTeam.set(
          teamName,
          Date.now() + MEMBER_SPAWN_STATUSES_IPC_RETRY_BACKOFF_MS
        );
      }
      // ignore — spawn statuses are best-effort
    }
  },
  fetchTeamAgentRuntime: async (teamName: string) => {
    if (!api.teams?.getTeamAgentRuntime) return;
    try {
      const snapshot = await api.teams.getTeamAgentRuntime(teamName);
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
        if (areTeamAgentRuntimeSnapshotsEqual(previousSnapshot, snapshot)) {
          return {};
        }
        return {
          teamAgentRuntimeByTeam: {
            ...prev.teamAgentRuntimeByTeam,
            [teamName]: snapshot,
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
  openMemberProfile: (memberName: string) => set({ pendingMemberProfile: memberName }),
  closeMemberProfile: () => set({ pendingMemberProfile: null }),
  pendingReviewRequest: null,
  setPendingReviewRequest: (req) => set({ pendingReviewRequest: req }),
  openGlobalTaskDetail: (teamName: string, taskId: string) => {
    set({ globalTaskDetail: { teamName, taskId } });
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
  messagesPanelMode: 'sidebar' as const,
  messagesPanelWidth: 340,
  sidebarLogsHeight: 213,
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => set({ messagesPanelMode: mode }),
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
      // Atomic update: set teams AND clean up provisioning snapshots in one call
      // to prevent any render cycle with duplicate cards.
      set((state) => {
        const nextSnapshots = { ...state.provisioningSnapshotByTeam };
        for (const team of teams) {
          delete nextSnapshots[team.teamName];
        }
        return {
          teams,
          teamByName,
          teamBySessionId,
          teamsLoading: false,
          teamsError: null,
          provisioningSnapshotByTeam: nextSnapshots,
        };
      });
    } catch (error) {
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
      pendingFreshGlobalTasksRefresh = true;
      await inFlightGlobalTasksRefresh;
      return;
    }

    const runRefresh = async (): Promise<void> => {
      do {
        pendingFreshGlobalTasksRefresh = false;

        // Show skeleton only on the very first fetch — not on subsequent refreshes
        // even when the task list is empty (avoids flickering skeleton on every watcher event).
        const isInitialLoad = !get().globalTasksInitialized;
        if (isInitialLoad) {
          set({ globalTasksLoading: true, globalTasksError: null });
        }
        const oldTasks = get().globalTasks;
        const wasFirst = isFirstFetchAllTasks;
        isFirstFetchAllTasks = false;
        try {
          const tasks = await withTimeout(
            unwrapIpc('team:getAllTasks', () => api.teams.getAllTasks()),
            TEAM_FETCH_TIMEOUT_MS,
            'fetchAllTasks'
          );
          if (!wasFirst) {
            const notifyOnClarifications =
              get().appConfig?.notifications?.notifyOnClarifications ?? true;
            detectClarificationNotifications(oldTasks, tasks, notifyOnClarifications);
            detectStatusChangeNotifications(oldTasks, tasks, get().appConfig, get().teamByName);
            const notifyOnTaskComments =
              get().appConfig?.notifications?.notifyOnTaskComments ?? true;
            detectTaskCommentNotifications(oldTasks, tasks, notifyOnTaskComments);
            const notifyOnTaskCreated = get().appConfig?.notifications?.notifyOnTaskCreated ?? true;
            detectTaskCreatedNotifications(oldTasks, tasks, notifyOnTaskCreated);
            const notifyOnAllCompleted =
              get().appConfig?.notifications?.notifyOnAllTasksCompleted ?? true;
            detectAllTasksCompletedNotification(oldTasks, tasks, notifyOnAllCompleted);
          } else {
            // Initial load — seed the Sets to prevent false notifications on next update
            for (const task of tasks) {
              if (task.needsClarification === 'user') {
                notifiedClarificationTaskKeys.add(`${task.teamName}:${task.id}`);
              }
              notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:${task.status}`);
              if (task.reviewState === 'needsFix') {
                notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:needsFix`);
              }
              if (getTaskKanbanColumn(task) === 'approved') {
                notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:approved`);
              }
              if (getTaskKanbanColumn(task) === 'review') {
                notifiedStatusChangeKeys.add(`${task.teamName}:${task.id}:review`);
              }
              // Seed comment keys to prevent false notifications
              for (const comment of task.comments ?? []) {
                notifiedCommentKeys.add(`${task.teamName}:${task.id}:${comment.id}`);
              }
              // Seed created task keys to prevent false notifications
              notifiedCreatedTaskKeys.add(`${task.teamName}:${task.id}`);
            }
            // Seed all-completed teams
            const teamTasksMap = new Map<string, GlobalTask[]>();
            for (const task of tasks) {
              const list = teamTasksMap.get(task.teamName) ?? [];
              list.push(task);
              teamTasksMap.set(task.teamName, list);
            }
            for (const [teamName, teamTasks] of teamTasksMap) {
              if (teamTasks.every((t) => t.status === 'completed' || t.status === 'deleted')) {
                notifiedAllCompletedTeams.add(teamName);
              }
            }
          }

          set({
            globalTasks: tasks,
            globalTasksLoading: false,
            globalTasksInitialized: true,
            globalTasksError: null,
          });
        } catch (error) {
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
    set((state) => {
      const currentTeamData = selectTeamDataForName(state, teamName);
      let cacheChanged = false;
      const nextTeamData = currentTeamData
        ? {
            ...currentTeamData,
            tasks: currentTeamData.tasks.map((task) => {
              if (task.id !== taskId || task.changePresence === presence) {
                return task;
              }
              cacheChanged = true;
              return { ...task, changePresence: presence };
            }),
          }
        : null;

      let globalChanged = false;
      const nextGlobalTasks = state.globalTasks.map((task) => {
        if (task.teamName !== teamName || task.id !== taskId || task.changePresence === presence) {
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
    const currentTeamData = selectTeamDataForName(get(), teamName);
    if (!currentTeamData) {
      return;
    }

    try {
      const presenceByTaskId = await unwrapIpc('team:getTaskChangePresence', () =>
        api.teams.getTaskChangePresence(teamName)
      );

      set((state) => {
        const teamData = selectTeamDataForName(state, teamName);
        if (!teamData) {
          return {};
        }

        let changed = false;
        const nextTasks = teamData.tasks.map((task) => {
          const nextPresence = presenceByTaskId[task.id] ?? 'unknown';
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
    const startedAt = performance.now();
    const teamStateEpoch = captureTeamLocalStateEpoch(teamName);
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
      const data = await fetchTeamDataDeduped(teamName);
      if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
        return;
      }
      const ipcMs = performance.now() - startedAt;
      // Stale check: user may have switched to another team during the async call
      if (get().selectedTeamName !== teamName || get().selectedTeamLoadNonce !== requestNonce) {
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

      const projectedTeamData = previousData
        ? {
            ...data,
            tasks: preserveKnownTaskChangePresence(teamName, previousData.tasks, data.tasks),
          }
        : data;
      const nextTeamData = structurallyShareTeamSnapshot(previousData, projectedTeamData);
      const setStartedAt = performance.now();
      set((state) => {
        const nextCache =
          state.teamDataCacheByName[teamName] === nextTeamData
            ? state.teamDataCacheByName
            : {
                ...state.teamDataCacheByName,
                [teamName]: nextTeamData,
              };

        return {
          selectedTeamName: teamName,
          selectedTeamData: nextTeamData,
          teamDataCacheByName: nextCache,
          selectedTeamLoading: false,
          selectedTeamError: null,
        };
      });
      lastResolvedTeamDataRefreshAtByTeam.set(teamName, Date.now());
      const setMs = performance.now() - setStartedAt;
      const postStartedAt = performance.now();
      const invalidationState = previousData
        ? collectTaskChangeInvalidationState(teamName, previousData.tasks, data.tasks)
        : { cacheKeys: [], taskIds: [] };
      if (invalidationState.cacheKeys.length > 0) {
        get().invalidateTaskChangePresence(invalidationState.cacheKeys);
      }
      if (invalidationState.taskIds.length > 0) {
        await api.review.invalidateTaskChangeSummaries(teamName, invalidationState.taskIds);
      }
      const postMs = performance.now() - postStartedAt;
      maybeLogTeamDataPerf({
        phase: 'selectTeam',
        teamName,
        ipcMs,
        setMs,
        postMs,
        totalMs: performance.now() - startedAt,
        previousData,
        nextData: nextTeamData,
        deduped: true,
        reusedInFlightRequest: false,
      });
      // Sync tab label with the team's display name from config
      const displayName = data.config.name || teamName;
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

      const messagesHeadResult = await get().refreshTeamMessagesHead(teamName);
      if (messagesHeadResult.feedChanged || isMemberActivityMetaStale(get(), teamName)) {
        await get().refreshMemberActivityMeta(teamName);
      }

      if (opts?.skipProjectAutoSelect) {
        return;
      }

      // Auto-select the project associated with this team's cwd/projectPath.
      // Must search both flat projects and grouped repositoryGroups/worktrees
      // because the default viewMode is 'grouped' and flat projects may be empty.
      const projectPath = data.config.projectPath;
      if (projectPath) {
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
      if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
        return;
      }
      // If provisioning is in progress for this team, stay in loading state;
      // file watcher / progress callback will refresh once config is written.
      const currentState = get();
      if (
        currentState.selectedTeamName !== teamName ||
        currentState.selectedTeamLoadNonce !== requestNonce
      ) {
        return;
      }
      const isProvisioning = isTeamProvisioningActive(currentState, teamName);

      const msg = error instanceof Error ? error.message : String(error);
      // IPC can report provisioning state explicitly.
      if (msg === 'TEAM_PROVISIONING' || (msg.includes('TEAM_PROVISIONING') && isProvisioning)) {
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
      set({
        selectedTeamLoading: false,
        selectedTeamData: null,
        selectedTeamError: message,
      });
    }
  },

  refreshTeamData: async (teamName: string, opts?: RefreshTeamDataOptions) => {
    const startedAt = performance.now();
    const teamStateEpoch = captureTeamLocalStateEpoch(teamName);
    const refreshToken = beginInFlightTeamDataRefresh(teamName);
    // Silent refresh — update data without showing loading skeleton.
    // Only selectTeam() sets loading: true (for initial load).
    const reusedInFlightRequest =
      opts?.withDedup === true && inFlightTeamDataRequests.has(teamName);
    const burstCount = noteTeamRefreshBurst(teamName);
    if (reusedInFlightRequest) {
      pendingFreshTeamDataRefreshes.add(teamName);
      logger.warn(
        `[perf] refreshTeamData queued-fresh team=${teamName} burst=${burstCount} reason=inFlightDedup`
      );
    }
    try {
      const previousData = selectTeamDataForName(get(), teamName);
      const data = opts?.withDedup
        ? await fetchTeamDataDeduped(teamName)
        : await fetchTeamDataFresh(teamName);
      if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
        return;
      }
      const ipcMs = performance.now() - startedAt;
      const projectedTeamData = previousData
        ? {
            ...data,
            tasks: preserveKnownTaskChangePresence(teamName, previousData.tasks, data.tasks),
          }
        : data;
      const nextTeamData = structurallyShareTeamSnapshot(previousData, projectedTeamData);
      const setStartedAt = performance.now();
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

        if (
          nextCache === state.teamDataCacheByName &&
          (state.selectedTeamName !== teamName ||
            (state.selectedTeamData === nextTeamData && state.selectedTeamError == null))
        ) {
          return {};
        }

        return {
          teamDataCacheByName: nextCache,
          ...selectedState,
        };
      });
      lastResolvedTeamDataRefreshAtByTeam.set(teamName, Date.now());
      const setMs = performance.now() - setStartedAt;
      const postStartedAt = performance.now();
      const invalidationState = previousData
        ? collectTaskChangeInvalidationState(teamName, previousData.tasks, data.tasks)
        : { cacheKeys: [], taskIds: [] };
      if (invalidationState.cacheKeys.length > 0) {
        get().invalidateTaskChangePresence(invalidationState.cacheKeys);
      }
      if (invalidationState.taskIds.length > 0) {
        await api.review.invalidateTaskChangeSummaries(teamName, invalidationState.taskIds);
      }
      const postMs = performance.now() - postStartedAt;
      maybeLogTeamDataPerf({
        phase: 'refreshTeamData',
        teamName,
        ipcMs,
        setMs,
        postMs,
        totalMs: performance.now() - startedAt,
        previousData,
        nextData: nextTeamData,
        deduped: opts?.withDedup === true,
        reusedInFlightRequest,
        burstCount,
      });
    } catch (error) {
      if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
      if (reusedInFlightRequest && pendingFreshTeamDataRefreshes.delete(teamName)) {
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
      const queuedEpoch = captureTeamLocalStateEpoch(teamName);
      const queuedRequest: Promise<RefreshTeamMessagesHeadResult> = existingOlderRequest
        .then(() => {
          if (!isTeamLocalStateEpochCurrent(teamName, queuedEpoch)) {
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
      const teamStateEpoch = captureTeamLocalStateEpoch(teamName);
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
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
          if (pendingFreshTeamMessagesHeadRefreshes.delete(teamName)) {
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
    const requestedEpoch = captureTeamLocalStateEpoch(teamName);
    const existingRequest = inFlightTeamMessagesOlderRequests.get(teamName);
    if (existingRequest) {
      return existingRequest;
    }

    const existingHeadRequest = inFlightTeamMessagesHeadRequests.get(teamName);
    if (existingHeadRequest) {
      await existingHeadRequest;
      if (!isTeamLocalStateEpochCurrent(teamName, requestedEpoch)) {
        return;
      }
    }

    let entry = getTeamMessagesCacheEntry(get(), teamName);
    if (!entry.headHydrated) {
      await get().refreshTeamMessagesHead(teamName);
      if (!isTeamLocalStateEpochCurrent(teamName, requestedEpoch)) {
        return;
      }
      entry = getTeamMessagesCacheEntry(get(), teamName);
    }

    if (!entry.headHydrated || !entry.nextCursor || entry.loadingOlder || entry.loadingHead) {
      return;
    }

    const requestRef: { current: Promise<void> | null } = { current: null };
    requestRef.current = (async (): Promise<void> => {
      const teamStateEpoch = captureTeamLocalStateEpoch(teamName);
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
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
      const teamStateEpoch = captureTeamLocalStateEpoch(teamName);
      try {
        const meta = await unwrapIpc('team:getMemberActivityMeta', () =>
          api.teams.getMemberActivityMeta(teamName)
        );
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
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
        if (!isTeamLocalStateEpochCurrent(teamName, teamStateEpoch)) {
          return;
        }
        throw error;
      } finally {
        if (inFlightTeamMemberActivityMetaRequests.get(teamName) === requestRef.current) {
          inFlightTeamMemberActivityMetaRequests.delete(teamName);
          if (pendingFreshTeamMemberActivityMetaRefreshes.delete(teamName)) {
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
    set({ sendingMessage: true, sendMessageError: null, lastSendMessageResult: null });
    try {
      const result = await unwrapIpc('team:sendMessage', () =>
        api.teams.sendMessage(teamName, request)
      );
      const optimisticMessage: InboxMessage = {
        from: request.from ?? 'user',
        to: request.to ?? request.member,
        text: request.text,
        timestamp: request.timestamp ?? nowIso(),
        read: true,
        taskRefs: request.taskRefs?.length ? request.taskRefs : undefined,
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
        lastSendMessageResult: result,
        teamMessagesByName: {
          ...state.teamMessagesByName,
          [teamName]: upsertOptimisticTeamMessage(
            getTeamMessagesCacheEntry(state, teamName),
            optimisticMessage
          ),
        },
      }));
      await get().refreshTeamMessagesHead(teamName);
    } catch (error) {
      set({
        sendingMessage: false,
        lastSendMessageResult: null,
        sendMessageError: mapSendMessageError(error),
      });
    }
  },

  fetchCrossTeamTargets: async () => {
    set({ crossTeamTargetsLoading: true });
    try {
      const targets = await api.crossTeam.listTargets();
      set({ crossTeamTargets: targets, crossTeamTargetsLoading: false });
    } catch (error) {
      logger.error('fetchCrossTeamTargets failed', error);
      set({ crossTeamTargets: [], crossTeamTargetsLoading: false });
    }
  },

  sendCrossTeamMessage: async (request: CrossTeamSendRequest) => {
    set({ sendingMessage: true, sendMessageError: null, lastSendMessageResult: null });
    try {
      const result = await api.crossTeam.send(request);
      set({
        sendingMessage: false,
        sendMessageError: null,
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
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  },

  removeMember: async (teamName: string, memberName: string) => {
    await unwrapIpc('team:removeMember', () => api.teams.removeMember(teamName, memberName));
    await get().refreshTeamData(teamName);
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
          members: request.members.map((m) => ({ name: m.name, role: m.role })),
          taskCount: 0,
          lastActivity: null,
          projectPath: request.cwd || undefined,
        },
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

      // Persist per-team launch params (model, effort, limit context)
      const baseModel = extractBaseModel(request.model, request.providerId);
      const params: TeamLaunchParams = {
        providerId: request.providerId ?? 'anthropic',
        providerBackendId: request.providerBackendId,
        model: baseModel || 'default',
        effort: request.effort,
        limitContext: request.limitContext ?? false,
      };
      saveLaunchParams(request.teamName, params);
      set((state) => ({
        launchParamsByTeam: {
          ...state.launchParamsByTeam,
          [request.teamName]: params,
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
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
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

      // Persist per-team launch params (model, effort, limit context)
      const baseModel = extractBaseModel(request.model, request.providerId);
      const params: TeamLaunchParams = {
        providerId: request.providerId ?? 'anthropic',
        providerBackendId: request.providerBackendId,
        model: baseModel || 'default',
        effort: request.effort,
        limitContext: request.limitContext ?? false,
      };
      saveLaunchParams(request.teamName, params);
      set((state) => ({
        launchParamsByTeam: {
          ...state.launchParamsByTeam,
          [request.teamName]: params,
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
        return {
          provisioningRuns: nextRuns,
          currentProvisioningRunIdByTeam: nextCurrentRunIdByTeam,
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
      existingProgress?.updatedAt === progress.updatedAt &&
      existingProgress?.state === progress.state &&
      existingProgress?.message === progress.message &&
      existingProgress?.error === progress.error &&
      existingProgress?.pid === progress.pid;
    if (isDuplicateProgress && currentRunId === progress.runId) {
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
        if (state.selectedTeamName === progress.teamName && state.selectedTeamData == null) {
          void state.selectTeam(progress.teamName, { allowReloadWhileProvisioning: true });
        } else {
          void state.refreshTeamData(progress.teamName, { withDedup: true });
        }
        hydratedVisibleTeam = true;
      }
    }

    if (isCanonicalRun && TERMINAL_PROVISIONING_STATES.has(progress.state)) {
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
      void get().fetchTeams();
      if (hydratedVisibleTeam) {
        return;
      }

      const state = get();
      if (!isVisibleInActiveTeamSurface(state, progress.teamName)) {
        return;
      }

      // If the user already opened the team tab, reload team data now that
      // config.json is guaranteed to exist.
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
