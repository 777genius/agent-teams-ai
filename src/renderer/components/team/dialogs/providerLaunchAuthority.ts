import { useMemo } from 'react';

import { mergeCodexCliStatusWithSnapshot } from '@features/codex-account/renderer';
import {
  hasEffectiveProviderLaunchAuthority,
  useLaunchAuthorityGatedCliStatus,
} from '@renderer/hooks/useEffectiveCliProviderStatus';
import { getProviderLaunchReadinessDetail } from '@renderer/utils/providerReadiness';
import {
  canSettleOpenCodeStatusWithScopedPreparation,
  getOpenCodeScopedPreparationFailure,
  hasSettledOpenCodeScopedPreparation,
  type OpenCodeScopedPreparationEvidence,
} from '@renderer/utils/teamProviderRuntimeStatusLoading';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type { CliInstallationStatus, CliProviderStatus, TeamProviderId } from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>;

export interface ProviderLaunchBlocker {
  providerId: TeamProviderId;
  providerStatus: CliProviderStatus | null;
  detail: string;
}

export interface ProviderLaunchGuard {
  blocked(enabled: boolean, now?: number): boolean;
  blockers(enabled: boolean, now?: number): ProviderLaunchBlocker[];
  reject(enabled: boolean, onRejected: () => void): boolean;
}

export function canResolveOpenCodeLaunchBlockers(
  blockers: readonly ProviderLaunchBlocker[]
): boolean {
  return (
    blockers.length > 0 &&
    blockers.every(
      ({ providerId, providerStatus }) =>
        providerId === 'opencode' && canSettleOpenCodeStatusWithScopedPreparation(providerStatus)
    )
  );
}

function getProviderStatusDetail(provider: CliProviderStatus): string | null {
  if (provider.modelCatalogRefreshState === 'loading') {
    return null;
  }
  return (
    provider.modelCatalog?.diagnostics.message?.trim() ||
    provider.detailMessage?.trim() ||
    provider.statusMessage?.trim() ||
    null
  );
}

/** A failed duplicate source refresh cannot revoke fresher exact-project authority.
 * Only catalogue transport timeouts qualify, never authentication or model failures.
 */
function hasAuthoritativeOpenCodeCatalogFallback(
  provider: CliProviderStatus | null,
  evidence: OpenCodeScopedPreparationEvidence | undefined,
  now: number
): boolean {
  if (
    !provider ||
    !hasEffectiveProviderLaunchAuthority(provider, now) ||
    !evidence?.selectedModels.length
  )
    return false;
  const catalog = provider.modelCatalog!;
  return evidence.selectedModels.every((model) => {
    const sourceId = parseOpenCodeQualifiedModelRef(model)?.sourceId;
    const item = catalog.models.find((entry) => entry.launchModel === model);
    if (!sourceId || !item || item.metadata?.opencode?.proofState === 'failed') return false;
    if (
      provider.modelAvailability?.some(
        (entry) =>
          (entry.modelId === model || entry.modelId === item.id) && entry.status !== 'available'
      )
    )
      return false;
    const source = evidence.scopedStatusBySourceId.get(sourceId);
    if (
      source &&
      (source.providerId !== 'opencode' ||
        !source.supported ||
        !source.authenticated ||
        source.verificationState === 'error' ||
        source.statusCheckErrorCode != null ||
        source.modelCatalog?.models.some(
          (entry) =>
            entry.launchModel === model && entry.metadata?.opencode?.proofState === 'failed'
        ) ||
        source.modelAvailability?.some(
          (entry) =>
            (entry.modelId === model || entry.modelId === item.id) && entry.status !== 'available'
        ))
    )
      return false;
    if (source?.modelCatalogRefreshState !== 'error') return true;
    const sourceCatalog = source.modelCatalog;
    const fetchedAt = Date.parse(sourceCatalog?.fetchedAt ?? '');
    const diagnostics = sourceCatalog?.diagnostics;
    return (
      source.verificationState === 'verified' &&
      source.statusCheckOutcome === 'authoritative' &&
      source.modelVerificationState !== 'verifying' &&
      sourceCatalog?.status === 'stale' &&
      sourceCatalog.providerId === 'opencode' &&
      Number.isFinite(fetchedAt) &&
      new Date(fetchedAt).toISOString() === sourceCatalog.fetchedAt &&
      Date.parse(catalog.fetchedAt) >= fetchedAt &&
      (diagnostics?.code
        ? ['timeout', 'deadline_exceeded'].includes(diagnostics.code)
        : /\bcatalog\b[^.\n]*(?:timed?\s*out|timeout|deadline exceeded)/i.test(
            diagnostics?.message ?? ''
          ))
    );
  });
}

export function createLaunchGuard(
  providerIds: readonly TeamProviderId[],
  runtimeProviderStatusById: RuntimeProviderStatusById,
  openCodeEvidence?: OpenCodeScopedPreparationEvidence
): ProviderLaunchGuard {
  const blockers = (enabled: boolean, now: number = Date.now()): ProviderLaunchBlocker[] => {
    if (!enabled) return [];

    return providerIds.flatMap((providerId) => {
      const provider = runtimeProviderStatusById.get(providerId) ?? null;
      if (
        providerId === 'opencode' &&
        canSettleOpenCodeStatusWithScopedPreparation(provider) &&
        provider?.runtimeCapabilities?.modelCatalog?.source === 'app-server' &&
        hasSettledOpenCodeScopedPreparation(provider, openCodeEvidence, now)
      ) {
        // Passive status cannot authorize a launch. The strict OpenCode launch
        // attempt performs fresh exact-model proof before creating members.
        return [];
      }
      const scopedFailure =
        providerId === 'opencode' ? getOpenCodeScopedPreparationFailure(openCodeEvidence) : null;
      if (scopedFailure) {
        if (hasAuthoritativeOpenCodeCatalogFallback(provider, openCodeEvidence, now)) return [];
        return [
          {
            providerId,
            providerStatus: scopedFailure,
            detail:
              getProviderStatusDetail(scopedFailure) ??
              'The selected provider model catalog could not be refreshed. Refresh provider status.',
          },
        ];
      }
      return hasEffectiveProviderLaunchAuthority(provider, now)
        ? []
        : [
            {
              providerId,
              providerStatus: provider,
              detail: getProviderLaunchReadinessDetail(provider, now),
            },
          ];
    });
  };
  const blocked = (enabled: boolean, now?: number): boolean => blockers(enabled, now).length > 0;

  return {
    blocked,
    blockers,
    reject(enabled, onRejected) {
      if (!blocked(enabled)) return false;
      onRejected();
      return true;
    },
  };
}

export function useAuthorityGatedCliStatus(
  cliStatus: CliInstallationStatus | null,
  codexSnapshot: Parameters<typeof mergeCodexCliStatusWithSnapshot>[1]
): CliInstallationStatus | null {
  const mergedStatus = useMemo(
    () => mergeCodexCliStatusWithSnapshot(cliStatus, codexSnapshot),
    [cliStatus, codexSnapshot]
  );
  return useLaunchAuthorityGatedCliStatus(mergedStatus);
}
