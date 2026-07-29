import { describe, expect, it } from 'vitest';

import {
  buildOpenCodeLocalModelOverlay,
  resolveOpenCodeLocalModelPresentation,
} from './openCodeLocalModelOverlay';

import type { RuntimeLocalProviderListEntryDto } from '@features/runtime-provider-management/contracts';

const configuredModelUnavailableReason =
  'This configured model is not currently served by the local server.';

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
  configuredModelIds: ['llama3.2:latest'],
  defaultModelId: 'llama3.2:latest',
  isDefault: false,
  state: 'available',
  liveModels: [
    { id: 'llama3.2:latest', displayName: 'llama3.2:latest' },
    { id: 'qwen3-30b-32k', displayName: 'qwen3-30b-32k' },
  ],
  latencyMs: 8,
  message: 'Connected.',
  ...overrides,
});

describe('buildOpenCodeLocalModelOverlay', () => {
  it('keeps a custom live Qwen visible even before it is added to project config', () => {
    const overlay = buildOpenCodeLocalModelOverlay([provider()], configuredModelUnavailableReason);

    expect(overlay.options.map((option) => option.value)).toEqual([
      'ollama/llama3.2:latest',
      'ollama/qwen3-30b-32k',
    ]);
    expect(overlay.detectedCount).toBe(2);
    expect(overlay.configuredCount).toBe(1);
    expect(overlay.descriptorByRoute.get('ollama/qwen3-30b-32k')).toMatchObject({
      configured: false,
      detected: true,
      baseStatus: 'not_configured',
    });
  });

  it('keeps a configured model visible when the server no longer serves it', () => {
    const overlay = buildOpenCodeLocalModelOverlay(
      [
        provider({
          configuredModelIds: ['stale:latest'],
          defaultModelId: 'stale:latest',
          liveModels: [],
        }),
      ],
      configuredModelUnavailableReason
    );

    expect(overlay.options).toHaveLength(1);
    expect(overlay.descriptorByRoute.get('ollama/stale:latest')).toMatchObject({
      baseStatus: 'unavailable',
      detected: false,
      configured: true,
    });
  });
});

describe('resolveOpenCodeLocalModelPresentation', () => {
  const descriptor = buildOpenCodeLocalModelOverlay(
    [provider()],
    configuredModelUnavailableReason
  ).descriptorByRoute.get('ollama/llama3.2:latest');

  it('promotes verified local routes to Ready', () => {
    expect(
      resolveOpenCodeLocalModelPresentation({ descriptor: descriptor!, proofState: 'verified' })
    ).toEqual({ status: 'ready', reason: null });
  });

  it('keeps hard compatibility failures disabled with their exact reason', () => {
    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: descriptor!,
        blockingReason: 'This model does not support tool calls required by Agent Teams.',
      })
    ).toEqual({
      status: 'incompatible',
      reason: 'This model does not support tool calls required by Agent Teams.',
    });
  });

  it.each([
    ['adding', 'adding'],
    ['ready', 'ready'],
    ['incompatible', 'incompatible'],
  ] as const)(
    'applies the %s action state while the live route remains healthy',
    (action, status) => {
      expect(
        resolveOpenCodeLocalModelPresentation({
          descriptor: descriptor!,
          actionState: { status: action, message: `${action} result` },
        })
      ).toEqual({ status, reason: `${action} result` });
    }
  );

  it('keeps an add error attached to an unconfigured route', () => {
    const unconfiguredDescriptor = buildOpenCodeLocalModelOverlay(
      [provider()],
      configuredModelUnavailableReason
    ).descriptorByRoute.get('ollama/qwen3-30b-32k');

    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: unconfiguredDescriptor!,
        actionState: { status: 'error', message: 'Configuration failed.' },
      })
    ).toEqual({ status: 'not_configured', reason: 'Configuration failed.' });
  });

  it('never lets a cached Ready state hide current availability or provisioning blockers', () => {
    const unavailableDescriptor = buildOpenCodeLocalModelOverlay(
      [
        provider({
          state: 'unavailable',
          liveModels: [],
          message: 'Ollama is offline.',
        }),
      ],
      configuredModelUnavailableReason
    ).descriptorByRoute.get('ollama/llama3.2:latest');
    const readyAction = { status: 'ready' as const, message: 'Previously verified.' };

    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: unavailableDescriptor!,
        actionState: readyAction,
      })
    ).toEqual({ status: 'incompatible', reason: 'Ollama is offline.' });
    expect(
      resolveOpenCodeLocalModelPresentation({
        descriptor: descriptor!,
        actionState: readyAction,
        blockingReason: 'The latest deep check rejected this route.',
      })
    ).toEqual({
      status: 'incompatible',
      reason: 'The latest deep check rejected this route.',
    });
  });
});
