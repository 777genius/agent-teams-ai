/**
 * ToolExecutionBuilder - Builds tool execution tracking from messages.
 *
 * Matches tool calls with their results using:
 * 1. sourceToolUseID for accurate internal user message matching
 * 2. toolResults array fallback for other patterns
 */

import type { ParsedMessage, ToolCall, ToolExecution } from '@main/types';

/**
 * Build tool execution tracking from messages.
 * Enhanced to use sourceToolUseID for more accurate matching.
 */
export function buildToolExecutions(messages: ParsedMessage[]): ToolExecution[] {
  const executions: ToolExecution[] = [];
  const toolCallMap = new Map<string, { call: ToolCall; startTime: Date }>();

  // First pass: collect all tool calls
  for (const msg of messages) {
    for (const toolCall of msg.toolCalls) {
      toolCallMap.set(toolCall.id, {
        call: toolCall,
        startTime: msg.timestamp,
      });
    }
  }

  // Second pass: match with results and build executions
  // Try sourceToolUseID first (most accurate), then fall back to toolResults array
  for (const msg of messages) {
    // Check if this message has a sourceToolUseID (internal user messages)
    if (msg.sourceToolUseID) {
      const callInfo = toolCallMap.get(msg.sourceToolUseID);
      if (callInfo && msg.toolResults.length > 0) {
        // Use the first tool result for this internal user message
        const result = msg.toolResults[0];
        executions.push({
          toolCall: callInfo.call,
          result,
          startTime: callInfo.startTime,
          endTime: msg.timestamp,
          durationMs: msg.timestamp.getTime() - callInfo.startTime.getTime(),
        });
      }
    }

    // Also check toolResults array for any results not matched above
    for (const result of msg.toolResults) {
      // Skip if already matched via sourceToolUseID
      const alreadyMatched = executions.some((e) => e.result?.toolUseId === result.toolUseId);
      if (alreadyMatched) continue;

      const callInfo = toolCallMap.get(result.toolUseId);
      if (callInfo) {
        executions.push({
          toolCall: callInfo.call,
          result,
          startTime: callInfo.startTime,
          endTime: msg.timestamp,
          durationMs: msg.timestamp.getTime() - callInfo.startTime.getTime(),
        });
      }
    }
  }

  // Add calls without results
  for (const [id, callInfo] of toolCallMap) {
    const hasResult = executions.some((e) => e.toolCall.id === id);
    if (!hasResult) {
      executions.push({
        toolCall: callInfo.call,
        startTime: callInfo.startTime,
      });
    }
  }

  // Sort by start time
  executions.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());

  return executions;
}
