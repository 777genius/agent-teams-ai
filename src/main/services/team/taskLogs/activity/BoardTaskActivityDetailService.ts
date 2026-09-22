import { isEnhancedAIChunk } from '@main/types';
import {
  describeBoardTaskActivityLabel,
  formatBoardTaskActivityTaskLabel,
} from '@shared/utils/boardTaskActivityLabels';
import {
  describeBoardTaskActivityActorLabel,
  describeBoardTaskActivityContextLines,
} from '@shared/utils/boardTaskActivityPresentation';

import { BoardTaskExactLogChunkBuilder } from '../exact/BoardTaskExactLogChunkBuilder';
import { BoardTaskExactLogDetailSelector } from '../exact/BoardTaskExactLogDetailSelector';
import { BoardTaskExactLogStrictParser } from '../exact/BoardTaskExactLogStrictParser';

import { BoardTaskActivityRecordSource } from './BoardTaskActivityRecordSource';

import type { BoardTaskExactLogBundleCandidate } from '../exact/BoardTaskExactLogTypes';
import type { BoardTaskActivityRecord } from './BoardTaskActivityRecord';
import type { ContentBlock, EnhancedChunk, ParsedMessage, ToolUseResultData } from '@main/types';
import type {
  BoardTaskActivityDetail,
  BoardTaskActivityDetailMetadataRow,
  BoardTaskActivityDetailResult,
} from '@shared/types';

const READ_ONLY_TOOL_NAMES = new Set(['task_get', 'task_get_comment']);

function scopeLabel(record: BoardTaskActivityRecord): string {
  switch (record.actorContext.relation) {
    case 'same_task':
      return 'same task';
    case 'other_active_task':
      return 'other active task';
    case 'idle':
      return 'idle';
    case 'ambiguous':
      return 'ambiguous';
    default:
      return record.actorContext.relation;
  }
}

function formatTaskLabelOrLocator(record: BoardTaskActivityRecord['task']): string {
  return formatBoardTaskActivityTaskLabel(record) ?? `#${record.locator.ref}`;
}

function relationshipValue(record: BoardTaskActivityRecord): string | null {
  const relationship = record.action?.details?.relationship;
  const peerTaskLabel = formatBoardTaskActivityTaskLabel(record.action?.peerTask);

  if (relationship && peerTaskLabel) {
    return `${relationship} ${peerTaskLabel}`;
  }
  if (relationship) {
    return relationship;
  }
  if (peerTaskLabel) {
    return peerTaskLabel;
  }
  return null;
}

function buildMetadataRows(record: BoardTaskActivityRecord): BoardTaskActivityDetailMetadataRow[] {
  const rows: BoardTaskActivityDetailMetadataRow[] = [
    {
      label: 'Task',
      value: formatTaskLabelOrLocator(record.task),
    },
    {
      label: 'Scope',
      value: scopeLabel(record),
    },
  ];

  if (record.action?.canonicalToolName) {
    rows.push({ label: 'Tool', value: record.action.canonicalToolName });
  }
  if (record.action?.details?.status) {
    rows.push({ label: 'Status', value: record.action.details.status });
  }
  if ('owner' in (record.action?.details ?? {})) {
    rows.push({ label: 'Owner', value: record.action?.details?.owner ?? 'cleared' });
  }
  if ('clarification' in (record.action?.details ?? {})) {
    rows.push({
      label: 'Clarification',
      value: record.action?.details?.clarification ?? 'cleared',
    });
  }
  if (record.action?.details?.reviewer) {
    rows.push({ label: 'Reviewer', value: record.action.details.reviewer });
  }
  if (record.action?.details?.commentId) {
    rows.push({ label: 'Comment', value: record.action.details.commentId });
  }
  if (record.action?.details?.attachmentId) {
    rows.push({ label: 'Attachment ID', value: record.action.details.attachmentId });
  }
  if (record.action?.details?.filename) {
    rows.push({ label: 'File', value: record.action.details.filename });
  }
  const relationship = relationshipValue(record);
  if (relationship) {
    rows.push({ label: 'Relationship', value: relationship });
  }
  const activeTaskLabel = formatBoardTaskActivityTaskLabel(record.actorContext.activeTask);
  if (activeTaskLabel) {
    rows.push({ label: 'Active task', value: activeTaskLabel });
  }
  if (record.actorContext.activePhase) {
    rows.push({ label: 'Phase', value: record.actorContext.activePhase });
  }

  return rows;
}

