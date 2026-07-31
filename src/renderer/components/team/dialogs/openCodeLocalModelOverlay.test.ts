import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeLocalModelOverlay,
  resolveOpenCodeLocalModelPresentation,
} from './openCodeLocalModelOverlay';

import type { RuntimeLocalProviderListEntryDto } from '@features/runtime-provider-management/contracts';

const provider = (
  overrides: Partial<RuntimeLocalProviderListEntryDto> = {}
): RuntimeLocalProviderListEntryDto => ({
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
  configuredModelIds: ['qwen3.5-agent-teams:4b-16k'],
  defaultModelId: 'qwen3.5-agent-teams:4b-16k',
  isDefault: false,
  state: 'available',
  liveModels: [
    { id: 'qwen3.5-agent-teams:4b-16k', displayName: 'qwen3.5-agent-teams:4b-16k' },
    { id: 'llama3.2:latest', displayName: 'llama3.2:latest' },
  ],
  latencyMs: 8,
  message: 'Connected.',
  ...overrides,
});

describe('buildOpenCodeLocalModelOverlay', () => {
  it('keeps live unconfigured models visible with separate detected and configured counts', () => {
    const overlay = buildOpenCodeLocalModelOverlay([provider()]);

    expect(overlay.options.map((option) => option.value)).toEqual([
      'ollama/qwen3.5-agent-teams:4b-16k',
      'ollama/llama3.2:latest',
    ]);
    expect(overlay.options[1]?.label).toBe('Llama 3.2 3B');
    expect(overlay.detectedCount).toBe(2);
    expect(overlay.configuredCount).toBe(1);
    expect(overlay.descriptorByRoute.get('ollama/llama3.2:latest')).toMatchObject({
      configured: false,
      detected: true,
      baseStatus: 'not_configured',
    });
  });

  it('keeps a configured model visible when the server no longer serves it', () => {
    const overlay = buildOpenCodeLocalModelOverlay([
      provider({
        configuredModelIds: ['stale:latest'],
        defaultModelId: 'stale:latest',
        liveModels: [],
      }),
    ]);

    expect(overlay.options).toHaveLength(1);
    expect(overlay.descriptorByRoute.get('ollama/stale:latest')).toMatchObject({
      baseStatus: 'unavailable',
      detected: false,
      configured: true,
    });
  });
});

describe('resolveOpenCodeLocalModelPresentation', () => {
  const descriptor = buildOpenCodeLocalModelOverlay([provider()]).descriptorByRoute.get(
    'ollama/qwen3.5-agent-teams:4b-16k'
  );

  it('promotes verified local routes to Ready', () => {
    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: descriptor!,
        proofState: 'verified',
      })
    ).toEqual({ status: 'ready', reason: null });
  });

  it('exposes the explicit experimental override state', () => {
    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: descriptor!,
        proofState: 'failed',
        advisoryReason:
          'Coordination failed. You can enable the experimental local-model override.',
      })
    ).toMatchObject({ status: 'experimental' });
  });

  it('keeps hard compatibility failures disabled with their exact reason', () => {
    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: descriptor!,
        blockingReason: 'Ollama is running this model with 4K context; 16K is required.',
      })
    ).toEqual({
      status: 'incompatible',
      reason: 'Ollama is running this model with 4K context; 16K is required.',
    });
  });
});
