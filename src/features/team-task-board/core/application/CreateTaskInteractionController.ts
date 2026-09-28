import type {
  ConfirmedCreateTask,
  CreateTaskAvailability,
  CreateTaskEnvelope,
  CreateTaskInteractionSnapshot,
  CreateTaskScope,
} from './models/CreateTaskInteraction';
import type {
  CreateTaskInteractionPorts,
  ExecuteCreateTaskOutcome,
} from './ports/CreateTaskInteractionPorts';

function sameScope(left: CreateTaskScope, right: CreateTaskScope): boolean {
  return left.key === right.key && left.authorityEpoch === right.authorityEpoch;
}

function copyAndFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(copyAndFreeze)) as T;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError('create-task-envelope-must-be-plain-data');
  }
  const copy: Record<string, unknown> = {};
  for (const [key, part] of Object.entries(value)) copy[key] = copyAndFreeze(part);
  return Object.freeze(copy) as T;
}

function validEnvelope(envelope: CreateTaskEnvelope, scope: CreateTaskScope): boolean {
  if (!sameScope(envelope.scope, scope)) return false;
  const { commandId, idempotencyKey } = envelope.identity;
  if (!envelope.intentId || !commandId || !idempotencyKey) return false;
  if (envelope.body.kind === 'desktop') {
    return (
      envelope.body.request.command.commandId === commandId &&
      envelope.body.request.command.idempotencyKey === idempotencyKey &&
      (Boolean(envelope.body.request.prompt) || Boolean(envelope.body.request.startImmediately)
        ? envelope.effects.kind === 'task_write_and_delivery'
        : true)
    );
  }
  return (
    envelope.body.command.kind === 'create_task' &&
    envelope.body.command.commandId === commandId &&
    envelope.body.command.idempotencyKey === idempotencyKey &&
    envelope.effects.kind === 'task_write'
  );
}

export class CreateTaskInteractionController<Draft> {
  private readonly scope: CreateTaskScope;
  private snapshot: CreateTaskInteractionSnapshot;
  private readonly listeners = new Set<() => void>();
  private readonly usedIntentIds = new Set<string>();
  private readonly outputIntentIds = new Set<string>();
  private operation = 0;
  private reading = false;

  constructor(
    scope: CreateTaskScope,
    private readonly ports: CreateTaskInteractionPorts<Draft>
  ) {
    this.scope = copyAndFreeze(scope);
    this.snapshot = Object.freeze({
      phase: 'idle',
      scope: this.scope,
      availability: this.readAvailability(),
      freshness: 'unknown',
      envelope: null,
      confirmed: null,
      recovery: 'none',
      reason: null,
    });
  }

  getSnapshot = (): CreateTaskInteractionSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    if (this.snapshot.phase === 'disposed') return () => undefined;
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAvailability(scope: CreateTaskScope, availability: CreateTaskAvailability): void {
    if (this.snapshot.phase === 'disposed' || !sameScope(scope, this.scope)) return;
    this.publish({ availability: copyAndFreeze(availability) });
  }

  /** Claims the gate before preparation can yield, including under two synchronous callers. */
  submit(draft: Draft): Promise<CreateTaskInteractionSnapshot> {
    if (
      !['idle', 'not_applied', 'conflict', 'dismissed_unconfirmed'].includes(this.snapshot.phase)
    ) {
      return Promise.resolve(this.snapshot);
    }
    const availability = this.effectiveAvailability();
    if (!availability.supported || !availability.available) {
      this.publish({ availability, phase: 'not_applied', reason: 'create_unavailable' });
      return Promise.resolve(this.snapshot);
    }
    const operation = ++this.operation;
    this.publish({ phase: 'preparing', availability, reason: null, freshness: 'unknown' });
    if (!this.currentInPhase(operation, 'preparing')) return Promise.resolve(this.snapshot);
    try {
      return this.prepareAndSubmit(copyAndFreeze(draft), operation);
    } catch {
      if (this.current(operation)) this.publish({ phase: 'not_applied', reason: 'invalid_draft' });
      return Promise.resolve(this.snapshot);
    }
  }

