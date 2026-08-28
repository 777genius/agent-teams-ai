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
  reconcileCliStatus,
} from '@renderer/store/slices/cliInstallerSlice';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export interface EffectiveCliProviderStatusSnapshot {
  cliStatus: CliInstallationStatus | null;
  sourceCliStatus: CliInstallationStatus | null;
  providerStatus: CliProviderStatus | null;
  loading: boolean;
  codexSnapshotPending: boolean;
}

/** Resolves one exact project scope without borrowing global catalog or launch authority. */
export function resolveProjectScopedProviderStatus(
  providerId: CliProviderId,
  scopedProviderStatus: CliProviderStatus | null,
  globalProviderStatus: CliProviderStatus | null
): CliProviderStatus | null {
  if (scopedProviderStatus?.providerId === providerId) {
    return reconcileCliStatus(undefined, scopedProviderStatus);
  }
  if (!globalProviderStatus || globalProviderStatus.providerId !== providerId) {
    return null;
  }
  return reconcileCliStatus(undefined, {
    ...globalProviderStatus,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusCheckOutcome: 'pending',
    statusCheckErrorCode: 'partial_response',
    models: [],
    modelAvailability: [],
    modelCatalog: null,
    modelCatalogRefreshState: 'loading',
    capabilities: {
      ...globalProviderStatus.capabilities,
      teamLaunch: false,
    },
  });
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
    const projectProvider = resolveProjectScopedProviderStatus(
      providerId,
      scopedProviderStatus,
      globalProvider ?? null
    );
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
    isCodexAccountSnapshotPending(
      codexAccount.loading,
      codexAccount.snapshot,
      codexAccount.error
    ) &&
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
