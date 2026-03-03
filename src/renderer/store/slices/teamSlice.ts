import { api } from '@renderer/api';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';
import { createLogger } from '@shared/utils/logger';

import { getWorktreeNavigationState } from '../utils/stateResetHelpers';

const logger = createLogger('teamSlice');

const TEAM_GET_DATA_TIMEOUT_MS = 30_000;
const TEAM_FETCH_TIMEOUT_MS = 30_000;
function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TERMINAL_PROVISIONING_STATES = new Set(['ready', 'failed', 'disconnected', 'cancelled']);

function isPendingProvisioningRunId(runId: string): boolean {
  return runId.startsWith('pending:');
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
    } catch {
      // best-effort polling; don't fail launch because status fetch is flaky
    }
    await sleep(delayMs);
    delayMs = Math.min(1500, Math.round(delayMs * 1.5));
  }
}

import type { AppState } from '../types';
import type {
  AddMemberRequest,
  CreateTaskRequest,
  GlobalTask,
  KanbanColumnId,
  LeadActivityState,
  SendMessageRequest,
  SendMessageResult,
  TaskComment,
  TeamCreateRequest,
  TeamData,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types';
import type { StateCreator } from 'zustand';

// --- Clarification notification tracking ---
// Native OS notifications for new inbox messages are handled in main process
// (main/index.ts → notifyNewInboxMessages). This renderer-side tracking only
// handles clarification-specific logic (e.g., marking tasks as needing user input).
const notifiedClarificationTaskKeys = new Set<string>();

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
        if (notifyEnabled) {
          fireClarificationNotification(task);
        }
      }
    } else {
      notifiedClarificationTaskKeys.delete(key);
    }
  }
}

