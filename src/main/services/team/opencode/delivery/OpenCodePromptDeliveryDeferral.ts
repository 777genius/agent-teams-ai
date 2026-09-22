import { createLogger } from '@shared/utils/logger';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';

const logger = createLogger('Service:OpenCodePromptDeliveryDeferral');

/**
 * Push a delivery record's own deadline out without changing anything else
 * about it.
 *
 * A postponed dispatch is not an attempt and not a state change: the prompt
 * never left, so `status`, `attempts`, `lastReason` and every observation field
 * must survive it untouched. The deadline still has to move, because it is the
 * durable half of the wake schedule - a record left holding a deadline in the
 * past is re-armed by every pass that looks for due work, which replaces the
 * backoff the postponement asked for with an immediate wake, and the same
 * refusal is then re-decided in a tight loop.
 *
 * A ledger write failure degrades to "not deferred" rather than to a delivery
 * failure: the caller decided to keep this record alive, and losing the
 * deadline write costs an extra observe pass, while turning it into an error
 * would cost the record. It is still reported, because the record that comes
 * back looks exactly like a successful postponement and the lane-scoped ledger
 * is deleted when the team stops - so an unreported failure here is a tight
 * re-decide loop with nothing left to explain it.
 */
export async function deferOpenCodePromptDeliveryAttempt(input: {
  ledger: Pick<OpenCodePromptDeliveryLedgerStore, 'markNextAttemptDeferred'>;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  delayMs: number;
  nowMs?: number;
}): Promise<OpenCodePromptDeliveryLedgerRecord> {
  const nowMs = input.nowMs ?? Date.now();
  try {
    return await input.ledger.markNextAttemptDeferred({
      id: input.ledgerRecord.id,
      nextAttemptAt: new Date(nowMs + Math.max(0, input.delayMs)).toISOString(),
      deferredAt: new Date(nowMs).toISOString(),
    });
  } catch (error) {
    logger.error(
      `[${input.ledgerRecord.teamName}] opencode_prompt_delivery_defer_failed ` +
        `${input.ledgerRecord.memberName}/${input.ledgerRecord.laneId} ` +
        `msg=${input.ledgerRecord.inboxMessageId} delayMs=${Math.max(0, input.delayMs)}`,
      error
    );
    return input.ledgerRecord;
  }
}
