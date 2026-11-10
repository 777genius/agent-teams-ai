/**
 * UI slice - manages command palette and sidebar state.
 */

import type { AppState } from '../types';
import type { StateCreator } from 'zustand';

// =============================================================================
// Slice Interface
// =============================================================================

export interface UISlice {
  // State
  commandPaletteOpen: boolean;
  sidebarCollapsed: boolean;

  // Actions
  openCommandPalette: () => void;
  closeCommandPalette: () => void;
  toggleSidebar: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createUISlice: StateCreator<AppState, [], [], UISlice> = (set) => ({
  // Initial state
  commandPaletteOpen: false,
  sidebarCollapsed: false,

  // Command palette actions
  openCommandPalette: () => {
    set({ commandPaletteOpen: true });
  },

  closeCommandPalette: () => {
    set({ commandPaletteOpen: false });
  },

  // Sidebar actions
  toggleSidebar: () => {
    set((state) => ({ sidebarCollapsed: !state.sidebarCollapsed }));
  },
});
