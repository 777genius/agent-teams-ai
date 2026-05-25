import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { EffortLevelSelector } from '@renderer/components/team/dialogs/EffortLevelSelector';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

let providerStatus: CliProviderStatus | null = null;

vi.mock('@renderer/hooks/useEffectiveCliProviderStatus', () => ({
  useEffectiveCliProviderStatus: () => ({
    providerStatus,
    cliStatus: null,
    loading: false,
  }),
}));

function createAnthropicProviderStatus(): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    models: ['claude-haiku-4-5-20251001'],
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: '2026-04-30T00:00:00.000Z',
      staleAt: '2026-04-30T00:10:00.000Z',
      defaultModelId: 'haiku',
      defaultLaunchModel: 'claude-haiku-4-5-20251001',
      models: [
        {
          id: 'haiku',
          launchModel: 'claude-haiku-4-5-20251001',
          displayName: 'Haiku 4.5',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'anthropic-models-api',
        },
      ],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
    modelAvailability: [],
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'anthropic-models-api' },
      reasoningEffort: {
        supported: true,
        values: [],
        configPassthrough: false,
      },
    },
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
  };
}

describe('EffortLevelSelector', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    providerStatus = null;
  });

  it('disables effort selection and resets stale effort for Anthropic models without effort support', async () => {
    providerStatus = createAnthropicProviderStatus();
    const onValueChange = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <EffortLevelSelector
          value="high"
          onValueChange={onValueChange}
          providerId="anthropic"
          model="claude-haiku-4-5-20251001"
        />
      );
    });

    expect(host.textContent).toContain('Not supported');
    expect(host.textContent).toContain('Haiku 4.5 does not support configurable reasoning effort');
    expect(host.querySelector('button')?.disabled).toBe(true);
    expect(onValueChange).toHaveBeenCalledWith('');

    await act(async () => {
      root.unmount();
    });
    host.remove();
  });
});
