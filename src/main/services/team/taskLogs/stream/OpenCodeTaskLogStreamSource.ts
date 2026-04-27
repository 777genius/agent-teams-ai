import { createLogger } from '@shared/utils/logger';
import { sanitizeDisplayContent } from '@shared/utils/contentSanitizer';

import { ClaudeMultimodelBridgeService } from '../../../runtime/ClaudeMultimodelBridgeService';
import { canonicalizeAgentTeamsToolName } from '../../agentTeamsToolNames';
import { ClaudeBinaryResolver } from '../../ClaudeBinaryResolver';
import { TeamTaskReader } from '../../TeamTaskReader';
import { BoardTaskExactLogChunkBuilder } from '../exact/BoardTaskExactLogChunkBuilder';

import { OpenCodeTaskLogAttributionStore } from './OpenCodeTaskLogAttributionStore';

import type {
  OpenCodeRuntimeTranscriptLogContentBlock,
  OpenCodeRuntimeTranscriptLogMessage,
} from '../../../runtime/ClaudeMultimodelBridgeService';
import type {
  OpenCodeTaskLogAttributionReader,
  OpenCodeTaskLogAttributionRecord,
} from './OpenCodeTaskLogAttributionStore';
import type { ContentBlock, ParsedMessage, ToolUseResultData } from '@main/types';
import type {
  BoardTaskLogActor,
  BoardTaskLogParticipant,
  BoardTaskLogSegment,
  BoardTaskLogStreamResponse,
  TeamTask,
} from '@shared/types';

const logger = createLogger('OpenCodeTaskLogStreamSource');

const CACHE_TTL_MS = 1_500;
const HEURISTIC_TRANSCRIPT_LIMIT = 200;
const ATTRIBUTED_TRANSCRIPT_LIMIT = 500;
const WINDOW_GRACE_BEFORE_MS = 30_000;
const WINDOW_GRACE_AFTER_MS = 15_000;
const ATTRIBUTION_WINDOW_GRACE_MS = 1_000;
const TASK_MARKER_CONTEXT_BEFORE_MESSAGES = 1;
const TASK_MARKER_CONTEXT_MAX_MS = 5 * 60_000;
const NATIVE_TOOL_CONTEXT_BEFORE_MS = 5 * 60_000;
const NATIVE_TOOL_CONTEXT_AFTER_MS = 5 * 60_000;

const AGENT_TEAMS_TOOL_PREFIXES = [
  'mcp__agent-teams__',
  'mcp__agent_teams__',
  'agent-teams_',
  'agent_teams_',
] as const;

const TASK_LOG_MARKER_TOOL_NAMES = new Set<string>([
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

const BOARD_MCP_TOOL_NAMES = new Set<string>([
  ...TASK_LOG_MARKER_TOOL_NAMES,
  'runtime_bootstrap_checkin',
  'member_briefing',
  'message_send',
  'cross_team_send',
  'task_create',
  'task_create_from_message',
  'task_get',
  'task_get_comment',
  'task_list',
  'task_update',
  'task_delete',
  'process_list',
]);

const TERMINAL_TASK_MARKER_TOOL_NAMES = new Set<string>([
  'task_complete',
  'review_approve',
  'review_request_changes',
]);

const TERMINAL_TASK_SET_STATUS_VALUES = new Set<string>(['completed', 'pending', 'deleted']);

const TASK_REFERENCE_KEYS = new Set<string>([
  'taskid',
  'task_id',
  'targetid',
  'targettaskid',
  'target_task_id',
  'canonicalid',
  'canonical_id',
  'displayid',
  'display_id',
]);

const TEAM_REFERENCE_KEYS = new Set<string>(['team', 'teamid', 'team_id', 'teamname', 'team_name']);

interface TimeWindow {
  startMs: number;
  endMs: number | null;
}

interface TaskMarkerCall {
  toolName: string;
  input: unknown;
}

interface TaskMarkerMatch {
  index: number;
  markerCalls: TaskMarkerCall[];
  windowIndex: number | null;
}

interface BinaryResolverLike {
  resolve(): Promise<string | null>;
}

interface MemberProjectedMessages {
  memberName: string;
  sessionId?: string;
  messages: ParsedMessage[];
}

interface TaskMarkerProjection {
  messages: ParsedMessage[];
  markerMatchCount: number;
  markerSpanCount: number;
  boardMcpToolCount: number;
  nativeToolCount: number;
}

interface ProjectionToolCounts {
  boardMcpToolCount: number;
  nativeToolCount: number;
}

type HeuristicFallbackReason =
  | 'no_attribution_records'
  | 'attribution_no_projected_messages'
  | 'task_tool_markers';

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function buildParticipantKey(memberName: string): string {
  return `member:${normalizeMemberName(memberName)}`;
}

function buildParticipant(memberName: string): BoardTaskLogParticipant {
  return {
    key: buildParticipantKey(memberName),
    label: memberName,
    role: 'member',
    isLead: false,
    isSidechain: true,
  };
}

function buildActor(memberName: string, sessionId: string | undefined): BoardTaskLogActor {
  return {
    memberName,
    role: 'member',
    sessionId: sessionId?.trim() || `opencode:${normalizeMemberName(memberName)}`,
    isSidechain: true,
  };
}

function stableTaskWindowKey(task: TeamTask): string {
  const intervals = (task.workIntervals ?? [])
    .map((interval) => `${interval.startedAt}:${interval.completedAt ?? ''}`)
    .join('|');
  return [task.id, task.owner ?? '', task.createdAt ?? '', task.updatedAt ?? '', intervals].join(
    '::'
  );
}

function stableAttributionKey(records: OpenCodeTaskLogAttributionRecord[]): string {
  if (records.length === 0) {
    return 'no-attribution';
  }

  return records
    .map((record) =>
      JSON.stringify([
        normalizeMemberName(record.memberName),
        record.scope,
        record.sessionId ?? '',
        record.since ?? '',
        record.until ?? '',
        record.startMessageUuid ?? '',
        record.endMessageUuid ?? '',
      ])
    )
    .sort()
    .join('|');
}

function normalizeTaskRef(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildTaskRefSet(task: TeamTask): Set<string> {
  return new Set(
    [task.id, task.displayId]
      .map(normalizeTaskRef)
      .filter((value): value is string => value !== null)
  );
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
    return Object.entries(value as Record<string, unknown>).some(([key, nestedValue]) => {
      const normalizedKey = key.toLowerCase();
      if (TASK_REFERENCE_KEYS.has(normalizedKey)) {
        return valueReferencesTask(nestedValue, taskRefs, depth + 1);
      }
      return depth < 2 && valueReferencesTask(nestedValue, taskRefs, depth + 1);
    });
  }

  return false;
}

function collectNormalizedRefs(value: unknown, depth = 0): Set<string> {
  const refs = new Set<string>();
  if (depth > 4 || value === null || value === undefined) {
    return refs;
  }

  const normalized = normalizeTaskRef(value);
  if (normalized) {
    refs.add(normalized);
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectNormalizedRefs(item, depth + 1)) {
        refs.add(ref);
      }
    }
  } else if (typeof value === 'object') {
    for (const nestedValue of Object.values(value as Record<string, unknown>)) {
      for (const ref of collectNormalizedRefs(nestedValue, depth + 1)) {
        refs.add(ref);
      }
    }
  }

  return refs;
}

