/**
 * Connection Slice - Manages SSH connection state.
 *
 * Tracks connection mode (local/ssh), connection state,
 * and provides actions for connecting/disconnecting.
 */

import { api } from '@renderer/api';

import { invalidateContextScopedRequestEpoch } from '../utils/contextScopedRequestEpoch';
import { getContextScopedTeamResetState, getFullResetState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type {
  SshConfigHostEntry,
  SshConnectionConfig,
  SshConnectionState,
  SshLastConnection,
} from '@shared/types';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface ConnectionSlice {
  // State
  connectionMode: 'local' | 'ssh';
  connectionState: SshConnectionState;
  connectedHost: string | null;
  connectionError: string | null;
  sshConfigHosts: SshConfigHostEntry[];
  lastSshConfig: SshLastConnection | null;

  // Actions
  connectSsh: (config: SshConnectionConfig) => Promise<void>;
  disconnectSsh: () => Promise<void>;
  testConnection: (config: SshConnectionConfig) => Promise<{ success: boolean; error?: string }>;
  setConnectionStatus: (
    state: SshConnectionState,
    host: string | null,
    error: string | null
  ) => void;
  fetchSshConfigHosts: () => Promise<void>;
  resolveConfigHost: (alias: string) => Promise<SshConfigHostEntry | null>;
  loadLastConnection: () => Promise<void>;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createConnectionSlice: StateCreator<AppState, [], [], ConnectionSlice> = (
  set,
  get
) => ({
  // Initial state
  connectionMode: 'local',
  connectionState: 'disconnected',
  connectedHost: null,
  connectionError: null,
  sshConfigHosts: [],
  lastSshConfig: null,

  // Actions
  connectSsh: async (config: SshConnectionConfig): Promise<void> => {
    set({
      connectionState: 'connecting',
      connectedHost: config.host,
      connectionError: null,
    });

    try {
      const status = await api.ssh.connect(config);
      if (status.state === 'connected') {
        invalidateContextScopedRequestEpoch();
      }
      set({
        connectionMode: status.state === 'connected' ? 'ssh' : 'local',
        connectionState: status.state,
        connectedHost: status.host,
        connectionError: status.error,
        // On connect: sync context ID + clear all stale local data including tabs
        ...(status.state === 'connected'
          ? {
              activeContextId: `ssh-${config.host}`,
              projects: [],
              repositoryGroups: [],
              openTabs: [],
              activeTabId: null,
              selectedTabIds: [],
              paneLayout: {
                panes: [
                  {
                    id: 'pane-default',
                    tabs: [],
                    activeTabId: null,
                    selectedTabIds: [],
                    widthFraction: 1,
                  },
                ],
                focusedPaneId: 'pane-default',
              },
              ...getFullResetState(),
              ...getContextScopedTeamResetState(),
            }
          : {}),
      });

      // Re-fetch all data and persist config when connected
      if (status.state === 'connected') {
        const state = get();
        void state.fetchProjects();
        void state.fetchRepositoryGroups();
        void state.fetchTeams();
        void state.fetchAllTasks();

        // Save connection config (without password) for form pre-fill on next launch
        const saved: SshLastConnection = {
          host: config.host,
          port: config.port,
          username: config.username,
          authMethod: config.authMethod,
          privateKeyPath: config.privateKeyPath,
        };
        set({ lastSshConfig: saved });
        void api.ssh.saveLastConnection(saved);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({
        connectionState: 'error',
        connectionError: message,
      });
    }
  },

  disconnectSsh: async (): Promise<void> => {
    try {
      const status = await api.ssh.disconnect();
      invalidateContextScopedRequestEpoch();
      set({
        connectionMode: 'local',
        connectionState: status.state,
        connectedHost: null,
        connectionError: null,
        activeContextId: 'local',
        // Clear all stale SSH data including tabs so dashboard shows fresh local data
        projects: [],
        repositoryGroups: [],
        openTabs: [],
        activeTabId: null,
        selectedTabIds: [],
        paneLayout: {
          panes: [
            {
              id: 'pane-default',
              tabs: [],
              activeTabId: null,
              selectedTabIds: [],
              widthFraction: 1,
            },
          ],
          focusedPaneId: 'pane-default',
        },
        ...getFullResetState(),
        ...getContextScopedTeamResetState(),
      });

      // Re-fetch local data
      const state = get();
      void state.fetchProjects();
      void state.fetchRepositoryGroups();
      void state.fetchTeams();
      void state.fetchAllTasks();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      set({ connectionError: message });
    }
  },

  testConnection: async (
    config: SshConnectionConfig
  ): Promise<{ success: boolean; error?: string }> => {
    try {
      return await api.ssh.test(config);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, error: message };
    }
  },

  setConnectionStatus: (
    state: SshConnectionState,
    host: string | null,
    error: string | null
  ): void => {
    set({
      connectionState: state,
      connectionMode: state === 'connected' ? 'ssh' : 'local',
      connectedHost: host,
      connectionError: error,
    });
  },

  fetchSshConfigHosts: async (): Promise<void> => {
    try {
      const hosts = await api.ssh.getConfigHosts();
      set({ sshConfigHosts: hosts });
    } catch {
      // Gracefully ignore - SSH config may not exist
      set({ sshConfigHosts: [] });
    }
  },

  resolveConfigHost: async (alias: string): Promise<SshConfigHostEntry | null> => {
    try {
      return await api.ssh.resolveHost(alias);
    } catch {
      return null;
    }
  },

  loadLastConnection: async (): Promise<void> => {
    try {
      const saved = await api.ssh.getLastConnection();
      set({ lastSshConfig: saved });
    } catch {
      // Gracefully ignore - no saved connection
    }
  },
});
