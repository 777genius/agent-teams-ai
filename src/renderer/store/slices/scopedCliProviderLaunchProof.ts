import {
  getCliProviderProfileAuthorityFingerprint,
  normalizeCliProviderAuthorityProjectPath,
} from '@shared/utils/cliProviderAuthority';
import { hasFreshAuthoritativeScopedProviderStatus } from '@shared/utils/cliProviderStatus';

import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusAuthorityScope,
} from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export interface ScopedCliProviderLaunchProof {
  providerStatus: CliProviderStatus;
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
  /** Missing legacy entries are display-only and must not authorize launch. */
  authorityScope?: CliProviderStatusAuthorityScope;
}

export function setBoundedScopedProviderLaunchProof(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  scopeKey: string,
  proof: ScopedCliProviderLaunchProof
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, proof]);
  if (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.splice(0, entries.length - CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  }
  return Object.fromEntries(entries);
}

function isSemanticAuthorityObservation(status: CliProviderStatus): boolean {
  return !['pending', 'transient_error', 'model_only'].includes(status.statusCheckOutcome ?? '');
}

function deleteProvider(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  providerId: CliProviderId
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => !key.startsWith(`${providerId}\0`));
  return entries.length === Object.keys(current).length ? current : Object.fromEntries(entries);
}

function getObservedGeneration(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  select: (proof: ScopedCliProviderLaunchProof) => number | null
): number | null {
  let observed: number | null = null;
  for (const proof of Object.values(current)) {
    const generation = select(proof);
    if (generation !== null && (observed === null || generation > observed)) {
      observed = generation;
    }
  }
  return observed;
}

export function reconcileGlobalProviderLaunchProofs(
  currentProofs: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  currentStatus: CliInstallationStatus | null,
  incomingStatus: CliInstallationStatus
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  let nextProofs = currentProofs;
  for (const incoming of incomingStatus.providers) {
    if (!isSemanticAuthorityObservation(incoming)) continue;
    const current = currentStatus?.providers.find(
      ({ providerId }) => providerId === incoming.providerId
    );
    if (
      (current &&
        isSemanticAuthorityObservation(current) &&
        getCliProviderProfileAuthorityFingerprint(current) !==
          getCliProviderProfileAuthorityFingerprint(incoming)) ||
      (incoming.statusCheckOutcome === 'authoritative' && !incoming.authenticated)
    )
      nextProofs = deleteProvider(nextProofs, incoming.providerId);
  }
  return nextProofs;
}

