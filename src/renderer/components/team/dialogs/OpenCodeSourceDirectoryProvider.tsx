import { createContext, useContext, useEffect } from 'react';

import {
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickConnectRuntimeRevision,
} from '@features/runtime-provider-management/core/domain';
import { useRuntimeProviderQuickConnect } from '@features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect';
import { useStore } from '@renderer/store';
import { getCliProviderStatusScopeKey } from '@renderer/store/slices/cliInstallerSlice';

import type { JSX, ReactNode } from 'react';
import type { CliProviderStatus } from '@shared/types';

type SourceDirectory = ReturnType<typeof useRuntimeProviderQuickConnect> & {
  readonly enabled: boolean;
  readonly projectPath: string | null;
};

export const OpenCodeSourceDirectoryContext = createContext<SourceDirectory | null>(null);

export function useOpenCodeSourceDirectory(projectPath: string | null): SourceDirectory | null {
  const discovery = useContext(OpenCodeSourceDirectoryContext);
  return discovery?.enabled && discovery.projectPath === projectPath ? discovery : null;
}

export function useScopedOpenCodeStatus(projectPath: string): CliProviderStatus | null {
  return useStore((state) =>
    projectPath
      ? (state.cliProviderStatusByScope?.[
          getCliProviderStatusScopeKey('opencode', projectPath)
        ] ?? null)
      : null
  );
}

/** One summary-only source lookup per dialog, not per team member. */
export function OpenCodeSourceDirectoryProvider({
  children,
  enabled,
  projectPath,
}: Readonly<{
  children: ReactNode;
  enabled: boolean;
  projectPath: string | null | undefined;
}>): JSX.Element {
  const normalizedPath = projectPath?.trim() || null;
  const runtimeStatus = useStore((state) => state.openCodeRuntimeStatus);
  const runtimeStatusLoading = useStore((state) => state.openCodeRuntimeStatusLoading);
  const runtimeError = useStore((state) => state.openCodeRuntimeError);
  const fetchRuntimeStatus = useStore((state) => state.fetchOpenCodeRuntimeStatus);
  const cliStatusLoading = useStore((state) => state.cliStatusLoading);
  const provider = useStore(
    (state) => state.cliStatus?.providers.find((item) => item.providerId === 'opencode') ?? null
  );
  useEffect(() => {
    if (enabled && !runtimeStatus && !runtimeStatusLoading && !runtimeError) {
      void fetchRuntimeStatus();
    }
  }, [enabled, fetchRuntimeStatus, runtimeError, runtimeStatus, runtimeStatusLoading]);

  const gate = resolveOpenCodeQuickConnectGate({
    runtimeStatus,
    runtimeStatusLoading,
    provider,
    cliStatusLoading,
  });
  const runtimeRevision = resolveOpenCodeQuickConnectRuntimeRevision({ gate, runtimeStatus });
  const runtimeReady = enabled && gate === 'ready';
  const checking = enabled && (gate === 'checking' || gate === 'installing');
  const directory = useRuntimeProviderQuickConnect({
    enabled: runtimeReady,
    projectPath: normalizedPath,
    runtimeRevision,
  });
  const error = enabled && !checking && !runtimeReady
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
      }}
    >
      {children}
    </OpenCodeSourceDirectoryContext.Provider>
  );
}
