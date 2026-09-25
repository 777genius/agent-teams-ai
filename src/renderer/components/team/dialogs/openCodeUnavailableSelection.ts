import { getTeamModelSourceBadgeLabel } from '@renderer/utils/teamModelCatalog';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';

// A selected route that its own provider's fresh catalog no longer offers (for
// example after that provider's key was removed) must stay on screen as
// unavailable. Normalizing it to '' would silently launch Default instead.
// Switching to a different source tab still clears the selection as before,
// because then the loaded catalog belongs to another provider.
export function shouldKeepUnavailableOpenCodeSelection(input: {
  value: string;
  runtimeNormalizedValue: string;
  catalogSourceProviderId: string | null;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  catalogState: 'fresh' | 'stale' | null;
  isLocalModel: boolean;
  disabledReason: string | null;
}): boolean {
  const value = input.value.trim();
  if (!value || input.runtimeNormalizedValue.trim() || input.isLocalModel || input.disabledReason) {
    return false;
  }
  if (input.catalogStatus !== 'ready' || input.catalogState !== 'fresh') {
    return false;
  }
  const sourceId = parseOpenCodeQualifiedModelRef(value)?.sourceId?.trim().toLowerCase();
  return Boolean(sourceId) && sourceId === input.catalogSourceProviderId?.trim().toLowerCase();
}

// The option shown for a selection the current catalog cannot confirm: either
// a kept unavailable route (above) or an explicit local model that the local
// provider lookup does not serve in this project.
export function buildSelectedOpenCodeFallbackOption(input: {
  value: string;
  keepUnavailable: boolean;
  unavailableReason: string;
  selectedUnverifiedLocalModel: boolean;
  localProvidersLoading: boolean;
  localProviderLookupError: string | null | undefined;
}): TeamRuntimeModelOption | null {
  const selectedModel = input.value.trim();
  if (input.keepUnavailable) {
    return buildUnavailableOpenCodeSelectionOption(selectedModel, input.unavailableReason);
  }
  if (!input.selectedUnverifiedLocalModel || !selectedModel) {
    return null;
  }
  const parsed = parseOpenCodeQualifiedModelRef(selectedModel);
  const availabilityReason = input.localProvidersLoading
    ? 'Checking the selected local model...'
    : input.localProviderLookupError?.trim() ||
      'This explicitly selected local model is not currently served in this project scope.';
  return {
    value: selectedModel,
    label: parsed?.modelId ?? selectedModel,
    badgeLabel:
      getTeamModelSourceBadgeLabel('opencode', selectedModel) ?? parsed?.sourceId ?? 'Local',
    availabilityStatus: 'unavailable',
    availabilityReason,
  };
}

export function buildUnavailableOpenCodeSelectionOption(
  value: string,
  reason: string
): TeamRuntimeModelOption {
  const selectedModel = value.trim();
  const parsed = parseOpenCodeQualifiedModelRef(selectedModel);
  return {
    value: selectedModel,
    label: parsed?.modelId ?? selectedModel,
    badgeLabel:
      getTeamModelSourceBadgeLabel('opencode', selectedModel) ?? parsed?.sourceId ?? 'OpenCode',
    availabilityStatus: 'unavailable',
    availabilityReason: reason,
  };
}
