import { isTeamProviderBackendId, migrateProviderBackendId } from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

/** Reject loss of recognized persisted values while allowing canonical defaults and migrations. */
export function hasCompleteKnownMetadata(raw: unknown, normalized: unknown): boolean {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !normalized ||
    typeof normalized !== 'object' ||
    Array.isArray(normalized)
  )
    return false;
  const input = raw as Record<string, unknown>;
  for (const [key, canonical] of Object.entries(normalized as Record<string, unknown>)) {
    const value = input[key];
    if (value == null) continue;
    if (key === 'providerBackendId' && typeof value === 'string') {
      const provider = normalizeOptionalTeamProviderId(input.providerId);
      const migrated = migrateProviderBackendId(provider, value);
      if (migrated != null && migrated === canonical) continue;
      if (
        canonical == null &&
        (provider == null || provider === 'anthropic') &&
        isTeamProviderBackendId(value.trim())
      )
        continue;
    }
    if (typeof value === 'string') {
      if (value === canonical || value.trim() === canonical || (!value.trim() && canonical == null))
        continue;
      return false;
    }
    if (typeof value === 'number') {
      if (Number.isFinite(value) && value === canonical) continue;
      return false;
    }
    if (typeof value === 'boolean') {
      if (value === canonical) continue;
      return false;
    }
    if (!hasCompleteKnownMetadata(value, canonical)) return false;
  }
  return true;
}
