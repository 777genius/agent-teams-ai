import { settledRuntimeAdmission } from './settledRuntimeAdmission.js';
import { formatTeamMessage } from './formatTeamMessage.js';
import { cancelRetainedDeliveries } from './cancelRetainedDeliveries.js';
import { classifyProof, deliveryIdentity } from './DeliveryRecovery.js';
import { queuedDiscardInput, validateQueuedDiscardReceipt } from './queuedDiscardContracts.js';
import { listProductCommandReceipts, teamCommandPath } from './commandEntries.js';
import { listQueuedUserMessagesFromRows } from './queuedUserMessageRows.js';
import { digest, safeSegment } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import type { QueuedDiscardReceipt } from './queuedDiscardContracts.js';
import type { CommandReceipt, DeliveryIntent, ImmutableDelivery, TeamBinding, TeamGrant, TeamRuntimeDeliveryPort } from './contracts.js';
import type { TeamStore, TeamPolicyPort } from './ports.js';

/** The existing inbox projection and original Runtime inputs remain the only queue. */
export class TeamQueuedMessages {
  constructor(private readonly options: {
    store: TeamStore; binding: TeamBinding; policy: TeamPolicyPort;
    authorize(principalId: string, permission: 'read' | 'admin'): TeamGrant;
    reserved(commandId: string): boolean;
    ownsTaskIntent(intent: DeliveryIntent, receipt: CommandReceipt): boolean;
    invalidate(): void;
  }) {}
  private receipt(commandId: string): QueuedDiscardReceipt | undefined {
    const raw = this.options.store.read<QueuedDiscardReceipt>(teamCommandPath(commandId));
    if (!raw) return undefined;
    const checked = validateQueuedDiscardReceipt(raw);
    if (checked.commandId !== commandId || digest(checked.binding) !== digest(this.options.binding)) throw new TeamOwnerError('hold');
    return checked;
  }
  private candidates(member: string) {
    safeSegment(member);
    const inbox = this.options.policy.readInbox(member);
    const rows = listQueuedUserMessagesFromRows(inbox);
    const outbox = this.options.store.list<DeliveryIntent>('outbox');
    const receipts = listProductCommandReceipts(this.options.store);
    return rows.flatMap(row => {
      const intents = outbox.filter(intent => intent.messageId === row.messageId);
      if (!intents.length) return []; // Imported/history-only rows have no proven Host queue admission and cannot be discarded here.
      if (intents.length !== 1) throw new TeamOwnerError('hold');
      const intent = intents[0]!, receipt = receipts.find(entry => entry.commandId === intent.commandId);
      if (!receipt || receipt.phase !== 'completed' || receipt.effects.messageId !== row.messageId ||
        intent.inputId !== intent.deliveryId || intent.binding.backendId !== this.options.binding.backendId ||
        intent.binding.teamId !== this.options.binding.teamId || intent.binding.teamName !== this.options.binding.teamName) throw new TeamOwnerError('hold');
      const original = receipt.result && typeof receipt.result === 'object' && !Array.isArray(receipt.result) ? receipt.result.message : undefined;
      if (receipt.command.operation === 'message.send') {
        if (receipt.command.payload.to !== member || !original || typeof original !== 'object' || Array.isArray(original) ||
          original.from !== 'user' || original.messageId !== row.messageId || original.text !== row.text) throw new TeamOwnerError('hold');
      } else if (!this.options.ownsTaskIntent(intent, receipt)) throw new TeamOwnerError('hold');
      const source = inbox.find(value => value && typeof value === 'object' && !Array.isArray(value) && value.messageId === row.messageId);
      if (!source) throw new TeamOwnerError('hold');
      if (receipt.command.operation === 'message.send' && (digest({ ...(source as Record<string, unknown>), read: false }) !== digest(original) ||
        receipt.effects.deliveryId !== intent.deliveryId || receipt.principalId !== intent.principalId || receipt.authorityRevision !== intent.authorityRevision ||
        digest(receipt.deliveryBinding) !== digest(intent.binding) ||
        formatTeamMessage(receipt.command.payload, 'user', receipt.effects.messageId, receipt.messageRecipientRole, receipt.crossTeam) !== intent.content)) throw new TeamOwnerError('hold');
      return [{ row, rowDigest: digest(source), intent: structuredClone(intent) }];
    });
  }
  private async visible(member: string, runtime: TeamRuntimeDeliveryPort) {
    const captured = this.options.store.fenced(() => this.candidates(member));
    const visible: typeof captured = [];
    for (const row of captured) {
      if (row.intent.phase === 'not_admitted') continue;
      const proof = await runtime.lookupDelivery(structuredClone(row.intent));
      const outcome = classifyProof(row.intent, proof, runtime);
      const phase = proof.receipt && typeof proof.receipt === 'object' && !Array.isArray(proof.receipt) ? proof.receipt.phase : undefined;
      if (outcome === 'absent' || (outcome === 'admitted' && phase === 'admitted')) visible.push(row);
    }
    return this.options.store.fenced(() => {
      const current = this.candidates(member);
      return visible.filter(row => current.some(now => now.row.messageId === row.row.messageId && now.rowDigest === row.rowDigest &&
        digest(deliveryIdentity(now.intent)) === digest(deliveryIdentity(row.intent))));
    });
  }
  async list(principalId: string, member: string, runtime: TeamRuntimeDeliveryPort) {
    this.options.store.fenced(() => { this.options.authorize(principalId, 'read'); this.options.authorize(principalId, 'admin'); });
    const rows = await this.visible(member, runtime);
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read'); this.options.authorize(principalId, 'admin');
      return { member, messages: rows.map(value => value.row) };
    });
  }
  async discard(principalId: string, raw: unknown, runtime: TeamRuntimeDeliveryPort): Promise<QueuedDiscardReceipt> {
    const parsed = queuedDiscardInput.safeParse(raw);
    if (!parsed.success || new Set(parsed.data.messageIds).size !== parsed.data.messageIds.length) throw new TeamOwnerError('invalid');
    const input = structuredClone(parsed.data);
    const captured = this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read'); this.options.authorize(principalId, 'admin');
      const fingerprint = digest({ binding: this.options.binding, principalId, input });
      const prior = this.receipt(input.commandId);
      if (prior) { if (prior.principalId !== principalId || prior.fingerprint !== fingerprint) throw new TeamOwnerError('conflict'); return prior; }
      if (this.options.reserved(input.commandId)) throw new TeamOwnerError('conflict');
      const selected = this.candidates(input.member).filter(row => input.messageIds.includes(row.row.messageId));
      const rows = selected.map(value => ({ messageId: value.row.messageId, digest: value.rowDigest }));
      const targets = selected.map(value => ({ intent: value.intent }));
      const receipt: QueuedDiscardReceipt = { schemaVersion: 1, family: 'queued-discard', binding: structuredClone(this.options.binding),
        ...input, principalId, fingerprint, captureDigest: digest({ rows, intents: targets.map(value => value.intent) }), rows, targets, phase: 'prepared' };
      validateQueuedDiscardReceipt(receipt);
      this.options.store.write(teamCommandPath(input.commandId), receipt);
      return receipt;
    });
    return this.continueCaptured(captured, runtime);
  }
  /** Read-only resolution of the exact original discard; never retries cancellation or deletes rows. */
  lookup(principalId: string, commandId: string, expected: unknown): QueuedDiscardReceipt | undefined {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.hasOwn(expected, 'commandId')) throw new TeamOwnerError('invalid');
    const parsed = queuedDiscardInput.safeParse({ ...expected, commandId });
    if (!parsed.success || new Set(parsed.data.messageIds).size !== parsed.data.messageIds.length) throw new TeamOwnerError('invalid');
    return this.options.store.fenced(() => {
      this.options.authorize(principalId, 'read');
      const prior = this.receipt(commandId);
      if (prior && (prior.principalId !== principalId || prior.fingerprint !== digest({ binding: this.options.binding, principalId, input: parsed.data }))) throw new TeamOwnerError('conflict');
      return prior ? structuredClone(prior) : undefined;
    });
  }
  private async continueCaptured(captured: QueuedDiscardReceipt, runtime: TeamRuntimeDeliveryPort): Promise<QueuedDiscardReceipt> {
    const input = { commandId: captured.commandId, member: captured.member };
    if (captured.phase === 'completed') return captured;
    await cancelRetainedDeliveries({ store: this.options.store, runtime, targets: captured.targets,
      assertRetained: target => {
        const current = this.receipt(input.commandId);
        if (!current?.targets.some(row => digest(row.intent) === digest(target.intent))) throw new TeamOwnerError('hold');
      },
      saveProof: target => {
        const current = this.receipt(input.commandId)!;
        const index = current.targets.findIndex(row => digest(row.intent) === digest(target.intent));
        if (index < 0) throw new TeamOwnerError('hold');
        current.targets[index] = structuredClone(target);
        this.options.store.write(teamCommandPath(input.commandId), current);
      },
    });
    const remaining = await this.visible(input.member, runtime);
    return this.options.store.fenced(() => {
      const receipt = this.receipt(input.commandId)!;
      if (receipt.phase === 'completed') return receipt;
      // A terminal/claimed input remains history. Only exact durable not-sent proof permits row removal.
      const cancelled = receipt.targets.filter(target => target.proof && target.fingerprint === runtime.fingerprintDelivery(target.intent) &&
        classifyProof(target.intent, target.proof, runtime) === 'not_admitted').map(target => target.intent.messageId);
      if (receipt.targets.some(target => !target.proof || target.fingerprint !== runtime.fingerprintDelivery(target.intent) ||
        (classifyProof(target.intent, target.proof, runtime) !== 'not_admitted' && !settledRuntimeAdmission(target.proof)))) throw new TeamOwnerError('hold');
      const currentOutbox = this.options.store.list<DeliveryIntent>('outbox');
      for (const target of receipt.targets) {
        const current = currentOutbox.filter(row => row.messageId === target.intent.messageId);
        if (current.length !== 1 || digest(deliveryIdentity(current[0]!)) !== digest(deliveryIdentity(target.intent))) throw new TeamOwnerError('hold');
      }
      const before = this.options.policy.readInbox(input.member);
      const selected = receipt.discardedMessageIds ?? receipt.rows.filter(row => cancelled.includes(row.messageId) && before.some(value => digest(value) === row.digest)).map(row => row.messageId);
      const kept = before.filter(value => {
        if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.messageId !== 'string' || !selected.includes(value.messageId)) return true;
        const original = receipt.rows.find(row => row.messageId === value.messageId)!;
        if (digest(value) !== original.digest) throw new TeamOwnerError('hold');
        return false;
      });
      receipt.discardedMessageIds = selected;
      this.options.store.write(teamCommandPath(input.commandId), receipt); // Same original decision precedes its recoverable inbox projection.
      if (kept.length !== before.length) this.options.store.write(`../inboxes/${safeSegment(input.member)}.json`, kept);
      receipt.remainingQueued = remaining.filter(value => !selected.includes(value.row.messageId)).length;
      receipt.phase = 'completed';
      this.options.store.write(teamCommandPath(input.commandId), receipt);
      this.options.invalidate();
      return structuredClone(receipt);
    });
  }
  /** Trusted cold continuation of the same original decisions, including after actor revocation. */
  async recover(runtime: TeamRuntimeDeliveryPort): Promise<{ commandId: string; phase: 'completed' | 'held' }[]> {
    const pending = this.options.store.fenced(() => this.options.store.list<{ family?: string; commandId: string }>('commands')
      .filter(row => row.family === 'queued-discard').map(row => this.receipt(row.commandId)!).filter(row => row.phase === 'prepared'));
    const result: { commandId: string; phase: 'completed' | 'held' }[] = [];
    for (const receipt of pending) {
      try { await this.continueCaptured(receipt, runtime); result.push({ commandId: receipt.commandId, phase: 'completed' }); }
      catch { result.push({ commandId: receipt.commandId, phase: 'held' }); }
    }
    return result;
  }
  authorizeCancellation(raw: ImmutableDelivery, pendingOnly = false): boolean {
    return this.options.store.fenced(() => this.options.store.list<{ family?: string; commandId: string }>('commands').some(value => {
      if (value.family !== 'queued-discard') return false;
      const receipt = this.receipt(value.commandId)!;
      return (!pendingOnly || receipt.phase === 'prepared') && receipt.targets.some(target => digest(deliveryIdentity(target.intent)) === digest(deliveryIdentity(raw)));
    }));
  }
}
