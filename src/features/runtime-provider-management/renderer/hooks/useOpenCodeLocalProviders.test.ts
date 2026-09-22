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
  models: [{ id: 'qwen3-30b-32k', displayName: 'qwen3-30b-32k' }],
  latencyMs: 5,
  message: 'Connected.',
});

const configuredProvider = (): RuntimeLocalProviderListEntryDto => ({
  preset: ollamaProbe().preset,
  providerId: 'ollama',
  baseUrl: 'http://127.0.0.1:11434/v1',
  configuredModelIds: ['llama3.2:latest'],
  defaultModelId: 'llama3.2:latest',
  isDefault: false,
  state: 'available',
  liveModels: [
    { id: 'llama3.2:latest', displayName: 'llama3.2:latest' },
    { id: 'qwen3-30b-32k', displayName: 'qwen3-30b-32k' },
  ],
  latencyMs: 4,
  message: 'Connected.',
});

describe('mergeOpenCodeLocalProviders', () => {
  it('adds a discovered Ollama server even when it is not configured yet', () => {
    expect(mergeOpenCodeLocalProviders([], [], [ollamaProbe()])).toEqual([
      expect.objectContaining({
        providerId: 'ollama',
        configuredModelIds: [],
        liveModels: [{ id: 'qwen3-30b-32k', displayName: 'qwen3-30b-32k' }],
      }),
    ]);
  });

  it('keeps configured scope data while its live inventory exposes newly pulled models', () => {
    expect(mergeOpenCodeLocalProviders([], [configuredProvider()], [ollamaProbe()])).toEqual([
      configuredProvider(),
    ]);
  });

  it('does not carry global private-network approval into a project target', () => {
    const globalProvider = {
      ...configuredProvider(),
      baseUrl: ['http', '://ollama.local:11434/v1'].join(''),
      privateNetworkApproved: true,
    };

    expect(mergeOpenCodeLocalProviders([globalProvider], [], [])[0]).toMatchObject({
      providerId: 'ollama',
      privateNetworkApproved: false,
    });
  });

  it('preserves approval reported for the exact project provider target', () => {
    const projectProvider = {
      ...configuredProvider(),
      baseUrl: ['http', '://ollama.local:11434/v1'].join(''),
      privateNetworkApproved: true,
    };

    expect(
      mergeOpenCodeLocalProviders(
        [{ ...projectProvider, privateNetworkApproved: false }],
        [projectProvider],
        []
      )[0]
    ).toMatchObject({ providerId: 'ollama', privateNetworkApproved: true });
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

  it('keeps configured models usable when discovery fails but marks the lookup partial', () => {
    const resolution = resolveOpenCodeLocalProviderLookup(
      [
        {
          status: 'fulfilled',
          value: {
            schemaVersion: 1,
            runtimeId: 'opencode',
            scope: 'project',
            providers: [configuredProvider()],
          },
        },
      ],
      { status: 'rejected', reason: new Error('offline') }
    );

    expect(resolution.providers).toHaveLength(1);
    expect(resolution.authoritative).toBe(false);
    expect(resolution.error).toContain('scan local model servers');
  });
});
