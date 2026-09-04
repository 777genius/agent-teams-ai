import { isOpenCodeAcceptedDeliveryMissingPromptProof } from './OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodeMemberMessageDeliveryServiceDependencies } from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';

/**
 * Ports needed to decide whether the record currently holding a lane still
 * blocks the next delivery.
 */
export type OpenCodeActiveDeliveryPreemptionPorts = Pick<
  OpenCodeMemberMessageDeliveryServiceDependencies,
  | 'openCodeVisibleReplyProofService'
  | 'isOpenCodeDeliveryResponseReadCommitAllowed'
  | 'markOpenCodeAcceptedDeliveryMissingPromptProofForRetry'
  | 'scheduleOpenCodePromptDeliveryWatchdog'
  | 'logOpenCodePromptDeliveryEvent'
>;

/**
 * Re-examine the record that is blocking the lane before queueing a new message
 * behind it. The proof service may have picked up a reply that landed after the
 * last observation; when it did, the blocker is settled and the lane is free.
 * An accepted record whose prompt proof went missing is re-armed for a retry
 * instead.
 *
 * Returns the record that still blocks the lane, or null once it no longer does.
 */
export async function recoverOpenCodeActiveDeliveryBlocker(input: {
  ports: OpenCodeActiveDeliveryPreemptionPorts;
  ledger: OpenCodePromptDeliveryLedgerStore;
  activeRecord: OpenCodePromptDeliveryLedgerRecord;
  teamName: string;
  memberName: string;
}): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  const { ports, ledger, teamName, memberName } = input;
  let active = input.activeRecord;
  let proof = await ports.openCodeVisibleReplyProofService.applyDestinationProof({
    ledger,
    ledgerRecord: active,
    teamName,
    replyRecipient: active.replyRecipient,
    memberName,
  });
  active = proof.ledgerRecord;
  proof = await ports.openCodeVisibleReplyProofService.materializePlainTextReplyIfNeeded({
    ledger,
    ledgerRecord: active,
    teamName,
    memberName,
    visibleReply: proof.visibleReply,
  });
  active = proof.ledgerRecord;
  const activeReadAllowed = await ports.isOpenCodeDeliveryResponseReadCommitAllowed({
    teamName,
    memberName,
    responseState: active.responseState,
    actionMode: active.actionMode ?? undefined,
    taskRefs: active.taskRefs,
    visibleReply: proof.visibleReply,
    ledgerRecord: active,
  });
  if (activeReadAllowed) {
    ports.logOpenCodePromptDeliveryEvent('opencode_prompt_delivery_response_observed', active, {
      visibleReplySemanticallySufficient: true,
      unblockedNextDelivery: true,
    });
    return null;
  }
  if (isOpenCodeAcceptedDeliveryMissingPromptProof(active)) {
    active = await ports.markOpenCodeAcceptedDeliveryMissingPromptProofForRetry({
      ledger,
      ledgerRecord: active,
      eventContext: { recoveredActiveBlocker: true },
    });
    ports.scheduleOpenCodePromptDeliveryWatchdog({
      teamName,
      memberName,
      messageId: active.inboxMessageId,
      delayMs: 500,
    });
  }
  return active;
}
