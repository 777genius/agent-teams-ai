import { useEffect, useMemo, useRef, useState } from 'react';

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
import { hasFreshAuthoritativeScopedProviderStatus } from '@shared/utils/cliProviderStatus';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

const CLI_PROVIDER_LAUNCH_PROOF_TTL_MS = 60_000;

export interface EffectiveCliProviderStatusSnapshot {
  cliStatus: CliInstallationStatus | null;
  sourceCliStatus: CliInstallationStatus | null;
  providerStatus: CliProviderStatus | null;
  loading: boolean;
  codexSnapshotPending: boolean;
}

export interface ExactProjectProviderLaunchProofSnapshot {
  providerStatusById: ReadonlyMap<CliProviderId, CliProviderStatus | null>;
  providerLoadingById: ReadonlyMap<CliProviderId, boolean>;
  providerGenerationById: ReadonlyMap<CliProviderId, string | null>;
  providerProofExpiresAtMs: number | null;
}

export const EXACT_PROJECT_PROVIDER_PROOF_MAX_ATTEMPTS = 3;
export const EXACT_PROJECT_PROVIDER_PROOF_RETRY_DELAYS_MS = [500, 1_500] as const;
export const EXACT_PROJECT_PROVIDER_PROOF_REFRESH_TIMEOUT_MS = 12_000;
export const EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS = [15_000, 30_000, 60_000] as const;

type ExactProjectProviderProofAttemptPhase = 'loading' | 'degraded' | 'authoritative';

interface ExactProjectProviderProofAttemptState {
  requestKey: string;
  phase: ExactProjectProviderProofAttemptPhase;
  providerGenerationById: ReadonlyMap<CliProviderId, string>;
}

function getScopedLaunchProofGeneration(
  proof:
    | import('@renderer/store/slices/scopedCliProviderLaunchProof').ScopedCliProviderLaunchProof
    | null
    | undefined
): string | null {
  const authority = proof?.authorityScope;
  if (!proof || !authority) return null;
  return `${proof.epoch}:${proof.requestId}`;
}

export function didExactProjectProviderLaunchProofComplete(results: readonly boolean[]): boolean {
  return results.length > 0 && results.every((result) => result === true);
}

export function isExactProjectProviderLaunchProofCurrent(
  completedRequestKey: string | null,
  activeCompletedRequestKey: string | null,
  currentRequestKey: string
): boolean {
  return (
    completedRequestKey === currentRequestKey && activeCompletedRequestKey === currentRequestKey
  );
}

/**
 * Fetches and exposes only raw, exact project+provider status evidence. This is
 * deliberately separate from the display status hook above: account snapshots,
 * global status and retained catalogs must never become launch proof.
 */
