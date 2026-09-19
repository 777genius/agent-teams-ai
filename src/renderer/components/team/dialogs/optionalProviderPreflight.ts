import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';
import {
  hasProviderCatalogRefreshLaunchSupport,
  isAuthenticatedProviderCatalogRefresh,
} from '@shared/utils/providerStatusAuthority';

import { runProviderPrepareDiagnostics } from './providerPrepareDiagnostics';

import type { ProviderPrepareDiagnosticsResult } from './providerPrepareDiagnostics';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

type OptionalProviderPreflightState = 'idle' | 'loading' | 'ready' | 'failed';

/** Aggregate progress must not restart badges for providers whose own work settled. */
export function getPendingProviderPreflightIds(
  state: OptionalProviderPreflightState,
  providerIds: readonly TeamProviderId[],
  checks: readonly ProvisioningProviderCheck[]
): TeamProviderId[] {
  if (state !== 'idle' && state !== 'loading') return [];
  return providerIds.filter((providerId) => {
    const check = checks.find((entry) => entry.providerId === providerId);
    return !check || check.status === 'pending' || check.status === 'checking';
  });
}

function hasKnownProviderFailure(status: CliProviderStatus | null | undefined): boolean {
  return Boolean(
    status &&
    (status.statusCheckErrorCode === 'runtime_missing' ||
      status.statusCheckErrorCode === 'unavailable' ||
      // A timed-out inventory probe reports verification=error too; it is not
      // an authoritative auth denial. Only the optional UI check is skippable.
      (status.verificationState === 'error' && !isProviderAuthorityRetryableDiscovery(status)) ||
      (status.statusCheckOutcome === 'authoritative' &&
        (!status.supported || !status.authenticated || !status.capabilities.teamLaunch)))
  );
}

function isProviderAuthorityStillResolving(
  providerId: TeamProviderId,
  status: CliProviderStatus | null | undefined,
  loading: ReadonlyMap<TeamProviderId, boolean>
): boolean {
  return (
    loading.get(providerId) === true ||
    status?.statusCheckOutcome === 'pending' ||
    status?.statusCheckOutcome === 'model_only' ||
    status?.modelCatalogRefreshState === 'loading' ||
    isProviderAuthorityRetryableDiscovery(status)
  );
}

function isProviderAuthorityRetryableDiscovery(
  status: CliProviderStatus | null | undefined
): boolean {
  return (
    status?.statusCheckOutcome === 'transient_error' &&
    (status.statusCheckErrorCode === 'timeout' ||
      status.statusCheckErrorCode === 'partial_response')
  );
}

/** Let the user bypass the optional UI preflight while passive discovery is
 * genuinely pending. The launch boundary still performs strict verification.
 */
export function canSkipPendingProviderDiscovery(
  providerIds: readonly TeamProviderId[],
  statuses: ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>,
  loading: ReadonlyMap<TeamProviderId, boolean>,
  now: number = Date.now()
): boolean {
  let discoveryPending = false;
  for (const providerId of providerIds) {
    const status = statuses.get(providerId);
    if (hasKnownProviderFailure(status)) return false;
    if (
      loading.get(providerId) === true ||
      status?.statusCheckOutcome === 'pending' ||
      isProviderAuthorityRetryableDiscovery(status)
    ) {
      discoveryPending = true;
      continue;
    }
    if (!hasEffectiveProviderLaunchAuthority(status, now)) return false;
  }
  return discoveryPending;
}

/** Skip an in-flight UI preflight once no selected provider has a known failure.
 * A passive/model-only status may still be resolving while the selected-model
 * check runs; provisioning owns the final launch-time verification.
 * Re-evaluated at click time, including catalog TTL when authority is available.
 */
export function canSkipOptionalProviderPreflight(
  providerIds: readonly TeamProviderId[],
  statuses: ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>,
  loading: ReadonlyMap<TeamProviderId, boolean>,
  checks: readonly ProvisioningProviderCheck[],
  now: number = Date.now()
): boolean {
  let optionalPending = false;
  for (const providerId of providerIds) {
    const check = checks.find((entry) => entry.providerId === providerId);
    if (!check || check.status === 'failed') return false;
    if (hasKnownProviderFailure(statuses.get(providerId))) return false;
    if (check.status === 'ready') continue;
    if (check.status === 'pending' || check.status === 'checking') {
      optionalPending = true;
      const status = statuses.get(providerId);
      const authorityStillResolving = isProviderAuthorityStillResolving(
        providerId,
        status,
        loading
      );
      if (!authorityStillResolving && !hasEffectiveProviderLaunchAuthority(status, now)) {
        return false;
      }
    }
  }
  return optionalPending;
}

