import { selectTeamDataForName } from './team/teamDataSelectors';

import type { AppState } from './types';

type ViewedTeamStore = {
  getState: () => AppState;
  subscribe: (listener: (state: AppState, prevState: AppState) => void) => () => void;
};

export function getFocusedVisibleTeamName(state: AppState): string | null {
  const focusedPane = state.paneLayout.panes.find(
    (pane) => pane.id === state.paneLayout.focusedPaneId
  );
  if (!focusedPane?.activeTabId) {
    return null;
  }

  const activeTab = focusedPane.tabs.find((tab) => tab.id === focusedPane.activeTabId);
  if ((activeTab?.type !== 'team' && activeTab?.type !== 'graph') || !activeTab.teamName) {
    return null;
  }

  if (!selectTeamDataForName(state, activeTab.teamName)) {
    return null;
  }

  return activeTab.teamName;
}

export function startViewedTeamNotificationSync(store: ViewedTeamStore): () => void {
  let lastViewedTeamForNotifications: string | null | undefined;
  const sync = (state: AppState = store.getState()): void => {
    const focused = getFocusedVisibleTeamName(state);
    if (focused === lastViewedTeamForNotifications) {
      return;
    }
    lastViewedTeamForNotifications = focused;
    void state.setViewedTeamForNotifications(focused);
  };

  sync();
  return store.subscribe((state, prevState) => {
    if (
      state.paneLayout === prevState.paneLayout &&
      state.selectedTeamName === prevState.selectedTeamName &&
      state.selectedTeamData === prevState.selectedTeamData &&
      state.teamDataCacheByName === prevState.teamDataCacheByName
    ) {
      return;
    }
    sync(state);
  });
}
