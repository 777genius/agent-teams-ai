/**
 * ProcessLinker service - Links subagent processes to AI chunks.
 *
 * Uses deterministic parentTaskId matching only. If a subagent has no parentTaskId
 * or it doesn't match any Task call in the chunk, the subagent is NOT linked.
 * No timing-based or positional fallbacks — avoids false positives.
 */

import { type EnhancedAIChunk, type Process } from '@main/types';

/**
 * Link processes to a single AI chunk via deterministic parentTaskId matching.
 *
 * Only links subagents whose parentTaskId matches a Task tool_use ID in the chunk.
 * Subagents without parentTaskId or with non-matching parentTaskId are skipped.
 */
export function linkProcessesToAIChunk(chunk: EnhancedAIChunk, subagents: Process[]): void {
  // Build set of Task tool IDs from this chunk's responses
  const chunkTaskIds = new Set<string>();
  for (const response of chunk.responses) {
    for (const toolCall of response.toolCalls) {
      if (toolCall.isTask) {
        chunkTaskIds.add(toolCall.id);
      }
    }
  }

  // Deterministic linking: Match subagents to Task calls by parentTaskId only
  for (const subagent of subagents) {
    if (subagent.parentTaskId && chunkTaskIds.has(subagent.parentTaskId)) {
      chunk.processes.push(subagent);
    }
  }

  chunk.processes.sort((a, b) => a.startTime.getTime() - b.startTime.getTime());
}
