import {
  AGENT_BLOCK_CLOSE,
  AGENT_BLOCK_OPEN,
  extractAgentBlockContents,
  stripAgentBlocks,
  unwrapAgentBlock,
} from '@shared/constants/agentBlocks';

describe('agentBlocks', () => {
  it('strips the canonical info_for_agent tags from display text', () => {
    const text = `Visible line\n${AGENT_BLOCK_OPEN}\ninternal instruction\n${AGENT_BLOCK_CLOSE}\nAfter`;

    expect(stripAgentBlocks(text)).toBe('Visible line\nAfter');
    expect(extractAgentBlockContents(text)).toEqual(['internal instruction']);
  });

  it('keeps backward compatibility for legacy agent block formats', () => {
    const legacyFenced = 'Hello\n```info_for_agent\nhidden fenced\n```\nWorld';
    const legacyXml = 'Hello\n<agent-block>\nhidden xml\n</agent-block>\nWorld';

    expect(stripAgentBlocks(legacyFenced)).toBe('Hello\nWorld');
    expect(stripAgentBlocks(legacyXml)).toBe('Hello\nWorld');
    expect(extractAgentBlockContents(legacyFenced)).toEqual(['hidden fenced']);
    expect(extractAgentBlockContents(legacyXml)).toEqual(['hidden xml']);
  });

  it('unwraps canonical and legacy wrappers consistently', () => {
    expect(unwrapAgentBlock(`${AGENT_BLOCK_OPEN}\ninside\n${AGENT_BLOCK_CLOSE}`)).toBe('inside');
    expect(unwrapAgentBlock('```info_for_agent\ninside\n```')).toBe('inside');
    expect(unwrapAgentBlock('<agent-block>\ninside\n</agent-block>')).toBe('inside');
  });

  it('strips OpenCode runtime-only delivery blocks from display text', () => {
    const text = [
      '<opencode_runtime_identity>',
      'Do not use SendMessage.',
      '</opencode_runtime_identity>',
      '<opencode_app_message_delivery>',
      'Use agent-teams_message_send.',
      '</opencode_app_message_delivery>',
      'Human-visible task text',
    ].join('\n');

    expect(stripAgentBlocks(text)).toBe('Human-visible task text');
    expect(extractAgentBlockContents(text)).toEqual([
      'Do not use SendMessage.',
      'Use agent-teams_message_send.',
    ]);
  });
});
