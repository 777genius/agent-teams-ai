import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  useRetainedLegacyInstallers,
  useRetainedLegacyLaunch,
  useRetainedLegacyRuntimeStatus,
} from '@features/agent-backend/renderer';
import {
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickConnectRuntimeRevision,
  useRuntimeProviderQuickConnect,
} from '@features/runtime-provider-management/renderer';
import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
  subscribeContextScopedRequestEpoch,
} from '@renderer/store/utils/contextScopedRequestEpoch';

import type { CliProviderStatus } from '@shared/types';
import type { JSX, ReactNode } from 'react';

type SourceDirectory = ReturnType<typeof useRuntimeProviderQuickConnect> & {
  readonly enabled: boolean;
  readonly projectPath: string | null;
  readonly retainDiscovery?: () => () => void;
};

export const OpenCodeSourceDirectoryContext = createContext<SourceDirectory | null>(null);

export function useOpenCodeSourceDirectory(
  projectPath: string | null,
  requestDiscovery = false
): SourceDirectory | null {
  const discovery = useContext(OpenCodeSourceDirectoryContext);
  const current = discovery?.enabled && discovery.projectPath === projectPath ? discovery : null;
  const retainDiscovery = current?.retainDiscovery;
  useEffect(
    () => (requestDiscovery ? retainDiscovery?.() : undefined),
    [requestDiscovery, retainDiscovery]
  );
  return current;
}

export function useScopedOpenCodeStatus(projectPath: string): CliProviderStatus | null {
  const retained = useRetainedLegacyLaunch();
  const original = useRetainedLegacyRuntimeStatus(projectPath);
  const stored = useStore((state) =>
    projectPath
      ? (state.cliProviderStatusByScope?.[getCliProviderStatusScopeKey('opencode', projectPath)] ??
        null)
      : null
  );
  return retained
    ? (original.status?.providers.find((p) => p.providerId === 'opencode') ?? null)
    : stored;
}

/** One summary-only source lookup per dialog, not per team member. */
export const OpenCodeSourceDirectoryProvider = ({
  children,
  enabled,
  projectPath,
  deferDiscovery = false,
}: Readonly<{
  children: ReactNode;
  enabled: boolean;
  projectPath: string | null | undefined;
  /** Display-only discovery may wait for a mounted model picker or explicit refresh. */
  deferDiscovery?: boolean;
}>): JSX.Element => {
  const retained = useRetainedLegacyLaunch();
  const original = useRetainedLegacyRuntimeStatus(projectPath, enabled);
  const installers = useRetainedLegacyInstallers();
  const normalizedPath = projectPath?.trim() || null;
  const storedRuntimeStatus = useStore((state) => state.openCodeRuntimeStatus ?? null);
  const storedRuntimeStatusLoading = useStore(
    (state) => state.openCodeRuntimeStatusLoading === true
  );
  const storedRuntimeError = useStore((state) => state.openCodeRuntimeError ?? null);
  const fetchRuntimeStatus = useStore((state) => state.fetchOpenCodeRuntimeStatus);
  const storedCliStatusLoading = useStore((state) => state.cliStatusLoading === true);
  const storedProvider = useStore(
    (state) => state.cliStatus?.providers.find((item) => item.providerId === 'opencode') ?? null
  );
  const provider = retained
    ? (original.status?.providers.find((p) => p.providerId === 'opencode') ?? null)
    : storedProvider;
  const runtimeStatus = retained ? installers.opencode : storedRuntimeStatus;
  const runtimeStatusLoading = retained ? installers.loading : storedRuntimeStatusLoading;
  const runtimeError = retained ? installers.error : storedRuntimeError;
  const cliStatusLoading = retained ? original.loading : storedCliStatusLoading;
  useEffect(() => {
    if (
      !retained &&
      enabled &&
      !runtimeStatus &&
      !runtimeStatusLoading &&
      !runtimeError &&
      typeof fetchRuntimeStatus === 'function'
    ) {
      void fetchRuntimeStatus();
    }
  }, [retained, enabled, fetchRuntimeStatus, runtimeError, runtimeStatus, runtimeStatusLoading]);

  const gate = resolveOpenCodeQuickConnectGate({
    runtimeStatus,
    runtimeStatusLoading,
    provider,
    cliStatusLoading,
  });
  const runtimeRevision = retained
    ? retained.choice.scopeId
    : resolveOpenCodeQuickConnectRuntimeRevision({ gate, runtimeStatus });
  const runtimeReady = enabled && gate === 'ready';
  const checking = enabled && (gate === 'checking' || gate === 'installing');
  const contextEpoch = useSyncExternalStore(
    subscribeContextScopedRequestEpoch,
    captureContextScopedRequestEpoch,
    captureContextScopedRequestEpoch
  );
  const demandScope = useMemo(
    () => ({ enabled, deferDiscovery, normalizedPath, runtimeRevision, retained, contextEpoch }),
    [enabled, deferDiscovery, normalizedPath, runtimeRevision, retained, contextEpoch]
  );
  const currentScope = useRef(demandScope);
  currentScope.current = demandScope;
  const [demand, setDemand] = useState<{
    scope: typeof demandScope;
    consumers: ReadonlySet<symbol>;
    refresh: boolean;
  } | null>(null);
  const scopeIsCurrent = useCallback(
    () =>
      enabled &&
      currentScope.current === demandScope &&
      isContextScopedRequestEpochCurrent(contextEpoch),
    [enabled, demandScope, contextEpoch]
  );
  const retainDiscovery = useCallback(() => {
    if (!scopeIsCurrent()) return () => undefined;
    const consumer = Symbol('source-directory-consumer');
    setDemand((current) => ({
      scope: demandScope,
      consumers: new Set([...(current?.scope === demandScope ? current.consumers : []), consumer]),
      refresh: current?.scope === demandScope && current.refresh,
    }));
    return () =>
      setDemand((current) => {
        if (current?.scope !== demandScope || !current.consumers.has(consumer)) return current;
        const consumers = new Set(current.consumers);
        consumers.delete(consumer);
        return { ...current, consumers };
      });
  }, [demandScope, scopeIsCurrent]);
  const discoveryRequested =
    !deferDiscovery ||
    (demand?.scope === demandScope && (demand.consumers.size > 0 || demand.refresh));
  const directory = useRuntimeProviderQuickConnect({
    enabled: runtimeReady && discoveryRequested,
    projectPath: normalizedPath,
    runtimeRevision,
  });
  const refreshDirectory = directory.refresh;
  const requestRefresh = useCallback(() => {
    if (!scopeIsCurrent()) return;
    setDemand((current) => ({
      scope: demandScope,
      consumers: current?.scope === demandScope ? current.consumers : new Set(),
      refresh: true,
    }));
    refreshDirectory();
  }, [demandScope, refreshDirectory, scopeIsCurrent]);
  const error =
    enabled && !checking && !runtimeReady
      ? (runtimeError ?? runtimeStatus?.error ?? 'OpenCode runtime is not ready.')
      : directory.error;

  return (
    <OpenCodeSourceDirectoryContext.Provider
      value={{
        ...directory,
        loading: checking || directory.loading,
        authoritativePending: checking || (runtimeReady && directory.authoritativePending),
        error,
        enabled,
        projectPath: normalizedPath,
        ...(deferDiscovery ? { retainDiscovery, refresh: requestRefresh } : {}),
      }}
    >
      {children}
    </OpenCodeSourceDirectoryContext.Provider>
  );
};
