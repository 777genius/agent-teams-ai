/**
 * Project slice - manages project list state and selection.
 */

import { api } from '@renderer/api';

import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '../utils/contextScopedRequestEpoch';
import { getSessionResetState } from '../utils/stateResetHelpers';

import type { AppState } from '../types';
import type { Project } from '@renderer/types/data';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface ProjectSlice {
  // State
  projects: Project[];
  selectedProjectId: string | null;
  projectsLoading: boolean;
  projectsInitialized: boolean;
  projectsError: string | null;

  // Actions
  fetchProjects: () => Promise<void>;
  selectProject: (id: string) => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createProjectSlice: StateCreator<AppState, [], [], ProjectSlice> = (set, get) => ({
  // Initial state
  projects: [],
  selectedProjectId: null,
  projectsLoading: false,
  projectsInitialized: false,
  projectsError: null,

  // Fetch all projects from main process
  fetchProjects: async () => {
    // Guard: prevent concurrent fetches (component mount + centralized init chain)
    if (get().projectsLoading) return;
    const requestContextId = get().activeContextId;
    const requestContextEpoch = captureContextScopedRequestEpoch();
    set({ projectsLoading: true, projectsError: null });
    try {
      const projects = await api.getProjects();
      if (
        get().activeContextId !== requestContextId ||
        !isContextScopedRequestEpochCurrent(requestContextEpoch)
      ) {
        return;
      }
      // Sort by most recent session (descending)
      const sorted = [...projects].sort(
        (a, b) => (b.mostRecentSession ?? 0) - (a.mostRecentSession ?? 0)
      );
      set({ projects: sorted, projectsLoading: false, projectsInitialized: true });
    } catch (error) {
      if (
        get().activeContextId !== requestContextId ||
        !isContextScopedRequestEpochCurrent(requestContextEpoch)
      ) {
        return;
      }
      set({
        projectsError: error instanceof Error ? error.message : 'Failed to fetch projects',
        projectsLoading: false,
      });
    }
  },

  // Select a project and fetch its sessions (paginated)
  selectProject: (id: string) => {
    set({
      selectedRepositoryId: null,
      selectedWorktreeId: null,
      selectedProjectId: id,
      activeProjectId: id,
      ...getSessionResetState(),
    });

    // Fetch sessions for this project (paginated)
    void get().fetchSessionsInitial(id);
  },
});