function collectExplicitRefsForKeys(value: unknown, keys: Set<string>, depth = 0): Set<string> {
  const refs = new Set<string>();
  if (depth > 4 || value === null || value === undefined) {
    return refs;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      for (const ref of collectExplicitRefsForKeys(item, keys, depth + 1)) {
        refs.add(ref);
      }
    }
    return refs;
  }

  if (typeof value !== 'object') {
    return refs;
  }

  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    if (keys.has(key.toLowerCase())) {
      for (const ref of collectNormalizedRefs(nestedValue)) {
        refs.add(ref);
      }
      continue;
    }

    for (const ref of collectExplicitRefsForKeys(nestedValue, keys, depth + 1)) {
      refs.add(ref);
    }
  }

  return refs;
}

function refsIntersect(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) {
    if (right.has(value)) {
      return true;
    }
  }
  return false;
}

function isBoardMcpToolName(rawName: string): boolean {
  const normalizedRawName = rawName
    .trim()
    .replace(/^proxy_/, '')
    .toLowerCase();
  const canonicalName = canonicalizeAgentTeamsToolName(rawName).trim().toLowerCase();
  return (
    AGENT_TEAMS_TOOL_PREFIXES.some((prefix) => normalizedRawName.startsWith(prefix)) ||
    BOARD_MCP_TOOL_NAMES.has(canonicalName)
  );
}

function isNativeOpenCodeToolName(rawName: string): boolean {
  const normalizedName = rawName.trim();
  return normalizedName.length > 0 && !isBoardMcpToolName(normalizedName);
}

function messageHasNativeOpenCodeToolCall(message: ParsedMessage): boolean {
  return message.toolCalls.some((toolCall) => isNativeOpenCodeToolName(toolCall.name ?? ''));
}

function countProjectionToolCalls(messages: ParsedMessage[]): ProjectionToolCounts {
  let boardMcpToolCount = 0;
  let nativeToolCount = 0;

  for (const message of messages) {
    for (const toolCall of message.toolCalls) {
      if (isNativeOpenCodeToolName(toolCall.name ?? '')) {
        nativeToolCount += 1;
      } else if (isBoardMcpToolName(toolCall.name ?? '')) {
        boardMcpToolCount += 1;
      }
    }
  }

  return { boardMcpToolCount, nativeToolCount };
}

function markerInputReferencesTaskInTeam(
  input: unknown,
  teamName: string,
  taskRefs: Set<string>
): boolean {
  const normalizedTeamName = normalizeTaskRef(teamName);
  const explicitTeamRefs = collectExplicitRefsForKeys(input, TEAM_REFERENCE_KEYS);
  if (
    normalizedTeamName &&
    explicitTeamRefs.size > 0 &&
    !explicitTeamRefs.has(normalizedTeamName)
  ) {
    return false;
  }

  const explicitTaskRefs = collectExplicitRefsForKeys(input, TASK_REFERENCE_KEYS);
  if (explicitTaskRefs.size > 0) {
    return refsIntersect(explicitTaskRefs, taskRefs);
  }

  return valueReferencesTask(input, taskRefs);
}

function collectTaskMarkerCalls(
  message: ParsedMessage,
  teamName: string,
  taskRefs: Set<string>
): TaskMarkerCall[] {
  if (taskRefs.size === 0) {
    return [];
  }

  return message.toolCalls.flatMap((toolCall) => {
    const toolName = canonicalizeAgentTeamsToolName(toolCall.name ?? '').toLowerCase();
    return TASK_LOG_MARKER_TOOL_NAMES.has(toolName) &&
      markerInputReferencesTaskInTeam(toolCall.input, teamName, taskRefs)
      ? [{ toolName, input: toolCall.input }]
      : [];
  });
}

