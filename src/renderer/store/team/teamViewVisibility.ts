import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import type { AppState } from '../types';

// Multiple panes may show the same owned native project context. Reference
// counting prevents one pane's cleanup from hiding the other pane's updates.
const mountedPhysicalTeams = new Map<string, number>();

/** Register a verified physical team while its logical-team view is active. */
export function registerVisiblePhysicalTeam(teamName: string): () => void {
  if (!teamName) return () => undefined;
  mountedPhysicalTeams.set(teamName, (mountedPhysicalTeams.get(teamName) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const remaining = (mountedPhysicalTeams.get(teamName) ?? 0) - 1;
    if (remaining > 0) mountedPhysicalTeams.set(teamName, remaining);
    else mountedPhysicalTeams.delete(teamName);
  };
}

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
  for (const physicalTeamName of mountedPhysicalTeams.keys()) {
    visibleTeamNames.add(physicalTeamName);
  }
  return visibleTeamNames;
};
