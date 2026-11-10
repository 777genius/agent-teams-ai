import { settledRuntimeAdmission } from './settledRuntimeAdmission.js';
import { listProductCommandReceipts } from './commandEntries.js';
import { TeamOwnerError } from './contracts.js';
import { isUserTaskStartIntent } from './taskStartIntent.js';
import { classifyProof, deliveryIdentity } from './DeliveryRecovery.js';
import { digest, effectId } from './identity.js';
import { safeSegment } from './identity.js';
import type { TaskStartCause } from './TaskStartCause.js';

import type { JsonValue } from '../contracts.js';
import type {
  CommandReceipt,
  DeliveryAdmission,
  DeliveryIntent,
  ImmutableDelivery,
  TeamMember,
  TeamRuntimeDeliveryPort,
} from './contracts.js';
import type {
  PreparedTaskMutation,
  TaskBoardPolicy,
  TaskMutationPort,
  TeamStore,
} from './ports.js';

interface Retraction {
  intent: DeliveryIntent;
  proof?: DeliveryAdmission;
  /** Captured from the official Runtime fingerprint function when the proof is checked. */
  fingerprint?: string;
}
interface Obligations {
  fingerprint: string;
  deliveries: DeliveryIntent[];
  retractions: Retraction[];
}

/** Continuation of one canonical Task decision; no policy or notification is invoked on replay. */
export class TaskRecovery {
  private running: Promise<{ commandId: string; outcome: 'completed' | 'held' }[]> | undefined;

  constructor(
    private readonly store: TeamStore,
    private readonly mutations: TaskMutationPort,
    private readonly current: (receipt: CommandReceipt) => boolean,
    private readonly finish: (receipt: CommandReceipt) => void
  ) {}

  private key(receipt: CommandReceipt): string {
    return `task-obligations/${digest(receipt.commandId)}.json`;
  }

  private obligations(receipt: CommandReceipt): Obligations | undefined {
    const value = this.store.read<Obligations>(this.key(receipt));
    if (value && value.fingerprint !== receipt.fingerprint) throw new TeamOwnerError('hold');
    return value;
  }

  hasPlan(receipt: CommandReceipt): boolean {
    return !!this.mutations.load(receipt);
  }

  commit(
    receipt: CommandReceipt,
    actor: string,
    members: TeamMember[],
    apply: (board: TaskBoardPolicy) => JsonValue
  ): PreparedTaskMutation {
    if (!this.current(receipt)) throw new TeamOwnerError('hold');
    const plan = this.mutations.load(receipt) ?? this.mutations.prepare(receipt, actor, apply);
    let obligations = this.obligations(receipt);
    if (!obligations) {
      if (receipt.authorityRevision === undefined || !receipt.taskRecipients)
        throw new TeamOwnerError('hold');
      const deliveries: DeliveryIntent[] = [];
      for (const notification of plan.notifications) {
        const member = receipt.taskRecipients.find((entry) => entry.name === notification.member);
        // Saved/offline roster members have a product inbox, but no current native target.
        if (!member?.delivery) continue;
        const deliveryId = effectId(
          'task-notification',
          receipt.binding.backendId,
          receipt.binding.teamId,
          receipt.commandId,
          notification.messageId
        );
        deliveries.push({
          schemaVersion: 1,
          binding: structuredClone(member.delivery),
          commandId: receipt.commandId,
          principalId: receipt.principalId,
          messageId: notification.messageId,
          deliveryId,
          inputId: deliveryId,
          content: notification.content,
          authorityRevision: receipt.authorityRevision,
          phase: 'pending',
        });
      }
      obligations = {
        fingerprint: receipt.fingerprint,
        deliveries,
        retractions: this.store
          .list<DeliveryIntent>('outbox')
          .filter((intent) => plan.removedMessageIds.includes(intent.messageId))
          .map((intent) => ({ intent })),
      };
      this.store.write(this.key(receipt), obligations);
    }
    // A cancellation proof must be durable before any product file is published.
    if (obligations.retractions.some((entry) => !this.provenRetraction(entry)))
      throw new TeamOwnerError('hold');
    for (const intent of obligations.deliveries) {
      const member = members.find((entry) => entry.memberId === intent.binding.memberId);
      if (!member?.delivery || digest(member.delivery) !== digest(intent.binding))
        throw new TeamOwnerError('hold');
    }
    for (const { intent, proof } of obligations.retractions) {
      const prior = this.store.read<DeliveryIntent>(`outbox/${intent.deliveryId}.json`);
      if (
        !prior ||
        !proof?.receipt ||
        digest(deliveryIdentity(prior)) !== digest(deliveryIdentity(intent))
      )
        throw new TeamOwnerError('hold');
      this.store.write(`outbox/${prior.deliveryId}.json`, {
        ...prior,
        phase: proof.outcome === 'not_admitted' ? 'not_admitted' : 'admitted',
        runtimeReceipt: proof.receipt,
      });
    }
    if (!this.current(receipt)) throw new TeamOwnerError('hold');
    this.mutations.publish(receipt);
    for (const intent of obligations.deliveries) {
      const path = `outbox/${intent.deliveryId}.json`;
      const existing = this.store.read<DeliveryIntent>(path);
      if (existing && digest(deliveryIdentity(existing)) !== digest(deliveryIdentity(intent)))
        throw new TeamOwnerError('hold');
      if (!existing) this.store.write(path, intent);
    }
    return plan;
  }

