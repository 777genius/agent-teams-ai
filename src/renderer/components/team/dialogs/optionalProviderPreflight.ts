import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';

import { runProviderPrepareDiagnostics } from './providerPrepareDiagnostics';

import type { ProviderPrepareDiagnosticsResult } from './providerPrepareDiagnostics';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

type OptionalProviderPreflightState = 'idle' | 'loading' | 'ready' | 'failed';

function isProviderAuthorityStillResolving(
  providerId: TeamProviderId,
  status: CliProviderStatus | null | undefined,
  loading: ReadonlyMap<TeamProviderId, boolean>
): boolean {
  return (
    loading.get(providerId) === true ||
    status?.statusCheckOutcome === 'model_only' ||
    status?.modelCatalogRefreshState === 'loading' ||
    isProviderAuthorityRetryableTimeout(status)
  );
}

function isProviderAuthorityRetryableTimeout(
  status: CliProviderStatus | null | undefined
): boolean {
  return (
    status?.statusCheckOutcome === 'transient_error' && status.statusCheckErrorCode === 'timeout'
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
    if (loading.get(providerId) === true || isProviderAuthorityRetryableTimeout(status)) {
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
  now: number = Date.now()
): boolean {
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
