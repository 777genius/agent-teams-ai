import { type LifecycleState, LifecycleStateMachine } from './lifecycle-state-machine';
import {
  deadlineFrom,
  type OperationBudget,
  runWithinBudget,
  validateBudgetMs,
} from './operation-budget';

import type {
  AuditFlushPort,
  ConnectionDrainingPort,
  DurableStateFlushPort,
  LifecycleCancellation,
  LifecycleOperationContext,
  MonotonicClock,
  OwnedRuntimeReleasePort,
  ReadinessPublicationPort,
  RouteAdmissionPort,
} from './ports';

export type LifecycleOperation =
  | 'close_route_admission'
  | 'publish_not_ready'
  | 'drain_http_sse'
  | 'flush_durable_state'
  | 'flush_audit'
  | 'release_owned_runtime';

export interface LifecycleFailure {
  readonly operation: LifecycleOperation;
  readonly error: unknown;
}

interface LifecycleStopResultBase {
  readonly finalState: 'stopped';
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly deadlineMs: number;
  readonly failures: readonly LifecycleFailure[];
}

export type LifecycleStopResult =
  | (LifecycleStopResultBase & { readonly kind: 'stopped' })
  | (LifecycleStopResultBase & { readonly kind: 'failed' })
  | (LifecycleStopResultBase & {
      readonly kind: 'deadline_exceeded';
      readonly interruptedOperation: LifecycleOperation;
    })
  | (LifecycleStopResultBase & {
      readonly kind: 'cancelled';
      readonly interruptedOperation: LifecycleOperation;
    });

export interface HostedLifecyclePorts {
  readonly routeAdmission: RouteAdmissionPort;
  readonly readiness: ReadinessPublicationPort;
  readonly connections: ConnectionDrainingPort;
  readonly durableState: DurableStateFlushPort;
  readonly audit: AuditFlushPort;
  readonly ownedRuntime: OwnedRuntimeReleasePort;
  readonly clock: MonotonicClock;
  readonly cancellation: LifecycleCancellation;
}

export interface HostedLifecycleCoordinatorOptions {
  readonly shutdownBudgetMs: number;
}

interface Stage {
  readonly state: Exclude<LifecycleState, 'accepting' | 'stopped'>;
  readonly operations: readonly {
    readonly name: LifecycleOperation;
    readonly run: (context: LifecycleOperationContext) => Promise<void>;
  }[];
}

/** Coordinates shutdown; it never supervises or executes provider processes. */
export class HostedLifecycleCoordinator {
  private readonly machine = new LifecycleStateMachine();
  private stopResult?: Promise<LifecycleStopResult>;

  constructor(
    private readonly ports: HostedLifecyclePorts,
    private readonly options: HostedLifecycleCoordinatorOptions
  ) {
    validateBudgetMs(options.shutdownBudgetMs);
  }

  get state(): LifecycleState {
    return this.machine.state;
  }

  get stateHistory(): readonly LifecycleState[] {
    return this.machine.history;
  }

  /** The first request owns the budget; repeated signals receive the same promise. */
  requestStop(): Promise<LifecycleStopResult> {
    if (!this.stopResult) {
      this.stopResult = this.stopOnce();
    }
    return this.stopResult;
  }

