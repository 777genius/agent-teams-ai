import { createCodexAccountFeature } from '@features/codex-account/main';
import { createCodexModelCatalogFeature } from '@features/codex-model-catalog/main';
import { createLogger } from '@shared/utils/logger';

import { getDesktopCodexFeatures } from '../ipc/agentBackend';

/** Shell composition keeps the selected native source exclusive while preserving the legacy default. */
export function createDesktopCodexFeatures(
  configManager: Parameters<typeof createCodexAccountFeature>[0]['configManager']
) {
  const native = getDesktopCodexFeatures(
    () => configManager.getConfig().providerConnections.codex.preferredAuthMode ?? 'auto'
  );
  const accountFeature =
    native?.accountFeature ??
    createCodexAccountFeature({
      logger: createLogger('Feature:CodexAccount'),
      configManager,
    });
  const modelCatalogFeature =
    native?.modelCatalogFeature ??
    createCodexModelCatalogFeature({
      logger: createLogger('Feature:CodexModelCatalog'),
      codexAccountFeature: accountFeature,
    });
  return { accountFeature, modelCatalogFeature, native: native !== undefined };
}
