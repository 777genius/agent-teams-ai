import { isAutoRetryableOpenCodePreLaunchGate } from '../runtime/OpenCodeLaunchGateResult';

import { sleep } from './TeamProvisioningAsyncUtils';
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
 * Drops a non-transient record an earlier launch left for this project.
 *
 * A permanent record is what blocks the remaining lanes of the run that saw the
 * failure, and the run-scoped ledger keeps doing exactly that. The scope shared
 * across primary launches has a narrower job: stop a relaunch from spending a
 * second retry inside the transient TTL window. A host-unhealthy or
 * connection-refused record never expires, so left in that scope it also
 * cancels the eligible retry of every later launch of the same project - long
 * after the host was restarted and the condition it describes is gone.
 */
export function clearNonTransientOpenCodeSharedRuntimeFailure(
  scope: OpenCodeSharedRuntimeFailureScope,
  cwd: string
): void {
  const failures = scope.mixedSecondarySharedRuntimeFailuresByProject;
  const record = failures?.get(cwd);
  if (record && !record.transient) {
    failures?.delete(cwd);
  }
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

export interface OpenCodePrimaryTransientSharedRuntimeRetryPorts {
  nowMs(): number;
  logWarning(message: string): void;
  /** False once this launch lost authority: cancelled, or superseded by a newer run. */
  hasLaunchAuthority(): boolean;
}

/**
 * The primary launch has no later lane that could re-attempt the shared runtime
 * on its behalf: one timeout-class preflight failure fails the whole team at
 * the readiness gate with every member marked failed_to_start. Grant it what a
 * secondary lane already gets - one in-place relaunch after the same backoff,
 * only for the timeout class and only while the pre-launch gate marker is
 * present - and record the same TTL-scoped failure, so a second timeout inside
 * the window fails normally instead of retrying forever.
 */
export async function launchOpenCodePrimaryWithTransientSharedRuntimeRetry(
  params: {
    teamName: string;
    cwd: string;
    scope: OpenCodeSharedRuntimeFailureScope;
    launch: () => Promise<TeamRuntimeLaunchResult>;
  },
  ports: OpenCodePrimaryTransientSharedRuntimeRetryPorts
): Promise<TeamRuntimeLaunchResult> {
  // This call is the project's cross-launch boundary: whatever a previous
  // launch could not recover from is that launch's verdict, not this one's.
  clearNonTransientOpenCodeSharedRuntimeFailure(params.scope, params.cwd);
  const result = await params.launch();
  if (!shouldRetryTransientOpenCodeSharedRuntimeFailure(result)) {
    trackOpenCodeSharedRuntimeFailureFromResult(params.scope, params.cwd, result, ports.nowMs());
    return result;
  }
  // A record that still blocks proves an earlier attempt already spent this
  // project's retry inside the TTL window (or failed for a non-transient
  // reason), so this failure is reported as it stands.
  const blockingFailure = takeBlockingOpenCodeSharedRuntimeFailure(
    params.scope,
    params.cwd,
    ports.nowMs()
  );
  trackOpenCodeSharedRuntimeFailureFromResult(params.scope, params.cwd, result, ports.nowMs());
  if (blockingFailure !== null || !ports.hasLaunchAuthority()) {
    return result;
  }
  ports.logWarning(
    `[${params.teamName}] OpenCode primary launch hit a transient shared runtime timeout; retrying once in ${OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS}ms`
  );
  await sleep(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS);
  // The backoff is a window in which a stop or a newer run can take the team.
  if (!ports.hasLaunchAuthority()) {
    return result;
  }
  const retryResult = await params.launch();
  trackOpenCodeSharedRuntimeFailureFromResult(params.scope, params.cwd, retryResult, ports.nowMs());
  return retryResult;
}
