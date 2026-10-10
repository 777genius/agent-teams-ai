import { useStore } from '@renderer/store';
import { invalidateContextScopedRequestEpoch } from '@renderer/store/utils/contextScopedRequestEpoch';
import {
  getContextScopedTeamResetState,
  getFullResetState,
} from '@renderer/store/utils/stateResetHelpers';

export function resetWorkspaceForRootChange(): void {
  invalidateContextScopedRequestEpoch();
  useStore.setState({
    projects: [],
    repositoryGroups: [],
    openTabs: [],
    activeTabId: null,
    selectedTabIds: [],
    paneLayout: {
      panes: [
        {
          id: 'pane-default',
          tabs: [],
          activeTabId: null,
          selectedTabIds: [],
          widthFraction: 1,
        },
      ],
      focusedPaneId: 'pane-default',
    },
    ...getFullResetState(),
    ...getContextScopedTeamResetState(),
  });
}
