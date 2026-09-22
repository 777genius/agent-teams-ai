import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { TeamProviderId } from '@shared/types';
import type { CliProviderId } from '@shared/types/cliInstaller';

export const GEMINI_UI_FROZEN = true;
export const GEMINI_UI_DISABLED_REASON = 'Gemini in development';
export const GEMINI_UI_DISABLED_BADGE_LABEL = 'In development';

export function isGeminiUiFrozen(): boolean {
  return GEMINI_UI_FROZEN;
}

export function isGeminiProviderId(
  providerId: CliProviderId | TeamProviderId | undefined
): providerId is 'gemini' {
  return providerId === 'gemini';
}

export function filterMainScreenCliProviders<T extends { providerId: CliProviderId }>(
  providers: readonly T[]
): T[] {
  if (!GEMINI_UI_FROZEN) {
    return [...providers];
  }

  return providers.filter((provider) => provider.providerId !== 'gemini');
}

export function normalizeCreateLaunchProviderForUi(
  providerId: TeamProviderId | undefined,
  multimodelEnabled: boolean
): TeamProviderId {
  if (!multimodelEnabled) {
    return 'anthropic';
  }

  const normalizedProviderId = normalizeOptionalTeamProviderId(providerId);
  if (normalizedProviderId === 'gemini' && GEMINI_UI_FROZEN) {
    return 'anthropic';
  }
  return normalizedProviderId ?? 'anthropic';
}

export function isCreateLaunchProviderDisabled(
  providerId: TeamProviderId,
  multimodelEnabled: boolean
): boolean {
  if (providerId === 'gemini' && GEMINI_UI_FROZEN) {
    return true;
  }
  if (!multimodelEnabled && providerId !== 'anthropic') {
    return true;
  }
  return false;
}