export function canSkipProviderPreflight(
  state: OptionalProviderPreflightState,
  providerIds: readonly TeamProviderId[],
  statuses: ReadonlyMap<TeamProviderId, CliProviderStatus | null | undefined>,
  loading: ReadonlyMap<TeamProviderId, boolean>,
  checks: readonly ProvisioningProviderCheck[],
  now: number = Date.now(),
  sourceProviders: readonly CliProviderStatus[] = []
): boolean {
  // Main/store may already have gated teamLaunch. The app-derived restriction
  // preserves affirmative support from this snapshot, never a previous one.
  const refreshingProviders = new Map<TeamProviderId, CliProviderStatus>();
  if (state !== 'failed') {
    for (const id of providerIds) {
      const source = sourceProviders.find((provider) => provider.providerId === id);
      if (
        hasProviderCatalogRefreshLaunchSupport(source) &&
        isAuthenticatedProviderCatalogRefresh(statuses.get(id))
      ) {
        refreshingProviders.set(id, source);
      }
    }
  }
  if (refreshingProviders.size > 0) {
    if (checks.some((check) => providerIds.includes(check.providerId) && check.status === 'failed'))
      return false;
    if (
      providerIds.some((id) => {
        if (refreshingProviders.has(id)) return false;
        const status = statuses.get(id);
        // Completed checks cannot hide stale authority, but active discovery is
        // still optional. Keep catalog errors terminal even during a retry.
        return (
          status?.modelCatalogRefreshState === 'error' ||
          (!hasEffectiveProviderLaunchAuthority(status, now) &&
            !canSkipPendingProviderDiscovery([id], statuses, loading, now))
        );
      })
    )
      return false;
    const refreshStatuses = new Map(statuses);
    const refreshLoading = new Map(loading);
    for (const [id, source] of refreshingProviders) {
      refreshStatuses.set(id, {
        ...source,
        capabilities: { ...source.capabilities, teamLaunch: true },
      });
      refreshLoading.set(id, true);
    }
    if (state === 'idle')
      return canSkipPendingProviderDiscovery(providerIds, refreshStatuses, refreshLoading, now);
    // A passive refresh does not invalidate or repeat the completed deep check.
    // Treat it as pending only for this optional-skip decision.
    return canSkipOptionalProviderPreflight(
      providerIds,
      refreshStatuses,
      refreshLoading,
      checks.map((check) =>
        refreshingProviders.has(check.providerId) ? { ...check, status: 'checking' } : check
      ),
      now
    );
  }
  if (state === 'idle') {
    return canSkipPendingProviderDiscovery(providerIds, statuses, loading, now);
  }
  return (
    state === 'loading' &&
    canSkipOptionalProviderPreflight(providerIds, statuses, loading, checks, now)
  );
}

/** A synchronous latch prevents two clicks before React commits submitting state.
 * Advancing the generation also fences late diagnostic/progress callbacks.
 */
export function createProviderSubmissionFence() {
  let busy = false;
  const diagnostics = new Map<
    string,
    {
      promise: Promise<ProviderPrepareDiagnosticsResult>;
      interrupted: boolean;
      expiresAt: number;
    }
  >();
  return {
    get busy() {
      return busy;
    },
    acquire(generation: { current: number }): boolean {
      if (busy) return false;
      busy = true;
      for (const entry of diagnostics.values()) entry.interrupted = true;
      generation.current += 1;
      return true;
    },
    /** Transfer skipped in-flight work to one retry with the exact proof identity.
     * UI callbacks retain their original generation and can never cross the fence.
     */
    runPreflight(
      identity: Pick<ProviderPreparePlan, 'cacheKey' | 'requestSignature'>,
      input: Parameters<typeof runProviderPrepareDiagnostics>[0]
    ): Promise<ProviderPrepareDiagnosticsResult> {
      const key = JSON.stringify([identity.cacheKey, identity.requestSignature]);
      const run = () => runProviderPrepareDiagnostics(input);
      for (const [entryKey, entry] of diagnostics)
        if (entry.expiresAt <= Date.now()) diagnostics.delete(entryKey);
      const previous = diagnostics.get(key);
      if (previous?.interrupted) {
        previous.interrupted = false;
        if (previous.expiresAt !== Infinity) diagnostics.delete(key);
        return previous.promise;
      }
      const entry = { promise: run(), interrupted: false, expiresAt: Infinity };
      entry.promise = entry.promise.then(
        (result) => {
          entry.expiresAt = Date.now() + 45_000;
          if ((!entry.interrupted || result.status !== 'ready') && diagnostics.get(key) === entry)
            diagnostics.delete(key);
          return result;
        },
        (error: unknown) => {
          if (diagnostics.get(key) === entry) diagnostics.delete(key);
          throw error;
        }
      );
      diagnostics.set(key, entry);
      return entry.promise;
    },
    release(): void {
      busy = false;
    },
  };
}

/** A rejected submit resumes only interrupted work, never already settled checks. */
export function resumeInterruptedProviderPreflight(
  checks: readonly ProvisioningProviderCheck[],
  attempts: Map<TeamProviderId, string>
): void {
  for (const check of checks) {
    if (check.status === 'pending' || check.status === 'checking')
      attempts.delete(check.providerId);
  }
}
