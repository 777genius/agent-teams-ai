import { describe, expect, it } from 'vitest';

import {
  buildRuntimeLocalProviderModelRoute,
  normalizeRuntimeLocalProviderModelId,
  normalizeRuntimeLocalProviderTarget,
  RuntimeLocalProviderValidationError,
} from './runtimeLocalProvider';

describe('runtimeLocalProvider', () => {
  it('normalizes built-in presets to stable OpenCode provider routes', () => {
    expect(normalizeRuntimeLocalProviderTarget({ presetId: 'ollama' })).toMatchObject({
      providerId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'lm-studio',
        baseUrl: 'http://localhost:1234/',
      })
    ).toMatchObject({ providerId: 'lmstudio', baseUrl: 'http://localhost:1234/v1' });
    expect(buildRuntimeLocalProviderModelRoute('atomic-chat', 'qwen3:8b')).toBe(
      'atomic-chat/qwen3:8b'
    );
  });

  it('allows loopback and trusted remote HTTPS URLs for custom providers', () => {
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'my-local',
        baseUrl: 'https://127.0.0.2:9443/openai/v1/',
      })
    ).toMatchObject({
      providerId: 'my-local',
      baseUrl: 'https://127.0.0.2:9443/openai/v1',
    });
    expect(
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'omniroute',
        baseUrl: 'https://models.example.com/openai/v1/',
      })
    ).toMatchObject({
      providerId: 'omniroute',
      baseUrl: 'https://models.example.com/openai/v1',
    });

    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'My Local',
      })
    ).toThrow(RuntimeLocalProviderValidationError);
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'local',
        baseUrl: 'http://example.com/v1',
      })
    ).toThrow('must use HTTPS');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'ollama',
        baseUrl: 'https://models.example.com/v1',
      })
    ).toThrow('Choose Custom OpenAI-compatible server');
    expect(() =>
      normalizeRuntimeLocalProviderTarget({
        presetId: 'custom',
        providerId: 'omniroute',
        baseUrl: 'https://0.0.0.0/v1',
      })
    ).toThrow('reachable host');
  });

  it('rejects unsafe model identifiers', () => {
    expect(normalizeRuntimeLocalProviderModelId(' qwen3:8b ')).toBe('qwen3:8b');
    expect(normalizeRuntimeLocalProviderModelId('bad\nmodel')).toBeNull();
    expect(normalizeRuntimeLocalProviderModelId('')).toBeNull();
  });
});
