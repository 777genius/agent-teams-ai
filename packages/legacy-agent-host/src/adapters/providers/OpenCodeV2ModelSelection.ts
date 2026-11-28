import { setTimeout as delay } from 'node:timers/promises';
import { types } from 'node:util';

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

export interface OpenCodeCatalogRepeatObservation {
  readonly catalogProviderPresent: boolean;
  readonly catalogModelPresent: boolean;
}

function missingSelection(catalog: NativeCatalog, model: NativeCatalog['models'][number] | undefined):
  OpenCodeCatalogRepeatObservation | undefined {
  try {
    if (types.isProxy(catalog)) return;
    const field = Object.getOwnPropertyDescriptor(catalog, 'provider');
    if (!field || !Object.hasOwn(field, 'value')) return;
    const provider: unknown = field.value;
    if (provider !== null && (typeof provider !== 'object' || Array.isArray(provider) || types.isProxy(provider))) return;
    const catalogProviderPresent = provider !== null, catalogModelPresent = model !== undefined;
    if (catalogProviderPresent && catalogModelPresent) return;
    return Object.freeze({ catalogProviderPresent, catalogModelPresent });
  } catch { return; }
}

/** A native model/variant must exist before an owned session is created or a prompt is admitted. */
export async function attestOpenCodeV2ModelSelection(
  client: { readCatalog(providerId: string): Promise<NativeCatalog> },
  selection: SelectedModel,
  options: { signal: AbortSignal; deadline: number; isCurrent(): boolean; requireTools?: boolean },
  observePhase?: (phase: 'catalog-read-returned' | 'catalog-current-returned' | 'catalog-repeat',
    detail?: OpenCodeCatalogRepeatObservation) => void
): Promise<void> {
  const observe = (phase: Parameters<NonNullable<typeof observePhase>>[0], detail?: OpenCodeCatalogRepeatObservation) => {
    try {
      if (detail === undefined) observePhase?.(phase);
      else observePhase?.(phase, detail);
    } catch { /* Passive diagnostics cannot replace the original result. */ }
  };
  const current = () => {
    options.signal.throwIfAborted();
    if (!options.isCurrent() || Date.now() >= options.deadline)
      throw new ManagementCommandError('held');
  };
  let reads = 0;
  let firstMissing: OpenCodeCatalogRepeatObservation | undefined;
  for (;;) {
    current();
    if (++reads === 2) observe('catalog-repeat', firstMissing);
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
    if (reads === 1 && observePhase) firstMissing = missingSelection(catalog, model);
    // Native plugin/model activation is asynchronous; share the original finite owner budget.
    await delay(Math.min(50, Math.max(1, options.deadline - Date.now())), undefined, {
      signal: options.signal,
    });
  }
}
