import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeWorkSyncLaneDeliveryReason } from '@features/member-work-sync/main';

const RETIRE_REASONS: ReadonlySet<OpenCodeWorkSyncLaneDeliveryReason> = new Set([
  'work_sync_admission_stopped',
  'work_sync_ticket_stale',
]);

export function isNeverSentOpenCodeWorkSyncDelivery(
  record: Pick<OpenCodePromptDeliveryLedgerRecord, 'status' | 'acceptedAt' | 'attempts'>
): boolean {
  return record.status === 'pending' && record.acceptedAt == null && record.attempts === 0;
}

export async function retireNeverSentOpenCodeWorkSyncDelivery(input: {
  ledger?: OpenCodePromptDeliveryLedgerStore | null;
  record?: OpenCodePromptDeliveryLedgerRecord | null;
  reason: OpenCodeWorkSyncLaneDeliveryReason;
  nowIso: string;
}): Promise<void> {
  const { ledger, record, reason } = input;
  if (!ledger || !record || !RETIRE_REASONS.has(reason)) {
    return;
  }
  if (!isNeverSentOpenCodeWorkSyncDelivery(record)) {
    return;
  }
  await ledger.markFailedTerminal({
    id: record.id,
    reason,
    failedAt: input.nowIso,
  });
}
