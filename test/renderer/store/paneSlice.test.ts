/**
 * Tests for the paneSlice - multi-pane split layout state management.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { MAX_PANES } from '../../../src/renderer/types/panes';

import { createTestStore } from './storeTestUtils';

import type { TestStore } from './storeTestUtils';

let store: TestStore;

beforeEach(() => {
  store = createTestStore();
});

describe('paneSlice', () => {
  describe('initial state', () => {
    it('starts with a single default pane', () => {
      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(1);
      expect(paneLayout.panes[0].id).toBe('pane-default');
      expect(paneLayout.panes[0].widthFraction).toBe(1);
      expect(paneLayout.panes[0].tabs).toEqual([]);
      expect(paneLayout.focusedPaneId).toBe('pane-default');
    });
  });

  describe('focusPane', () => {
    it('changes focusedPaneId', () => {
      const state = store.getState();
      // Open a tab first and split to create a second pane
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(2);

      // New pane should be focused after split
      const newPaneId = paneLayout.focusedPaneId;
      expect(newPaneId).not.toBe('pane-default');

      // Focus back to default pane
      store.getState().focusPane('pane-default');
      expect(store.getState().paneLayout.focusedPaneId).toBe('pane-default');
    });

    it('no-ops when already focused', () => {
      const before = store.getState().paneLayout;
      store.getState().focusPane('pane-default');
      expect(store.getState().paneLayout).toBe(before);
    });

    it('no-ops for non-existent pane', () => {
      const before = store.getState().paneLayout;
      store.getState().focusPane('non-existent');
      expect(store.getState().paneLayout).toBe(before);
    });
  });

  describe('splitPane', () => {
    it('creates a new pane with the specified tab to the right', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tabs = store.getState().paneLayout.panes[0].tabs;
      expect(tabs).toHaveLength(2);
      const tab1Id = tabs[0].id;

      state.splitPane('pane-default', tab1Id, 'right');

      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(2);

      // Source pane should have lost the tab
      const sourcePane = paneLayout.panes.find((p) => p.id === 'pane-default');
      expect(sourcePane?.tabs).toHaveLength(1);
      expect(sourcePane?.tabs[0].sessionId).toBe('s2');

      // New pane should have the split tab
      const newPane = paneLayout.panes.find((p) => p.id !== 'pane-default');
      expect(newPane?.tabs).toHaveLength(1);
      expect(newPane?.tabs[0].sessionId).toBe('s1');

      // New pane should be focused
      expect(paneLayout.focusedPaneId).toBe(newPane?.id);

      // Widths should be equal
      expect(sourcePane?.widthFraction).toBeCloseTo(0.5);
      expect(newPane?.widthFraction).toBeCloseTo(0.5);
    });

    it('creates a new pane to the left', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab2Id = store.getState().paneLayout.panes[0].tabs[1].id;
      state.splitPane('pane-default', tab2Id, 'left');

      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(2);

      // New pane should be to the left (index 0)
      const leftPane = paneLayout.panes[0];
      expect(leftPane.tabs[0].sessionId).toBe('s2');
      expect(leftPane.id).toBe(paneLayout.focusedPaneId);
    });

    it('does not exceed MAX_PANES', () => {
      const state = store.getState();
      // Create MAX_PANES tabs
      for (let i = 0; i < MAX_PANES + 1; i++) {
        state.openTab({
          type: 'session',
          sessionId: `s${i}`,
          projectId: 'p1',
          label: `Session ${i}`,
        });
      }

      // Split until we reach MAX_PANES
      for (let i = 0; i < MAX_PANES - 1; i++) {
        const currentState = store.getState();
        const focusedPane = currentState.paneLayout.panes.find(
          (p) => p.id === currentState.paneLayout.focusedPaneId
        );
        if (focusedPane && focusedPane.tabs.length > 1) {
          currentState.splitPane(focusedPane.id, focusedPane.tabs[0].id, 'right');
        }
      }

      const paneCount = store.getState().paneLayout.panes.length;
      expect(paneCount).toBeLessThanOrEqual(MAX_PANES);

      // Attempting to split again should be no-op if at MAX_PANES
      if (paneCount === MAX_PANES) {
        const beforeLayout = store.getState().paneLayout;
        const focusedPane = beforeLayout.panes.find((p) => p.id === beforeLayout.focusedPaneId);
        if (focusedPane && focusedPane.tabs.length > 0) {
          store.getState().splitPane(focusedPane.id, focusedPane.tabs[0].id, 'right');
          expect(store.getState().paneLayout.panes).toHaveLength(MAX_PANES);
        }
      }
    });
  });

  describe('closePane', () => {
    it('removes a pane and redistributes width', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      const newPaneId = store.getState().paneLayout.panes.find((p) => p.id !== 'pane-default')?.id;
      expect(newPaneId).toBeDefined();

      store.getState().closePane(newPaneId!);

      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(1);
      expect(paneLayout.panes[0].widthFraction).toBe(1);
    });

    it('cannot close the last pane', () => {
      store.getState().closePane('pane-default');
      expect(store.getState().paneLayout.panes).toHaveLength(1);
    });

    it('shifts focus to neighbor when closing focused pane', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      // New pane is focused
      const focusedId = store.getState().paneLayout.focusedPaneId;
      expect(focusedId).not.toBe('pane-default');

      // Close the focused pane
      store.getState().closePane(focusedId);

      // Focus should shift to remaining pane
      expect(store.getState().paneLayout.focusedPaneId).toBe('pane-default');
    });
  });

  describe('moveTabToPane', () => {
    it('moves a tab from one pane to another', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });
      state.openTab({ type: 'session', sessionId: 's3', projectId: 'p1', label: 'Session 3' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      const panes = store.getState().paneLayout.panes;
      const newPaneId = panes.find((p) => p.id !== 'pane-default')!.id;

      // Move s2 from pane-default to the new pane
      const tab2Id = panes.find((p) => p.id === 'pane-default')!.tabs[0].id;
      store.getState().moveTabToPane(tab2Id, 'pane-default', newPaneId);

      const updatedPanes = store.getState().paneLayout.panes;
      const sourcePane = updatedPanes.find((p) => p.id === 'pane-default')!;
      const targetPane = updatedPanes.find((p) => p.id === newPaneId)!;

      expect(sourcePane.tabs).toHaveLength(1); // s3 left
      expect(targetPane.tabs).toHaveLength(2); // s1 + s2
    });

    it('auto-closes source pane when last tab is moved out', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      // Now pane-default has s2, new pane has s1
      const newPaneId = store.getState().paneLayout.panes.find((p) => p.id !== 'pane-default')!.id;

      // Move s2 (last tab in pane-default) to new pane
      const tab2Id = store.getState().paneLayout.panes.find((p) => p.id === 'pane-default')!.tabs[0]
        .id;
      store.getState().moveTabToPane(tab2Id, 'pane-default', newPaneId);

      // pane-default should be auto-closed
      const panes = store.getState().paneLayout.panes;
      expect(panes).toHaveLength(1);
      expect(panes[0].id).toBe(newPaneId);
      expect(panes[0].tabs).toHaveLength(2);
    });

    it('no-ops when source and target are the same', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 's1',
        projectId: 'p1',
        label: 'Session 1',
      });
      const tabId = store.getState().paneLayout.panes[0].tabs[0].id;
      const before = store.getState().paneLayout;
      store.getState().moveTabToPane(tabId, 'pane-default', 'pane-default');
      expect(store.getState().paneLayout).toBe(before);
    });
  });

  describe('reorderTabInPane', () => {
    it('reorders tabs within a pane', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });
      state.openTab({ type: 'session', sessionId: 's3', projectId: 'p1', label: 'Session 3' });

      const tabs = store.getState().paneLayout.panes[0].tabs;
      expect(tabs[0].sessionId).toBe('s1');
      expect(tabs[2].sessionId).toBe('s3');

      // Move first tab to last position
      store.getState().reorderTabInPane('pane-default', 0, 2);

      const reordered = store.getState().paneLayout.panes[0].tabs;
      expect(reordered[0].sessionId).toBe('s2');
      expect(reordered[1].sessionId).toBe('s3');
      expect(reordered[2].sessionId).toBe('s1');
    });

    it('no-ops for same index', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 's1',
        projectId: 'p1',
        label: 'Session 1',
      });
      const before = store.getState().paneLayout;
      store.getState().reorderTabInPane('pane-default', 0, 0);
      expect(store.getState().paneLayout).toBe(before);
    });

    it('no-ops for out-of-bounds index', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 's1',
        projectId: 'p1',
        label: 'Session 1',
      });
      const before = store.getState().paneLayout;
      store.getState().reorderTabInPane('pane-default', 0, 5);
      expect(store.getState().paneLayout).toBe(before);
    });
  });

  describe('resizePanes', () => {
    it('adjusts width fractions of adjacent panes', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      // Resize pane-default to 60%
      store.getState().resizePanes('pane-default', 0.6);

      const panes = store.getState().paneLayout.panes;
      const defaultPane = panes.find((p) => p.id === 'pane-default')!;
      const otherPane = panes.find((p) => p.id !== 'pane-default')!;

      expect(defaultPane.widthFraction).toBeCloseTo(0.6);
      expect(otherPane.widthFraction).toBeCloseTo(0.4);
    });

    it('clamps to minimum fraction', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      // Try to make pane-default almost 100% (leaving too little for neighbor)
      store.getState().resizePanes('pane-default', 0.95);

      const panes = store.getState().paneLayout.panes;
      for (const pane of panes) {
        expect(pane.widthFraction).toBeGreaterThanOrEqual(0.1);
      }
    });
  });

  describe('getPaneForTab', () => {
    it('returns the pane ID containing the tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 's1',
        projectId: 'p1',
        label: 'Session 1',
      });
      const tabId = store.getState().paneLayout.panes[0].tabs[0].id;
      expect(store.getState().getPaneForTab(tabId)).toBe('pane-default');
    });

    it('returns null for non-existent tab', () => {
      expect(store.getState().getPaneForTab('non-existent')).toBeNull();
    });
  });

  describe('getAllPaneTabs', () => {
    it('returns all tabs across all panes', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      const allTabs = store.getState().getAllPaneTabs();
      expect(allTabs).toHaveLength(2);
      const sessionIds = allTabs.map((t) => t.sessionId);
      expect(sessionIds).toContain('s1');
      expect(sessionIds).toContain('s2');
    });
  });

  describe('moveTabToNewPane', () => {
    it('creates a new pane and moves the tab there', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.moveTabToNewPane(tab1Id, 'pane-default', 'pane-default', 'right');

      const { paneLayout } = store.getState();
      expect(paneLayout.panes).toHaveLength(2);

      const sourcePane = paneLayout.panes.find((p) => p.id === 'pane-default')!;
      const newPane = paneLayout.panes.find((p) => p.id !== 'pane-default')!;

      expect(sourcePane.tabs).toHaveLength(1);
      expect(sourcePane.tabs[0].sessionId).toBe('s2');
      expect(newPane.tabs).toHaveLength(1);
      expect(newPane.tabs[0].sessionId).toBe('s1');
    });

    it('respects MAX_PANES limit', () => {
      const state = store.getState();
      for (let i = 0; i < MAX_PANES + 1; i++) {
        state.openTab({
          type: 'session',
          sessionId: `s${i}`,
          projectId: 'p1',
          label: `Session ${i}`,
        });
      }

      // Split until MAX_PANES
      for (let i = 0; i < MAX_PANES - 1; i++) {
        const currentState = store.getState();
        const focusedPane = currentState.paneLayout.panes.find(
          (p) => p.id === currentState.paneLayout.focusedPaneId
        );
        if (focusedPane && focusedPane.tabs.length > 1) {
          currentState.splitPane(focusedPane.id, focusedPane.tabs[0].id, 'right');
        }
      }

      const paneCountBefore = store.getState().paneLayout.panes.length;
      if (paneCountBefore >= MAX_PANES) {
        // Attempt should be no-op
        const focusedPane = store
          .getState()
          .paneLayout.panes.find((p) => p.id === store.getState().paneLayout.focusedPaneId);
        if (focusedPane && focusedPane.tabs.length > 0) {
          store
            .getState()
            .moveTabToNewPane(focusedPane.tabs[0].id, focusedPane.id, focusedPane.id, 'right');
          expect(store.getState().paneLayout.panes.length).toBe(paneCountBefore);
        }
      }
    });
  });

  describe('integration with tabSlice', () => {
    it('openTab adds to focused pane', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 's1',
        projectId: 'p1',
        label: 'Session 1',
      });

      const pane = store.getState().paneLayout.panes[0];
      expect(pane.tabs).toHaveLength(1);
      expect(pane.tabs[0].sessionId).toBe('s1');

      // Root-level state should be synced
      expect(store.getState().openTabs).toHaveLength(1);
      expect(store.getState().activeTabId).toBe(pane.tabs[0].id);
    });

    it('closeTab removes from the containing pane', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      const tabToClose = store.getState().paneLayout.panes[0].tabs[0].id;
      store.getState().closeTab(tabToClose);

      const pane = store.getState().paneLayout.panes[0];
      expect(pane.tabs).toHaveLength(1);
      expect(pane.tabs[0].sessionId).toBe('s2');
    });

    it('setActiveTab focuses the pane containing the tab', () => {
      const state = store.getState();
      state.openTab({ type: 'session', sessionId: 's1', projectId: 'p1', label: 'Session 1' });
      state.openTab({ type: 'session', sessionId: 's2', projectId: 'p1', label: 'Session 2' });

      // Split to create two panes
      const tab1Id = store.getState().paneLayout.panes[0].tabs[0].id;
      state.splitPane('pane-default', tab1Id, 'right');

      // Now s2 is in pane-default, s1 is in new pane
      // Focus pane-default
      store.getState().focusPane('pane-default');
      expect(store.getState().paneLayout.focusedPaneId).toBe('pane-default');

      // Set active tab to s1 (in other pane) - should focus that pane
      store.getState().setActiveTab(tab1Id);
      const newPaneId = store.getState().paneLayout.panes.find((p) => p.id !== 'pane-default')?.id;
      expect(store.getState().paneLayout.focusedPaneId).toBe(newPaneId);
    });
  });
});
