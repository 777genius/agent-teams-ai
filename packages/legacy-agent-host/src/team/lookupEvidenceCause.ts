import { TeamOwnerError } from './contracts.js';
import { readProductCommand } from './commandEntries.js';
import { deliveryIdentity, memberBinding } from './DeliveryRecovery.js';
import { digest, safeSegment } from './identity.js';
import type { TaskRecovery } from './TaskRecovery.js';
import type { TaskStartCause } from './TaskStartCause.js';
import type { DeliveryIntent, ImmutableDelivery, RuntimeMemberBinding } from './contracts.js';
import type { TeamStore } from './ports.js';

export interface MessageInputCause {
  readonly messageCommandId: string;
  readonly messageId: string;
  readonly deliveryId: string;
  readonly inputId: string;
  readonly binding: Readonly<RuntimeMemberBinding>;
}
export type ToolInputCause = TaskStartCause | MessageInputCause;

/** Runs under the existing Team fence; current outbox authority is checked before provenance. */
export function lookupEvidenceCause(options: {
  store: TeamStore;
  recovery: TaskRecovery;
  raw: ImmutableDelivery;
  authorize(): void;
  deliveryAuthorized(intent: DeliveryIntent): boolean;
}): ToolInputCause | null {
  const { raw, store, recovery } = options;
  options.authorize();
  safeSegment(raw.deliveryId);
  const intent = store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
  if (!intent) return null;
  if (
    intent.phase === 'not_admitted' ||
    recovery.retracting(raw) ||
    digest(deliveryIdentity(raw)) !== digest(deliveryIdentity(intent)) ||
    !options.deliveryAuthorized(intent)
  )
    throw new TeamOwnerError('forbidden');
  const receipt = readProductCommand(store, intent.commandId);
  if (!receipt) throw new TeamOwnerError('hold');
  if (receipt.command.operation !== 'message.send')
    return recovery.lookupTaskStartCause(intent, receipt);
  // deliveryAuthorized has proved canonical message bytes, actor grant revision and captured recipient.
  if (
    receipt.phase !== 'completed' ||
    receipt.effects.messageId !== intent.messageId ||
    receipt.effects.deliveryId !== intent.deliveryId ||
    receipt.principalId !== intent.principalId
  )
    throw new TeamOwnerError('hold');
  return Object.freeze({
    messageCommandId: receipt.commandId,
    messageId: intent.messageId,
    deliveryId: intent.deliveryId,
    inputId: intent.inputId,
    binding: Object.freeze(memberBinding(intent.binding)),
  });
}
