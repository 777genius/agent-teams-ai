import { canonicalizeAgentTeamsToolName } from '../../agentTeamsToolNames';
import { mapOpenCodeRuntimeTranscriptMessagesToParsedMessages } from './OpenCodeRuntimeProjectionMapper';

import type { OpenCodeRuntimeTranscriptLogMessage } from '../../../runtime/ClaudeMultimodelBridgeService';
import type { OpenCodeTaskLogAttributionRecord } from './OpenCodeTaskLogAttributionStore';
import type { ParsedMessage } from '@main/types';

const ATTRIBUTION_WINDOW_GRACE_MS = 1_000;

export const TASK_LOG_MARKER_TOOL_NAMES = new Set<string>([
  'task_start',
  'task_complete',
  'task_set_status',
  'task_set_owner',
  'task_add_comment',
  'task_attach_file',
  'task_attach_comment_file',
  'task_set_clarification',
  'review_start',
  'review_request',
  'review_approve',
  'review_request_changes',
]);

export const TERMINAL_TASK_MARKER_TOOL_NAMES = new Set<string>([
  'task_complete',
  'review_approve',
  'review_request_changes',
]);

export const TERMINAL_TASK_SET_STATUS_VALUES = new Set<string>(['completed', 'pending', 'deleted']);

function collectTurnClosure(messages: ParsedMessage[], rootUuid: string): ParsedMessage[] {
  const included = new Set([rootUuid]);
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

function filterDeliveryTurn(messages: ParsedMessage[], promptUuid: string): ParsedMessage[] {
  const prompt = messages.find((message) => message.uuid === promptUuid);
  if (!prompt || prompt.type !== 'user' || prompt.toolResults.length > 0) {
    return [];
  }

  // OpenCode assistant parent IDs identify the delivered prompt. A later notification
  // can share the same task ref and time window without belonging to this turn.
  return collectTurnClosure(messages, promptUuid);
}

function normalizeTaskRef(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function valueReferencesTask(value: unknown, taskRefs: Set<string>, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined || taskRefs.size === 0) {
    return false;
  }
  const normalized = normalizeTaskRef(value);
  if (normalized && taskRefs.has(normalized)) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.some((item) => valueReferencesTask(item, taskRefs, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((nested) =>
      valueReferencesTask(nested, taskRefs, depth + 1)
    );
  }
  return false;
}

function markerCallReferencesTask(
  toolCall: { name?: string; input?: unknown },
  taskRefs: Set<string>
): boolean {
  const canonicalName = canonicalizeAgentTeamsToolName(toolCall.name ?? '')
    .trim()
    .toLowerCase();
  return (
    TASK_LOG_MARKER_TOOL_NAMES.has(canonicalName) && valueReferencesTask(toolCall.input, taskRefs)
  );
}

function terminalMarkerCallReferencesTask(
  toolCall: { name?: string; input?: unknown },
  taskRefs: Set<string>
): boolean {
  if (!markerCallReferencesTask(toolCall, taskRefs)) {
    return false;
  }
  const canonicalName = canonicalizeAgentTeamsToolName(toolCall.name ?? '')
    .trim()
    .toLowerCase();
  if (TERMINAL_TASK_MARKER_TOOL_NAMES.has(canonicalName)) {
    return true;
  }
  if (canonicalName !== 'task_set_status') {
    return false;
  }
  const status = (toolCall.input as Record<string, unknown> | undefined)?.status;
  return (
    typeof status === 'string' && TERMINAL_TASK_SET_STATUS_VALUES.has(status.trim().toLowerCase())
  );
}

function resolveTurnRootUuid(messages: ParsedMessage[], message: ParsedMessage): string {
  const byUuid = new Map<string, ParsedMessage>();
  for (const item of messages) {
    byUuid.set(item.uuid, item);
  }
  const seen = new Set([message.uuid]);
  let current = message;
  while (current.parentUuid) {
    const parent = byUuid.get(current.parentUuid);
    if (!parent || seen.has(parent.uuid)) {
      break;
    }
    seen.add(parent.uuid);
    current = parent;
  }
  return current.uuid;
}

/**
 * V1 keeps working on a task inside turns triggered by later pumped messages, so the
 * delivered turn alone hides the task's own command evidence. Those pump turns carry
 * plain work tools (read/write/bash) without any task marker, so when the delivered
 * turn has no terminal task marker, attribute every turn from the delivered turn
 * through the turn that carries the terminal marker. Without a terminal marker inside
 * the record bounds, stay strict.
 */
function extendDeliveryTurnAcrossTaskLifecycle(
  messages: ParsedMessage[],
  promptUuid: string,
  taskRefs: Set<string>
): ParsedMessage[] {
  const base = filterDeliveryTurn(messages, promptUuid);
  if (base.length === 0) {
    return base;
  }
  const containsTerminal = (list: ParsedMessage[]) =>
    list.some((message) =>
      message.toolCalls.some((toolCall) => terminalMarkerCallReferencesTask(toolCall, taskRefs))
    );
  if (containsTerminal(base)) {
    return base;
  }

  const baseRoots = new Set(base.map((message) => resolveTurnRootUuid(messages, message)));
  let terminalEndIndex = -1;
  for (const message of messages) {
    if (!message.toolCalls.some((toolCall) => terminalMarkerCallReferencesTask(toolCall, taskRefs))) {
      continue;
    }
    const rootUuid = resolveTurnRootUuid(messages, message);
    if (baseRoots.has(rootUuid)) {
      continue;
    }
    const terminalTurnUuids = new Set(
      collectTurnClosure(messages, rootUuid).map((item) => item.uuid)
    );
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (terminalTurnUuids.has(messages[index].uuid)) {
        terminalEndIndex = index;
        break;
      }
    }
    break;
  }
  if (terminalEndIndex < 0) {
    return base;
  }

  const baseUuids = new Set(base.map((message) => message.uuid));
  let baseStartIndex = messages.findIndex((message) => baseUuids.has(message.uuid));
  if (baseStartIndex < 0) {
    baseStartIndex = 0;
  }
  return messages.filter((message, index) => index >= baseStartIndex && index <= terminalEndIndex);
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
  return messages.slice(startIndex, nextInput < 0 ? messages.length : nextInput);
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
  const taskRefs = new Set(
    [record.taskId].map(normalizeTaskRef).filter((value): value is string => value !== null)
  );
  const turn =
    record.source === 'delivery_ledger'
      ? record.startMessageUuid
        ? options.nativeParentIdsUnavailable && record.sessionId?.trim()
          ? filterV2NativeInputWindow(messages.slice(0, endIndex + 1), record.startMessageUuid)
          : extendDeliveryTurnAcrossTaskLifecycle(range, record.startMessageUuid, taskRefs)
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
