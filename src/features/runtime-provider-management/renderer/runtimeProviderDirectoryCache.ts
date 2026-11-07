import { useCallback, useSyncExternalStore } from 'react';

import type { RuntimeProviderDirectoryEntryDto } from '../contracts';

export interface RuntimeProviderDirectoryCacheSnapshot {
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  fetchedAt: string;
  authoritative: boolean;
  totalCount?: number | null;
  nextCursor?: string | null;
  runtimeRevision?: string | null;
  lastSummaryFetchedAt?: string;
}

interface PublishRuntimeProviderDirectoryCacheInput {
  projectPath?: string | null;
  entries: readonly RuntimeProviderDirectoryEntryDto[];
  fetchedAt: string;
  authoritative: boolean;
  runtimeRevision?: string | null;
  totalCount?: number | null;
  nextCursor?: string | null;
  readToken?: string;
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
let observedRuntimeRevision: string | null = null;
let invalidationEpoch = 0;
const generationByScope = new Map<string, number>;

/** Reject directory reads started before a credential mutation. */
export function getRuntimeProviderDirectoryReadToken(projectPath?: string | null): string {
  return `${invalidationEpoch}:${generationByScope.get(getScopeKey(projectPath)) ?? 0}`;
}

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

  const entries = Array.from(entryByProviderId.values());
  const snapshot: RuntimeProviderDirectoryCacheSnapshot = {
    entries,
    fetchedAt:
      getFetchedAtTimestamp(projectSnapshot.fetchedAt) >=
      getFetchedAtTimestamp(globalSnapshot.fetchedAt)
        ? projectSnapshot.fetchedAt
        : globalSnapshot.fetchedAt,
    authoritative: projectSnapshot.authoritative && globalSnapshot.authoritative,
    totalCount: projectSnapshot.totalCount ?? entries.length,
    nextCursor: projectSnapshot.nextCursor ?? null,
  };
  mergedFallbackByScope.set(scopeKey, {
    projectSource: projectSnapshot,
    globalSource: globalSnapshot,
    snapshot,
  });
  return snapshot;
}

export function getRuntimeProviderDirectoryCacheSnapshot(
  projectPath?: string | null,
  expectedRuntimeRevision?: string | null
): RuntimeProviderDirectoryCacheSnapshot | null {
  const snapshot = snapshotsByScope.get(getScopeKey(projectPath)) ?? EMPTY_SNAPSHOT;
  return expectedRuntimeRevision && snapshot?.runtimeRevision !== expectedRuntimeRevision
    ? null
    : snapshot;
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
  totalCount,
  nextCursor,
  runtimeRevision,
  readToken,
}: PublishRuntimeProviderDirectoryCacheInput): void {
  if (readToken !== undefined && readToken !== getRuntimeProviderDirectoryReadToken(projectPath)) return;
  if (runtimeRevision && observedRuntimeRevision && runtimeRevision !== observedRuntimeRevision) {
    return; // An in-flight response from a replaced binary is stale.
  }
  const scopeKey = getScopeKey(projectPath);
  const current = snapshotsByScope.get(scopeKey);
  const nextFetchedAt = getFetchedAtTimestamp(fetchedAt);
  const currentFetchedAt = current ? getFetchedAtTimestamp(current.fetchedAt) : 0;
  const matchingRevision =
    !current || current.runtimeRevision === (runtimeRevision ?? observedRuntimeRevision);
  if (
    current &&
    matchingRevision &&
    nextFetchedAt <
      Math.max(currentFetchedAt, getFetchedAtTimestamp(current.lastSummaryFetchedAt ?? ''))
  ) return;
  const retainFullDirectory = matchingRevision && current?.authoritative && !authoritative;
  const summaryByProvider = retainFullDirectory
    ? new Map(entries.map((entry) => [entry.providerId, entry] as const))
    : null;
  const nextEntries = summaryByProvider
    ? (current?.entries ?? []).map((entry) => {
        const latest = summaryByProvider.get(entry.providerId);
        if (!latest) return entry;
        const connectionChanged =
          entry.state !== latest.state ||
          entry.setupKind !== latest.setupKind ||
          entry.connectedAuthHint !== latest.connectedAuthHint ||
          entry.ownership.length !== latest.ownership.length ||
          entry.ownership.some((owner) => !latest.ownership.includes(owner));
        return {
          ...entry,
          state: latest.state,
          setupKind: latest.setupKind,
          connectedAuthHint: latest.connectedAuthHint,
          ownership: latest.ownership,
          // Passive summaries have fewer capabilities. Keep live actions until
          // connection changes make those actions stale (for example, logout).
          actions: connectionChanged ? latest.actions : entry.actions,
        };
      })
    : entries;
  const nextSnapshot: RuntimeProviderDirectoryCacheSnapshot = {
    entries: nextEntries,
    fetchedAt: retainFullDirectory ? (current?.fetchedAt ?? fetchedAt) : fetchedAt,
    authoritative: retainFullDirectory ? true : authoritative,
    runtimeRevision: runtimeRevision ?? observedRuntimeRevision,
    ...(retainFullDirectory ? { lastSummaryFetchedAt: fetchedAt } : {}),
    ...(retainFullDirectory
      ? { totalCount: current?.totalCount, nextCursor: current?.nextCursor }
      : {
          ...(totalCount !== undefined ? { totalCount } : {}),
          ...(nextCursor !== undefined ? { nextCursor } : {}),
        }),
  };
  if (scopeKey === GLOBAL_SCOPE_KEY) {
    mergedFallbackByScope.clear();
  } else {
    mergedFallbackByScope.delete(scopeKey);
  }
  touchScope(scopeKey, nextSnapshot);
  notifyScope(scopeKey);
}

/** Retain cached entries but withdraw exact-count authority when a confirmed
 * credential mutation cannot be reconciled with the runtime directory. */
/** Fence reads begun before a credential mutation, without losing verified rows. */
export function invalidateRuntimeProviderDirectoryScopeReads(projectPath?: string | null): void {
  const scopeKey = getScopeKey(projectPath);
  generationByScope.set(scopeKey, (generationByScope.get(scopeKey) ?? 0) + 1);
}

export function markRuntimeProviderDirectoryScopeUnverified(projectPath?: string | null): void {
  invalidateRuntimeProviderDirectoryScopeReads(projectPath);
  const scopeKey = getScopeKey(projectPath);
  const current = snapshotsByScope.get(scopeKey);
  if (!current?.authoritative) return;
  touchScope(scopeKey, { ...current, authoritative: false });
  mergedFallbackByScope.clear();
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

/** The last settled revision survives hook unmounts; changes invalidate every scope. */
export function observeRuntimeProviderDirectoryRevision(revision: string | null): void {
  if (!revision || revision === observedRuntimeRevision) return;
  if (observedRuntimeRevision !== null) invalidateRuntimeProviderDirectoryCache();
  observedRuntimeRevision = revision;
}

/** Drop provider inventory when the installed OpenCode runtime identity changes. */
export function invalidateRuntimeProviderDirectoryCache(): void {
  invalidationEpoch += 1;
  generationByScope.clear();
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

export function resetRuntimeProviderDirectoryCacheForTests(): void {
  invalidateRuntimeProviderDirectoryCache();
  observedRuntimeRevision = null;
}
