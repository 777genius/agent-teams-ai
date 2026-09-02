import type { OpenCodeDeliveryResponseState } from '../bridge/OpenCodeBridgeCommandContract';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryStatus,
} from './OpenCodePromptDeliveryLedger';
import type { AgentActionMode, InboxMessage, TaskRef } from '@shared/types/team';

export const OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS = 3_000;
export const OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS = 15_000;
/**
 * Retry delay once the runtime has already answered and the answer merely lacks
 * the proof the delivery requires (the visible reply is not readable yet, the
 * text was an acknowledgement, ...).
 *
 * The default delay assumes a retry lands on a lane that did nothing with the
 * prompt, where a fast second attempt is free. A lane that answered is in the
 * opposite situation: one turn regularly spans several assistant messages - a
 * few task writes, then the reply - and a retry that lands between them puts
 * the same prompt in front of a member who has no memory of having answered it,
 * so the user is answered twice. The turn-activity guard already refuses a
 * retry while output is still arriving, but it can only refuse what it can
 * observe; the grace is what covers the quiet gaps inside one long turn.
 */
export const OPENCODE_PROMPT_DELIVERY_RESPONDED_RETRY_DELAY_MS = 90_000;
/**
 * Absolute ceiling for deferring a due retry because the turn still looks
 * active: a lane that never stops producing output must not starve the retry
 * budget forever.
 *
 * It bounds only the inferred signals (a growing assistant message, growing
 * tool calls, growing assistant text). A raw `session status busy` is the
 * bridge stating the turn is live, and re-prompting into a live turn is exactly
 * the double answer this guard exists to prevent, so that signal is not capped
 * here. Whether a session that reports busy forever is ever given up on is a
 * separate decision with a separate owner: the stale-pending policy keeps
 * observing a non-idle session instead of settling it. This cap therefore only
 * decides when a retry may fire, never whether the record is finished.
 */
export const OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS = 600_000;
export const OPENCODE_PROMPT_WATCHDOG_GLOBAL_CONCURRENCY = 2;
export const OPENCODE_PROMPT_WATCHDOG_PER_TEAM_CONCURRENCY = 2;

export type OpenCodePromptDeliveryTurnActivityReason =
  | 'turn_activity_absolute_cap'
  | 'session_status_busy'
  | 'assistant_message_progressed'
  | 'tool_calls_progressed'
  | 'assistant_text_progressed'
  | 'turn_idle';

export interface OpenCodePromptDeliveryTurnActivityInput {
  previousAssistantMessageId: string;
  previousToolCallCount: number;
  previousAssistantPreview: string;
  observation?: {
    assistantMessageId?: string | null;
    toolCallNames?: string[];
    latestAssistantPreview?: string | null;
  } | null;
  observedDiagnostics: readonly string[];
  pendingAgeMs: number | null;
}

export interface OpenCodePromptDeliveryTurnActivityDecision {
  active: boolean;
  reason: OpenCodePromptDeliveryTurnActivityReason;
}

/**
 * Whether the runtime turn answering a prompt is still producing output, so a
 * due retry would land mid-turn and make the member answer twice.
 *
 * A changing assistant message id is the obvious activity proof, but it does
 * not hold for every runtime: an ACP bridge runs its whole tool loop inside a
 * single OpenCode turn, so the assistant message id never changes mid-turn and
 * the bridge reports the session idle after the first completed step. Growing
 * tool calls and growing assistant text are the signals that survive that, and
 * they are the ledger analogue of what the native lead relay already treats as
 * liveness on tool and text events.
 */
export function decideOpenCodePromptDeliveryTurnActivity(
  input: OpenCodePromptDeliveryTurnActivityInput
): OpenCodePromptDeliveryTurnActivityDecision {
  const sessionReportsBusy = input.observedDiagnostics.some((diagnostic) =>
    diagnostic.trim().toLowerCase().startsWith('opencode session status busy')
  );
  if (sessionReportsBusy) {
    return { active: true, reason: 'session_status_busy' };
  }
  if (
    input.pendingAgeMs !== null &&
    input.pendingAgeMs >= OPENCODE_PROMPT_DELIVERY_TURN_ACTIVITY_CAP_MS
  ) {
    return { active: false, reason: 'turn_activity_absolute_cap' };
  }
  const assistantMessageId = input.observation?.assistantMessageId?.trim() ?? '';
  if (
    input.previousAssistantMessageId &&
    assistantMessageId &&
    assistantMessageId !== input.previousAssistantMessageId
  ) {
    return { active: true, reason: 'assistant_message_progressed' };
  }
  if ((input.observation?.toolCallNames?.length ?? 0) > input.previousToolCallCount) {
    return { active: true, reason: 'tool_calls_progressed' };
  }
  const assistantPreview = input.observation?.latestAssistantPreview?.trim() ?? '';
  if (assistantPreview && assistantPreview !== input.previousAssistantPreview) {
    return { active: true, reason: 'assistant_text_progressed' };
  }
  return { active: false, reason: 'turn_idle' };
}

const ACK_ONLY_PHRASES = new Set([
  'понял',
  'поняла',
  'ок',
  'окей',
  'принял',
  'приняла',
  'сделаю',
  'разберусь',
  'understood',
  'got it',
  'ok',
  'okay',
  'will do',
]);

