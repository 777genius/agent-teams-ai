/**
 * Fenced code block marker for agent-only content.
 * Content wrapped in these markers is intended for the agent (Claude Code)
 * and should be hidden from the human user in the UI.
 *
 * Format:
 * ```info_for_agent
 * ... agent-only instructions ...
 * ```
 */
export const AGENT_BLOCK_TAG = 'info_for_agent';
export const AGENT_BLOCK_OPEN = '```' + AGENT_BLOCK_TAG;
export const AGENT_BLOCK_CLOSE = '```';

/**
 * Regex that matches a full ``` info_for_agent ... ``` block (including fences).
 * Supports optional leading/trailing whitespace and newlines around the block.
 */
export const AGENT_BLOCK_REGEX = new RegExp(
  '\\n?```' + AGENT_BLOCK_TAG + '\\n[\\s\\S]*?\\n```\\n?',
  'g'
);
