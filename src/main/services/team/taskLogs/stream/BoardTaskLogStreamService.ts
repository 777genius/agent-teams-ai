import { extractToolCalls, extractToolResults } from '@main/utils/toolExtraction';

import { BoardTaskActivityRecordSource } from '../activity/BoardTaskActivityRecordSource';
import { BoardTaskExactLogChunkBuilder } from '../exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogDetailSelector } from '../exact/BoardTaskExactLogDetailSelector';
import { BoardTaskExactLogStrictParser } from '../exact/BoardTaskExactLogStrictParser';
import { BoardTaskExactLogSummarySelector } from '../exact/BoardTaskExactLogSummarySelector';
import { isBoardTaskExactLogsReadEnabled } from '../exact/featureGates';
import { getBoardTaskExactLogFileVersions } from '../exact/fileVersions';

import type { BoardTaskExactLogDetailCandidate } from '../exact/BoardTaskExactLogTypes';
import type { ContentBlock, ParsedMessage, ToolUseResultData } from '@main/types';
import type {
  BoardTaskActivityCategory,
  BoardTaskLogActor,
  BoardTaskLogParticipant,
  BoardTaskLogSegment,
  BoardTaskLogStreamResponse,
} from '@shared/types';

interface StreamSlice {
  id: string;
  timestamp: string;
  filePath: string;
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

function emptyResponse(): BoardTaskLogStreamResponse {
  return {
    participants: [],
    defaultFilter: 'all',
    segments: [],
  };
}

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
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

function extractBoardToolOutputText(
  toolName: string | undefined,
  parsedPayload: unknown
): string | null {
  if (!toolName || !parsedPayload || typeof parsedPayload !== 'object') {
    return null;
  }

  const payload = parsedPayload as Record<string, unknown>;
  if (toolName === 'task_add_comment' || toolName === 'task_get_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (typeof comment?.text === 'string' && comment.text.trim().length > 0) {
      return comment.text;
    }
  }

  return null;
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
      return {
        ...content,
        content: [{ type: 'text', text: extractedText }],
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

function sanitizeJsonLikeToolResultPayloads(
  messages: ParsedMessage[],
  canonicalToolName?: string
): ParsedMessage[] {
  return messages.map((message) => {
    let nextMessage = message;

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
      return nextMessage;
    }

    return {
      ...nextMessage,
      content: nextContent,
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

export class BoardTaskLogStreamService {
  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly summarySelector: BoardTaskExactLogSummarySelector = new BoardTaskExactLogSummarySelector(),
    private readonly strictParser: BoardTaskExactLogStrictParser = new BoardTaskExactLogStrictParser(),
    private readonly detailSelector: BoardTaskExactLogDetailSelector = new BoardTaskExactLogDetailSelector(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder()
  ) {}

  async getTaskLogStream(teamName: string, taskId: string): Promise<BoardTaskLogStreamResponse> {
    if (!isBoardTaskExactLogsReadEnabled()) {
      return emptyResponse();
    }

    const records = await this.recordSource.getTaskRecords(teamName, taskId);
    if (records.length === 0) {
      return emptyResponse();
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
      return emptyResponse();
    }

    const parsedMessagesByFile = await this.strictParser.parseFiles(
      candidates.map((candidate) => candidate.source.filePath)
    );

    const slices: StreamSlice[] = [];
    for (const candidate of candidates) {
      const detail = this.detailSelector.selectDetail({
        candidate,
        records,
        parsedMessagesByFile,
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
        participantKey: buildParticipantKey(actor),
        actor,
        actionCategory: candidate.actionCategory,
        filteredMessages: prunedMessages,
      });
    }

    if (slices.length === 0) {
      return emptyResponse();
    }

    const deNoisedSlices = filterReadOnlySlices(slices);

    const namedParticipantSlices = deNoisedSlices.filter((slice) =>
      hasNamedParticipant(slice.actor)
    );
    const visibleSlices =
      namedParticipantSlices.length > 0 ? namedParticipantSlices : deNoisedSlices;

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

    const orderedParticipants = participantOrder
      .map((key) => participantsByKey.get(key))
      .filter((participant): participant is BoardTaskLogParticipant => Boolean(participant))
      .sort((left, right) => {
        if (left.isLead && !right.isLead) return 1;
        if (!left.isLead && right.isLead) return -1;
        return participantOrder.indexOf(left.key) - participantOrder.indexOf(right.key);
      });

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
      const chunks = this.chunkBuilder.buildBundleChunks(cleanedMessages);
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

    for (const slice of visibleSlices) {
      if (
        currentSegmentSlices.length > 0 &&
        currentSegmentSlices[0].participantKey !== slice.participantKey
      ) {
        flushSegment();
      }
      currentSegmentSlices.push(slice);
    }
    flushSegment();

    const namedParticipants = orderedParticipants.filter((participant) => !participant.isLead);
    const defaultFilter = namedParticipants.length === 1 ? namedParticipants[0].key : 'all';

    return {
      participants: orderedParticipants,
      defaultFilter,
      segments,
    };
  }
}
