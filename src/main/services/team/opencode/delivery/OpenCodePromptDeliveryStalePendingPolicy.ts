import { isOpenCodeReplyOptionalDeliveryContract } from './OpenCodeDeliveryReplyContract';
import {
  hasOpenCodeAcceptedRuntimePrompt,
  isOpenCodeDirectUserPromptDelivery,
} from './OpenCodePromptDeliveryReadCommitPolicy';

import type { OpenCodeDeliveryResponseObservation } from '../bridge/OpenCodeBridgeCommandContract';
import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

/**
 * Stale-pending guard for accepted OpenCode prompt deliveries.
 *
 * An accepted prompt whose bridge observation keeps answering `pending` is
 * re-observed every OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS with no attempt
 * budget (attempts only count sends). The ledger record then never reaches a
 * terminal decision, and because the delivery service queues every later
 * message behind the oldest non-terminal record, one such record blocks the
 * whole lane forever. This policy bounds that loop.
 */

/** An accepted/pending record older than this (since its last send) is stale. */
export const OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS = 5 * 60_000;
/**
 * A stale non-user record whose session still reports busy is settled terminal
 * after this long regardless; user-prompt records are never hard-capped.
 */
export const OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS = 30 * 60_000;

/**
 * The windows this policy bounds a pending delivery with. The policy has no
 * defaults of its own: whoever composes the delivery pipeline states them, so
 * the shipped values are read at one place in the composition rather than
 * hidden as fallbacks behind every call.
 */
export interface OpenCodeStalePendingPolicyConfig {
  /** Age since the last send at which an observe-only pending record is stale. */
  staleAfterMs: number;
  /** Age at which a stale non-user record settles terminal even while busy. */
  hardCapMs: number;
}

/** The windows the shipped delivery pipeline runs this policy with. */
export const OPENCODE_STALE_PENDING_POLICY_CONFIG: OpenCodeStalePendingPolicyConfig = {
  staleAfterMs: OPENCODE_PROMPT_DELIVERY_STALE_PENDING_MS,
  hardCapMs: OPENCODE_PROMPT_DELIVERY_STALE_PENDING_HARD_CAP_MS,
};

export const OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON =
  'opencode_lead_plain_text_turn_end_non_user_message';
export const OPENCODE_REPLY_OPTIONAL_TURN_END_REASON = 'opencode_reply_optional_delivery_turn_end';
export const OPENCODE_STALE_PENDING_TERMINAL_REASON =
  'opencode_stale_pending_observe_window_exhausted';
export const OPENCODE_STALE_PENDING_HARD_CAP_REASON =
  'opencode_stale_pending_busy_hard_cap_exceeded';
export const OPENCODE_STALE_PENDING_PREEMPTED_REASON =
  'opencode_stale_pending_preempted_by_user_message';

export type OpenCodeObservedSessionActivity = 'busy' | 'idle' | 'unknown';

export type OpenCodeStalePendingResolution =
  | { action: 'none' }
  | { action: 'keep_observing'; reason: string }
  | { action: 'settle_plain_text'; reason: string }
  | { action: 'fail_terminal'; reason: string; diagnostics: string[] };

/**
 * Session activity as reported by the bridge observation diagnostics. The
 * bridge emits "OpenCode session status busy" while a turn runs and the
 * "... treating session as idle" heuristic once the transcript shows a
 * completed assistant response for the latest user message.
 */
export function getOpenCodeObservedSessionActivity(
  diagnostics: readonly string[] | undefined
): OpenCodeObservedSessionActivity {
  const normalized = (diagnostics ?? []).map((diagnostic) => diagnostic.trim().toLowerCase());
  if (
    normalized.some(
      (diagnostic) =>
        diagnostic.includes('treating session as idle') ||
        diagnostic.startsWith('opencode session status idle')
    )
  ) {
    return 'idle';
  }
  if (normalized.some((diagnostic) => diagnostic.startsWith('opencode session status busy'))) {
    return 'busy';
  }
  return 'unknown';
}

