import { hasOpenCodeNonVisibleProgressProof } from './OpenCodePromptDeliveryReadCommitPolicy';
import {
  decideOpenCodePromptDeliveryRepair,
  type OpenCodePromptDeliveryHardFailureKind,
} from './OpenCodePromptDeliveryRepairPolicy';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

/**
 * The text a single OpenCode prompt delivery attempt carries.
 *
 * A first attempt sends the prompt body alone. A retry additionally carries a
 * repair control block naming the proof the previous attempt failed to produce,
 * so the runtime is told what is missing instead of being asked the same
 * question again.
 */

export function getOpenCodeDeliveryHardFailureKind(
  record?: OpenCodePromptDeliveryLedgerRecord | null
): OpenCodePromptDeliveryHardFailureKind {
  if (!record) {
    return 'none';
  }
  if (record.status === 'failed_terminal') {
    return 'unknown';
  }
  if (record.responseState === 'permission_blocked') {
    return 'permission';
  }
  if (record.responseState === 'session_error') {
    return 'session';
  }
  return 'none';
}

export function buildOpenCodePromptDeliveryRepairControlText(input: {
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  readAllowed: boolean;
  pendingReason: string;
  controlUrl?: string | null;
}): string | null {
  const record = input.ledgerRecord;
  if (!record) {
    return null;
  }
  return decideOpenCodePromptDeliveryRepair({
    teamName: record.teamName,
    memberName: record.memberName,
    inboxMessageId: record.inboxMessageId,
    replyRecipient: record.replyRecipient,
    messageKind: record.messageKind,
    workSyncIntent: record.workSyncIntent,
    actionMode: record.actionMode,
    taskRefs: record.taskRefs,
    status: record.status,
    responseState: record.responseState,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    pendingReason: input.pendingReason,
    readAllowed: input.readAllowed,
    inboxReadCommitted: Boolean(record.inboxReadCommittedAt),
    visibleReplyFound: Boolean(record.visibleReplyMessageId),
    hasKnownProgressProof: hasOpenCodeNonVisibleProgressProof(record),
    toolCallNames: record.observedToolCallNames,
    acceptanceUnknown: record.acceptanceUnknown,
    hardFailureKind: getOpenCodeDeliveryHardFailureKind(record),
    controlUrl: input.controlUrl,
  }).controlText;
}

export function buildOpenCodePromptDeliveryAttemptText(input: {
  text: string;
  controlText?: string | null;
}): string {
  const controlText = input.controlText?.trim();
  return controlText ? `${controlText}\n\n${input.text}` : input.text;
}
