import {
  type BudgetedOperationResult,
  deadlineFrom,
  type OperationBudget,
  runWithinBudget,
  validateBudgetMs,
} from './operation-budget';

import type { LifecycleStopResult } from './hosted-lifecycle-coordinator';
import type {
  AdmissionAttempt,
  AdmissionMutationAcknowledgement,
  LifecycleCancellation,
  LifecycleOperationContext,
  MonotonicClock,
  ReplacementAdmissionOperationContext,
  ReplacementReadinessPublicationPort,
  ReplacementRouteAdmissionPort,
} from './ports';

export type ReplacementAdmissionCleanupOperation = 'close_route_admission' | 'publish_not_ready';

export interface ReplacementAdmissionCleanupFailure {
  readonly operation: ReplacementAdmissionCleanupOperation;
  readonly kind: 'failed' | 'deadline_exceeded' | 'cancelled';
  readonly error?: unknown;
}

export type ReplacementAdmissionResult =
  | { readonly kind: 'admitted'; readonly predecessor: LifecycleStopResult }
  | { readonly kind: 'held_closed'; readonly predecessor: LifecycleStopResult }
  | {
      readonly kind: 'failed' | 'deadline_exceeded' | 'cancelled';
      readonly predecessor: LifecycleStopResult;
      readonly error?: unknown;
      readonly cleanupFailures: readonly ReplacementAdmissionCleanupFailure[];
    };

export interface ReplacementAdmissionPorts {
  readonly routeAdmission: ReplacementRouteAdmissionPort;
  readonly readiness: ReplacementReadinessPublicationPort;
  readonly clock: MonotonicClock;
  readonly cancellation: LifecycleCancellation;
}

export interface ReplacementAdmissionGateOptions {
  readonly admissionBudgetMs: number;
  readonly cleanupBudgetMs: number;
}

type AdmissionFailure =
  | { readonly kind: 'failed'; readonly error: unknown }
  | { readonly kind: 'deadline_exceeded' | 'cancelled' };

const CLEANUP_CANCELLATION: LifecycleCancellation = {
  isCancellationRequested: () => false,
  whenCancellationRequested: () => new Promise<void>(() => undefined),
};

class MutableAdmissionAttempt implements AdmissionAttempt {
  private active = true;

  constructor(
    readonly generation: number,
    private readonly clock: MonotonicClock,
    private readonly context: LifecycleOperationContext
  ) {}

  isCurrent(): boolean {
    return (
      this.active &&
      this.clock.nowMs() < this.context.deadlineMs &&
      !this.context.cancellation.isCancellationRequested()
    );
  }

  invalidate(): void {
    this.active = false;
  }
}

export class AdmissionAcknowledgementError extends Error {
  constructor(
    readonly expectedGeneration: number,
    readonly acknowledgement: AdmissionMutationAcknowledgement | undefined
  ) {
    const received = acknowledgement
      ? `${acknowledgement.generation}/${acknowledgement.disposition}`
      : 'missing';
    super(
      `Invalid admission acknowledgement: expected ${expectedGeneration}, received ${received}`
    );
    this.name = 'AdmissionAcknowledgementError';
  }
}

/**
 * Opens a replacement only after its predecessor stops cleanly. Failure keeps,
 * or restores, both admission and readiness to their closed state.
 */
export class ReplacementAdmissionGate {
  private admissionResult?: Promise<ReplacementAdmissionResult>;
  private nextGeneration = 1;

  constructor(
    private readonly ports: ReplacementAdmissionPorts,
    private readonly options: ReplacementAdmissionGateOptions
  ) {
    validateBudgetMs(options.admissionBudgetMs);
    validateBudgetMs(options.cleanupBudgetMs);
  }

  admitAfter(predecessorStop: Promise<LifecycleStopResult>): Promise<ReplacementAdmissionResult> {
    if (!this.admissionResult) {
      this.admissionResult = this.admitOnce(predecessorStop);
    }
    return this.admissionResult;
  }

