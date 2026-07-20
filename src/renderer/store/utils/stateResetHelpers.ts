/**
 * Shared state reset helpers to eliminate duplicated reset blocks across slices.
 *
 * These return partial state objects that can be spread into Zustand `set()` calls.
 */

import type { AppState } from '../types';

/**
 * Reset session-related state (sessions list, detail, pagination, context stats).
 * Used when switching projects, worktrees, or repositories.
 */
export function getSessionResetState(): Partial<AppState> {
  return {
    selectedSessionId: null,
    sessionDetail: null,
    sessionContextStats: null,
    sessions: [],
    sessionsError: null,
    sessionsCursor: null,
    sessionsHasMore: false,
    sessionsTotalCount: 0,
    sessionsLoadingMore: false,
  };
}

/**
 * Atomically navigate to a specific worktree.
 * Use instead of selectRepository() + selectWorktree() to avoid race condition
 * (two competing fetchSessionsInitial calls where the stale response can overwrite).
 */
export function getWorktreeNavigationState(repoId: string, worktreeId: string): Partial<AppState> {
  return {
    selectedRepositoryId: repoId,
    selectedWorktreeId: worktreeId,
    selectedProjectId: worktreeId,
    activeProjectId: worktreeId,
    ...getSessionResetState(),
  };
}

/**
 * Clear the active project/worktree selection without resetting unrelated UI state.
 * Used when a screen wants to remove the current project context entirely.
 */
export function getProjectSelectionResetState(): Partial<AppState> {
  return {
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    selectedProjectId: null,
    activeProjectId: null,
    ...getSessionResetState(),
  };
}

/**
 * Reset team/task data that belongs to the active main-process context.
 * These caches are populated through context-aware IPC calls and must not
 * survive a local/SSH context switch.
 */
export function getContextScopedTeamResetState(): Partial<AppState> {
  return {
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
    globalTaskDetail: null,
    pendingMemberProfile: null,
    pendingTeamSectionFocus: null,
    pendingReviewRequest: null,
    selectedTeamName: null,
    selectedTeamData: null,
    teamsProjectNavigationIntent: null,
    teamDataCacheByName: {},
    selectedTeamLoading: false,
    selectedTeamLoadNonce: 0,
    selectedTeamError: null,
    sendingMessage: false,
    sendMessageError: null,
    sendMessageWarning: null,
    sendMessageDebugDetails: null,
    lastSendMessageResult: null,
    reviewActionError: null,
    graphLayoutModeByTeam: {},
    gridOwnerOrderByTeam: {},
    slotAssignmentsByTeam: {},
    teamMessagesByName: {},
    memberActivityMetaByTeam: {},
    graphLayoutSessionByTeam: {},
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
    crossTeamTargets: [],
    crossTeamTargetsLoading: false,
    kanbanFilterQuery: null,
    addingComment: false,
    addCommentError: null,
    deletedTasks: [],
    deletedTasksLoading: false,
    pendingApprovals: [],
    resolvedApprovals: new Map(),
  };
}

/**
 * Full state reset (session + project + repository + conversation).
 * Used when closing all tabs or resetting to initial state.
 */
export function getFullResetState(): Partial<AppState> {
  return {
    ...getSessionResetState(),
    selectedRepositoryId: null,
    selectedWorktreeId: null,
    selectedProjectId: null,
    activeProjectId: null,
    teamsProjectNavigationIntent: null,
    conversation: null,
    visibleAIGroupId: null,
    selectedAIGroup: null,
    sessionClaudeMdStats: null,
  };
}
