import { describe, expect, it } from 'vitest';

import {
  type AdmissionAttempt,
  type AdmissionMutationAcknowledgement,
  HostedLifecycleCoordinator,
  type HostedLifecyclePorts,
  type LifecycleCancellation,
  type LifecycleOperation,
  type LifecycleOperationContext,
  LifecycleStateMachine,
  type LifecycleStopResult,
  type MonotonicClock,
  ReplacementAdmissionGate,
  type ReplacementAdmissionOperationContext,
  type ReplacementAdmissionPorts,
} from '../../../src/features/hosted-lifecycle-hardening';

class FakeMonotonicClock implements MonotonicClock {
  private timeMs = 0;
  private waiters: { readonly targetMs: number; readonly resolve: () => void }[] = [];

  nowMs(): number {
    return this.timeMs;
  }

  whenMsReached(targetMs: number): Promise<void> {
    if (this.timeMs >= targetMs) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push({ targetMs, resolve }));
  }

  advanceBy(elapsedMs: number): void {
    this.timeMs += elapsedMs;
    const ready = this.waiters.filter(({ targetMs }) => targetMs <= this.timeMs);
    this.waiters = this.waiters.filter(({ targetMs }) => targetMs > this.timeMs);
    for (const waiter of ready) waiter.resolve();
  }
}

class FakeCancellation implements LifecycleCancellation {
  private requested = false;
  private readonly cancellation = deferred<void>();

  isCancellationRequested(): boolean {
    return this.requested;
  }

  whenCancellationRequested(): Promise<void> {
    return this.cancellation.promise;
  }

  cancel(): void {
    if (!this.requested) {
      this.requested = true;
      this.cancellation.resolve();
    }
  }
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

async function waitForCall<T extends string>(calls: readonly T[], expected: T): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (calls.includes(expected)) return;
    await Promise.resolve();
  }
  throw new Error(`Operation was not called: ${expected}`);
}

type TestOperation = LifecycleOperation;
type OperationBehavior = Partial<Record<TestOperation, () => Promise<void>>>;

function createHarness(behavior: OperationBehavior = {}): {
  readonly coordinator: HostedLifecycleCoordinator;
  readonly clock: FakeMonotonicClock;
  readonly cancellation: FakeCancellation;
  readonly calls: TestOperation[];
  readonly ports: HostedLifecyclePorts;
} {
  const calls: TestOperation[] = [];
  const clock = new FakeMonotonicClock();
  const cancellation = new FakeCancellation();
  const run = async (operation: TestOperation): Promise<void> => {
    calls.push(operation);
    await behavior[operation]?.();
  };
  const ports: HostedLifecyclePorts = {
    routeAdmission: {
      closeAdmission: () => run('close_route_admission'),
    },
    readiness: {
      publishNotReady: () => run('publish_not_ready'),
    },
    connections: { drainHttpAndSse: () => run('drain_http_sse') },
    durableState: { flushDurableState: () => run('flush_durable_state') },
    audit: { flushAudit: () => run('flush_audit') },
    ownedRuntime: { releaseOwnedRuntime: () => run('release_owned_runtime') },
    clock,
    cancellation,
  };

  return {
    coordinator: new HostedLifecycleCoordinator(ports, { shutdownBudgetMs: 100 }),
    clock,
    cancellation,
    calls,
    ports,
  };
}

function stoppedResult(overrides: Partial<LifecycleStopResult> = {}): LifecycleStopResult {
  return {
    kind: 'stopped',
    finalState: 'stopped',
    startedAtMs: 0,
    completedAtMs: 10,
    deadlineMs: 100,
    failures: [],
    ...overrides,
  } as LifecycleStopResult;
}

describe('LifecycleStateMachine', () => {
  it('allows only the forward lifecycle sequence', () => {
    const machine = new LifecycleStateMachine();

    machine.transition('admission_closed');
    expect(() => machine.transition('flushing_state_audit')).toThrow(
      'Invalid lifecycle transition: admission_closed -> flushing_state_audit'
    );
    machine.transition('draining_http_sse');
    machine.transition('flushing_state_audit');
    machine.transition('releasing_owned_runtime');
    machine.transition('stopped');

    expect(machine.history).toEqual([
      'accepting',
      'admission_closed',
      'draining_http_sse',
      'flushing_state_audit',
      'releasing_owned_runtime',
      'stopped',
    ]);
  });
});

