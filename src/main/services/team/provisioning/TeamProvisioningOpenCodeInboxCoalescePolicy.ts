/**
 * Cursor and coalescing policy for the OpenCode member inbox relay.
 *
 * The relay walks one member's unread inbox rows and decides, per row, whether
 * to deliver it, to skip ahead, or to stop. Everything that answers "which
 * other rows does this delivery cover, and where does the walk go next" lives
 * here, so the relay keeps only the I/O and the ledger bookkeeping.
 *
 * The relay owns `resolveOpenCodeMemberInboxDeliveryDecision`, so this module
 * takes the reply contract of a candidate row as a port instead of importing
 * it back: the dependency stays one-way and the policy stays testable without
 * the relay's ledger and delivery ports.
 */

import { isOpenCodeReplyOptionalDeliveryContract } from '../opencode/delivery/OpenCodeDeliveryReplyContract';
import { hasOpenCodeAcceptedRuntimePrompt } from '../opencode/delivery/OpenCodePromptDeliveryReadCommitPolicy';
import {
  OPENCODE_COALESCE_DEFERRED_DIAGNOSTIC,
  OPENCODE_COALESCE_NOT_DISPATCHED_DIAGNOSTIC,
} from '../opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics';

import type { OpenCodeMemberInboxDelivery } from '../opencode/delivery/OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { RelayInboxMessage } from './TeamProvisioningInboxRelayPolicy';
import type { InboxMessageKind } from '@shared/types';

/**
 * How many queued notices may ride along with one anchor delivery.
 *
 * This is prompt protection, not throughput tuning: the coalesced block is
 * appended to a prompt the model has to read in full, and a lead that has been
 * idle for a while can have far more than this queued. Everything past the
 * limit simply becomes the anchor of the next relay pass.
 */
export const OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT = 8;

/**
 * Message kinds that may be coalesced, as anchor or as rider. Every other kind
 * carries its own delivery contract (a work-sync nudge expects a report, a
 * slash command expects a result, a recovery nudge is idempotency-keyed), so
 * folding one into somebody else's prompt would drop that contract.
 */
export const COALESCABLE_MESSAGE_KINDS: ReadonlySet<InboxMessageKind> = new Set<InboxMessageKind>([
  'default',
  'task_comment_notification',
]);

export function isCoalescableNoticeKind(message: RelayInboxMessage): boolean {
  return !message.messageKind || COALESCABLE_MESSAGE_KINDS.has(message.messageKind);
}

export interface OpenCodeReplyOptionalCoalescePorts {
  /**
   * Reply recipient the relay would resolve for this row if it were delivered
   * on its own. A rider must be reply-optional under its own contract, not
   * under the anchor's.
   */
  resolveReplyRecipient(message: RelayInboxMessage): string;
  /**
   * True when the row already has a prompt-delivery ledger record. Such a row
   * is mid-flight (or terminal) in its own right and must keep its own record;
   * folding it into another prompt would leave that record dangling.
   */
  hasExistingRecord(message: RelayInboxMessage): Promise<boolean>;
}

/**
 * Reply-optional notices queued directly behind the message at `index` (in
 * inbox order, stopping at the first message that is not reply-optional, is an
 * automated nudge, or already has a ledger record). They are delivered in the
 * same prompt and marked read once that prompt is accepted.
 *
 * Ordering matters: the walk stops at the first candidate that fails, it never
 * skips one. A reply-required message behind a notice therefore ends the run
 * and stays unread, so it still gets its own prompt and its own reply contract.
 */
export async function selectOpenCodeReplyOptionalCoalescedFollowers(input: {
  unread: readonly RelayInboxMessage[];
  index: number;
  anchorReplyRecipient: string;
  ports: OpenCodeReplyOptionalCoalescePorts;
}): Promise<RelayInboxMessage[]> {
  const anchor = input.unread[input.index];
  if (
    !anchor ||
    !isCoalescableNoticeKind(anchor) ||
    !isOpenCodeReplyOptionalDeliveryContract(input.anchorReplyRecipient)
  ) {
    return [];
  }
  const followers: RelayInboxMessage[] = [];
  for (let cursor = input.index + 1; cursor < input.unread.length; cursor += 1) {
    if (followers.length >= OPENCODE_REPLY_OPTIONAL_COALESCE_LIMIT) break;
    const candidate = input.unread[cursor];
    if (!candidate || candidate.read || !isCoalescableNoticeKind(candidate)) break;
    if (typeof candidate.text !== 'string' || candidate.text.trim().length === 0) break;
    if (!isOpenCodeReplyOptionalDeliveryContract(input.ports.resolveReplyRecipient(candidate))) {
      break;
    }
    if (await input.ports.hasExistingRecord(candidate)) break;
    followers.push(candidate);
  }
  return followers;
}

