import type { HostedReadinessProbe } from './HostedReadiness';

export interface HostedLifecycleComponent extends HostedReadinessProbe {
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
}

export type HostedLifecycleState = 'failed' | 'started' | 'starting' | 'stopped' | 'stopping';

export interface HostedLifecycleSnapshot {
  readonly generation: number;
  readonly state: HostedLifecycleState;
  readonly startedComponentIds: readonly string[];
}

export interface HostedLifecycleFailure {
  readonly componentId: string;
  readonly error: unknown;
}

function immutableFailure(failure: HostedLifecycleFailure): HostedLifecycleFailure {
  return Object.freeze({ ...failure });
}

export class HostedLifecycleStartError extends AggregateError {
  readonly startFailure: HostedLifecycleFailure;
  readonly rollbackFailures: readonly HostedLifecycleFailure[];

  constructor(
    startFailure: HostedLifecycleFailure,
    rollbackFailures: readonly HostedLifecycleFailure[]
  ) {
    const immutableStartFailure = immutableFailure(startFailure);
    const immutableRollbackFailures = Object.freeze(rollbackFailures.map(immutableFailure));
    super(
      [immutableStartFailure.error, ...immutableRollbackFailures.map((failure) => failure.error)],
      `Hosted component start failed and rollback was incomplete: ${startFailure.componentId}`,
      { cause: startFailure.error }
    );
    this.name = 'HostedLifecycleStartError';
    this.startFailure = immutableStartFailure;
    this.rollbackFailures = immutableRollbackFailures;
  }
}

export class HostedLifecycleStopError extends AggregateError {
  readonly failures: readonly HostedLifecycleFailure[];

  constructor(failures: readonly HostedLifecycleFailure[]) {
    const immutableFailures = Object.freeze(failures.map(immutableFailure));
    super(
      immutableFailures.map((failure) => failure.error),
      `Hosted component stop failed: ${immutableFailures
        .map((failure) => failure.componentId)
        .join(', ')}`
    );
    this.name = 'HostedLifecycleStopError';
    this.failures = immutableFailures;
  }
}

export class HostedLifecycleStateError extends Error {
  constructor(state: HostedLifecycleState) {
    super(`Hosted lifecycle cannot start while cleanup is incomplete: ${state}`);
    this.name = 'HostedLifecycleStateError';
  }
}

function assertComponentIds(components: readonly HostedLifecycleComponent[]): void {
  const ids = new Set<string>();

  for (const component of components) {
    if (
      component.id.length === 0 ||
      component.id.trim() !== component.id ||
      ids.has(component.id)
    ) {
      throw new TypeError(`Invalid or duplicate hosted lifecycle component id: ${component.id}`);
    }
    ids.add(component.id);
  }
}

type HostedLifecycleOperationKind = 'start' | 'stop';

interface HostedLifecycleOperation {
  readonly id: number;
  readonly kind: HostedLifecycleOperationKind;
  begun: boolean;
  promise: Promise<void>;
}

/** Orders lifecycle ports and owns only their operational state. */
export class HostedLifecycle {
  private readonly components: readonly HostedLifecycleComponent[];
  private readonly startedComponents: HostedLifecycleComponent[] = [];
  private currentState: HostedLifecycleState = 'stopped';
  private currentGeneration = 0;
  private nextOperationId = 1;
  private tailOperation: HostedLifecycleOperation | undefined;

  constructor(components: readonly HostedLifecycleComponent[]) {
    assertComponentIds(components);
    this.components = Object.freeze([...components]);
  }

  get state(): HostedLifecycleState {
    return this.currentState;
  }

  snapshot(): HostedLifecycleSnapshot {
    return Object.freeze({
      generation: this.currentGeneration,
      state: this.currentState,
      startedComponentIds: Object.freeze(this.startedComponents.map((component) => component.id)),
    });
  }

  start(): Promise<void> {
    return this.requestOperation('start');
  }

  stop(): Promise<void> {
    return this.requestOperation('stop');
  }

  private requestOperation(kind: HostedLifecycleOperationKind): Promise<void> {
    const precedingOperation = this.tailOperation;
    if (precedingOperation?.kind === kind) return precedingOperation.promise;

    if (precedingOperation === undefined) {
      if (kind === 'start' && this.currentState === 'started') return Promise.resolve();
      if (kind === 'stop' && this.currentState === 'stopped') return Promise.resolve();
      if (kind === 'start' && this.currentState === 'failed') {
        return Promise.reject(new HostedLifecycleStateError(this.currentState));
      }
    }

    const operation: HostedLifecycleOperation = {
      id: this.nextOperationId++,
      kind,
      begun: false,
      promise: Promise.resolve(),
    };

    if (precedingOperation === undefined) this.beginOperation(operation);

    const run = (): Promise<void> => this.executeOperation(operation);
    operation.promise =
      precedingOperation === undefined
        ? Promise.resolve().then(run)
        : precedingOperation.promise.then(run, run);
    this.tailOperation = operation;
    this.clearTailWhenSettled(operation);
    return operation.promise;
  }

  private beginOperation(operation: HostedLifecycleOperation): void {
    if (operation.begun) return;
    operation.begun = true;
    this.currentGeneration += 1;
    this.currentState = operation.kind === 'start' ? 'starting' : 'stopping';
  }

  private async executeOperation(operation: HostedLifecycleOperation): Promise<void> {
    if (!operation.begun) {
      if (
        operation.kind === 'start' &&
        (this.currentState === 'failed' || this.startedComponents.length > 0)
      ) {
        this.currentGeneration += 1;
        this.currentState = 'failed';
        throw new HostedLifecycleStateError(this.currentState);
      }
      this.beginOperation(operation);
    }

    if (operation.kind === 'start') {
      await this.startComponents();
      return;
    }

    if (this.startedComponents.length === 0) {
      this.currentState = 'stopped';
      return;
    }

    const failures = await this.stopStartedComponents();
    this.currentState = this.startedComponents.length === 0 ? 'stopped' : 'failed';
    if (failures.length > 0) throw new HostedLifecycleStopError(failures);
  }

  private async startComponents(): Promise<void> {
    for (const component of this.components) {
      try {
        await component.start();
        this.startedComponents.push(component);
      } catch (error) {
        const startFailure = immutableFailure({ componentId: component.id, error });
        const rollbackFailures = await this.stopStartedComponents();
        this.currentState = this.startedComponents.length === 0 ? 'stopped' : 'failed';

        if (rollbackFailures.length > 0) {
          throw new HostedLifecycleStartError(startFailure, rollbackFailures);
        }
        throw error;
      }
    }

    this.currentState = 'started';
  }

  private async stopStartedComponents(): Promise<HostedLifecycleFailure[]> {
    const failures: HostedLifecycleFailure[] = [];

    for (const component of [...this.startedComponents].reverse()) {
      try {
        await component.stop();
        const componentIndex = this.startedComponents.lastIndexOf(component);
        if (componentIndex >= 0) this.startedComponents.splice(componentIndex, 1);
      } catch (error) {
        failures.push(immutableFailure({ componentId: component.id, error }));
      }
    }

    return failures;
  }

  private clearTailWhenSettled(operation: HostedLifecycleOperation): void {
    const clear = (): void => {
      if (this.tailOperation?.id === operation.id) this.tailOperation = undefined;
    };
    operation.promise.then(clear, clear);
  }
}