  private async prepareAndSubmit(
    draft: Draft,
    operation: number
  ): Promise<CreateTaskInteractionSnapshot> {
    let envelope: CreateTaskEnvelope;
    try {
      envelope = copyAndFreeze(await this.ports.prepareCreate(this.scope, draft));
    } catch {
      if (this.current(operation)) this.publish({ phase: 'not_applied', reason: 'prepare_failed' });
      return this.snapshot;
    }
    if (!this.current(operation)) return this.snapshot;
    if (!validEnvelope(envelope, this.scope) || this.usedIntentIds.has(envelope.intentId)) {
      this.publish({ phase: 'not_applied', reason: 'invalid_create_envelope' });
      return this.snapshot;
    }
    const availability = this.effectiveAvailability();
    if (!availability.supported || !availability.available) {
      this.publish({ phase: 'not_applied', availability, reason: 'create_unavailable' });
      return this.snapshot;
    }
    this.usedIntentIds.add(envelope.intentId);
    this.publish({ phase: 'submitting', envelope, availability, reason: null });
    if (!this.currentInPhase(operation, 'submitting')) return this.snapshot;
    return this.execute(envelope, operation, false);
  }

  retryExact(): Promise<CreateTaskInteractionSnapshot> {
    const envelope = this.snapshot.envelope;
    if (
      this.snapshot.phase !== 'uncertain' ||
      this.snapshot.recovery !== 'exact_replay' ||
      envelope?.effects.recovery !== 'exact_replay' ||
      !this.ports.recoverCreate
    ) {
      return Promise.resolve(this.snapshot);
    }
    const availability = this.effectiveAvailability();
    if (!availability.supported || !availability.available) {
      this.publish({ availability });
      return Promise.resolve(this.snapshot);
    }
    const operation = ++this.operation;
    this.publish({ phase: 'submitting', availability, reason: null });
    if (!this.currentInPhase(operation, 'submitting')) return Promise.resolve(this.snapshot);
    return this.execute(envelope, operation, true);
  }

  private async execute(
    envelope: CreateTaskEnvelope,
    operation: number,
    replay: boolean
  ): Promise<CreateTaskInteractionSnapshot> {
    let outcome: ExecuteCreateTaskOutcome;
    try {
      outcome = await (replay
        ? this.ports.recoverCreate!(envelope)
        : this.ports.executeCreate(envelope));
    } catch {
      outcome = { kind: 'uncertain', reason: 'create_outcome_unknown' };
    }
    if (!this.current(operation)) return this.snapshot;
    if (outcome.kind === 'confirmed') {
      if (
        outcome.intentId !== envelope.intentId ||
        !sameScope(outcome.scope, envelope.scope) ||
        outcome.identity.commandId !== envelope.identity.commandId ||
        outcome.identity.idempotencyKey !== envelope.identity.idempotencyKey
      ) {
        this.publish({
          phase: 'uncertain',
          reason: 'receipt_identity_mismatch',
          recovery: this.recoveryFor(envelope),
        });
        return this.snapshot;
      }
      const confirmed: ConfirmedCreateTask = copyAndFreeze({
        ...outcome.confirmation,
        origin: 'mutation_receipt',
      });
      this.confirm(envelope, confirmed, operation);
      await this.refreshConfirmed(operation);
      return this.snapshot;
    }
    if (!replay && (outcome.kind === 'not_applied' || outcome.kind === 'conflict')) {
      this.publish({
        phase: outcome.kind,
        envelope: null,
        reason: outcome.reason,
        recovery: 'none',
      });
      return this.snapshot;
    }
    this.publish({
      phase: 'uncertain',
      reason: outcome.reason,
      recovery: this.recoveryFor(envelope),
    });
    return this.snapshot;
  }

  observe(): Promise<CreateTaskInteractionSnapshot> {
    const envelope = this.snapshot.envelope;
    if (
      this.snapshot.phase !== 'uncertain' ||
      !envelope ||
      !this.ports.observeCreate ||
      this.reading
    ) {
      return Promise.resolve(this.snapshot);
    }
    this.reading = true;
    const operation = this.operation;
    return this.observePending(envelope, operation);
  }

  private async observePending(
    envelope: CreateTaskEnvelope,
    operation: number
  ): Promise<CreateTaskInteractionSnapshot> {
    try {
      const outcome = await this.ports.observeCreate!(envelope);
      if (this.current(operation) && this.snapshot.phase === 'uncertain') {
        if (outcome.kind === 'confirmed_task_write') {
          this.confirm(
            envelope,
            copyAndFreeze({
              origin: 'observed_task_record',
              coverage: 'task_write',
              reference: { taskId: outcome.taskId },
              recordState: outcome.state,
              replayed: 'unknown',
            }),
            operation
          );
          await this.refreshConfirmed(operation);
        } else if (outcome.kind === 'unresolved') {
          this.publish({ recovery: 'operator_required', reason: 'observation_unresolved' });
        }
      }
    } catch {
      if (this.current(operation) && this.snapshot.phase === 'uncertain') {
        this.publish({ recovery: 'operator_required', reason: 'observation_unavailable' });
      }
    } finally {
      this.reading = false;
    }
    return this.snapshot;
  }