describe('HostedLifecycleCoordinator', () => {
  it('runs the complete shutdown sequence in order with one shared deadline', async () => {
    const { coordinator, calls, ports } = createHarness();
    const contexts: LifecycleOperationContext[] = [];
    ports.connections.drainHttpAndSse = async (context) => {
      contexts.push(context);
      calls.push('drain_http_sse');
    };

    const result = await coordinator.requestStop();

    expect(result).toMatchObject({
      kind: 'stopped',
      finalState: 'stopped',
      startedAtMs: 0,
      completedAtMs: 0,
      deadlineMs: 100,
      failures: [],
    });
    expect(calls).toEqual([
      'close_route_admission',
      'publish_not_ready',
      'drain_http_sse',
      'flush_durable_state',
      'flush_audit',
      'release_owned_runtime',
    ]);
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.deadlineMs).toBe(100);
    expect(coordinator.stateHistory).toEqual([
      'accepting',
      'admission_closed',
      'draining_http_sse',
      'flushing_state_audit',
      'releasing_owned_runtime',
      'stopped',
    ]);
  });

  it('coalesces repeated termination signals while shutdown is active', async () => {
    const drain = deferred<void>();
    const harness = createHarness({ drain_http_sse: () => drain.promise });

    const first = harness.coordinator.requestStop();
    const second = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'drain_http_sse');

    expect(second).toBe(first);
    expect(harness.calls).toEqual(['close_route_admission', 'publish_not_ready', 'drain_http_sse']);

    drain.resolve();
    await expect(first).resolves.toMatchObject({ kind: 'stopped' });
    expect(harness.calls.filter((call) => call === 'drain_http_sse')).toHaveLength(1);
  });

  it('returns the cached result without repeating work after shutdown', async () => {
    const harness = createHarness();
    const first = await harness.coordinator.requestStop();
    const callsAfterStop = [...harness.calls];

    const second = await harness.coordinator.requestStop();

    expect(second).toBe(first);
    expect(harness.calls).toEqual(callsAfterStop);
  });

  it('records non-barrier partial failures and continues remaining cleanup', async () => {
    const stateError = new Error('state unavailable');
    const releaseError = new Error('release unavailable');
    const harness = createHarness({
      flush_durable_state: async () => Promise.reject(stateError),
      release_owned_runtime: async () => Promise.reject(releaseError),
    });

    const result = await harness.coordinator.requestStop();

    expect(result.kind).toBe('failed');
    expect(result.failures).toEqual([
      { operation: 'flush_durable_state', error: stateError },
      { operation: 'release_owned_runtime', error: releaseError },
    ]);
    expect(harness.calls).toEqual([
      'close_route_admission',
      'publish_not_ready',
      'drain_http_sse',
      'flush_durable_state',
      'flush_audit',
      'release_owned_runtime',
    ]);
  });

  it('stops without claiming admission closure when route closure fails', async () => {
    const closeError = new Error('admission unavailable');
    const harness = createHarness({
      close_route_admission: async () => Promise.reject(closeError),
    });

    const result = await harness.coordinator.requestStop();

    expect(result).toMatchObject({
      kind: 'failed',
      failures: [{ operation: 'close_route_admission', error: closeError }],
    });
    expect(harness.calls).toEqual(['close_route_admission', 'publish_not_ready']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'stopped']);
  });

  it('stops without later work when route closure exceeds the deadline', async () => {
    const close = deferred<void>();
    const harness = createHarness({ close_route_admission: () => close.promise });
    const resultPromise = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'close_route_admission');

    harness.clock.advanceBy(100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'deadline_exceeded',
      interruptedOperation: 'close_route_admission',
    });
    expect(harness.calls).toEqual(['close_route_admission']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'stopped']);

    close.resolve();
    await flushMicrotasks();
  });

  it('stops without later work when route closure is cancelled', async () => {
    const close = deferred<void>();
    const harness = createHarness({ close_route_admission: () => close.promise });
    const resultPromise = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'close_route_admission');

    harness.cancellation.cancel();
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'cancelled',
      interruptedOperation: 'close_route_admission',
    });
    expect(harness.calls).toEqual(['close_route_admission']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'stopped']);

    close.resolve();
    await flushMicrotasks();
  });

  it('stops without claiming connection drain when draining fails', async () => {
    const drainError = new Error('drain unavailable');
    const harness = createHarness({
      drain_http_sse: async () => Promise.reject(drainError),
    });

    const result = await harness.coordinator.requestStop();

    expect(result).toMatchObject({
      kind: 'failed',
      failures: [{ operation: 'drain_http_sse', error: drainError }],
    });
    expect(harness.calls).toEqual(['close_route_admission', 'publish_not_ready', 'drain_http_sse']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'admission_closed', 'stopped']);
  });

  it('honors the hard deadline and starts no later cleanup phase', async () => {
    const drain = deferred<void>();
    const harness = createHarness({ drain_http_sse: () => drain.promise });
    const resultPromise = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'drain_http_sse');

    harness.clock.advanceBy(100);
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'deadline_exceeded',
      interruptedOperation: 'drain_http_sse',
      completedAtMs: 100,
    });
    expect(harness.calls).toEqual(['close_route_admission', 'publish_not_ready', 'drain_http_sse']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.state).toBe('stopped');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'admission_closed', 'stopped']);
  });

  it('stops without later work when connection draining is cancelled', async () => {
    const drain = deferred<void>();
    const harness = createHarness({ drain_http_sse: () => drain.promise });
    const resultPromise = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'drain_http_sse');

    harness.cancellation.cancel();
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'cancelled',
      interruptedOperation: 'drain_http_sse',
    });
    expect(harness.calls).toEqual(['close_route_admission', 'publish_not_ready', 'drain_http_sse']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(harness.coordinator.stateHistory).toEqual(['accepting', 'admission_closed', 'stopped']);

    drain.resolve();
    await flushMicrotasks();
  });

  it('initiates fail-closed admission even when the budget is already exhausted', async () => {
    const harness = createHarness();
    const coordinator = new HostedLifecycleCoordinator(harness.ports, { shutdownBudgetMs: 0 });

    const result = await coordinator.requestStop();
    await flushMicrotasks();

    expect(result).toMatchObject({
      kind: 'deadline_exceeded',
      interruptedOperation: 'close_route_admission',
    });
    expect(harness.calls).toEqual(['close_route_admission']);
    expect(harness.calls).not.toContain('release_owned_runtime');
    expect(coordinator.stateHistory).toEqual(['accepting', 'stopped']);
  });

  it('returns cancellation explicitly and does not begin later operations', async () => {
    const durableFlush = deferred<void>();
    const harness = createHarness({ flush_durable_state: () => durableFlush.promise });
    const resultPromise = harness.coordinator.requestStop();
    await waitForCall(harness.calls, 'flush_durable_state');

    harness.cancellation.cancel();
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'cancelled',
      interruptedOperation: 'flush_durable_state',
    });
    expect(harness.calls).toEqual([
      'close_route_admission',
      'publish_not_ready',
      'drain_http_sse',
      'flush_durable_state',
    ]);
  });
});

