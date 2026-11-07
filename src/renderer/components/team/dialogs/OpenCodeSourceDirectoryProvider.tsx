import { createContext, useContext } from 'react';

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
  const runtimeRevision = useStore((state) => state.openCodeRuntimeStatus?.version ?? null);
  const directory = useRuntimeProviderQuickConnect({
    enabled: enabled && normalizedPath !== null,
    projectPath: normalizedPath,
    runtimeRevision,
  });

  return (
    <OpenCodeSourceDirectoryContext.Provider
      value={{
        ...directory,
        enabled: enabled && normalizedPath !== null,
        projectPath: normalizedPath,
      }}
    >
      {children}
    </OpenCodeSourceDirectoryContext.Provider>
  );
}
