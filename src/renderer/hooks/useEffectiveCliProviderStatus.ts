import { useMemo } from 'react';

import {
  isCodexAccountSnapshotPending,
  mergeCodexCliStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { useStore } from '@renderer/store';
import {
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
} from '@renderer/store/slices/cliInstallerSlice';
import { isTeamProviderModelCatalogSettled } from '@renderer/utils/teamModelAvailability';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export interface EffectiveCliProviderStatusSnapshot {
  cliStatus: CliInstallationStatus | null;
  sourceCliStatus: CliInstallationStatus | null;
  providerStatus: CliProviderStatus | null;
  loading: boolean;
  codexSnapshotPending: boolean;
}

export function useEffectiveCliProviderStatus(
  providerId: CliProviderId | undefined,
  options: { projectPath?: string | null } = {}
): EffectiveCliProviderStatusSnapshot {
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const cliStatus = useStore((s) => s.cliStatus);
  const cliStatusLoading = useStore((s) => s.cliStatusLoading);
  const scopedProviderStatus = useStore((s) => {
    if (!providerId || !options.projectPath?.trim()) {
      return null;
    }
    return (
      s.cliProviderStatusByScope?.[getCliProviderStatusScopeKey(providerId, options.projectPath)] ??
      null
    );
  });

  const loadingCliStatus = useMemo(
    () =>
      !cliStatus && cliStatusLoading && multimodelEnabled
        ? createLoadingMultimodelCliStatus()
        : cliStatus,
    [cliStatus, cliStatusLoading, multimodelEnabled]
  );

  const codexAccount = useCodexAccountSnapshot({
    enabled:
      providerId === 'codex' &&
      multimodelEnabled &&
      loadingCliStatus?.flavor === 'agent_teams_orchestrator' &&
      Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')),
  });

  const effectiveCliStatus = useMemo(() => {
    const withCodexSnapshot = mergeCodexCliStatusWithSnapshot(
      loadingCliStatus,
      codexAccount.snapshot
    );
    if (!providerId || !options.projectPath?.trim() || !withCodexSnapshot) {
      return withCodexSnapshot;
    }

    const globalProvider = withCodexSnapshot.providers.find(
      (provider) => provider.providerId === providerId
    );
    const scopedProviderFailed =
      scopedProviderStatus?.verificationState === 'error' ||
      scopedProviderStatus?.modelCatalogRefreshState === 'error';
    const scopedProviderSettled = Boolean(
      scopedProviderStatus && isTeamProviderModelCatalogSettled(providerId, scopedProviderStatus)
    );
    const projectProviderBase = scopedProviderStatus ?? globalProvider ?? null;
    const catalogFallbackProvider =
      scopedProviderStatus?.modelCatalog != null ? scopedProviderStatus : (globalProvider ?? null);
    const canReuseOpenCodeCatalog = Boolean(
      providerId === 'opencode' && (catalogFallbackProvider?.modelCatalog?.models.length ?? 0) > 0
    );
    const projectProviderWithCatalogFallback =
      projectProviderBase && catalogFallbackProvider && canReuseOpenCodeCatalog
        ? {
            ...projectProviderBase,
            models:
              projectProviderBase.models.length > 0
                ? projectProviderBase.models
                : catalogFallbackProvider.models,
            modelAvailability:
              (projectProviderBase.modelAvailability?.length ?? 0) > 0
                ? projectProviderBase.modelAvailability
                : catalogFallbackProvider.modelAvailability,
            modelCatalog: projectProviderBase.modelCatalog ?? catalogFallbackProvider.modelCatalog,
          }
        : projectProviderBase;
    let projectProvider: CliProviderStatus | null = null;
    if (scopedProviderSettled) {
      projectProvider = scopedProviderStatus;
    } else if (scopedProviderFailed) {
      projectProvider =
        canReuseOpenCodeCatalog && projectProviderWithCatalogFallback
          ? projectProviderWithCatalogFallback
          : scopedProviderStatus;
    } else if (projectProviderBase) {
      projectProvider =
        canReuseOpenCodeCatalog && projectProviderWithCatalogFallback
          ? {
              ...projectProviderWithCatalogFallback,
              modelCatalogRefreshState: 'loading',
            }
          : {
              ...projectProviderBase,
              models: [],
              modelAvailability: [],
              modelCatalog: null,
              modelCatalogRefreshState: 'loading',
            };
    }
    if (!projectProvider) {
      return withCodexSnapshot;
    }
    return {
      ...withCodexSnapshot,
      providers: withCodexSnapshot.providers.some((provider) => provider.providerId === providerId)
        ? withCodexSnapshot.providers.map((provider) =>
            provider.providerId === providerId ? projectProvider : provider
          )
        : [...withCodexSnapshot.providers, projectProvider],
    };
  }, [
    codexAccount.snapshot,
    loadingCliStatus,
    options.projectPath,
    providerId,
    scopedProviderStatus,
  ]);
  const codexSnapshotPending =
    isCodexAccountSnapshotPending(codexAccount.loading, codexAccount.snapshot) &&
    Boolean(loadingCliStatus?.providers.some((provider) => provider.providerId === 'codex')) &&
    providerId === 'codex';
  const providerStatus = useMemo(
    () =>
      providerId
        ? (effectiveCliStatus?.providers.find((provider) => provider.providerId === providerId) ??
          null)
        : null,
    [effectiveCliStatus?.providers, providerId]
  );

  return {
    cliStatus: effectiveCliStatus,
    sourceCliStatus: loadingCliStatus,
    providerStatus,
    loading: cliStatusLoading && effectiveCliStatus === null,
    codexSnapshotPending,
  };
}
