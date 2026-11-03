import { isOpenCodeHumanGroupNonResponse } from './OpenCodeHumanGroupReply';
import { buildOpenCodePromptDeliveryAttemptId } from './OpenCodePromptDeliveryLedger';
import { hasOpenCodeAcceptedRuntimePrompt } from './OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodeMemberInboxDelivery } from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';

/** Persist before the bridge side effect; a crash never permits a second group send. */
export function markOpenCodeGroupHandoff(
  ledger: OpenCodePromptDeliveryLedgerStore,
  record: OpenCodePromptDeliveryLedgerRecord,
  now: string
) {
  return ledger.markNextAttemptScheduled({
    id: record.id,
    status: 'accepted',
    handoffDeliveryAttemptId: buildOpenCodePromptDeliveryAttemptId(record),
    nextAttemptAt: now,
    reason: isOpenCodeHumanGroupNonResponse(record)
      ? 'group_repair_handoff_acceptance_unknown'
      : 'group_handoff_started_acceptance_unknown',
    scheduledAt: now,
    ...(isOpenCodeHumanGroupNonResponse(record) ? { startGroupRepairHandoff: true as const } : {}),
  });
}

export function observedOpenCodeDelivery(
  record: OpenCodePromptDeliveryLedgerRecord,
  laneId: string
): OpenCodeMemberInboxDelivery {
  return {
    delivered: true,
    accepted: true,
    responsePending: false,
    responseState: record.responseState,
    ledgerStatus: record.status,
    ledgerRecordId: record.id,
    laneId,
    visibleReplyMessageId: record.visibleReplyMessageId ?? undefined,
    visibleReplyCorrelation: record.visibleReplyCorrelation ?? undefined,
    diagnostics: record.diagnostics,
  };
}

/** Call only after checking exact destination proof. No marker proves acceptance. */
export function unknownGroupHandoffSnapshot(
  record: OpenCodePromptDeliveryLedgerRecord,
  laneId: string
): OpenCodeMemberInboxDelivery | null {
  if (
    !record.groupChatId ||
    record.status === 'failed_terminal' ||
    (record.status === 'retry_scheduled' &&
      record.promptNotSubmitted === true &&
      !record.acceptanceUnknown &&
      !record.groupRepairHandoffPending) ||
    (!record.groupRepairHandoffPending &&
      (record.status === 'pending' || hasOpenCodeAcceptedRuntimePrompt(record)))
  )
    return null;
  return {
    delivered: false,
    accepted: false,
    acceptanceUnknown: true,
    responsePending: true,
    ledgerStatus: record.status,
    ledgerRecordId: record.id,
    laneId,
    reason: 'group_handoff_acceptance_unknown',
    diagnostics: record.diagnostics,
  };
}

/** An unknown submission remains fenced even after automatic observation ends. */
export async function settleUnconfirmedGroupDelivery(
  ledger: OpenCodePromptDeliveryLedgerStore,
  record: OpenCodePromptDeliveryLedgerRecord,
  snapshot: OpenCodeMemberInboxDelivery | null,
  observed: { ok: boolean; diagnostics: string[] },
  ageMs: number | null
): Promise<OpenCodeMemberInboxDelivery | null> {
  if (
    !snapshot ||
    observed.ok ||
    ageMs === null ||
    ageMs < 60_000 ||
    !observed.diagnostics.some((diagnostic) => /\boriginal_input_unknown\b/.test(diagnostic))
  )
    return null;
  const settled = await ledger.markFailedTerminal({
    id: record.id,
    reason: 'group_delivery_unconfirmed',
    diagnostics: observed.diagnostics,
    failedAt: new Date().toISOString(),
  });
  return {
    ...snapshot,
    responsePending: false,
    ledgerStatus: settled.status,
    reason: 'group_delivery_unconfirmed',
    diagnostics: settled.diagnostics,
  };
}

export function terminalOpenCodeDelivery(
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord,
  laneId: string
): OpenCodeMemberInboxDelivery {
  return {
    delivered: false,
    accepted: false,
    responsePending: false,
    responseState: ledgerRecord.responseState,
    ledgerStatus: ledgerRecord.status,
    ledgerRecordId: ledgerRecord.id,
    laneId,
    reason: ledgerRecord.lastReason ?? 'opencode_prompt_delivery_failed_terminal',
    diagnostics: ledgerRecord.diagnostics,
  };
}
