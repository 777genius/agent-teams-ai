import { RUN_TIMEOUT_MS } from './TeamProvisioningBootstrapSpec';

import type { TeamProvisioningState } from '@shared/types';
import type { ChildProcess } from 'child_process';

interface TimeoutRun {
  child: ChildProcess | null | undefined;
  provisioningComplete: boolean;
  processKilled: boolean;
  cancelRequested: boolean;
  processClosed?: boolean;
  finalizingByTimeout?: boolean;
  authRetryInProgress?: boolean;
  requiresFirstRealTurnSuccess?: boolean;
  progress: { state: TeamProvisioningState };
}

interface TimeoutAttempt {
  child: ChildProcess;
  bootstrapDeadlineAt: number;
  firstTurnDeadlineAt?: number;
  nowMs(): number;
  schedule(ms: number): void;
}

// One owner for the deadline of each process attempt. A respawn replaces the
// entry, so neither its old timer nor its first-turn budget can affect the child.
const attempts = new WeakMap<TimeoutRun, TimeoutAttempt>();

function isPending(run: TimeoutRun): boolean {
  return (
    !run.provisioningComplete &&
    !run.processKilled &&
    !run.processClosed &&
    !run.cancelRequested &&
    !run.finalizingByTimeout &&
    !run.authRetryInProgress &&
    !['ready', 'failed', 'disconnected', 'cancelled'].includes(run.progress.state)
  );
}

export function recordProvisioningFirstTurnStart(run: TimeoutRun): void {
  const attempt = attempts.get(run);
  if (
    !attempt ||
    attempt.child !== run.child ||
    !run.requiresFirstRealTurnSuccess ||
    !isPending(run) ||
    attempt.firstTurnDeadlineAt !== undefined
  )
    return;
  const now = attempt.nowMs();
  // A delayed event cannot revive a bootstrap that already exceeded its budget.
  if (now >= attempt.bootstrapDeadlineAt) return;
  attempt.firstTurnDeadlineAt = now + RUN_TIMEOUT_MS;
  attempt.schedule(RUN_TIMEOUT_MS);
}

export function scheduleProvisioningRunTimeout(
  run: TimeoutRun & { timeoutHandle: NodeJS.Timeout | null },
  timeoutMs: number,
  onTimeout: () => void,
  timers: {
    setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
    clearTimeout?(handle: NodeJS.Timeout): void;
    nowMs?(): number;
  } = { setTimeout }
): void {
  const child = run.child;
  if (!child) return;
  const nowMs = timers.nowMs ?? Date.now;
  const attempt: TimeoutAttempt = {
    child,
    bootstrapDeadlineAt: nowMs() + timeoutMs,
    nowMs,
    schedule(ms) {
      if (run.timeoutHandle) (timers.clearTimeout ?? clearTimeout)(run.timeoutHandle);
      run.timeoutHandle = timers.setTimeout(expire, ms);
    },
  };
  attempts.set(run, attempt);
  const expire = (): void => {
    if (attempts.get(run) !== attempt || run.child !== child || !isPending(run)) return;
    const remaining = (attempt.firstTurnDeadlineAt ?? 0) - nowMs();
    if (remaining > 0) {
      attempt.schedule(remaining);
      return;
    }
    attempts.delete(run);
    onTimeout();
  };
  attempt.schedule(timeoutMs);
}
