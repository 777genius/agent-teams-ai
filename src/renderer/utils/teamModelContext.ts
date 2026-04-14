import { inferTeamProviderIdFromModel } from '@shared/utils/teamProvider';

import type { TeamProviderId } from '@shared/types';

export function stripTrailingOneMillionSuffixes(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.replace(/(?:\[1m\])+$/, '') || undefined;
}

export function extractProviderScopedBaseModel(
  model: string | undefined,
  providerId?: TeamProviderId
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  const effectiveProviderId =
    providerId ??
    inferTeamProviderIdFromModel(trimmed) ??
    inferTeamProviderIdFromModel(stripTrailingOneMillionSuffixes(trimmed));
  if (effectiveProviderId !== 'anthropic') {
    return trimmed;
  }

  return stripTrailingOneMillionSuffixes(trimmed);
}
