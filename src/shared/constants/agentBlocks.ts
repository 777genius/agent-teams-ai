/**
 * XML-like marker for agent-only content.
 * Content wrapped in these markers is intended for the agent (Claude Code)
 * and should be hidden from the human user in the UI.
 *
 * Canonical format:
 * <info_for_agent>
 * ... agent-only instructions ...
 * </info_for_agent>
 *
 * Backward compatibility:
 * - legacy fenced blocks: ```info_for_agent ... ```
 * - legacy xml-like blocks: <agent-block> ... </agent-block>
 */
export const AGENT_BLOCK_TAG = 'info_for_agent';
export const AGENT_BLOCK_OPEN = `<${AGENT_BLOCK_TAG}>`;
export const AGENT_BLOCK_CLOSE = `</${AGENT_BLOCK_TAG}>`;

/**
 * Regex pattern string for matching current and legacy agent-only blocks.
 */
const CURRENT_AGENT_BLOCK_PATTERN = '\\n?<info_for_agent>\\n?[\\s\\S]*?\\n?<\\/info_for_agent>\\n?';
const LEGACY_FENCED_AGENT_BLOCK_PATTERN = '\\n?```' + AGENT_BLOCK_TAG + '\\n[\\s\\S]*?\\n```\\n?';
const LEGACY_XML_AGENT_BLOCK_PATTERN = '\\n?<agent-block>\\n?[\\s\\S]*?\\n?<\\/agent-block>\\n?';
const AGENT_BLOCK_PATTERN = `(?:${CURRENT_AGENT_BLOCK_PATTERN}|${LEGACY_FENCED_AGENT_BLOCK_PATTERN}|${LEGACY_XML_AGENT_BLOCK_PATTERN})`;

/**
 * Creates a new RegExp for matching agent blocks.
 * Returns a fresh instance each time to avoid stateful 'g' flag issues with .test().
 */
export function createAgentBlockRegex(): RegExp {
  return new RegExp(AGENT_BLOCK_PATTERN, 'g');
}

/**
 * Removes the current and legacy agent-only blocks from text for UI display.
 */
export function stripAgentBlocks(text: string): string {
  return text
    .replace(createAgentBlockRegex(), '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Removes only the wrapper markers from a single agent block.
 */
export function unwrapAgentBlock(block: string): string {
  const trimmed = block.trim();

  if (trimmed.startsWith(AGENT_BLOCK_OPEN) && trimmed.endsWith(AGENT_BLOCK_CLOSE)) {
    return trimmed.slice(AGENT_BLOCK_OPEN.length, -AGENT_BLOCK_CLOSE.length).trim();
  }

  const legacyFencedOpen = '```' + AGENT_BLOCK_TAG;
  if (trimmed.startsWith(legacyFencedOpen) && trimmed.endsWith('```')) {
    return trimmed.slice(legacyFencedOpen.length, -'```'.length).trim();
  }

  const legacyXmlOpen = '<agent-block>';
  const legacyXmlClose = '</agent-block>';
  if (trimmed.startsWith(legacyXmlOpen) && trimmed.endsWith(legacyXmlClose)) {
    return trimmed.slice(legacyXmlOpen.length, -legacyXmlClose.length).trim();
  }

  return trimmed;
}

/**
 * Extracts agent-only block contents without the wrapper markers.
 */
export function extractAgentBlockContents(text: string): string[] {
  return Array.from(text.matchAll(createAgentBlockRegex()))
    .map((match) => unwrapAgentBlock(match[0]))
    .filter((content) => content.length > 0);
}

/**
 * @deprecated Use createAgentBlockRegex() instead to avoid stateful 'g' flag issues.
 * Kept for backward compatibility with .replace() calls.
 */
export const AGENT_BLOCK_REGEX = new RegExp(AGENT_BLOCK_PATTERN, 'g');

/**
 * Wraps text in agent-only block markers.
 * Use this instead of manually concatenating AGENT_BLOCK_OPEN/CLOSE.
 */
export function wrapAgentBlock(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return '';
  return `${AGENT_BLOCK_OPEN}\n${trimmed}\n${AGENT_BLOCK_CLOSE}`;
}

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