function markerInputReferencesTaskInDifferentExplicitTeam(
  input: unknown,
  teamName: string,
  taskRefs: Set<string>
): boolean {
  if (taskRefs.size === 0) {
    return false;
  }

  const normalizedTeamName = normalizeTaskRef(teamName);
  const explicitTeamRefs = collectExplicitRefsForKeys(input, TEAM_REFERENCE_KEYS);
  if (
    !normalizedTeamName ||
    explicitTeamRefs.size === 0 ||
    explicitTeamRefs.has(normalizedTeamName)
  ) {
    return false;
  }

  const explicitTaskRefs = collectExplicitRefsForKeys(input, TASK_REFERENCE_KEYS);
  return explicitTaskRefs.size > 0
    ? refsIntersect(explicitTaskRefs, taskRefs)
    : valueReferencesTask(input, taskRefs);
}

function hasForeignTeamTaskMarker(
  projectedMessages: OpenCodeRuntimeTranscriptLogMessage[],
  teamName: string,
  task: TeamTask
): boolean {
  const taskRefs = buildTaskRefSet(task);
  if (taskRefs.size === 0) {
    return false;
  }

  return projectedMessages
    .map(toParsedMessage)
    .filter((message): message is ParsedMessage => message !== null)
    .some((message) =>
      message.toolCalls.some((toolCall) => {
        const toolName = canonicalizeAgentTeamsToolName(toolCall.name ?? '').toLowerCase();
        return (
          TASK_LOG_MARKER_TOOL_NAMES.has(toolName) &&
          markerInputReferencesTaskInDifferentExplicitTeam(toolCall.input, teamName, taskRefs)
        );
      })
    );
}

function isTerminalTaskMarkerCall(markerCall: TaskMarkerCall): boolean {
  if (TERMINAL_TASK_MARKER_TOOL_NAMES.has(markerCall.toolName)) {
    return true;
  }

  if (
    markerCall.toolName === 'task_set_status' &&
    markerCall.input &&
    typeof markerCall.input === 'object' &&
    !Array.isArray(markerCall.input)
  ) {
    const status = (markerCall.input as Record<string, unknown>).status;
    return (
      typeof status === 'string' && TERMINAL_TASK_SET_STATUS_VALUES.has(status.trim().toLowerCase())
    );
  }

  return false;
}

function isTerminalTaskMarkerMatch(match: TaskMarkerMatch): boolean {
  return match.markerCalls.some(isTerminalTaskMarkerCall);
}

function sortParsedMessagesByTime(messages: ParsedMessage[]): ParsedMessage[] {
  return messages
    .map((message, index) => ({ message, index }))
    .sort((left, right) => {
      const timeDiff = left.message.timestamp.getTime() - right.message.timestamp.getTime();
      return timeDiff !== 0 ? timeDiff : left.index - right.index;
    })
    .map(({ message }) => message);
}

function isWithinSingleTimeWindow(timestamp: Date, window: TimeWindow): boolean {
  const messageTime = timestamp.getTime();
  if (!Number.isFinite(messageTime)) {
    return false;
  }

  const endMs = window.endMs ?? Date.now();
  return messageTime >= window.startMs && messageTime <= endMs;
}

function findContainingWindowIndex(timestamp: Date, windows: TimeWindow[]): number | null {
  if (windows.length === 0) {
    return null;
  }

  const index = windows.findIndex((window) => isWithinSingleTimeWindow(timestamp, window));
  return index >= 0 ? index : null;
}

function groupMarkerMatchesByWindow(matches: TaskMarkerMatch[]): TaskMarkerMatch[][] {
  const groups = new Map<number, TaskMarkerMatch[]>();
  for (const match of matches) {
    if (match.windowIndex === null) {
      continue;
    }
    const existing = groups.get(match.windowIndex) ?? [];
    existing.push(match);
    groups.set(match.windowIndex, existing);
  }

  return [...groups.entries()].sort(([left], [right]) => left - right).map(([, group]) => group);
}

function groupMarkerMatchesByLifecycle(matches: TaskMarkerMatch[]): TaskMarkerMatch[][] {
  const groups: TaskMarkerMatch[][] = [];
  let currentGroup: TaskMarkerMatch[] = [];

  for (const match of matches) {
    currentGroup.push(match);
    if (isTerminalTaskMarkerMatch(match)) {
      groups.push(currentGroup);
      currentGroup = [];
    }
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function groupMarkerMatches(
  matches: TaskMarkerMatch[],
  windows: TimeWindow[]
): TaskMarkerMatch[][] {
  return windows.length > 0
    ? groupMarkerMatchesByWindow(matches)
    : groupMarkerMatchesByLifecycle(matches);
}

function shouldIncludeMarkerContext(
  previousMessage: ParsedMessage | undefined,
  markerMessage: ParsedMessage
): boolean {
  if (!previousMessage || previousMessage.isMeta) {
    return false;
  }

  if (markerMessage.parentUuid && previousMessage.uuid === markerMessage.parentUuid) {
    return true;
  }

  const diffMs = markerMessage.timestamp.getTime() - previousMessage.timestamp.getTime();
  return (
    previousMessage.type === 'user' &&
    Number.isFinite(diffMs) &&
    diffMs >= 0 &&
    diffMs <= TASK_MARKER_CONTEXT_MAX_MS
  );
}

function resolveMarkerSpanStart(messages: ParsedMessage[], markerIndex: number): number {
  const contextIndex = markerIndex - TASK_MARKER_CONTEXT_BEFORE_MESSAGES;
  if (
    contextIndex >= 0 &&
    shouldIncludeMarkerContext(messages[contextIndex], messages[markerIndex])
  ) {
    return contextIndex;
  }
  return markerIndex;
}

function findLastMessageIndexInWindow(
  messages: ParsedMessage[],
  startIndex: number,
  window: TimeWindow,
  maxEndMs = Number.POSITIVE_INFINITY
): number {
  let endIndex = startIndex;
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.timestamp.getTime() > maxEndMs) {
      break;
    }
    if (!isWithinSingleTimeWindow(message.timestamp, window)) {
      break;
    }
    endIndex = index;
  }
  return endIndex;
}

