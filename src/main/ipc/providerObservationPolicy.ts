import type { CliProviderId, CliProviderStatus } from '@shared/types';

export interface ProviderObservationRequestFence {
  epoch: number;
  order: number;
}

export interface ProviderObservationCompletionClaim {
  applyAuthority: boolean;
  applyCache: boolean;
}

export class ProviderObservationPolicy {
  private epoch = 0;
  private nextRequestOrder = 0;
  private readonly latestAuthorityOrderByProvider = new Map<CliProviderId, number>();
  private readonly latestCacheOrderByProvider = new Map<CliProviderId, number>();

  reset(): void {
    this.epoch += 1;
    this.nextRequestOrder = 0;
    this.latestAuthorityOrderByProvider.clear();
    this.latestCacheOrderByProvider.clear();
  }

  beginRequest(): ProviderObservationRequestFence {
    this.nextRequestOrder += 1;
    return { epoch: this.epoch, order: this.nextRequestOrder };
  }

  claimCompletion(
    providerStatus: CliProviderStatus,
    requestFence: ProviderObservationRequestFence
  ): ProviderObservationCompletionClaim {
    if (requestFence.epoch !== this.epoch) {
      return { applyAuthority: false, applyCache: false };
    }

    const providerId = providerStatus.providerId;
    const latestAuthorityOrder = this.latestAuthorityOrderByProvider.get(providerId) ?? 0;
    const latestCacheOrder = this.latestCacheOrderByProvider.get(providerId) ?? 0;
    if (isSemanticProviderAuthorityObservation(providerStatus)) {
      // Cache-only completions cannot suppress genuine authority. Older
      // authority still owns its auth/capability change, but not newer catalog data.
      if (requestFence.order < latestAuthorityOrder) {
        return { applyAuthority: false, applyCache: false };
      }
      this.latestAuthorityOrderByProvider.set(providerId, requestFence.order);

      const applyCache = requestFence.order >= latestCacheOrder;
      if (applyCache) {
        this.latestCacheOrderByProvider.set(providerId, requestFence.order);
      }
      return { applyAuthority: true, applyCache };
    }

    // Non-authoritative observations only own cache/catalog data. A newer
    // authority completion fences older cache data as well as older authority.
    if (requestFence.order < latestAuthorityOrder || requestFence.order < latestCacheOrder) {
      return { applyAuthority: false, applyCache: false };
    }
    this.latestCacheOrderByProvider.set(providerId, requestFence.order);
    return { applyAuthority: false, applyCache: true };
  }
}

export function isSemanticProviderAuthorityObservation(providerStatus: CliProviderStatus): boolean {
  // Missing legacy outcomes are ambiguous (including deferred/partial service
  // paths), so fail closed instead of inferring semantic authority from fields.
  return providerStatus.statusCheckOutcome === 'authoritative';
}

function mergeAuthoritativeProviderFields(
  cachedProviderStatus: CliProviderStatus,
  authoritativeProviderStatus: CliProviderStatus
): CliProviderStatus {
  return {
    ...cachedProviderStatus,
    supported: authoritativeProviderStatus.supported,
    authenticated: authoritativeProviderStatus.authenticated,
    authMethod: authoritativeProviderStatus.authMethod,
    verificationState: authoritativeProviderStatus.verificationState,
    statusCheckOutcome: authoritativeProviderStatus.statusCheckOutcome,
    statusCheckErrorCode: authoritativeProviderStatus.statusCheckErrorCode,
    canLoginFromUi: authoritativeProviderStatus.canLoginFromUi,
    capabilities: authoritativeProviderStatus.capabilities,
    selectedBackendId: authoritativeProviderStatus.selectedBackendId,
    resolvedBackendId: authoritativeProviderStatus.resolvedBackendId,
    availableBackends: authoritativeProviderStatus.availableBackends,
    backend: authoritativeProviderStatus.backend,
    connection: authoritativeProviderStatus.connection,
  };
}

export function mergeProviderObservationForCache(
  cachedProviderStatus: CliProviderStatus | null,
  providerStatus: CliProviderStatus,
  claim: ProviderObservationCompletionClaim
): CliProviderStatus | null {
  if (claim.applyAuthority) {
    if (claim.applyCache || !cachedProviderStatus) return providerStatus;
    return mergeAuthoritativeProviderFields(cachedProviderStatus, providerStatus);
  }
  if (!claim.applyCache) return cachedProviderStatus;
  if (cachedProviderStatus && providerStatus.statusCheckOutcome === 'model_only') {
    return mergeAuthoritativeProviderFields(providerStatus, cachedProviderStatus);
  }
  return providerStatus;
}
