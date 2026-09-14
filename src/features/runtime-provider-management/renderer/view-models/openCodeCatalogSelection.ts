import { isOpenCodeLocalProviderId } from '@shared/utils/opencodeModelRoute';

import { parseStrictQualifiedModelRef } from '../../core/domain/openCodeModelIdentity';

export function resolveOpenCodeSelectionScopeDecision(input: {
  value: string;
  runtimeNormalizedValue: string;
  selectionScopeKey: string | null;
  catalogScopeKey: string | null;
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error';
  catalogState: 'fresh' | 'stale' | null;
}): { normalizedValue: string; preserve: boolean } {
  if (!input.catalogScopeKey) {
    return { normalizedValue: input.runtimeNormalizedValue, preserve: false };
  }

  const sameScope = input.selectionScopeKey === input.catalogScopeKey;
  const freshAuthority = input.catalogStatus === 'ready' && input.catalogState === 'fresh';
  return {
    normalizedValue:
      sameScope || freshAuthority || !input.value.trim() ? input.runtimeNormalizedValue : '',
    preserve: sameScope && !freshAuthority,
  };
}

export function normalizeOpenCodeCatalogSourceProviderId(
  sourceProviderId: string | null | undefined
): string | null {
  const normalized = sourceProviderId?.trim().toLowerCase() ?? '';
  if (!normalized || isOpenCodeLocalProviderId(normalized)) {
    return null;
  }
  return normalized;
}

export function resolveOpenCodeCatalogSourceProviderId(input: {
  selectedSourceIds: ReadonlySet<string>;
  selectedModel: string | null | undefined;
  localModelsSelected?: boolean;
  knownLocalSourceIds: ReadonlySet<string>;
  localProviderLookupReady: boolean;
}): string | null {
  const resolveCandidate = (candidate: string | null | undefined): string | null => {
    const normalized = candidate?.trim().toLowerCase() ?? '';
    if (
      !normalized ||
      isOpenCodeLocalProviderId(normalized) ||
      Array.from(input.knownLocalSourceIds).some(
        (sourceId) => sourceId.trim().toLowerCase() === normalized
      )
    ) {
      return null;
    }
    return normalized;
  };

  if (input.localModelsSelected) {
    return null;
  }
  if (input.selectedSourceIds.size === 1) {
    // An explicit built-in/free or local tab is still an explicit selection. Do not
    // fall back to the previously selected qualified model and fetch that provider.
    for (const selectedSource of input.selectedSourceIds) {
      return resolveCandidate(selectedSource);
    }
  }
  if (input.selectedSourceIds.size > 1) {
    return null;
  }

  if (!input.localProviderLookupReady) {
    return null;
  }
  return resolveCandidate(parseStrictQualifiedModelRef(input.selectedModel)?.sourceId ?? null);
}