function extendSpanEndForToolResults(
  messages: ParsedMessage[],
  startIndex: number,
  endIndex: number
): number {
  const includedAssistantUuids = new Set<string>();
  for (let index = startIndex; index <= endIndex; index += 1) {
    const message = messages[index];
    if (message?.type === 'assistant') {
      includedAssistantUuids.add(message.uuid);
    }
  }

  let extendedEndIndex = endIndex;
  while (extendedEndIndex + 1 < messages.length) {
    const nextMessage = messages[extendedEndIndex + 1];
    if (
      !nextMessage?.isMeta ||
      !nextMessage.sourceToolAssistantUUID ||
      !includedAssistantUuids.has(nextMessage.sourceToolAssistantUUID)
    ) {
      break;
    }
    extendedEndIndex += 1;
  }

  return extendedEndIndex;
}

function buildMarkerSpan(
  messages: ParsedMessage[],
  markerGroup: TaskMarkerMatch[],
  windows: TimeWindow[]
): { startIndex: number; endIndex: number } | null {
  const firstMarker = markerGroup[0];
  const lastMarker = markerGroup[markerGroup.length - 1];
  if (!firstMarker || !lastMarker) {
    return null;
  }

  const startIndex = resolveMarkerSpanStart(messages, firstMarker.index);
  let endIndex = lastMarker.index;
  const window =
    lastMarker.windowIndex === null ? undefined : (windows[lastMarker.windowIndex] ?? undefined);

  if (!isTerminalTaskMarkerMatch(lastMarker) && window) {
    const maxEndMs =
      window.endMs === null
        ? messages[lastMarker.index].timestamp.getTime() + TASK_MARKER_CONTEXT_MAX_MS
        : Number.POSITIVE_INFINITY;
    endIndex = findLastMessageIndexInWindow(messages, lastMarker.index, window, maxEndMs);
  }

  return {
    startIndex,
    endIndex: extendSpanEndForToolResults(messages, startIndex, endIndex),
  };
}

function clampWindowToTaskWindow(
  window: TimeWindow,
  taskWindow: TimeWindow | undefined
): TimeWindow {
  if (!taskWindow) {
    return window;
  }

  const taskEndMs = taskWindow.endMs ?? Date.now();
  return {
    startMs: Math.max(window.startMs, taskWindow.startMs),
    endMs: Math.min(window.endMs ?? taskEndMs, taskEndMs),
  };
}

function buildNativeToolWindowForMarkerGroup(
  messages: ParsedMessage[],
  markerGroup: TaskMarkerMatch[],
  span: { startIndex: number; endIndex: number },
  taskWindows: TimeWindow[]
): TimeWindow | null {
  const firstMarker = markerGroup[0];
  const lastMarker = markerGroup[markerGroup.length - 1];
  if (!firstMarker || !lastMarker) {
    return null;
  }

  const groupHasStartMarker = markerGroup.some((match) =>
    match.markerCalls.some((markerCall) => markerCall.toolName === 'task_start')
  );
  const spanStartMessage = messages[span.startIndex];
  const lastMarkerMessage = messages[lastMarker.index];
  if (!spanStartMessage || !lastMarkerMessage) {
    return null;
  }

  const startMs = groupHasStartMarker
    ? spanStartMessage.timestamp.getTime()
    : lastMarkerMessage.timestamp.getTime() - NATIVE_TOOL_CONTEXT_BEFORE_MS;
  const taskWindow =
    lastMarker.windowIndex === null
      ? undefined
      : (taskWindows[lastMarker.windowIndex] ?? undefined);
  const endMs = isTerminalTaskMarkerMatch(lastMarker)
    ? Math.max(
        messages[span.endIndex]?.timestamp.getTime() ?? lastMarkerMessage.timestamp.getTime(),
        lastMarkerMessage.timestamp.getTime()
      )
    : (taskWindow?.endMs ?? lastMarkerMessage.timestamp.getTime() + NATIVE_TOOL_CONTEXT_AFTER_MS);
  const clamped = clampWindowToTaskWindow({ startMs, endMs }, taskWindow);
  return clamped.startMs <= (clamped.endMs ?? Date.now()) ? clamped : null;
}

function addNativeToolIndexesInWindows(
  includedIndexes: Set<number>,
  messages: ParsedMessage[],
  windows: TimeWindow[]
): void {
  if (windows.length === 0) {
    return;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!messageHasNativeOpenCodeToolCall(message)) {
      continue;
    }
    if (isWithinTimeWindows(message.timestamp, windows)) {
      includedIndexes.add(index);
    }
  }
}

