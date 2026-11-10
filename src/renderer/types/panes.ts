/**
 * Pane type definitions for the multi-pane split layout feature.
 * Supports up to MAX_PANES horizontal panes, each with its own TabBar and tab state.
 */

import type { Tab } from './tabs';

export const MAX_PANES = 4;

/**
 * Represents a single pane in the split layout.
 * Each pane has its own set of tabs and active tab.
 */
export interface Pane {
  /** Unique identifier (UUID) */
  id: string;
  /** Tabs in this pane */
  tabs: Tab[];
  /** Active tab within this pane */
  activeTabId: string | null;
  /** Multi-selected tabs within this pane */
  selectedTabIds: string[];
  /** Width as fraction of total (0-1, sum of all panes = 1) */
  widthFraction: number;
}

/**
 * The overall pane layout state.
 */
export interface PaneLayout {
  /** Ordered left-to-right panes */
  panes: Pane[];
  /** Which pane receives keyboard/sidebar actions */
  focusedPaneId: string;
}
