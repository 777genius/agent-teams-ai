import {
  hasAuthoritativeProviderStatusEvidence,
  isProviderModelCatalogExactReady,
} from '@shared/utils/providerStatusAuthority';

import {
  createRuntimeStatusErrorProviderStatus,
  sanitizeProviderStatusAuthority,
} from '../runtime/providerStatusCheckContract';

import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

type CloneInstallationStatus = (status: CliInstallationStatus) => CliInstallationStatus;

export const FRONTEND_PROVIDER_IDS: readonly CliProviderId[] = ['anthropic', 'codex', 'opencode'];
const FRONTEND_PROVIDER_ID_SET = new Set<CliProviderId>(FRONTEND_PROVIDER_IDS);

export function isFrontendProvider(providerId: CliProviderId): boolean {
  return FRONTEND_PROVIDER_ID_SET.has(providerId);
}

export function getAuthenticatedFrontendProvider(
  providers: CliProviderStatus[]
): CliProviderStatus | null {
  return (
    providers.find(
      (provider) => isFrontendProvider(provider.providerId) && provider.authenticated
    ) ?? null
  );
}

export function hasAuthenticatedFrontendProvider(providers: CliProviderStatus[]): boolean {
  return getAuthenticatedFrontendProvider(providers) !== null;
}

export function filterFrontendProviders(providers: CliProviderStatus[]): CliProviderStatus[] {
  return providers.filter((provider) => isFrontendProvider(provider.providerId));
}

export function projectProviderAuthority(
  provider: CliProviderStatus,
  now: number
): CliProviderStatus {
  const projected = sanitizeProviderStatusAuthority(structuredClone(provider));
  const catalogFresh = isProviderModelCatalogExactReady(provider, now);
  const teamLaunch =
    hasAuthoritativeProviderStatusEvidence(provider) &&
    provider.authenticated === true &&
    provider.capabilities.teamLaunch === true &&
    catalogFresh;
  return {
    ...projected,
    modelCatalog:
      provider.modelCatalog && !catalogFresh
        ? { ...structuredClone(provider.modelCatalog), status: 'stale' }
        : provider.modelCatalog && structuredClone(provider.modelCatalog),
    modelCatalogRefreshState:
      provider.modelCatalog && !catalogFresh ? 'error' : provider.modelCatalogRefreshState,
    capabilities: { ...projected.capabilities, teamLaunch },
  };
}

export function projectStatusAuthority(
  status: CliInstallationStatus,
  now: number,
  cloneStatus: CloneInstallationStatus
): CliInstallationStatus {
  const cloned = cloneStatus(status);
  const providers = cloned.providers.map((provider) => projectProviderAuthority(provider, now));
  const authenticatedProvider = getAuthenticatedFrontendProvider(providers);
  return {
    ...cloned,
    providers,
    authLoggedIn:
      status.flavor === 'agent_teams_orchestrator'
        ? authenticatedProvider !== null
        : status.authLoggedIn,
    authMethod:
      status.flavor === 'agent_teams_orchestrator'
        ? (authenticatedProvider?.authMethod ?? null)
        : status.authMethod,
  };
}

export function resolvePassiveProviderRuntime(
  status: CliInstallationStatus | null,
  providerId: CliProviderId
): { binaryPath: string } | { errorStatus: CliProviderStatus } {
  if (!status?.binaryPath) {
    return {
      errorStatus: createRuntimeStatusErrorProviderStatus(
        providerId,
        new Error('Provider runtime missing')
      ),
    };
  }
  if (status.flavor !== 'agent_teams_orchestrator') {
    return {
      errorStatus: createRuntimeStatusErrorProviderStatus(
        providerId,
        new Error('Provider-scoped runtime status is unavailable for this CLI flavor')
      ),
    };
  }
  return { binaryPath: status.binaryPath };
}

export function projectMismatchedProviderStatus(
  requestedProviderId: CliProviderId,
  providerStatus: CliProviderStatus,
  now: number
): CliProviderStatus | null {
  return providerStatus.providerId === requestedProviderId
    ? null
    : projectProviderAuthority(
        createRuntimeStatusErrorProviderStatus(
          requestedProviderId,
          new Error('Provider status response did not match the requested provider')
        ),
        now
      );
}

export function createMismatchedProviderStatus(
  requestedProviderId: CliProviderId,
  providerStatus: CliProviderStatus
): CliProviderStatus | null {
  return providerStatus.providerId === requestedProviderId
    ? null
    : createRuntimeStatusErrorProviderStatus(
        requestedProviderId,
        new Error('Provider verification response did not match the requested provider')
      );
}