function addToolResultIndexesForIncludedAssistants(
  includedIndexes: Set<number>,
  messages: ParsedMessage[]
): void {
  const includedAssistantUuids = new Set<string>();
  for (const index of includedIndexes) {
    const message = messages[index];
    if (message?.type === 'assistant') {
      includedAssistantUuids.add(message.uuid);
    }
  }

  if (includedAssistantUuids.size === 0) {
    return;
  }

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (
      message?.isMeta &&
      message.sourceToolAssistantUUID &&
      includedAssistantUuids.has(message.sourceToolAssistantUUID)
    ) {
      includedIndexes.add(index);
    }
  }
}

function buildTaskMarkerProjection(
  projectedMessages: OpenCodeRuntimeTranscriptLogMessage[],
  teamName: string,
  task: TeamTask
): TaskMarkerProjection | null {
  const parsedMessages = sortParsedMessagesByTime(
    projectedMessages
      .map(toParsedMessage)
      .filter((message): message is ParsedMessage => message !== null)
  );
  const taskRefs = buildTaskRefSet(task);
  const taskWindows = buildTaskTimeWindows(task);

  const markerMatches = parsedMessages.flatMap((message, index) => {
    const markerCalls = collectTaskMarkerCalls(message, teamName, taskRefs);
    const windowIndex = findContainingWindowIndex(message.timestamp, taskWindows);
    return markerCalls.length > 0 && (taskWindows.length === 0 || windowIndex !== null)
      ? [{ index, markerCalls, windowIndex }]
      : [];
  });
  if (markerMatches.length === 0) {
    return null;
  }

  const markerGroups = groupMarkerMatches(markerMatches, taskWindows);
  const spansWithGroups = markerGroups
    .map((group) => {
      const span = buildMarkerSpan(parsedMessages, group, taskWindows);
      return span ? { group, span } : null;
    })
    .filter(
      (
        item
      ): item is { group: TaskMarkerMatch[]; span: { startIndex: number; endIndex: number } } =>
        item !== null
    );
  const includedIndexes = new Set<number>();
  const nativeToolWindows: TimeWindow[] = [];
  for (const { group, span } of spansWithGroups) {
    for (let index = span.startIndex; index <= span.endIndex; index += 1) {
      includedIndexes.add(index);
    }
    const nativeToolWindow = buildNativeToolWindowForMarkerGroup(
      parsedMessages,
      group,
      span,
      taskWindows
    );
    if (nativeToolWindow) {
      nativeToolWindows.push(nativeToolWindow);
    }
  }
  addNativeToolIndexesInWindows(includedIndexes, parsedMessages, nativeToolWindows);
  addToolResultIndexesForIncludedAssistants(includedIndexes, parsedMessages);

  const messages = [...includedIndexes]
    .sort((left, right) => left - right)
    .map((index) => parsedMessages[index])
    .filter((message): message is ParsedMessage => message !== undefined);
  const markerMatchCount = markerMatches.reduce(
    (count, match) => count + match.markerCalls.length,
    0
  );

  return messages.length > 0
    ? {
        messages,
        markerMatchCount,
        markerSpanCount: spansWithGroups.length,
        ...countProjectionToolCalls(messages),
      }
    : null;
}

function buildTaskTimeWindows(task: TeamTask): TimeWindow[] {
  const windowsFromIntervals = (Array.isArray(task.workIntervals) ? task.workIntervals : [])
    .map((interval) => {
      const startedAt = Date.parse(interval.startedAt);
      if (!Number.isFinite(startedAt)) {
        return null;
      }
      const completedAt =
        typeof interval.completedAt === 'string' ? Date.parse(interval.completedAt) : Number.NaN;
      return {
        startMs: startedAt - WINDOW_GRACE_BEFORE_MS,
        endMs: Number.isFinite(completedAt) ? completedAt + WINDOW_GRACE_AFTER_MS : null,
      };
    })
    .filter((window): window is TimeWindow => window !== null);

  if (windowsFromIntervals.length > 0) {
    return windowsFromIntervals;
  }

  const createdAtMs = typeof task.createdAt === 'string' ? Date.parse(task.createdAt) : Number.NaN;
  const updatedAtMs = typeof task.updatedAt === 'string' ? Date.parse(task.updatedAt) : Number.NaN;
  if (Number.isFinite(createdAtMs) || Number.isFinite(updatedAtMs)) {
    const startMs = Number.isFinite(createdAtMs) ? createdAtMs : updatedAtMs;
    return [
      {
        startMs: startMs - WINDOW_GRACE_BEFORE_MS,
        endMs: Number.isFinite(updatedAtMs) ? updatedAtMs + WINDOW_GRACE_AFTER_MS : null,
      },
    ];
  }

  return [];
}

function buildAttributionTimeWindows(record: OpenCodeTaskLogAttributionRecord): TimeWindow[] {
  const sinceMs = record.since ? Date.parse(record.since) : Number.NaN;
  const untilMs = record.until ? Date.parse(record.until) : Number.NaN;
  if (!Number.isFinite(sinceMs) && !Number.isFinite(untilMs)) {
    return [];
  }

  return [
    {
      startMs: Number.isFinite(sinceMs)
        ? sinceMs - ATTRIBUTION_WINDOW_GRACE_MS
        : Number.NEGATIVE_INFINITY,
      endMs: Number.isFinite(untilMs) ? untilMs + ATTRIBUTION_WINDOW_GRACE_MS : null,
    },
  ];
}

