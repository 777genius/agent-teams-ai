import { ANTHROPIC_COMPATIBLE_BACKEND_IDS } from '@shared/constants/anthropicConnectionMode';

import type { CliProviderStatus } from '@shared/types';

export function isAnthropicCompatibleCatalogChecking(
  provider: Pick<
    CliProviderStatus,
    'providerId' | 'supported' | 'backend' | 'modelCatalogRefreshState'
  > &
    Partial<Pick<CliProviderStatus, 'verificationState'>>
): boolean {
  return (
    provider.providerId === 'anthropic' &&
    provider.supported &&
    provider.verificationState === 'unknown' &&
    provider.modelCatalogRefreshState === 'loading' &&
    ANTHROPIC_COMPATIBLE_BACKEND_IDS.some((id) => id === provider.backend?.kind)
  );
}
