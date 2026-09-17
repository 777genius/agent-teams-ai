import {
  getFocusedVisibleTeamName,
  startViewedTeamNotificationSync,
} from '@renderer/store/viewedTeamNotificationSync';
import { describe, expect, it, vi } from 'vitest';

import type { AppState } from '@renderer/store/types';

function createState(teamName: string | null): AppState {
  const setViewedTeamForNotifications = vi.fn(async () => undefined);
  return {
    paneLayout: {
      focusedPaneId: 'pane-1',
      panes: [
        {
          id: 'pane-1',
          activeTabId: teamName ? 'tab-team' : 'tab-home',
          selectedTabIds: [],
          widthFraction: 1,
          tabs: teamName
            ? [{ id: 'tab-team', type: 'team', teamName, title: teamName }]
            : [{ id: 'tab-home', type: 'home', title: 'Home' }],
        },
      ],
    },
    selectedTeamName: teamName,
    selectedTeamData: teamName ? ({ teamName } as AppState['selectedTeamData']) : null,
    teamDataCacheByName: teamName ? { [teamName]: { teamName } } : {},
    setViewedTeamForNotifications,
  } as unknown as AppState;
}

describe('viewedTeamNotificationSync', () => {
  it('reads the focused team tab only when that team has loaded data', () => {
    expect(getFocusedVisibleTeamName(createState('mixed-v2150-20260917'))).toBe(
      'mixed-v2150-20260917'
    );
    expect(getFocusedVisibleTeamName(createState(null))).toBeNull();
  });

  it('notifies main once when the focused team changes', () => {
    let state = createState('alpha');
    const store = {
      getState: () => state,
      subscribe(listener: (next: AppState, prev: AppState) => void) {
        this.listener = listener;
        return () => undefined;
      },
      listener: undefined as ((next: AppState, prev: AppState) => void) | undefined,
    };
    startViewedTeamNotificationSync(store);
    expect(state.setViewedTeamForNotifications).toHaveBeenCalledWith('alpha');

    const previous = state;
    state = createState('beta');
    store.listener?.(state, previous);
    expect(state.setViewedTeamForNotifications).toHaveBeenCalledWith('beta');
  });

  it('retries viewed-team sync after a failed IPC write', async () => {
    const setViewedTeamForNotifications = vi.fn(async () => true).mockResolvedValueOnce(false);
    const makeState = (teamName: string): AppState => ({
      ...createState(teamName),
      setViewedTeamForNotifications,
    });
    const state = makeState('alpha');
    const store = {
      getState: () => state,
      subscribe() {
        return () => undefined;
      },
    };
    startViewedTeamNotificationSync(store);
    await Promise.resolve();
    await Promise.resolve();
    expect(setViewedTeamForNotifications).toHaveBeenCalledTimes(2);
  });
});
