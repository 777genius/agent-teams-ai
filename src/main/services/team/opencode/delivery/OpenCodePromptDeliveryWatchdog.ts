import type { AgentActionMode, InboxMessage, TaskRef } from '@shared/types/team';
import type { OpenCodeDeliveryResponseState } from '../bridge/OpenCodeBridgeCommandContract';

export const OPENCODE_PROMPT_DELIVERY_OBSERVE_DELAY_MS = 3_000;
export const OPENCODE_PROMPT_DELIVERY_RETRY_DELAY_MS = 15_000;
export const OPENCODE_PROMPT_WATCHDOG_GLOBAL_CONCURRENCY = 2;
export const OPENCODE_PROMPT_WATCHDOG_PER_TEAM_CONCURRENCY = 1;

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
    state === 'tool_error' ||
    state === 'reconcile_failed' ||
    state === 'not_observed'
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
