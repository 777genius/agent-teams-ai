import { getAnthropicDefaultTeamModel } from './anthropicModelDefaults';
import { isDefaultProviderModelSelection } from './providerModelSelection';

function stripOneMillionSuffix(model: string): string {
  return model.replace(/(?:\[1m\])+$/i, '');
}

function hasOneMillionSuffix(model: string): boolean {
  return /\[1m\]$/i.test(model);
}

function isAnthropicHaikuModel(model: string): boolean {
  const baseModel = stripOneMillionSuffix(model);
  return baseModel === 'haiku' || baseModel.startsWith('claude-haiku-');
}

function isAnthropicSonnetModel(model: string): boolean {
  const baseModel = stripOneMillionSuffix(model);
  return baseModel === 'sonnet' || baseModel.startsWith('claude-sonnet-');
}

function isAnthropicOpusModel(model: string): boolean {
  const baseModel = stripOneMillionSuffix(model);
  return baseModel === 'opus' || baseModel.startsWith('claude-opus-');
}

function isAnthropicFamilyAlias(model: string): boolean {
  return ['opus', 'sonnet', 'haiku'].includes(stripOneMillionSuffix(model));
}

function normalizeStandardOnlyAnthropicModel(model: string): string {
  const baseModel = stripOneMillionSuffix(model);
  return isAnthropicHaikuModel(baseModel) || isAnthropicSonnetModel(baseModel) ? baseModel : model;
}

function normalizeAvailableLaunchModels(
  availableLaunchModels: Iterable<string> | undefined
): Set<string> {
  const normalized = new Set<string>();
  for (const model of availableLaunchModels ?? []) {
    const trimmed = model.trim();
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return normalized;
}

function chooseAvailableModel(
  availableModels: Set<string>,
  candidates: readonly string[]
): string | null {
  if (availableModels.size === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (availableModels.has(candidate)) {
      return candidate;
    }
  }

  return null;
}

export function isAnthropicContextPolicyLaunchModelAvailable(
  modelIds: ReadonlySet<string>,
  resolvedLaunchModel: string
): boolean {
  if (modelIds.has(resolvedLaunchModel)) return true;
  const baseModel = stripOneMillionSuffix(resolvedLaunchModel);
  return baseModel !== resolvedLaunchModel && modelIds.has(baseModel);
}

export function resolveAnthropicLaunchModel(params: {
  selectedModel?: string | null;
  limitContext: boolean;
  availableLaunchModels?: Iterable<string>;
  defaultLaunchModel?: string | null;
}): string | null {
  const selectedModel = params.selectedModel?.trim() ?? '';
  const availableModels = normalizeAvailableLaunchModels(params.availableLaunchModels);

  if (!selectedModel || isDefaultProviderModelSelection(selectedModel)) {
    const staticDefault = getAnthropicDefaultTeamModel(params.limitContext);
    const runtimeDefault = params.defaultLaunchModel?.trim() || null;
    const rawPreferredDefault = runtimeDefault || staticDefault;
    const preferredDefault = params.limitContext
      ? stripOneMillionSuffix(rawPreferredDefault) || staticDefault
      : normalizeStandardOnlyAnthropicModel(rawPreferredDefault) || staticDefault;
    // A context policy may add/remove [1m], but catalog aliases and static
    // fallbacks must never replace the runtime's concrete default identity.
    if (runtimeDefault && !isAnthropicFamilyAlias(runtimeDefault)) {
      return preferredDefault;
    }
    if (availableModels.size === 0) {
      return preferredDefault;
    }

    return (
      chooseAvailableModel(availableModels, [
        preferredDefault,
        stripOneMillionSuffix(runtimeDefault || preferredDefault),
        staticDefault,
        stripOneMillionSuffix(staticDefault),
      ]) ?? preferredDefault
    );
  }

  const selectedOneMillionContext = hasOneMillionSuffix(selectedModel);
  const baseModel = stripOneMillionSuffix(selectedModel);
  if (!baseModel) {
    return null;
  }

  if (params.limitContext) {
    return baseModel;
  }

  if (isAnthropicHaikuModel(baseModel)) {
    return baseModel;
  }

  if (isAnthropicSonnetModel(baseModel) && !selectedOneMillionContext) {
    return baseModel;
  }

  if (!isAnthropicOpusModel(baseModel)) {
    return selectedOneMillionContext ? `${baseModel}[1m]` : baseModel;
  }

  const preferredLongContextModel = `${baseModel}[1m]`;

  if (availableModels.size === 0) {
    return preferredLongContextModel;
  }

  return chooseAvailableModel(availableModels, [preferredLongContextModel, baseModel]) ?? baseModel;
}
