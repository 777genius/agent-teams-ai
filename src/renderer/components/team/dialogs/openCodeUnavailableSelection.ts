import { getTeamModelSourceBadgeLabel } from '@renderer/utils/teamModelCatalog';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type { TeamRuntimeModelOption } from '@renderer/utils/teamModelAvailability';
import type { CliProviderStatus } from '@shared/types';

// A selected route that its own provider's fresh catalog no longer offers (for
// example after that provider's key was removed) must stay on screen as
// unavailable. Normalizing it to '' would silently launch Default instead.
// A catalog of another source cannot judge the route at all, so browsing
// another source tab leaves the selection alone (see the scope decision).
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
  /** Status of the catalog that judged the selection; its own reason wins. */
  catalogStatus?: Pick<CliProviderStatus, 'modelAvailability'> | null;
  selectedUnverifiedLocalModel: boolean;
  localProvidersLoading: boolean;
  localProviderLookupError: string | null | undefined;
}): TeamRuntimeModelOption | null {
  const selectedModel = input.value.trim();
  if (input.keepUnavailable) {
    const catalogReason = input.catalogStatus?.modelAvailability
      ?.find((item) => item.modelId === selectedModel)
      ?.reason?.trim();
    return buildUnavailableOpenCodeSelectionOption(
      selectedModel,
      catalogReason || input.unavailableReason
    );
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
