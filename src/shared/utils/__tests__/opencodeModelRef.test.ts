import { describe, expect, it } from 'vitest';

import { getOpenCodeSourceDisplayName } from '../opencodeModelRef';

describe('opencodeModelRef', () => {
  it('uses the registry label for known OpenCode source ids', () => {
    expect(getOpenCodeSourceDisplayName('openrouter')).toBe('OpenRouter');
    expect(getOpenCodeSourceDisplayName('orcarouter')).toBe('OrcaRouter');
    expect(getOpenCodeSourceDisplayName('openai')).toBe('OpenAI');
  });

  it('falls back to the runtime-supplied display name', () => {
    expect(getOpenCodeSourceDisplayName('custom-provider', 'Custom Provider')).toBe(
      'Custom Provider'
    );
  });

  it('title-cases unknown source ids without a runtime label', () => {
    expect(getOpenCodeSourceDisplayName('my-local-gateway')).toBe('My Local Gateway');
  });
});
