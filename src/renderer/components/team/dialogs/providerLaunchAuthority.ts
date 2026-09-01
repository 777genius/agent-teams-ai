import { useMemo } from 'react';

import { mergeCodexCliStatusWithSnapshot } from '@features/codex-account/renderer';
import {
  hasEffectiveProviderLaunchAuthority,
  useLaunchAuthorityGatedCliStatus,
} from '@renderer/hooks/useEffectiveCliProviderStatus';
import {
  hasAuthoritativeProviderStatusEvidence,
  isProviderModelCatalogExactReady,
} from '@shared/utils/providerStatusAuthority';

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

function getProviderStatusDetail(provider: CliProviderStatus): string | null {
  return provider.detailMessage?.trim() || provider.statusMessage?.trim() || null;
}

function getProviderLaunchBlockerDetail(
  providerId: TeamProviderId,
  provider: CliProviderStatus | null | undefined,
  now: number
): string {
  if (!provider) {
    return 'Provider launch status is unavailable. Refresh the provider status.';
  }

  const statusDetail = getProviderStatusDetail(provider);
  const connectedCodexAccount =
    providerId === 'codex' && provider.connection?.codex?.launchAllowed === true;
  if (connectedCodexAccount) {
    return (
      'The ChatGPT account is connected, but the Codex runtime has not confirmed launch ' +
      'readiness. Refresh Codex status or reconnect ChatGPT in provider settings.'
    );
  }

  if (!hasAuthoritativeProviderStatusEvidence(provider)) {
    return statusDetail ?? 'Provider launch status could not be verified. Refresh provider status.';
  }
  if (provider.authenticated !== true) {
    return statusDetail ?? 'Authentication is required before this provider can launch.';
  }
  if (!isProviderModelCatalogExactReady(provider, now)) {
    return 'The verified model catalog is unavailable or stale. Refresh provider status.';
  }
  if (provider.capabilities.teamLaunch !== true) {
    return statusDetail ?? 'This provider runtime is not available for team launch.';
  }

  return 'Provider launch readiness could not be confirmed. Refresh provider status.';
}

export function createLaunchGuard(
  providerIds: readonly TeamProviderId[],
  runtimeProviderStatusById: RuntimeProviderStatusById
): ProviderLaunchGuard {
  const blockers = (enabled: boolean, now: number = Date.now()): ProviderLaunchBlocker[] => {
    if (!enabled) return [];

    return providerIds.flatMap((providerId) => {
      const provider = runtimeProviderStatusById.get(providerId) ?? null;
      return hasEffectiveProviderLaunchAuthority(provider, now)
        ? []
        : [
            {
              providerId,
              providerStatus: provider,
              detail: getProviderLaunchBlockerDetail(providerId, provider, now),
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
