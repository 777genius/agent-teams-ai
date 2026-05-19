import { normalizeCodexReasoningEffort, CODEX_REASONING_EFFORTS } from './codexReasoningEffort';

import type { CodexAppServerModel } from '@main/services/infrastructure/codexAppServer';
import type { CliProviderModelCatalogItem, CliProviderReasoningEffort } from '@shared/types';

export interface NormalizedCodexModelCatalogResult {
  models: CliProviderModelCatalogItem[];
  defaultModelId: string | null;
  diagnostics: string[];
}

function normalizeModelId(model: CodexAppServerModel): string | null {
  const id = model.id?.trim() || model.model?.trim() || null;
  return id && id.length > 0 ? id : null;
}

function normalizeEffortOption(option: unknown): CliProviderReasoningEffort | null {
  if (typeof option === 'string') {
    return normalizeCodexReasoningEffort(option);
  }

  if (option && typeof option === 'object' && 'reasoningEffort' in option) {
    return normalizeCodexReasoningEffort((option as { reasoningEffort?: unknown }).reasoningEffort);
  }

  return null;
}

function normalizeEfforts(model: CodexAppServerModel): CliProviderReasoningEffort[] {
  const efforts = model.supportedReasoningEfforts?.flatMap((option) => {
    const normalized = normalizeEffortOption(option);
    return normalized ? [normalized] : [];
  });

  if (!efforts || efforts.length === 0) {
    return ['low', 'medium', 'high'];
  }

  return CODEX_REASONING_EFFORTS.filter((effort) => efforts.includes(effort));
}

function normalizeDefaultEffort(
  defaultEffort: unknown,
  supportedEfforts: readonly CliProviderReasoningEffort[]
): CliProviderReasoningEffort | null {
  const normalized = normalizeCodexReasoningEffort(defaultEffort);
  if (!normalized) {
    return supportedEfforts.includes('medium') ? 'medium' : (supportedEfforts[0] ?? null);
  }

  return supportedEfforts.includes(normalized)
    ? normalized
    : supportedEfforts.includes('medium')
      ? 'medium'
      : (supportedEfforts[0] ?? null);
}

function normalizeModalities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['text', 'image'];
  }

  const seen = new Set<string>();
  const modalities: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim().toLowerCase();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    modalities.push(normalized);
  }

  return modalities.length > 0 ? modalities : ['text', 'image'];
}

function asBadgeLabel(modelId: string): string {
  return modelId.replace(/^gpt-/, '');
}

export function normalizeCodexAppServerModels(
  models: readonly CodexAppServerModel[] | undefined,
  options: {
    includeHidden?: boolean;
  } = {}
): NormalizedCodexModelCatalogResult {
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  const seenLaunchModels = new Set<string>();
  const normalizedModels: CliProviderModelCatalogItem[] = [];

  for (const model of models ?? []) {
    const id = normalizeModelId(model);
    if (!id) {
      diagnostics.push('model/list returned a model without id/model.');
      continue;
    }

    if (seen.has(id)) {
      diagnostics.push(`model/list returned duplicate model id ${id}.`);
      continue;
    }
    seen.add(id);

    const hidden = model.hidden === true;
    if (hidden && options.includeHidden !== true) {
      continue;
    }

    const launchModel = model.model?.trim() || id;
    if (seenLaunchModels.has(launchModel)) {
      diagnostics.push(`model/list returned duplicate launch model ${launchModel}.`);
      continue;
    }
    seenLaunchModels.add(launchModel);

    const supportedReasoningEfforts = normalizeEfforts(model);
    normalizedModels.push({
      id,
      launchModel,
      displayName: model.displayName?.trim() || id,
      hidden,
      supportedReasoningEfforts,
      defaultReasoningEffort: normalizeDefaultEffort(
        model.defaultReasoningEffort,
        supportedReasoningEfforts
      ),
      inputModalities: normalizeModalities(model.inputModalities),
      supportsPersonality: model.supportsPersonality === true,
      isDefault: model.isDefault === true,
      upgrade: Boolean(model.upgrade),
      source: 'app-server',
      badgeLabel: asBadgeLabel(id),
    });
  }

  const defaultModel =
    normalizedModels.find((model) => model.isDefault) ??
    normalizedModels.find((model) => !model.hidden) ??
    normalizedModels[0] ??
    null;

  return {
    models: normalizedModels,
    defaultModelId: defaultModel?.id ?? null,
    diagnostics,
  };
}
