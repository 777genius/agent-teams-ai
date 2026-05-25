import type { TeamProviderBackendId, TeamProviderId } from '@shared/types';

const TEAM_PROVIDER_BACKEND_IDS = new Set<TeamProviderBackendId>([
  'auto',
  'adapter',
  'api',
  'cli-sdk',
  'codex-native',
  'opencode-cli',
]);
const GEMINI_PROVIDER_BACKEND_IDS = new Set<TeamProviderBackendId>(['auto', 'api', 'cli-sdk']);
const OPENCODE_PROVIDER_BACKEND_IDS = new Set<TeamProviderBackendId>(['adapter', 'opencode-cli']);

function normalizeOptionalBackendId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function getDefaultProviderBackendId(
  providerId: TeamProviderId | undefined
): TeamProviderBackendId | undefined {
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

export function isTeamProviderBackendId(
  providerBackendId: string | null | undefined
): providerBackendId is TeamProviderBackendId {
  return (
    !!providerBackendId && TEAM_PROVIDER_BACKEND_IDS.has(providerBackendId as TeamProviderBackendId)
  );
}

export function migrateProviderBackendId(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | null | undefined
): TeamProviderBackendId | undefined {
  const normalizedBackendId = normalizeOptionalBackendId(providerBackendId);
  if (providerId === undefined || providerId === 'anthropic') {
    return undefined;
  }

  if (providerId === 'codex') {
    if (!normalizedBackendId || isLegacyCodexProviderBackendId(normalizedBackendId)) {
      return 'codex-native';
    }

    return normalizedBackendId === 'codex-native' ? normalizedBackendId : undefined;
  }

  if (!isTeamProviderBackendId(normalizedBackendId)) {
    return undefined;
  }

  if (providerId === 'gemini') {
    return GEMINI_PROVIDER_BACKEND_IDS.has(normalizedBackendId) ? normalizedBackendId : undefined;
  }

  if (providerId === 'opencode') {
    return OPENCODE_PROVIDER_BACKEND_IDS.has(normalizedBackendId) ? normalizedBackendId : undefined;
  }

  return undefined;
}

export function formatProviderBackendLabel(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | undefined
): string | undefined {
  const normalizedBackendId = migrateProviderBackendId(providerId, providerBackendId);
  if (!normalizedBackendId) {
    return undefined;
  }

  if ((providerId ?? 'anthropic') === 'codex') {
    if (normalizedBackendId === 'codex-native') {
      return 'Codex native';
    }
    return normalizedBackendId;
  }

  if ((providerId ?? 'anthropic') === 'gemini') {
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