function isWithinTimeWindows(timestamp: Date, windows: TimeWindow[]): boolean {
  const messageTime = timestamp.getTime();
  if (!Number.isFinite(messageTime)) {
    return false;
  }
  if (windows.length === 0) {
    return true;
  }

  const now = Date.now();
  return windows.some((window) => {
    const endMs = window.endMs ?? now;
    return messageTime >= window.startMs && messageTime <= endMs;
  });
}

function filterByMessageUuidRange(
  messages: ParsedMessage[],
  record: OpenCodeTaskLogAttributionRecord
): ParsedMessage[] {
  const startIndex = record.startMessageUuid
    ? messages.findIndex((message) => message.uuid === record.startMessageUuid)
    : 0;
  if (startIndex < 0) {
    return [];
  }

  const endIndex = record.endMessageUuid
    ? messages.findIndex((message) => message.uuid === record.endMessageUuid)
    : messages.length - 1;
  if (endIndex < 0 || endIndex < startIndex) {
    return [];
  }

  return messages.slice(startIndex, endIndex + 1);
}

function filterMessagesForAttribution(
  messages: OpenCodeRuntimeTranscriptLogMessage[],
  record: OpenCodeTaskLogAttributionRecord
): ParsedMessage[] {
  const parsedMessages = messages
    .map(toParsedMessage)
    .filter((message): message is ParsedMessage => message !== null);

  const hasMessageBounds = Boolean(record.startMessageUuid || record.endMessageUuid);
  const hasTimeBounds = Boolean(record.since || record.until);
  const canUseTaskSessionScope = record.scope === 'task_session' && Boolean(record.sessionId);
  if (!hasMessageBounds && !hasTimeBounds && !canUseTaskSessionScope) {
    return [];
  }

  const rangeFiltered = filterByMessageUuidRange(parsedMessages, record);
  const windows = buildAttributionTimeWindows(record);
  return rangeFiltered
    .filter((message) => isWithinTimeWindows(message.timestamp, windows))
    .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
}

function mapOpenCodeContentBlock(
  block: OpenCodeRuntimeTranscriptLogContentBlock
): ContentBlock | null {
  switch (block.type) {
    case 'text': {
      const text = sanitizeDisplayContent(block.text);
      return text.length > 0 ? { type: 'text', text } : null;
    }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
      };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: Array.isArray(block.content)
          ? block.content
              .map(mapOpenCodeContentBlock)
              .filter((item): item is ContentBlock => item !== null)
          : block.content,
        ...(block.is_error ? { is_error: true } : {}),
      };
    default:
      return null;
  }
}

function buildToolUseResultData(
  message: OpenCodeRuntimeTranscriptLogMessage
): ToolUseResultData | undefined {
  if (!message.sourceToolUseID || message.toolResults.length !== 1) {
    return undefined;
  }

  const toolResult = message.toolResults[0];
  if (!toolResult) {
    return undefined;
  }

  return {
    toolUseId: toolResult.toolUseId,
    content: toolResult.content,
    isError: toolResult.isError,
  };
}

function toParsedMessage(message: OpenCodeRuntimeTranscriptLogMessage): ParsedMessage | null {
  const timestamp = new Date(message.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return null;
  }

  const normalizedContent: ContentBlock[] | string =
    typeof message.content === 'string'
      ? sanitizeDisplayContent(message.content)
      : message.content
          .map(mapOpenCodeContentBlock)
          .filter((item): item is ContentBlock => item !== null);

  const toolCalls = message.toolCalls.map((toolCall) => ({
    id: toolCall.id,
    name: toolCall.name,
    input: toolCall.input,
    isTask: toolCall.isTask,
    ...(toolCall.taskDescription ? { taskDescription: toolCall.taskDescription } : {}),
    ...(toolCall.taskSubagentType ? { taskSubagentType: toolCall.taskSubagentType } : {}),
  }));

  const toolResults = message.toolResults.map((toolResult) => ({
    toolUseId: toolResult.toolUseId,
    content: toolResult.content,
    isError: toolResult.isError,
  }));
  const toolUseResult = buildToolUseResultData(message);

  return {
    uuid: message.uuid,
    parentUuid: message.parentUuid,
    type: message.type,
    timestamp,
    role: message.role,
    content: normalizedContent,
    model: message.model,
    agentName: message.agentName,
    isSidechain: true,
    isMeta: message.isMeta,
    sessionId: message.sessionId,
    toolCalls,
    toolResults,
    ...(message.sourceToolUseID ? { sourceToolUseID: message.sourceToolUseID } : {}),
    ...(message.sourceToolAssistantUUID
      ? { sourceToolAssistantUUID: message.sourceToolAssistantUUID }
      : {}),
    ...(toolUseResult ? { toolUseResult } : {}),
    ...(message.subtype ? { subtype: message.subtype } : {}),
    ...(message.level ? { level: message.level } : {}),
  };
}

export class OpenCodeTaskLogStreamSource {
  private readonly cache = new Map<
    string,
    {
      expiresAt: number;
      response: BoardTaskLogStreamResponse | null;
    }
  >();

  private readonly inFlight = new Map<string, Promise<BoardTaskLogStreamResponse | null>>();

