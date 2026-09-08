import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

/** A lane and inbox identity survive relaunch; their runtime run does not. */
export function isOpenCodeDeliveryFromOtherRun(
  record: Pick<OpenCodePromptDeliveryLedgerRecord, 'runId'>,
  runId: string | null | undefined
): boolean {
  return Boolean(record.runId && runId && record.runId !== runId);
}

export function cancelOpenCodeDeliveryFromOtherRun(
  record: OpenCodePromptDeliveryLedgerRecord,
  now: string
): OpenCodePromptDeliveryLedgerRecord {
  if (record.cancelledAt) return record;
  const reason = 'opencode_prompt_delivery_run_superseded';
  return {
    ...record,
    status: 'failed_terminal',
    cancelledAt: now,
    failedAt: now,
    nextAttemptAt: null,
    lastReason: reason,
    diagnostics: [...new Set([...record.diagnostics, reason])],
    updatedAt: now,
  };
}
