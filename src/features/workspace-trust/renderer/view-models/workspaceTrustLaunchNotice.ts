import type { LaunchTrustProviderId, WorkspaceTrustProjectStatus } from '../../contracts';

export type WorkspaceTrustDisplayStatus =
  | WorkspaceTrustProjectStatus
  | 'checking'
  | 'launch_scoped';

export function canonicalLaunchTrustProviders(
  providerIds: readonly string[]
): LaunchTrustProviderId[] {
  return (['anthropic', 'codex'] as const).filter((providerId) => providerIds.includes(providerId));
}

/** Treat bridge responses as untrusted, including partial or contradictory provider evidence. */
export function getWorkspaceTrustDisplayStatus(
  result: unknown,
  providerIds: readonly LaunchTrustProviderId[]
): WorkspaceTrustDisplayStatus {
  const providers =
    result && typeof result === 'object' && 'providers' in result && Array.isArray(result.providers)
      ? result.providers
      : [];
  const statuses = providerIds.map((providerId) => {
    const entries = providers.filter(
      (entry: unknown) =>
        entry &&
        typeof entry === 'object' &&
        'providerId' in entry &&
        entry.providerId === providerId
    );
    const status: unknown = entries.length === 1 ? entries[0].status : undefined;
    if (status === 'disabled' || status === 'not_applicable') return status;
    if (providerId === 'anthropic' && (status === 'trusted' || status === 'untrusted'))
      return status;
    if (providerId === 'codex' && status === 'launch_scoped') return status;
    return 'unknown';
  });
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('untrusted')) return 'untrusted';
  if (statuses.includes('launch_scoped')) return 'launch_scoped';
  return statuses.includes('trusted') ? 'trusted' : 'disabled';
}

export function shouldShowWorkspaceTrustLaunchNotice(status: WorkspaceTrustDisplayStatus): boolean {
  return status === 'untrusted';
}
