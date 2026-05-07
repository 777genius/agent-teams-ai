import { sanitizeDisplayContent } from '@shared/utils/contentSanitizer';

import type {
  OpenCodeRuntimeTranscriptLogContentBlock,
  OpenCodeRuntimeTranscriptLogMessage,
} from '../../../runtime/ClaudeMultimodelBridgeService';
import type { ContentBlock, ParsedMessage, ToolUseResultData } from '@main/types';

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

export function mapOpenCodeRuntimeTranscriptLogMessageToParsedMessage(
  message: OpenCodeRuntimeTranscriptLogMessage
): ParsedMessage | null {
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

export function mapOpenCodeRuntimeTranscriptMessagesToParsedMessages(
  messages: readonly OpenCodeRuntimeTranscriptLogMessage[]
): ParsedMessage[] {
  return messages
    .map(mapOpenCodeRuntimeTranscriptLogMessageToParsedMessage)
    .filter((message): message is ParsedMessage => message !== null);
}
