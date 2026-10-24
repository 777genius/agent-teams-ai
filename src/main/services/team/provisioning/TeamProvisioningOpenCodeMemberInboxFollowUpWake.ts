import {
  DEFAULT_INBOX_RELAY_BATCH_SIZE,
  hasStableInboxMessageId,
  type RelayInboxMessage,
  selectOpenCodeInboxRelayBatch,
} from './TeamProvisioningInboxRelayPolicy';

import type {
  OpenCodeMemberIdentityResolution,
  OpenCodeMemberInboxDelivery,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerStore } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage } from '@shared/types';

export interface OpenCodeMemberInboxFollowUpWakePorts {
  scheduleOpenCodeMemberInboxDeliveryWake(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs: number;
    isCurrent?: () => boolean;
  }): void;
  resolveOpenCodeMemberDeliveryIdentity(
    teamName: string,
    memberName: string
  ): Promise<OpenCodeMemberIdentityResolution>;
  createOpenCodePromptDeliveryLedger(
    teamName: string,
    laneId: string
  ): OpenCodePromptDeliveryLedgerStore;
}

export function selectOpenCodeMemberInboxRelayUnreadMessages(input: {
  inboxMessages: readonly InboxMessage[];
  onlyMessageId?: string;
  maxRelay?: number;
}): RelayInboxMessage[] {
  const onlyMessageId = input.onlyMessageId?.trim();
  return selectOpenCodeInboxRelayBatch(
    input.inboxMessages.filter((message): message is RelayInboxMessage => {
      if (onlyMessageId && message.messageId !== onlyMessageId) return false;
      if (message.read && (!onlyMessageId || message.messageKind !== 'member_work_sync_nudge')) {
        return false;
      }
      if (typeof message.text !== 'string' || message.text.trim().length === 0) return false;
      return hasStableInboxMessageId(message);
    }),
    input.maxRelay ?? DEFAULT_INBOX_RELAY_BATCH_SIZE
  );
}

/**
 * Wakes are what chain: every wake runs a pass scoped to one row, and that pass
 * may arm the next wake. A woken pass whose row only queued behind another
 * row's live delivery, or was refused before any delivery record existed, left
 * the lane exactly as it found it - the next pass sees the same durable state
 * and fails the same way. Arming from it made two such rows wake each other
 * every 500ms for as long as the blocker lasted. The blocker settling, or the
 * runtime checking back in, runs a pass of its own, and that pass arms the
 * backlog.
 */
export function isOpenCodeInboxFollowUpWakeStalled(
  lastDelivery: OpenCodeMemberInboxDelivery | undefined
): boolean {
  if (!lastDelivery) return false;
  if (lastDelivery.queuedBehindMessageId) return true;
  return !lastDelivery.delivered && !lastDelivery.ledgerRecordId;
}

// A walk delivers at most one message and stops; unexamined rows are picked up
// only when some later inbox write re-fires the watcher. Arm the next pass for
// the first leftover row so the backlog drains even when no further write comes.
export async function armOpenCodeInboxFollowUpWake(input: {
  teamName: string;
  memberName: string;
  inboxMessages: readonly InboxMessage[];
  handledMessageIds: ReadonlySet<string>;
  /** The row a scoped (woken) pass was run for; absent for a full walk. */
  wokenMessageId?: string;
  lastDelivery?: OpenCodeMemberInboxDelivery;
  ports: OpenCodeMemberInboxFollowUpWakePorts;
}): Promise<void> {
  if (input.wokenMessageId && isOpenCodeInboxFollowUpWakeStalled(input.lastDelivery)) return;
  const candidates = selectOpenCodeMemberInboxRelayUnreadMessages({
    inboxMessages: input.inboxMessages,
    maxRelay: input.inboxMessages.length,
  }).filter((message) => !input.handledMessageIds.has(message.messageId));
  if (candidates.length === 0) return;
  const hasDeliveryRecord = await readOpenCodeInboxFollowUpHasRecord({
    teamName: input.teamName,
    memberName: input.memberName,
    ports: input.ports,
  });
  for (const candidate of candidates) {
    // A row a delivery record already owns belongs to the retry machinery; only
    // a row nothing owns yet needs a fresh wake.
    if (await hasDeliveryRecord(candidate.messageId)) {
      continue;
    }
    // Unscoped and generation-free on purpose: the wake belongs to the row, not
    // to the pass that noticed it, and must outlive that pass's revocation.
    input.ports.scheduleOpenCodeMemberInboxDeliveryWake({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: candidate.messageId,
      delayMs: 500,
    });
    return;
  }
}

async function readOpenCodeInboxFollowUpHasRecord(input: {
  teamName: string;
  memberName: string;
  ports: OpenCodeMemberInboxFollowUpWakePorts;
}): Promise<(inboxMessageId: string) => Promise<boolean>> {
  try {
    const memberIdentity = await input.ports.resolveOpenCodeMemberDeliveryIdentity(
      input.teamName,
      input.memberName
    );
    if (!memberIdentity.ok) {
      throw new Error(memberIdentity.reason);
    }
    const { canonicalMemberName, laneId } = memberIdentity;
    const ledger = input.ports.createOpenCodePromptDeliveryLedger(input.teamName, laneId);
    return async (inboxMessageId) =>
      Boolean(
        await ledger
          .getByInboxMessage({
            teamName: input.teamName,
            memberName: canonicalMemberName,
            laneId,
            inboxMessageId,
          })
          .catch(() => null)
      );
  } catch {
    // Ownership cannot be proven; every leftover row stays wake-worthy and the
    // woken pass makes the authoritative decision.
    return async () => false;
  }
}
