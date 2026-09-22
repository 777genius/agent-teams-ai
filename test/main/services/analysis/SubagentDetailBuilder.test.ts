import { deriveSubagentDescription } from '@main/services/analysis/SubagentDetailBuilder';
import { describe, expect, it } from 'vitest';

import type { ParsedMessage } from '@main/types';

function message(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: 'msg-1',
    parentUuid: null,
    type: 'user',
    timestamp: new Date('2026-01-01T00:00:00.000Z'),
    content: '',
    isSidechain: true,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('deriveSubagentDescription', () => {
  it('uses the first authored user text', () => {
    expect(
      deriveSubagentDescription([
        message({ type: 'assistant', content: 'assistant output' }),
        message({ content: 'real subagent task' }),
      ])
    ).toBe('real subagent task');
  });

  it('ignores synthetic user replay text before real user text', () => {
    expect(
      deriveSubagentDescription([
        message({
          content: 'Human: I tested the feature looks good',
          isMeta: true,
          isReplay: true,
          isSynthetic: true,
        }),
        message({ content: 'Implement the actual task' }),
      ])
    ).toBe('Implement the actual task');
  });

  it('falls back when no authored user text exists', () => {
    expect(
      deriveSubagentDescription([
        message({
          content: 'Human: I tested the feature looks good',
          isMeta: true,
          isReplay: true,
          isSynthetic: true,
        }),
      ])
    ).toBe('Subagent');
  });

  it('ignores structured protocol rows before authored text', () => {
    expect(
      deriveSubagentDescription([
        message({
          content: 'plain protocol payload',
          protocolKind: 'teammate-message',
        }),
        message({ content: 'Implement the actual task' }),
      ])
    ).toBe('Implement the actual task');
  });

  it('preserves the existing 100 character truncation behavior', () => {
    expect(deriveSubagentDescription([message({ content: 'a'.repeat(101) })])).toBe(
      `${'a'.repeat(100)}...`
    );
  });
});
