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
 * Legacy configuration window. Age alone never terminates busy or unknown work.
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
  /** Legacy observation window, retained for callers; never a completion deadline. */
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
export const OPENCODE_STALE_PENDING_EXECUTION_EVIDENCE_REASON =
  'opencode_stale_pending_execution_evidence';

export type OpenCodeObservedSessionActivity = 'busy' | 'idle' | 'unknown';

export type OpenCodeStalePendingResolution =
  | { action: 'none' }
  | { action: 'keep_observing'; reason: string }
  | { action: 'settle_plain_text'; reason: string }
  | { action: 'fail_terminal'; reason: string; diagnostics: string[] };

/**
 * Session activity as reported by the bridge observation diagnostics.
 *
 * The raw "OpenCode session status busy" line is the bridge stating that the
 * turn is live, and it wins over the "... treating session as idle" heuristic.
 * That heuristic is a transcript-shape guess ("status WAS busy, but the
 * transcript already holds a completed assistant response"), so it only ever
 * arrives alongside the raw busy line - and an ACP bridge runs its whole tool
 * loop inside one turn with one assistant message, which is exactly the shape
 * the guess misreads: every observation of such a turn carries both strings
 * while the runtime is still spending tokens.
 *
 * The precedence only ever moves an observation from `idle` to `busy`, and this
 * policy never terminates busy or unknown work, so it can only widen what keeps
 * being observed. Turn *ends* are read separately, by
 * `hasOpenCodeObservedTurnEndHeuristic`, so a lead still settles a teammate
 * report on the same evidence it settled it on before.
 *
 * This mirrors `decideOpenCodePromptDeliveryTurnActivity`, which reads the same
 * array: two policies over one observation must not disagree.
 */
export function getOpenCodeObservedSessionActivity(
  diagnostics: readonly string[] | undefined
): OpenCodeObservedSessionActivity {
  const normalized = (diagnostics ?? []).map((diagnostic) => diagnostic.trim().toLowerCase());
  if (normalized.some((diagnostic) => diagnostic.startsWith('opencode session status busy'))) {
    return 'busy';
  }
  if (hasOpenCodeObservedTurnEndHeuristic(diagnostics)) {
    return 'idle';
  }
  return 'unknown';
}

/**
 * The bridge's turn-end evidence: either a plain idle status or the transcript
 * heuristic ("status WAS busy, but the transcript already holds a completed
 * assistant response for the latest user message").
 *
 * The heuristic loses to the raw busy line for the *activity* reading - that is
 * what `getOpenCodeObservedSessionActivity` encodes - but it still closes a turn
 * for settlement. An ACP bridge emits both strings in the same observation for
 * its whole turn, so gating settlement on the raw status alone would mean a lead
 * never settles a teammate report or a notification at all.
 */
export function hasOpenCodeObservedTurnEndHeuristic(
  diagnostics: readonly string[] | undefined
): boolean {
  return (diagnostics ?? [])
    .map((diagnostic) => diagnostic.trim().toLowerCase())
    .some(
      (diagnostic) =>
        diagnostic.includes('treating session as idle') ||
        diagnostic.startsWith('opencode session status idle')
    );
}

/**
 * Milliseconds of silence since the last send, acceptance or turn progress of
 * the record, or null when unknown.
 *
 * `lastTurnProgressAt` is an anchor because silence is the quantity both this
 * window and `OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS` are documented to
 * measure: a turn that keeps producing output must reach neither bound. Adding
 * the anchor can only move the age down, never up, so it never brings a
 * decision forward. The delivery service feeds this same helper into the retry
 * gate, so the coupling is deliberate rather than an accident of sharing one
 * helper.
 */
