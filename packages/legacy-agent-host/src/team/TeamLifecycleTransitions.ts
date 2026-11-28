import { controllerProjection } from './TeamRosterTransitions.js';
import { teamLifecycleInput, validateTeamLifecycleReceipt } from './lifecycleContracts.js';
import type { TeamLifecycleState, LifecycleOwnerState, TeamLifecycleReceipt } from './lifecycleContracts.js';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { teamCommandPath } from './commandEntries.js';
import { deliveryIdentity } from './DeliveryRecovery.js';
import type { DeliveryIntent, ImmutableDelivery, RuntimeMemberBinding, TeamBinding, TeamGrant } from './contracts.js';
import type { TeamStore } from './ports.js';
import type { RetainedDeliveryCancellation } from './cancelRetainedDeliveries.js';

/** Product tombstone decisions live in the same Team command namespace/fence as Task and review receipts. */
export class TeamLifecycleTransitions {
  constructor(private readonly options: {
    store: TeamStore;
    binding: TeamBinding;
    state(): LifecycleOwnerState;
    authorize(principalId: string, permission: 'admin' | 'read'): TeamGrant;
    captureRuntimeBindings(state: LifecycleOwnerState): RuntimeMemberBinding[];
    recoverConfig(state: LifecycleOwnerState): void;
    invalidate(): void;
    reserved(commandId: string): boolean;
  }) {}

