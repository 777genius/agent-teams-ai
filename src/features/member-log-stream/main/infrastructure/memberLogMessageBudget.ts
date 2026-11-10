import type { MemberLogStreamBudget } from '../../core/domain/models/MemberLogStreamBudget';
import type { ContentBlock, ParsedMessage, ToolResult, ToolUseResultData } from '@main/types';

export interface MessageBudgetResult {
  messages: ParsedMessage[];
  droppedMessageCount: number;
  segmentWindowLimited: boolean;
  contentLimited: boolean;
}

const CONTENT_LIMIT_SUFFIX = '\n\n[content truncated by member log stream budget]';
const TOOL_RESULT_ID_KEYS = new Set([
  'id',
  'toolUseId',
  'tool_use_id',
  'sourceToolUseID',
  'sourceToolAssistantUUID',
  'uuid',
  'parentUuid',
]);

function truncateString(value: string, limit: number): { value: string; truncated: boolean } {
  if (value.length <= limit) {
    return { value, truncated: false };
  }
  const allowed = Math.max(0, limit - CONTENT_LIMIT_SUFFIX.length);
  return { value: `${value.slice(0, allowed)}${CONTENT_LIMIT_SUFFIX}`, truncated: true };
}

function buildAssistantToolUseIds(messages: readonly ParsedMessage[]): Set<string> {
  const ids = new Set<string>();
  for (const message of messages) {
    if (message.type !== 'assistant') {
      continue;
    }
    for (const toolCall of message.toolCalls) {
      ids.add(toolCall.id);
    }
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          ids.add(block.id);
        }
      }
    }
  }
  return ids;
}

function dropOrphanToolResults(messages: readonly ParsedMessage[]): ParsedMessage[] {
  const assistantToolUseIds = buildAssistantToolUseIds(messages);
  return messages.filter((message) => {
    if (!message.isMeta && message.toolResults.length === 0 && !message.sourceToolUseID) {
      return true;
    }
    const toolUseIds = [
      message.sourceToolUseID,
      ...message.toolResults.map((toolResult) => toolResult.toolUseId),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    if (toolUseIds.length === 0) {
      return true;
    }
    return toolUseIds.some((toolUseId) => assistantToolUseIds.has(toolUseId));
  });
}

function trimMessageWindow(
  messages: readonly ParsedMessage[],
  maxMessages: number
): { messages: ParsedMessage[]; droppedMessageCount: number; limited: boolean } {
  if (messages.length <= maxMessages) {
    return { messages: [...messages], droppedMessageCount: 0, limited: false };
  }
  const sliced = messages.slice(-maxMessages);
  const paired = dropOrphanToolResults(sliced);
  return {
    messages: paired,
    droppedMessageCount: messages.length - paired.length,
    limited: true,
  };
}

function truncateContentBlock(
  block: ContentBlock,
  budget: MemberLogStreamBudget,
  total: { remaining: number }
): { block: ContentBlock; truncated: boolean } {
  if (total.remaining <= 0) {
    if (block.type === 'text') {
      return { block: { ...block, text: CONTENT_LIMIT_SUFFIX.trim() }, truncated: true };
    }
    if (block.type === 'thinking') {
      return { block: { ...block, thinking: CONTENT_LIMIT_SUFFIX.trim() }, truncated: true };
    }
    if (block.type === 'tool_result') {
      return { block: { ...block, content: CONTENT_LIMIT_SUFFIX.trim() }, truncated: true };
    }
    return { block, truncated: false };
  }

  if (block.type === 'text') {
    const limit = Math.min(budget.maxMessageContentChars, total.remaining);
    const truncated = truncateString(block.text, limit);
    total.remaining -= truncated.value.length;
    return { block: { ...block, text: truncated.value }, truncated: truncated.truncated };
  }

  if (block.type === 'thinking') {
    const limit = Math.min(budget.maxMessageContentChars, total.remaining);
    const truncated = truncateString(block.thinking, limit);
    total.remaining -= truncated.value.length;
    return { block: { ...block, thinking: truncated.value }, truncated: truncated.truncated };
  }

  if (block.type === 'tool_result') {
    if (typeof block.content === 'string') {
      const limit = Math.min(budget.maxToolResultContentChars, total.remaining);
      const truncated = truncateString(block.content, limit);
      total.remaining -= truncated.value.length;
      return { block: { ...block, content: truncated.value }, truncated: truncated.truncated };
    }
    const nested = block.content.map((item) => truncateContentBlock(item, budget, total));
    return {
      block: { ...block, content: nested.map((item) => item.block) },
      truncated: nested.some((item) => item.truncated),
    };
  }

  return { block, truncated: false };
}

function truncateToolResult(
  toolResult: ToolResult,
  budget: MemberLogStreamBudget,
  total: { remaining: number }
): { toolResult: ToolResult; truncated: boolean } {
  if (typeof toolResult.content !== 'string') {
    return { toolResult, truncated: false };
  }
  const limit = Math.min(budget.maxToolResultContentChars, Math.max(0, total.remaining));
  const truncated = truncateString(toolResult.content, limit);
  total.remaining -= truncated.value.length;
  return {
    toolResult: { ...toolResult, content: truncated.value },
    truncated: truncated.truncated,
  };
}

function truncateUnknownToolResultValue(
  value: unknown,
  budget: MemberLogStreamBudget,
  total: { remaining: number },
  key?: string
): { value: unknown; truncated: boolean } {
  if (typeof value === 'string') {
    if (key && TOOL_RESULT_ID_KEYS.has(key)) {
      return { value, truncated: false };
    }
    const limit = Math.min(budget.maxToolResultContentChars, Math.max(0, total.remaining));
    const truncated = truncateString(value, limit);
    total.remaining = Math.max(0, total.remaining - truncated.value.length);
    return { value: truncated.value, truncated: truncated.truncated };
  }

  if (Array.isArray(value)) {
    let truncated = false;
    const mapped = value.map((item) => {
      const result = truncateUnknownToolResultValue(item, budget, total);
      truncated = truncated || result.truncated;
      return result.value;
    });
    return { value: mapped, truncated };
  }

  if (value && typeof value === 'object') {
    let truncated = false;
    const mapped: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      const result = truncateUnknownToolResultValue(childValue, budget, total, childKey);
      truncated = truncated || result.truncated;
      mapped[childKey] = result.value;
    }
    return { value: mapped, truncated };
  }

  return { value, truncated: false };
}

