import { createLogger } from '@shared/utils/logger';

import { buildOpenCodePromptBodyText } from './OpenCodeMemberMessageDeliveryPorts';
import {
  buildOpenCodePromptDeliveryAttemptText,
  buildOpenCodePromptDeliveryRepairControlText,
} from './OpenCodePromptDeliveryAttemptText';
import { isOpenCodeSessionRefreshRetryRecord } from './OpenCodePromptDeliveryFollowUpPolicy';
import { isOpenCodePromptDeliveryAttemptDue } from './OpenCodePromptDeliveryLedger';
import { hasOpenCodeAcceptedRuntimePrompt } from './OpenCodePromptDeliveryReadCommitPolicy';

import type {
  OpenCodeMemberMessageDeliveryInput,
  OpenCodeMemberMessageDeliveryServiceDependencies,
} from './OpenCodeMemberMessageDeliveryPorts';
import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

const logger = createLogger('Service:OpenCodePromptDispatchPreparation');

export type OpenCodePromptDispatchPreparationPorts = Pick<
  OpenCodeMemberMessageDeliveryServiceDependencies,
  | 'getOpenCodeDeliveryPendingReason'
  | 'isOpenCodeDeliveryResponseReadCommitAllowed'
  | 'resolveControlApiBaseUrl'
>;

export interface OpenCodePromptDispatchPlan {
  /** Control API base URL handed to the runtime, or null when this prompt needs none. */
  controlUrl: string | null;
  /** True when the attempt text carries the redelivery marker instead of the prompt body. */
  promptBodyAlreadyDelivered: boolean;
  /** Session refresh reason the send must carry, including one derived from a retry record. */
  forceSessionRefreshReason: string | undefined;
  /** The exact text this attempt sends to the runtime. */
  deliveryText: string;
}

/**
 * Everything a prompt dispatch needs decided before the runtime send.
 *
 * The delivery service reaches this point from three different paths (first
 * send, retry, and forced session refresh), so the preparation has to read the
 * ledger record rather than the call site: whether the previous attempt's
 * response would have been allowed to close the inbox row decides which repair
 * control block the retry carries, and a retry record parked on a session
 * refresh reason has to re-arm that refresh even when the caller did not ask
 * for one.
 */
export async function prepareOpenCodePromptDispatch(input: {
  deps: OpenCodePromptDispatchPreparationPorts;
  teamName: string;
  memberName: string;
  message: Pick<
    OpenCodeMemberMessageDeliveryInput,
    'text' | 'coalescedNoticeText' | 'messageKind' | 'messageId'
  >;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  forceSessionRefreshReason: string | undefined;
}): Promise<OpenCodePromptDispatchPlan> {
  const ledgerRecord = input.ledgerRecord;
  const retryReadAllowed = ledgerRecord
    ? await input.deps.isOpenCodeDeliveryResponseReadCommitAllowed({
        teamName: input.teamName,
        memberName: input.memberName,
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode ?? undefined,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply: null,
        ledgerRecord,
      })
    : false;
  const retryPendingReason = ledgerRecord
    ? input.deps.getOpenCodeDeliveryPendingReason({
        responseState: ledgerRecord.responseState,
        actionMode: ledgerRecord.actionMode,
        taskRefs: ledgerRecord.taskRefs,
        visibleReply: null,
        ledgerRecord,
      })
    : 'opencode_delivery_response_pending';
  const controlUrl =
    input.message.messageKind === 'member_work_sync_nudge'
      ? await input.deps.resolveControlApiBaseUrl()
      : null;
  let forceSessionRefreshReason = input.forceSessionRefreshReason;
  if (
    !forceSessionRefreshReason &&
    ledgerRecord?.status === 'retry_scheduled' &&
    !hasOpenCodeAcceptedRuntimePrompt(ledgerRecord) &&
    isOpenCodePromptDeliveryAttemptDue(ledgerRecord) &&
    isOpenCodeSessionRefreshRetryRecord(ledgerRecord, ledgerRecord.lastReason)
  ) {
    forceSessionRefreshReason =
      ledgerRecord.lastSessionRefreshReason ??
      ledgerRecord.lastReason ??
      ledgerRecord.responseState ??
      'session_stale';
  }
  // The lane ledger is deleted on stop, so accepted-prompt evidence is a
  // per-launch latch: the body is already in THIS session. A forced session
  // refresh rebuilds the session without that history, so there the body must
  // still be redelivered.
  const promptBodyAlreadyDelivered = Boolean(
    ledgerRecord && hasOpenCodeAcceptedRuntimePrompt(ledgerRecord) && !forceSessionRefreshReason
  );
  if (promptBodyAlreadyDelivered) {
    logger.diagnostic(
      `[${input.teamName}] opencode_prompt_delivery_body_suppressed ` +
        `${input.memberName} msg=${ledgerRecord?.inboxMessageId} ` +
        `attempts=${ledgerRecord?.attempts} reason=${retryPendingReason}`
    );
  }
  const deliveryText = buildOpenCodePromptDeliveryAttemptText({
    text: buildOpenCodePromptBodyText(input.message),
    omitOriginalPrompt: promptBodyAlreadyDelivered,
    originalPromptMessageId: ledgerRecord?.inboxMessageId ?? input.message.messageId ?? null,
    controlText: buildOpenCodePromptDeliveryRepairControlText({
      ledgerRecord,
      readAllowed: retryReadAllowed,
      pendingReason: retryPendingReason,
      controlUrl,
    }),
  });
  return { controlUrl, forceSessionRefreshReason, promptBodyAlreadyDelivered, deliveryText };
}
