import { isOpenCodeDeliveryFromOtherRun } from '../opencode/delivery/OpenCodePromptDeliveryRunEligibility';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import type { InboxMessage } from '@shared/types';

type RunFenceOutcome = 'current' | 'stale' | 'superseded';

/** Run identity is shared by group rows in one relay pass; direct rows keep fresh lookups. */
export function createOpenCodeMemberInboxRunFence(input: {
  resolveCurrentRunId(): Promise<string | null>;
  isCurrent(): boolean;
  ledger: Pick<OpenCodePromptDeliveryLedgerStore, 'ensurePending'>;
  nowIso(): string;
}): {
  fenceExistingDelivery(
    message: Pick<InboxMessage, 'groupChatId'>,
    record: OpenCodePromptDeliveryLedgerRecord
  ): Promise<RunFenceOutcome>;
  checkGroupDelivery(
    message: Pick<InboxMessage, 'groupChatId' | 'groupRunKey'>
  ): Promise<RunFenceOutcome>;
} {
  let groupRunLookup: Promise<string | null> | null = null;
  const resolveGroupRun = (): Promise<string | null> => {
    groupRunLookup ??= input.resolveCurrentRunId().catch(() => null);
    return groupRunLookup;
  };

  return {
    async fenceExistingDelivery(message, record) {
      const currentRunId = message.groupChatId
        ? await resolveGroupRun()
        : await input.resolveCurrentRunId();
      if (!input.isCurrent()) return 'superseded';
      if (!isOpenCodeDeliveryFromOtherRun(record, currentRunId)) return 'current';
      // Persist the fence so due scans cannot repeatedly select this historical row.
      await input.ledger.ensurePending({ ...record, runId: currentRunId, now: input.nowIso() });
      return 'stale';
    },
    async checkGroupDelivery(message) {
      if (!message.groupChatId) return 'current';
      const currentRunId = await resolveGroupRun();
      if (!input.isCurrent()) return 'superseded';
      // Historical group envelopes remain owned by their original run.
      return currentRunId && message.groupRunKey === currentRunId ? 'current' : 'stale';
    },
  };
}