  private async stopOnce(): Promise<LifecycleStopResult> {
    const startedAtMs = this.ports.clock.nowMs();
    const deadlineMs = deadlineFrom(this.ports.clock, this.options.shutdownBudgetMs, startedAtMs);
    const budget: OperationBudget = {
      clock: this.ports.clock,
      cancellation: this.ports.cancellation,
      deadlineMs,
    };
    const context: LifecycleOperationContext = {
      cancellation: this.ports.cancellation,
      deadlineMs,
    };
    const failures: LifecycleFailure[] = [];

    const finishFailed = (): LifecycleStopResult => {
      this.machine.stopAfterTerminalOutcome();
      return {
        kind: 'failed',
        finalState: 'stopped',
        startedAtMs,
        completedAtMs: this.ports.clock.nowMs(),
        deadlineMs,
        failures,
      };
    };
    const finishInterrupted = (
      kind: 'deadline_exceeded' | 'cancelled',
      interruptedOperation: LifecycleOperation
    ): LifecycleStopResult => {
      this.machine.stopAfterTerminalOutcome();
      return {
        kind,
        finalState: 'stopped',
        startedAtMs,
        completedAtMs: this.ports.clock.nowMs(),
        deadlineMs,
        failures,
        interruptedOperation,
      };
    };

    const closeAdmission = await runWithinBudget(
      budget,
      () => this.ports.routeAdmission.closeAdmission(context),
      {
        // Admission closure is the fail-closed action and is always initiated.
        startWhenInterrupted: true,
      }
    );
    if (closeAdmission.kind === 'deadline_exceeded' || closeAdmission.kind === 'cancelled') {
      return finishInterrupted(closeAdmission.kind, 'close_route_admission');
    }
    if (closeAdmission.kind === 'failed') {
      failures.push({ operation: 'close_route_admission', error: closeAdmission.error });

      // Publishing not-ready is still safe after closure fails, but no work that
      // assumes admission is closed may begin.
      const readiness = await runWithinBudget(budget, () =>
        this.ports.readiness.publishNotReady(context)
      );
      if (readiness.kind === 'failed') {
        failures.push({ operation: 'publish_not_ready', error: readiness.error });
      } else if (readiness.kind === 'deadline_exceeded' || readiness.kind === 'cancelled') {
        return finishInterrupted(readiness.kind, 'publish_not_ready');
      }
      return finishFailed();
    }

    this.machine.transition('admission_closed');

    const readiness = await runWithinBudget(budget, () =>
      this.ports.readiness.publishNotReady(context)
    );
    if (readiness.kind === 'failed') {
      failures.push({ operation: 'publish_not_ready', error: readiness.error });
    } else if (readiness.kind === 'deadline_exceeded' || readiness.kind === 'cancelled') {
      return finishInterrupted(readiness.kind, 'publish_not_ready');
    }

    const drainConnections = await runWithinBudget(budget, () =>
      this.ports.connections.drainHttpAndSse(context)
    );
    if (drainConnections.kind === 'failed') {
      failures.push({ operation: 'drain_http_sse', error: drainConnections.error });
      return finishFailed();
    }
    if (drainConnections.kind === 'deadline_exceeded' || drainConnections.kind === 'cancelled') {
      return finishInterrupted(drainConnections.kind, 'drain_http_sse');
    }

    this.machine.transition('draining_http_sse');

    const stages: readonly Stage[] = [
      {
        state: 'flushing_state_audit',
        operations: [
          {
            name: 'flush_durable_state',
            run: (value) => this.ports.durableState.flushDurableState(value),
          },
          { name: 'flush_audit', run: (value) => this.ports.audit.flushAudit(value) },
        ],
      },
      {
        state: 'releasing_owned_runtime',
        operations: [
          {
            name: 'release_owned_runtime',
            run: (value) => this.ports.ownedRuntime.releaseOwnedRuntime(value),
          },
        ],
      },
    ];

    for (const stage of stages) {
      this.machine.transition(stage.state);
      for (const operation of stage.operations) {
        const result = await runWithinBudget(budget, () => operation.run(context));
        if (result.kind === 'failed') {
          failures.push({ operation: operation.name, error: result.error });
          continue;
        }
        if (result.kind === 'deadline_exceeded' || result.kind === 'cancelled') {
          return finishInterrupted(result.kind, operation.name);
        }
      }
    }

    this.machine.transition('stopped');
    return {
      kind: failures.length === 0 ? 'stopped' : 'failed',
      finalState: 'stopped',
      startedAtMs,
      completedAtMs: this.ports.clock.nowMs(),
      deadlineMs,
      failures,
    };
  }
}
