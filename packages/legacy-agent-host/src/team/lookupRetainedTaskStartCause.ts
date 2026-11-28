import { TeamOwnerError } from './contracts.js';
import { readProductCommand } from './commandEntries.js';
import { deliveryIdentity } from './DeliveryRecovery.js';
import { digest, safeSegment } from './identity.js';
import type { TaskRecovery } from './TaskRecovery.js';
import type { TaskStartCause } from './TaskStartCause.js';
import type { DeliveryIntent, ImmutableDelivery } from './contracts.js';
import type { TeamStore } from './ports.js';

/** Read-only original execution provenance; caller holds current viewer read authority inside Team fence.
 * This never grants delivery admission or replays a retired Task notification. */
export function lookupRetainedTaskStartCause(options: {
  store: TeamStore;
  recovery: Pick<TaskRecovery, 'lookupTaskStartCause'>;
  raw: ImmutableDelivery;
}): TaskStartCause | null {
  const { raw, store, recovery } = options;
  safeSegment(raw.deliveryId);
  const original = store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
  if (!original) return null;
  if (
    original.phase === 'not_admitted' ||
    digest(deliveryIdentity(raw)) !== digest(deliveryIdentity(original))
  )
    throw new TeamOwnerError('forbidden');
  const receipt = readProductCommand(store, original.commandId);
  if (!receipt || receipt.phase !== 'completed') throw new TeamOwnerError('hold');
  return recovery.lookupTaskStartCause(original, receipt, 'historical');
}