export function useExactProjectProviderLaunchProof(
  providerIds: readonly CliProviderId[],
  projectPath: string | null | undefined,
  enabled = true
): ExactProjectProviderLaunchProofSnapshot {
  const scopedLaunchProofs = useStore((s) => s.cliProviderLaunchProofByScope);
  const fetchCliProviderStatus = useStore((s) => s.fetchCliProviderStatus);
  const normalizedProjectPath = projectPath?.trim() ?? '';
  const providerKey = Array.from(new Set(providerIds)).sort().join('\u0000');
  const normalizedProviderIds = useMemo(
    () => providerKey.split('\u0000').filter(Boolean) as CliProviderId[],
    [providerKey]
  );
  // Store-wide scope revisions include semantically unrelated status refreshes.
  // Binding the request lifecycle to that counter cancels a valid exact-project
  // proof (and its in-flight model preflight) on an otherwise identical rerender.
  const proofRequestKey = `${normalizedProjectPath}\u0001${providerKey}`;
  const proofRequestGenerationRef = useRef(0);
  const retryTimerRef = useRef<number | null>(null);
  const recoveryTimerRef = useRef<number | null>(null);
  const recoveryBackoffRef = useRef(0);
  const acceptedProviderGenerationsRef = useRef(new Map<CliProviderId, string>());
  const [proofRefreshRevision, setProofRefreshRevision] = useState(0);
  const [attemptState, setAttemptState] = useState<ExactProjectProviderProofAttemptState | null>(
    null
  );

  useEffect(() => {
    recoveryBackoffRef.current = 0;
    acceptedProviderGenerationsRef.current.clear();
  }, [proofRequestKey]);

  useEffect(() => {
    if (!enabled || !normalizedProjectPath) {
      setAttemptState(null);
      return;
    }
    const generation = ++proofRequestGenerationRef.current;
    let cancelled = false;
    const refreshTimeoutHandles = new Set<number>();
    const previouslyAcceptedProviderGenerations = new Map(acceptedProviderGenerationsRef.current);
    const completedProviderIds = new Set<CliProviderId>();
    const completedProviderGenerations = new Map<CliProviderId, string>();

    const scheduleRecovery = (): void => {
      if (cancelled || proofRequestGenerationRef.current !== generation) return;
      const delayIndex = Math.min(
        recoveryBackoffRef.current,
        EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS.length - 1
      );
      recoveryBackoffRef.current += 1;
      recoveryTimerRef.current = window.setTimeout(() => {
        recoveryTimerRef.current = null;
        if (!cancelled && proofRequestGenerationRef.current === generation) {
          setProofRefreshRevision((revision) => revision + 1);
        }
      }, EXACT_PROJECT_PROVIDER_PROOF_RECOVERY_DELAYS_MS[delayIndex]);
    };

    const runAttempt = (providerIds: readonly CliProviderId[], attempt: number): void => {
      if (cancelled || proofRequestGenerationRef.current !== generation) {
        return;
      }
      setAttemptState({
        requestKey: proofRequestKey,
        phase: 'loading',
        providerGenerationById: new Map(),
      });
      const fetchBatch = Promise.all(
        providerIds.map(async (providerId) => {
          const authoritative = await fetchCliProviderStatus(providerId, {
            silent: true,
            requestEpoch: generation,
            checkReason: 'launch_preflight',
            projectPath: normalizedProjectPath,
            intent: 'launch-proof',
          });
          return [providerId, authoritative] as const;
        })
      );
      let timeoutHandle: number | null = null;
      const timedBatch = Promise.race([
        fetchBatch,
        new Promise<null>((resolve) => {
          timeoutHandle = window.setTimeout(
            () => resolve(null),
            EXACT_PROJECT_PROVIDER_PROOF_REFRESH_TIMEOUT_MS
          );
          refreshTimeoutHandles.add(timeoutHandle);
        }),
      ]);
      void timedBatch.then(
        (results) => {
          if (timeoutHandle !== null) {
            window.clearTimeout(timeoutHandle);
            refreshTimeoutHandles.delete(timeoutHandle);
          }
          if (cancelled || proofRequestGenerationRef.current !== generation) {
            return;
          }
          if (results === null) {
            setAttemptState({
              requestKey: proofRequestKey,
              phase: 'degraded',
              providerGenerationById: new Map(),
            });
            scheduleRecovery();
            return;
          }
          const currentProofs = useStore.getState().cliProviderLaunchProofByScope;
          for (const [providerId, authoritative] of results) {
            const proof =
              currentProofs[getCliProviderStatusScopeKey(providerId, normalizedProjectPath)];
            const proofGeneration = getScopedLaunchProofGeneration(proof);
            if (
              authoritative &&
              proof !== undefined &&
              proof.fetchedAtMs + CLI_PROVIDER_LAUNCH_PROOF_TTL_MS > Date.now() &&
              proofGeneration !== null &&
              proofGeneration !== previouslyAcceptedProviderGenerations.get(providerId)
            ) {
              completedProviderIds.add(providerId);
              completedProviderGenerations.set(providerId, proofGeneration);
            } else {
              completedProviderIds.delete(providerId);
              completedProviderGenerations.delete(providerId);
            }
          }
          const providerGenerationById = new Map<CliProviderId, string>();
          for (const providerId of normalizedProviderIds) {
            if (!completedProviderIds.has(providerId)) {
              continue;
            }
            const proof =
              currentProofs[getCliProviderStatusScopeKey(providerId, normalizedProjectPath)];
            const proofGeneration = getScopedLaunchProofGeneration(proof);
            if (proofGeneration === completedProviderGenerations.get(providerId)) {
              providerGenerationById.set(providerId, proofGeneration);
            } else {
              completedProviderIds.delete(providerId);
              completedProviderGenerations.delete(providerId);
            }
          }
          if (completedProviderIds.size === normalizedProviderIds.length) {
            acceptedProviderGenerationsRef.current = new Map(providerGenerationById);
            recoveryBackoffRef.current = 0;
            setAttemptState({
              requestKey: proofRequestKey,
              phase: 'authoritative',
              providerGenerationById,
            });
            return;
          }

          setAttemptState({
            requestKey: proofRequestKey,
            phase: 'degraded',
            providerGenerationById: new Map(),
          });
          if (attempt >= EXACT_PROJECT_PROVIDER_PROOF_MAX_ATTEMPTS) {
            scheduleRecovery();
            return;
          }
          const failedProviderIds = normalizedProviderIds.filter(
            (providerId) => !completedProviderIds.has(providerId)
          );
          retryTimerRef.current = window.setTimeout(
            () => {
              retryTimerRef.current = null;
              runAttempt(failedProviderIds, attempt + 1);
            },
            EXACT_PROJECT_PROVIDER_PROOF_RETRY_DELAYS_MS[attempt - 1]
          );
        },
        () => {
          if (timeoutHandle !== null) {
            window.clearTimeout(timeoutHandle);
            refreshTimeoutHandles.delete(timeoutHandle);
          }
          if (cancelled || proofRequestGenerationRef.current !== generation) {
            return;
          }
          // A rejected transport has an uncertain outcome. Fail closed and
          // defer the next generation so it cannot become an immediate loop.
          setAttemptState({
            requestKey: proofRequestKey,
            phase: 'degraded',
            providerGenerationById: new Map(),
          });
          scheduleRecovery();
        }
      );
    };

    if (normalizedProviderIds.length === 0) {
      setAttemptState({
        requestKey: proofRequestKey,
        phase: 'degraded',
        providerGenerationById: new Map(),
      });
    } else {
      runAttempt(normalizedProviderIds, 1);
    }
    return () => {
      cancelled = true;
      if (retryTimerRef.current !== null) {
        window.clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (recoveryTimerRef.current !== null) {
        window.clearTimeout(recoveryTimerRef.current);
        recoveryTimerRef.current = null;
      }
      for (const timeoutHandle of refreshTimeoutHandles) {
        window.clearTimeout(timeoutHandle);
      }
      refreshTimeoutHandles.clear();
      proofRequestGenerationRef.current += 1;
    };
  }, [
    enabled,
    fetchCliProviderStatus,
    normalizedProjectPath,
    normalizedProviderIds,
    proofRequestKey,
    proofRefreshRevision,
  ]);

  const snapshot = useMemo(() => {
    const providerStatusById = new Map<CliProviderId, CliProviderStatus | null>();
    const providerLoadingById = new Map<CliProviderId, boolean>();
    const providerGenerationById = new Map<CliProviderId, string | null>();
    let providerProofExpiresAtMs: number | null = null;
    for (const providerId of normalizedProviderIds) {
      const scopeKey = getCliProviderStatusScopeKey(providerId, normalizedProjectPath);
      const proof = normalizedProjectPath ? (scopedLaunchProofs?.[scopeKey] ?? null) : null;
      const proofGeneration = getScopedLaunchProofGeneration(proof);
      const expectedGeneration = attemptState?.providerGenerationById.get(providerId) ?? null;
      const proofIsCurrent =
        attemptState?.requestKey === proofRequestKey &&
        attemptState.phase === 'authoritative' &&
        expectedGeneration !== null &&
        proofGeneration === expectedGeneration;
      const status = proofIsCurrent ? (proof?.providerStatus ?? null) : null;
      providerStatusById.set(providerId, status);
      providerGenerationById.set(providerId, proofIsCurrent ? proofGeneration : null);
      const fetchTimeExpiryMs =
        proofIsCurrent && proof ? proof.fetchedAtMs + CLI_PROVIDER_LAUNCH_PROOF_TTL_MS : null;
      if (
        fetchTimeExpiryMs !== null &&
        (providerProofExpiresAtMs === null || fetchTimeExpiryMs < providerProofExpiresAtMs)
      ) {
        providerProofExpiresAtMs = fetchTimeExpiryMs;
      }
      if (status?.modelCatalog) {
        const staleAtMs = Date.parse(status.modelCatalog.staleAt);
        if (
          Number.isFinite(staleAtMs) &&
          (providerProofExpiresAtMs === null || staleAtMs < providerProofExpiresAtMs)
        ) {
          providerProofExpiresAtMs = staleAtMs;
        }
      }
      providerLoadingById.set(
        providerId,
        enabled &&
          Boolean(normalizedProjectPath) &&
          (attemptState?.requestKey !== proofRequestKey ||
            attemptState.phase === 'loading' ||
            (attemptState.phase === 'authoritative' && !status))
      );
    }
    return {
      providerStatusById,
      providerLoadingById,
      providerGenerationById,
      providerProofExpiresAtMs,
    };
  }, [
    attemptState,
    enabled,
    normalizedProjectPath,
    normalizedProviderIds,
    proofRequestKey,
    scopedLaunchProofs,
  ]);
  useEffect(() => {
    if (attemptState?.requestKey !== proofRequestKey || attemptState.phase !== 'authoritative') {
      return;
    }
    const changedProofs = normalizedProviderIds.flatMap((providerId) => {
      const proof =
        scopedLaunchProofs?.[getCliProviderStatusScopeKey(providerId, normalizedProjectPath)];
      const currentGeneration = getScopedLaunchProofGeneration(proof);
      return currentGeneration !== attemptState.providerGenerationById.get(providerId)
        ? [proof]
        : [];
    });
    if (
      changedProofs.some(
        (proof) => proof && hasFreshAuthoritativeScopedProviderStatus(proof.providerStatus)
      )
    ) {
      setProofRefreshRevision((revision) => revision + 1);
    } else if (changedProofs.length > 0) {
      setAttemptState({
        requestKey: proofRequestKey,
        phase: 'degraded',
        providerGenerationById: new Map(),
      });
    }
  }, [
    attemptState,
    normalizedProjectPath,
    normalizedProviderIds,
    proofRequestKey,
    scopedLaunchProofs,
  ]);
  useEffect(() => {
    const expiresAtMs = snapshot.providerProofExpiresAtMs;
    if (!enabled || expiresAtMs === null) {
      return;
    }
    const generations = Array.from(snapshot.providerGenerationById.values())
      .filter((value): value is string => value !== null)
      .sort()
      .join('\u0000');
    if (!generations) return;
    if (expiresAtMs <= Date.now()) {
      setProofRefreshRevision((revision) => revision + 1);
      return;
    }
    const timer = window.setTimeout(
      () => {
        setProofRefreshRevision((revision) => revision + 1);
      },
      Math.min(expiresAtMs - Date.now() + 1, 2_147_483_647)
    );
    return () => window.clearTimeout(timer);
  }, [
    enabled,
    proofRequestKey,
    snapshot.providerGenerationById,
    snapshot.providerProofExpiresAtMs,
  ]);
  return snapshot;
}

export function resolveProjectScopedProviderStatus(
  providerId: CliProviderId,
  scopedProviderStatus: CliProviderStatus | null,
  globalProviderStatus?: CliProviderStatus | null
): CliProviderStatus | null {
  if (scopedProviderStatus) return scopedProviderStatus;
  if (globalProviderStatus) {
    return {
      ...globalProviderStatus,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusCheckOutcome: 'pending',
      statusCheckErrorCode: 'partial_response',
      capabilities: { ...globalProviderStatus.capabilities, teamLaunch: false },
      modelCatalog: globalProviderStatus.modelCatalog
        ? { ...globalProviderStatus.modelCatalog, status: 'stale' }
        : null,
    };
  }
  return (
    createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === providerId
    ) ?? null
  );
}