export function reconcileScopedProviderLaunchProofs(input: {
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  scopeKey: string;
  providerId: CliProviderId;
  projectPath: string;
  providerStatus: CliProviderStatus;
  responseMatchesProvider: boolean;
  metadataMatchesRequest: boolean;
  authorityScope: CliProviderStatusAuthorityScope | null;
  requestIntent: 'passive' | 'launch-proof';
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
  observedGlobalGeneration?: number | null;
  observedProfileGeneration?: number | null;
}): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const previous = input.current[input.scopeKey];
  const scope = input.authorityScope;
  const scopeMatchesRequest =
    input.metadataMatchesRequest &&
    scope?.schemaVersion === 1 &&
    scope.providerId === input.providerId &&
    scope.projectPath === normalizeCliProviderAuthorityProjectPath(input.projectPath);
  const proofGlobalGeneration = getObservedGeneration(
    input.current,
    (proof) => proof.authorityScope?.globalGeneration ?? null
  );
  const proofProfileGeneration = getObservedGeneration(input.current, (proof) =>
    proof.authorityScope?.providerId === input.providerId
      ? proof.authorityScope.profileGeneration
      : null
  );
  // Proofs are bounded and may be removed on logout or refresh. The store
  // watermarks retain the highest main-process generations across removals.
  const observedGlobalGeneration = Math.max(
    input.observedGlobalGeneration ?? -1,
    proofGlobalGeneration ?? -1
  );
  const observedProfileGeneration = Math.max(
    input.observedProfileGeneration ?? -1,
    proofProfileGeneration ?? -1
  );
  const incomingGlobalGeneration = scope?.globalGeneration ?? null;
  const incomingProfileGeneration = scope?.profileGeneration ?? null;
  const incomingCatalogGeneration = scope?.catalogGeneration ?? null;
  const staleGlobalGeneration =
    scopeMatchesRequest &&
    observedGlobalGeneration >= 0 &&
    incomingGlobalGeneration !== null &&
    incomingGlobalGeneration < observedGlobalGeneration;
  const staleProfileGeneration =
    scopeMatchesRequest &&
    observedProfileGeneration >= 0 &&
    incomingProfileGeneration !== null &&
    incomingProfileGeneration < observedProfileGeneration;
  const newerGlobalGeneration =
    scopeMatchesRequest &&
    observedGlobalGeneration >= 0 &&
    incomingGlobalGeneration !== null &&
    incomingGlobalGeneration > observedGlobalGeneration;
  const newerProfileGeneration =
    scopeMatchesRequest &&
    observedProfileGeneration >= 0 &&
    incomingProfileGeneration !== null &&
    incomingProfileGeneration > observedProfileGeneration;
  const staleCatalogGeneration =
    scopeMatchesRequest &&
    previous?.authorityScope !== undefined &&
    incomingCatalogGeneration !== null &&
    incomingCatalogGeneration < previous.authorityScope.catalogGeneration;
  const globalLogout =
    input.responseMatchesProvider &&
    input.providerStatus.statusCheckOutcome === 'authoritative' &&
    !input.providerStatus.authenticated;
  const retained = newerGlobalGeneration
    ? {}
    : globalLogout || newerProfileGeneration
      ? deleteProvider(input.current, input.providerId)
      : input.current;
  const canAuthorize =
    input.requestIntent === 'launch-proof' &&
    input.responseMatchesProvider &&
    hasFreshAuthoritativeScopedProviderStatus(input.providerStatus) &&
    scopeMatchesRequest &&
    !globalLogout &&
    !staleGlobalGeneration &&
    !staleProfileGeneration &&
    !staleCatalogGeneration;
  return canAuthorize
    ? setBoundedScopedProviderLaunchProof(retained, input.scopeKey, {
        providerStatus: input.providerStatus,
        requestId: input.requestId,
        epoch: input.epoch,
        fetchedAtMs: input.fetchedAtMs,
        authorityScope: scope ?? undefined,
      })
    : retained;
}

export function reconcileScopedProviderAuthorityResponse(input: {
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  currentGlobalGeneration: number | null;
  currentProfileGenerationById: Readonly<Partial<Record<CliProviderId, number>>>;
  scopeKey: string;
  providerId: CliProviderId;
  projectPath: string;
  providerStatus: CliProviderStatus;
  responseMatchesProvider: boolean;
  metadataMatchesRequest: boolean;
  authorityScope: CliProviderStatusAuthorityScope | null;
  requestIntent: 'passive' | 'launch-proof';
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
}): {
  cliProviderLaunchProofByScope: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  cliProviderAuthorityGlobalGeneration: number | null;
  cliProviderAuthorityProfileGenerationById: Readonly<Partial<Record<CliProviderId, number>>>;
} {
  const cliProviderLaunchProofByScope = reconcileScopedProviderLaunchProofs({
    ...input,
    observedGlobalGeneration: input.currentGlobalGeneration,
    observedProfileGeneration: input.currentProfileGenerationById[input.providerId] ?? null,
  });
  const observedScope =
    input.responseMatchesProvider &&
    input.metadataMatchesRequest &&
    input.authorityScope?.providerId === input.providerId &&
    input.authorityScope.projectPath === normalizeCliProviderAuthorityProjectPath(input.projectPath)
      ? input.authorityScope
      : null;
  return {
    cliProviderLaunchProofByScope,
    cliProviderAuthorityGlobalGeneration: observedScope
      ? Math.max(input.currentGlobalGeneration ?? -1, observedScope.globalGeneration)
      : input.currentGlobalGeneration,
    cliProviderAuthorityProfileGenerationById: observedScope
      ? {
          ...input.currentProfileGenerationById,
          [input.providerId]: Math.max(
            input.currentProfileGenerationById[input.providerId] ?? -1,
            observedScope.profileGeneration
          ),
        }
      : input.currentProfileGenerationById,
  };
}
