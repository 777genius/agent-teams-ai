import { describe, expect, it } from 'vitest';

import {
  buildLocalServerModelMetadataRequest,
  parseLlamaCppPropsMetadata,
  parseLmStudioModelMetadata,
} from './localServerRuntimeApi';

describe('localServerRuntimeApi', () => {
  it('reads the effective slot context from llama.cpp /props', () => {
    expect(
      parseLlamaCppPropsMetadata(
        JSON.stringify({ default_generation_settings: { n_ctx: 32_768 }, total_slots: 1 })
      )
    ).toEqual({ toolCapable: null, contextTokens: 32_768 });
    expect(parseLlamaCppPropsMetadata('not json')).toBeNull();
    expect(parseLlamaCppPropsMetadata(JSON.stringify({}))).toEqual({
      toolCapable: null,
      contextTokens: null,
    });
  });

  it('prefers loaded context over max context for LM Studio models', () => {
    const raw = JSON.stringify({
      data: [
        {
          id: 'qwen3-8b',
          max_context_length: 131_072,
          loaded_context_length: 8_192,
          capabilities: ['tool_use'],
        },
        { id: 'other-model', max_context_length: 4_096 },
      ],
    });
    expect(parseLmStudioModelMetadata(raw, 'qwen3-8b')).toEqual({
      toolCapable: true,
      contextTokens: 8_192,
    });
    expect(parseLmStudioModelMetadata(raw, 'other-model')).toEqual({
      toolCapable: null,
      contextTokens: 4_096,
    });
    expect(parseLmStudioModelMetadata(raw, 'missing')).toBeNull();
  });

  it('builds native metadata requests only for presets with known endpoints', () => {
    expect(
      buildLocalServerModelMetadataRequest('llama.cpp', 'http://127.0.0.1:8080/v1', 'm')?.url
    ).toBe('http://127.0.0.1:8080/props');
    expect(
      buildLocalServerModelMetadataRequest('lm-studio', 'http://127.0.0.1:1234/v1', 'm')?.url
    ).toBe('http://127.0.0.1:1234/api/v0/models');
    expect(
      buildLocalServerModelMetadataRequest('ollama', 'http://127.0.0.1:11434/v1', 'm')?.url
    ).toBe('http://127.0.0.1:11434/api/show');
    expect(buildLocalServerModelMetadataRequest('custom', 'http://127.0.0.1:8080/v1', 'm')).toBe(
      null
    );
  });
});
