import { api } from '@renderer/api';

import { getVisibleTeamNamesInAnyPane } from './teamViewVisibility';

import type { AppState } from '../types';

interface TaskLogStreamTrackingStore {
  getState: () => AppState;
  subscribe: (listener: (state: AppState, previous: AppState) => void) => () => void;
}

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

export function getTrackedTaskLogStreamTeams(state: AppState): Set<string> {
  if (state.isContextSwitching || !isDocumentVisible()) return new Set();
  const teams = getVisibleTeamNamesInAnyPane(state);
  for (const demand of Object.values(state.taskDetailVisibleDemandById)) {
    if (demand.identity.contextId !== state.activeContextId) continue;
    if (
      demand.resources['log-summary'] !== undefined ||
      demand.resources['log-stream'] !== undefined ||
      demand.resources.activity !== undefined
    ) {
      teams.add(demand.identity.teamName);
    }
  }
  return teams;
}

export function startTaskLogStreamTracking(
  store: TaskLogStreamTrackingStore,
  onTrackingDisabled: (teamName: string) => void
): () => void {
  if (!api.teams?.setTaskLogStreamTracking) return () => undefined;
  let trackedTeamNames = new Set<string>();
  let trackedContextId = store.getState().activeContextId;
  const sync = (): void => {
    const state = store.getState();
    if (trackedContextId !== state.activeContextId) {
      trackedTeamNames.clear();
      trackedContextId = state.activeContextId;
    }
    const nextTrackedTeamNames = getTrackedTaskLogStreamTeams(state);
    for (const teamName of nextTrackedTeamNames) {
      if (!trackedTeamNames.has(teamName)) {
        void api.teams.setTaskLogStreamTracking?.(teamName, true).catch(() => undefined);
      }
    }
    for (const teamName of trackedTeamNames) {
      if (!nextTrackedTeamNames.has(teamName)) {
        void api.teams.setTaskLogStreamTracking?.(teamName, false).catch(() => undefined);
        onTrackingDisabled(teamName);
      }
    }
    trackedTeamNames = nextTrackedTeamNames;
  };

  sync();
  const unsubscribe = store.subscribe((state, previous) => {
    if (
      state.paneLayout === previous.paneLayout &&
      state.taskDetailVisibleDemandById === previous.taskDetailVisibleDemandById &&
      state.activeContextId === previous.activeContextId &&
      state.isContextSwitching === previous.isContextSwitching
    ) {
      return;
    }
    sync();
  });
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', sync);

  return () => {
    unsubscribe();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', sync);
    if (trackedContextId !== store.getState().activeContextId) return;
    for (const teamName of trackedTeamNames) {
      void api.teams.setTaskLogStreamTracking?.(teamName, false).catch(() => undefined);
      onTrackingDisabled(teamName);
    }
    trackedTeamNames.clear();
  };
}
