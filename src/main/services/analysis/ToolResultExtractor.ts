/**
 * ToolResultExtractor service - Extracts tool results from messages.
 *
 * Provides utilities for:
 * - Building tool_use maps for linking results to calls
 * - Building tool_result maps for token estimation
 * - Estimating token counts from content
 * - Extracting tool results from various message formats
 */

import { isToolResultContent, type ParsedMessage } from '@main/types';
import { countContentTokens } from '@main/utils/tokenizer';

// =============================================================================
// Types
// =============================================================================

/**
 * Extracted tool result information for trigger matching.
 */
export interface ExtractedToolResult {
  toolUseId: string;
  isError: boolean;
  content: string | unknown[];
  toolName?: string;
}

/**
 * Tool use information from assistant messages.
 */
export interface ToolUseInfo {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Tool result information for token estimation.
 */
export interface ToolResultInfo {
  content: string | unknown[];
  isError: boolean;
}

// =============================================================================
// Map Building
// =============================================================================

/**
 * Builds a map of tool_use_id to tool_use content.
 * This allows linking tool_results back to their tool_use calls to check tool names.
 */
export function buildToolUseMap(messages: ParsedMessage[]): Map<string, ToolUseInfo> {
  const map = new Map<string, ToolUseInfo>();

  for (const message of messages) {
    if (message.type !== 'assistant') continue;

    // Check content array for tool_use blocks
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type === 'tool_use') {
          const toolUse = block;
          map.set(toolUse.id, {
            name: toolUse.name,
            input: toolUse.input || {},
          });
        }
      }
    }

    // Also check toolCalls if present
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        map.set(toolCall.id, {
          name: toolCall.name,
          input: toolCall.input || {},
        });
      }
    }
  }

  return map;
}

/**
 * Builds a map of tool_use_id to tool_result content.
 * Used for estimating output tokens per tool_use.
 */
export function buildToolResultMap(messages: ParsedMessage[]): Map<string, ToolResultInfo> {
  const map = new Map<string, ToolResultInfo>();

  for (const message of messages) {
    // Check content array for tool_result blocks
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isToolResultContent(block)) {
          map.set(block.tool_use_id, {
            content: block.content,
            isError: block.is_error === true,
          });
        }
      }
    }

    // Also check toolResults array if present
    if (message.toolResults) {
      for (const toolResult of message.toolResults) {
        map.set(toolResult.toolUseId, {
          content: toolResult.content,
          isError: toolResult.isError === true,
        });
      }
    }

    // Also check toolUseResult if present (enriched data)
    if (message.toolUseResult && message.sourceToolUseID) {
      const content = extractContentFromToolUseResult(message.toolUseResult);
      const isError =
        message.toolUseResult.isError === true || message.toolUseResult.is_error === true;
      map.set(message.sourceToolUseID, { content, isError });
    }
  }

  return map;
}

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimates token count from content using the shared tokenizer.
 * Uses the same calculation as ChunkBuilder for consistency with UI display.
 */
export function estimateTokens(content: string | unknown[] | Record<string, unknown>): number {
  if (typeof content === 'string') {
    return countContentTokens(content);
  }
  // For objects/arrays, use countContentTokens which handles JSON.stringify
  return countContentTokens(content as unknown[]);
}

// =============================================================================
// Tool Result Extraction
// =============================================================================

/**
 * Extracts content string from toolUseResult.
 */
function extractContentFromToolUseResult(toolUseResult: Record<string, unknown>): string {
  if (typeof toolUseResult.error === 'string') {
    return toolUseResult.error;
  }
  if (typeof toolUseResult.stderr === 'string' && toolUseResult.stderr.trim()) {
    return toolUseResult.stderr;
  }
  if (typeof toolUseResult.content === 'string') {
    return toolUseResult.content;
  }
  if (typeof toolUseResult.message === 'string') {
    return toolUseResult.message;
  }
  return '';
}

/**
 * Extracts tool results from a message.
 * Handles multiple patterns of tool result storage.
 *
 * @param message - The parsed message to extract from
 * @param findToolNameFn - Function to find tool name by tool use ID
 */
export function extractToolResults(
  message: ParsedMessage,
  findToolNameFn: (message: ParsedMessage, toolUseId: string) => string | null
): ExtractedToolResult[] {
  const results: ExtractedToolResult[] = [];

  // Pattern 1: Check toolResults array on ParsedMessage
  if (message.toolResults && message.toolResults.length > 0) {
    for (const toolResult of message.toolResults) {
      results.push({
        toolUseId: toolResult.toolUseId,
        isError: toolResult.isError === true,
        content: toolResult.content,
        toolName: findToolNameFn(message, toolResult.toolUseId) ?? undefined,
      });
    }
  }

  // Pattern 2: Check toolUseResult field (enriched data from entry)
  if (message.toolUseResult) {
    const toolUseResult = message.toolUseResult;
    const hasError = toolUseResult.isError === true || toolUseResult.is_error === true;
    const toolUseId =
      (typeof toolUseResult.toolUseId === 'string' ? toolUseResult.toolUseId : undefined) ??
      message.sourceToolUseID;

    if (toolUseId) {
      results.push({
        toolUseId,
        isError: hasError,
        content: extractContentFromToolUseResult(toolUseResult),
        toolName: typeof toolUseResult.toolName === 'string' ? toolUseResult.toolName : undefined,
      });
    }
  }

  // Pattern 3: Check content blocks for tool_result
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isToolResultContent(block)) {
        results.push({
          toolUseId: block.tool_use_id,
          isError: block.is_error === true,
          content: block.content,
          toolName: findToolNameFn(message, block.tool_use_id) ?? undefined,
        });
      }
    }
  }

  return results;
}
