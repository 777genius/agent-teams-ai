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

interface ToolAnchorScope {
  toolUseId?: string;
  assistantUuids: Set<string>;
  outputMessageUuids: Set<string>;
}

function messageHasToolUse(message: ParsedMessage, toolUseId: string | undefined): boolean {
  if (!toolUseId || message.type !== 'assistant' || typeof message.content === 'string') {
    return false;
  }
  return message.content.some((block) => block.type === 'tool_use' && block.id === toolUseId);
}

function messageHasToolResult(message: ParsedMessage, toolUseId: string | undefined): boolean {
  if (!toolUseId || typeof message.content === 'string') {
    return false;
  }
  return message.content.some(
    (block) => block.type === 'tool_result' && block.tool_use_id === toolUseId
  );
}

function buildToolAnchorScope(args: {
  candidate: BoardTaskExactLogBundleCandidate;
  parsedMessages: ParsedMessage[];
  explicitMessageIds: Set<string>;
}): ToolAnchorScope {
  const toolUseId =
    args.candidate.anchor.kind === 'tool' ? args.candidate.anchor.toolUseId : undefined;
  const assistantUuids = new Set<string>();
  const outputMessageUuids = new Set<string>();
  if (!toolUseId) {
    return { assistantUuids, outputMessageUuids };
  }

  const messagesByUuid = new Map(args.parsedMessages.map((message) => [message.uuid, message]));
  const messageIndexByUuid = new Map(
    args.parsedMessages.map((message, index) => [message.uuid, index])
  );

  const addMatchingAssistant = (uuid: string | null | undefined): void => {
    if (!uuid) {
      return;
    }
    const message = messagesByUuid.get(uuid);
    if (message && messageHasToolUse(message, toolUseId)) {
      assistantUuids.add(message.uuid);
    }
  };

  const addNearestPreviousMatchingAssistant = (message: ParsedMessage): void => {
    const startIndex = messageIndexByUuid.get(message.uuid);
    if (startIndex === undefined) {
      return;
    }

    for (let index = startIndex - 1; index >= 0; index -= 1) {
      const candidate = args.parsedMessages[index];
      if (!candidate) {
        continue;
      }
      if (candidate.type !== 'assistant') {
        continue;
      }
      if (messageHasToolUse(candidate, toolUseId)) {
        assistantUuids.add(candidate.uuid);
      }
      return;
    }
  };

  addMatchingAssistant(args.candidate.anchor.messageUuid);
  for (const explicitMessageId of args.explicitMessageIds) {
    const message = messagesByUuid.get(explicitMessageId);
    if (!message) {
      continue;
    }
    addMatchingAssistant(message.uuid);
    addMatchingAssistant(message.sourceToolAssistantUUID);
    addMatchingAssistant(message.parentUuid);
    if (message.type === 'user' && messageHasToolResult(message, toolUseId)) {
      addNearestPreviousMatchingAssistant(message);
    }
  }

  let previousAssistantUuid: string | undefined;
  for (const message of args.parsedMessages) {
    const referencesTool =
      message.sourceToolUseID === toolUseId || messageHasToolResult(message, toolUseId);
    if (
      referencesTool &&
      ((message.sourceToolAssistantUUID !== undefined &&
        assistantUuids.has(message.sourceToolAssistantUUID)) ||
        (message.parentUuid !== null &&
          message.parentUuid !== undefined &&
          assistantUuids.has(message.parentUuid)) ||
        (message.sourceToolAssistantUUID === undefined &&
          (message.parentUuid === null || message.parentUuid === undefined) &&
          previousAssistantUuid !== undefined &&
          assistantUuids.has(previousAssistantUuid)))
    ) {
      outputMessageUuids.add(message.uuid);
    }

    if (message.type === 'assistant') {
      previousAssistantUuid = message.uuid;
    }
  }

  return { toolUseId, assistantUuids, outputMessageUuids };
}

function isToolLinkedMessage(message: ParsedMessage, scope: ToolAnchorScope): boolean {
  const { toolUseId } = scope;
  if (!toolUseId) {
    return false;
  }

  const hasScopedAssistant = scope.assistantUuids.size > 0;
  if (scope.outputMessageUuids.has(message.uuid)) {
    return true;
  }

  if (message.type === 'assistant' && messageHasToolUse(message, toolUseId)) {
    return !hasScopedAssistant || scope.assistantUuids.has(message.uuid);
  }

  const referencesTool =
    message.sourceToolUseID === toolUseId || messageHasToolResult(message, toolUseId);
  if (!referencesTool) {
    return false;
  }

  if (!hasScopedAssistant) {
    return true;
  }

  return (
    (message.sourceToolAssistantUUID !== undefined &&
      scope.assistantUuids.has(message.sourceToolAssistantUUID)) ||
    (message.parentUuid !== null &&
      message.parentUuid !== undefined &&
      scope.assistantUuids.has(message.parentUuid))
  );
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
  toolAnchorScope: ToolAnchorScope;
}): TentativeFilteredMessage | null {
  const { message, candidate, explicitMessageIds, toolAnchorScope } = args;
  const explicitMessageLinked = explicitMessageIds.has(message.uuid);
  const toolUseId = candidate.anchor.kind === 'tool' ? candidate.anchor.toolUseId : undefined;
  const toolLinked = isToolLinkedMessage(message, toolAnchorScope);

  if (!explicitMessageLinked && !toolLinked) {
    return null;
  }

  if (typeof message.content === 'string') {
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
      explicitMessageLinked || toolLinked
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
    const toolAnchorScope = buildToolAnchorScope({
      candidate,
      parsedMessages,
      explicitMessageIds,
    });
    const tentative: TentativeFilteredMessage[] = [];

    for (const message of parsedMessages) {
      const filtered = filterMessageForCandidate({
        message,
        candidate,
        explicitMessageIds,
        toolAnchorScope,
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
