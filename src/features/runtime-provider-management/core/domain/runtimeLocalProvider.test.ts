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

  it('allows a validated custom provider id on loopback only', () => {
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
    ).toThrow('localhost or a loopback address');
  });

  it('rejects unsafe model identifiers', () => {
    expect(normalizeRuntimeLocalProviderModelId(' qwen3:8b ')).toBe('qwen3:8b');
    expect(normalizeRuntimeLocalProviderModelId('bad\nmodel')).toBeNull();
    expect(normalizeRuntimeLocalProviderModelId('')).toBeNull();
  });
});
