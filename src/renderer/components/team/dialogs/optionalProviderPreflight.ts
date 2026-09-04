import { hasEffectiveProviderLaunchAuthority } from '@renderer/utils/providerReadiness';

import { runProviderPrepareDiagnostics } from './providerPrepareDiagnostics';

import type { ProviderPrepareDiagnosticsResult } from './providerPrepareDiagnostics';
import type { ProviderPreparePlan } from './providerPreparePlans';
import type { ProvisioningProviderCheck } from './provisioningProviderChecks';
import type { CliProviderStatus, TeamProviderId } from '@shared/types';

/** Skip only optional Anthropic/Codex model/PONG work, never provider discovery
 * or OpenCode exact-model proof. Re-evaluated at click time, including catalog TTL.
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
    if (
      loading.get(providerId) ||
      !hasEffectiveProviderLaunchAuthority(statuses.get(providerId), now)
    )
      return false;
    const check = checks.find((entry) => entry.providerId === providerId);
    if (!check || check.status === 'failed') return false;
    if (check.status === 'pending' || check.status === 'checking') {
      if (providerId !== 'anthropic' && providerId !== 'codex') return false;
      optionalPending = true;
    }
  }
  return optionalPending;
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
    /** Transfer only skipped optional work to one retry with the exact proof identity.
     * UI callbacks retain their original generation and can never cross the fence.
     */
    runPreflight(
      identity: Pick<ProviderPreparePlan, 'cacheKey' | 'requestSignature'>,
      input: Parameters<typeof runProviderPrepareDiagnostics>[0]
    ): Promise<ProviderPrepareDiagnosticsResult> {
      const { providerId } = input;
      const key = JSON.stringify([identity.cacheKey, identity.requestSignature]);
      const run = () => runProviderPrepareDiagnostics(input);
      if (providerId !== 'anthropic' && providerId !== 'codex') return run();
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
