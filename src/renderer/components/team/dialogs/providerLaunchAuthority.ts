import { useMemo } from 'react';

import { mergeCodexCliStatusWithSnapshot } from '@features/codex-account/renderer';
import {
  hasEffectiveProviderLaunchAuthority,
  useLaunchAuthorityGatedCliStatus,
} from '@renderer/hooks/useEffectiveCliProviderStatus';

import type { CliInstallationStatus, CliProviderStatus, TeamProviderId } from '@shared/types';

type RuntimeProviderStatusById = ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>;

export interface ProviderLaunchGuard {
  blocked(enabled: boolean, now?: number): boolean;
  reject(enabled: boolean, onRejected: () => void): boolean;
}

export function createLaunchGuard(
  providerIds: readonly TeamProviderId[],
  runtimeProviderStatusById: RuntimeProviderStatusById
): ProviderLaunchGuard {
  const blocked = (enabled: boolean, now?: number): boolean =>
    enabled &&
    providerIds.some(
      (providerId) =>
        !hasEffectiveProviderLaunchAuthority(runtimeProviderStatusById.get(providerId), now)
    );

  return {
    blocked,
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
