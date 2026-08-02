import type { LifecycleCancellation, MonotonicClock } from './ports';

export type BudgetedOperationResult =
  | { readonly kind: 'completed' }
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'deadline_exceeded' }
  | { readonly kind: 'cancelled' };

export interface OperationBudget {
  readonly clock: MonotonicClock;
  readonly cancellation: LifecycleCancellation;
  readonly deadlineMs: number;
}

export function validateBudgetMs(budgetMs: number): void {
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new RangeError('Lifecycle budget must be a finite, non-negative number');
  }
}

export function deadlineFrom(
  clock: MonotonicClock,
  budgetMs: number,
  startedAtMs = clock.nowMs()
): number {
  validateBudgetMs(budgetMs);
  if (!Number.isFinite(startedAtMs)) {
    throw new RangeError('Monotonic clock must return a finite number');
  }
  const deadlineMs = startedAtMs + budgetMs;
  if (!Number.isFinite(deadlineMs)) {
    throw new RangeError('Lifecycle deadline must be finite');
  }
  return deadlineMs;
}

export async function runWithinBudget(
  budget: OperationBudget,
  operation: () => Promise<void>,
  options: { readonly startWhenInterrupted?: boolean } = {}
): Promise<BudgetedOperationResult> {
  const startExecution = (): Promise<BudgetedOperationResult> => {
    try {
      return Promise.resolve(operation()).then<BudgetedOperationResult, BudgetedOperationResult>(
        () => ({ kind: 'completed' }),
        (error: unknown) => ({ kind: 'failed', error })
      );
    } catch (error: unknown) {
      return Promise.resolve({ kind: 'failed', error });
    }
  };

  const earlyExecution = options.startWhenInterrupted ? startExecution() : undefined;
  if (budget.clock.nowMs() >= budget.deadlineMs) {
    return { kind: 'deadline_exceeded' };
  }
  if (budget.cancellation.isCancellationRequested()) {
    return { kind: 'cancelled' };
  }

  const execution = earlyExecution ?? startExecution();
  const cancellation = budget.cancellation
    .whenCancellationRequested()
    .then<BudgetedOperationResult>(() => ({ kind: 'cancelled' }));
  const deadline = budget.clock
    .whenMsReached(budget.deadlineMs)
    .then<BudgetedOperationResult>(() => ({ kind: 'deadline_exceeded' }));

  return Promise.race([execution, deadline, cancellation]);
}
