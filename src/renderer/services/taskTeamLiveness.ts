import { api, isElectronMode } from '@renderer/api';
import { selectSidebarTeamsDerived } from '@renderer/components/sidebar/sidebarTeamSelectors';
import { useStore } from '@renderer/store';

interface AliveSnapshot {
  teams: string[];
  initialized: boolean;
}
const EMPTY: AliveSnapshot = { teams: [], initialized: false };
let snapshot = EMPTY;
const listeners = new Set<() => void>();
let releaseStore: (() => void) | undefined;
let refreshKey: string | undefined;
let generation = 0;

async function readAliveTeams(): Promise<string[] | null> {
  if (!isElectronMode() || !api.teams?.aliveList) return null;
  try {
    return await api.teams.aliveList();
  } catch {
    return null;
  }
}

function refresh(): void {
  const state = useStore.getState();
  const identityKey = selectSidebarTeamsDerived(state.teams).identityKey;
  const readyKey = Object.entries(state.currentProvisioningRunIdByTeam)
    .map(([teamName, runId]) => {
      if (!runId) return null;
      const progress = state.provisioningRuns[runId];
      return progress?.state === 'ready'
        ? `${teamName}:${progress.runId}:${progress.updatedAt}`
        : null;
    })
    .filter(Boolean)
    .join('|');
  const key = JSON.stringify([isElectronMode(), identityKey, readyKey]);
  if (key === refreshKey) return;
  refreshKey = key;
  const requestGeneration = ++generation;
  void readAliveTeams().then((teams) => {
    if (requestGeneration !== generation || !listeners.size || teams === null) return;
    snapshot = { teams, initialized: true };
    for (const listener of listeners) listener();
  });
}

/** One alive-list request lifecycle and authoritative snapshot for all task views. */
export const taskTeamLiveness = {
  getSnapshot: (): AliveSnapshot => snapshot,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    if (listeners.size === 1) {
      releaseStore = useStore.subscribe(refresh);
      refresh();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size) return;
      releaseStore?.();
      releaseStore = undefined;
      refreshKey = undefined;
      generation += 1;
      snapshot = EMPTY;
    };
  },
};
