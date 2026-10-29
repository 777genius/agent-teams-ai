import type { RuntimeProviderDirectoryEntryDto } from '../../contracts';

/** A read-only model lane can coexist with an optional credential upgrade. */
export function runtimeProviderDirectoryInteraction(provider: RuntimeProviderDirectoryEntryDto): {
  canOpenConnect: boolean;
  canSelectModels: boolean;
} {
  const enabled = (id: 'connect' | 'test' | 'use'): boolean =>
    provider.actions.some((action) => action.id === id && action.enabled);
  const readOnlyModels = provider.setupKind === 'available-readonly' && enabled('use');
  const canSelectModels =
    provider.modelCount !== 0 &&
    (provider.state === 'connected' ||
      provider.metadata.configuredAuthless === true ||
      enabled('test') ||
      readOnlyModels);
  return {
    canSelectModels,
    canOpenConnect:
      provider.state !== 'connected' && enabled('connect') && !(readOnlyModels && canSelectModels),
  };
}
