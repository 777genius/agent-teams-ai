import { isOpenCodePromptDeliveryCancelled } from './OpenCodePromptDeliveryLedger';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

export type OpenCodeGroupAcknowledgementReader = (input: {
  teamName: string;
  groupChatId: string;
  memberName: string;
  inboxMessageId: string;
  runId: string;
}) => Promise<boolean>;

/** Stored proof consumes only a known accepted delivery from this exact run. */
export async function hasOpenCodeGroupAcknowledgement(input: {
  teamName?: string;
  memberName?: string;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  hasAcknowledgedInbound?: OpenCodeGroupAcknowledgementReader;
}): Promise<boolean> {
  const record = input.ledgerRecord;
  if (
    !record?.groupChatId ||
    !record.runId ||
    !record.inboxMessageId ||
    !record.acceptedAt ||
    record.acceptanceUnknown ||
    isOpenCodePromptDeliveryCancelled(record) ||
    record.teamName !== input.teamName ||
    record.memberName !== input.memberName ||
    record.memberName.trim().toLowerCase() === 'user' ||
    !input.hasAcknowledgedInbound
  )
    return false;
  try {
    return (
      (await input.hasAcknowledgedInbound({
        teamName: record.teamName,
        memberName: record.memberName,
        groupChatId: record.groupChatId,
        inboxMessageId: record.inboxMessageId,
        runId: record.runId,
      })) === true
    );
  } catch {
    // Storage failures never consume an inbound or suppress its reply fallback.
    return false;
  }
}
