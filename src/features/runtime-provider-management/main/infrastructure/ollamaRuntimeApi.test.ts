import { describe, expect, it } from 'vitest';

import {
  buildOllamaNativeUrl,
  parseOllamaRunningContextTokens,
  parseOllamaShowMetadata,
} from './ollamaRuntimeApi';

describe('ollamaRuntimeApi', () => {
  it('builds native API URLs from an OpenAI-compatible base URL', () => {
    expect(buildOllamaNativeUrl('http://127.0.0.1:11434/v1', '/api/ps')).toBe(
      'http://127.0.0.1:11434/api/ps'
    );
  });

  it('prefers an explicit num_ctx parameter over the trained model maximum', () => {
    expect(
      parseOllamaShowMetadata(
        JSON.stringify({
          capabilities: ['completion', 'tools'],
          parameters: 'temperature 0.2\nnum_ctx 16384',
          model_info: {
            'general.parameter_count': 7_615_616_000,
            'qwen2.context_length': 32_768,
          },
        })
      )
    ).toEqual({
      completionCapable: true,
      toolCapable: true,
      parameterCount: 7_615_616_000,
      configuredContextTokens: 16_384,
      trainedContextTokens: 32_768,
    });
  });

  it('matches an implicit latest tag in the running model inventory', () => {
    expect(
      parseOllamaRunningContextTokens(
        JSON.stringify({
          models: [{ model: 'llama3.1:latest', context_length: 32_768 }],
        }),
        'llama3.1'
      )
    ).toBe(32_768);
  });
});