/**
 * The riders as one tagged block, appended to the anchor's prompt body by the
 * delivery service. The wrapper tells the runtime that everything inside
 * arrived after the anchor and needs no reply either, so the turn answers the
 * batch at most once instead of once per notice.
 *
 * The block deliberately excludes the anchor text: it travels as its own
 * delivery field so the ledger payload hash keeps identifying the inbox row.
 */
export function buildOpenCodeCoalescedNoticeText(followers: readonly RelayInboxMessage[]): string {
  const lines = [
    `<opencode_coalesced_notices count="${followers.length}">`,
    `${followers.length} further informational notice(s) arrived after the message above and are delivered together with it. They need no reply either; treat everything here as one update and act at most once.`,
  ];
  followers.forEach((follower, position) => {
    const sender =
      typeof follower.from === 'string' && follower.from.trim() ? follower.from.trim() : 'system';
    lines.push(
      `--- notice ${position + 1} (from ${sender}, messageId ${follower.messageId}${
        follower.timestamp ? `, ${follower.timestamp}` : ''
      }) ---`,
      follower.text
    );
  });
  lines.push('</opencode_coalesced_notices>');
  return lines.join('\n');
}

/**
 * A rider may only be folded into an anchor whose prompt body is still going to
 * be dispatched. Once the runtime has accepted the anchor's prompt, this call
 * can only observe it, so a rider added now would be marked read without ever
 * reaching the model. The same holds for a record whose inbox read is already
 * committed, and for terminal records, which are not going to send anything.
 */
export function canCoalesceNoticesIntoOpenCodeDelivery(
  existingRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  if (!existingRecord) {
    return true;
  }
  if (existingRecord.inboxReadCommittedAt) {
    return false;
  }
  if (hasOpenCodeAcceptedRuntimePrompt(existingRecord)) {
    return false;
  }
  return (
    existingRecord.status === 'pending' ||
    existingRecord.status === 'retry_scheduled' ||
    existingRecord.status === 'failed_retryable'
  );
}

/**
 * Read-commit riders ONLY on positive proof that this call dispatched a prompt
 * that contained them and the runtime accepted it. `delivered: true` is not that
 * proof: several delivery paths return it without sending anything (queued
 * behind another record, observation-only passes, a response that was already
 * sufficient).
 */
export function isOpenCodeCoalescedNoticeDeliveryProven(
  delivery: Pick<OpenCodeMemberInboxDelivery, 'coalescedNoticesDelivered'>
): boolean {
  return delivery.coalescedNoticesDelivered === true;
}

export function buildOpenCodeCoalesceDeferredDiagnostic(input: {
  anchorMessageId: string;
  deferredMessageId?: string;
  record?: OpenCodePromptDeliveryLedgerRecord | null;
}): string {
  return (
    `${OPENCODE_COALESCE_DEFERRED_DIAGNOSTIC}: ${input.anchorMessageId} ` +
    `(status=${input.record?.status ?? 'none'}, acceptedAt=${input.record?.acceptedAt ?? 'none'}, ` +
    `attempts=${input.record?.attempts ?? 0}); deferred=${input.deferredMessageId ?? 'none'}`
  );
}

export function buildOpenCodeCoalesceNotDispatchedDiagnostic(input: {
  anchorMessageId: string;
  deferredMessageIds: readonly string[];
  delivery: Pick<
    OpenCodeMemberInboxDelivery,
    'delivered' | 'accepted' | 'responsePending' | 'ledgerStatus'
  >;
}): string {
  return (
    `${OPENCODE_COALESCE_NOT_DISPATCHED_DIAGNOSTIC}: ${input.anchorMessageId} -> ` +
    `${input.deferredMessageIds.join(',')} (delivered=${input.delivery.delivered}, ` +
    `accepted=${input.delivery.accepted ?? 'unknown'}, ` +
    `responsePending=${input.delivery.responsePending ?? false}, ` +
    `ledgerStatus=${input.delivery.ledgerStatus ?? 'none'})`
  );
}

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
