/**
 * Subagent slice - manages subagent drill-down state.
 */

import { api } from '@renderer/api';

import type { AppState, BreadcrumbItem } from '../types';
import type { SubagentDetail } from '@renderer/types/data';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface SubagentSlice {
  // State
  drillDownStack: BreadcrumbItem[];
  currentSubagentDetail: SubagentDetail | null;
  subagentDetailLoading: boolean;
  subagentDetailError: string | null;

  // Actions
  drillDownSubagent: (
    projectId: string,
    sessionId: string,
    subagentId: string,
    description: string
  ) => Promise<void>;
  navigateToBreadcrumb: (index: number) => void;
  closeSubagentModal: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createSubagentSlice: StateCreator<AppState, [], [], SubagentSlice> = (set, get) => ({
  // Initial state
  drillDownStack: [],
  currentSubagentDetail: null,
  subagentDetailLoading: false,
  subagentDetailError: null,

  // Drill down into a subagent
  drillDownSubagent: async (
    projectId: string,
    sessionId: string,
    subagentId: string,
    description: string
  ) => {
    set({ subagentDetailLoading: true, subagentDetailError: null });
    try {
      const detail = await api.getSubagentDetail(projectId, sessionId, subagentId);

      if (!detail) {
        set({
          subagentDetailError: 'Failed to load subagent details',
          subagentDetailLoading: false,
        });
        return;
      }

      // Add to breadcrumb stack
      const currentStack = get().drillDownStack;
      set({
        drillDownStack: [...currentStack, { id: subagentId, description }],
        currentSubagentDetail: detail,
        subagentDetailLoading: false,
      });
    } catch (error) {
      set({
        subagentDetailError: error instanceof Error ? error.message : 'Failed to load subagent',
        subagentDetailLoading: false,
      });
    }
  },

  // Navigate to a specific breadcrumb (pop stack to that level)
  navigateToBreadcrumb: (index: number) => {
    const state = get();

    // If navigating to index 0 or negative, close modal
    if (index <= 0) {
      set({
        drillDownStack: [],
        currentSubagentDetail: null,
        subagentDetailError: null,
      });
      return;
    }

    // Pop stack to the specified index
    const newStack = state.drillDownStack.slice(0, index);

    if (newStack.length === 0) {
      set({
        drillDownStack: [],
        currentSubagentDetail: null,
        subagentDetailError: null,
      });
      return;
    }

    // Reload detail for the target level
    const targetItem = newStack[newStack.length - 1];
    const projectId = state.selectedProjectId;
    const sessionId = state.selectedSessionId;

    if (!projectId || !sessionId) return;

    set({ subagentDetailLoading: true, subagentDetailError: null });

    api
      .getSubagentDetail(projectId, sessionId, targetItem.id)
      .then((detail) => {
        if (detail) {
          set({
            drillDownStack: newStack,
            currentSubagentDetail: detail,
            subagentDetailLoading: false,
          });
        } else {
          set({
            subagentDetailError: 'Failed to load subagent details',
            subagentDetailLoading: false,
          });
        }
      })
      .catch((error) => {
        set({
          subagentDetailError: error instanceof Error ? error.message : 'Failed to load subagent',
          subagentDetailLoading: false,
        });
      });
  },

  // Close the subagent modal
  closeSubagentModal: () => {
    set({
      drillDownStack: [],
      currentSubagentDetail: null,
      subagentDetailError: null,
    });
  },
});
