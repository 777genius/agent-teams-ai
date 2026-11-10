import type { CliProviderModelCatalog } from '@shared/types';

export function isUsableCodexModelCatalog(
  catalog: CliProviderModelCatalog | null | undefined
): catalog is CliProviderModelCatalog {
  return (
    catalog?.schemaVersion === 1 &&
    catalog.providerId === 'codex' &&
    (catalog.source === 'app-server' || catalog.source === 'static-fallback') &&
    Array.isArray(catalog.models) &&
    catalog.models.some((model) => model.launchModel?.trim())
  );
}

export function isDynamicCodexModelCatalog(catalog: CliProviderModelCatalog): boolean {
  return (
    catalog.source === 'app-server' && (catalog.status === 'ready' || catalog.status === 'stale')
  );
}
