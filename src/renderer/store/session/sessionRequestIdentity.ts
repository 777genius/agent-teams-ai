import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '../utils/contextScopedRequestEpoch';
import { getAllTabs } from '../utils/paneHelpers';

import type { AppState } from '../types';

export function captureSessionConnectionScope(state: AppState): string {
  // SessionAPI currently reads Claude transcripts only. Include its configurable
  // provider root as well as the transport identity, including reconnect epochs.
  return JSON.stringify([
    'claude',
    state.appConfig?.general?.claudeRootPath ?? null,
    state.activeContextId,
    state.connectionMode,
    state.connectionState,
    state.connectedHost,
  ]);
}

function tabScope(state: AppState, tabId: string): string | null {
  const tab = getAllTabs(state.paneLayout).find((candidate) => candidate.id === tabId);
  return tab
    ? JSON.stringify([tab.type, tab.createdAt, tab.projectId, tab.sessionId, tab.teamName])
    : null;
}

export function createSessionRequestIdentity(get: () => AppState) {
  const requests = new Map<string, symbol>();
  const lifetimes = new Map<string, symbol>();
  function captureScope(projectId: string, sessionId?: string, tabId?: string) {
    const state = get();
    const epoch = captureContextScopedRequestEpoch();
    const connection = captureSessionConnectionScope(state);
    const ownerTab = tabId ? getAllTabs(state.paneLayout).find((tab) => tab.id === tabId) : null;
    const owner = tabId ? tabScope(state, tabId) : null;
    const requestMatchesOwner =
      ownerTab?.type !== 'session' ||
      (ownerTab.projectId === projectId && ownerTab.sessionId === sessionId);
    const lifetime = tabId ? (lifetimes.get(tabId) ?? Symbol('tab-instance')) : null;
    if (tabId && lifetime) lifetimes.set(tabId, lifetime);
    return () => {
      const latest = get();
      if (
        !isContextScopedRequestEpochCurrent(epoch) ||
        captureSessionConnectionScope(latest) !== connection
      ) {
        return false;
      }
      // Inactive tabs remain valid. A missing or replaced owner never does.
      if (tabId)
        return (
          requestMatchesOwner &&
          owner !== null &&
          lifetimes.get(tabId) === lifetime &&
          tabScope(latest, tabId) === owner
        );
      return (
        latest.selectedProjectId === projectId &&
        (sessionId === undefined || latest.selectedSessionId === sessionId)
      );
    };
  }
  return {
    captureScope,
    captureLatestFetchScope(projectId: string, sessionId: string, tabId?: string) {
      const key = tabId ?? '__global__';
      const fetchToken = requests.get(key);
      const scopeCurrent = captureScope(projectId, sessionId, tabId);
      return () => requests.get(key) === fetchToken && scopeCurrent();
    },
    contextKey: () =>
      JSON.stringify([captureContextScopedRequestEpoch(), captureSessionConnectionScope(get())]),
    begin(projectId: string, sessionId: string, tabId?: string) {
      const key = tabId ?? '__global__';
      const token = Symbol('session-request');
      const scopeCurrent = captureScope(projectId, sessionId, tabId);
      if (!scopeCurrent()) return () => false;
      requests.set(key, token);
      return () => requests.get(key) === token && scopeCurrent();
    },
    invalidate(tabId: string) {
      requests.delete(tabId);
      lifetimes.delete(tabId);
    },
    viewing(projectId: string, sessionId: string, tabId?: string) {
      const state = get();
      const active = state.getActiveTab();
      if (tabId && active?.id !== tabId) return false;
      return active?.type === 'session'
        ? active.projectId === projectId && active.sessionId === sessionId
        : state.selectedProjectId === projectId && state.selectedSessionId === sessionId;
    },
  };
}