  private receipt(commandId: string): TeamLifecycleReceipt | undefined {
    const value = this.options.store.read<TeamLifecycleReceipt>(teamCommandPath(commandId));
    if (!value) return undefined;
    const checked = validateTeamLifecycleReceipt(value);
    if (digest(checked.binding) !== digest(this.options.binding) || checked.commandId !== commandId) throw new TeamOwnerError('hold');
    return value;
  }
  execute(principalId: string, raw: unknown): TeamLifecycleReceipt {
    const parsed = teamLifecycleInput.safeParse(raw);
    if (!parsed.success) throw new TeamOwnerError('invalid');
    const input = parsed.data;
    const { store } = this.options;
    return store.fenced(() => {
      const grant = this.options.authorize(principalId, 'admin');
      this.options.authorize(principalId, 'read');
      const fingerprint = digest({ binding: this.options.binding, principalId, input });
      const prior = this.receipt(input.commandId);
      if (prior) {
        if (prior.principalId !== principalId || prior.fingerprint !== fingerprint) throw new TeamOwnerError('conflict');
        return this.publish(prior);
      }
      if (this.options.reserved(input.commandId)) throw new TeamOwnerError('conflict');
      const state = this.options.state();
      if (digest(state.lifecycle ?? null) !== input.expectedRevision) throw new TeamOwnerError('conflict');
      const timestamp = new Date().toISOString();
      let after: TeamLifecycleState;
      if (input.operation === 'trash') after = { deletedAt: state.lifecycle?.deletedAt ?? timestamp, cleanupCommandId: input.commandId, cleanupPending: true };
      else {
        if (!state.lifecycle?.deletedAt) throw new TeamOwnerError('invalid');
        after = { cleanupCommandId: state.lifecycle.cleanupCommandId, cleanupPending: state.lifecycle.cleanupPending };
      }
      const targets = input.operation === 'trash' ? store.list<DeliveryIntent>('outbox').map(intent => ({ intent: structuredClone(intent) })) : [];
      const runtimeBindings = input.operation === 'trash' ? this.options.captureRuntimeBindings(state) : [];
      const receipt: TeamLifecycleReceipt = { schemaVersion: 1, family: 'lifecycle', binding: structuredClone(this.options.binding),
        commandId: input.commandId, principalId, fingerprint, captureDigest: digest({ intents: targets.map(target => target.intent), runtimeBindings }), authorityRevision: grant.revision ?? 1, operation: input.operation,
        createdAt: timestamp, phase: 'prepared', before: structuredClone(state.lifecycle ?? null), after,
        targets, runtimeBindings };
      validateTeamLifecycleReceipt(receipt);
      store.write(teamCommandPath(input.commandId), receipt);
      return this.publish(receipt);
    });
  }
  private publish(receipt: TeamLifecycleReceipt): TeamLifecycleReceipt {
    const state = this.options.state();
    if (receipt.phase === 'held') throw new TeamOwnerError('hold');
    if (receipt.phase === 'completed') return structuredClone(receipt);
    const current = digest(state.lifecycle ?? null);
    if (current !== digest(receipt.after)) {
      const grant = this.options.authorize(receipt.principalId, 'admin');
      if (current !== digest(receipt.before) || (grant.revision ?? 1) !== receipt.authorityRevision) throw new TeamOwnerError('hold');
      const before = this.options.store.read<Record<string, unknown>>('../config.json');
      if (!before) throw new TeamOwnerError('hold');
      state.lifecycle = structuredClone(receipt.after);
      const previous = JSON.parse(JSON.stringify(before));
      state.rosterProjection = { before: previous, after: controllerProjection(state, previous) };
      this.options.store.write('state.json', state); // Business commit closes ingress before any cleanup await.
      this.options.invalidate();
    }
    this.options.recoverConfig(state);
    receipt.phase = 'completed';
    this.options.store.write(teamCommandPath(receipt.commandId), receipt);
    return structuredClone(receipt);
  }
  lookup(principalId: string, commandId: string, expected: unknown): TeamLifecycleReceipt | undefined {
    if (expected && typeof expected === 'object' && Object.hasOwn(expected, 'commandId')) throw new TeamOwnerError('invalid');
    const parsed = teamLifecycleInput.safeParse({ ...(expected && typeof expected === 'object' ? expected : {}), commandId });
    if (!parsed.success) throw new TeamOwnerError('invalid');
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const prior = this.receipt(commandId);
      if (prior && (prior.principalId !== principalId || prior.fingerprint !== digest({ binding: this.options.binding, principalId, input: parsed.data }))) throw new TeamOwnerError('conflict');
      return prior ? structuredClone(prior) : undefined;
    });
  }
  /** Explicit startup/retry continuation; never submits an input, restores a grant or invokes stop here. */
  recover(): void {
    this.options.store.fenced(() => {
      for (const raw of this.options.store.list<TeamLifecycleReceipt>('commands')) {
        if (raw.family !== 'lifecycle' || raw.phase !== 'prepared') continue;
        const receipt = this.receipt(raw.commandId)!;
        this.publish(receipt);
      }
    });
  }
  view(principalId: string) {
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const state = this.options.state();
      return { revision: digest(state.lifecycle ?? null), deletedAt: state.lifecycle?.deletedAt ?? null, deleted: !!state.lifecycle?.deletedAt, cleanupPending: state.lifecycle?.cleanupPending ?? false };
    });
  }
  /** Same immutable retained command scope may cancel after revoke; this never grants new work or arbitrary member control. */
  retainedCancellation(commandId: string, raw: ImmutableDelivery): boolean {
    return this.options.store.fenced(() => {
      const receipt = this.receipt(commandId);
      return !!receipt && receipt.operation === 'trash' && receipt.phase === 'completed' &&
        receipt.targets.some(target => digest(deliveryIdentity(target.intent)) === digest(deliveryIdentity(raw)));
    });
  }
  authorizeCancellation(raw: ImmutableDelivery): boolean {
    return this.options.store.fenced(() => this.options.store.list<TeamLifecycleReceipt>('commands').some(receipt =>
      receipt.family === 'lifecycle' && this.retainedCancellation(receipt.commandId, raw)));
  }
  saveCancellation(commandId: string, target: RetainedDeliveryCancellation): void {
    this.options.store.fenced(() => {
    const receipt = this.receipt(commandId);
    if (!receipt || !this.retainedCancellation(commandId, target.intent)) throw new TeamOwnerError('hold');
    const index = receipt.targets.findIndex(row => digest(row.intent) === digest(target.intent));
    if (index < 0) throw new TeamOwnerError('hold');
    receipt.targets[index] = structuredClone(target);
    this.options.store.write(teamCommandPath(commandId), receipt);
    });
  }
  capturedCleanup(commandId: string): TeamLifecycleReceipt {
    return this.options.store.fenced(() => {
      const receipt = this.receipt(commandId);
      if (!receipt || receipt.operation !== 'trash' || receipt.phase !== 'completed') throw new TeamOwnerError('hold');
      return structuredClone(receipt);
    });
  }
  /** Called only with actual exact Runtime closed/released and cancellation proofs already checked by composition. */
  settleCleanup(commandId: string, assertReleased: (receipt: TeamLifecycleReceipt) => void): void {
    this.options.store.fenced(() => {
      const receipt = this.receipt(commandId);
      if (!receipt || receipt.operation !== 'trash' || receipt.phase !== 'completed') throw new TeamOwnerError('hold');
      const result: unknown = assertReleased(structuredClone(receipt));
      if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw new TeamOwnerError('hold'); }
      const state = this.options.state();
      if (state.lifecycle?.cleanupCommandId !== commandId) return;
      state.lifecycle.cleanupPending = false;
      this.options.store.write('state.json', state);
      this.options.invalidate();
    });
  }
}
