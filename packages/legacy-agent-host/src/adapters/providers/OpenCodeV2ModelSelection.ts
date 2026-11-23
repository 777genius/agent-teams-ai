import { setTimeout as delay } from 'node:timers/promises';

import { ManagementCommandError } from '../../management/commandRecords.js';

interface SelectedModel {
  providerID: string;
  id: string;
  variant?: string;
}
interface NativeCatalog {
  provider: { id: string; activation: string } | null;
  defaultModel: { providerId: string; modelId: string } | null;
  models: readonly {
    id: string;
    enabled: boolean;
    variants?: readonly string[];
    supportsTools?: boolean;
  }[];
}

/** A native model/variant must exist before an owned session is created or a prompt is admitted. */
export async function attestOpenCodeV2ModelSelection(
  client: { readCatalog(providerId: string): Promise<NativeCatalog> },
  selection: SelectedModel,
  options: { signal: AbortSignal; deadline: number; isCurrent(): boolean; requireTools?: boolean },
  observePhase?: (phase: 'catalog-read-returned' | 'catalog-current-returned' | 'catalog-repeat') => void
): Promise<void> {
  const observe = (phase: Parameters<NonNullable<typeof observePhase>>[0]) => {
    try { observePhase?.(phase); } catch { /* Passive diagnostics cannot replace the original result. */ }
  };
  const current = () => {
    options.signal.throwIfAborted();
    if (!options.isCurrent() || Date.now() >= options.deadline)
      throw new ManagementCommandError('held');
  };
  let reads = 0;
  for (;;) {
    current();
    if (++reads === 2) observe('catalog-repeat');
    const catalog = await client.readCatalog(selection.providerID);
    if (reads === 1) observe('catalog-read-returned');
    current();
    if (reads === 1) observe('catalog-current-returned');
    const model = catalog.models.find((row) => row.id === selection.id);
    if (catalog.provider && model) {
      if (
        catalog.provider.id !== selection.providerID ||
        catalog.provider.activation === 'disabled' ||
        !model.enabled ||
        !Array.isArray(model.variants) ||
        (selection.variant !== undefined &&
          selection.variant !== 'default' &&
          !model.variants.includes(selection.variant)) ||
        (options.requireTools === true && model.supportsTools !== true) ||
        catalog.defaultModel?.providerId !== selection.providerID ||
        catalog.defaultModel.modelId !== selection.id
      )
        throw new ManagementCommandError('invalid');
      return;
    }
    // Native plugin/model activation is asynchronous; share the original finite owner budget.
    await delay(Math.min(50, Math.max(1, options.deadline - Date.now())), undefined, {
      signal: options.signal,
    });
  }
}
