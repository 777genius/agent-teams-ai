import { isOpenCodeAcceptedDeliveryMissingPromptProof } from './OpenCodePromptDeliveryReadCommitPolicy';
import { decideOpenCodeStalePendingUserPreemption } from './OpenCodePromptDeliveryStalePendingPolicy';

import type { OpenCodeMemberMessageDeliveryServiceDependencies } from './OpenCodeMemberMessageDeliveryPorts';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeStalePendingResolution } from './OpenCodePromptDeliveryStalePendingPolicy';

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

/**
 * Settles a stale-pending resolution against the ledger. Returns the settled
 * record, or null when the resolution changed nothing.
 */
export type OpenCodeStalePendingSettler = (input: {
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  resolution: OpenCodeStalePendingResolution;
  eventContext: Record<string, unknown>;
}) => Promise<OpenCodePromptDeliveryLedgerRecord | null>;

/**
 * A new user message must never wait behind a stale non-user record that the
 * observe loop never settled. Decide whether the blocker can be preempted, and
 * settle it if so.
 *
 * Returns the record that still blocks the lane, or null once it no longer does.
 */
export async function preemptStaleOpenCodeActiveDelivery(input: {
  ports: Pick<
    OpenCodeMemberMessageDeliveryServiceDependencies,
    'scheduleOpenCodePromptDeliveryWatchdog' | 'openCodeStalePendingPolicyConfig'
  >;
  activeRecord: OpenCodePromptDeliveryLedgerRecord;
  incomingMessageId?: string;
  incomingReplyRecipient?: string;
  laneKind: 'primary' | 'secondary';
  teamName: string;
  memberName: string;
  settle: OpenCodeStalePendingSettler;
}): Promise<OpenCodePromptDeliveryLedgerRecord | null> {
  const preemption = decideOpenCodeStalePendingUserPreemption({
    activeRecord: input.activeRecord,
    incomingReplyRecipient: input.incomingReplyRecipient,
    laneKind: input.laneKind,
    nowMs: Date.now(),
    config: input.ports.openCodeStalePendingPolicyConfig,
  });
  const settled = await input.settle({
    ledgerRecord: input.activeRecord,
    resolution: preemption,
    eventContext: { preemptedByUserMessageId: input.incomingMessageId },
  });
  if (!settled) {
    return input.activeRecord;
  }
  if (settled.status === 'responded') {
    // Let the watchdog relay read-commit the settled inbox row.
    input.ports.scheduleOpenCodePromptDeliveryWatchdog({
      teamName: input.teamName,
      memberName: input.memberName,
      messageId: settled.inboxMessageId,
      delayMs: 500,
    });
  }
  return null;
}