function buildCandidate(record: BoardTaskActivityRecord): BoardTaskExactLogBundleCandidate {
  return {
    id: `activity:${record.id}`,
    timestamp: record.timestamp,
    actor: record.actor,
    source: {
      filePath: record.source.filePath,
      messageUuid: record.source.messageUuid,
      ...(record.source.toolUseId ? { toolUseId: record.source.toolUseId } : {}),
      sourceOrder: record.source.sourceOrder,
    },
    records: [record],
    anchor: record.source.toolUseId
      ? {
          kind: 'tool',
          filePath: record.source.filePath,
          messageUuid: record.source.messageUuid,
          toolUseId: record.source.toolUseId,
        }
      : {
          kind: 'message',
          filePath: record.source.filePath,
          messageUuid: record.source.messageUuid,
        },
    actionLabel: describeBoardTaskActivityLabel(record),
    ...(record.action?.category ? { actionCategory: record.action.category } : {}),
    ...(record.action?.canonicalToolName
      ? { canonicalToolName: record.action.canonicalToolName }
      : {}),
    linkKinds: [record.linkKind],
    targetRoles: [record.targetRole],
    canLoadDetail: false,
  };
}

function shouldIncludeLinkedTool(record: BoardTaskActivityRecord): boolean {
  const toolName = record.action?.canonicalToolName;
  if (!record.source.toolUseId || !toolName) {
    return false;
  }

  return !READ_ONLY_TOOL_NAMES.has(toolName);
}

function looksLikeJsonPayload(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function parseJsonLikeString(value: string): unknown {
  if (!looksLikeJsonPayload(value)) {
    return null;
  }

  try {
    return JSON.parse(value);
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

  const payload = unwrapAgentTeamsResponsePayload(parsedPayload as Record<string, unknown>);
  if (toolName === 'task_add_comment' || toolName === 'task_get_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    if (typeof comment?.text === 'string' && comment.text.trim().length > 0) {
      return comment.text;
    }
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

  const jsonText = collectTextBlockText(content.content);
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
          toolUseResult: nextToolUseResult as ToolUseResultData,
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

function hasToolUseBlock(
  content: ParsedMessage['content'],
  toolUseId: string | undefined
): boolean {
  if (!toolUseId || typeof content === 'string') {
    return false;
  }

  return content.some((block) => block.type === 'tool_use' && block.id === toolUseId);
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

function sanitizeDetailMessages(
  messages: ParsedMessage[],
  canonicalToolName: string | undefined,
  toolUseId: string | undefined
): ParsedMessage[] {
  return pruneEmptyInternalToolResultMessages(
    pruneToolAnchoredAssistantOutputMessages(
      sanitizeJsonLikeToolResultPayloads(messages, canonicalToolName),
      toolUseId
    )
  );
}

function hasUsefulLinkedToolChunks(chunks: EnhancedChunk[]): boolean {
  return chunks.some((chunk) => isEnhancedAIChunk(chunk) && chunk.toolExecutions.length > 0);
}

export class BoardTaskActivityDetailService {
  constructor(
    private readonly recordSource: BoardTaskActivityRecordSource = new BoardTaskActivityRecordSource(),
    private readonly strictParser: BoardTaskExactLogStrictParser = new BoardTaskExactLogStrictParser(),
    private readonly detailSelector: BoardTaskExactLogDetailSelector = new BoardTaskExactLogDetailSelector(),
    private readonly chunkBuilder: BoardTaskExactLogChunkBuilder = new BoardTaskExactLogChunkBuilder()
  ) {}

  async getTaskActivityDetail(
    teamName: string,
    taskId: string,
    activityId: string
  ): Promise<BoardTaskActivityDetailResult> {
    const records = await this.recordSource.getTaskRecords(teamName, taskId);
    const record = records.find((candidate) => candidate.id === activityId);
    if (!record) {
      return { status: 'missing' };
    }

    const detail: BoardTaskActivityDetail = {
      entryId: record.id,
      summaryLabel: describeBoardTaskActivityLabel(record),
      actorLabel: describeBoardTaskActivityActorLabel(record.actor),
      timestamp: record.timestamp,
      contextLines: describeBoardTaskActivityContextLines(record),
      metadataRows: buildMetadataRows(record),
    };

    if (shouldIncludeLinkedTool(record)) {
      const parsedMessagesByFile = await this.strictParser.parseFiles([record.source.filePath]);
      const detailCandidate = this.detailSelector.selectDetail({
        candidate: buildCandidate(record),
        records,
        parsedMessagesByFile,
      });

      if (detailCandidate) {
        const filteredMessages = sanitizeDetailMessages(
          detailCandidate.filteredMessages,
          record.action?.canonicalToolName,
          record.source.toolUseId
        );
        const chunks = this.chunkBuilder.buildBundleChunks(filteredMessages);
        if (chunks.length > 0 && hasUsefulLinkedToolChunks(chunks)) {
          detail.logDetail = {
            id: detailCandidate.id,
            chunks,
          };
        }
      }
    }

    return {
      status: 'ok',
      detail,
    };
  }
}