const ACK_ONLY_PREFIXES = [
  "i'll check",
  'i will check',
  "i'll take a look",
  'i will take a look',
  "i'll do it",
  'i will do it',
  'я проверю',
  'я посмотрю',
];

export interface OpenCodeVisibleReplyProof {
  inboxName: string;
  message: InboxMessage & { messageId: string };
  missingRuntimeDeliverySource?: boolean;
}

export interface OpenCodeVisibleReplySemanticResult {
  sufficient: boolean;
  reason?: 'ack_only' | 'concrete_reply';
}

export function isOpenCodeVisibleReplySemanticallySufficient(input: {
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  text: string;
  summary?: string | null;
}): OpenCodeVisibleReplySemanticResult {
  const combined = [input.summary, input.text]
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .join('\n')
    .trim();
  if (!combined) {
    return { sufficient: false, reason: 'ack_only' };
  }
  if (!looksLikeNarrowAckOnly(combined)) {
    return { sufficient: true, reason: 'concrete_reply' };
  }

  return { sufficient: false, reason: 'ack_only' };
}

export function isOpenCodeVisibleReplyReadCommitAllowed(input: {
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  visibleReply?: OpenCodeVisibleReplyProof | null;
  transcriptOnlyVisibleReply?: boolean;
}): boolean {
  if (input.visibleReply) {
    return isOpenCodeVisibleReplySemanticallySufficient({
      actionMode: input.actionMode,
      taskRefs: input.taskRefs,
      text: input.visibleReply.message.text,
      summary: input.visibleReply.message.summary,
    }).sufficient;
  }

  // Transcript-only message_send proves OpenCode attempted a visible reply, but not
  // whether the destination store committed it yet. Keep it pending for the watchdog.
  return input.transcriptOnlyVisibleReply !== true;
}

export function isOpenCodePromptDeliveryRetryableResponseState(
  state: OpenCodeDeliveryResponseState | undefined
): boolean {
  return (
    state === 'empty_assistant_turn' ||
    state === 'prompt_delivered_no_assistant_message' ||
    state === 'tool_error' ||
    state === 'reconcile_failed' ||
    state === 'not_observed' ||
    state === 'session_stale'
  );
}

export function isOpenCodePromptDeliveryRetryAttemptDue(input: {
  attemptDue: boolean;
  ledgerRecord: {
    status: OpenCodePromptDeliveryStatus;
    responseState: OpenCodeDeliveryResponseState;
  };
}): boolean {
  if (!input.attemptDue) {
    return false;
  }
  return (
    input.ledgerRecord.status === 'retry_scheduled' ||
    input.ledgerRecord.status === 'failed_retryable' ||
    isOpenCodePromptDeliveryRetryableResponseState(input.ledgerRecord.responseState)
  );
}

export function isOpenCodePromptDeliveryObserveLaterResponseState(
  state: OpenCodeDeliveryResponseState | undefined
): boolean {
  return (
    state === 'pending' ||
    state === 'prompt_not_indexed' ||
    state === 'permission_blocked' ||
    state === 'session_stale'
  );
}

export function buildOpenCodePromptDeliveryActiveBusyStatus(input: {
  teamName: string;
  memberName: string;
  retryAfterIso: string;
  nowMs?: number;
  activeRecord: OpenCodePromptDeliveryLedgerRecord;
  scheduleWake: (input: {
    teamName: string;
    memberName: string;
    messageId: string;
    delayMs?: number;
  }) => void;
}): {
  busy: true;
  reason: string;
  retryAfterIso: string;
  activeMessageId: string;
  activeMessageKind: string | null;
} {
  const nextAttemptMs = input.activeRecord.nextAttemptAt
    ? Date.parse(input.activeRecord.nextAttemptAt)
    : NaN;
  const nowMs = input.nowMs ?? Date.now();
  const hasFutureNextAttempt = Number.isFinite(nextAttemptMs) && nextAttemptMs > nowMs;
  input.scheduleWake({
    teamName: input.teamName,
    memberName: input.memberName,
    messageId: input.activeRecord.inboxMessageId,
    delayMs: hasFutureNextAttempt ? Math.max(500, nextAttemptMs - nowMs) : 500,
  });
  return {
    busy: true,
    reason: `opencode_prompt_delivery_active:${input.activeRecord.messageKind ?? 'default'}`,
    retryAfterIso: hasFutureNextAttempt ? input.activeRecord.nextAttemptAt! : input.retryAfterIso,
    activeMessageId: input.activeRecord.inboxMessageId,
    activeMessageKind: input.activeRecord.messageKind,
  };
}

function looksLikeNarrowAckOnly(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[.!?,;:()[\]{}"'`«»]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || normalized.length > 120) {
    return false;
  }
  if (/[#/@\\]|\d|```|`/.test(text)) {
    return false;
  }
  if (/[?？]/.test(text)) {
    return false;
  }
  const sentenceLikeParts = text
    .split(/[.!?。！？]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (sentenceLikeParts.length > 1) {
    return false;
  }
  if (ACK_ONLY_PHRASES.has(normalized)) {
    return true;
  }
  return ACK_ONLY_PREFIXES.some(
    (prefix) => normalized === prefix || normalized.startsWith(`${prefix} `)
  );
}