  refresh(): Promise<CreateTaskInteractionSnapshot> {
    if (this.snapshot.phase !== 'confirmed' || this.snapshot.freshness === 'refreshing') {
      return Promise.resolve(this.snapshot);
    }
    return this.refreshConfirmed(this.operation).then(() => this.snapshot);
  }

  acknowledgeConfirmed(): void {
    if (this.snapshot.phase !== 'confirmed') return;
    ++this.operation;
    this.publish({
      phase: 'idle',
      envelope: null,
      confirmed: null,
      freshness: 'unknown',
      recovery: 'none',
      reason: null,
    });
  }

  /** Explicit operator action. This never asserts that the original write did not occur. */
  dismissUnresolved(): void {
    if (this.snapshot.phase !== 'uncertain') return;
    ++this.operation;
    this.publish({
      phase: 'dismissed_unconfirmed',
      envelope: null,
      recovery: 'none',
      reason: 'original_outcome_unconfirmed',
    });
  }

  dispose(): void {
    if (this.snapshot.phase === 'disposed') return;
    ++this.operation;
    this.reading = false;
    this.usedIntentIds.clear();
    this.outputIntentIds.clear();
    this.publish({
      phase: 'disposed',
      envelope: null,
      confirmed: null,
      recovery: 'none',
      reason: null,
    });
    this.listeners.clear();
  }

  private confirm(
    envelope: CreateTaskEnvelope,
    confirmation: ConfirmedCreateTask,
    operation: number
  ): void {
    this.publish({
      phase: 'confirmed',
      confirmed: confirmation,
      recovery: 'none',
      reason: null,
    });
    if (!this.currentInPhase(operation, 'confirmed')) return;
    // Receipt origin gates local output; coverage does not assert provider delivery.
    if (
      confirmation.origin === 'mutation_receipt' &&
      !this.outputIntentIds.has(envelope.intentId)
    ) {
      this.outputIntentIds.add(envelope.intentId);
      try {
        void Promise.resolve(this.ports.onConfirmed?.(envelope.intentId, confirmation)).catch(
          () => undefined
        );
      } catch {
        // A best-effort output cannot revoke the confirmed task write.
      }
    }
  }

  private async refreshConfirmed(operation: number): Promise<void> {
    const reference = this.snapshot.confirmed?.reference;
    if (!reference || this.snapshot.phase !== 'confirmed') return;
    this.publish({ freshness: 'refreshing' });
    if (!this.currentInPhase(operation, 'confirmed')) return;
    try {
      await this.ports.refreshCreatedTask(this.scope, reference);
      if (this.current(operation) && this.snapshot.phase === 'confirmed') {
        this.publish({ freshness: 'fresh' });
      }
    } catch {
      if (this.current(operation) && this.snapshot.phase === 'confirmed') {
        this.publish({ freshness: 'failed' });
      }
    }
  }

  private recoveryFor(envelope: CreateTaskEnvelope): CreateTaskInteractionSnapshot['recovery'] {
    if (envelope.effects.recovery === 'exact_replay' && this.ports.recoverCreate)
      return 'exact_replay';
    return this.ports.observeCreate ? 'observe' : 'operator_required';
  }

  private readAvailability(): CreateTaskAvailability {
    try {
      return copyAndFreeze(this.ports.readAvailability(this.scope));
    } catch {
      return Object.freeze({ supported: false, available: false });
    }
  }

  private effectiveAvailability(): CreateTaskAvailability {
    const latest = this.readAvailability();
    return Object.freeze({
      supported: latest.supported && this.snapshot.availability.supported,
      available: latest.available && this.snapshot.availability.available,
    });
  }

  private current(operation: number): boolean {
    return this.snapshot.phase !== 'disposed' && this.operation === operation;
  }

  private currentInPhase(
    operation: number,
    phase: CreateTaskInteractionSnapshot['phase']
  ): boolean {
    return this.current(operation) && this.snapshot.phase === phase;
  }

  private publish(change: Partial<CreateTaskInteractionSnapshot>): void {
    this.snapshot = Object.freeze({ ...this.snapshot, ...change });
    for (const listener of this.listeners) listener();
  }
}

export function createCreateTaskInteractionController<Draft>(
  scope: CreateTaskScope,
  ports: CreateTaskInteractionPorts<Draft>
): CreateTaskInteractionController<Draft> {
  return new CreateTaskInteractionController(scope, ports);
}
