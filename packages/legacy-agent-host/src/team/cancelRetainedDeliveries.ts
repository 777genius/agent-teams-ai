import { classifyProof } from './DeliveryRecovery.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import { settledRuntimeAdmission } from './settledRuntimeAdmission.js';
import type { DeliveryAdmission, DeliveryIntent, TeamRuntimeDeliveryPort } from './contracts.js';
import type { TeamStore } from './ports.js';

export interface RetainedDeliveryCancellation {
  intent: DeliveryIntent;
  proof?: DeliveryAdmission;
  fingerprint?: string;
}
/** Caller durably captures targets in its existing command receipt before using this continuation. */
export async function cancelRetainedDeliveries(options: {
  store: TeamStore;
  runtime: TeamRuntimeDeliveryPort;
  targets: readonly RetainedDeliveryCancellation[];
  /** Rechecks the original retained receipt, not a newly resolved recipient or current delivery grant. */
  assertRetained(target: RetainedDeliveryCancellation): void;
  /** Writes proof into that same original command receipt under Team's fence. */
  saveProof(target: RetainedDeliveryCancellation): void;
}): Promise<{ deliveryId: string; outcome: 'not-sent' | 'settled' | 'held' }[]> {
  const { store, runtime } = options;
  const results: { deliveryId: string; outcome: 'not-sent' | 'settled' | 'held' }[] = [];
  for (const original of options.targets) {
    try {
      const target = structuredClone(original);
      store.fenced(() => options.assertRetained(target));
      let proof = target.proof;
      if (proof && target.fingerprint !== runtime.fingerprintDelivery(target.intent)) throw new TeamOwnerError('hold');
      let outcome = proof ? classifyProof(target.intent, proof, runtime) : 'unknown';
      if (!proof || (outcome !== 'not_admitted' && !settledRuntimeAdmission(proof))) {
        // Always cancel the original input, including previously unseen IDs. Lookup-only absence
        // is not a tombstone and would allow a racing old outbox admission after restore.
        if (!runtime.cancelDelivery) throw new TeamOwnerError('hold');
        proof = await runtime.cancelDelivery(structuredClone(target.intent));
        outcome = classifyProof(target.intent, proof, runtime);
      }
      const knownNotSent = outcome === 'not_admitted';
      if (!knownNotSent && !settledRuntimeAdmission(proof)) throw new TeamOwnerError('hold');
      if (proof.receipt === undefined) throw new TeamOwnerError('hold');
      const receipt = structuredClone(proof.receipt);
      target.proof = structuredClone(proof);
      target.fingerprint = runtime.fingerprintDelivery(target.intent);
      store.fenced(() => {
        options.assertRetained(target);
        const current = store.read<DeliveryIntent>(`outbox/${target.intent.deliveryId}.json`);
        if (!current || digest({ ...current, phase: 'pending', runtimeReceipt: undefined }) !== digest({ ...target.intent, phase: 'pending', runtimeReceipt: undefined })) throw new TeamOwnerError('conflict');
        options.saveProof(target);
        // Retain the full input/content/history. Only the durable admission projection changes.
        store.write(`outbox/${current.deliveryId}.json`, { ...current,
          phase: knownNotSent ? 'not_admitted' : 'admitted', runtimeReceipt: receipt } satisfies DeliveryIntent);
      });
      results.push({ deliveryId: target.intent.deliveryId, outcome: knownNotSent ? 'not-sent' : 'settled' });
    } catch {
      results.push({ deliveryId: original.intent.deliveryId, outcome: 'held' });
    }
  }
  return results;
}
