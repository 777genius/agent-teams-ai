import { extractToolCalls, extractToolResults } from '@main/utils/toolExtraction';
import { isLeadMember as isLeadMemberCheck } from '@shared/utils/leadDetection';
import { createLogger } from '@shared/utils/logger';
import { getTaskDisplayId } from '@shared/utils/taskIdentity';

import { TeamConfigReader } from '../../TeamConfigReader';
import { TeamMembersMetaStore } from '../../TeamMembersMetaStore';
import { TeamTaskReader } from '../../TeamTaskReader';
import { BoardTaskActivityRecordSource } from '../activity/BoardTaskActivityRecordSource';
import { TeamTranscriptSourceLocator } from '../discovery/TeamTranscriptSourceLocator';
import { BoardTaskExactLogChunkBuilder } from '../exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogDetailSelector } from '../exact/BoardTaskExactLogDetailSelector';
import { BoardTaskExactLogStrictParser } from '../exact/BoardTaskExactLogStrictParser';
import { BoardTaskExactLogSummarySelector } from '../exact/BoardTaskExactLogSummarySelector';
import { isBoardTaskExactLogsReadEnabled } from '../exact/featureGates';
import { getBoardTaskExactLogFileVersions } from '../exact/fileVersions';

import {
  canonicalizeBoardTaskLogToolName,
  isBoardTaskLogMcpToolName,
} from './boardTaskLogToolNames';
import { CodexNativeTaskLogStreamSource } from './CodexNativeTaskLogStreamSource';
import { buildCodexNativeToolSignature } from './CodexNativeTraceProjector';
import { HistoricalBoardMcpRawProbe } from './HistoricalBoardMcpRawProbe';
import { OpenCodeTaskLogStreamSource } from './OpenCodeTaskLogStreamSource';
import { TaskLogTranscriptCandidateSelector } from './TaskLogTranscriptCandidateSelector';

import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';
import type { BoardTaskExactLogDetailCandidate } from '../exact/BoardTaskExactLogTypes';
import type { TaskLogRuntimeStreamSource } from './TaskLogRuntimeStreamSource';
import type { ContentBlock, ParsedMessage, ToolUseResultData } from '@main/types';
import type {
  BoardTaskActivityCategory,
  BoardTaskLogActor,
  BoardTaskLogParticipant,
  BoardTaskLogSegment,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  TeamTask,
} from '@shared/types';

interface StreamSlice {
  id: string;
  timestamp: string;
  filePath: string;
  sortOrder?: number;
  participantKey: string;
  actor: BoardTaskLogActor;
  actionCategory?: BoardTaskActivityCategory;
  filteredMessages: ParsedMessage[];
}

interface MergedMessageAccumulator {
  message: ParsedMessage;
  content: ParsedMessage['content'];
  firstSeenOrder: number;
  sourceToolUseIds: Set<string>;
  sourceToolAssistantUUIDs: Set<string>;
  toolUseResults: ToolUseResultData[];
}

interface TimeWindow {
  startMs: number;
  endMs: number | null;
}

interface StreamLayout {
  participants: BoardTaskLogParticipant[];
  visibleSlices: StreamSlice[];
  shouldMergeRuntimeFallback?: boolean;
}

const logger = createLogger('Service:BoardTaskLogStreamService');
const INFERRED_WINDOW_GRACE_BEFORE_MS = 30_000;
const INFERRED_WINDOW_GRACE_AFTER_MS = 15_000;
const INFERRED_RECORD_RANGE_BEFORE_MS = 5 * 60_000;
const INFERRED_RECORD_RANGE_AFTER_MS = 60_000;
const STREAM_LAYOUT_CACHE_TTL_MS = 1_000;
const STREAM_LAYOUT_BUILD_WARN_MS = 3_000;
const RUNTIME_FALLBACK_WARN_MS = 3_000;
const INFERRED_CANDIDATE_SELECTION_WARN_COUNT = 100;
const HISTORICAL_RAW_PROBE_WARN_MS = 3_000;
const HISTORICAL_RAW_PROBE_WARN_FILE_COUNT = 500;
const TASK_REFERENCE_KEYS = new Set(['task', 'taskid', 'id', 'displayid', 'targetid']);

function emptyResponse(): BoardTaskLogStreamResponse {
  return {
    participants: [],
    defaultFilter: 'all',
    segments: [],
  };
}

function emptySummary(): BoardTaskLogStreamSummary {
  return {
    segmentCount: 0,
  };
}

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

const isBoardMcpToolName = isBoardTaskLogMcpToolName;
const canonicalizeBoardToolName = canonicalizeBoardTaskLogToolName;

function normalizeTaskReference(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }

  const normalized = String(value).trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildTaskReferenceSet(task: TeamTask): Set<string> {
  return new Set(
    [task.id, getTaskDisplayId(task)]
      .map(normalizeTaskReference)
      .filter((value): value is string => value !== null)
  );
}

