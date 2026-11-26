import type { CliInstallerSlice, CliProviderStatusFetchOptions } from './cliInstallerSlice';
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export function applyCliProviderAuthState(
  status: CliInstallationStatus,
  auth: Pick<CliInstallationStatus, 'authLoggedIn' | 'authMethod' | 'authStatusChecking'>
): CliInstallationStatus {
  return status.authLoggedIn === auth.authLoggedIn &&
    status.authMethod === auth.authMethod &&
    status.authStatusChecking === auth.authStatusChecking
    ? status
    : { ...status, ...auth };
}

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

/** Ownership witnesses survive completion; they never make a retired response current. */
export function createCliProviderStatusOwnership(
  pending: Map<string, Promise<boolean>>,
  reads: WeakMap<Promise<boolean>, CliProviderStatusRead>,
  activeRequestIds: Map<string, number>,
  current: () => Pick<CliProviderStatusRead, 'epoch' | 'generation'>
) {
  let requestId = 0;
  const globalIntents = new Map<
    CliProviderId,
    { read: CliProviderStatusRead; options: CliProviderStatusFetchOptions }
  >();
  const recoveryVisibility = new WeakMap<CliProviderStatusFetchOptions, boolean>();
  return {
    capture(
      providerId: CliProviderId,
      options: CliProviderStatusFetchOptions | undefined,
      identity: Omit<CliProviderStatusRead, 'visible' | 'requestId'>
    ) {
      const global = identity.scopeKey === `${providerId}\0`;
      const visible =
        options?.silent !== true ||
        !global ||
        (options !== undefined && recoveryVisibility.get(options) === true);
      const captured = captureCliProviderStatusRead(
        pending,
        reads,
        activeRequestIds,
        { ...identity, requestId: ++requestId },
        Boolean(visible)
      );
      const read = captured.read;
      activeRequestIds.set(read.scopeKey, read.requestId);
      if (global) globalIntents.set(providerId, { read, options: { ...options } });
      return {
        ...captured,
        visible,
        isCurrentRequest: () => {
          const owner = current();
          return (
            read.epoch === owner.epoch &&
            read.generation === owner.generation &&
            activeRequestIds.get(read.scopeKey) === read.requestId
          );
        },
      };
    },
    captureRecovery(
      excluded: CliProviderId,
      get: () => Pick<CliInstallerSlice, 'fetchCliProviderStatus'>
    ) {
      const previous = current();
      const expected = { epoch: previous.epoch + 1, generation: previous.generation + 1 };
      const intents = [...globalIntents.entries()].filter(
        ([providerId, { read }]) =>
          providerId !== excluded &&
          read.epoch === previous.epoch &&
          read.generation === previous.generation &&
          activeRequestIds.get(read.scopeKey) === read.requestId
      );
      return () => {
        for (const [providerId, intent] of intents) {
          const owner = current();
          if (owner.epoch !== expected.epoch || owner.generation !== expected.generation) return;
          if (globalIntents.get(providerId) !== intent) continue;
          const options = { ...intent.options, epoch: expected.epoch };
          recoveryVisibility.set(options, intent.read.visible);
          // Recovery is a fresh read; neither it nor a subscriber may replace the IPC error.
          try {
            void get()
              .fetchCliProviderStatus(providerId, options)
              .catch(() => undefined);
          } catch {
            // A synchronous subscriber failure does not erase the original invalidation failure.
          }
        }
      };
    },
    clear(providerId: CliProviderId): void {
      globalIntents.delete(providerId);
      for (const key of pending.keys()) {
        if (key.startsWith(`${providerId}:`)) pending.delete(key);
      }
      for (const key of activeRequestIds.keys()) {
        if (key.startsWith(`${providerId}\0`)) activeRequestIds.delete(key);
      }
    },
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
