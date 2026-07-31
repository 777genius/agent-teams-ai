import { describe, expect, it } from 'vitest';

import {
  mergeOpenCodeLocalProviders,
  resolveOpenCodeLocalProviderLookup,
} from './useOpenCodeLocalProviders';

import type {
  RuntimeLocalProviderListEntryDto,
  RuntimeLocalProviderProbeDto,
} from '../../contracts';

const ollamaProbe = (): RuntimeLocalProviderProbeDto => ({
  preset: {
    id: 'ollama',
    providerId: 'ollama',
    displayName: 'Ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    description: 'Local Ollama',
    scannable: true,
  },
  providerId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  state: 'available',
  models: [{ id: 'llama3.2:latest', displayName: 'llama3.2:latest' }],
  latencyMs: 5,
  message: 'Connected.',
});

const configuredProvider = (): RuntimeLocalProviderListEntryDto => ({
  preset: ollamaProbe().preset,
  providerId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  configuredModelIds: ['qwen3.5:4b'],
  defaultModelId: 'qwen3.5:4b',
  isDefault: false,
  state: 'available',
  liveModels: [{ id: 'qwen3.5:4b', displayName: 'qwen3.5:4b' }],
  latencyMs: 4,
  message: 'Connected.',
});

describe('mergeOpenCodeLocalProviders', () => {
  it('adds a discovered Ollama server even when it is not configured yet', () => {
    expect(mergeOpenCodeLocalProviders([], [], [ollamaProbe()])).toEqual([
      expect.objectContaining({
        providerId: 'ollama',
        configuredModelIds: [],
        liveModels: [{ id: 'llama3.2:latest', displayName: 'llama3.2:latest' }],
      }),
    ]);
  });

  it('keeps project configuration authoritative over discovery data', () => {
    expect(mergeOpenCodeLocalProviders([], [configuredProvider()], [ollamaProbe()])).toEqual([
      configuredProvider(),
    ]);
  });
});

describe('resolveOpenCodeLocalProviderLookup', () => {
  it('combines successful config lookup with live discovery', () => {
    const resolution = resolveOpenCodeLocalProviderLookup(
      [
        {
          status: 'fulfilled',
          value: {
            schemaVersion: 1,
            runtimeId: 'opencode',
            scope: 'global',
            providers: [],
          },
        },
      ],
      {
        status: 'fulfilled',
        value: {
          schemaVersion: 1,
          runtimeId: 'opencode',
          probes: [ollamaProbe()],
        },
      }
    );

    expect(resolution.authoritative).toBe(true);
    expect(resolution.providers[0]?.providerId).toBe('ollama');
  });
});
