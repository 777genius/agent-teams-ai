/**
 * Tool Token Utilities
 *
 * Functions for estimating and calculating token counts for tool operations.
 */

import { estimateTokens } from '@shared/utils/tokenFormatting';

import type { ItemStatus } from '@renderer/components/chat/items/BaseItem';
import type { LinkedToolItem } from '@renderer/types/groups';

/**
 * Calculates total context tokens consumed by a tool operation.
 */
export function getToolContextTokens(linkedTool: LinkedToolItem): number {
  let totalTokens = 0;

  // Tool CALL tokens (what Claude generated)
  if (linkedTool.callTokens !== undefined) {
    totalTokens += linkedTool.callTokens;
  } else {
    // Fallback: estimate from input
    totalTokens += estimateTokens(JSON.stringify(linkedTool.input));
  }

  // Tool RESULT tokens (what Claude reads back)
  if (linkedTool.result?.tokenCount !== undefined) {
    totalTokens += linkedTool.result.tokenCount;
  } else if (linkedTool.result?.content) {
    const content = linkedTool.result.content;
    if (typeof content === 'string') {
      totalTokens += estimateTokens(content);
    } else if (Array.isArray(content)) {
      totalTokens += estimateTokens(JSON.stringify(content));
    }
  }

  // For Skill tools, also add skill instructions tokens
  if (linkedTool.name === 'Skill') {
    if (linkedTool.skillInstructionsTokenCount !== undefined) {
      totalTokens += linkedTool.skillInstructionsTokenCount;
    } else if (linkedTool.skillInstructions) {
      totalTokens += estimateTokens(linkedTool.skillInstructions);
    }
  }

  return totalTokens;
}

/**
 * Gets the status of a tool execution.
 */
export function getToolStatus(linkedTool: LinkedToolItem): ItemStatus {
  if (linkedTool.isOrphaned) return 'orphaned';
  if (linkedTool.result?.isError) return 'error';
  return 'ok';
}
