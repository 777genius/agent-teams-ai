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

/**
 * A memoryless cloud or ACP-bridged lead treats a re-sent prompt body as a
 * fresh kickoff and answers it a second time. Once the runtime has provably
 * accepted the body in this session, the retry carries only the repair control
 * block plus an explicit redelivery marker, the OpenCode-path analogue of the
 * redelivery framing the native lead relay already uses.
 *
 * The marker is emitted unconditionally so a retry is never an empty prompt
 * when the repair policy produced no control text (`max_attempts_reached`, for
 * instance). In that case it also has to name the expected proof itself, since
 * otherwise the only instruction left would be "produce no user-facing output"
 * and the last repair attempt would be a no-op.
 */
export function buildOpenCodePromptDeliveryAttemptText(input: {
  text: string;
  controlText?: string | null;
  omitOriginalPrompt?: boolean;
  originalPromptMessageId?: string | null;
}): string {
  const controlText = input.controlText?.trim();
  if (!input.omitOriginalPrompt) {
    return controlText ? `${controlText}\n\n${input.text}` : input.text;
  }
  const originalPromptMessageId = input.originalPromptMessageId?.trim();
  const messageIdSuffix = originalPromptMessageId ? ` "${originalPromptMessageId}"` : '';
  const missingProofLine = controlText
    ? 'Send only the missing proof named above; if everything is already handled, produce no user-facing output.'
    : `Send the missing proof now: one visible reply to the user via message_send with relayOfMessageId=${
        originalPromptMessageId ? `"${originalPromptMessageId}"` : 'that app message id'
      }, stating the concrete result (a short factual summary when the work is already done). Produce no other user-facing output.`;
  const redeliveryNote = [
    '<opencode_delivery_redelivery>',
    `The inbound app message${messageIdSuffix} is ALREADY in this session and you may have already fully handled it.`,
    'Do NOT treat it as a new request. Check the board and your recent messages first (task_list etc.).',
    'Do NOT re-create tasks, do NOT repeat side effects, and do NOT restate or rephrase a status message you already sent the user.',
    missingProofLine,
    '</opencode_delivery_redelivery>',
  ].join('\n');
  return controlText ? `${redeliveryNote}\n\n${controlText}` : redeliveryNote;
}