function truncateToolUseResult(
  toolUseResult: ToolUseResultData | undefined,
  budget: MemberLogStreamBudget,
  total: { remaining: number }
): { toolUseResult: ToolUseResultData | undefined; truncated: boolean } {
  if (!toolUseResult) {
    return { toolUseResult, truncated: false };
  }
  const result = truncateUnknownToolResultValue(toolUseResult, budget, total);
  return {
    toolUseResult: result.value as ToolUseResultData,
    truncated: result.truncated,
  };
}

function truncateMessageContent(
  message: ParsedMessage,
  budget: MemberLogStreamBudget,
  total: { remaining: number }
): { message: ParsedMessage; truncated: boolean } {
  let truncated = false;
  let content: ParsedMessage['content'];
  if (typeof message.content === 'string') {
    const limit = Math.min(budget.maxMessageContentChars, Math.max(0, total.remaining));
    const result = truncateString(message.content, limit);
    total.remaining -= result.value.length;
    truncated = result.truncated;
    content = result.value;
  } else {
    const mapped = message.content.map((block) => truncateContentBlock(block, budget, total));
    truncated = mapped.some((item) => item.truncated);
    content = mapped.map((item) => item.block);
  }

  const toolResults = message.toolResults.map((toolResult) =>
    truncateToolResult(toolResult, budget, total)
  );
  const toolUseResult = truncateToolUseResult(message.toolUseResult, budget, total);

  return {
    message: {
      ...message,
      content,
      toolResults: toolResults.map((item) => item.toolResult),
      ...(toolUseResult.toolUseResult ? { toolUseResult: toolUseResult.toolUseResult } : {}),
    },
    truncated: truncated || toolResults.some((item) => item.truncated) || toolUseResult.truncated,
  };
}

export function applyMemberLogMessageBudget(
  messages: readonly ParsedMessage[],
  budget: MemberLogStreamBudget
): MessageBudgetResult {
  const windowed = trimMessageWindow(messages, budget.maxMessagesPerSegment);
  const total = { remaining: budget.maxTotalContentChars };
  const truncated = windowed.messages.map((message) =>
    truncateMessageContent(message, budget, total)
  );
  return {
    messages: truncated.map((item) => item.message),
    droppedMessageCount: windowed.droppedMessageCount,
    segmentWindowLimited: windowed.limited,
    contentLimited: truncated.some((item) => item.truncated),
  };
}
