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
/** Mirrors main's per-provider catalog authority scope bound. */
export const CLI_PROVIDER_CATALOG_WATERMARK_SCOPE_LIMIT = 128;

export interface ScopedCliProviderLaunchProof {
  providerStatus: CliProviderStatus;
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
  /** Missing legacy entries are display-only and must not authorize launch. */
  authorityScope?: CliProviderStatusAuthorityScope;
}

export interface ScopedCliProviderAuthorityState {
  /** Monotonic tombstones prevent late cross-project responses from reviving cleared proofs. */
  cliProviderAuthorityGlobalGeneration: number | null;
  cliProviderAuthorityProfileGenerationById: Readonly<Partial<Record<CliProviderId, number>>>;
  cliProviderCatalogWatermarkById: Readonly<
    Partial<Record<CliProviderId, ScopedCliProviderCatalogWatermark>>
  >;
}

export interface ScopedCliProviderCatalogWatermark {
  profileGeneration: number;
  catalogGenerationByProjectPath: Readonly<Record<string, number>>;
  /** Fail closed if main ever violates its matching bounded-scope contract. */
  saturated: boolean;
}

export function createEmptyScopedCliProviderAuthorityState(): ScopedCliProviderAuthorityState {
  return {
    cliProviderAuthorityGlobalGeneration: null,
    cliProviderAuthorityProfileGenerationById: {},
    cliProviderCatalogWatermarkById: {},
  };
}

export function setBoundedScopedProviderLaunchProof(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  scopeKey: string,
  proof: ScopedCliProviderLaunchProof
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, proof]);
  while (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.shift();
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

function getProjectCatalogWatermark(
  current: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'],
  providerId: CliProviderId,
  profileGeneration: number | null,
  projectPath: string
): number | null {
  if (profileGeneration === null) return null;
  const providerWatermark = current[providerId];
  if (!providerWatermark || providerWatermark.profileGeneration !== profileGeneration) return null;
  return providerWatermark.catalogGenerationByProjectPath[projectPath] ?? null;
}

function deleteProviderCatalogWatermark(
  current: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'],
  providerId: CliProviderId
): ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'] {
  if (!current[providerId]) return current;
  const next = { ...current };
  delete next[providerId];
  return next;
}

function retainProjectCatalogWatermark(
  current: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'],
  providerId: CliProviderId,
  profileGeneration: number,
  projectPath: string,
  catalogGeneration: number
): ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'] {
  const currentProvider = current[providerId];
  const provider =
    currentProvider?.profileGeneration === profileGeneration
      ? currentProvider
      : {
          profileGeneration,
          catalogGenerationByProjectPath: {},
          saturated: false,
        };
  if (provider.saturated) return current;
  const previousGeneration = provider.catalogGenerationByProjectPath[projectPath];
  // Zero is main's implicit value for an untracked scope. It needs no tombstone
  // and retaining it would let ordinary project reads consume the scope bound.
  if (previousGeneration === undefined && catalogGeneration === 0) return current;
  if (previousGeneration !== undefined && previousGeneration >= catalogGeneration) return current;
  const isNewScope = previousGeneration === undefined;
  if (
    isNewScope &&
    Object.keys(provider.catalogGenerationByProjectPath).length >=
      CLI_PROVIDER_CATALOG_WATERMARK_SCOPE_LIMIT
  ) {
    return { ...current, [providerId]: { ...provider, saturated: true } };
  }
  return {
    ...current,
    [providerId]: {
      ...provider,
      catalogGenerationByProjectPath: {
        ...provider.catalogGenerationByProjectPath,
        [projectPath]: catalogGeneration,
      },
    },
  };
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
  const catalogWatermarks = Object.values(input.current).reduce<
    ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById']
  >((watermarks, proof) => {
    const scope = proof.authorityScope;
    if (!scope?.projectPath) return watermarks;
    return retainProjectCatalogWatermark(
      watermarks,
      scope.providerId,
      scope.profileGeneration,
      scope.projectPath,
      scope.catalogGeneration
    );
  }, {});
  return reconcileScopedProviderAuthority({
    ...input,
    currentCatalogWatermarkById: catalogWatermarks,
  }).cliProviderLaunchProofByScope;
}

