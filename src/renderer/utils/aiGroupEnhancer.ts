/**
 * AI Group Enhancer - Orchestrator for AI Group enhancement
 *
 * This module transforms raw AIGroup data into EnhancedAIGroup with display-ready
 * properties for the chat-style UI. It coordinates between specialized utility modules:
 * - lastOutputDetector: Find the last visible output
 * - slashCommandExtractor: Handle slash command extraction
 * - toolLinkingEngine: Link tool calls to their results
 * - displayItemBuilder: Build display items from steps/messages
 * - modelExtractor: Extract model information
 * - displaySummary: Build human-readable summaries
 * - aiGroupHelpers: Small utility functions
 */

// Import from specialized modules
import { attachMainSessionImpact } from './aiGroupHelpers';
import { buildDisplayItems } from './displayItemBuilder';
import { buildSummary } from './displaySummary';
import { findLastOutput } from './lastOutputDetector';
import { extractMainModel, extractSubagentModels } from './modelExtractor';
import { type PrecedingSlashInfo } from './slashCommandExtractor';
import { linkToolCallsToResults } from './toolLinkingEngine';

import type { ClaudeMdStats } from '../types/claudeMd';
import type { AIGroup, EnhancedAIGroup } from '../types/groups';

// Re-export types and functions that are part of the public API
export { truncateText } from './aiGroupHelpers';
export { buildDisplayItems, buildDisplayItemsFromMessages } from './displayItemBuilder';
export { buildSummary } from './displaySummary';
export { findLastOutput } from './lastOutputDetector';
export { type PrecedingSlashInfo } from './slashCommandExtractor';
export { linkToolCallsToResults } from './toolLinkingEngine';

/**
 * Main enhancement function - transforms AIGroup into EnhancedAIGroup.
 *
 * This is the primary entry point that ties together all the helper functions
 * to produce a display-ready enhanced group.
 *
 * @param aiGroup - Base AI Group to enhance
 * @param claudeMdStats - Optional CLAUDE.md injection stats for this group
 * @param precedingSlash - Optional slash info from the preceding UserGroup
 * @returns Enhanced AI Group with display data
 */
export function enhanceAIGroup(
  aiGroup: AIGroup,
  claudeMdStats?: ClaudeMdStats,
  precedingSlash?: PrecedingSlashInfo
): EnhancedAIGroup {
  // Pass isOngoing to findLastOutput - if ongoing, it returns 'ongoing' type instead of forcing a last output
  const lastOutput = findLastOutput(aiGroup.steps, aiGroup.isOngoing ?? false);
  // Pass responses to linkToolCallsToResults for slash instruction extraction
  const linkedTools = linkToolCallsToResults(aiGroup.steps, aiGroup.responses);
  // Attach main session impact tokens to subagents (Task tool call/result tokens)
  attachMainSessionImpact(aiGroup.processes, linkedTools);
  const displayItems = buildDisplayItems(
    aiGroup.steps,
    lastOutput,
    aiGroup.processes,
    aiGroup.responses,
    precedingSlash
  );
  const summary = buildSummary(displayItems);
  const mainModel = extractMainModel(aiGroup.steps);
  const subagentModels = extractSubagentModels(aiGroup.processes, mainModel);

  return {
    ...aiGroup,
    lastOutput,
    linkedTools,
    displayItems,
    itemsSummary: summary,
    mainModel,
    subagentModels,
    claudeMdStats: claudeMdStats ?? null,
  };
}
