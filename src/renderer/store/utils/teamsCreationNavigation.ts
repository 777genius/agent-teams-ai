import { findPane, findPaneByTabId, getAllTabs, updatePane } from './paneHelpers';

import type { PaneLayout } from '@renderer/types/panes';
import type { Tab, TabInput, TeamsCreationSeed } from '@renderer/types/tabs';

interface NavigationState {
  paneLayout: PaneLayout;
  openTab(tab: TabInput): void;
  setActiveTab(tabId: string): void;
}

/** Reuse the same immutable pane update path as other tab mutations. */
export function updateTabInLayout(
  layout: PaneLayout,
  tabId: string,
  updater: (tab: Tab) => Tab
): PaneLayout {
  const pane = findPaneByTabId(layout, tabId);
  if (!pane) return layout;
  return updatePane(layout, {
    ...pane,
    tabs: pane.tabs.map((tab) => (tab.id === tabId ? updater(tab) : tab)),
  });
}

export function navigateToTeamsCreation(
  state: NavigationState,
  setLayout: (layout: PaneLayout) => void,
  seed?: Omit<TeamsCreationSeed, 'id'>,
  replaceExisting = false
): void {
  const layout = state.paneLayout;
  const existingEditor = getAllTabs(layout).find(
    (tab) => tab.type === 'teams' && tab.teamsCreationPage
  );
  if (existingEditor && !replaceExisting) {
    state.setActiveTab(existingEditor.id);
    return;
  }

  const focusedPane = findPane(layout, layout.focusedPaneId);
  const teamsTab = existingEditor ?? focusedPane?.tabs.find((tab) => tab.type === 'teams');
  const nextSeed = seed ? { ...seed, id: crypto.randomUUID() } : undefined;
  if (!teamsTab) {
    state.openTab({
      type: 'teams',
      label: 'Teams',
      teamsCreationPage: true,
      teamsCreationSeed: nextSeed,
    });
    return;
  }
  setLayout(
    updateTabInLayout(layout, teamsTab.id, (tab) => ({
      ...tab,
      teamsCreationPage: true,
      teamsCreationSeed: nextSeed,
    }))
  );
  state.setActiveTab(teamsTab.id);
}

export function leaveTeamsCreation(
  state: NavigationState,
  setLayout: (layout: PaneLayout) => void,
  tabId: string
): void {
  const tab = getAllTabs(state.paneLayout).find((candidate) => candidate.id === tabId);
  if (!tab || tab.type !== 'teams' || !tab.teamsCreationPage) return;
  setLayout(
    updateTabInLayout(state.paneLayout, tabId, (current) => ({
      ...current,
      teamsCreationPage: false,
      teamsCreationSeed: undefined,
    }))
  );
}
