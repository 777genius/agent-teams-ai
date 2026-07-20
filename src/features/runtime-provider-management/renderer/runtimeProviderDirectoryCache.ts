import { useCallback, useSyncExternalStore } from 'react';

import type { RuntimeProviderDirectoryEntryDto } from '../contracts';

export interface RuntimeProviderDirectoryCacheSnapshot {
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  fetchedAt: string;
  authoritative: boolean;
}

interface PublishRuntimeProviderDirectoryCacheInput {
  projectPath?: string | null;
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  fetchedAt: string;
  authoritative: boolean;
}

const GLOBAL_SCOPE_KEY = '\u0000global';
const MAX_CACHED_PROJECT_SCOPES = 8;
const EMPTY_SNAPSHOT: RuntimeProviderDirectoryCacheSnapshot | null = null;
const snapshotsByScope = new Map<string, RuntimeProviderDirectoryCacheSnapshot>();
const listenersByScope = new Map<string, Set<() => void>>();
const mergedFallbackByScope = new Map<
  string,
  {
    projectSource: RuntimeProviderDirectoryCacheSnapshot;
    globalSource: RuntimeProviderDirectoryCacheSnapshot;
    snapshot: RuntimeProviderDirectoryCacheSnapshot;
  }
>();
let globalFallbackSource: RuntimeProviderDirectoryCacheSnapshot | null = null;
let globalFallbackSnapshot: RuntimeProviderDirectoryCacheSnapshot | null = null;

function getScopeKey(projectPath?: string | null): string {
  return projectPath?.trim() || GLOBAL_SCOPE_KEY;
}

