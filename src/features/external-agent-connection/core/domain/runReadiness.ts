import { hasAuthoritativeProviderStatusEvidence } from '@shared/utils/providerStatusAuthority';

import type { AppConnectionContext } from '../../contracts';
import type { CliProviderStatus } from '@shared/types';

export function sameExternalAgentRunContext(
  left: AppConnectionContext,
  right: AppConnectionContext
): boolean {
  return (
    left.appInstanceId === right.appInstanceId &&
    left.dataRootFingerprint === right.dataRootFingerprint &&
    left.connectionGeneration === right.connectionGeneration
  );
}

/** One-shot authority is independent of team launch and its model catalog. */
export function canRunExternalAgent(
  provider: CliProviderStatus | null | undefined,
  codexLaunchAllowed = provider?.connection?.codex?.launchAllowed
): boolean {
  if (
    !provider ||
    !provider.supported ||
    !provider.authenticated ||
    !provider.capabilities.oneShot ||
    !hasAuthoritativeProviderStatusEvidence(provider)
  )
    return false;
  if (provider.providerId === 'codex') return codexLaunchAllowed === true;
  return (
    provider.providerId === 'anthropic' &&
    (!provider.resolvedBackendId ||
      ['auto', 'cli-sdk', 'anthropic'].includes(provider.resolvedBackendId))
  );
}
