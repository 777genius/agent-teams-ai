import type { ProviderModelLaunchIdentity } from '@shared/types';

type ProviderId = ProviderModelLaunchIdentity['providerId'];

let generation = 0;
const generationByProviderId = new Map<ProviderId, number>();

export function captureGenerations(): ReadonlyMap<ProviderId, number> {
  return new Map(generationByProviderId);
}

export function generationsAreCurrent(
  capturedGenerations: ReadonlyMap<ProviderId, number>,
  providerIds: ReadonlySet<ProviderId>
): boolean {
  for (const providerId of providerIds) {
    if (
      (capturedGenerations.get(providerId) ?? 0) !== (generationByProviderId.get(providerId) ?? 0)
    ) {
      return false;
    }
  }
  return true;
}

export function invalidateAll(): void {
  generation += 1;
}

export function invalidateProvider(providerId: ProviderId): void {
  generation += 1;
  generationByProviderId.set(providerId, (generationByProviderId.get(providerId) ?? 0) + 1);
}

export function getProviderAuthorityGeneration(): number {
  return generation;
}
