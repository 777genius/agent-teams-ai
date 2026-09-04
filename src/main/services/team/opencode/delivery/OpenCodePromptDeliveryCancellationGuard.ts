import { isOpenCodePromptDeliveryCancelled } from './OpenCodePromptDeliveryLedger';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';

export class OpenCodePromptDeliveryCancelledError extends Error {
  constructor(readonly record?: OpenCodePromptDeliveryLedgerRecord | null) {
    super('opencode_prompt_delivery_cancelled');
  }
}

export async function assertOpenCodePromptDeliveryNotCancelled(
  ledger: OpenCodePromptDeliveryLedgerStore | null | undefined,
  record: OpenCodePromptDeliveryLedgerRecord | null | undefined
): Promise<void> {
  if (!record) return;
  const current = ledger ? await ledger.getByInboxMessage(record) : record;
  if (isOpenCodePromptDeliveryCancelled(current ?? record)) {
    throw new OpenCodePromptDeliveryCancelledError(current ?? record);
  }
}
