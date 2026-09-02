/**
 * Cursor and coalescing policy for the OpenCode member inbox relay.
 *
 * The relay walks one member's unread inbox rows and decides, per row, whether
 * to deliver it, to skip ahead, or to stop. Everything that answers "which
 * other rows does this delivery cover, and where does the walk go next" lives
 * here, so the relay keeps only the I/O and the ledger bookkeeping.
 */

import type { RelayInboxMessage } from './TeamProvisioningInboxRelayPolicy';

/**
 * Index of the first unread user message after `afterIndex`, or -1. Only a
 * pending non-user delivery yields to a user message; a pending user delivery
 * keeps the inbox order (the next user message queues behind it).
 */
export function findNextUnreadUserMessageIndex(input: {
  unread: readonly RelayInboxMessage[];
  afterIndex: number;
  currentReplyRecipient: string;
}): number {
  if (input.currentReplyRecipient.trim().toLowerCase() === 'user') {
    return -1;
  }
  for (let index = input.afterIndex + 1; index < input.unread.length; index += 1) {
    const candidate = input.unread[index];
    if (candidate && !candidate.read && candidate.from.trim().toLowerCase() === 'user') {
      return index;
    }
  }
  return -1;
}
