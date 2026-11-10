/**
 * Pure utility functions for immutable pane manipulation.
 * All functions return new objects (no mutation).
 */

import type { Pane, PaneLayout } from '@renderer/types/panes';
import type { Tab } from '@renderer/types/tabs';

/**
 * Find a pane by its ID.
 */
export function findPane(layout: PaneLayout, paneId: string): Pane | undefined {
  return layout.panes.find((p) => p.id === paneId);
}

/**
 * Find which pane contains a given tab.
 */
export function findPaneByTabId(layout: PaneLayout, tabId: string): Pane | undefined {
  return layout.panes.find((p) => p.tabs.some((t) => t.id === tabId));
}

/**
 * Replace a pane immutably in the layout.
 */
export function updatePane(layout: PaneLayout, updatedPane: Pane): PaneLayout {
  return {
    ...layout,
    panes: layout.panes.map((p) => (p.id === updatedPane.id ? updatedPane : p)),
  };
}

/**
 * Remove a pane and redistribute its width to a neighbor.
 * If removing the focused pane, focus shifts to the nearest neighbor.
 */
export function removePane(layout: PaneLayout, paneId: string): PaneLayout {
  const index = layout.panes.findIndex((p) => p.id === paneId);
  if (index === -1 || layout.panes.length <= 1) return layout;

  const removedPane = layout.panes[index];
  const newPanes = layout.panes.filter((p) => p.id !== paneId);

  // Redistribute width to the nearest neighbor
  const neighborIndex = index > 0 ? index - 1 : 0;
  const redistributed = newPanes.map((p, i) =>
    i === neighborIndex ? { ...p, widthFraction: p.widthFraction + removedPane.widthFraction } : p
  );

  // Equalize to avoid floating point drift
  const equalized = redistributeWidths(redistributed);

  // Update focus if the removed pane was focused
  let newFocusedId = layout.focusedPaneId;
  if (layout.focusedPaneId === paneId) {
    const focusTarget = equalized[Math.min(index, equalized.length - 1)];
    newFocusedId = focusTarget.id;
  }

  return {
    panes: equalized,
    focusedPaneId: newFocusedId,
  };
}

/**
 * Insert a new pane adjacent to an existing pane.
 */
export function insertPane(
  layout: PaneLayout,
  adjacentPaneId: string,
  newPane: Pane,
  direction: 'left' | 'right'
): PaneLayout {
  const index = layout.panes.findIndex((p) => p.id === adjacentPaneId);
  if (index === -1) return layout;

  const insertAt = direction === 'right' ? index + 1 : index;
  const newPanes = [...layout.panes];
  newPanes.splice(insertAt, 0, newPane);

  return {
    ...layout,
    panes: redistributeWidths(newPanes),
  };
}

/**
 * Equalize widths across all panes so they sum to 1.
 */
function redistributeWidths(panes: Pane[]): Pane[] {
  if (panes.length === 0) return panes;
  const fraction = 1 / panes.length;
  return panes.map((p) => ({ ...p, widthFraction: fraction }));
}

/**
 * Extract the focused pane's tab state for root-level sync.
 */
export function syncFocusedPaneState(layout: PaneLayout): {
  openTabs: Tab[];
  activeTabId: string | null;
  selectedTabIds: string[];
} {
  const focused = findPane(layout, layout.focusedPaneId);
  if (!focused) {
    return { openTabs: [], activeTabId: null, selectedTabIds: [] };
  }
  return {
    openTabs: focused.tabs,
    activeTabId: focused.activeTabId,
    selectedTabIds: focused.selectedTabIds,
  };
}

/**
 * Get all tabs across all panes (flat list).
 */
export function getAllTabs(layout: PaneLayout): Tab[] {
  return layout.panes.flatMap((p) => p.tabs);
}

/**
 * Create a new empty pane with a unique ID.
 */
export function createEmptyPane(id: string): Pane {
  return {
    id,
    tabs: [],
    activeTabId: null,
    selectedTabIds: [],
    widthFraction: 0,
  };
}
