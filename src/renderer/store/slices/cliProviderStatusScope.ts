import type { CliInstallerSlice } from './cliInstallerSlice';
import type { CliProviderId, CliProviderStatus } from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export interface CliProviderStatusRead {
  readonly epoch: number;
  readonly generation: number;
  readonly scopeKey: string;
  readonly requestId: number;
  readonly visible: boolean;
}

/** Display ownership follows the latest read; a quiet successor inherits its pending state. */
export function captureCliProviderStatusRead(
  pending: ReadonlyMap<string, Promise<boolean>>,
  reads: WeakMap<Promise<boolean>, CliProviderStatusRead>,
  activeRequestIds: ReadonlyMap<string, number>,
  current: Omit<CliProviderStatusRead, 'visible'>,
  visible: boolean
): { read: CliProviderStatusRead; hasOtherVisibleRead: () => boolean } {
  const providerPrefix = current.scopeKey.slice(0, current.scopeKey.indexOf('\0') + 1);
  const hasVisibleRead = (scopeOnly: boolean): boolean => {
    for (const promise of pending.values()) {
      const read = reads.get(promise);
      if (
        read?.visible &&
        read.requestId !== current.requestId &&
        read.epoch === current.epoch &&
        read.generation === current.generation &&
        (scopeOnly
          ? read.scopeKey === current.scopeKey
          : read.scopeKey.startsWith(providerPrefix)) &&
        activeRequestIds.get(read.scopeKey) === read.requestId
      ) {
        return true;
      }
    }
    return false;
  };
  return {
    read: { ...current, visible: visible || hasVisibleRead(true) },
    hasOtherVisibleRead: () => hasVisibleRead(false),
  };
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

type ScopeRefreshState = Pick<
  CliInstallerSlice,
  'cliProviderStatusLoading' | 'cliProviderStatusScopeRevision'
>;

/** Retire project reads without cancelling a new epoch's unscoped hydration. */
export function invalidateCliProviderScopeReads(
  state: ScopeRefreshState,
  inFlight: Map<string, Promise<boolean>>,
  activeRequestIds: Map<string, number>,
  scopedOnly: boolean,
  reads: WeakMap<Promise<boolean>, CliProviderStatusRead>,
  current: Pick<CliProviderStatusRead, 'epoch' | 'generation'>
): ScopeRefreshState {
  const invalidatedProviders = new Set<CliProviderId>();
  for (const key of activeRequestIds.keys()) {
    const separator = key.indexOf('\0');
    if (scopedOnly && key.length <= separator + 1) continue;
    invalidatedProviders.add(key.slice(0, separator) as CliProviderId);
    activeRequestIds.delete(key);
  }
  for (const key of inFlight.keys()) {
    const pathSeparator = key.indexOf(':', key.indexOf(':') + 1);
    if (!scopedOnly || key.length > pathSeparator + 1) inFlight.delete(key);
  }
  const visibleScopes = new Set<string>();
  for (const promise of inFlight.values()) {
    const read = reads.get(promise);
    if (
      read?.visible &&
      read.epoch === current.epoch &&
      read.generation === current.generation &&
      activeRequestIds.get(read.scopeKey) === read.requestId
    ) {
      visibleScopes.add(read.scopeKey);
    }
  }
  const nextLoading = { ...state.cliProviderStatusLoading };
  for (const providerId of invalidatedProviders) {
    if (!scopedOnly || !visibleScopes.has(`${providerId}\0`)) delete nextLoading[providerId];
  }
  return {
    cliProviderStatusLoading: nextLoading,
    cliProviderStatusScopeRevision: state.cliProviderStatusScopeRevision + 1,
  };
}
