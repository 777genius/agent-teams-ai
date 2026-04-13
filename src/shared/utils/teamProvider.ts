import type { TeamProviderId } from '@shared/types';

export function isTeamProviderId(value: unknown): value is TeamProviderId {
  return value === 'anthropic' || value === 'codex' || value === 'gemini';
}

export function normalizeOptionalTeamProviderId(value: unknown): TeamProviderId | undefined {
  return isTeamProviderId(value) ? value : undefined;
}

export function normalizeTeamProviderId(
  value: unknown,
  fallback: TeamProviderId = 'anthropic'
): TeamProviderId {
  return normalizeOptionalTeamProviderId(value) ?? fallback;
}

export function inferTeamProviderIdFromModel(
  model: string | undefined
): TeamProviderId | undefined {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith('gpt-') || normalized.startsWith('codex')) {
    return 'codex';
  }

  if (normalized.startsWith('gemini')) {
    return 'gemini';
  }

  if (
    normalized.startsWith('claude') ||
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'haiku'
  ) {
    return 'anthropic';
  }

  return undefined;
}