function readHistoricalActorName(input: Record<string, unknown>): string | undefined {
  for (const key of ['actor', 'from']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function valueReferencesTask(value: unknown, taskRefs: Set<string>, depth = 0): boolean {
  if (depth > 4 || value === null || value === undefined || taskRefs.size === 0) {
    return false;
  }

  const normalized = normalizeTaskReference(value);
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

function normalizeStatusDetail(
  value: unknown
): 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined {
  if (
    value !== 'pending' &&
    value !== 'in_progress' &&
    value !== 'completed' &&
    value !== 'deleted'
  ) {
    return undefined;
  }
  return value;
}

function normalizeOwnerDetail(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  const normalized = normalizeTaskReference(value);
  if (!normalized) {
    return undefined;
  }

  return normalized === 'clear' || normalized === 'none' ? null : String(value).trim();
}

function normalizeClarificationDetail(value: unknown): 'lead' | 'user' | null | undefined {
  if (value === null) {
    return null;
  }

  if (value !== 'lead' && value !== 'user' && value !== 'clear') {
    return undefined;
  }

  return value === 'clear' ? null : value;
}

function normalizeRelationshipDetail(
  value: unknown
): 'blocked-by' | 'blocks' | 'related' | undefined {
  if (value !== 'blocked-by' && value !== 'blocks' && value !== 'related') {
    return undefined;
  }
  return value;
}

function inferHistoricalLinkKind(canonicalToolName: string): 'lifecycle' | 'board_action' | null {
  switch (canonicalToolName) {
    case 'task_complete':
    case 'task_set_status':
    case 'task_start':
    case 'review_approve':
    case 'review_request_changes':
    case 'review_start':
      return 'lifecycle';
    case 'review_request':
    case 'task_add_comment':
    case 'task_attach_comment_file':
    case 'task_attach_file':
    case 'task_get':
    case 'task_get_comment':
    case 'task_link':
    case 'task_set_clarification':
    case 'task_set_owner':
    case 'task_unlink':
      return 'board_action';
    default:
      return null;
  }
}

function inferHistoricalActionCategory(canonicalToolName: string): BoardTaskActivityCategory {
  switch (canonicalToolName) {
    case 'task_start':
    case 'task_complete':
    case 'task_set_status':
      return 'status';
    case 'review_start':
    case 'review_request':
    case 'review_approve':
    case 'review_request_changes':
      return 'review';
    case 'task_add_comment':
    case 'task_get_comment':
      return 'comment';
    case 'task_set_owner':
      return 'assignment';
    case 'task_get':
      return 'read';
    case 'task_attach_file':
    case 'task_attach_comment_file':
      return 'attachment';
    case 'task_link':
    case 'task_unlink':
      return 'relationship';
    case 'task_set_clarification':
      return 'clarification';
    default:
      return 'other';
  }
}

function historicalBoardToolReferencesTask(args: {
  canonicalToolName: string;
  input: Record<string, unknown>;
  resultPayload: unknown;
  taskRefs: Set<string>;
}): boolean {
  const { canonicalToolName, input, resultPayload, taskRefs } = args;
  if (valueReferencesTask(input, taskRefs)) {
    return true;
  }

  if (canonicalToolName === 'task_get' || canonicalToolName === 'task_get_comment') {
    return false;
  }

  return valueReferencesTask(resultPayload, taskRefs);
}

function asObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function resolveToolResultPayload(
  message: ParsedMessage,
  toolResult: ParsedMessage['toolResults'][number]
): unknown {
  const toolUseResult = message.toolUseResult as
    | ({ toolUseId?: string } & Record<string, unknown>)
    | string
    | unknown[]
    | undefined;

  if (toolUseResult && typeof toolUseResult === 'object' && !Array.isArray(toolUseResult)) {
    const toolUseId =
      typeof toolUseResult.toolUseId === 'string' ? toolUseResult.toolUseId.trim() : undefined;
    if (toolUseId === toolResult.toolUseId || message.toolResults.length === 1) {
      return toolUseResult;
    }
  }

  if (toolUseResult && message.toolResults.length === 1) {
    return toolUseResult;
  }

  return toolResult.content;
}

function parseToolResultRecord(value: unknown): Record<string, unknown> | null {
  const directRecord = asObjectRecord(value);
  if (directRecord) {
    return directRecord;
  }

  if (typeof value === 'string') {
    return asObjectRecord(parseJsonLikeString(value));
  }

  if (!Array.isArray(value)) {
    return null;
  }

  return asObjectRecord(parseJsonLikeString(collectTextBlockText(value)));
}

function buildHistoricalActionDetails(args: {
  canonicalToolName: string;
  input: Record<string, unknown>;
  resultPayload: unknown;
}): NonNullable<BoardTaskActivityRecord['action']>['details'] | undefined {
  const { canonicalToolName, input, resultPayload } = args;
  const resultRecord = parseToolResultRecord(resultPayload);
  const details: NonNullable<NonNullable<BoardTaskActivityRecord['action']>['details']> = {};

  if (canonicalToolName === 'task_set_status') {
    const status = normalizeStatusDetail(input.status);
    if (status) {
      details.status = status;
    }
  }

  if (
    canonicalToolName === 'task_set_owner' &&
    Object.prototype.hasOwnProperty.call(input, 'owner')
  ) {
    const owner = normalizeOwnerDetail(input.owner);
    if (owner !== undefined) {
      details.owner = owner;
    }
  }

  if (canonicalToolName === 'task_set_clarification') {
    const clarification = normalizeClarificationDetail(input.clarification ?? input.value);
    if (clarification !== undefined) {
      details.clarification = clarification;
    }
  }

  if (canonicalToolName === 'review_request' && typeof input.reviewer === 'string') {
    details.reviewer = input.reviewer.trim();
  }

  if (canonicalToolName === 'task_link' || canonicalToolName === 'task_unlink') {
    const relationship = normalizeRelationshipDetail(input.relationship ?? input.linkType);
    if (relationship) {
      details.relationship = relationship;
    }
  }

  if (canonicalToolName === 'task_get_comment' && typeof input.commentId === 'string') {
    details.commentId = input.commentId.trim();
  }

  if (canonicalToolName === 'task_add_comment') {
    const resultCommentId =
      typeof resultRecord?.commentId === 'string'
        ? resultRecord.commentId.trim()
        : typeof resultRecord?.comment === 'object' &&
            resultRecord.comment !== null &&
            'id' in resultRecord.comment &&
            typeof (resultRecord.comment as Record<string, unknown>).id === 'string'
          ? String((resultRecord.comment as Record<string, unknown>).id).trim()
          : undefined;
    if (resultCommentId) {
      details.commentId = resultCommentId;
    }
  }

  if (
    canonicalToolName === 'task_attach_file' ||
    canonicalToolName === 'task_attach_comment_file'
  ) {
    const attachmentId =
      typeof resultRecord?.id === 'string' && resultRecord.id.trim().length > 0
        ? resultRecord.id.trim()
        : undefined;
    const filename =
      typeof resultRecord?.filename === 'string' && resultRecord.filename.trim().length > 0
        ? resultRecord.filename.trim()
        : undefined;
    if (attachmentId) {
      details.attachmentId = attachmentId;
    }
    if (filename) {
      details.filename = filename;
    }
  }

  return Object.keys(details).length > 0 ? details : undefined;
}

function mergeActivityRecords(
  explicitRecords: BoardTaskActivityRecord[],
  inferredRecords: BoardTaskActivityRecord[]
): BoardTaskActivityRecord[] {
  const merged = new Map<string, BoardTaskActivityRecord>();
  for (const record of [...explicitRecords, ...inferredRecords]) {
    merged.set(record.id, record);
  }

  return [...merged.values()].sort(compareCandidates);
}

function retainSyntheticToolUseAssistants(messages: ParsedMessage[]): ParsedMessage[] {
  return messages.map((message) => {
    if (
      message.type !== 'assistant' ||
      message.model !== '<synthetic>' ||
      !Array.isArray(message.content)
    ) {
      return message;
    }

    const hasToolUse = message.content.some((block) => block.type === 'tool_use');
    if (!hasToolUse) {
      return message;
    }

    return {
      ...message,
      model: undefined,
    };
  });
}

function toStreamActor(detail: BoardTaskExactLogDetailCandidate['actor']): BoardTaskLogActor {
  return {
    ...(detail.memberName ? { memberName: detail.memberName } : {}),
    role: detail.role,
    sessionId: detail.sessionId,
    ...(detail.agentId ? { agentId: detail.agentId } : {}),
    isSidechain: detail.isSidechain,
  };
}

function buildParticipantKey(actor: BoardTaskLogActor): string {
  if (actor.memberName) {
    return `member:${normalizeMemberName(actor.memberName)}`;
  }
  if (!actor.isSidechain || actor.role === 'lead') {
    return 'lead';
  }
  if (actor.agentId) {
    return `sidechain-agent:${actor.agentId}`;
  }
  return `sidechain-session:${actor.sessionId}`;
}

function buildParticipantLabel(actor: BoardTaskLogActor): string {
  if (actor.memberName) {
    return actor.memberName;
  }
  if (!actor.isSidechain || actor.role === 'lead') {
    return 'lead session';
  }
  if (actor.agentId) {
    return `member ${actor.agentId.slice(0, 8)}`;
  }
  return `member session ${actor.sessionId.slice(0, 8)}`;
}

function buildParticipant(
  actor: BoardTaskLogActor,
  participantKey: string
): BoardTaskLogParticipant {
  return {
    key: participantKey,
    label: buildParticipantLabel(actor),
    role: actor.role,
    isLead: participantKey === 'lead',
    isSidechain: actor.isSidechain,
  };
}

function hasNamedParticipant(actor: BoardTaskLogActor): boolean {
  return typeof actor.memberName === 'string' && actor.memberName.trim().length > 0;
}

function hasToolUseBlock(
  content: ParsedMessage['content'],
  toolUseId: string | undefined
): boolean {
  if (!toolUseId || typeof content === 'string') {
    return false;
  }

  return content.some((block) => block.type === 'tool_use' && block.id === toolUseId);
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parseJsonLikeString(value: string): unknown {
  const trimmed = value.trim();
  if (!looksLikeJsonPayload(trimmed)) {
    return null;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatTaskStatusPayload(payload: Record<string, unknown>): string | null {
  const displayId =
    typeof payload.displayId === 'string' && payload.displayId.trim().length > 0
      ? payload.displayId.trim()
      : typeof payload.id === 'string' && payload.id.trim().length > 0
        ? payload.id.trim()
        : null;
  const status =
    typeof payload.status === 'string' && payload.status.trim().length > 0
      ? payload.status.trim()
      : null;
  if (!displayId || !status) {
    return null;
  }
  return `Task ${displayId} ${status}`;
}

function formatMessageSendPayload(payload: Record<string, unknown>): string | null {
  const routing = payload.routing as Record<string, unknown> | undefined;
  const messageRecord =
    typeof payload.message === 'object' && payload.message !== null
      ? (payload.message as Record<string, unknown>)
      : undefined;
  const deliveryMessage =
    typeof payload.message === 'string' && payload.message.trim().length > 0
      ? payload.message.trim()
      : null;
  const summary =
    typeof messageRecord?.summary === 'string' && messageRecord.summary.trim().length > 0
      ? messageRecord.summary.trim()
      : typeof routing?.summary === 'string' && routing.summary.trim().length > 0
        ? routing.summary.trim()
        : null;
  const target =
    typeof messageRecord?.to === 'string' && messageRecord.to.trim().length > 0
      ? messageRecord.to.trim()
      : typeof routing?.target === 'string' && routing.target.trim().length > 0
        ? routing.target.trim()
        : null;
  const messageText =
    typeof messageRecord?.text === 'string' && messageRecord.text.trim().length > 0
      ? messageRecord.text.trim()
      : null;

  if (deliveryMessage && summary) {
    return `${deliveryMessage} - ${summary}`;
  }
  if (summary && target) {
    return `Message sent to ${target} - ${summary}`;
  }
  if (summary) {
    return summary;
  }
  if (deliveryMessage) {
    return deliveryMessage;
  }
  if (messageText && target) {
    return `Message sent to ${target} - ${messageText}`;
  }
  if (messageText) {
    return messageText;
  }
  if (target) {
    return `Message sent to ${target}`;
  }
  return null;
}

function extractBoardToolOutputText(
  toolName: string | undefined,
  parsedPayload: unknown
): string | null {
  if (!toolName || !parsedPayload || typeof parsedPayload !== 'object') {
    return null;
  }

  const normalizedToolName = canonicalizeBoardToolName(toolName) ?? toolName.trim().toLowerCase();
  const payload = unwrapAgentTeamsResponsePayload(parsedPayload as Record<string, unknown>);
  if (normalizedToolName === 'task_add_comment' || normalizedToolName === 'task_get_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (typeof comment?.text === 'string' && comment.text.trim().length > 0) {
      return comment.text;
    }
  }

  if (normalizedToolName === 'task_complete') {
    return formatTaskStatusPayload(payload) ?? 'Task completed';
  }

  if (normalizedToolName === 'sendmessage' || normalizedToolName === 'message_send') {
    return formatMessageSendPayload(payload);
  }

  if (payload.message) {
    return formatMessageSendPayload(payload);
  }

  if (payload.status) {
    return formatTaskStatusPayload(payload);
  }

  return null;
}

function unwrapAgentTeamsResponsePayload(
  payload: Record<string, unknown>
): Record<string, unknown> {
  const wrapperKey = Object.keys(payload).find(
    (key) => key.startsWith('agent_teams_') && key.endsWith('_response')
  );
  if (!wrapperKey) {
    return payload;
  }

  const nested = payload[wrapperKey];
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : payload;
}

function collectTextBlockText(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  return value
    .filter(
      (child): child is Extract<ContentBlock, { type: 'text' }> =>
        typeof child === 'object' &&
        child !== null &&
        'type' in child &&
        child.type === 'text' &&
        'text' in child &&
        typeof child.text === 'string'
    )
    .map((child) => child.text)
    .join('\n');
}

function isEmptyToolPayload(value: unknown): boolean {
  if (value == null) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim().length === 0;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  return false;
}

function inferSingleToolUseId(message: ParsedMessage): string | undefined {
  if (message.sourceToolUseID) {
    return message.sourceToolUseID;
  }

  if (message.toolResults.length === 1) {
    return message.toolResults[0]?.toolUseId;
  }

  if (!Array.isArray(message.content)) {
    return undefined;
  }

  const uniqueIds = new Set(
    message.content
      .filter(
        (block): block is Extract<ContentBlock, { type: 'tool_result' }> =>
          block.type === 'tool_result'
      )
      .map((block) => block.tool_use_id)
  );

  return uniqueIds.size === 1 ? uniqueIds.values().next().value : undefined;
}

function sanitizeToolResultContent(
  content: ContentBlock,
  canonicalToolName?: string
): ContentBlock {
  if (content.type !== 'tool_result') {
    return cloneBlock(content);
  }

  if (typeof content.content === 'string') {
    const parsedPayload = parseJsonLikeString(content.content);
    const extractedText = extractBoardToolOutputText(canonicalToolName, parsedPayload);
    if (typeof extractedText === 'string') {
      const { is_error: _isError, ...rest } = content;
      return {
        ...rest,
        content: extractedText,
      };
    }
    return parsedPayload ? { ...content, content: '' } : cloneBlock(content);
  }

  if (!Array.isArray(content.content)) {
    return cloneBlock(content);
  }

  const jsonText = content.content
    .filter((child): child is Extract<ContentBlock, { type: 'text' }> => child.type === 'text')
    .map((child) => child.text)
    .join('\n');
  const parsedPayload = parseJsonLikeString(jsonText);
  const extractedText = extractBoardToolOutputText(canonicalToolName, parsedPayload);
  if (typeof extractedText === 'string') {
    return {
      ...content,
      content: extractedText,
    };
  }

  const sanitizedChildren = content.content
    .map((child) => {
      if (child.type !== 'text') {
        return cloneBlock(child);
      }

      return looksLikeJsonPayload(child.text) ? null : cloneBlock(child);
    })
    .filter((child): child is ContentBlock => child !== null);

  if (sanitizedChildren.length === 0) {
    return {
      ...content,
      content: '',
    };
  }

  return {
    ...content,
    content: sanitizedChildren,
  };
}

function sanitizeToolResultPayloadValue(
  value: string | unknown[],
  canonicalToolName?: string
): string | unknown[] {
  if (typeof value === 'string') {
    const parsedPayload = parseJsonLikeString(value);
    const extractedText = extractBoardToolOutputText(canonicalToolName, parsedPayload);
    if (typeof extractedText === 'string') {
      return extractedText;
    }
    return parsedPayload ? '' : value;
  }

  const jsonText = collectTextBlockText(value);
  const parsedPayload = parseJsonLikeString(jsonText);
  const extractedText = extractBoardToolOutputText(canonicalToolName, parsedPayload);
  if (typeof extractedText === 'string') {
    return extractedText;
  }

  const sanitizedChildren = value
    .map((child) => {
      if (
        typeof child === 'object' &&
        child !== null &&
        'type' in child &&
        child.type === 'text' &&
        'text' in child &&
        typeof child.text === 'string'
      ) {
        return looksLikeJsonPayload(child.text) ? null : { ...child };
      }
      return child;
    })
    .filter((child) => child !== null);

  if (parsedPayload && sanitizedChildren.length === value.length) {
    return '';
  }

  return sanitizedChildren.length > 0 ? sanitizedChildren : '';
}

function hasExtractedBoardToolOutput(value: string | unknown[]): boolean {
  return typeof value === 'string' && value.trim().length > 0 && !looksLikeJsonPayload(value);
}

function sanitizeJsonLikeToolResultPayloads(
  messages: ParsedMessage[],
  canonicalToolName?: string
): ParsedMessage[] {
  return messages.map((message) => {
    let nextMessage = message;
    let toolResultsChanged = false;
    const nextToolResults = message.toolResults.map((toolResult) => {
      const nextContent = sanitizeToolResultPayloadValue(toolResult.content, canonicalToolName);
      if (JSON.stringify(nextContent) !== JSON.stringify(toolResult.content)) {
        toolResultsChanged = true;
        return {
          ...toolResult,
          content: nextContent,
          isError: hasExtractedBoardToolOutput(nextContent) ? false : toolResult.isError,
        };
      }
      return toolResult;
    });

    const rawToolUseResult = message.toolUseResult as unknown;
    if (
      rawToolUseResult &&
      typeof rawToolUseResult === 'object' &&
      !Array.isArray(rawToolUseResult)
    ) {
      const nextToolUseResult: Record<string, unknown> & {
        content?: unknown;
        message?: unknown;
      } = { ...(rawToolUseResult as Record<string, unknown>) };
      let toolUseResultChanged = false;
      const extractedFromContent =
        typeof nextToolUseResult.content === 'string'
          ? extractBoardToolOutputText(
              canonicalToolName,
              parseJsonLikeString(nextToolUseResult.content)
            )
          : null;
      const extractedFromMessage =
        typeof nextToolUseResult.message === 'string'
          ? extractBoardToolOutputText(
              canonicalToolName,
              parseJsonLikeString(nextToolUseResult.message)
            )
          : null;

      if (typeof extractedFromContent === 'string') {
        nextToolUseResult.content = extractedFromContent;
        toolUseResultChanged = true;
      }

      if (
        typeof nextToolUseResult.content === 'string' &&
        looksLikeJsonPayload(nextToolUseResult.content)
      ) {
        nextToolUseResult.content = '';
        toolUseResultChanged = true;
      }

      if (typeof extractedFromMessage === 'string') {
        nextToolUseResult.message = extractedFromMessage;
        toolUseResultChanged = true;
      }

      if (
        typeof nextToolUseResult.message === 'string' &&
        looksLikeJsonPayload(nextToolUseResult.message)
      ) {
        nextToolUseResult.message = '';
        toolUseResultChanged = true;
      }

      if (toolUseResultChanged) {
        nextMessage = {
          ...nextMessage,
          toolUseResult: nextToolUseResult,
        };
      }
    } else if (Array.isArray(rawToolUseResult)) {
      const toolUseId = inferSingleToolUseId(message);
      const jsonText = collectTextBlockText(rawToolUseResult);
      const parsedPayload = parseJsonLikeString(jsonText);
      const extractedText = extractBoardToolOutputText(canonicalToolName, parsedPayload);
      if (typeof extractedText === 'string' || parsedPayload) {
        nextMessage = {
          ...nextMessage,
          toolUseResult: {
            ...(toolUseId ? { toolUseId } : {}),
            content: typeof extractedText === 'string' ? extractedText : '',
          },
        };
      }
    }

    if (typeof message.content === 'string') {
      return nextMessage;
    }

    let changed = false;
    const nextContent = message.content.map((block) => {
      if (block.type !== 'tool_result') {
        return block;
      }

      const sanitized = sanitizeToolResultContent(block, canonicalToolName);
      if (JSON.stringify(sanitized) !== JSON.stringify(block)) {
        changed = true;
      }
      return sanitized;
    });

    if (!changed) {
      if (!toolResultsChanged) {
        return nextMessage;
      }

      return {
        ...nextMessage,
        toolResults: nextToolResults,
      };
    }

    return {
      ...nextMessage,
      content: nextContent,
      toolResults: toolResultsChanged ? nextToolResults : nextMessage.toolResults,
    };
  });
}

function hasMeaningfulToolUseResult(message: ParsedMessage): boolean {
  const rawToolUseResult = message.toolUseResult as unknown;
  if (
    !rawToolUseResult ||
    typeof rawToolUseResult !== 'object' ||
    Array.isArray(rawToolUseResult)
  ) {
    return false;
  }

  const toolUseResult = rawToolUseResult as {
    error?: unknown;
    stderr?: unknown;
    content?: unknown;
    message?: unknown;
  };
  if (typeof toolUseResult.error === 'string' && toolUseResult.error.trim().length > 0) {
    return true;
  }
  if (typeof toolUseResult.stderr === 'string' && toolUseResult.stderr.trim().length > 0) {
    return true;
  }
  if (typeof toolUseResult.content === 'string' && toolUseResult.content.trim().length > 0) {
    return true;
  }
  if (Array.isArray(toolUseResult.content) && toolUseResult.content.length > 0) {
    return true;
  }
  if (typeof toolUseResult.message === 'string' && toolUseResult.message.trim().length > 0) {
    return true;
  }
  if (Array.isArray(toolUseResult.message) && toolUseResult.message.length > 0) {
    return true;
  }
  return false;
}

function pruneEmptyInternalToolResultMessages(messages: ParsedMessage[]): ParsedMessage[] {
  return messages.filter((message) => {
    if (
      message.type !== 'user' ||
      message.toolResults.length === 0 ||
      typeof message.content === 'string'
    ) {
      return true;
    }

    const hasNonToolResultContent = message.content.some((block) => block.type !== 'tool_result');
    if (hasNonToolResultContent) {
      return true;
    }

    const allToolResultsEmpty = message.toolResults.every((toolResult) =>
      isEmptyToolPayload(toolResult.content)
    );
    if (!allToolResultsEmpty) {
      return true;
    }

    return hasMeaningfulToolUseResult(message);
  });
}

function pruneToolAnchoredAssistantOutputMessages(
  messages: ParsedMessage[],
  toolUseId: string | undefined
): ParsedMessage[] {
  if (!toolUseId) {
    return messages;
  }

  return messages.filter((message) => {
    if (message.type !== 'assistant') {
      return true;
    }
    if (message.sourceToolUseID !== toolUseId) {
      return true;
    }
    return hasToolUseBlock(message.content, toolUseId);
  });
}

function filterReadOnlySlices(slices: StreamSlice[]): StreamSlice[] {
  const participantHasNonRead = new Map<string, boolean>();

  for (const slice of slices) {
    if (slice.actionCategory && slice.actionCategory !== 'read') {
      participantHasNonRead.set(slice.participantKey, true);
    }
  }

  return slices.filter((slice) => {
    const hasNonReadForParticipant = participantHasNonRead.get(slice.participantKey) === true;
    if (!hasNonReadForParticipant) {
      return true;
    }
    return slice.actionCategory !== 'read';
  });
}

function compareCandidates(
  left: {
    id: string;
    timestamp: string;
    source: { filePath: string; sourceOrder: number; toolUseId?: string };
  },
  right: {
    id: string;
    timestamp: string;
    source: { filePath: string; sourceOrder: number; toolUseId?: string };
  }
): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (left.source.filePath !== right.source.filePath) {
    return left.source.filePath.localeCompare(right.source.filePath);
  }
  if (left.source.sourceOrder !== right.source.sourceOrder) {
    return left.source.sourceOrder - right.source.sourceOrder;
  }
  if ((left.source.toolUseId ?? '') !== (right.source.toolUseId ?? '')) {
    return (left.source.toolUseId ?? '').localeCompare(right.source.toolUseId ?? '');
  }
  return left.id.localeCompare(right.id);
}

function blockKey(block: ContentBlock): string {
  return JSON.stringify(block);
}

function cloneBlock<T extends ContentBlock>(block: T): T {
  if (block.type === 'tool_use') {
    return {
      ...block,
      input: { ...(block.input ?? {}) },
    } as T;
  }

  if (block.type === 'tool_result') {
    return {
      ...block,
      content: Array.isArray(block.content)
        ? block.content.map((child) => cloneBlock(child))
        : block.content,
    } as T;
  }

  if (block.type === 'image') {
    return {
      ...block,
      source: { ...block.source },
    } as T;
  }

  return { ...block };
}

function cloneMessageContent(content: ParsedMessage['content']): ParsedMessage['content'] {
  if (typeof content === 'string') {
    return content;
  }
  return content.map((block) => cloneBlock(block));
}

function mergeMessageContent(
  current: ParsedMessage['content'],
  incoming: ParsedMessage['content']
): ParsedMessage['content'] {
  if (typeof current === 'string') {
    return current;
  }
  if (typeof incoming === 'string') {
    return current;
  }

  const merged = current.map((block) => cloneBlock(block));
  const seen = new Set(merged.map((block) => blockKey(block)));
  for (const block of incoming) {
    const key = blockKey(block);
    if (seen.has(key)) continue;
    merged.push(cloneBlock(block));
    seen.add(key);
  }
  return merged;
}

function createAccumulator(
  message: ParsedMessage,
  firstSeenOrder: number
): MergedMessageAccumulator {
  return {
    message,
    content: cloneMessageContent(message.content),
    firstSeenOrder,
    sourceToolUseIds: new Set(message.sourceToolUseID ? [message.sourceToolUseID] : []),
    sourceToolAssistantUUIDs: new Set(
      message.sourceToolAssistantUUID ? [message.sourceToolAssistantUUID] : []
    ),
    toolUseResults: message.toolUseResult ? [message.toolUseResult] : [],
  };
}

function updateAccumulator(accumulator: MergedMessageAccumulator, message: ParsedMessage): void {
  accumulator.content = mergeMessageContent(accumulator.content, message.content);
  if (message.sourceToolUseID) {
    accumulator.sourceToolUseIds.add(message.sourceToolUseID);
  }
  if (message.sourceToolAssistantUUID) {
    accumulator.sourceToolAssistantUUIDs.add(message.sourceToolAssistantUUID);
  }
  if (message.toolUseResult) {
    accumulator.toolUseResults.push(message.toolUseResult);
  }
}

function selectSingleValue(values: Set<string>): string | undefined {
  if (values.size !== 1) return undefined;
  return values.values().next().value;
}

function selectSingleToolUseResult(values: ToolUseResultData[]): ToolUseResultData | undefined {
  if (values.length !== 1) return undefined;
  return values[0];
}

function extractToolUseIdFromToolUseResult(
  value: ToolUseResultData | undefined
): string | undefined {
  if (!value || typeof value.toolUseId !== 'string') {
    return undefined;
  }
  const trimmed = value.toolUseId.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function rebuildMergedMessage(
  accumulator: MergedMessageAccumulator,
  keptAssistantUuids: Set<string>
): ParsedMessage {
  const {
    toolCalls: _toolCalls,
    toolResults: _toolResults,
    sourceToolUseID: _sourceToolUseID,
    sourceToolAssistantUUID: _sourceToolAssistantUUID,
    toolUseResult: _toolUseResult,
    ...base
  } = accumulator.message;

  const toolCalls = extractToolCalls(accumulator.content);
  const toolResults = extractToolResults(accumulator.content);
  const singleToolUseResult = selectSingleToolUseResult(accumulator.toolUseResults);
  const derivedToolUseId =
    selectSingleValue(accumulator.sourceToolUseIds) ??
    (toolResults.length === 1 ? toolResults[0]?.toolUseId : undefined) ??
    extractToolUseIdFromToolUseResult(singleToolUseResult);
  const sourceToolAssistantUUID = selectSingleValue(accumulator.sourceToolAssistantUUIDs);
  const preservedSourceToolAssistantUUID =
    sourceToolAssistantUUID && keptAssistantUuids.has(sourceToolAssistantUUID)
      ? sourceToolAssistantUUID
      : undefined;
  const toolUseResult = singleToolUseResult;

  return {
    ...base,
    content: accumulator.content,
    toolCalls,
    toolResults,
    ...(derivedToolUseId ? { sourceToolUseID: derivedToolUseId } : {}),
    ...(preservedSourceToolAssistantUUID
      ? { sourceToolAssistantUUID: preservedSourceToolAssistantUUID }
      : {}),
    ...(toolUseResult ? { toolUseResult } : {}),
  };
}

function mergeMessages(
  details: { filePath: string; filteredMessages: ParsedMessage[] }[]
): ParsedMessage[] {
  const byMessageKey = new Map<string, MergedMessageAccumulator>();
  let order = 0;

  for (const detail of details) {
    for (const message of detail.filteredMessages) {
      const key = `${detail.filePath}:${message.uuid}`;
      const existing = byMessageKey.get(key);
      if (existing) {
        updateAccumulator(existing, message);
      } else {
        byMessageKey.set(key, createAccumulator(message, order));
        order += 1;
      }
    }
  }

  const mergedAccumulators = [...byMessageKey.values()].sort(
    (left, right) => left.firstSeenOrder - right.firstSeenOrder
  );
  const keptAssistantUuids = new Set(
    mergedAccumulators
      .filter((entry) => entry.message.type === 'assistant')
      .map((entry) => entry.message.uuid)
  );

  return mergedAccumulators.map((entry) => rebuildMergedMessage(entry, keptAssistantUuids));
}

function buildSegmentId(participantKey: string, slices: StreamSlice[]): string {
  const first = slices[0];
  const last = slices[slices.length - 1];
  return `${participantKey}:${first?.id ?? 'start'}:${last?.id ?? 'end'}`;
}

function buildToolNameByUseId(
  parsedMessagesByFile: Map<string, ParsedMessage[]>
): Map<string, string> {
  const toolNameByUseId = new Map<string, string>();

  for (const messages of parsedMessagesByFile.values()) {
    for (const message of messages) {
      for (const toolCall of message.toolCalls) {
        toolNameByUseId.set(toolCall.id, toolCall.name);
      }
    }
  }

  return toolNameByUseId;
}

function buildTaskTimeWindows(task: TeamTask, recordTimestamps: number[]): TimeWindow[] {
  const windowsFromIntervals = (Array.isArray(task.workIntervals) ? task.workIntervals : [])
    .map((interval) => {
      const startedAt = Date.parse(interval.startedAt);
      if (!Number.isFinite(startedAt)) {
        return null;
      }
      const completedAt =
        typeof interval.completedAt === 'string' ? Date.parse(interval.completedAt) : Number.NaN;
      const endMs =
        interval.completedAt === undefined
          ? null
          : (Number.isFinite(completedAt) ? Math.max(completedAt, startedAt) : startedAt) +
            INFERRED_WINDOW_GRACE_AFTER_MS;
      return {
        startMs: startedAt - INFERRED_WINDOW_GRACE_BEFORE_MS,
        endMs,
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
        startMs: startMs - INFERRED_WINDOW_GRACE_BEFORE_MS,
        endMs: Number.isFinite(updatedAtMs) ? updatedAtMs + INFERRED_WINDOW_GRACE_AFTER_MS : null,
      },
    ];
  }

  const finiteRecordTimestamps = recordTimestamps.filter((timestamp) => Number.isFinite(timestamp));
  if (finiteRecordTimestamps.length === 0) {
    return [];
  }

  return [
    {
      startMs: Math.min(...finiteRecordTimestamps) - INFERRED_RECORD_RANGE_BEFORE_MS,
      endMs: Math.max(...finiteRecordTimestamps) + INFERRED_RECORD_RANGE_AFTER_MS,
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

function collectExplicitMessageIds(records: { source: { messageUuid: string } }[]): Set<string> {
  return new Set(records.map((record) => record.source.messageUuid));
}

function collectExplicitToolUseIds(
  records: {
    source: { toolUseId?: string };
    action?: { toolUseId?: string };
  }[]
): Set<string> {
  const toolUseIds = new Set<string>();

  for (const record of records) {
    const sourceToolUseId = record.source.toolUseId?.trim();
    if (sourceToolUseId) {
      toolUseIds.add(sourceToolUseId);
    }

    const actionToolUseId = record.action?.toolUseId?.trim();
    if (actionToolUseId) {
      toolUseIds.add(actionToolUseId);
    }
  }

  return toolUseIds;
}

function collectAllowedMemberNames(
  task: TeamTask,
  records: {
    actor: { memberName?: string };
    action?: { category?: BoardTaskActivityCategory; canonicalToolName?: string };
  }[]
): Set<string> {
  const allowedNames = new Set<string>();

  if (typeof task.owner === 'string' && task.owner.trim().length > 0) {
    allowedNames.add(normalizeMemberName(task.owner));
  }

  for (const record of records) {
    const canonicalToolName = canonicalizeBoardToolName(record.action?.canonicalToolName);
    const isReadOnlyTool =
      canonicalToolName === 'task_get' || canonicalToolName === 'task_get_comment';
    if (record.action?.category === 'read' || isReadOnlyTool) {
      continue;
    }

    if (typeof record.actor.memberName === 'string' && record.actor.memberName.trim().length > 0) {
      allowedNames.add(normalizeMemberName(record.actor.memberName));
    }
  }

  return allowedNames;
}

function extractMessageToolUseIds(message: ParsedMessage): Set<string> {
  const toolUseIds = new Set<string>();

  for (const toolCall of message.toolCalls) {
    if (typeof toolCall.id === 'string' && toolCall.id.trim().length > 0) {
      toolUseIds.add(toolCall.id.trim());
    }
  }

  for (const toolResult of message.toolResults) {
    if (typeof toolResult.toolUseId === 'string' && toolResult.toolUseId.trim().length > 0) {
      toolUseIds.add(toolResult.toolUseId.trim());
    }
  }

  if (typeof message.sourceToolUseID === 'string' && message.sourceToolUseID.trim().length > 0) {
    toolUseIds.add(message.sourceToolUseID.trim());
  }

  return toolUseIds;
}

function messageHasNonBoardToolActivity(
  message: ParsedMessage,
  toolNameByUseId: Map<string, string>
): boolean {
  for (const toolCall of message.toolCalls) {
    if (!isBoardMcpToolName(toolCall.name)) {
      return true;
    }
  }

  for (const toolResult of message.toolResults) {
    if (!isBoardMcpToolName(toolNameByUseId.get(toolResult.toolUseId))) {
      return true;
    }
  }

  if (message.sourceToolUseID) {
    const sourceToolName = toolNameByUseId.get(message.sourceToolUseID);
    if (sourceToolName && !isBoardMcpToolName(sourceToolName)) {
      return true;
    }
  }

  return false;
}

function buildInferredActor(message: ParsedMessage, leadName: string): BoardTaskLogActor | null {
  const sessionId = message.sessionId?.trim();
  if (!sessionId) {
    return null;
  }

  const memberName =
    typeof message.agentName === 'string' && message.agentName.trim().length > 0
      ? message.agentName.trim()
      : undefined;

  const isLead =
    memberName != null && normalizeMemberName(memberName) === normalizeMemberName(leadName);

  return {
    ...(memberName ? { memberName } : {}),
    role: isLead ? 'lead' : memberName ? 'member' : message.isSidechain ? 'member' : 'unknown',
    sessionId,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    isSidechain: message.isSidechain,
  };
}

function compareSlices(left: StreamSlice, right: StreamSlice): number {
  const leftTs = Date.parse(left.timestamp);
  const rightTs = Date.parse(right.timestamp);
  if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
    return leftTs - rightTs;
  }
  if (left.filePath !== right.filePath) {
    return left.filePath.localeCompare(right.filePath);
  }
  if ((left.sortOrder ?? 0) !== (right.sortOrder ?? 0)) {
    return (left.sortOrder ?? 0) - (right.sortOrder ?? 0);
  }
  return left.id.localeCompare(right.id);
}

function buildOrderedParticipants(visibleSlices: StreamSlice[]): BoardTaskLogParticipant[] {
  const participantsByKey = new Map<string, BoardTaskLogParticipant>();
  const participantOrder: string[] = [];

  for (const slice of visibleSlices) {
    if (participantsByKey.has(slice.participantKey)) {
      continue;
    }
    participantsByKey.set(
      slice.participantKey,
      buildParticipant(slice.actor, slice.participantKey)
    );
    participantOrder.push(slice.participantKey);
  }

  return participantOrder
    .map((key) => participantsByKey.get(key))
    .filter((participant): participant is BoardTaskLogParticipant => Boolean(participant))
    .sort((left, right) => {
      if (left.isLead && !right.isLead) return 1;
      if (!left.isLead && right.isLead) return -1;
      return participantOrder.indexOf(left.key) - participantOrder.indexOf(right.key);
    });
}

function countSegmentsFromSlices(visibleSlices: StreamSlice[]): number {
  if (visibleSlices.length === 0) {
    return 0;
  }

  let segmentCount = 1;
  for (let index = 1; index < visibleSlices.length; index += 1) {
    if (visibleSlices[index]?.participantKey !== visibleSlices[index - 1]?.participantKey) {
      segmentCount += 1;
    }
  }

  return segmentCount;
}

function mergeParticipants(
  primary: BoardTaskLogParticipant[],
  fallback: BoardTaskLogParticipant[]
): BoardTaskLogParticipant[] {
  const participantsByKey = new Map<string, BoardTaskLogParticipant>();
  for (const participant of [...primary, ...fallback]) {
    if (!participantsByKey.has(participant.key)) {
      participantsByKey.set(participant.key, participant);
    }
  }

  return Array.from(participantsByKey.values()).sort((left, right) => {
    if (left.isLead && !right.isLead) return 1;
    if (!left.isLead && right.isLead) return -1;
    return 0;
  });
}

function mergeSegments(
  primary: BoardTaskLogSegment[],
  fallback: BoardTaskLogSegment[]
): BoardTaskLogSegment[] {
  const segmentsById = new Map<string, BoardTaskLogSegment>();
  for (const segment of [...primary, ...fallback]) {
    if (!segmentsById.has(segment.id)) {
      segmentsById.set(segment.id, segment);
    }
  }

  return Array.from(segmentsById.values()).sort((left, right) => {
    const leftTs = Date.parse(left.startTimestamp);
    const rightTs = Date.parse(right.startTimestamp);
    if (Number.isFinite(leftTs) && Number.isFinite(rightTs) && leftTs !== rightTs) {
      return leftTs - rightTs;
    }
    return left.id.localeCompare(right.id);
  });
}

function chooseDefaultFilter(participants: BoardTaskLogParticipant[]): 'all' | string {
  const namedParticipants = participants.filter((participant) => !participant.isLead);
  return namedParticipants.length === 1 ? namedParticipants[0].key : 'all';
}

function mergeRuntimeFallbackResponse(
  primary: BoardTaskLogStreamResponse,
  fallback: BoardTaskLogStreamResponse
): BoardTaskLogStreamResponse {
  const participants = mergeParticipants(primary.participants, fallback.participants);
  const source =
    fallback.source === 'codex_native_trace_fallback'
      ? 'mixed_transcript_codex_native_trace'
      : 'mixed_transcript_opencode_runtime';
  return {
    participants,
    defaultFilter: chooseDefaultFilter(participants),
    segments: mergeSegments(primary.segments, fallback.segments),
    source,
    runtimeProjection: fallback.runtimeProjection ?? primary.runtimeProjection,
  };
}

function collectNativeToolSignatures(response: BoardTaskLogStreamResponse): Set<string> {
  const signatures = new Set<string>();
  for (const segment of response.segments) {
    for (const chunk of segment.chunks) {
      const record = chunk as unknown as Record<string, unknown>;
      const toolExecutions = Array.isArray(record.toolExecutions) ? record.toolExecutions : [];
      for (const execution of toolExecutions) {
        const toolCall = (execution as Record<string, unknown>)?.toolCall as
          | { name?: string; input?: Record<string, unknown> }
          | undefined;
        const signature = buildCodexNativeToolSignature({
          toolName: toolCall?.name,
          input: toolCall?.input,
        });
        if (signature) {
          signatures.add(signature);
        }
      }
      const semanticSteps = Array.isArray(record.semanticSteps) ? record.semanticSteps : [];
      for (const step of semanticSteps) {
        const content = (step as Record<string, unknown>)?.content as
          | { toolName?: string; toolInput?: Record<string, unknown> }
          | undefined;
        const signature = buildCodexNativeToolSignature({
          toolName: content?.toolName,
          input: content?.toolInput,
        });
        if (signature) {
          signatures.add(signature);
        }
      }
    }
  }
  return signatures;
}

function collectNativeToolSignaturesFromSlices(slices: StreamSlice[]): Set<string> {
  const signatures = new Set<string>();
  for (const slice of slices) {
    for (const message of slice.filteredMessages) {
      for (const toolCall of message.toolCalls) {
        const signature = buildCodexNativeToolSignature({
          toolName: toolCall.name,
          input: toolCall.input,
        });
        if (signature) {
          signatures.add(signature);
        }
      }
    }
  }
  return signatures;
}

export class BoardTaskLogStreamService {
  private readonly layoutCache = new Map<
    string,
    {
      expiresAt: number;
      generation: number;
      layout: StreamLayout;
    }
  >();

  private readonly layoutInFlight = new Map<
    string,
    {
      generation: number;
      promise: Promise<StreamLayout>;
    }
  >();

  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly summarySelector: BoardTaskExactLogSummarySelector = new BoardTaskExactLogSummarySelector(),
    private readonly strictParser: BoardTaskExactLogStrictParser = new BoardTaskExactLogStrictParser(),
    private readonly detailSelector: BoardTaskExactLogDetailSelector = new BoardTaskExactLogDetailSelector(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder(),
    private readonly taskReader: TeamTaskReader = new TeamTaskReader(),
    private readonly transcriptSourceLocator: TeamTranscriptSourceLocator = new TeamTranscriptSourceLocator(),
    private readonly openCodeRuntimeFallbackSource: TaskLogRuntimeStreamSource = new OpenCodeTaskLogStreamSource(),
    private readonly membersMetaStore: TeamMembersMetaStore = new TeamMembersMetaStore(),
    private readonly configReader: TeamConfigReader = new TeamConfigReader(),
    private readonly codexNativeTraceFallbackSource: CodexNativeTaskLogStreamSource = new CodexNativeTaskLogStreamSource(),
    private readonly transcriptCandidateSelector: TaskLogTranscriptCandidateSelector = new TaskLogTranscriptCandidateSelector(),
    private readonly historicalBoardMcpRawProbe: HistoricalBoardMcpRawProbe = new HistoricalBoardMcpRawProbe()
  ) {}

  private readConfigForObservation(teamName: string) {
    return typeof this.configReader.getConfigSnapshot === 'function'
      ? this.configReader.getConfigSnapshot(teamName)
      : this.configReader.getConfig(teamName);
  }

  private buildLayoutCacheKey(teamName: string, taskId: string): string {
    return `${teamName}::${taskId}`;
  }

  private getTranscriptDiscoveryGeneration(teamName: string): number {
    const locator = this.transcriptSourceLocator as {
      getGeneration?: (teamName: string) => number;
    };
    return locator.getGeneration?.(teamName) ?? 0;
  }

  private async getStreamLayout(teamName: string, taskId: string): Promise<StreamLayout> {
    const cacheKey = this.buildLayoutCacheKey(teamName, taskId);
    const generation = this.getTranscriptDiscoveryGeneration(teamName);
    const cached = this.layoutCache.get(cacheKey);
    if (cached?.generation === generation && cached.expiresAt > Date.now()) {
      return cached.layout;
    }

    const existingInFlight = this.layoutInFlight.get(cacheKey);
    if (existingInFlight?.generation === generation) {
      return await existingInFlight.promise;
    }

    const startedAt = Date.now();
    let inFlightEntry: { generation: number; promise: Promise<StreamLayout> } | null = null;
    const promise = this.buildStreamLayout(teamName, taskId)
      .then((layout) => {
        if (this.getTranscriptDiscoveryGeneration(teamName) === generation) {
          this.layoutCache.set(cacheKey, {
            expiresAt: Date.now() + STREAM_LAYOUT_CACHE_TTL_MS,
            generation,
            layout,
          });
        }
        return layout;
      })
      .finally(() => {
        if (this.layoutInFlight.get(cacheKey) === inFlightEntry) {
          this.layoutInFlight.delete(cacheKey);
        }
      });

    inFlightEntry = { generation, promise };
    this.layoutInFlight.set(cacheKey, inFlightEntry);
    const layout = await promise;
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= STREAM_LAYOUT_BUILD_WARN_MS) {
      logger.warn(
        `Slow task-log stream layout: team=${teamName} task=${taskId} participants=${layout.participants.length} slices=${layout.visibleSlices.length} elapsedMs=${elapsedMs}`
      );
    }
    return layout;
  }

  private async buildInferredExecutionSlices(
    teamName: string,
    taskId: string,
    records: Awaited<ReturnType<BoardTaskActivityRecordSource['getTaskRecords']>>,
    parsedMessagesByFile: Map<string, ParsedMessage[]>
  ): Promise<StreamSlice[]> {
    if (records.some((record) => record.linkKind === 'execution')) {
      return [];
    }

    const [activeTasks, deletedTasks, transcriptContext] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.transcriptSourceLocator.getContext(teamName),
    ]);

    const task = [...activeTasks, ...deletedTasks].find((candidate) => candidate.id === taskId);
    if (!task) {
      return [];
    }

    const transcriptFiles = transcriptContext?.transcriptFiles ?? [];
    const candidateSelection = this.transcriptCandidateSelector.selectInferredNativeTranscriptFiles(
      {
        records,
        transcriptFiles,
        projectDir: transcriptContext?.projectDir,
        alreadyParsedFilePaths: new Set(parsedMessagesByFile.keys()),
      }
    );
    if (
      candidateSelection.diagnostics.finalCandidateCount >= INFERRED_CANDIDATE_SELECTION_WARN_COUNT
    ) {
      logger.warn(
        `Broad inferred native task-log candidate selection: team=${teamName} task=${taskId} files=${candidateSelection.diagnostics.finalCandidateCount} recordFiles=${candidateSelection.diagnostics.recordFileCount} sessions=${candidateSelection.diagnostics.nonReadSessionCount} reason=${candidateSelection.diagnostics.reason}`
      );
    }

    const missingFiles = candidateSelection.filePaths;
    let mergedParsedMessagesByFile = parsedMessagesByFile;
    if (missingFiles.length > 0) {
      const additionalParsedMessages = await this.strictParser.parseFiles(missingFiles);
      mergedParsedMessagesByFile = new Map([
        ...parsedMessagesByFile.entries(),
        ...additionalParsedMessages.entries(),
      ]);
    }

    const toolNameByUseId = buildToolNameByUseId(mergedParsedMessagesByFile);
    const recordTimestamps = records.map((record) => Date.parse(record.timestamp));
    const taskTimeWindows = buildTaskTimeWindows(task, recordTimestamps);
    if (taskTimeWindows.length === 0) {
      return [];
    }

    const explicitMessageIds = collectExplicitMessageIds(records);
    const explicitToolUseIds = collectExplicitToolUseIds(records);
    const allowedMemberNames = collectAllowedMemberNames(task, records);
    const leadName =
      transcriptContext?.config.members
        ?.find((member) => isLeadMemberCheck(member))
        ?.name?.trim() || 'team-lead';

    const inferredSlices: StreamSlice[] = [];
    for (const [filePath, messages] of mergedParsedMessagesByFile.entries()) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (explicitMessageIds.has(message.uuid)) {
          continue;
        }
        if (!isWithinTimeWindows(message.timestamp, taskTimeWindows)) {
          continue;
        }

        const actor = buildInferredActor(message, leadName);
        if (!actor?.memberName) {
          continue;
        }

        if (
          allowedMemberNames.size > 0 &&
          !allowedMemberNames.has(normalizeMemberName(actor.memberName))
        ) {
          continue;
        }

        const messageToolUseIds = extractMessageToolUseIds(message);
        if ([...messageToolUseIds].some((toolUseId) => explicitToolUseIds.has(toolUseId))) {
          continue;
        }
        if (!messageHasNonBoardToolActivity(message, toolNameByUseId)) {
          continue;
        }

        const inferredToolName = [...messageToolUseIds]
          .map((toolUseId) => toolNameByUseId.get(toolUseId))
          .find((toolName): toolName is string => typeof toolName === 'string');
        const sanitizedMessages = sanitizeJsonLikeToolResultPayloads([message], inferredToolName);
        const prunedMessages = pruneEmptyInternalToolResultMessages(sanitizedMessages);
        if (prunedMessages.length === 0) {
          continue;
        }

        inferredSlices.push({
          id: `inferred:${filePath}:${message.uuid}`,
          timestamp: message.timestamp.toISOString(),
          filePath,
          sortOrder: index,
          participantKey: buildParticipantKey(actor),
          actor,
          filteredMessages: prunedMessages,
        });
      }
    }

    return inferredSlices.sort(compareSlices);
  }

  private async recoverHistoricalBoardMcpRecords(
    teamName: string,
    taskId: string
  ): Promise<{
    task: TeamTask | null;
    parsedMessagesByFile: Map<string, ParsedMessage[]>;
    records: BoardTaskActivityRecord[];
  }> {
    const [activeTasks, deletedTasks, transcriptContext] = await Promise.all([
      this.taskReader.getTasks(teamName),
      this.taskReader.getDeletedTasks(teamName),
      this.transcriptSourceLocator.getContext(teamName),
    ]);

    const task =
      [...activeTasks, ...deletedTasks].find((candidate) => candidate.id === taskId) ?? null;
    const transcriptFiles = transcriptContext?.transcriptFiles ?? [];
    if (!task || transcriptFiles.length === 0) {
      return {
        task,
        parsedMessagesByFile: new Map(),
        records: [],
      };
    }

    const rawProbe = await this.historicalBoardMcpRawProbe.findCandidateFiles({
      task,
      transcriptFiles,
    });
    if (
      rawProbe.elapsedMs >= HISTORICAL_RAW_PROBE_WARN_MS ||
      rawProbe.scannedFileCount >= HISTORICAL_RAW_PROBE_WARN_FILE_COUNT
    ) {
      logger.warn(
        `Historical board MCP raw probe: team=${teamName} task=${taskId} scanned=${rawProbe.scannedFileCount} hits=${rawProbe.hitCount} elapsedMs=${rawProbe.elapsedMs}`
      );
    }
    if (rawProbe.filePaths.length === 0) {
      return {
        task,
        parsedMessagesByFile: new Map(),
        records: [],
      };
    }

    const parsedMessagesByFile = await this.strictParser.parseFiles(rawProbe.filePaths);
    const taskRefs = buildTaskReferenceSet(task);
    const leadName =
      transcriptContext?.config.members
        ?.find((member) => isLeadMemberCheck(member))
        ?.name?.trim() || 'team-lead';

    const toolCallsByUseIdByFile = new Map<
      string,
      Map<
        string,
        {
          toolName: string;
          canonicalToolName: string;
          input: Record<string, unknown>;
        }
      >
    >();

    for (const [filePath, messages] of parsedMessagesByFile.entries()) {
      const toolCallsByUseId = new Map<
        string,
        {
          toolName: string;
          canonicalToolName: string;
          input: Record<string, unknown>;
        }
      >();
      for (const message of messages) {
        for (const toolCall of message.toolCalls) {
          if (!isBoardMcpToolName(toolCall.name)) {
            continue;
          }
          const canonicalToolName = canonicalizeBoardToolName(toolCall.name);
          if (!canonicalToolName) {
            continue;
          }
          toolCallsByUseId.set(toolCall.id, {
            toolName: toolCall.name,
            canonicalToolName,
            input: toolCall.input ?? {},
          });
        }
      }
      toolCallsByUseIdByFile.set(filePath, toolCallsByUseId);
    }

    const recoveredRecords: BoardTaskActivityRecord[] = [];
    for (const [filePath, messages] of parsedMessagesByFile.entries()) {
      const toolCallsByUseId = toolCallsByUseIdByFile.get(filePath);
      if (!toolCallsByUseId) {
        continue;
      }
      const taskDisplayId = getTaskDisplayId(task);

      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index];
        if (message.type !== 'user' || message.toolResults.length === 0) {
          continue;
        }

        const baseActor = buildInferredActor(message, leadName);
        if (!baseActor) {
          continue;
        }

        for (const toolResult of message.toolResults) {
          if (toolResult.isError) {
            continue;
          }

          const toolCall = toolCallsByUseId.get(toolResult.toolUseId);
          if (!toolCall) {
            continue;
          }

          const overriddenActorName = !baseActor.memberName
            ? readHistoricalActorName(toolCall.input)
            : undefined;
          const actor: BoardTaskLogActor = overriddenActorName
            ? {
                ...baseActor,
                memberName: overriddenActorName,
                role:
                  normalizeMemberName(overriddenActorName) === normalizeMemberName(leadName)
                    ? 'lead'
                    : 'member',
              }
            : baseActor;

          const linkKind = inferHistoricalLinkKind(toolCall.canonicalToolName);
          if (!linkKind) {
            continue;
          }

          const resultPayload = resolveToolResultPayload(message, toolResult);
          if (
            !historicalBoardToolReferencesTask({
              canonicalToolName: toolCall.canonicalToolName,
              input: toolCall.input,
              resultPayload,
              taskRefs,
            })
          ) {
            continue;
          }

          const details = buildHistoricalActionDetails({
            canonicalToolName: toolCall.canonicalToolName,
            input: toolCall.input,
            resultPayload,
          });

          recoveredRecords.push({
            id: [
              'historical-board-mcp',
              filePath,
              message.uuid,
              toolResult.toolUseId,
              task.id,
            ].join(':'),
            timestamp: message.timestamp.toISOString(),
            task: {
              locator: {
                ref: taskDisplayId,
                refKind: 'display',
                canonicalId: task.id,
              },
              resolution: task.status === 'deleted' ? 'deleted' : 'resolved',
              taskRef: {
                taskId: task.id,
                displayId: taskDisplayId,
                teamName,
              },
            },
            linkKind,
            targetRole: 'subject',
            actor: {
              ...(actor.memberName ? { memberName: actor.memberName } : {}),
              role: actor.role,
              sessionId: actor.sessionId,
              ...(actor.agentId ? { agentId: actor.agentId } : {}),
              isSidechain: actor.isSidechain,
            },
            actorContext: {
              relation:
                toolCall.canonicalToolName === 'task_start' ||
                toolCall.canonicalToolName === 'review_start'
                  ? 'idle'
                  : 'same_task',
            },
            action: {
              canonicalToolName: toolCall.canonicalToolName,
              toolUseId: toolResult.toolUseId,
              category: inferHistoricalActionCategory(toolCall.canonicalToolName),
              ...(details ? { details } : {}),
            },
            source: {
              messageUuid: message.uuid,
              filePath,
              toolUseId: toolResult.toolUseId,
              sourceOrder: index + 1,
            },
          });
        }
      }
    }

    return {
      task,
      parsedMessagesByFile,
      records: recoveredRecords.sort(compareCandidates),
    };
  }

  private async buildStreamLayout(teamName: string, taskId: string): Promise<StreamLayout> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return {
        participants: [],
        visibleSlices: [],
      };
    }

    let records = await this.recordSource.getTaskRecords(teamName, taskId);
    let parsedMessagesByFile: Map<string, ParsedMessage[]> | null = null;

    if (records.length === 0) {
      const recovered = await this.recoverHistoricalBoardMcpRecords(teamName, taskId);
      if (recovered.records.length > 0) {
        records = mergeActivityRecords(records, recovered.records);
        parsedMessagesByFile = recovered.parsedMessagesByFile;
      }
    }

    if (records.length === 0) {
      return {
        participants: [],
        visibleSlices: [],
      };
    }

    const fileVersionsByPath = await getBoardTaskExactLogFileVersions(
      records.map((record) => record.source.filePath)
    );

    const candidates = this.summarySelector
      .selectSummaries({
        records,
        fileVersionsByPath,
      })
      .filter((candidate) => candidate.canLoadDetail)
      .sort(compareCandidates);

    if (candidates.length === 0) {
      return {
        participants: [],
        visibleSlices: [],
      };
    }

    const candidateFilePaths = [
      ...new Set(candidates.map((candidate) => candidate.source.filePath)),
    ].sort((left, right) => left.localeCompare(right));
    const parsedMessagesByFileForCandidates =
      parsedMessagesByFile &&
      candidateFilePaths.every((filePath) => parsedMessagesByFile?.has(filePath))
        ? parsedMessagesByFile
        : await this.strictParser.parseFiles(candidateFilePaths);

    const slices: StreamSlice[] = [];
    for (const candidate of candidates) {
      const detail = this.detailSelector.selectDetail({
        candidate,
        records,
        parsedMessagesByFile: parsedMessagesByFileForCandidates,
      });
      if (!detail || detail.filteredMessages.length === 0) {
        continue;
      }

      const filteredMessages =
        candidate.anchor.kind === 'tool'
          ? pruneToolAnchoredAssistantOutputMessages(
              detail.filteredMessages,
              candidate.anchor.toolUseId
            )
          : detail.filteredMessages;
      const sanitizedMessages = sanitizeJsonLikeToolResultPayloads(
        filteredMessages,
        candidate.canonicalToolName
      );
      const prunedMessages = pruneEmptyInternalToolResultMessages(sanitizedMessages);
      if (prunedMessages.length === 0) {
        continue;
      }

      const actor = toStreamActor(detail.actor);
      slices.push({
        id: detail.id,
        timestamp: detail.timestamp,
        filePath: detail.source.filePath,
        sortOrder: detail.source.sourceOrder,
        participantKey: buildParticipantKey(actor),
        actor,
        actionCategory: candidate.actionCategory,
        filteredMessages: prunedMessages,
      });
    }

    if (slices.length === 0) {
      return {
        participants: [],
        visibleSlices: [],
      };
    }

    const inferredExecutionSlices = await this.buildInferredExecutionSlices(
      teamName,
      taskId,
      records,
      parsedMessagesByFileForCandidates
    );
    const combinedSlices = [...slices, ...inferredExecutionSlices].sort(compareSlices);
    const deNoisedSlices = filterReadOnlySlices(combinedSlices);

    const namedParticipantSlices = deNoisedSlices.filter((slice) =>
      hasNamedParticipant(slice.actor)
    );
    const visibleSlices =
      namedParticipantSlices.length > 0 ? namedParticipantSlices : deNoisedSlices;

    return {
      participants: buildOrderedParticipants(visibleSlices),
      visibleSlices,
      shouldMergeRuntimeFallback: await this.shouldMergeRuntimeFallback(teamName, taskId, records),
    };
  }

  private async shouldMergeRuntimeFallback(
    teamName: string,
    taskId: string,
    records: BoardTaskActivityRecord[]
  ): Promise<boolean> {
    try {
      const [activeTasks, deletedTasks, metaMembers, config] = await Promise.all([
        this.taskReader.getTasks(teamName).catch(() => []),
        this.taskReader.getDeletedTasks(teamName).catch(() => []),
        this.membersMetaStore.getMembers(teamName).catch(() => []),
        this.readConfigForObservation(teamName).catch(() => null),
      ]);
      const task = [...activeTasks, ...deletedTasks].find((candidate) => candidate.id === taskId);
      const ownerName = task?.owner?.trim();
      if (!ownerName) {
        return false;
      }

      const normalizedOwner = normalizeMemberName(ownerName);
      const hasOwnerExecution = records.some(
        (record) =>
          record.linkKind === 'execution' &&
          normalizeMemberName(record.actor.memberName ?? '') === normalizedOwner
      );
      if (hasOwnerExecution) {
        return false;
      }

      const member = [...metaMembers, ...(config?.members ?? [])].find(
        (candidate) => normalizeMemberName(candidate.name) === normalizedOwner
      );
      return member?.providerId === 'opencode';
    } catch {
      return false;
    }
  }

  private async loadOpenCodeRuntimeFallback(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskLogStreamResponse | null> {
    const startedAt = Date.now();
    const fallback = await this.openCodeRuntimeFallbackSource.getTaskLogStream(teamName, taskId);
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= RUNTIME_FALLBACK_WARN_MS) {
      logger.warn(
        `Slow task-log runtime fallback: team=${teamName} task=${taskId} hit=${Boolean(
          fallback
        )} elapsedMs=${elapsedMs}`
      );
    }
    return fallback;
  }

  private async loadCodexNativeTraceFallback(
    teamName: string,
    taskId: string,
    excludeNativeToolSignatures?: ReadonlySet<string>
  ): Promise<BoardTaskLogStreamResponse | null> {
    const startedAt = Date.now();
    const fallback = await this.codexNativeTraceFallbackSource.getTaskLogStream(teamName, taskId, {
      excludeNativeToolSignatures,
    });
    const elapsedMs = Date.now() - startedAt;
    if (elapsedMs >= RUNTIME_FALLBACK_WARN_MS) {
      logger.warn(
        `Slow task-log Codex native trace fallback: team=${teamName} task=${taskId} hit=${Boolean(
          fallback
        )} elapsedMs=${elapsedMs}`
      );
    }
    return fallback;
  }

  async getTaskLogStreamSummary(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskLogStreamSummary> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return emptySummary();
    }

    const layout = await this.getStreamLayout(teamName, taskId);
    if (layout.visibleSlices.length === 0) {
      const codexFallback = await this.loadCodexNativeTraceFallback(teamName, taskId);
      if (codexFallback) {
        return { segmentCount: codexFallback.segments.length };
      }
      const runtimeFallback = await this.loadOpenCodeRuntimeFallback(teamName, taskId);
      return runtimeFallback ? { segmentCount: runtimeFallback.segments.length } : emptySummary();
    }

    const codexFallback = await this.loadCodexNativeTraceFallback(
      teamName,
      taskId,
      collectNativeToolSignaturesFromSlices(layout.visibleSlices)
    );
    return {
      segmentCount:
        countSegmentsFromSlices(layout.visibleSlices) + (codexFallback?.segments.length ?? 0),
    };
  }

  async getTaskLogStream(teamName: string, taskId: string): Promise<BoardTaskLogStreamResponse> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return emptyResponse();
    }

    const layout = await this.getStreamLayout(teamName, taskId);
    if (layout.visibleSlices.length === 0) {
      const codexFallback = await this.loadCodexNativeTraceFallback(teamName, taskId);
      if (codexFallback) {
        return codexFallback;
      }
      const fallback = await this.loadOpenCodeRuntimeFallback(teamName, taskId);
      return fallback ?? emptyResponse();
    }

    const segments: BoardTaskLogSegment[] = [];
    let currentSegmentSlices: StreamSlice[] = [];

    const flushSegment = (): void => {
      if (currentSegmentSlices.length === 0) return;
      const participantKey = currentSegmentSlices[0].participantKey;
      const actor = currentSegmentSlices[0].actor;
      const mergedMessages = mergeMessages(
        currentSegmentSlices.map((slice) => ({
          filePath: slice.filePath,
          filteredMessages: slice.filteredMessages,
        }))
      );
      const cleanedMessages = pruneEmptyInternalToolResultMessages(mergedMessages);
      if (cleanedMessages.length === 0) {
        currentSegmentSlices = [];
        return;
      }
      const chunks = this.chunkBuilder.buildBundleChunks(
        retainSyntheticToolUseAssistants(cleanedMessages)
      );
      if (chunks.length > 0) {
        segments.push({
          id: buildSegmentId(participantKey, currentSegmentSlices),
          participantKey,
          actor,
          startTimestamp: currentSegmentSlices[0].timestamp,
          endTimestamp: currentSegmentSlices[currentSegmentSlices.length - 1].timestamp,
          chunks,
        });
      }
      currentSegmentSlices = [];
    };

    for (const slice of layout.visibleSlices) {
      if (
        currentSegmentSlices.length > 0 &&
        currentSegmentSlices[0].participantKey !== slice.participantKey
      ) {
        flushSegment();
      }
      currentSegmentSlices.push(slice);
    }
    flushSegment();

    let primaryResponse: BoardTaskLogStreamResponse = {
      participants: layout.participants,
      defaultFilter: chooseDefaultFilter(layout.participants),
      segments,
      source: 'transcript',
    };

    if (layout.shouldMergeRuntimeFallback) {
      const fallback = await this.loadOpenCodeRuntimeFallback(teamName, taskId);
      if (fallback) {
        primaryResponse = mergeRuntimeFallbackResponse(primaryResponse, fallback);
      }
    }

    const codexFallback = await this.loadCodexNativeTraceFallback(
      teamName,
      taskId,
      collectNativeToolSignatures(primaryResponse)
    );
    if (codexFallback) {
      primaryResponse = mergeRuntimeFallbackResponse(primaryResponse, codexFallback);
    }

    return primaryResponse;
  }
}
