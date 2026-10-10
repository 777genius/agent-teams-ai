import { hasOpenCodeAcceptedRuntimePrompt } from './OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodeMemberInboxDelivery } from './OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord, OpenCodePromptDeliveryLedgerStore } from './OpenCodePromptDeliveryLedger';

/** Persist before the bridge side effect; a crash never permits a second group send. */
export function markOpenCodeGroupHandoff(
  ledger: OpenCodePromptDeliveryLedgerStore, record: OpenCodePromptDeliveryLedgerRecord, now: string
) {
  return ledger.markNextAttemptScheduled({ id: record.id, status: 'accepted',
    nextAttemptAt: now, reason: 'group_handoff_started_acceptance_unknown', scheduledAt: now });
}

export function observedOpenCodeDelivery(
  record: OpenCodePromptDeliveryLedgerRecord, laneId: string
): OpenCodeMemberInboxDelivery {
  return {
    delivered: true, accepted: true, responsePending: false,
    responseState: record.responseState, ledgerStatus: record.status,
    ledgerRecordId: record.id, laneId,
    visibleReplyMessageId: record.visibleReplyMessageId ?? undefined,
    visibleReplyCorrelation: record.visibleReplyCorrelation ?? undefined,
    diagnostics: record.diagnostics,
  };
}

/** Call only after checking exact destination proof. No marker proves acceptance. */
export function unknownGroupHandoffSnapshot(
  record: OpenCodePromptDeliveryLedgerRecord, laneId: string
): OpenCodeMemberInboxDelivery | null {
  if (!record.groupChatId || record.status === 'pending' || hasOpenCodeAcceptedRuntimePrompt(record))
    return null;
  return {
    delivered: false, accepted: false, acceptanceUnknown: true, responsePending: true,
    ledgerStatus: record.status, ledgerRecordId: record.id, laneId,
    reason: 'group_handoff_acceptance_unknown', diagnostics: record.diagnostics,
  };
}