  owns(intent: DeliveryIntent, receipt: CommandReceipt): boolean {
    const obligations = this.obligations(receipt);
    return !!obligations?.deliveries.some(
      (expected) =>
        digest(deliveryIdentity(expected)) === digest(deliveryIdentity(intent)) &&
        expected.principalId === intent.principalId &&
        expected.authorityRevision === intent.authorityRevision
    );
  }

  /** Called only under Team's fence, using an exact persisted input/outbox identity. */
  lookupTaskStartCause(intent: DeliveryIntent, receipt: CommandReceipt, mode: 'current' | 'historical' = 'current'): TaskStartCause | null {
    if (!isUserTaskStartIntent(receipt.command)) return null;
    const created = receipt.command.operation === 'task.create';
    if (receipt.phase !== 'completed' || (mode === 'current' && !this.current(receipt))) throw new TeamOwnerError('hold');
    const obligations = this.obligations(receipt);
    const plan = this.mutations.load(receipt);
    const matching = obligations?.deliveries.filter(
      (entry) =>
        digest(deliveryIdentity(entry)) === digest(deliveryIdentity(intent)) &&
        entry.commandId === receipt.commandId &&
        entry.principalId === receipt.principalId &&
        entry.authorityRevision === receipt.authorityRevision
    );
    if (!plan || !matching || matching.length !== 1 || !Array.isArray(plan.notifications))
      throw new TeamOwnerError('hold');
    const recipient = receipt.taskRecipients?.find(
      (entry) =>
        entry.delivery &&
        digest(deliveryIdentity({ ...intent, binding: entry.delivery })) ===
          digest(deliveryIdentity(intent))
    );
    const notifications = plan.notifications.filter(
      (entry) =>
        entry.member === recipient?.name &&
        entry.messageId === intent.messageId &&
        entry.content === intent.content
    );
    const result = plan.result;
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new TeamOwnerError('hold');
    const task = created ? result : result.task;
    if (
      !task ||
      typeof task !== 'object' ||
      Array.isArray(task) ||
      typeof task.id !== 'string' ||
      (!created && result.notifiedOwner !== true) ||
      (created && (task.id !== receipt.effects.taskId || task.status !== 'in_progress')) ||
      notifications.length !== 1 ||
      digest(receipt.result) !== digest(plan.result) ||
      receipt.taskHash !== plan.taskHash ||
      intent.messageId !== receipt.effects.messageId ||
      intent.inputId !== intent.deliveryId ||
      intent.deliveryId !==
        effectId(
          'task-notification',
          receipt.binding.backendId,
          receipt.binding.teamId,
          receipt.commandId,
          intent.messageId
        )
    )
      throw new TeamOwnerError('hold');
    safeSegment(task.id);
    return Object.freeze({
      taskId: task.id,
      taskStartCommandId: receipt.commandId,
      messageId: intent.messageId,
      deliveryId: intent.deliveryId,
      inputId: intent.inputId,
      binding: Object.freeze(deliveryIdentity(intent).binding),
    });
  }

