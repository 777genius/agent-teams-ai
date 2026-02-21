import { api } from '@renderer/api';
import { IpcError, unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { AppState } from '../types';
import type {
  CreateTaskRequest,
  SendMessageRequest,
  SendMessageResult,
  TeamCreateRequest,
  TeamData,
  TeamProvisioningProgress,
  TeamSummary,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '@shared/types';
import type { StateCreator } from 'zustand';

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

export interface TeamSlice {
  teams: TeamSummary[];
  teamsLoading: boolean;
  teamsError: string | null;
  selectedTeamName: string | null;
  selectedTeamData: TeamData | null;
  selectedTeamLoading: boolean;
  selectedTeamError: string | null;
  sendingMessage: boolean;
  sendMessageError: string | null;
  lastSendMessageResult: SendMessageResult | null;
  reviewActionError: string | null;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  activeProvisioningRunId: string | null;
  provisioningError: string | null;
  provisioningProgressUnsubscribe: (() => void) | null;
  fetchTeams: () => Promise<void>;
  openTeamsTab: () => void;
  openTeamTab: (teamName: string) => void;
  selectTeam: (teamName: string) => Promise<void>;
  refreshTeamData: (teamName: string) => Promise<void>;
  sendTeamMessage: (teamName: string, request: SendMessageRequest) => Promise<void>;
  requestReview: (teamName: string, taskId: string) => Promise<void>;
  updateKanban: (teamName: string, taskId: string, patch: UpdateKanbanPatch) => Promise<void>;
  createTeamTask: (teamName: string, request: CreateTaskRequest) => Promise<TeamTask>;
  updateTaskStatus: (teamName: string, taskId: string, status: TeamTaskStatus) => Promise<void>;
  deleteTeam: (teamName: string) => Promise<void>;
  createTeam: (request: TeamCreateRequest) => Promise<string>;
  cancelProvisioning: (runId: string) => Promise<void>;
  getProvisioningStatus: (runId: string) => Promise<void>;
  onProvisioningProgress: (progress: TeamProvisioningProgress) => void;
  subscribeProvisioningProgress: () => void;
  unsubscribeProvisioningProgress: () => void;
}

export const createTeamSlice: StateCreator<AppState, [], [], TeamSlice> = (set, get) => ({
  teams: [],
  teamsLoading: false,
  teamsError: null,
  selectedTeamName: null,
  selectedTeamData: null,
  selectedTeamLoading: false,
  selectedTeamError: null,
  sendingMessage: false,
  sendMessageError: null,
  lastSendMessageResult: null,
  reviewActionError: null,
  provisioningRuns: {},
  activeProvisioningRunId: null,
  provisioningError: null,
  provisioningProgressUnsubscribe: null,

  fetchTeams: async () => {
    set({ teamsLoading: true, teamsError: null });
    try {
      const teams = await unwrapIpc('team:list', () => api.teams.list());
      set({ teams, teamsLoading: false, teamsError: null });
    } catch (error) {
      set({
        teamsLoading: false,
        teamsError:
          error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to fetch teams',
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

  openTeamTab: (teamName: string) => {
    if (!teamName.trim()) {
      return;
    }

    const state = get();
    const allTabs = state.getAllPaneTabs();
    const existing = allTabs.find((tab) => tab.type === 'team' && tab.teamName === teamName);
    if (existing) {
      state.setActiveTab(existing.id);
      return;
    }

    state.openTab({
      type: 'team',
      label: teamName,
      teamName,
    });
  },

  selectTeam: async (teamName: string) => {
    set({
      selectedTeamName: teamName,
      selectedTeamLoading: true,
      selectedTeamError: null,
      reviewActionError: null,
    });

    try {
      const data = await unwrapIpc('team:getData', () => api.teams.getData(teamName));
      set({
        selectedTeamName: teamName,
        selectedTeamData: data,
        selectedTeamLoading: false,
        selectedTeamError: null,
      });
    } catch (error) {
      set({
        selectedTeamLoading: false,
        selectedTeamData: null,
        selectedTeamError:
          error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to fetch team data',
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
      const data = await unwrapIpc('team:getData', () => api.teams.getData(teamName));
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
      set({
        selectedTeamError:
          error instanceof IpcError
            ? error.message
            : error instanceof Error
              ? error.message
              : 'Failed to refresh team data',
      });
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

  updateTaskStatus: async (teamName: string, taskId: string, status: TeamTaskStatus) => {
    await unwrapIpc('team:updateTaskStatus', () =>
      api.teams.updateTaskStatus(teamName, taskId, status)
    );
    await get().refreshTeamData(teamName);
  },

  deleteTeam: async (teamName: string) => {
    await unwrapIpc('team:deleteTeam', () => api.teams.deleteTeam(teamName));
    const state = get();
    if (state.selectedTeamName === teamName) {
      set({ selectedTeamName: null, selectedTeamData: null, selectedTeamError: null });
    }
    await get().fetchTeams();
  },

  createTeam: async (request: TeamCreateRequest) => {
    set({ provisioningError: null });
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
      await get().getProvisioningStatus(response.runId);
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

  getProvisioningStatus: async (runId: string) => {
    const progress = await unwrapIpc('team:provisioningStatus', () =>
      api.teams.getProvisioningStatus(runId)
    );
    get().onProvisioningProgress(progress);
  },

  cancelProvisioning: async (runId: string) => {
    await unwrapIpc('team:cancelProvisioning', () => api.teams.cancelProvisioning(runId));
  },

  onProvisioningProgress: (progress: TeamProvisioningProgress) => {
    set((state) => ({
      provisioningRuns: {
        ...state.provisioningRuns,
        [progress.runId]: progress,
      },
      activeProvisioningRunId: progress.runId,
      provisioningError: progress.state === 'failed' ? (progress.error ?? null) : null,
    }));

    if (progress.state === 'ready' || progress.state === 'disconnected') {
      void get().fetchTeams();
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
