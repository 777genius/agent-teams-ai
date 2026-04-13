import { extractToolCalls, extractToolResults } from '@main/utils/toolExtraction';
import { createLogger } from '@shared/utils/logger';

import type { BoardTaskActivityRecord } from '../activity/BoardTaskActivityRecord';
import type {
  BoardTaskExactLogBundleCandidate,
  BoardTaskExactLogDetailCandidate,
} from './BoardTaskExactLogTypes';
import type { ContentBlock, ParsedMessage } from '@main/types';

const logger = createLogger('Service:BoardTaskExactLogDetailSelector');

interface TentativeFilteredMessage {
  original: ParsedMessage;
  filteredContent: ParsedMessage['content'];
  matchedToolUseId?: string;
}

function isToolAnchoredOutputMessage(
  message: ParsedMessage,
  toolUseId: string | undefined
): boolean {
  return Boolean(toolUseId && message.sourceToolUseID === toolUseId);
}

function noteExactDiagnostic(
  event: string,
  details: Record<string, string | number | undefined> = {}
): void {
  const suffix = Object.entries(details)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(' ');

  logger.debug(`[board_task_exact_logs.${event}]${suffix ? ` ${suffix}` : ''}`);
}

function keepExplicitTextualBlock(block: ContentBlock): boolean {
  return block.type === 'text' || block.type === 'image';
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

function filterAssistantContent(
  content: ContentBlock[],
  toolUseId: string | undefined,
  explicitMessageLinked: boolean
): ContentBlock[] {
  const kept: ContentBlock[] = [];

  for (const block of content) {
    if (block.type === 'tool_use') {
      if (toolUseId && block.id === toolUseId) {
        kept.push(cloneBlock(block));
      }
      continue;
    }

    if (block.type === 'thinking') {
      continue;
    }

    if (explicitMessageLinked && keepExplicitTextualBlock(block)) {
      kept.push(cloneBlock(block));
    }
  }

  return kept;
}

function filterUserArrayContent(
  content: ContentBlock[],
  toolUseId: string | undefined,
  explicitMessageLinked: boolean
): ContentBlock[] {
  const kept: ContentBlock[] = [];

  for (const block of content) {
    if (block.type === 'tool_result') {
      if (toolUseId && block.tool_use_id === toolUseId) {
        kept.push(cloneBlock(block));
      }
      continue;
    }

    if (explicitMessageLinked && keepExplicitTextualBlock(block)) {
      kept.push(cloneBlock(block));
    }
  }

  return kept;
}

function filterMessageForCandidate(args: {
  message: ParsedMessage;
  candidate: BoardTaskExactLogBundleCandidate;
  explicitMessageIds: Set<string>;
}): TentativeFilteredMessage | null {
  const { message, candidate, explicitMessageIds } = args;
  const explicitMessageLinked = explicitMessageIds.has(message.uuid);
  const toolUseId = candidate.anchor.kind === 'tool' ? candidate.anchor.toolUseId : undefined;
  const anchoredOutputLinked = isToolAnchoredOutputMessage(message, toolUseId);

  if (typeof message.content === 'string') {
    if (!explicitMessageLinked && !anchoredOutputLinked) {
      return null;
    }
    return {
      original: message,
      filteredContent: message.content,
      ...(toolUseId ? { matchedToolUseId: toolUseId } : {}),
    };
  }

  let filteredBlocks: ContentBlock[] = [];
  if (message.type === 'assistant') {
    filteredBlocks = filterAssistantContent(
      message.content,
      toolUseId,
      explicitMessageLinked || anchoredOutputLinked
    );
  } else if (message.type === 'user') {
    filteredBlocks = filterUserArrayContent(message.content, toolUseId, explicitMessageLinked);
  } else {
    filteredBlocks = explicitMessageLinked
      ? message.content.filter(keepExplicitTextualBlock).map((block) => cloneBlock(block))
      : [];
  }

  if (filteredBlocks.length === 0) {
    return null;
  }

  return {
    original: message,
    filteredContent: filteredBlocks,
    ...(toolUseId ? { matchedToolUseId: toolUseId } : {}),
  };
}

function rebuildParsedMessage(
  message: ParsedMessage,
  filteredContent: ParsedMessage['content'],
  keptAssistantUuids: Set<string>,
  matchedToolUseId?: string
): ParsedMessage {
  const {
    toolCalls: _originalToolCalls,
    toolResults: _originalToolResults,
    sourceToolUseID: _originalSourceToolUseID,
    sourceToolAssistantUUID: _originalSourceToolAssistantUUID,
    toolUseResult: _originalToolUseResult,
    ...baseMessage
  } = message;
  const toolCalls = extractToolCalls(filteredContent);
  const toolResults = extractToolResults(filteredContent);
  const singleToolResult = toolResults.length === 1 ? toolResults[0] : undefined;
  const matchedToolUseResultId =
    message.toolUseResult &&
    typeof message.toolUseResult.toolUseId === 'string' &&
    message.toolUseResult.toolUseId === matchedToolUseId
      ? matchedToolUseId
      : undefined;
  const matchedSourceToolUseId =
    matchedToolUseId &&
    (message.sourceToolUseID === matchedToolUseId ||
      singleToolResult?.toolUseId === matchedToolUseId ||
      matchedToolUseResultId === matchedToolUseId)
      ? matchedToolUseId
      : undefined;
  const matchedSourceToolAssistantUUID =
    matchedToolUseId &&
    message.sourceToolAssistantUUID &&
    keptAssistantUuids.has(message.sourceToolAssistantUUID)
      ? message.sourceToolAssistantUUID
      : undefined;
  const toolUseResult =
    matchedToolUseId &&
    matchedSourceToolUseId === matchedToolUseId &&
    singleToolResult?.toolUseId === matchedToolUseId
      ? message.toolUseResult
      : undefined;

  return {
    ...baseMessage,
    content: filteredContent,
    toolCalls,
    toolResults,
    ...(matchedSourceToolUseId ? { sourceToolUseID: matchedSourceToolUseId } : {}),
    ...(matchedSourceToolAssistantUUID
      ? { sourceToolAssistantUUID: matchedSourceToolAssistantUUID }
      : {}),
    ...(toolUseResult ? { toolUseResult } : {}),
  };
}

function anchorEvidenceRank(message: ParsedMessage, toolUseId: string | undefined): number {
  if (message.type !== 'assistant' || !toolUseId) {
    return 0;
  }

  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.id === toolUseId) {
        return 2;
      }
    }
  }

  return message.sourceToolUseID === toolUseId ? 1 : 0;
}

