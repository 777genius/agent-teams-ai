import { settledRuntimeInput } from '../runtime/settledRuntimeInput.js';
import { cancelRetainedDeliveries } from './cancelRetainedDeliveries.js';
import { classifyProof } from './DeliveryRecovery.js';
import { settledRuntimeAdmission } from './settledRuntimeAdmission.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import type { TeamLifecycleTransitions } from './TeamLifecycleTransitions.js';
import type { TeamRuntimeDeliveryPort } from './contracts.js';
import type { TeamStore } from './ports.js';
import type { RuntimeOwner } from '../runtime/RuntimeOwner.js';

/** Finite continuation of the original trash receipt; stop failure never rolls back the product tombstone. */
export async function continueTeamLifecycleCleanup(options: {
  commandId: string;
  lifecycle: TeamLifecycleTransitions;
  store: TeamStore;
  runtime: Pick<RuntimeOwner, 'stopCapturedSession' | 'readCapturedSession'>;
  delivery: TeamRuntimeDeliveryPort;
}): Promise<{ cleanupPending: boolean }> {
  const { commandId, lifecycle, store, runtime, delivery } = options;
  const captured = lifecycle.capturedCleanup(commandId);
  // Invocations synchronously seal every exact original record before the first await.
  let stopsCompleted = captured.runtimeBindings.length === 0;
  const stopping = Promise.allSettled(captured.runtimeBindings.map(binding => runtime.stopCapturedSession(binding)))
    .then(results => { stopsCompleted = results.every(result => result.status === 'fulfilled'); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([stopping, new Promise<void>(resolve => { timer = setTimeout(resolve, 5000); timer.unref(); })]);
  } finally { if (timer) clearTimeout(timer); }
  await cancelRetainedDeliveries({ store, runtime: delivery, targets: captured.targets,
    assertRetained(target) {
      const original = lifecycle.capturedCleanup(commandId);
      if (!original.targets.some(row => digest(row.intent) === digest(target.intent))) throw new TeamOwnerError('hold');
    },
    saveProof: target => lifecycle.saveCancellation(commandId, target),
  });
  try {
    lifecycle.settleCleanup(commandId, receipt => {
      if (!stopsCompleted) throw new TeamOwnerError('hold');
      // Fresh custody observation under the Team fence; old stop return values are insufficient.
      for (const binding of receipt.runtimeBindings) {
        const current = runtime.readCapturedSession(binding);
        if (!current.record || digest(current.record.binding) !== digest(binding) || current.attached ||
          current.record.phase !== 'closed' || current.record.custody !== 'released' ||
          current.record.inputs.some(input => !settledRuntimeInput(input)) ||
          current.record.interactions.some(interaction => interaction.phase !== 'resolved')) throw new TeamOwnerError('hold');
      }
      for (const target of receipt.targets) {
        if (!target.proof || target.fingerprint !== delivery.fingerprintDelivery(target.intent)) throw new TeamOwnerError('hold');
        const outcome = classifyProof(target.intent, target.proof, delivery);
        if (outcome !== 'not_admitted' && !settledRuntimeAdmission(target.proof)) throw new TeamOwnerError('hold');
      }
    });
    return { cleanupPending: false };
  } catch { return { cleanupPending: true }; }
}
