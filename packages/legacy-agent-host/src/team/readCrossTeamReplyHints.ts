import { readProductCommand } from './commandEntries.js';
import { TeamOwnerError } from './contracts.js';
import { deliveryIdentity } from './DeliveryRecovery.js';
import { digest, safeSegment } from './identity.js';
import type { TeamStore } from './ports.js';
import type { DeliveryIntent, ImmutableDelivery } from './contracts.js';

/** Active identities come only from captured Runtime, never the model/UI. */
export function readCrossTeamReplyHints(options: {
  store: TeamStore;
  active: readonly ImmutableDelivery[];
  authorizeOriginal(raw: ImmutableDelivery): boolean;
}): { toTeam: string; conversationId: string }[] {
  if (options.active.length > 256) throw new TeamOwnerError('hold');
  return options.active.flatMap((raw) => {
    safeSegment(raw.deliveryId);
    const intent = options.store.read<DeliveryIntent>(`outbox/${raw.deliveryId}.json`);
    if (!intent || digest(deliveryIdentity(intent)) !== digest(deliveryIdentity(raw)))
      throw new TeamOwnerError('hold');
    const receipt = readProductCommand(options.store, intent.commandId);
    if (!receipt?.crossTeam) return [];
    if (receipt.phase !== 'completed' || !options.authorizeOriginal(raw))
      throw new TeamOwnerError('hold');
    return [
      {
        toTeam: receipt.crossTeam.pair.source.teamId,
        conversationId: receipt.crossTeam.request.conversationId,
      },
    ];
  });
}
