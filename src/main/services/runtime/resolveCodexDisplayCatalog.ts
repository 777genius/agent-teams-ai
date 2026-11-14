import type { CodexModelCatalogFeatureFacade } from '@features/codex-model-catalog/main';
import type { CliProviderModelCatalog } from '@shared/types';

/** Keep the runtime's catalog while enriching it with the user's Codex setting. */
export async function resolveCodexDisplayCatalog(
  runtimeCatalog: CliProviderModelCatalog | null,
  feature: Pick<CodexModelCatalogFeatureFacade, 'getCatalog'> | null,
  hydrate: boolean
): Promise<CliProviderModelCatalog | null> {
  let configured: CliProviderModelCatalog | null = null;
  if (hydrate && feature) {
    try {
      configured = await feature.getCatalog();
    } catch {
      // A failed config read must not discard an already usable runtime catalog.
    }
  }
  if (!runtimeCatalog) return configured;
  return configured?.configuredReasoningEffort
    ? { ...runtimeCatalog, configuredReasoningEffort: configured.configuredReasoningEffort }
    : runtimeCatalog;
}
