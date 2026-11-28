import { TeamOwnerError } from '../team/contracts.js';
import { digest, safeSegment } from '../team/identity.js';
import { readProductCommand } from '../team/commandEntries.js';
import type { NativeMcpAuthorityProof } from '../team/NativeMcpAuthority.js';
import type { DeliveryIntent } from '../team/contracts.js';
import type { TeamStore } from '../team/ports.js';
/** Team-only projection of another sender's receipt, revalidated by the original input proof. */
export function readGroupInputSource(options: {
  store: TeamStore;
  proof: Readonly<NativeMcpAuthorityProof>;
  capture(raw: DeliveryIntent): Readonly<NativeMcpAuthorityProof>;
}) {
  const { proof } = options;
  const raw = options.store.read<DeliveryIntent>(
    `outbox/${safeSegment(proof.original.deliveryId)}.json`
  );
  if (!raw || digest(options.capture(raw)) !== digest(proof)) throw new TeamOwnerError('forbidden');
  if (!('messageCommandId' in proof.cause)) throw new TeamOwnerError('forbidden');
  const receipt = readProductCommand(options.store, proof.cause.messageCommandId);
  if (
    !receipt ||
    receipt.command.operation !== 'message.send' ||
    receipt.effects.messageId !== proof.original.messageId ||
    receipt.effects.deliveryId !== proof.original.deliveryId ||
    receipt.command.payload.to !== proof.memberName
  )
    throw new TeamOwnerError('forbidden');
  return Object.freeze({
    sourceMessageId: receipt.group?.message.groupMessageId ?? proof.original.messageId,
    ...(receipt.group
      ? {
          groupChatId: receipt.group.message.groupChatId,
          physicalMessageId: receipt.group.message.messageId,
        }
      : {}),
  });
}
