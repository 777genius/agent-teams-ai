import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
} from '../../contracts';

/** Configured or read-only models can coexist with an optional credential connection. */
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
  const testModels = enabled('test');
  const canSelectModels =
    provider.modelCount !== 0 &&
    (provider.state === 'connected' ||
      ('metadata' in provider && provider.metadata.configuredAuthless === true) ||
      testModels ||
      readOnlyModels);
  return {
    canSelectModels,
    canOpenConnect:
      provider.state !== 'connected' && enabled('connect') &&
      !((readOnlyModels || testModels) && canSelectModels),
  };
}