function reconcileScopedProviderAuthority(input: {
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  currentCatalogWatermarkById: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'];
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
}): {
  cliProviderLaunchProofByScope: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  cliProviderCatalogWatermarkById: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'];
} {
  const scope = input.authorityScope;
  const normalizedProjectPath = normalizeCliProviderAuthorityProjectPath(input.projectPath);
  const scopeMatchesRequest =
    input.metadataMatchesRequest &&
    scope?.schemaVersion === 1 &&
    scope.providerId === input.providerId &&
    scope.projectPath === normalizedProjectPath;
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
  const providerWatermark = input.currentCatalogWatermarkById[input.providerId];
  const providerCatalogWatermark = getProjectCatalogWatermark(
    input.currentCatalogWatermarkById,
    input.providerId,
    incomingProfileGeneration,
    normalizedProjectPath
  );
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
    providerCatalogWatermark !== null &&
    incomingCatalogGeneration !== null &&
    incomingCatalogGeneration < providerCatalogWatermark;
  const saturatedCatalogWatermark =
    scopeMatchesRequest &&
    !newerGlobalGeneration &&
    !newerProfileGeneration &&
    providerWatermark?.profileGeneration === incomingProfileGeneration &&
    providerWatermark.saturated;
  const globalLogout =
    input.responseMatchesProvider &&
    input.providerStatus.statusCheckOutcome === 'authoritative' &&
    !input.providerStatus.authenticated;
  const retained = newerGlobalGeneration
    ? {}
    : globalLogout || newerProfileGeneration
      ? deleteProvider(input.current, input.providerId)
      : input.current;
  let retainedCatalogWatermarks = newerGlobalGeneration
    ? {}
    : globalLogout || newerProfileGeneration
      ? deleteProviderCatalogWatermark(input.currentCatalogWatermarkById, input.providerId)
      : input.currentCatalogWatermarkById;
  const canObserveCatalogGeneration =
    input.responseMatchesProvider &&
    scopeMatchesRequest &&
    !globalLogout &&
    !staleGlobalGeneration &&
    !staleProfileGeneration &&
    !staleCatalogGeneration &&
    !saturatedCatalogWatermark;
  if (canObserveCatalogGeneration) {
    retainedCatalogWatermarks = retainProjectCatalogWatermark(
      retainedCatalogWatermarks,
      input.providerId,
      incomingProfileGeneration!,
      normalizedProjectPath,
      incomingCatalogGeneration!
    );
  }
  const catalogWatermarkSaturated =
    retainedCatalogWatermarks[input.providerId]?.profileGeneration === incomingProfileGeneration &&
    retainedCatalogWatermarks[input.providerId]?.saturated;
  const canAuthorize =
    input.requestIntent === 'launch-proof' &&
    input.responseMatchesProvider &&
    hasFreshAuthoritativeScopedProviderStatus(input.providerStatus) &&
    scopeMatchesRequest &&
    !globalLogout &&
    !staleGlobalGeneration &&
    !staleProfileGeneration &&
    !staleCatalogGeneration &&
    !catalogWatermarkSaturated;
  if (!canAuthorize) {
    return {
      cliProviderLaunchProofByScope: retained,
      cliProviderCatalogWatermarkById: retainedCatalogWatermarks,
    };
  }
  const proof = {
    providerStatus: input.providerStatus,
    requestId: input.requestId,
    epoch: input.epoch,
    fetchedAtMs: input.fetchedAtMs,
    authorityScope: scope ?? undefined,
  };
  return {
    cliProviderLaunchProofByScope: setBoundedScopedProviderLaunchProof(
      retained,
      input.scopeKey,
      proof
    ),
    cliProviderCatalogWatermarkById: retainedCatalogWatermarks,
  };
}

export function reconcileScopedProviderAuthorityResponse(input: {
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>;
  currentGlobalGeneration: number | null;
  currentProfileGenerationById: Readonly<Partial<Record<CliProviderId, number>>>;
  currentCatalogWatermarkById: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'];
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
  cliProviderCatalogWatermarkById: ScopedCliProviderAuthorityState['cliProviderCatalogWatermarkById'];
} {
  const reconciled = reconcileScopedProviderAuthority({
    ...input,
    currentCatalogWatermarkById: input.currentCatalogWatermarkById,
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
    ...reconciled,
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