function getFetchedAtTimestamp(fetchedAt: string): number {
  const timestamp = Date.parse(fetchedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function pruneInactiveProjectScopes(): void {
  let projectScopeCount = Array.from(snapshotsByScope.keys()).filter(
    (scopeKey) => scopeKey !== GLOBAL_SCOPE_KEY
  ).length;
  while (projectScopeCount > MAX_CACHED_PROJECT_SCOPES) {
    const oldestInactiveScopeKey = Array.from(snapshotsByScope.keys()).find(
      (candidateScopeKey) =>
        candidateScopeKey !== GLOBAL_SCOPE_KEY &&
        (listenersByScope.get(candidateScopeKey)?.size ?? 0) === 0
    );
    if (!oldestInactiveScopeKey) {
      break;
    }
    snapshotsByScope.delete(oldestInactiveScopeKey);
    mergedFallbackByScope.delete(oldestInactiveScopeKey);
    projectScopeCount -= 1;
  }
}

function touchScope(scopeKey: string, snapshot: RuntimeProviderDirectoryCacheSnapshot): void {
  snapshotsByScope.delete(scopeKey);
  snapshotsByScope.set(scopeKey, snapshot);
  pruneInactiveProjectScopes();
}

function notifyScope(scopeKey: string): void {
  for (const listener of listenersByScope.get(scopeKey) ?? []) {
    listener();
  }
}

function subscribeScope(scopeKey: string, listener: () => void): () => void {
  let listeners = listenersByScope.get(scopeKey);
  if (!listeners) {
    listeners = new Set();
    listenersByScope.set(scopeKey, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size === 0) {
      listenersByScope.delete(scopeKey);
      pruneInactiveProjectScopes();
    }
  };
}

function getGlobalFallbackSnapshot(): RuntimeProviderDirectoryCacheSnapshot | null {
  const globalSnapshot = snapshotsByScope.get(GLOBAL_SCOPE_KEY) ?? null;
  if (!globalSnapshot) {
    globalFallbackSource = null;
    globalFallbackSnapshot = null;
    return null;
  }
  if (globalFallbackSource === globalSnapshot) {
    return globalFallbackSnapshot;
  }

  globalFallbackSource = globalSnapshot;
  globalFallbackSnapshot = {
    ...globalSnapshot,
    // Never project a project-only credential into another project. Entries that
    // are also managed remain safe because the global runtime owns that route.
    entries: globalSnapshot.entries.filter(
      (entry) => !entry.ownership.includes('project') || entry.ownership.includes('managed')
    ),
  };
  return globalFallbackSnapshot;
}

function getSnapshotWithGlobalFallback(
  scopeKey: string
): RuntimeProviderDirectoryCacheSnapshot | null {
  if (scopeKey === GLOBAL_SCOPE_KEY) {
    return snapshotsByScope.get(scopeKey) ?? EMPTY_SNAPSHOT;
  }

  const projectSnapshot = snapshotsByScope.get(scopeKey) ?? null;
  const globalSnapshot = getGlobalFallbackSnapshot();
  if (!projectSnapshot) {
    return globalSnapshot;
  }
  if (!globalSnapshot || globalSnapshot.entries.length === 0) {
    return projectSnapshot;
  }

  const cachedMerge = mergedFallbackByScope.get(scopeKey);
  if (
    cachedMerge?.projectSource === projectSnapshot &&
    cachedMerge.globalSource === globalSnapshot
  ) {
    return cachedMerge.snapshot;
  }

  const entryByProviderId = new Map(
    globalSnapshot.entries.map((entry) => [entry.providerId, entry] as const)
  );
  for (const entry of projectSnapshot.entries) {
    entryByProviderId.set(entry.providerId, entry);
  }
  if (entryByProviderId.size === projectSnapshot.entries.length) {
    mergedFallbackByScope.delete(scopeKey);
    return projectSnapshot;
  }

  const snapshot: RuntimeProviderDirectoryCacheSnapshot = {
    entries: Array.from(entryByProviderId.values()),
    fetchedAt:
      getFetchedAtTimestamp(projectSnapshot.fetchedAt) >=
      getFetchedAtTimestamp(globalSnapshot.fetchedAt)
        ? projectSnapshot.fetchedAt
        : globalSnapshot.fetchedAt,
    authoritative: projectSnapshot.authoritative && globalSnapshot.authoritative,
  };
  mergedFallbackByScope.set(scopeKey, {
    projectSource: projectSnapshot,
    globalSource: globalSnapshot,
    snapshot,
  });
  return snapshot;
}

export function getRuntimeProviderDirectoryCacheSnapshot(
  projectPath?: string | null
): RuntimeProviderDirectoryCacheSnapshot | null {
  return snapshotsByScope.get(getScopeKey(projectPath)) ?? EMPTY_SNAPSHOT;
}

export function getRuntimeProviderDirectoryCacheWithGlobalFallbackSnapshot(
  projectPath?: string | null
): RuntimeProviderDirectoryCacheSnapshot | null {
  return getSnapshotWithGlobalFallback(getScopeKey(projectPath));
}

export function publishRuntimeProviderDirectoryCache({
  projectPath,
  entries,
  fetchedAt,
  authoritative,
}: PublishRuntimeProviderDirectoryCacheInput): void {
  const scopeKey = getScopeKey(projectPath);
  const current = snapshotsByScope.get(scopeKey);
  const nextFetchedAt = getFetchedAtTimestamp(fetchedAt);
  const currentFetchedAt = current ? getFetchedAtTimestamp(current.fetchedAt) : 0;

  if (
    current &&
    (nextFetchedAt < currentFetchedAt ||
      (nextFetchedAt === currentFetchedAt && current.authoritative && !authoritative))
  ) {
    return;
  }

  const nextSnapshot: RuntimeProviderDirectoryCacheSnapshot = {
    entries,
    fetchedAt,
    authoritative,
  };
  if (scopeKey === GLOBAL_SCOPE_KEY) {
    mergedFallbackByScope.clear();
  } else {
    mergedFallbackByScope.delete(scopeKey);
  }
  touchScope(scopeKey, nextSnapshot);
  notifyScope(scopeKey);
}

export function useRuntimeProviderDirectoryCache(
  projectPath?: string | null
): RuntimeProviderDirectoryCacheSnapshot | null {
  const scopeKey = getScopeKey(projectPath);
  const subscribe = useCallback(
    (listener: () => void) => subscribeScope(scopeKey, listener),
    [scopeKey]
  );
  const getSnapshot = useCallback(
    () => snapshotsByScope.get(scopeKey) ?? EMPTY_SNAPSHOT,
    [scopeKey]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useRuntimeProviderDirectoryCacheWithGlobalFallback(
  projectPath?: string | null
): RuntimeProviderDirectoryCacheSnapshot | null {
  const scopeKey = getScopeKey(projectPath);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeScope = subscribeScope(scopeKey, listener);
      const unsubscribeGlobal =
        scopeKey === GLOBAL_SCOPE_KEY ? null : subscribeScope(GLOBAL_SCOPE_KEY, listener);
      return () => {
        unsubscribeScope();
        unsubscribeGlobal?.();
      };
    },
    [scopeKey]
  );
  const getSnapshot = useCallback(() => getSnapshotWithGlobalFallback(scopeKey), [scopeKey]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function resetRuntimeProviderDirectoryCacheForTests(): void {
  snapshotsByScope.clear();
  mergedFallbackByScope.clear();
  globalFallbackSource = null;
  globalFallbackSnapshot = null;
  for (const listeners of listenersByScope.values()) {
    for (const listener of listeners) {
      listener();
    }
  }
}
