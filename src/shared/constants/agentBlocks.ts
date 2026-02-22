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
 * Regex pattern string for matching ``` info_for_agent ... ``` blocks (including fences).
 * Supports optional leading/trailing whitespace and newlines around the block.
 */
const AGENT_BLOCK_PATTERN = '\\n?```' + AGENT_BLOCK_TAG + '\\n[\\s\\S]*?\\n```\\n?';

/**
 * Creates a new RegExp for matching agent blocks.
 * Returns a fresh instance each time to avoid stateful 'g' flag issues with .test().
 */
export function createAgentBlockRegex(): RegExp {
  return new RegExp(AGENT_BLOCK_PATTERN, 'g');
}

/**
 * @deprecated Use createAgentBlockRegex() instead to avoid stateful 'g' flag issues.
 * Kept for backward compatibility with .replace() calls.
 */
export const AGENT_BLOCK_REGEX = new RegExp(AGENT_BLOCK_PATTERN, 'g');

/**
 * Fenced code block marker for reply messages between agents.
 *
 * Format:
 * ```message_reply_for_agent
 * Reply on @agent-name original message with text "<original>", here is answer: "<reply>"
 * ```
 */
export const MESSAGE_REPLY_TAG = 'message_reply_for_agent';
export const MESSAGE_REPLY_OPEN = '```' + MESSAGE_REPLY_TAG;
export const MESSAGE_REPLY_CLOSE = '```';

/**
 * Creates a new RegExp for matching message reply blocks.
 * Returns a fresh instance each time to avoid stateful 'g' flag issues with .test().
 */
export function createMessageReplyBlockRegex(): RegExp {
  return new RegExp('```message_reply_for_agent\\n[\\s\\S]*?\\n```', 'g');
}
