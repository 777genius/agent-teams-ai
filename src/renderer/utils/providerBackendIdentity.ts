import type { CliProviderStatus, TeamProviderId } from '@shared/types';

function normalizeOptionalBackendId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function getDefaultProviderBackendId(
  providerId: TeamProviderId | CliProviderStatus['providerId'] | undefined
): string | undefined {
  return providerId === 'codex' ? 'codex-native' : undefined;
}

export function isLegacyCodexProviderBackendId(
  providerBackendId: string | null | undefined
): boolean {
  const normalizedBackendId = normalizeOptionalBackendId(providerBackendId);
  return (
    normalizedBackendId === 'auto' ||
    normalizedBackendId === 'adapter' ||
    normalizedBackendId === 'api'
  );
}

export function resolveEffectiveProviderBackendId(
  provider: Pick<CliProviderStatus, 'selectedBackendId' | 'resolvedBackendId'> | null | undefined
): string | undefined {
  return normalizeOptionalBackendId(provider?.resolvedBackendId ?? provider?.selectedBackendId);
}

export function resolveUiOwnedProviderBackendId(
  providerId: TeamProviderId | CliProviderStatus['providerId'] | undefined,
  provider: Pick<CliProviderStatus, 'selectedBackendId' | 'resolvedBackendId'> | null | undefined
): string | undefined {
  const normalizedProviderId = providerId ?? undefined;
  if (normalizedProviderId === 'codex') {
    const selectedBackendId = normalizeOptionalBackendId(provider?.selectedBackendId);
    if (!selectedBackendId || selectedBackendId === 'auto') {
      return 'codex-native';
    }
    return selectedBackendId;
  }

  return resolveEffectiveProviderBackendId(provider);
}

export function formatProviderBackendLabel(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | undefined
): string | undefined {
  const normalizedProviderId = providerId ?? 'anthropic';
  const normalizedBackendId = normalizeOptionalBackendId(providerBackendId);
  if (!normalizedBackendId) {
    return undefined;
  }

  if (normalizedProviderId === 'codex') {
    switch (normalizedBackendId) {
      case 'codex-native':
        return 'Codex native';
      case 'adapter':
        return 'Legacy adapter fallback';
      case 'api':
        return 'Legacy OpenAI fallback';
      case 'auto':
        return 'Legacy auto fallback';
      default:
        return normalizedBackendId;
    }
  }

  if (normalizedProviderId === 'gemini') {
    switch (normalizedBackendId) {
      case 'cli-sdk':
        return 'CLI SDK';
      case 'api':
        return 'API';
      case 'auto':
        return undefined;
      default:
        return normalizedBackendId;
    }
  }

  return normalizedBackendId;
}

export function formatTeamProviderBackendLabel(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | undefined
): string | undefined {
  return formatProviderBackendLabel(providerId, providerBackendId);
}