  constructor(
    private readonly runtimeBridge: ClaudeMultimodelBridgeService = new ClaudeMultimodelBridgeService(),
    private readonly binaryResolver: BinaryResolverLike = ClaudeBinaryResolver,
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder(),
    private readonly attributionStore: OpenCodeTaskLogAttributionReader = new OpenCodeTaskLogAttributionStore()
  ) {}

  private async resolveTask(teamName: string, taskId: string): Promise<TeamTask | null> {
    const [activeTasks, deletedTasks] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
    ]);
    return [...activeTasks, ...deletedTasks].find((task) => task.id === taskId) ?? null;
  }

  async getTaskLogStream(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskLogStreamResponse | null> {
    const task = await this.resolveTask(teamName, taskId);
    if (!task) {
      return null;
    }

    const attributionRecords = await this.attributionStore.readTaskRecords(teamName, taskId);
    if (!task.owner?.trim() && attributionRecords.length === 0) {
      return null;
    }

    const cacheKey = `${teamName}::${stableTaskWindowKey(task)}::${stableAttributionKey(attributionRecords)}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.response;
    }

    const existingPromise = this.inFlight.get(cacheKey);
    if (existingPromise) {
      return await existingPromise;
    }

    const promise = this.buildTaskLogStream(teamName, task, attributionRecords)
      .catch((error) => {
        logger.warn(
          `[${teamName}/${task.id}] OpenCode task-log fallback failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
        return null;
      })
      .then((response) => {
        this.cache.set(cacheKey, {
          expiresAt: Date.now() + CACHE_TTL_MS,
          response,
        });
        return response;
      })
      .finally(() => {
        this.inFlight.delete(cacheKey);
      });

    this.inFlight.set(cacheKey, promise);
    return await promise;
  }

  private async buildTaskLogStream(
    teamName: string,
    task: TeamTask,
    attributionRecords: OpenCodeTaskLogAttributionRecord[]
  ): Promise<BoardTaskLogStreamResponse | null> {
    const binaryPath = await this.binaryResolver.resolve();
    if (!binaryPath) {
      return null;
    }

    let fallbackReason: HeuristicFallbackReason = 'no_attribution_records';
    if (attributionRecords.length > 0) {
      const attributedResponse = await this.buildAttributedTaskLogStream(
        binaryPath,
        teamName,
        task,
        attributionRecords
      );
      if (attributedResponse) {
        return attributedResponse;
      }
      fallbackReason = 'attribution_no_projected_messages';
    }

    return await this.buildHeuristicTaskLogStream(binaryPath, teamName, task, {
      attributionRecordCount: attributionRecords.length,
      fallbackReason,
    });
  }

  private async buildHeuristicTaskLogStream(
    binaryPath: string,
    teamName: string,
    task: TeamTask,
    projectionContext: {
      attributionRecordCount: number;
      fallbackReason: HeuristicFallbackReason;
    }
  ): Promise<BoardTaskLogStreamResponse | null> {
    const ownerName = task.owner?.trim();
    if (!ownerName) {
      return null;
    }

    const transcript = await this.runtimeBridge.getOpenCodeTranscript(binaryPath, {
      teamId: teamName,
      memberName: ownerName,
      limit: HEURISTIC_TRANSCRIPT_LIMIT,
    });

    const projectedMessages = transcript?.logProjection?.messages ?? [];
    if (projectedMessages.length === 0) {
      return null;
    }

    const markerProjection = buildTaskMarkerProjection(projectedMessages, teamName, task);
    if (!markerProjection && hasForeignTeamTaskMarker(projectedMessages, teamName, task)) {
      return null;
    }
    const timeWindows = markerProjection ? [] : buildTaskTimeWindows(task);
    const projectionReason: HeuristicFallbackReason = markerProjection
      ? 'task_tool_markers'
      : projectionContext.fallbackReason;
    const filteredMessages =
      markerProjection?.messages ??
      projectedMessages
        .map(toParsedMessage)
        .filter((message): message is ParsedMessage => message !== null)
        .filter((message) => isWithinTimeWindows(message.timestamp, timeWindows))
        .sort((left, right) => left.timestamp.getTime() - right.timestamp.getTime());
    const toolCounts = markerProjection
      ? {
          boardMcpToolCount: markerProjection.boardMcpToolCount,
          nativeToolCount: markerProjection.nativeToolCount,
        }
      : countProjectionToolCalls(filteredMessages);

    if (filteredMessages.length === 0) {
      return null;
    }

    const chunks = this.chunkBuilder.buildBundleChunks(filteredMessages);
    if (chunks.length === 0) {
      return null;
    }

    const firstMessage = filteredMessages[0];
    const lastMessage = filteredMessages[filteredMessages.length - 1];
    if (!firstMessage || !lastMessage) {
      return null;
    }

    const actor = buildActor(ownerName, transcript?.sessionId ?? firstMessage.sessionId);
    const participant = buildParticipant(ownerName);
    const segment: BoardTaskLogSegment = {
      id: `opencode:${teamName}:${task.id}:${normalizeMemberName(ownerName)}`,
      participantKey: participant.key,
      actor,
      startTimestamp: firstMessage.timestamp.toISOString(),
      endTimestamp: lastMessage.timestamp.toISOString(),
      chunks,
    };

    logger.debug(
      `[${teamName}/${task.id}] using OpenCode runtime fallback for task log stream (${filteredMessages.length} messages, owner=${ownerName}, boardMcpTools=${toolCounts.boardMcpToolCount}, nativeTools=${toolCounts.nativeToolCount})`
    );

    return {
      participants: [participant],
      defaultFilter: participant.key,
      segments: [segment],
      source: 'opencode_runtime_fallback',
      runtimeProjection: {
        provider: 'opencode',
        mode: 'heuristic',
        attributionRecordCount: projectionContext.attributionRecordCount,
        projectedMessageCount: filteredMessages.length,
        ...toolCounts,
        fallbackReason: projectionReason,
        ...(markerProjection
          ? {
              markerMatchCount: markerProjection.markerMatchCount,
              markerSpanCount: markerProjection.markerSpanCount,
            }
          : {}),
      },
    };
  }

  private async buildAttributedTaskLogStream(
    binaryPath: string,
    teamName: string,
    task: TeamTask,
    attributionRecords: OpenCodeTaskLogAttributionRecord[]
  ): Promise<BoardTaskLogStreamResponse | null> {
    const projectedByParticipant = new Map<string, MemberProjectedMessages>();
    const transcriptCache = new Map<
      string,
      Awaited<ReturnType<ClaudeMultimodelBridgeService['getOpenCodeTranscript']>>
    >();

    for (const record of attributionRecords) {
      const memberName = record.memberName.trim();
      if (!memberName) {
        continue;
      }

      const memberKey = normalizeMemberName(memberName);
      if (!transcriptCache.has(memberKey)) {
        transcriptCache.set(
          memberKey,
          await this.runtimeBridge.getOpenCodeTranscript(binaryPath, {
            teamId: teamName,
            memberName,
            limit: ATTRIBUTED_TRANSCRIPT_LIMIT,
          })
        );
      }

      const transcript = transcriptCache.get(memberKey);
      if (!transcript) {
        continue;
      }
      if (record.sessionId && transcript.sessionId !== record.sessionId) {
        continue;
      }

      const filteredMessages = filterMessagesForAttribution(
        transcript.logProjection?.messages ?? [],
        record
      );
      if (filteredMessages.length === 0) {
        continue;
      }

      const participantKey = buildParticipantKey(memberName);
      const existing = projectedByParticipant.get(participantKey);
      if (existing) {
        const seen = new Set(existing.messages.map((message) => message.uuid));
        for (const message of filteredMessages) {
          if (!seen.has(message.uuid)) {
            existing.messages.push(message);
            seen.add(message.uuid);
          }
        }
        existing.messages.sort(
          (left, right) => left.timestamp.getTime() - right.timestamp.getTime()
        );
      } else {
        projectedByParticipant.set(participantKey, {
          memberName,
          sessionId: transcript.sessionId ?? record.sessionId,
          messages: filteredMessages,
        });
      }
    }

    const members = Array.from(projectedByParticipant.values()).filter(
      (item) => item.messages.length > 0
    );
    if (members.length === 0) {
      logger.debug(
        `[${teamName}/${task.id}] OpenCode task-log attribution yielded no projected messages; falling back to owner/time-window heuristic`
      );
      return null;
    }

    const participants: BoardTaskLogParticipant[] = [];
    const segments: BoardTaskLogSegment[] = [];
    let projectedMessageCount = 0;
    let boardMcpToolCount = 0;
    let nativeToolCount = 0;
    for (const member of members.sort((left, right) => {
      const leftStart = left.messages[0]?.timestamp.getTime() ?? 0;
      const rightStart = right.messages[0]?.timestamp.getTime() ?? 0;
      if (leftStart !== rightStart) {
        return leftStart - rightStart;
      }
      return left.memberName.localeCompare(right.memberName);
    })) {
      const chunks = this.chunkBuilder.buildBundleChunks(member.messages);
      if (chunks.length === 0) {
        continue;
      }

      const firstMessage = member.messages[0];
      const lastMessage = member.messages[member.messages.length - 1];
      if (!firstMessage || !lastMessage) {
        continue;
      }

      const participant = buildParticipant(member.memberName);
      const memberToolCounts = countProjectionToolCalls(member.messages);
      projectedMessageCount += member.messages.length;
      boardMcpToolCount += memberToolCounts.boardMcpToolCount;
      nativeToolCount += memberToolCounts.nativeToolCount;
      participants.push(participant);
      segments.push({
        id: `opencode-attributed:${teamName}:${task.id}:${normalizeMemberName(member.memberName)}`,
        participantKey: participant.key,
        actor: buildActor(member.memberName, member.sessionId ?? firstMessage.sessionId),
        startTimestamp: firstMessage.timestamp.toISOString(),
        endTimestamp: lastMessage.timestamp.toISOString(),
        chunks,
      });
    }

    if (segments.length === 0) {
      return null;
    }

    logger.debug(
      `[${teamName}/${task.id}] using OpenCode task-log attribution (${segments.length} segment(s), ${attributionRecords.length} record(s), boardMcpTools=${boardMcpToolCount}, nativeTools=${nativeToolCount})`
    );

    return {
      participants,
      defaultFilter: participants.length === 1 ? (participants[0]?.key ?? 'all') : 'all',
      segments,
      source: 'opencode_runtime_attribution',
      runtimeProjection: {
        provider: 'opencode',
        mode: 'attribution',
        attributionRecordCount: attributionRecords.length,
        projectedMessageCount,
        boardMcpToolCount,
        nativeToolCount,
      },
    };
  }
}
