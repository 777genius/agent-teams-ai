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
const catalogGenerationByScope = new Map<string, number>();

function catalogScopeKey(providerId: ProviderId, projectPath: string): string {
  return `${providerId}\0${projectPath}`;
}

export function captureGenerations(projectPath: string): CapturedProviderAuthorityGenerations {
  const catalogGenerationByProviderId = new Map<ProviderId, number>();
  for (const providerId of profileGenerationByProviderId.keys()) {
    catalogGenerationByProviderId.set(
      providerId,
      catalogGenerationByScope.get(catalogScopeKey(providerId, projectPath)) ?? 0
    );
  }
  for (const key of catalogGenerationByScope.keys()) {
    const separator = key.indexOf('\0');
    if (separator < 0 || key.slice(separator + 1) !== projectPath) continue;
    const providerId = key.slice(0, separator) as ProviderId;
    catalogGenerationByProviderId.set(providerId, catalogGenerationByScope.get(key) ?? 0);
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
        (catalogGenerationByScope.get(catalogScopeKey(providerId, captured.projectPath)) ?? 0)
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
    catalogGeneration: projectPath
      ? (catalogGenerationByScope.get(catalogScopeKey(providerId, projectPath)) ?? 0)
      : 0,
  };
}

export function invalidateAll(): void {
  globalGeneration += 1;
}

export function invalidateProviderProfile(providerId: ProviderId): void {
  profileGenerationByProviderId.set(
    providerId,
    (profileGenerationByProviderId.get(providerId) ?? 0) + 1
  );
}

export function invalidateProviderCatalog(providerId: ProviderId, projectPath: string): void {
  const key = catalogScopeKey(providerId, projectPath);
  catalogGenerationByScope.set(key, (catalogGenerationByScope.get(key) ?? 0) + 1);
}

/** Backward-compatible aggregate generation used only as a read-only diagnostic seam. */
export function getProviderAuthorityGeneration(): number {
  let generation = globalGeneration;
  for (const value of profileGenerationByProviderId.values()) generation += value;
  for (const value of catalogGenerationByScope.values()) generation += value;
  return generation;
}