function fireClarificationNotification(task: GlobalTask): void {
  // Delegate to main process for native OS notification (cross-platform, no permission needed)
  const latestComment = task.comments?.length ? task.comments[task.comments.length - 1] : undefined;
  const body = latestComment?.text || task.description || `Task #${task.id}: ${task.subject}`;

  void api.teams
    ?.showMessageNotification({
      teamDisplayName: task.teamDisplayName,
      from: latestComment?.author || 'team-lead',
      to: 'user',
      summary: `Clarification needed — Task #${task.id}`,
      body,
    })
    .catch(() => undefined);
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
  /** Set by GlobalTaskDetailDialog to signal TeamDetailView to open ChangeReviewDialog */
  pendingReviewRequest: { taskId: string; filePath?: string } | null;
  setPendingReviewRequest: (req: { taskId: string; filePath?: string } | null) => void;
  selectedTeamName: string | null;
  selectedTeamData: TeamData | null;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
  sendingMessage: boolean;
  sendMessageError: string | null;
  lastSendMessageResult: SendMessageResult | null;
  reviewActionError: string | null;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  /**
   * Per-team lower bound for provisioning progress timestamps.
   * Used to ignore late progress events from a previous run after stop→launch.
   */
  provisioningStartedAtFloorByTeam: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  activeProvisioningRunId: string | null;
  provisioningError: string | null;
  kanbanFilterQuery: string | null;
  provisioningProgressUnsubscribe: (() => void) | null;
  fetchBranches: (paths: string[]) => Promise<void>;
  fetchTeams: () => Promise<void>;
  fetchAllTasks: () => Promise<void>;
  openTeamsTab: () => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
  selectTeam: (teamName: string, opts?: { skipProjectAutoSelect?: boolean }) => Promise<void>;
  refreshTeamData: (teamName: string) => Promise<void>;
  sendTeamMessage: (teamName: string, request: SendMessageRequest) => Promise<void>;
  requestReview: (teamName: string, taskId: string) => Promise<void>;
  updateKanban: (teamName: string, taskId: string, patch: UpdateKanbanPatch) => Promise<void>;
  updateKanbanColumnOrder: (
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ) => Promise<void>;
  createTeamTask: (teamName: string, request: CreateTaskRequest) => Promise<TeamTask>;
  startTask: (teamName: string, taskId: string) => Promise<{ notifiedOwner: boolean }>;
  updateTaskStatus: (teamName: string, taskId: string, status: TeamTaskStatus) => Promise<void>;
  updateTaskOwner: (teamName: string, taskId: string, owner: string | null) => Promise<void>;
  updateTaskFields: (
    teamName: string,
    taskId: string,
    fields: { subject?: string; description?: string }
  ) => Promise<void>;
  addingComment: boolean;
  addCommentError: string | null;
  addTaskComment: (teamName: string, taskId: string, text: string) => Promise<TaskComment>;
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
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
  onProvisioningProgress: (progress: TeamProvisioningProgress) => void;
  subscribeProvisioningProgress: () => void;
  unsubscribeProvisioningProgress: () => void;
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
  selectedTeamLoading: false,
  selectedTeamError: null,
  sendingMessage: false,
  sendMessageError: null,
  lastSendMessageResult: null,
  reviewActionError: null,
  provisioningRuns: {},
  provisioningStartedAtFloorByTeam: {},
  leadActivityByTeam: {},
  activeProvisioningRunId: null,
  provisioningError: null,
  kanbanFilterQuery: null,
  globalTaskDetail: null,
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

  fetchBranches: async (paths: string[]) => {
    const results: Record<string, string | null> = {};
    for (const p of paths) {
      try {
        const branch = await api.teams.getProjectBranch(p);
        results[normalizePath(p)] = branch;
      } catch {
        results[normalizePath(p)] = null;
      }
    }
    if (Object.keys(results).length > 0) {
      set((state) => ({ branchByPath: { ...state.branchByPath, ...results } }));
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
      set({ teams, teamByName, teamBySessionId, teamsLoading: false, teamsError: null });
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
    // Guard: prevent concurrent fetches (component mount + centralized init chain)
    if (get().globalTasksLoading) return;
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
      } else {
        // Initial load — seed the Set to prevent false notifications on next update
        for (const task of tasks) {
          if (task.needsClarification === 'user') {
            notifiedClarificationTaskKeys.add(`${task.teamName}:${task.id}`);
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
    const displayName = teamSummary?.displayName || state.selectedTeamData?.config.name || teamName;

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

  selectTeam: async (teamName: string, opts) => {
    // Guard: prevent duplicate in-flight fetches for the same team.
    // GlobalTaskDetailDialog + tab navigation can call selectTeam() in quick succession.
    if (get().selectedTeamLoading && get().selectedTeamName === teamName) {
      return;
    }

    // Clear stale data immediately to prevent flash of previous team's content
    const prev = get().selectedTeamName;
    set({
      selectedTeamName: teamName,
      selectedTeamData: prev !== teamName ? null : get().selectedTeamData,
      selectedTeamLoading: true,
      selectedTeamError: null,
      reviewActionError: null,
    });

    try {
      const data = await withTimeout(
        unwrapIpc('team:getData', () => api.teams.getData(teamName)),
        TEAM_GET_DATA_TIMEOUT_MS,
        `team:getData(${teamName})`
      );
      // Stale check: user may have switched to another team during the async call
      if (get().selectedTeamName !== teamName) {
        return;
      }
      set({
        selectedTeamName: teamName,
        selectedTeamData: data,
        selectedTeamLoading: false,
        selectedTeamError: null,
      });

      // Sync tab label with the team's display name from config
      const displayName = data.config.name || teamName;
      const allTabs = get().getAllPaneTabs();
      const teamTab = allTabs.find((tab) => tab.type === 'team' && tab.teamName === teamName);
      if (teamTab && teamTab.label !== displayName) {
        get().updateTabLabel(teamTab.id, displayName);
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
      // If provisioning is in progress for this team, stay in loading state;
      // file watcher / progress callback will refresh once config is written.
      const isProvisioning = Object.values(get().provisioningRuns).some(
        (run) =>
          run.teamName === teamName &&
          !['ready', 'disconnected', 'failed', 'cancelled'].includes(run.state)
      );

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

  refreshTeamData: async (teamName: string) => {
    const state = get();
    if (state.selectedTeamName !== teamName) {
      return;
    }
    // Silent refresh — update data without showing loading skeleton.
    // Only selectTeam() sets loading: true (for initial load).
    try {
      const data = await withTimeout(
        unwrapIpc('team:getData', () => api.teams.getData(teamName)),
        TEAM_GET_DATA_TIMEOUT_MS,
        `refreshTeamData(${teamName})`
      );
      // Re-check after async: the user might have navigated away.
      if (get().selectedTeamName !== teamName) {
        return;
      }
      set({
        selectedTeamData: data,
        selectedTeamError: null,
      });
    } catch (error) {
      if (get().selectedTeamName !== teamName) {
        return;
      }
      const msg =
        error instanceof IpcError
          ? error.message
          : error instanceof Error
            ? error.message
            : 'Failed to refresh team data';
      logger.warn(`refreshTeamData(${teamName}) failed: ${msg}`);
      set({ selectedTeamError: msg });
    }
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
      set({
        sendingMessage: false,
        sendMessageError: null,
        lastSendMessageResult: result,
      });
      await get().refreshTeamData(teamName);
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
    return result;
  },

  updateTaskStatus: async (teamName: string, taskId: string, status: TeamTaskStatus) => {
    await unwrapIpc('team:updateTaskStatus', () =>
      api.teams.updateTaskStatus(teamName, taskId, status)
    );
    await get().refreshTeamData(teamName);
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

  addTaskComment: async (teamName, taskId, text) => {
    set({ addingComment: true, addCommentError: null });
    try {
      const comment = await unwrapIpc('team:addTaskComment', () =>
        api.teams.addTaskComment(teamName, taskId, text)
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
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  restoreTeam: async (teamName: string) => {
    await unwrapIpc('team:restoreTeam', () => api.teams.restoreTeam(teamName));
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  permanentlyDeleteTeam: async (teamName: string) => {
    await unwrapIpc('team:permanentlyDeleteTeam', () => api.teams.permanentlyDeleteTeam(teamName));
    const state = get();
    if (state.selectedTeamName === teamName) {
      set({ selectedTeamName: null, selectedTeamData: null, selectedTeamError: null });
    }
    await get().fetchTeams();
    await get().fetchAllTasks();
  },

  createTeam: async (request: TeamCreateRequest) => {
    // Ensure provisioning progress subscription is active (defensive).
    get().subscribeProvisioningProgress();

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
      return { provisioningError: null, provisioningRuns: cleaned };
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
      activeProvisioningRunId: pendingRunId,
    }));
    try {
      if (typeof api.teams.createTeam !== 'function') {
        throw new Error(
          'Current preload version does not support team:create. Restart the dev app.'
        );
      }
      const response = await unwrapIpc('team:create', () => api.teams.createTeam(request));
      set({
        activeProvisioningRunId: response.runId,
        provisioningError: null,
      });
      try {
        await get().getProvisioningStatus(response.runId);
      } catch {
        // ignore — polling below will retry
      }
      void pollProvisioningStatus(get, response.runId);
      return response.runId;
    } catch (error) {
      set({
        provisioningError:
          error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to create team',
      });
      throw error;
    }
  },

  launchTeam: async (request: TeamLaunchRequest) => {
    // Ensure provisioning progress subscription is active (defensive).
    get().subscribeProvisioningProgress();

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
      return { provisioningError: null, provisioningRuns: cleaned };
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
      activeProvisioningRunId: pendingRunId,
    }));
    try {
      const response = await unwrapIpc('team:launch', () => api.teams.launchTeam(request));
      set({
        activeProvisioningRunId: response.runId,
        provisioningError: null,
      });
      try {
        await get().getProvisioningStatus(response.runId);
      } catch {
        // ignore — polling below will retry
      }
      void pollProvisioningStatus(get, response.runId);
      return response.runId;
    } catch (error) {
      set({
        provisioningError:
          error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to launch team',
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

  cancelProvisioning: async (runId: string) => {
    await unwrapIpc('team:cancelProvisioning', () => api.teams.cancelProvisioning(runId));
  },

  onProvisioningProgress: (progress: TeamProvisioningProgress) => {
    const floor = get().provisioningStartedAtFloorByTeam[progress.teamName];
    if (floor && progress.startedAt < floor) {
      // Ignore late progress from a previous run (common after stop→launch).
      return;
    }
    set((state) => {
      const nextRuns: Record<string, TeamProvisioningProgress> = {
        ...state.provisioningRuns,
        [progress.runId]: progress,
      };
      // When real progress arrives, drop any pending placeholder runs for this team.
      if (!isPendingProvisioningRunId(progress.runId)) {
        for (const [runId, run] of Object.entries(nextRuns)) {
          if (isPendingProvisioningRunId(runId) && run.teamName === progress.teamName) {
            delete nextRuns[runId];
          }
        }
      }
      return {
        provisioningRuns: nextRuns,
        activeProvisioningRunId: progress.runId,
        provisioningError: progress.state === 'failed' ? (progress.error ?? null) : null,
      };
    });

    if (progress.state === 'ready' || progress.state === 'disconnected') {
      void get().fetchTeams();
      // If the user already opened the team tab, reload team data now that
      // config.json is guaranteed to exist.
      if (get().selectedTeamName === progress.teamName) {
        void get().selectTeam(progress.teamName);
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

  unsubscribeProvisioningProgress: () => {
    const unsubscribe = get().provisioningProgressUnsubscribe;
    if (unsubscribe) {
      unsubscribe();
      set({ provisioningProgressUnsubscribe: null });
    }
  },
});
