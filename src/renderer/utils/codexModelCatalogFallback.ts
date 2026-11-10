import type { CliProviderModelCatalog } from '@shared/types';

export function isCodexModelCatalogFallbackActive(
  catalog: CliProviderModelCatalog | null | undefined
): boolean {
  return (
    catalog?.providerId === 'codex' &&
    catalog.source === 'static-fallback' &&
    catalog.status !== 'ready'
  );
}
