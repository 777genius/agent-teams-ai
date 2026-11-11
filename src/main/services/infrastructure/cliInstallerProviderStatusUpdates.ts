import {
  filterFrontendProviders,
  getAuthenticatedFrontendProvider,
  hasAuthenticatedFrontendProvider,
  projectProviderAuthority,
} from './cliInstallerStatusAuthority';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

/** Tracks request order rather than authentication strength: fresh negative evidence wins too. */
export class ProviderStatusPublicationRevisions {
  private readonly revisions = new Map<CliProviderId, number>();
  private readonly readOwners = new Map<CliProviderId, object>();

  published(providerId: CliProviderId): void {
    this.revisions.set(providerId, (this.revisions.get(providerId) ?? 0) + 1);
  }

  beginRead(providerId: CliProviderId): {
    finish: () => void;
    isCurrent: () => boolean;
    acknowledgePublication: () => void;
  } {
    const owner = {};
    this.readOwners.set(providerId, owner);
    this.published(providerId);
    let revision = this.revisions.get(providerId)!;
    const isCurrent = () =>
      this.readOwners.get(providerId) === owner &&
      this.revisions.get(providerId) === revision;
    // Independent status publications supersede this read even when no newer
    // read was started. Only this read's own catalog callback may advance it.
    return {
      finish: () => {
        if (!isCurrent()) return;
        this.published(providerId);
        revision = this.revisions.get(providerId)!;
      },
      isCurrent,
      acknowledgePublication: () => {
        if (this.readOwners.get(providerId) === owner)
          revision = this.revisions.get(providerId)!;
      },
    };
  }

  captureAggregate(): (providerId: CliProviderId) => boolean {
    const captured = new Map(this.revisions);
    return (providerId) =>
      (captured.get(providerId) ?? 0) === (this.revisions.get(providerId) ?? 0);
  }
}

/** A hydration delta must never replay other providers from its original summary. */
export function mergeProviderStatusPublication(
  incoming: CliProviderStatus[],
  current: CliProviderStatus[],
  hydratedProviderIds: Set<CliProviderId>,
  final: boolean,
  now: number,
  updatedProviderId?: CliProviderId,
  canPublishProvider: (providerId: CliProviderId) => boolean = () => true
): Pick<CliInstallationStatus, 'providers' | 'authLoggedIn' | 'authMethod'> | null {
  let merged = incoming;
  if (updatedProviderId !== undefined) {
    if (!canPublishProvider(updatedProviderId)) return null;
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
  // A provider refresh can supersede both a summary row and its later catalog
  // hydration. Retain the newer result regardless of whether it authenticated.
  merged = merged.map((provider) =>
    canPublishProvider(provider.providerId)
      ? provider
      : (current.find((latest) => latest.providerId === provider.providerId) ?? provider)
  );
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