export function replaceProjectScopedProviderStatus(
  status: CliInstallationStatus,
  providerId: CliProviderId,
  projectProvider: CliProviderStatus
): CliInstallationStatus {
  const providers = status.providers.some((provider) => provider.providerId === providerId)
    ? status.providers.map((provider) =>
        provider.providerId === providerId ? projectProvider : provider
      )
    : [...status.providers, projectProvider];
  const authenticatedProvider = providers.find(
    (provider) => provider.authenticated === true && provider.statusCheckOutcome === 'authoritative'
  );
  return {
    ...status,
    providers,
    authLoggedIn: Boolean(authenticatedProvider),
    authMethod: authenticatedProvider?.authMethod ?? null,
  };
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
  const scopedProviderLoading = useStore((s) => {
    if (!providerId || !options.projectPath?.trim()) {
      return false;
    }
    return (
      s.cliProviderStatusLoadingByScope?.[
        getCliProviderStatusScopeKey(providerId, options.projectPath)
      ] === true
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
      globalProvider
    );
    if (!projectProvider) {
      return withCodexSnapshot;
    }
    return replaceProjectScopedProviderStatus(withCodexSnapshot, providerId, projectProvider);
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
    loading: options.projectPath?.trim()
      ? scopedProviderLoading
      : cliStatusLoading && effectiveCliStatus === null,
    codexSnapshotPending,
  };
}
