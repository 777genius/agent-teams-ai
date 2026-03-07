const AGENT_BLOCK_TAG = 'info_for_agent';
const AGENT_BLOCK_OPEN = `<${AGENT_BLOCK_TAG}>`;
const AGENT_BLOCK_CLOSE = `</${AGENT_BLOCK_TAG}>`;

function wrapAgentBlock(text) {
  const trimmed = typeof text === 'string' ? text.trim() : '';
  if (!trimmed) {
    return '';
  }
  return `${AGENT_BLOCK_OPEN}\n${trimmed}\n${AGENT_BLOCK_CLOSE}`;
}

module.exports = {
  AGENT_BLOCK_TAG,
  AGENT_BLOCK_OPEN,
  AGENT_BLOCK_CLOSE,
  wrapAgentBlock,
};
