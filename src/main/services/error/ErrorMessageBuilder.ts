/**
 * ErrorMessageBuilder service - Builds error messages and DetectedError objects.
 *
 * Provides utilities for:
 * - Extracting error messages from tool results
 * - Finding tool names by ID
 * - Creating DetectedError objects
 * - Truncating messages for display
 */

import { type ContentBlock, type ParsedMessage } from '@main/types';
import { randomUUID } from 'crypto';

import { type ExtractedToolResult } from '../analysis/ToolResultExtractor';

import type { TriggerColor } from '@shared/constants/triggerColors';

// =============================================================================
// Types
// =============================================================================

/**
 * Represents a detected error from a Claude Code session.
 */
export interface DetectedError {
  /** UUID for unique identification */
  id: string;
  /** Unix timestamp when error was detected */
  timestamp: number;
  /** Session ID where error occurred */
  sessionId: string;
  /** Project ID (encoded directory name) */
  projectId: string;
  /** Path to the JSONL file */
  filePath: string;
  /** Source of the error - tool name or 'assistant' */
  source: string;
  /** Error message content */
  message: string;
  /** Line number in JSONL for deep linking */
  lineNumber?: number;
  /** Tool use ID for precise deep linking to the specific tool item */
  toolUseId?: string;
  /** Subagent ID when error originates from a subagent session */
  subagentId?: string;
  /** Trigger color key for notification dot and highlight */
  triggerColor?: TriggerColor;
  /** ID of the trigger that produced this notification */
  triggerId?: string;
  /** Human-readable name of the trigger that produced this notification */
  triggerName?: string;
  /** Notification domain: 'error' (default/undefined) or 'team' */
  category?: 'error' | 'team';
  /** For team notifications: specific event sub-type */
  teamEventType?:
    | 'rate_limit'
    | 'lead_inbox'
    | 'user_inbox'
    | 'task_clarification'
    | 'task_status_change'
    | 'task_comment'
    | 'schedule_completed'
    | 'schedule_failed';
  /** Explicit key for storage deduplication. Two notifications with the same dedupeKey won't be stored twice. */
  dedupeKey?: string;
  /** Additional context about the error */
  context: {
    /** Human-readable project name */
    projectName: string;
    /** Current working directory when error occurred */
    cwd?: string;
  };
}

/**
 * Parameters for creating a DetectedError.
 */
export interface CreateDetectedErrorParams {
  sessionId: string;
  projectId: string;
  filePath: string;
  projectName: string;
  lineNumber: number;
  source: string;
  message: string;
  timestamp: Date;
  cwd?: string;
  toolUseId?: string;
  subagentId?: string;
  triggerColor?: TriggerColor;
  triggerId?: string;
  triggerName?: string;
}

// =============================================================================
// Error Message Extraction
// =============================================================================

/**
 * Extracts error message from a tool result.
 */
export function extractErrorMessage(result: ExtractedToolResult): string {
  if (typeof result.content === 'string') {
    return result.content.trim() || 'Unknown error';
  }

  if (Array.isArray(result.content)) {
    const texts: string[] = [];
    for (const item of result.content) {
      if (item && typeof item === 'object' && 'type' in item) {
        const block = item as ContentBlock;
        if (block.type === 'text' && 'text' in block) {
          texts.push(block.text);
        }
      }
    }
    return texts.join('\n').trim() || 'Unknown error';
  }

  return 'Unknown error';
}

// =============================================================================
// Tool Name Lookup
// =============================================================================

/**
 * Finds tool name from message's tool calls by tool use ID.
 */
function findToolName(message: ParsedMessage, toolUseId: string): string | null {
  if (message.toolCalls) {
    const toolCall = message.toolCalls.find((tc) => tc.id === toolUseId);
    if (toolCall) {
      return toolCall.name;
    }
  }
  return null;
}

/**
 * Finds tool name by searching tool_use_id in the message context.
 */
export function findToolNameByToolUseId(message: ParsedMessage, toolUseId: string): string | null {
  // First check toolCalls
  const fromToolCalls = findToolName(message, toolUseId);
  if (fromToolCalls) return fromToolCalls;

  // Check sourceToolUseID if this message is a tool result
  if (message.sourceToolUseID === toolUseId && message.toolUseResult) {
    if (typeof message.toolUseResult.toolName === 'string') {
      return message.toolUseResult.toolName;
    }
  }

  return null;
}

// =============================================================================
// Message Truncation
// =============================================================================

/**
 * Truncates error message to a reasonable length for display.
 */
function truncateMessage(message: string, maxLength: number = 500): string {
  if (message.length <= maxLength) {
    return message;
  }
  return message.slice(0, maxLength) + '...';
}

// =============================================================================
// DetectedError Creation
// =============================================================================

/**
 * Creates a DetectedError object with all required fields.
 */
export function createDetectedError(params: CreateDetectedErrorParams): DetectedError {
  return {
    id: randomUUID(),
    timestamp: params.timestamp.getTime(),
    sessionId: params.sessionId,
    projectId: params.projectId,
    filePath: params.filePath,
    source: params.source,
    message: truncateMessage(params.message),
    lineNumber: params.lineNumber,
    toolUseId: params.toolUseId,
    subagentId: params.subagentId,
    triggerColor: params.triggerColor,
    triggerId: params.triggerId,
    triggerName: params.triggerName,
    context: {
      projectName: params.projectName,
      cwd: params.cwd,
    },
  };
}
