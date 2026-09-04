import { useMemo } from 'react';

import { mergeCodexCliStatusWithSnapshot } from '@features/codex-account/renderer';
import {
  hasEffectiveProviderLaunchAuthority,
  useLaunchAuthorityGatedCliStatus,
} from '@renderer/hooks/useEffectiveCliProviderStatus';
import { getProviderLaunchReadinessDetail } from '@renderer/utils/providerReadiness';
import {
  getOpenCodeScopedPreparationFailure,
  hasSettledOpenCodeScopedPreparation,
  type OpenCodeScopedPreparationEvidence,
} from '@renderer/utils/teamProviderRuntimeStatusLoading';

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
        providerId === 'opencode' &&
        (providerStatus?.statusCheckOutcome === 'model_only' ||
          (providerStatus?.statusCheckOutcome === 'pending' &&
            providerStatus.statusCheckErrorCode === 'partial_response'))
    )
  );
}

function getProviderStatusDetail(provider: CliProviderStatus): string | null {
  if (provider.modelCatalogRefreshState === 'loading') {
    return null;
  }
  return (
    provider.detailMessage?.trim() ||
    provider.statusMessage?.trim() ||
    provider.modelCatalog?.diagnostics.message?.trim() ||
    null
  );
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
        provider?.statusCheckOutcome === 'model_only' &&
        provider.runtimeCapabilities?.modelCatalog?.source === 'app-server' &&
        hasSettledOpenCodeScopedPreparation(provider, openCodeEvidence, now)
      ) {
        // Passive status cannot authorize a launch. The strict OpenCode launch
        // attempt performs fresh exact-model proof before creating members.
        return [];
      }
      const scopedFailure =
        providerId === 'opencode' ? getOpenCodeScopedPreparationFailure(openCodeEvidence) : null;
      if (scopedFailure) {
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
