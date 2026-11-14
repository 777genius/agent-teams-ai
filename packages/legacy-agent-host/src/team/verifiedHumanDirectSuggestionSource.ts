import { digest } from './identity.js';
import { memberBinding } from './DeliveryRecovery.js';

import type { JsonValue } from '../contracts.js';
import type {
  CommandReceipt,
  DeliveryIntent,
  TeamGrant,
  TeamMember,
} from './contracts.js';

/**
 * Original Team product facts, not UI identity, determine whether the
 * completed native turn was a human-authored one-to-one message.
 * This pure check cannot grant authority; caller must first validate the
 * canonical outbox/command, original delivery and current permission fence.
 */
export function verifiedHumanDirectSuggestionSource(input: {
  readonly intent: DeliveryIntent;
  readonly receipt: CommandReceipt | undefined;
  readonly grant: TeamGrant;
  readonly members: readonly TeamMember[];
  readonly inbox: readonly JsonValue[];
}): { readonly memberId: string; readonly messageId: string } | null {
  const { intent, receipt, grant } = input;
  if (
    !receipt ||
    receipt.command.operation !== 'message.send' ||
    receipt.phase !== 'completed' ||
    receipt.group !== undefined ||
    receipt.crossTeam !== undefined ||
    receipt.principalId !== intent.principalId ||
    receipt.effects.deliveryId !== intent.deliveryId ||
    receipt.effects.messageId !== intent.messageId ||
    receipt.deliveryBinding === undefined ||
    digest(memberBinding(receipt.deliveryBinding)) !==
      digest(memberBinding(intent.binding)) ||
    grant.memberName !== 'user' ||
    grant.revoked === true ||
    !grant.permissions.includes('read') ||
    !grant.permissions.includes('message.write')
  ) return null;

  const member = input.members.find(
    (candidate) =>
      candidate.delivery !== undefined &&
      digest(memberBinding(candidate.delivery)) === digest(memberBinding(intent.binding))
  );
  if (
    !member ||
    member.name !== receipt.command.payload.to ||
    member.memberId !== intent.binding.memberId
  ) return null;

  // A matching messageId is not enough: group and cross-team records also
  // carry message IDs. Require the actual saved direct human inbox row.
  const rows = input.inbox.filter((value) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const row = value as Record<string, JsonValue>;
    return row.messageId === intent.messageId;
  });
  if (rows.length !== 1) return null;
  const row = rows[0] as Record<string, JsonValue>;
  if (
    row.from !== 'user' ||
    row.to !== member.name ||
    row.text !== receipt.command.payload.text ||
    row.timestamp !== receipt.createdAt ||
    row.groupChatId !== undefined ||
    row.groupMessageId !== undefined ||
    row.crossTeamMessageId !== undefined
  ) return null;

  return Object.freeze({ memberId: member.memberId, messageId: intent.messageId });
}
