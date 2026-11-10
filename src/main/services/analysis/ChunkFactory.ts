/**
 * ChunkFactory service - Creates individual chunk objects from messages.
 *
 * Responsibilities:
 * - Build UserChunk from user messages
 * - Build SystemChunk from command output messages
 * - Build CompactChunk from summary messages
 * - Build AIChunk from buffered AI messages
 * - Calculate timing and metrics for chunks
 */

import {
  type EnhancedAIChunk,
  type EnhancedCompactChunk,
  type EnhancedSystemChunk,
  type EnhancedUserChunk,
  type ParsedMessage,
  type Process,
} from '@main/types';
import { calculateStepContext } from '@main/utils/contextAccumulator';
import { calculateMetrics } from '@main/utils/jsonl';
import { fillTimelineGaps } from '@main/utils/timelineGapFilling';

import { linkProcessesToAIChunk } from './ProcessLinker';
import { extractSemanticStepsFromAIChunk } from './SemanticStepExtractor';
import { buildSemanticStepGroups } from './SemanticStepGrouper';
import { buildToolExecutions } from './ToolExecutionBuilder';

/**
 * Generate a stable chunk ID based on message UUID.
 * Using the message UUID ensures IDs are consistent across re-parses.
 */
function generateStableChunkId(prefix: string, message: ParsedMessage): string {
  return `${prefix}-${message.uuid}`;
}

/**
 * Build a UserChunk from a user message.
 */
export function buildUserChunk(message: ParsedMessage): EnhancedUserChunk {
  const id = generateStableChunkId('user', message);
  const metrics = calculateMetrics([message]);

  return {
    id,
    chunkType: 'user',
    userMessage: message,
    startTime: message.timestamp,
    endTime: message.timestamp,
    durationMs: 0,
    metrics,
    rawMessages: [message],
  };
}

/**
 * Build a SystemChunk from a command output message.
 */
export function buildSystemChunk(message: ParsedMessage): EnhancedSystemChunk {
  const id = generateStableChunkId('system', message);
  const commandOutput = extractCommandOutput(message);
  const metrics = calculateMetrics([message]);

  return {
    id,
    chunkType: 'system',
    message,
    commandOutput,
    startTime: message.timestamp,
    endTime: message.timestamp,
    durationMs: 0,
    metrics,
    rawMessages: [message],
  };
}

/**
 * Build a CompactChunk from a compact summary message.
 */
export function buildCompactChunk(message: ParsedMessage): EnhancedCompactChunk {
  const id = generateStableChunkId('compact', message);
  const metrics = calculateMetrics([message]);

  return {
    id,
    chunkType: 'compact',
    message,
    startTime: message.timestamp,
    endTime: message.timestamp,
    durationMs: 0,
    metrics,
    rawMessages: [message],
  };
}

/**
 * Extract command output from <local-command-stdout> tag.
 */
function extractCommandOutput(message: ParsedMessage): string {
  const content = typeof message.content === 'string' ? message.content : '';
  const match = /<local-command-stdout>([\s\S]*?)<\/local-command-stdout>/.exec(content);
  const matchStderr = /<local-command-stderr>([\s\S]*?)<\/local-command-stderr>/.exec(content);
  if (match) {
    return match[1];
  }
  if (matchStderr) {
    return matchStderr[1];
  }
  return content;
}

/**
 * Build an AIChunk from buffered AI messages.
 */
export function buildAIChunkFromBuffer(
  responses: ParsedMessage[],
  subagents: Process[],
  allMessages: ParsedMessage[]
): EnhancedAIChunk {
  // Use first response message's UUID for stable ID
  const id =
    responses.length > 0 ? generateStableChunkId('ai', responses[0]) : `ai-empty-${Date.now()}`; // Fallback for edge case
  const { startTime, endTime, durationMs } = calculateAIChunkTiming(responses);
  const metrics = calculateMetrics(responses);
  const toolExecutions = buildToolExecutions(responses);

  // Collect sidechain messages for this time range
  const sidechainMessages = collectSidechainMessages(allMessages, startTime, endTime);

  const chunk: EnhancedAIChunk = {
    id,
    chunkType: 'ai',
    responses,
    startTime,
    endTime,
    durationMs,
    metrics,
    processes: [],
    sidechainMessages,
    toolExecutions,
    semanticSteps: [],
    rawMessages: responses,
  };

  // Link processes to this chunk
  linkProcessesToAIChunk(chunk, subagents);

  // Extract semantic steps using the extracted module
  chunk.semanticSteps = extractSemanticStepsFromAIChunk(chunk);
  chunk.semanticSteps = fillTimelineGaps({
    steps: chunk.semanticSteps,
    chunkStartTime: chunk.startTime,
    chunkEndTime: chunk.endTime,
  });
  calculateStepContext(chunk.semanticSteps, chunk.rawMessages);
  chunk.semanticStepGroups = buildSemanticStepGroups(chunk.semanticSteps);

  return chunk;
}

/**
 * Calculate timing for AI chunks (responses only, no user message).
 */
function calculateAIChunkTiming(responses: ParsedMessage[]): {
  startTime: Date;
  endTime: Date;
  durationMs: number;
} {
  if (responses.length === 0) {
    const now = new Date();
    return { startTime: now, endTime: now, durationMs: 0 };
  }

  const startTime = responses[0].timestamp;
  let endTime = startTime;
  for (const resp of responses) {
    if (resp.timestamp > endTime) {
      endTime = resp.timestamp;
    }
  }

  return {
    startTime,
    endTime,
    durationMs: endTime.getTime() - startTime.getTime(),
  };
}

/**
 * Collect sidechain messages in a time range.
 */
function collectSidechainMessages(
  messages: ParsedMessage[],
  startTime: Date,
  endTime: Date | undefined
): ParsedMessage[] {
  return messages.filter((m) => {
    if (!m.isSidechain) return false;
    if (m.timestamp < startTime) return false;
    if (endTime && m.timestamp >= endTime) return false;
    return true;
  });
}
