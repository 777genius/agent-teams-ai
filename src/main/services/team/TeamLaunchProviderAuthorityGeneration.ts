import type { CliProviderStatusAuthorityScope, ProviderModelLaunchIdentity } from '@shared/types';

type ProviderId = ProviderModelLaunchIdentity['providerId'];

export interface CapturedProviderAuthorityGenerations {
  globalGeneration: number;
  projectPath: string;
  profileGenerationByProviderId: ReadonlyMap<ProviderId, number>;
  catalogGenerationByProviderId: ReadonlyMap<ProviderId, number>;
}

let globalGeneration = 0;
const profileGenerationByProviderId = new Map<ProviderId, number>();
const catalogGenerationsByProviderId = new Map<ProviderId, Map<string, number>>();
let aggregateGeneration = 0;

/**
 * Catalog generations are subordinate to a provider profile epoch. Crossing
 * this bound advances that epoch and retires all of its catalog generations,
 * so forgotten scopes remain stale without permanent tombstones.
 */
export const MAX_CATALOG_AUTHORITY_SCOPES_PER_PROVIDER = 128;

function catalogGenerations(providerId: ProviderId): Map<string, number> | undefined {
  return catalogGenerationsByProviderId.get(providerId);
}

function catalogGeneration(providerId: ProviderId, projectPath: string): number {
  return catalogGenerations(providerId)?.get(projectPath) ?? 0;
}

function retireProviderCatalogGenerations(providerId: ProviderId): void {
  catalogGenerationsByProviderId.delete(providerId);
}

function bumpProviderProfileGeneration(providerId: ProviderId): void {
  profileGenerationByProviderId.set(
    providerId,
    (profileGenerationByProviderId.get(providerId) ?? 0) + 1
  );
  retireProviderCatalogGenerations(providerId);
  aggregateGeneration += 1;
}

export function captureGenerations(projectPath: string): CapturedProviderAuthorityGenerations {
  const catalogGenerationByProviderId = new Map<ProviderId, number>();
  for (const providerId of profileGenerationByProviderId.keys()) {
    catalogGenerationByProviderId.set(providerId, catalogGeneration(providerId, projectPath));
  }
  // Catalog-only providers have no profile-map entry yet. Iterating provider
  // buckets keeps capture work independent of the number of retained scopes.
  for (const [providerId, generations] of catalogGenerationsByProviderId.entries()) {
    if (!profileGenerationByProviderId.has(providerId)) {
      catalogGenerationByProviderId.set(providerId, generations.get(projectPath) ?? 0);
    }
  }
  return {
    globalGeneration,
    projectPath,
    profileGenerationByProviderId: new Map(profileGenerationByProviderId),
    catalogGenerationByProviderId,
  };
}

export function generationsAreCurrent(
  captured: CapturedProviderAuthorityGenerations,
  providerIds: ReadonlySet<ProviderId>
): boolean {
  if (captured.globalGeneration !== globalGeneration) return false;
  for (const providerId of providerIds) {
    if (
      (captured.profileGenerationByProviderId.get(providerId) ?? 0) !==
        (profileGenerationByProviderId.get(providerId) ?? 0) ||
      (captured.catalogGenerationByProviderId.get(providerId) ?? 0) !==
        catalogGeneration(providerId, captured.projectPath)
    ) {
      return false;
    }
  }
  return true;
}

export function getAuthorityScope(
  providerId: ProviderId,
  projectPath: string | null
): CliProviderStatusAuthorityScope {
  return {
    schemaVersion: 1,
    providerId,
    projectPath,
    globalGeneration,
    profileGeneration: profileGenerationByProviderId.get(providerId) ?? 0,
    catalogGeneration: projectPath ? catalogGeneration(providerId, projectPath) : 0,
  };
}

export function invalidateAll(): void {
  globalGeneration += 1;
  aggregateGeneration += 1;
}

export function invalidateProviderProfile(providerId: ProviderId): void {
  bumpProviderProfileGeneration(providerId);
}

export function invalidateProviderCatalog(providerId: ProviderId, projectPath: string): void {
  let generations = catalogGenerations(providerId);
  if (
    generations !== undefined &&
    !generations.has(projectPath) &&
    generations.size >= MAX_CATALOG_AUTHORITY_SCOPES_PER_PROVIDER
  ) {
    bumpProviderProfileGeneration(providerId);
    generations = undefined;
  }
  if (!generations) {
    generations = new Map<string, number>();
    catalogGenerationsByProviderId.set(providerId, generations);
  }
  generations.set(projectPath, (generations.get(projectPath) ?? 0) + 1);
  aggregateGeneration += 1;
}

/** Backward-compatible aggregate generation used only as a read-only diagnostic seam. */
export function getProviderAuthorityGeneration(): number {
  return aggregateGeneration;
}

/** Read-only bounded-state diagnostics for regression tests and support probes. */
export function getProviderAuthorityGenerationDiagnostics(): {
  retainedCatalogScopeCount: number;
  catalogProviderCount: number;
  captureProviderLookupCount: number;
} {
  let retainedCatalogScopeCount = 0;
  for (const generations of catalogGenerationsByProviderId.values()) {
    retainedCatalogScopeCount += generations.size;
  }
  return {
    retainedCatalogScopeCount,
    catalogProviderCount: catalogGenerationsByProviderId.size,
    captureProviderLookupCount: new Set([
      ...profileGenerationByProviderId.keys(),
      ...catalogGenerationsByProviderId.keys(),
    ]).size,
  };
}
