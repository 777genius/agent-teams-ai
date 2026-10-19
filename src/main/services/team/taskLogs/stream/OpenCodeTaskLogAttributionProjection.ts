import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from './OpenCodeRuntimeProjectionMapper';

import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from './OpenCodeTaskLogAttributionStore';
import type { ParsedMessage } from '@main/types';

const ATTRIBUTION_WINDOW_GRACE_MS = 1_000;

function filterDeliveryTurn(messages: ParsedMessage[], promptUuid: string): ParsedMessage[] {
  const prompt = messages.find((message) => message.uuid === promptUuid);
  if (!prompt || prompt.type !== 'user' || prompt.toolResults.length > 0) {
    return [];
  }

  // OpenCode assistant parent IDs identify the delivered prompt. A later notification
  // can share the same task ref and time window without belonging to this turn.
  const included = new Set([promptUuid]);
  for (const message of messages) {
    if (
      (message.type === 'assistant' && message.parentUuid && included.has(message.parentUuid)) ||
      (message.isMeta &&
        (message.sourceToolAssistantUUID || message.parentUuid) &&
        included.has(message.sourceToolAssistantUUID || message.parentUuid!))
    ) {
      included.add(message.uuid);
    }
  }
  return messages.filter((message) => included.has(message.uuid));
}

/** V2 has no native parent IDs. This is a conservative display window, never turn authority. */
function filterV2NativeInputWindow(messages: ParsedMessage[], promptUuid: string): ParsedMessage[] {
  if (!/^msg_[A-Za-z0-9]+$/.test(promptUuid)) return [];
  const nativeInput = (message: ParsedMessage) =>
    message.type === 'user' &&
    message.toolResults.length === 0 &&
    /^msg_[A-Za-z0-9]+$/.test(message.uuid);
  const prompts = messages.filter((message) => message.uuid === promptUuid);
  if (prompts.length !== 1 || !nativeInput(prompts[0]) || prompts[0].isMeta) return [];
  const ids = new Set<string>();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const message of messages) {
    if (ids.has(message.uuid)) return [];
    ids.add(message.uuid);
    // Synthetic result timestamps may follow a later native message's creation.
    if (message.isMeta || !['user', 'assistant'].includes(message.type)) continue;
    const time = message.timestamp.getTime();
    if (!Number.isFinite(time) || time < previousTime) return [];
    previousTime = time;
  }
  // Native protocol notifications also delimit the window; synthetic tool-result
  // USER rows do not. Keep all original parent/result IDs exactly as projected.
  const startIndex = messages.findIndex((message) => message.uuid === promptUuid);
  const nextInput = messages.findIndex(
    (message, index) => index > startIndex && nativeInput(message)
  );
  return messages.slice(startIndex, nextInput < 0 ? undefined : nextInput);
}

export function filterMessagesForAttribution(
  projectedMessages: OpenCodeRuntimeTranscriptLogMessage[],
  record: OpenCodeTaskLogAttributionRecord,
  options: { nativeParentIdsUnavailable?: boolean } = {}
): ParsedMessage[] {
  const messages = mapOpenCodeRuntimeTranscriptMessagesToParsedMessages(projectedMessages).filter(
    (message) => !record.sessionId || message.sessionId === record.sessionId
  );
  const hasMessageBounds = Boolean(record.startMessageUuid || record.endMessageUuid);
  const hasTimeBounds = Boolean(record.since || record.until);
  if (
    !hasMessageBounds &&
    !hasTimeBounds &&
    !(record.scope === 'task_session' && record.sessionId)
  ) {
    return [];
  }

  const startIndex = record.startMessageUuid
    ? messages.findIndex((message) => message.uuid === record.startMessageUuid)
    : 0;
  const endIndex = record.endMessageUuid
    ? messages.findIndex((message) => message.uuid === record.endMessageUuid)
    : messages.length - 1;
  if (startIndex < 0 || endIndex < startIndex) {
    return [];
  }

  if (
    options.nativeParentIdsUnavailable &&
    record.source === 'delivery_ledger' &&
    messages.filter((message) => message.uuid === record.startMessageUuid).length !== 1
  )
    return [];

  const range = messages.slice(startIndex, endIndex + 1);
  const turn =
    record.source === 'delivery_ledger'
      ? record.startMessageUuid
        ? options.nativeParentIdsUnavailable && record.sessionId?.trim()
          ? filterV2NativeInputWindow(messages.slice(0, endIndex + 1), record.startMessageUuid)
          : filterDeliveryTurn(range, record.startMessageUuid)
        : []
      : range;
  const sinceMs = record.since ? Date.parse(record.since) : Number.NaN;
  const untilMs = record.until ? Date.parse(record.until) : Number.NaN;
  const startMs = Number.isFinite(sinceMs)
    ? sinceMs - ATTRIBUTION_WINDOW_GRACE_MS
    : Number.NEGATIVE_INFINITY;
  const endMs = Number.isFinite(untilMs)
    ? untilMs + ATTRIBUTION_WINDOW_GRACE_MS
    : hasTimeBounds
      ? Date.now()
      : Number.POSITIVE_INFINITY;
  return turn
    .filter((message) => {
      const timestamp = message.timestamp.getTime();
      return timestamp >= startMs && timestamp <= endMs;
    })
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}
