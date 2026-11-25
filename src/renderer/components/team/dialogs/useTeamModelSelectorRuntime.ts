import { useCallback, useState } from 'react';

import {
  useRetainedLegacyInstallers,
  useRetainedLegacyLaunch,
  useRetainedLegacyRuntimeStatus,
} from '@features/agent-backend/renderer';
import { useStore } from '@renderer/store';

import type { CliInstallerSlice } from '@renderer/store/slices/cliInstallerSlice';

/** Select status and actions together, so the original choice never borrows Host readiness. */
export function useTeamModelSelectorRuntime(projectPath: string) {
  const retained = useRetainedLegacyLaunch();
  const original = useRetainedLegacyRuntimeStatus(projectPath);
  const installers = useRetainedLegacyInstallers();
  const [revision, setRevision] = useState(0);
  const [installError, setInstallError] = useState<string | null>(null);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const cliProviderStatusLoading = useStore((s) => s.cliProviderStatusLoading ?? {});
  const cliProviderStatusScopeRevision = useStore((s) => s.cliProviderStatusScopeRevision);
  const invalidateCliProviderModelCatalog = useStore((s) => s.invalidateCliProviderModelCatalog);
  const fetchCliProviderStatus = useStore((s) => s.fetchCliProviderStatus);
  const openCodeRuntimeStatus = useStore((s) => s.openCodeRuntimeStatus);
  const openCodeRuntimeStatusLoading = useStore((s) => s.openCodeRuntimeStatusLoading);
  const openCodeRuntimeError = useStore((s) => s.openCodeRuntimeError);
  const fetchOpenCodeRuntimeStatus = useStore((s) => s.fetchOpenCodeRuntimeStatus);
  const codexRuntimeStatus = useStore((s) => s.codexRuntimeStatus);
  const codexRuntimeStatusLoading = useStore((s) => s.codexRuntimeStatusLoading);
  const codexRuntimeError = useStore((s) => s.codexRuntimeError);
  const fetchCodexRuntimeStatus = useStore((s) => s.fetchCodexRuntimeStatus);
  const installCodexRuntime = useStore((s) => s.installCodexRuntime);
  const { refresh: refreshOriginal } = original;
  const { refresh: refreshInstallers } = installers;
  const scopedFetch = useCallback<CliInstallerSlice['fetchCliProviderStatus']>(
    async (_provider, options) => {
      if (options?.projectPath && options.projectPath !== projectPath) return false;
      return refreshOriginal();
    },
    [refreshOriginal, projectPath]
  );
  const scopedInvalidate = useCallback(() => {
    setRevision((value) => value + 1);
  }, []);
  const scopedRuntime = useCallback(async () => {
    await refreshInstallers();
  }, [refreshInstallers]);
  const scopedInstall = useCallback(async () => {
    setInstallError(
      'Close Launch before changing the original runtime installation, then choose the original runtime again.'
    );
  }, []);
  return retained
    ? {
        cliStatusLoading: original.loading,
        cliProviderStatusLoading: {
          anthropic: original.loading,
          codex: original.loading,
          gemini: original.loading,
          opencode: original.loading,
        },
        cliProviderStatusScopeRevision: revision,
        invalidateCliProviderModelCatalog: scopedInvalidate,
        fetchCliProviderStatus: scopedFetch,
        openCodeRuntimeStatus: installers.opencode,
        openCodeRuntimeStatusLoading: installers.loading,
        openCodeRuntimeError: installers.error,
        fetchOpenCodeRuntimeStatus: scopedRuntime,
        codexRuntimeStatus: installers.codex,
        codexRuntimeStatusLoading: installers.loading,
        codexRuntimeError: installError ?? installers.error,
        fetchCodexRuntimeStatus: scopedRuntime,
        installCodexRuntime: scopedInstall,
      }
    : {
        cliStatusLoading,
        cliProviderStatusLoading,
        cliProviderStatusScopeRevision,
        invalidateCliProviderModelCatalog,
        fetchCliProviderStatus,
        openCodeRuntimeStatus,
        openCodeRuntimeStatusLoading,
        openCodeRuntimeError,
        fetchOpenCodeRuntimeStatus,
        codexRuntimeStatus,
        codexRuntimeStatusLoading,
        codexRuntimeError,
        fetchCodexRuntimeStatus,
        installCodexRuntime,
      };
}
