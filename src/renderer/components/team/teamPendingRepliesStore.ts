import { useCallback, useSyncExternalStore } from 'react';

import {
  getTeamPendingRepliesState,
  setTeamPendingRepliesState,
} from './sidebar/teamSidebarUiState';

export type PendingRepliesUpdater =
  | Record<string, number>
  | ((current: Record<string, number>) => Record<string, number>);

const pendingRepliesCacheByTeam = new Map<string, Record<string, number>>();
const pendingRepliesListenersByTeam = new Map<string, Set<() => void>>();

function getPendingRepliesSnapshot(teamName: string): Record<string, number> {
  let snapshot = pendingRepliesCacheByTeam.get(teamName);
  if (!snapshot) {
    snapshot = getTeamPendingRepliesState(teamName);
    pendingRepliesCacheByTeam.set(teamName, snapshot);
  }
  return snapshot;
}

function subscribePendingReplies(teamName: string, listener: () => void): () => void {
  let listeners = pendingRepliesListenersByTeam.get(teamName);
  if (!listeners) {
    listeners = new Set();
    pendingRepliesListenersByTeam.set(teamName, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      pendingRepliesListenersByTeam.delete(teamName);
    }
  };
}

export function setPendingRepliesForTeam(teamName: string, updater: PendingRepliesUpdater): void {
  const current = getPendingRepliesSnapshot(teamName);
  const next = typeof updater === 'function' ? updater(current) : updater;
  if (next === current) {
    return;
  }
  pendingRepliesCacheByTeam.set(teamName, next);
  setTeamPendingRepliesState(teamName, next);
  pendingRepliesListenersByTeam.get(teamName)?.forEach((listener) => listener());
}

export function useTeamPendingReplies(teamName: string): Record<string, number> {
  const subscribe = useCallback(
    (listener: () => void) => subscribePendingReplies(teamName, listener),
    [teamName]
  );
  const getSnapshot = useCallback(() => getPendingRepliesSnapshot(teamName), [teamName]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