describe('ReplacementAdmissionGate', () => {
  type GateOperation =
    | 'publish_ready'
    | 'open_route_admission'
    | 'close_route_admission'
    | 'publish_not_ready';
  type GateBehavior = Partial<
    Record<GateOperation, (context: LifecycleOperationContext) => Promise<void>>
  >;
  type AcknowledgementFactory = (attempt: AdmissionAttempt) => AdmissionMutationAcknowledgement;

  function createGateHarness(
    options: {
      readonly behavior?: GateBehavior;
      readonly acknowledgements?: Partial<
        Record<'publish_ready' | 'open_route_admission', AcknowledgementFactory>
      >;
      readonly admissionBudgetMs?: number;
      readonly cleanupBudgetMs?: number;
    } = {}
  ): {
    readonly gate: ReplacementAdmissionGate;
    readonly clock: FakeMonotonicClock;
    readonly cancellation: FakeCancellation;
    readonly calls: GateOperation[];
    readonly cleanupContexts: LifecycleOperationContext[];
    readonly state: { admissionOpen: boolean; ready: boolean };
  } {
    const calls: GateOperation[] = [];
    const cleanupContexts: LifecycleOperationContext[] = [];
    const clock = new FakeMonotonicClock();
    const cancellation = new FakeCancellation();
    const state = { admissionOpen: false, ready: false };
    const run = async (
      operation: GateOperation,
      context: LifecycleOperationContext
    ): Promise<void> => {
      calls.push(operation);
      await options.behavior?.[operation]?.(context);
    };
    const acknowledgeMutation = (
      operation: 'publish_ready' | 'open_route_admission',
      context: ReplacementAdmissionOperationContext,
      apply: () => void,
      isApplied: () => boolean
    ): AdmissionMutationAcknowledgement => {
      const configured = options.acknowledgements?.[operation]?.(context.attempt);
      if (configured) {
        if (
          configured.generation === context.attempt.generation &&
          configured.disposition !== 'stale'
        ) {
          apply();
        }
        return configured;
      }
      if (!context.attempt.isCurrent()) {
        return { generation: context.attempt.generation, disposition: 'stale' };
      }
      if (isApplied()) {
        return { generation: context.attempt.generation, disposition: 'duplicate' };
      }
      apply();
      return { generation: context.attempt.generation, disposition: 'applied' };
    };
    const ports: ReplacementAdmissionPorts = {
      routeAdmission: {
        closeAdmission: async (context) => {
          cleanupContexts.push(context);
          await run('close_route_admission', context);
          state.admissionOpen = false;
        },
        openAdmission: async (context) => {
          await run('open_route_admission', context);
          return acknowledgeMutation(
            'open_route_admission',
            context,
            () => {
              state.admissionOpen = true;
            },
            () => state.admissionOpen
          );
        },
      },
      readiness: {
        publishNotReady: async (context) => {
          cleanupContexts.push(context);
          await run('publish_not_ready', context);
          state.ready = false;
        },
        publishReady: async (context) => {
          await run('publish_ready', context);
          return acknowledgeMutation(
            'publish_ready',
            context,
            () => {
              state.ready = true;
            },
            () => state.ready
          );
        },
      },
      clock,
      cancellation,
    };
    return {
      gate: new ReplacementAdmissionGate(ports, {
        admissionBudgetMs: options.admissionBudgetMs ?? 50,
        cleanupBudgetMs: options.cleanupBudgetMs ?? 20,
      }),
      clock,
      cancellation,
      calls,
      cleanupContexts,
      state,
    };
  }

  it('waits for a clean predecessor stop before admitting a replacement', async () => {
    const predecessor = deferred<LifecycleStopResult>();
    const harness = createGateHarness();

    const first = harness.gate.admitAfter(predecessor.promise);
    const second = harness.gate.admitAfter(predecessor.promise);
    await flushMicrotasks();
    expect(first).toBe(second);
    expect(harness.calls).toEqual([]);

    predecessor.resolve(stoppedResult());
    await expect(first).resolves.toMatchObject({ kind: 'admitted' });
    expect(harness.calls).toEqual(['publish_ready', 'open_route_admission']);
  });

  it('holds replacement admission closed after an unclean predecessor stop', async () => {
    const harness = createGateHarness();
    const failed = stoppedResult({
      kind: 'failed',
      failures: [{ operation: 'flush_audit', error: new Error('audit failed') }],
    });

    const result = await harness.gate.admitAfter(Promise.resolve(failed));

    expect(result).toMatchObject({ kind: 'held_closed', predecessor: failed });
    expect(harness.calls).toEqual([]);
  });

  it('restores fail-closed state when replacement readiness fails', async () => {
    const readinessError = new Error('readiness failed');
    const harness = createGateHarness({
      behavior: { publish_ready: async () => Promise.reject(readinessError) },
    });

    const result = await harness.gate.admitAfter(Promise.resolve(stoppedResult()));

    expect(result).toMatchObject({ kind: 'failed', error: readinessError });
    expect(harness.calls).toEqual(['publish_ready', 'close_route_admission', 'publish_not_ready']);
  });

  it('invalidates a timed-out open before independent cleanup and ignores its late completion', async () => {
    const openAdmission = deferred<void>();
    const harness = createGateHarness({
      behavior: { open_route_admission: () => openAdmission.promise },
    });
    const resultPromise = harness.gate.admitAfter(Promise.resolve(stoppedResult()));
    await waitForCall(harness.calls, 'open_route_admission');

    harness.clock.advanceBy(50);
    const result = await resultPromise;

    expect(result).toMatchObject({ kind: 'deadline_exceeded', cleanupFailures: [] });
    expect(harness.calls).toEqual([
      'publish_ready',
      'open_route_admission',
      'close_route_admission',
      'publish_not_ready',
    ]);
    expect(harness.state).toEqual({ admissionOpen: false, ready: false });
    expect(harness.cleanupContexts).toHaveLength(2);
    expect(harness.cleanupContexts[0]).toMatchObject({ deadlineMs: 70 });
    expect(harness.cleanupContexts[0]?.cancellation.isCancellationRequested()).toBe(false);

    openAdmission.resolve();
    await flushMicrotasks();

    expect(harness.state).toEqual({ admissionOpen: false, ready: false });
  });

  it('invalidates a cancelled open before uncancelled cleanup and ignores its late completion', async () => {
    const openAdmission = deferred<void>();
    const harness = createGateHarness({
      behavior: { open_route_admission: () => openAdmission.promise },
    });
    const resultPromise = harness.gate.admitAfter(Promise.resolve(stoppedResult()));
    await waitForCall(harness.calls, 'open_route_admission');

    harness.cancellation.cancel();
    const result = await resultPromise;

    expect(result).toMatchObject({ kind: 'cancelled', cleanupFailures: [] });
    expect(harness.calls).toEqual([
      'publish_ready',
      'open_route_admission',
      'close_route_admission',
      'publish_not_ready',
    ]);
    expect(
      harness.cleanupContexts.every(({ cancellation }) => !cancellation.isCancellationRequested())
    ).toBe(true);
    expect(harness.state).toEqual({ admissionOpen: false, ready: false });

    openAdmission.resolve();
    await flushMicrotasks();

    expect(harness.state).toEqual({ admissionOpen: false, ready: false });
  });

  it('accepts duplicate acknowledgements for the current generation idempotently', async () => {
    const duplicate: AcknowledgementFactory = ({ generation }) => ({
      generation,
      disposition: 'duplicate',
    });
    const harness = createGateHarness({
      acknowledgements: {
        publish_ready: duplicate,
        open_route_admission: duplicate,
      },
    });

    const result = await harness.gate.admitAfter(Promise.resolve(stoppedResult()));

    expect(result).toMatchObject({ kind: 'admitted' });
    expect(harness.state).toEqual({ admissionOpen: true, ready: true });
  });

  it.each([
    [
      'stale disposition',
      ({ generation }: AdmissionAttempt) => ({ generation, disposition: 'stale' as const }),
    ],
    [
      'stale generation',
      ({ generation }: AdmissionAttempt) => ({
        generation: generation - 1,
        disposition: 'applied' as const,
      }),
    ],
  ])('rejects a %s acknowledgement and restores fail-closed state', async (_, acknowledgement) => {
    const harness = createGateHarness({
      acknowledgements: { publish_ready: acknowledgement },
    });

    const result = await harness.gate.admitAfter(Promise.resolve(stoppedResult()));

    expect(result).toMatchObject({ kind: 'failed', cleanupFailures: [] });
    expect(harness.calls).toEqual(['publish_ready', 'close_route_admission', 'publish_not_ready']);
    expect(harness.state).toEqual({ admissionOpen: false, ready: false });
  });

  it('surfaces independent cleanup failures while still attempting both fail-closed actions', async () => {
    const readinessError = new Error('ready failed');
    const closeError = new Error('close failed');
    const harness = createGateHarness({
      behavior: {
        publish_ready: async () => Promise.reject(readinessError),
        close_route_admission: async () => Promise.reject(closeError),
      },
    });

    const result = await harness.gate.admitAfter(Promise.resolve(stoppedResult()));

    expect(result).toMatchObject({
      kind: 'failed',
      error: readinessError,
      cleanupFailures: [{ operation: 'close_route_admission', kind: 'failed', error: closeError }],
    });
    expect(harness.calls).toEqual(['publish_ready', 'close_route_admission', 'publish_not_ready']);
  });

  it('bounds independent cleanup and surfaces its deadline expiry', async () => {
    const readinessError = new Error('ready failed');
    const closeAdmission = deferred<void>();
    const harness = createGateHarness({
      behavior: {
        publish_ready: async () => Promise.reject(readinessError),
        close_route_admission: () => closeAdmission.promise,
      },
      cleanupBudgetMs: 20,
    });
    const resultPromise = harness.gate.admitAfter(Promise.resolve(stoppedResult()));
    await waitForCall(harness.calls, 'close_route_admission');
    await flushMicrotasks();

    harness.clock.advanceBy(20);
    const result = await resultPromise;

    expect(result).toMatchObject({
      kind: 'failed',
      error: readinessError,
      cleanupFailures: [{ operation: 'close_route_admission', kind: 'deadline_exceeded' }],
    });
    expect(harness.calls).toEqual(['publish_ready', 'close_route_admission', 'publish_not_ready']);

    closeAdmission.resolve();
    await flushMicrotasks();
  });
});