/** Milliseconds since the last send/acceptance of the record, or null when unknown. */
export function getOpenCodePromptDeliveryPendingAgeMs(
  record: Pick<OpenCodePromptDeliveryLedgerRecord, 'lastAttemptAt' | 'acceptedAt' | 'createdAt'>,
  nowMs: number
): number | null {
  const anchors = [record.lastAttemptAt, record.acceptedAt, record.createdAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((value) => Number.isFinite(value));
  if (anchors.length === 0) {
    return null;
  }
  return Math.max(0, nowMs - Math.max(...anchors));
}

/**
 * Accepted prompt that is only being observed (no retry budget applies):
 * the bridge has the prompt, nothing has been read-committed, and the
 * observation state is still `pending`/`prompt_not_indexed`.
 */
export function isOpenCodePromptDeliveryObserveOnlyPendingRecord(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  return (
    record.status === 'accepted' &&
    !record.inboxReadCommittedAt &&
    hasOpenCodeAcceptedRuntimePrompt(record) &&
    (record.responseState === 'pending' || record.responseState === 'prompt_not_indexed')
  );
}

export function isOpenCodePromptDeliveryStalePending(
  record: OpenCodePromptDeliveryLedgerRecord,
  nowMs: number,
  staleAfterMs: number
): boolean {
  if (!isOpenCodePromptDeliveryObserveOnlyPendingRecord(record)) {
    return false;
  }
  const ageMs = getOpenCodePromptDeliveryPendingAgeMs(record, nowMs);
  return ageMs !== null && ageMs >= staleAfterMs;
}

/**
 * Decide what to do with an observe-only pending record after a fresh bridge
 * observation that still did not settle it.
 *
 * - Primary (lead) lane, non-user message, turn ended (assistant message seen
 *   and the session observed idle): settle as `responded_plain_text` right
 *   away. Lead replies to teammate reports and system notifications are
 *   optional, so a plain-text turn end is a complete response and read-commit
 *   may proceed. An unknown session is never a turn end - only the stale
 *   window below bounds a record the bridge reports nothing about.
 * - Any lane, reply-optional delivery (informational notice or teammate
 *   report), turn ended: same settlement. The member owed no reply, so a
 *   finished turn is the whole contract; without this the record sat pending
 *   until the stale window expired.
 * - Stale (older than `config.staleAfterMs`) and the session is not busy:
 *   terminal.
 * - Stale and busy: keep observing; non-user records are capped at
 *   `config.hardCapMs` and then settled terminal.
 */
export function decideOpenCodeStalePendingResolution(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  laneKind: 'primary' | 'secondary';
  observation?: Pick<OpenCodeDeliveryResponseObservation, 'state' | 'assistantMessageId'> | null;
  observedDiagnostics?: readonly string[];
  nowMs: number;
  config: OpenCodeStalePendingPolicyConfig;
}): OpenCodeStalePendingResolution {
  const { record } = input;
  if (!isOpenCodePromptDeliveryObserveOnlyPendingRecord(record)) {
    return { action: 'none' };
  }
  const { staleAfterMs, hardCapMs } = input.config;
  const isUserPrompt = isOpenCodeDirectUserPromptDelivery(record);
  const activity = getOpenCodeObservedSessionActivity(input.observedDiagnostics);
  const assistantMessageSeen = Boolean(
    input.observation?.assistantMessageId?.trim() || record.observedAssistantMessageId?.trim()
  );
  // A turn end has to be observed, not inferred from silence: the assistant
  // message row already exists while the turn runs, and `unknown` only means
  // the observation said nothing about the session.
  const turnEnded = assistantMessageSeen && activity === 'idle';

  if (input.laneKind === 'primary' && !isUserPrompt && turnEnded) {
    return { action: 'settle_plain_text', reason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON };
  }
  if (turnEnded && isOpenCodeReplyOptionalDeliveryContract(record.replyRecipient)) {
    return { action: 'settle_plain_text', reason: OPENCODE_REPLY_OPTIONAL_TURN_END_REASON };
  }

  const ageMs = getOpenCodePromptDeliveryPendingAgeMs(record, input.nowMs);
  if (ageMs === null || ageMs < staleAfterMs) {
    return { action: 'none' };
  }
  const ageDescription = `accepted prompt has been pending for ${Math.round(ageMs / 1000)}s`;
  if (activity === 'busy') {
    if (!isUserPrompt && ageMs >= hardCapMs) {
      return {
        action: 'fail_terminal',
        reason: OPENCODE_STALE_PENDING_HARD_CAP_REASON,
        diagnostics: [
          `OpenCode session still reported busy after ${Math.round(hardCapMs / 60_000)} minute(s); ${ageDescription}.`,
        ],
      };
    }
    return { action: 'keep_observing', reason: 'opencode_stale_pending_session_busy' };
  }
  return {
    action: 'fail_terminal',
    reason: OPENCODE_STALE_PENDING_TERMINAL_REASON,
    diagnostics: [
      `OpenCode observation never settled the accepted prompt (session ${activity}); ${ageDescription}.`,
    ],
  };
}

/**
 * A new user message must never wait behind a stale non-user record (teammate
 * report, task/system notification). Decide how to settle the blocking record
 * so the user delivery can proceed. Non-stale or user-prompt records keep the
 * normal queue-behind semantics.
 */
export function decideOpenCodeStalePendingUserPreemption(input: {
  activeRecord: OpenCodePromptDeliveryLedgerRecord;
  incomingReplyRecipient?: string | null;
  laneKind: 'primary' | 'secondary';
  nowMs: number;
  config: OpenCodeStalePendingPolicyConfig;
}): OpenCodeStalePendingResolution {
  if (input.incomingReplyRecipient?.trim().toLowerCase() !== 'user') {
    return { action: 'none' };
  }
  if (isOpenCodeDirectUserPromptDelivery(input.activeRecord)) {
    return { action: 'none' };
  }
  if (
    !isOpenCodePromptDeliveryStalePending(
      input.activeRecord,
      input.nowMs,
      input.config.staleAfterMs
    )
  ) {
    return { action: 'none' };
  }
  if (input.laneKind === 'primary' && input.activeRecord.observedAssistantMessageId?.trim()) {
    return { action: 'settle_plain_text', reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON };
  }
  return {
    action: 'fail_terminal',
    reason: OPENCODE_STALE_PENDING_PREEMPTED_REASON,
    diagnostics: [
      'A newer user message preempted this stale non-user delivery so the lane can continue.',
    ],
  };
}

/** Observation payload that settles a record as a plain-text turn end. */
export function buildOpenCodeStalePendingPlainTextObservation(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  reason: string;
}): OpenCodeDeliveryResponseObservation {
  return {
    state: 'responded_plain_text',
    deliveredUserMessageId: input.record.deliveredUserMessageId,
    assistantMessageId: input.record.observedAssistantMessageId,
    toolCallNames: input.record.observedToolCallNames,
    visibleMessageToolCallId: input.record.observedVisibleMessageId,
    visibleReplyMessageId: null,
    visibleReplyCorrelation: null,
    latestAssistantPreview: input.record.observedAssistantPreview,
    reason: input.reason,
  };
}
