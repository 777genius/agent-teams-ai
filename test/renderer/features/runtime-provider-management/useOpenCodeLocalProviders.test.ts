import {
  mergeOpenCodeLocalProviders,
  resolveOpenCodeLocalProviderLookup,
} from '@features/runtime-provider-management/renderer';
import { describe, expect, it } from 'vitest';

import type { RuntimeLocalProviderListEntryDto } from '@features/runtime-provider-management/contracts';

function createProvider(providerId: string, baseUrl: string): RuntimeLocalProviderListEntryDto {
  return {
    preset: {
      id: providerId === 'ollama' ? 'ollama' : 'lm-studio',
      providerId,
      displayName: providerId === 'ollama' ? 'Ollama' : 'LM Studio',
      defaultBaseUrl: baseUrl,
      description: 'Local test provider',
      scannable: true,
    },
    providerId,
    baseUrl,
    configuredModelIds: ['qwen-test:0.5b'],
    defaultModelId: 'qwen-test:0.5b',
    isDefault: true,
    state: 'available',
    liveModels: [{ id: 'qwen-test:0.5b', displayName: 'qwen-test:0.5b' }],
    latencyMs: 5,
    message: 'Connected',
  };
}

describe('mergeOpenCodeLocalProviders', () => {
  it('keeps global providers and lets project providers override the same provider id', () => {
    const globalLmStudio = createProvider('lmstudio', 'http://127.0.0.1:1234/v1');
    const projectLmStudio = createProvider('LMSTUDIO', 'http://127.0.0.1:4321/v1');
    const projectOllama = createProvider('ollama', 'http://127.0.0.1:11434/v1');

    const result = mergeOpenCodeLocalProviders([globalLmStudio], [projectLmStudio, projectOllama]);

    expect(result).toEqual([projectLmStudio, projectOllama]);
  });
});

describe('resolveOpenCodeLocalProviderLookup', () => {
  it('marks a complete global and project lookup as authoritative', () => {
    const globalProvider = createProvider('lmstudio', 'http://127.0.0.1:1234/v1');
    const projectProvider = createProvider('ollama', 'http://127.0.0.1:11434/v1');

    const result = resolveOpenCodeLocalProviderLookup([
      {
        status: 'fulfilled',
        value: {
          schemaVersion: 1,
          runtimeId: 'opencode',
          providers: [globalProvider],
        },
      },
      {
        status: 'fulfilled',
        value: {
          schemaVersion: 1,
          runtimeId: 'opencode',
          providers: [projectProvider],
        },
      },
    ]);

    expect(result).toEqual({
      providers: [globalProvider, projectProvider],
      authoritative: true,
      error: null,
    });
  });

  it('keeps successful-scope providers but does not treat a partial config failure as empty', () => {
    const globalProvider = createProvider('lmstudio', 'http://127.0.0.1:1234/v1');

    const result = resolveOpenCodeLocalProviderLookup([
      {
        status: 'fulfilled',
        value: {
          schemaVersion: 1,
          runtimeId: 'opencode',
          providers: [globalProvider],
        },
      },
      {
        status: 'fulfilled',
        value: {
          schemaVersion: 1,
          runtimeId: 'opencode',
          error: {
            code: 'config-invalid',
            message: 'Project OpenCode config is invalid.',
            recoverable: true,
          },
        },
      },
    ]);

    expect(result.providers).toEqual([globalProvider]);
    expect(result.authoritative).toBe(false);
    expect(result.error).toBe('Project OpenCode config is invalid.');
  });
});