  private provenRetraction(entry: Retraction): boolean {
    if (!entry.proof || !entry.fingerprint || !/^[a-f0-9]{64}$/.test(entry.fingerprint))
      return false;
    const outcome = classifyProof(entry.intent, entry.proof, {
      fingerprintDelivery: () => entry.fingerprint!,
    });
    return outcome === 'not_admitted' || (outcome === 'admitted' && settledRuntimeAdmission(entry.proof));
  }

  retracting(raw: ImmutableDelivery): boolean {
    return this.store
      .list<Obligations>('task-obligations')
      .some((obligations) =>
        obligations.retractions.some(
          ({ intent }) => digest(deliveryIdentity(intent)) === digest(deliveryIdentity(raw))
        )
      );
  }

  /** Cancellation is authorized by the current deleting Task principal, not a revoked prior sender. */
  authorizeRetraction(raw: ImmutableDelivery): boolean {
    return listProductCommandReceipts(this.store).some((receipt) => {
      if (['completed', 'rejected'].includes(receipt.phase)) return false;
      let matches = false;
      try {
        matches =
          this.obligations(receipt)?.retractions.some(
            ({ intent }) => digest(deliveryIdentity(intent)) === digest(deliveryIdentity(raw))
          ) ?? false;
      } catch {
        return false;
      }
      if (!matches || !this.current(receipt)) return false;
      if (this.hasPlan(receipt)) this.mutations.validate(receipt);
      return true;
    });
  }

  resume(
    runtime?: TeamRuntimeDeliveryPort
  ): Promise<{ commandId: string; outcome: 'completed' | 'held' }[]> {
    if (this.running) return this.running;
    this.running = this.run(runtime).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(
    runtime?: TeamRuntimeDeliveryPort
  ): Promise<{ commandId: string; outcome: 'completed' | 'held' }[]> {
    const receipts = this.store.fenced(() =>
      listProductCommandReceipts(this.store).filter(
        (receipt) =>
          receipt.command.operation !== 'message.send' &&
          !['completed', 'rejected'].includes(receipt.phase)
      )
    );
    const results: { commandId: string; outcome: 'completed' | 'held' }[] = [];
    for (const receipt of receipts) {
      try {
        const captured = this.store.fenced(() => {
          if (!this.current(receipt)) throw new TeamOwnerError('hold');
          if (this.hasPlan(receipt)) this.mutations.validate(receipt);
          return this.obligations(receipt);
        });
        for (const retraction of captured?.retractions ?? []) {
          if (this.provenRetraction(retraction)) continue;
          if (!runtime) throw new TeamOwnerError('hold');
          // Both calls stay outside Team's lock; Runtime uses the trusted synchronous authority callback.
          let response = await runtime.lookupDelivery(structuredClone(retraction.intent));
          let proof = classifyProof(retraction.intent, response, runtime);
          const settled = (): boolean =>
            proof === 'not_admitted' || (proof === 'admitted' && settledRuntimeAdmission(response));
          if (!settled()) {
            if (!runtime.cancelDelivery) throw new TeamOwnerError('hold');
            response = await runtime.cancelDelivery(structuredClone(retraction.intent));
            proof = classifyProof(retraction.intent, response, runtime);
          }
          if (!settled()) throw new TeamOwnerError('hold');
          this.store.fenced(() => {
            if (!this.current(receipt)) throw new TeamOwnerError('hold');
            const current = this.obligations(receipt);
            if (!current || digest(current) !== digest(captured)) throw new TeamOwnerError('hold');
            const target = current.retractions.find(
              (entry) => entry.intent.deliveryId === retraction.intent.deliveryId
            );
            if (!target || digest(target.intent) !== digest(retraction.intent))
              throw new TeamOwnerError('hold');
            target.proof = structuredClone(response);
            target.fingerprint = runtime.fingerprintDelivery(target.intent);
            this.store.write(this.key(receipt), current);
            // Maintain the captured revision for subsequent proofs in this same run.
            Object.assign(captured!, current);
          });
        }
        // finish enters the owner fence itself; never recursively acquire its file lock.
        this.finish(receipt);
        results.push({ commandId: receipt.commandId, outcome: 'completed' });
      } catch {
        results.push({ commandId: receipt.commandId, outcome: 'held' });
      }
    }
    return results;
  }
}
