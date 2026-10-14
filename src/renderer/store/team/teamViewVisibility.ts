import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import type { AppState } from '../types';

export const getVisibleTeamNamesInAnyPane = (state: Pick<AppState, 'paneLayout'>): Set<string> => {
  const { paneLayout } = state;
  const visibleTeamNames = new Set<string>();
  for (const pane of paneLayout.panes) {
    if (!pane.activeTabId) continue;
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    if (
      ((activeTab && isOrdinaryTeamTab(activeTab)) || activeTab?.type === 'graph') &&
      activeTab.teamName != null
    ) {
      visibleTeamNames.add(activeTab.teamName);
    }
  }
  return visibleTeamNames;
};
