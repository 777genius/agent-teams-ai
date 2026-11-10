import {
  hasAuthoritativeProviderStatusEvidence,
  isProviderModelCatalogExactReady,
} from '@shared/utils/providerStatusAuthority';

import type { CliProviderStatus } from '@shared/types';

export function hasEffectiveProviderLaunchAuthority(
  provider: CliProviderStatus | null | undefined,
  now: number = Date.now()
): boolean {
  return Boolean(
    provider &&
    hasAuthoritativeProviderStatusEvidence(provider) &&
    provider.authenticated === true &&
    provider.capabilities.teamLaunch === true &&
    isProviderModelCatalogExactReady(provider, now)
  );
}

export function getProviderLaunchReadinessDetail(
  provider: CliProviderStatus | null | undefined,
  now: number = Date.now()
): string {
  if (!provider) return 'Provider launch status is unavailable. Refresh the provider status.';
  if (provider.modelCatalogRefreshState === 'loading') {
    return 'The verified model catalog is being refreshed. Wait for provider status to finish.';
  }
  const detail = provider.detailMessage?.trim() || provider.statusMessage?.trim();
  // Account connectivity is not catalog freshness. Never prescribe reconnecting
  // an authenticated account to repair expired or failed model evidence.
  if (provider.authenticated === true && !isProviderModelCatalogExactReady(provider, now)) {
    return 'The verified model catalog is unavailable or stale. Refresh provider status.';
  }
  if (provider.providerId === 'codex' && provider.connection?.codex?.launchAllowed === true) {
    return 'The ChatGPT account is connected, but the Codex runtime has not confirmed launch readiness. Refresh Codex status in provider settings.';
  }
  if (!hasAuthoritativeProviderStatusEvidence(provider)) {
    return detail || 'Provider launch status could not be verified. Refresh provider status.';
  }
  if (provider.authenticated !== true) {
    return detail || 'Authentication is required before this provider can launch.';
  }
  return 'This provider runtime is not available for team launch. Refresh provider status.';
}
