const AGENT_BLOCK_TAG = 'info_for_agent';
const AGENT_BLOCK_OPEN = `<${AGENT_BLOCK_TAG}>`;
const AGENT_BLOCK_CLOSE = `</${AGENT_BLOCK_TAG}>`;
const AGENT_BLOCK_RE = new RegExp(`<${AGENT_BLOCK_TAG}>[\\s\\S]*?</${AGENT_BLOCK_TAG}>`, 'g');

/** Fresh instance per call: the shared /g regex carries `lastIndex` between uses. */
function createAgentBlockRegex() {
  return new RegExp(`<${AGENT_BLOCK_TAG}>[\\s\\S]*?</${AGENT_BLOCK_TAG}>`, 'g');
}

function wrapAgentBlock(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return '';
  }
  return `${AGENT_BLOCK_OPEN}\n${trimmed}\n${AGENT_BLOCK_CLOSE}`;
}

/**
 * Strip all agent-only blocks from text.
 * Returns text with `<info_for_agent>...</info_for_agent>` blocks removed and trimmed.
 */
function stripAgentBlocks(text) {
  if (typeof text !== 'string') return '';
  return text.replace(AGENT_BLOCK_RE, '').trim();
}

/**
 * Contents of every agent block in `text`, wrapper markers removed.
 *
 * Lets a caller move agent-only content somewhere the markers still parse
 * instead of carrying it through a transform that breaks them - quoting, for
 * one: `> <info_for_agent>` still matches, so the block is stripped but the
 * `> ` that opened it is left behind as a dangling blockquote line.
 */
function extractAgentBlockContents(text) {
  if (typeof text !== 'string') return [];
  return Array.from(text.matchAll(createAgentBlockRegex()))
    .map((match) => match[0].slice(AGENT_BLOCK_OPEN.length, -AGENT_BLOCK_CLOSE.length).trim())
    .filter((content) => content.length > 0);
}

module.exports = {
  AGENT_BLOCK_TAG,
  AGENT_BLOCK_OPEN,
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_RE,
  createAgentBlockRegex,
  extractAgentBlockContents,
  stripAgentBlocks,
  wrapAgentBlock,
};