export function getOpenCodePromptDeliveryPendingAgeMs(
  record: Pick<
    OpenCodePromptDeliveryLedgerRecord,
    'lastTurnProgressAt' | 'lastAttemptAt' | 'acceptedAt' | 'createdAt'
  >,
  nowMs: number
): number | null {
  const anchors = [
    record.lastTurnProgressAt,
    record.lastAttemptAt,
    record.acceptedAt,
    record.createdAt,
  ]
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

/**
 * The runtime accepted the prompt and provably acted on it. This is the
 * ledger-only half of the evidence gate; the runtime half - a growing turn
 * token spend, the only signal an ACP bridge produces - reaches the policy
 * through the progress stamp on the record.
 */
export function hasOpenCodeAcceptedPromptExecutionEvidence(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  if (!hasOpenCodeAcceptedRuntimePrompt(record)) {
    return false;
  }
  return Boolean(
    record.observedToolCallNames.length > 0 ||
    record.observedAssistantMessageId?.trim() ||
    record.observedAssistantPreview?.trim() ||
    record.observedVisibleMessageId?.trim()
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
 * Only positive turn-end evidence may settle an accepted prompt.
 * Reply-optional deliveries settle after turn proof; reply-required deliveries
 * retain their proof contract and fail visibly after the idle stale window.
 * Busy or unknown runtime activity is never completion, regardless of age, and
 * age alone never ends one either.
 *
 * "Active" is the raw bridge status, anything the bridge did not call idle, or
 * the turn-activity decision the delivery service computes from the same
 * observation, and it guards only the terminal decision. Settlement follows
 * `turnCompleted`, which lets the transcript heuristic close a turn the raw busy
 * line would otherwise keep open forever on an ACP bridge - but never while this
 * observation itself produced new output. Both of its disjuncts are positive
 * evidence: an observation that reports no session activity at all is never a
 * turn end.
 */
export function decideOpenCodeStalePendingResolution(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  laneKind: 'primary' | 'secondary';
  observation?: Pick<OpenCodeDeliveryResponseObservation, 'state' | 'assistantMessageId'> | null;
  observedDiagnostics?: readonly string[];
  /** `decideOpenCodePromptDeliveryTurnActivity` over the same observation. */
  turnActivity?: { active: boolean; reason: string } | null;
  hasExecutionEvidence?: boolean;
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
  const sessionActive = activity !== 'idle' || input.turnActivity?.active === true;
  const assistantMessageSeen = Boolean(
    input.observation?.assistantMessageId?.trim() || record.observedAssistantMessageId?.trim()
  );
  // Fresh output in this very observation (growing tool calls, growing
  // assistant text, a second assistant message) outranks the turn-end
  // heuristic; `session_status_busy` does not, because on an ACP bridge it is
  // permanent for the whole turn.
  const turnOutputProgressed =
    input.turnActivity?.active === true && input.turnActivity.reason !== 'session_status_busy';
  // A turn end has to be observed, not inferred from silence: the assistant
  // message row already exists while the turn runs, and `unknown` only means
  // the observation said nothing about the session. Both disjuncts are
  // therefore positive evidence - the transcript heuristic, which an ACP bridge
  // emits alongside its permanent busy line, or an explicitly idle session.
  const turnCompleted =
    assistantMessageSeen &&
    !turnOutputProgressed &&
    (hasOpenCodeObservedTurnEndHeuristic(input.observedDiagnostics) || activity === 'idle');

  if (
    input.laneKind === 'primary' &&
    !isUserPrompt &&
    turnCompleted &&
    isOpenCodeReplyOptionalDeliveryContract(record.replyRecipient)
  ) {
    return { action: 'settle_plain_text', reason: OPENCODE_LEAD_PLAIN_TEXT_TURN_END_REASON };
  }
  if (turnCompleted && isOpenCodeReplyOptionalDeliveryContract(record.replyRecipient)) {
    return { action: 'settle_plain_text', reason: OPENCODE_REPLY_OPTIONAL_TURN_END_REASON };
  }

  const ageMs = getOpenCodePromptDeliveryPendingAgeMs(record, input.nowMs);
  if (ageMs === null || ageMs < staleAfterMs) {
    return { action: 'none' };
  }
  const ageDescription = `accepted prompt has been pending for ${Math.round(ageMs / 1000)}s`;
  const turnActivityDescription = `turnActivity=${input.turnActivity?.reason ?? 'unknown'}`;
  if (sessionActive) {
    return { action: 'keep_observing', reason: `opencode_stale_pending_session_${activity}` };
  }
  // Accepted and provably executed: keep observing rather than closing a prompt
  // the runtime demonstrably worked on. This only ever postpones the terminal
  // decision the line below would otherwise take now, and the legacy
  // observation window bounds the postponement.
  if (input.hasExecutionEvidence === true && ageMs < hardCapMs) {
    return { action: 'keep_observing', reason: OPENCODE_STALE_PENDING_EXECUTION_EVIDENCE_REASON };
  }
  return {
    action: 'fail_terminal',
    reason: OPENCODE_STALE_PENDING_TERMINAL_REASON,
    diagnostics: [
      `OpenCode observation never settled the accepted prompt (session ${activity}, ${turnActivityDescription}); ${ageDescription}.`,
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
