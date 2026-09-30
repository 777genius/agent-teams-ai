import type { QueryContext } from '@shared/contracts/hosted';

export function requireOrchestratorLifecycleDeadlineRemaining(
  context: QueryContext,
  now: () => number
): number {
  const observedNow = now();
  if (!Number.isSafeInteger(observedNow) || context.deadlineAtMs <= observedNow) {
    throw new Error('orchestrator-lifecycle-request-deadline-exceeded');
  }
  return context.deadlineAtMs - observedNow;
}
