import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export const cliProviderStatusInFlight = new Map<
  string,
  { request: Promise<boolean>; epoch: number; generation: number }
>();
export const cliProviderStatusAppliedRequestIds = new Map<CliProviderId, number>();

export function registerCliProviderStatusInFlight(
  key: string,
  entry: { request: Promise<boolean>; epoch: number; generation: number }
): void {
  cliProviderStatusInFlight.set(key, entry);
}

export function markCliProviderStatusApplied(providerId: CliProviderId, requestId: number): void {
  cliProviderStatusAppliedRequestIds.set(providerId, requestId);
}

export function clearCliProviderStatusInFlight(providerId: CliProviderId): void {
  for (const key of cliProviderStatusInFlight.keys()) {
    if (key.startsWith(`${providerId}:status:`) || key.startsWith(`${providerId}:verify:`)) {
      cliProviderStatusInFlight.delete(key);
    }
  }
}

export function getProviderStatus(
  status: CliInstallationStatus | null | undefined,
  providerId: CliProviderId
): CliProviderStatus | undefined {
  return status?.providers.find((provider) => provider.providerId === providerId);
}

export function preserveProvidersUpdatedAfterRequest(
  current: CliInstallationStatus | null,
  incoming: CliInstallationStatus,
  appliedRequestIdsAtStart: ReadonlyMap<CliProviderId, number>
): CliInstallationStatus {
  if (
    current?.flavor !== 'agent_teams_orchestrator' ||
    incoming.flavor !== 'agent_teams_orchestrator' ||
    !incoming.installed
  ) {
    return incoming;
  }

  const providers = [...incoming.providers];
  for (const provider of current.providers) {
    const appliedRequestId = cliProviderStatusAppliedRequestIds.get(provider.providerId) ?? 0;
    if (appliedRequestId <= (appliedRequestIdsAtStart.get(provider.providerId) ?? 0)) {
      continue;
    }
    const index = providers.findIndex((item) => item.providerId === provider.providerId);
    if (index === -1) {
      providers.push(provider);
    } else {
      providers[index] = provider;
    }
  }
  return { ...incoming, providers };
}

export function getCliProviderStatusScopeKey(
  providerId: CliProviderId,
  projectPath: string | null | undefined
): string {
  return `${providerId}\0${projectPath?.trim() ?? ''}`;
}

export function setBoundedScopedProviderStatus(
  current: Readonly<Record<string, CliProviderStatus>>,
  scopeKey: string,
  providerStatus: CliProviderStatus
): Readonly<Record<string, CliProviderStatus>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, providerStatus]);
  if (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.splice(0, entries.length - CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  }
  return Object.fromEntries(entries);
}
