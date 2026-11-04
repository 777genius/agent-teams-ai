import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
} from '../../contracts';

/** A read-only model lane can coexist with an optional credential upgrade. */
export function runtimeProviderDirectoryInteraction(
  provider: RuntimeProviderConnectionDto | RuntimeProviderDirectoryEntryDto | null | undefined
): {
  canOpenConnect: boolean;
  canSelectModels: boolean;
} {
  if (!provider) return { canOpenConnect: false, canSelectModels: false };
  const enabled = (id: 'connect' | 'test' | 'use'): boolean =>
    provider.actions.some((action) => action.id === id && action.enabled);
  const readOnlyModels =
    'setupKind' in provider && provider.setupKind === 'available-readonly' && enabled('use');
  const canSelectModels =
    provider.modelCount !== 0 &&
    (provider.state === 'connected' ||
      ('metadata' in provider && provider.metadata.configuredAuthless === true) ||
      enabled('test') ||
      readOnlyModels);
  return {
    canSelectModels,
    canOpenConnect:
      provider.state !== 'connected' && enabled('connect') && !(readOnlyModels && canSelectModels),
  };
}
