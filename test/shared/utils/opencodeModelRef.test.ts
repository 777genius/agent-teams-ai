import { describe, expect, it } from 'vitest';

import {
  getOpenCodeQualifiedModelSourceLabel,
  getOpenCodeSourceDisplayName,
  parseOpenCodeQualifiedModelRef,
} from '../../../src/shared/utils/opencodeModelRef';

describe('opencodeModelRef', () => {
  it('parses dotted providers and model ids with nested slashes', () => {
    expect(parseOpenCodeQualifiedModelRef('llama.cpp/qwen3-coder:a3b')).toEqual({
      raw: 'llama.cpp/qwen3-coder:a3b',
      sourceId: 'llama.cpp',
      modelId: 'qwen3-coder:a3b',
    });

    expect(parseOpenCodeQualifiedModelRef('lmstudio/google/gemma-3n-e4b')).toEqual({
      raw: 'lmstudio/google/gemma-3n-e4b',
      sourceId: 'lmstudio',
      modelId: 'google/gemma-3n-e4b',
    });
  });

  it('rejects whitespace and unscoped OpenCode model refs', () => {
    expect(parseOpenCodeQualifiedModelRef('llama.cpp/qwen test')).toBeNull();
    expect(parseOpenCodeQualifiedModelRef('qwen3-coder:a3b')).toBeNull();
  });

  it('labels common local OpenCode providers', () => {
    expect(getOpenCodeQualifiedModelSourceLabel('llama.cpp/qwen3-coder:a3b')).toBe('llama.cpp');
    expect(getOpenCodeQualifiedModelSourceLabel('lmstudio/google/gemma-3n-e4b')).toBe('LM Studio');
    expect(getOpenCodeQualifiedModelSourceLabel('opencode/big-pickle')).toBe('OpenCode Zen');
  });

  it('disambiguates Google API, Vertex, and gateway provider names', () => {
    expect(getOpenCodeSourceDisplayName('google', 'Google')).toBe('Google Gemini API');
    expect(getOpenCodeSourceDisplayName('google-vertex', 'Vertex')).toBe('Google Vertex AI');
    expect(getOpenCodeSourceDisplayName('google-vertex-anthropic', 'Vertex (Anthropic)')).toBe(
      'Claude via Google Vertex'
    );
    expect(getOpenCodeSourceDisplayName('vercel', 'Vercel')).toBe('Vercel AI Gateway');
    expect(getOpenCodeSourceDisplayName('custom-provider', 'Custom Provider')).toBe(
      'Custom Provider'
    );
  });
});
