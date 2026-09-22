import { useEffect, useRef } from 'react';

import { useStore } from '@renderer/store';
import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import { refreshCliStatusForCurrentMode } from '@renderer/utils/refreshCliStatus';

import type { CliInstallationStatus, CliProviderId } from '@shared/types';

/** One automatic attempt per unhealthy episode, reset only by fresh evidence or close.
 * Store requests are deduplicated; failures require manual refresh or reopening.
 * This never grants authority and never replaces project-scoped preparation.
 */
export function useProviderReadinessRevalidation(
  enabled: boolean,
  providerIds: readonly CliProviderId[],
  cliStatus: CliInstallationStatus | null
): void {
  const fetchProvider = useStore((s) => s.fetchCliProviderStatus);
  const providerLoading = useStore((s) => s.cliProviderStatusLoading);
  const statusLoading = useStore((s) => s.cliStatusLoading);
  const bootstrapCliStatus = useStore((s) => s.bootstrapCliStatus);
  const fetchCliStatus = useStore((s) => s.fetchCliStatus);
  const multimodelEnabled = useStore((s) => s.appConfig?.general?.multimodelEnabled ?? true);
  const attempted = useRef(new Set<CliProviderId>());
  const bootstrapAttempted = useRef(false);
  useEffect(() => {
    if (!enabled) {
      attempted.current.clear();
      bootstrapAttempted.current = false;
      return;
    }
    if (!cliStatus && !statusLoading && !bootstrapAttempted.current) {
      bootstrapAttempted.current = true;
      void refreshCliStatusForCurrentMode({
        multimodelEnabled,
        bootstrapCliStatus,
        fetchCliStatus,
      });
    }
    if (!multimodelEnabled || !cliStatus?.installed || statusLoading) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = (): void => {
      const now = Date.now();
      let nextExpiry = Infinity;
      for (const providerId of providerIds) {
        const provider = cliStatus.providers.find((item) => item.providerId === providerId);
        if (provider && hasEffectiveProviderLaunchAuthority(provider, now)) {
          attempted.current.delete(providerId);
          nextExpiry = Math.min(nextExpiry, Date.parse(provider.modelCatalog!.staleAt));
          continue;
        }
        if (
          providerLoading[providerId] ||
          provider?.modelCatalogRefreshState === 'loading' ||
          attempted.current.has(providerId)
        )
          continue;
        attempted.current.add(providerId);
        void fetchProvider(providerId).catch(() => {
          // The store owns visible errors. Do not turn failure into an automatic loop.
        });
      }
      if (Number.isFinite(nextExpiry)) {
        timer = setTimeout(check, Math.min(Math.max(1, nextExpiry - now), 2_147_483_647));
      }
    };
    check();
    return () => clearTimeout(timer);
  }, [
    bootstrapCliStatus,
    cliStatus,
    enabled,
    fetchCliStatus,
    fetchProvider,
    multimodelEnabled,
    providerIds,
    providerLoading,
    statusLoading,
  ]);
}
