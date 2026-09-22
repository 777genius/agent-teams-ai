import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';

import type { CliProviderStatus } from '@shared/types';

/** Selected-provider passive hydration; completed failures require an explicit retry. */
export function shouldHydrateCodexModelCatalog(provider: CliProviderStatus): boolean {
  if (
    provider.providerId !== 'codex' ||
    provider.statusCheckOutcome === 'transient_error' ||
    (provider.statusCheckErrorCode != null &&
      !(
        provider.statusCheckOutcome === 'pending' &&
        provider.statusCheckErrorCode === 'partial_response'
      )) ||
    provider.verificationState === 'error' ||
    provider.verificationState === 'offline' ||
    provider.modelCatalogRefreshState === 'error' ||
    (provider.statusCheckOutcome === 'authoritative' &&
      (!provider.supported || !provider.authenticated))
  )
    return false;

  if (
    provider.statusCheckOutcome === 'pending' ||
    (provider.statusCheckOutcome == null &&
      !provider.supported &&
      !provider.authenticated &&
      provider.verificationState === 'unknown' &&
      (provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE ||
        provider.statusMessage === 'Checking...'))
  )
    return true;

  return (
    provider.runtimeCapabilities?.modelCatalog?.dynamic === true &&
    provider.modelCatalog?.providerId !== 'codex' &&
    (provider.models.length === 0 || provider.modelCatalogRefreshState === 'idle')
  );
}
