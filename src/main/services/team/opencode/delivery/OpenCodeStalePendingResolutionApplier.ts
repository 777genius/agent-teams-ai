import {
  buildOpenCodeStalePendingPlainTextObservation,
} from './OpenCodePromptDeliveryStalePendingPolicy';

import type {
  OpenCodeLeadTurnActivityNotification,
  OpenCodeMemberMessageDeliveryServiceDependencies,
} from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeStalePendingResolution } from './OpenCodePromptDeliveryStalePendingPolicy';

interface ApplyOpenCodeStalePendingResolutionInput {
  checkpoint: () => Promise<void>;
  ledger: OpenCodePromptDeliveryLedgerStore;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  resolution: OpenCodeStalePendingResolution;
  teamName: string;
  memberName: string;
  notifyActivity: (state: OpenCodeLeadTurnActivityNotification['state']) => void;
  eventContext: Record<string, unknown>;
}

/**
 * Settle or terminate a stale pending delivery without changing lane ownership
 * or the caller's checkpoint ordering. Returns null when no ledger mutation is
 * required and regular observation should continue.
 */
export async function applyOpenCodeStalePendingResolution(
  deps: Pick<OpenCodeMemberMessageDeliveryServiceDependencies, 'logOpenCodePromptDeliveryEvent'>,
  input: ApplyOpenCodeStalePendingResolutionInput
): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  const { resolution } = input;
  await input.checkpoint();
  if (resolution.action === 'settle_plain_text') {
    const settled = await input.ledger.applyObservation({
      id: input.ledgerRecord.id,
      responseObservation: buildOpenCodeStalePendingPlainTextObservation({
        record: input.ledgerRecord,
        reason: resolution.reason,
      }),
      diagnostics: [resolution.reason],
      observedAt: new Date().toISOString(),
    });
    await input.checkpoint();
    deps.logOpenCodePromptDeliveryEvent('opencode_prompt_delivery_response_observed', settled, {
      ...input.eventContext,
      reason: resolution.reason,
      stalePendingSettledAsPlainText: true,
    });
    return settled;
  }
  if (resolution.action === 'fail_terminal') {
    const failed = await input.ledger.markFailedTerminal({
      id: input.ledgerRecord.id,
      reason: resolution.reason,
      diagnostics: resolution.diagnostics,
      failedAt: new Date().toISOString(),
    });
    await input.checkpoint();
    deps.logOpenCodePromptDeliveryEvent('opencode_prompt_delivery_terminal_failure', failed, {
      ...input.eventContext,
      reason: resolution.reason,
      stalePending: true,
    });
    input.notifyActivity('idle');
    return failed;
  }
  // 'none' and 'keep_observing' use the caller's regular follow-up scheduling.
  return null;
}
