import { hasAuthoritativeProviderStatusEvidence } from '@shared/utils/providerStatusAuthority';

import type { CliProviderStatus } from '@shared/types';

/** One-shot authority is independent of team launch and its model catalog. */
export function canRunExternalAgent(provider: CliProviderStatus | null | undefined): boolean {
  if (
    !provider ||
    !provider.supported ||
    !provider.authenticated ||
    !provider.capabilities.oneShot ||
    !hasAuthoritativeProviderStatusEvidence(provider)
  )
    return false;
  if (provider.providerId === 'codex') return provider.connection?.codex?.launchAllowed === true;
  return (
    provider.providerId === 'anthropic' &&
    (!provider.resolvedBackendId ||
      ['auto', 'cli-sdk', 'anthropic'].includes(provider.resolvedBackendId))
  );
}
