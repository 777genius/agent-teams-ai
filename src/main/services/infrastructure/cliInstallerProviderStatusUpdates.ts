import {
  filterFrontendProviders,
  getAuthenticatedFrontendProvider,
  hasAuthenticatedFrontendProvider,
  projectProviderAuthority,
} from './cliInstallerStatusAuthority';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

/** A hydration delta must never replay other providers from its original summary. */
export function mergeProviderStatusPublication(
  incoming: CliProviderStatus[],
  current: CliProviderStatus[],
  hydratedProviderIds: Set<CliProviderId>,
  final: boolean,
  now: number,
  updatedProviderId?: CliProviderId
): Pick<CliInstallationStatus, 'providers' | 'authLoggedIn' | 'authMethod'> | null {
  let merged = incoming;
  if (updatedProviderId !== undefined) {
    if (incoming.length !== 1 || incoming[0].providerId !== updatedProviderId) return null;
    hydratedProviderIds.add(updatedProviderId);
    const found = current.some((provider) => provider.providerId === updatedProviderId);
    merged = found
      ? current.map((provider) =>
          provider.providerId === updatedProviderId ? incoming[0] : provider
        )
      : [...current, incoming[0]];
  } else if (final) {
    // The full command can finish before the aggregate summary promise settles.
    merged = incoming.map((provider) =>
      hydratedProviderIds.has(provider.providerId)
        ? (current.find((latest) => latest.providerId === provider.providerId) ?? provider)
        : provider
    );
  }
  const providers = filterFrontendProviders(merged).map((provider) =>
    projectProviderAuthority(provider, now)
  );
  return {
    providers,
    authLoggedIn: hasAuthenticatedFrontendProvider(providers),
    authMethod: getAuthenticatedFrontendProvider(providers)?.authMethod ?? null,
  };
}

/** Keep a finishing aggregate run from republishing providers captured before a refresh. */
export function retainLatestProviderStatus(
  target: CliInstallationStatus,
  latest: CliInstallationStatus | null
): void {
  if (
    !latest ||
    target.flavor !== 'agent_teams_orchestrator' ||
    target.flavor !== latest.flavor ||
    target.binaryPath !== latest.binaryPath
  )
    return;
  target.providers = latest.providers;
  target.authLoggedIn = latest.authLoggedIn;
  target.authMethod = latest.authMethod;
}