function deduplicateAssistantMessagesByRequestId(
  messages: ParsedMessage[],
  toolUseId: string | undefined
): ParsedMessage[] {
  const preferredAssistantIndexByRequestId = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.type === 'assistant' && message.requestId) {
      const existingIndex = preferredAssistantIndexByRequestId.get(message.requestId);
      if (existingIndex === undefined) {
        preferredAssistantIndexByRequestId.set(message.requestId, i);
        continue;
      }

      const existingRank = anchorEvidenceRank(messages[existingIndex], toolUseId);
      const nextRank = anchorEvidenceRank(message, toolUseId);
      if (nextRank > existingRank || (nextRank === existingRank && i > existingIndex)) {
        preferredAssistantIndexByRequestId.set(message.requestId, i);
      }
    }
  }

  if (preferredAssistantIndexByRequestId.size === 0) {
    return messages;
  }

  return messages.filter((message, index) => {
    if (message.type !== 'assistant' || !message.requestId) {
      return true;
    }
    return preferredAssistantIndexByRequestId.get(message.requestId) === index;
  });
}

function sanitizeSourceAssistantLinks(messages: ParsedMessage[]): ParsedMessage[] {
  const keptAssistantUuids = new Set(
    messages.filter((message) => message.type === 'assistant').map((message) => message.uuid)
  );

  return messages.map((message) => {
    if (
      !message.sourceToolAssistantUUID ||
      keptAssistantUuids.has(message.sourceToolAssistantUUID)
    ) {
      return message;
    }

    const { sourceToolAssistantUUID: _ignored, ...rest } = message;
    return rest;
  });
}

export class BoardTaskExactLogDetailSelector {
  selectDetail(args: {
    candidate: BoardTaskExactLogBundleCandidate;
    records: BoardTaskActivityRecord[];
    parsedMessagesByFile: Map<string, ParsedMessage[]>;
  }): BoardTaskExactLogDetailCandidate | null {
    const { candidate, records, parsedMessagesByFile } = args;
    const relevantRecords = records.filter((record) =>
      candidate.records.some((row) => row.id === record.id)
    );
    if (relevantRecords.length === 0) {
      noteExactDiagnostic('missing_records_for_detail', { id: candidate.id });
      return null;
    }

    const parsedMessages = parsedMessagesByFile.get(candidate.source.filePath);
    if (!parsedMessages || parsedMessages.length === 0) {
      noteExactDiagnostic('missing_parsed_messages', { filePath: candidate.source.filePath });
      return null;
    }

    const explicitMessageIds = new Set(relevantRecords.map((record) => record.source.messageUuid));
    const tentative: TentativeFilteredMessage[] = [];

    for (const message of parsedMessages) {
      const filtered = filterMessageForCandidate({
        message,
        candidate,
        explicitMessageIds,
      });
      if (filtered) {
        tentative.push(filtered);
      }
    }

    if (tentative.length === 0) {
      noteExactDiagnostic('empty_filtered_bundle', { id: candidate.id });
      return null;
    }

    const keptAssistantUuids = new Set(
      tentative
        .filter((entry) => entry.original.type === 'assistant')
        .map((entry) => entry.original.uuid)
    );

    const rebuilt = tentative.map((entry) =>
      rebuildParsedMessage(
        entry.original,
        entry.filteredContent,
        keptAssistantUuids,
        entry.matchedToolUseId
      )
    );

    const deduped = deduplicateAssistantMessagesByRequestId(
      rebuilt,
      candidate.anchor.kind === 'tool' ? candidate.anchor.toolUseId : undefined
    );
    const sanitized = sanitizeSourceAssistantLinks(deduped);
    if (sanitized.length === 0) {
      noteExactDiagnostic('empty_deduped_bundle', { id: candidate.id });
      return null;
    }

    return {
      id: candidate.id,
      timestamp: candidate.timestamp,
      actor: candidate.actor,
      source: candidate.source,
      records: candidate.records,
      filteredMessages: sanitized,
    };
  }
}