  private async admitOnce(
    predecessorStop: Promise<LifecycleStopResult>
  ): Promise<ReplacementAdmissionResult> {
    const predecessor = await predecessorStop;
    if (predecessor.kind !== 'stopped') {
      return { kind: 'held_closed', predecessor };
    }

    const deadlineMs = deadlineFrom(this.ports.clock, this.options.admissionBudgetMs);
    const budget: OperationBudget = {
      clock: this.ports.clock,
      cancellation: this.ports.cancellation,
      deadlineMs,
    };
    const context: LifecycleOperationContext = {
      cancellation: this.ports.cancellation,
      deadlineMs,
    };
    const attempt = new MutableAdmissionAttempt(this.nextGeneration, this.ports.clock, context);
    this.nextGeneration += 1;
    const operationContext: ReplacementAdmissionOperationContext = { ...context, attempt };

    const readiness = await this.runAcknowledged(budget, attempt, () =>
      this.ports.readiness.publishReady(operationContext)
    );
    if (readiness) {
      return this.failClosed(attempt, readiness, predecessor);
    }

    const admission = await this.runAcknowledged(budget, attempt, () =>
      this.ports.routeAdmission.openAdmission(operationContext)
    );
    if (admission) {
      return this.failClosed(attempt, admission, predecessor);
    }

    return { kind: 'admitted', predecessor };
  }

  private async runAcknowledged(
    budget: OperationBudget,
    attempt: AdmissionAttempt,
    operation: () => Promise<AdmissionMutationAcknowledgement>
  ): Promise<AdmissionFailure | undefined> {
    let acknowledgement: AdmissionMutationAcknowledgement | undefined;
    const result = await runWithinBudget(budget, async () => {
      acknowledgement = await operation();
    });

    if (result.kind !== 'completed') {
      return result;
    }
    if (
      acknowledgement?.generation !== attempt.generation ||
      acknowledgement.disposition === 'stale'
    ) {
      return {
        kind: 'failed',
        error: new AdmissionAcknowledgementError(attempt.generation, acknowledgement),
      };
    }
    return undefined;
  }

  private async failClosed(
    attempt: MutableAdmissionAttempt,
    failure: AdmissionFailure,
    predecessor: LifecycleStopResult
  ): Promise<ReplacementAdmissionResult> {
    attempt.invalidate();
    const cleanupFailures = await this.restoreClosedState();
    return failure.kind === 'failed'
      ? { kind: 'failed', predecessor, error: failure.error, cleanupFailures }
      : { kind: failure.kind, predecessor, cleanupFailures };
  }

  private async restoreClosedState(): Promise<readonly ReplacementAdmissionCleanupFailure[]> {
    const deadlineMs = deadlineFrom(this.ports.clock, this.options.cleanupBudgetMs);
    const budget: OperationBudget = {
      clock: this.ports.clock,
      cancellation: CLEANUP_CANCELLATION,
      deadlineMs,
    };
    const context: LifecycleOperationContext = {
      cancellation: CLEANUP_CANCELLATION,
      deadlineMs,
    };
    const operations: readonly {
      readonly name: ReplacementAdmissionCleanupOperation;
      readonly run: () => Promise<void>;
    }[] = [
      {
        name: 'close_route_admission',
        run: () => this.ports.routeAdmission.closeAdmission(context),
      },
      { name: 'publish_not_ready', run: () => this.ports.readiness.publishNotReady(context) },
    ];

    const results = await Promise.all(
      operations.map(async ({ name, run }) => ({
        name,
        result: await runWithinBudget(budget, run, { startWhenInterrupted: true }),
      }))
    );

    return results.flatMap(({ name, result }) => this.toCleanupFailure(name, result));
  }

  private toCleanupFailure(
    operation: ReplacementAdmissionCleanupOperation,
    result: BudgetedOperationResult
  ): readonly ReplacementAdmissionCleanupFailure[] {
    if (result.kind === 'completed') return [];
    return [
      result.kind === 'failed'
        ? { operation, kind: 'failed', error: result.error }
        : { operation, kind: result.kind },
    ];
  }
}
