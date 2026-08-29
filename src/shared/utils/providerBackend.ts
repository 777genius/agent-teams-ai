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

export type ProviderBackendMigrationSource = 'legacy-storage' | 'explicit-selection';
export type PersistedProviderBackendSource = 'legacy-unversioned' | 'current-version';

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
  if (providerId === 'codex') return 'codex-native';
  if (providerId === 'opencode') return 'opencode-cli';
  return undefined;
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
  providerBackendId: string | null | undefined,
  source: ProviderBackendMigrationSource = 'legacy-storage'
): TeamProviderBackendId | undefined {
  const normalizedBackendId = normalizeOptionalBackendId(providerBackendId);
  if (providerId === undefined || providerId === 'anthropic') {
    return undefined;
  }

  if (providerId === 'codex') {
    if (!normalizedBackendId) {
      return 'codex-native';
    }
    if (
      source === 'explicit-selection' &&
      (normalizedBackendId === 'auto' ||
        normalizedBackendId === 'adapter' ||
        normalizedBackendId === 'api')
    ) {
      return normalizedBackendId;
    }
    if (isLegacyCodexProviderBackendId(normalizedBackendId)) {
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

/**
 * Normalizes a backend read from persistence without applying new-selection
 * defaults to current schemas. Only explicitly legacy/unversioned records may
 * synthesize a migration default when the backend field is absent.
 */
export function normalizePersistedProviderBackendId(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | null | undefined,
  source: PersistedProviderBackendSource
): TeamProviderBackendId | undefined {
  const normalizedBackendId = normalizeOptionalBackendId(providerBackendId);
  if (!normalizedBackendId && source === 'current-version') return undefined;
  return migrateProviderBackendId(
    providerId,
    normalizedBackendId,
    source === 'current-version' ? 'explicit-selection' : 'legacy-storage'
  );
}

export function formatProviderBackendLabel(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | undefined
): string | undefined {
  const normalizedBackendId = migrateProviderBackendId(
    providerId,
    providerBackendId,
    'explicit-selection'
  );
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
