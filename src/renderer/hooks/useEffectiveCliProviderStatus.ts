import { useCallback, useEffect, useMemo, useReducer } from 'react';

import {
  isCodexAccountSnapshotPending,
  mergeCodexCliStatusWithSnapshot,
  mergeCodexProviderStatusWithSnapshot,
  useCodexAccountSnapshot,
} from '@features/codex-account/renderer';
import { useStore } from '@renderer/store';
import {
  createLoadingMultimodelCliStatus,
  getCliProviderStatusScopeKey,
  reconcileCliStatus,
} from '@renderer/store/slices/cliInstallerSlice';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

export interface EffectiveCliProviderStatusSnapshot {
  cliStatus: CliInstallationStatus | null;
  sourceCliStatus: CliInstallationStatus | null;
  providerStatus: CliProviderStatus | null;
  loading: boolean;
  codexSnapshotPending: boolean;
}

interface ConservativeClockSnapshot {
  source: unknown;
  now: number;
}

/** Starts fail-closed, then publishes clock reads only from timer callbacks. */
function useConservativeNow(source: unknown): readonly [number, (now: number) => void] {
  const [snapshot, publishSnapshot] = useReducer(
    (_current: ConservativeClockSnapshot, next: ConservativeClockSnapshot) => next,
    { source: null, now: Number.POSITIVE_INFINITY }
  );
  const publishNow = useCallback((now: number) => publishSnapshot({ source, now }), [source]);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => publishNow(Date.now()), 0);
    return () => window.clearTimeout(timeoutId);
  }, [publishNow]);

  return [Object.is(snapshot.source, source) ? snapshot.now : Number.POSITIVE_INFINITY, publishNow];
}

export { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';

function gateProviderLaunch(provider: CliProviderStatus, now: number): CliProviderStatus {
  return {
    ...provider,
    capabilities: {
      ...provider.capabilities,
      teamLaunch: hasEffectiveProviderLaunchAuthority(provider, now),
    },
  };
}

function gateStatusLaunch(status: CliInstallationStatus | null, now: number) {
  return status
    ? {
        ...status,
        providers: status.providers.map((provider) => gateProviderLaunch(provider, now)),
      }
    : null;
}

/** Keeps renderer launch authority synchronized with exact catalog expiry boundaries. */
export function useLaunchAuthorityGatedCliStatus(
  status: CliInstallationStatus | null
): CliInstallationStatus | null {
  const [authorityNow, publishAuthorityNow] = useConservativeNow(status);
  const gatedStatus = useMemo(() => gateStatusLaunch(status, authorityNow), [authorityNow, status]);
  const nextCatalogStaleAt = gatedStatus?.providers.reduce<number | null>((nearest, provider) => {
    if (!provider.capabilities.teamLaunch || provider.modelCatalog?.status !== 'ready') {
      return nearest;
    }
    const staleAt = Date.parse(provider.modelCatalog.staleAt);
    return Number.isFinite(staleAt) &&
      staleAt > authorityNow &&
      (nearest === null || staleAt < nearest)
      ? staleAt
      : nearest;
  }, null);

  useEffect(() => {
    if (nextCatalogStaleAt === null || nextCatalogStaleAt === undefined) {
      return;
    }

    let timeoutId: number | null = null;
    let cancelled = false;
    const scheduleNextChunk = (): void => {
      if (cancelled) return;
      const currentNow = Date.now();
      const remainingMs = nextCatalogStaleAt - currentNow;
      if (remainingMs <= 0) {
        publishAuthorityNow(currentNow);
        return;
      }
      timeoutId = window.setTimeout(
        scheduleNextChunk,
        Math.min(remainingMs, MAX_BROWSER_TIMEOUT_MS)
      );
    };

    scheduleNextChunk();
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [nextCatalogStaleAt, publishAuthorityNow]);

  return gatedStatus;
}

/** Resolves one exact project scope without borrowing global catalog or launch authority. */
export function resolveProjectScopedProviderStatus(
  providerId: CliProviderId,
  scopedProviderStatus: CliProviderStatus | null,
  globalProviderStatus: CliProviderStatus | null,
  now: number = Date.now(),
  codexSnapshot: CodexAccountSnapshotDto | null = null
): CliProviderStatus | null {
  if (scopedProviderStatus?.providerId === providerId) {
    // The scoped runtime remains the launch authority. The app-managed Codex
    // snapshot is shared connection evidence and must be reflected here too,
    // otherwise the global Ready pill and scoped launch dialog disagree.
    const scopedWithAccount =
      providerId === 'codex'
        ? mergeCodexProviderStatusWithSnapshot(scopedProviderStatus, codexSnapshot)
        : scopedProviderStatus;
    const resolved = reconcileCliStatus(undefined, scopedWithAccount);
    return {
      ...resolved,
      capabilities: gateProviderLaunch(scopedWithAccount, now).capabilities,
    };
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

  const authorityClockSource = useMemo(
    () => ({
      loadingCliStatus,
      codexSnapshot: codexAccount.snapshot,
      projectPath: options.projectPath,
      providerId,
      scopedProviderStatus,
    }),
    [codexAccount.snapshot, loadingCliStatus, options.projectPath, providerId, scopedProviderStatus]
  );
  const [authorityNow] = useConservativeNow(authorityClockSource);

  const resolvedCliStatus = useMemo(() => {
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
      globalProvider ?? null,
      authorityNow,
      codexAccount.snapshot
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
    authorityNow,
    loadingCliStatus,
    options.projectPath,
    providerId,
    scopedProviderStatus,
  ]);
  const effectiveCliStatus = useLaunchAuthorityGatedCliStatus(resolvedCliStatus);
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
