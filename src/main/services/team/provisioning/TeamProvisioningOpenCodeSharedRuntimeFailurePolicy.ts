import { isAutoRetryableOpenCodePreLaunchGate } from '../runtime/OpenCodeLaunchGateResult';

import { selectOpenCodeSharedRuntimePreflightFailureDiagnostic } from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';

import type { TeamRuntimeLaunchResult } from '../runtime/TeamRuntimeAdapter';

/**
 * One OpenCode host serves every lane of a project, so a shared-runtime
 * preflight failure in one lane is recorded per project and later lanes skip
 * their own doomed attempt. A models/agents/config query timeout is different
 * from host-unhealthy or connection-refused failures: it is routinely transient
 * (bootstrap contention while several members come up at once) and clears on
 * its own, so it must not block the project's remaining lanes for a whole run.
 */
export interface OpenCodeSharedRuntimeFailureRecord {
  rootCause: string;
  /** Timeout-class failures expire after a short TTL; other failures block until relaunch. */
  transient: boolean;
  recordedAtMs: number;
}

export type OpenCodeSharedRuntimeFailuresByProject = Map<
  string,
  OpenCodeSharedRuntimeFailureRecord
>;

export interface OpenCodeSharedRuntimeFailureScope {
  mixedSecondarySharedRuntimeFailuresByProject?: OpenCodeSharedRuntimeFailuresByProject;
}

export const OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS = 30_000;
export const OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS = 2_000;
export const OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC =
  'Retried OpenCode secondary launch once after a transient shared runtime preflight timeout.';

/**
 * Timeout-class subset of the shared-runtime preflight failures recognized by
 * `selectOpenCodeSharedRuntimePreflightFailureDiagnostic`. Host-unhealthy and
 * connection-refused failures stay non-transient on purpose: they do not clear
 * on their own within a launch run.
 */
const OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_PATTERNS = [
  /failed to query opencode (?:agents|models):.*\b(?:timed out|timeout)\b/i,
  /opencode request timed out.*\/config/i,
  /\/config request failed:.*\b(?:timed out|timeout)\b/i,
] as const;

export function isTransientOpenCodeSharedRuntimeFailure(rootCause: string): boolean {
  return OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_PATTERNS.some((pattern) =>
    pattern.test(rootCause)
  );
}

/**
 * Records the shared-runtime preflight failure of a finished lane result for
 * the lane's project. A result without such a failure proves the shared runtime
 * answered, so any stale record for the project is dropped instead.
 */
export function trackOpenCodeSharedRuntimeFailureFromResult(
  scope: OpenCodeSharedRuntimeFailureScope,
  cwd: string,
  result: TeamRuntimeLaunchResult,
  nowMs: number
): string | null {
  const rootCause = selectOpenCodeSharedRuntimePreflightFailureDiagnostic(result);
  if (!rootCause) {
    scope.mixedSecondarySharedRuntimeFailuresByProject?.delete(cwd);
    return null;
  }
  scope.mixedSecondarySharedRuntimeFailuresByProject ??= new Map();
  scope.mixedSecondarySharedRuntimeFailuresByProject.set(cwd, {
    rootCause,
    transient: isTransientOpenCodeSharedRuntimeFailure(rootCause),
    recordedAtMs: nowMs,
  });
  return rootCause;
}

/**
 * Root cause that still blocks the project's lanes, or null when the project
 * may attempt a launch. An expired transient record is consumed on read, so
 * exactly the next lane re-attempts the shared runtime; that lane's own result
 * then re-records the failure or leaves the project unblocked.
 */
export function takeBlockingOpenCodeSharedRuntimeFailure(
  scope: OpenCodeSharedRuntimeFailureScope,
  cwd: string,
  nowMs: number
): string | null {
  const failures = scope.mixedSecondarySharedRuntimeFailuresByProject;
  const record = failures?.get(cwd);
  if (!record) {
    return null;
  }
  if (
    record.transient &&
    nowMs - record.recordedAtMs >= OPENCODE_TRANSIENT_SHARED_RUNTIME_FAILURE_TTL_MS
  ) {
    failures?.delete(cwd);
    return null;
  }
  return record.rootCause;
}

/**
 * A lane launch may be retried in place only when both hold: the failure is the
 * transient timeout class above, and the result's pre-launch gate proves no
 * state-changing bridge command ran, so no host or session can be duplicated.
 */
export function shouldRetryTransientOpenCodeSharedRuntimeFailure(
  result: TeamRuntimeLaunchResult | null
): boolean {
  if (!result || !isAutoRetryableOpenCodePreLaunchGate(result)) {
    return false;
  }
  const rootCause = selectOpenCodeSharedRuntimePreflightFailureDiagnostic(result);
  return rootCause !== null && isTransientOpenCodeSharedRuntimeFailure(rootCause);
}
