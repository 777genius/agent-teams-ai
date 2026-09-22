import { parseOpenCodeQualifiedModelRef } from './opencodeModelRef';

import type { TeamProviderId } from '@shared/types';

export function isTeamProviderId(value: unknown): value is TeamProviderId {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode';
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
  const normalizedWithoutExtendedContextSuffix = normalized.replace(/(?:\[1m\])+$/, '');

  if (
    normalized.startsWith('opencode/') ||
    normalizedWithoutExtendedContextSuffix.startsWith('opencode/')
  ) {
    return 'opencode';
  }

  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('codex') ||
    normalizedWithoutExtendedContextSuffix.startsWith('gpt-') ||
    normalizedWithoutExtendedContextSuffix.startsWith('codex')
  ) {
    return 'codex';
  }

  if (
    normalized.startsWith('gemini') ||
    normalizedWithoutExtendedContextSuffix.startsWith('gemini')
  ) {
    return 'gemini';
  }

  if (
    normalized.startsWith('claude') ||
    normalizedWithoutExtendedContextSuffix.startsWith('claude') ||
    normalized === 'opus' ||
    normalizedWithoutExtendedContextSuffix === 'opus' ||
    normalized === 'sonnet' ||
    normalizedWithoutExtendedContextSuffix === 'sonnet' ||
    normalized === 'haiku' ||
    normalizedWithoutExtendedContextSuffix === 'haiku'
  ) {
    return 'anthropic';
  }

  if (
    parseOpenCodeQualifiedModelRef(normalized) ||
    parseOpenCodeQualifiedModelRef(normalizedWithoutExtendedContextSuffix)
  ) {
    return 'opencode';
  }

  return undefined;
}
