import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ status: null as unknown }));
vi.mock('@renderer/hooks/useEffectiveCliProviderStatus', () => ({
  useEffectiveCliProviderStatus: () => ({ providerStatus: runtime.status }),
}));

import { AnthropicFastModeSelector } from './AnthropicFastModeSelector';

describe('Anthropic Default fast-mode capability', () => {
  afterEach(() => {
    runtime.status = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reads the configured default model capability while explicit selection still wins', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const model = (id: string, fast: boolean) => ({
      id,
      launchModel: id,
      displayName: id,
      hidden: false,
      supportsFastMode: fast,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text'],
      supportsPersonality: false,
      isDefault: false,
      upgrade: false,
      source: 'anthropic-models-api',
    });
    const providerStatus = {
      providerId: 'anthropic',
      verificationState: 'verified',
      statusCheckOutcome: 'authoritative',
      effectiveDefaultModel: 'gateway/standard-only',
      modelCatalog: {
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        defaultLaunchModel: 'claude-opus-4-8',
        models: [model('claude-opus-4-8', true), model('gateway/standard-only', false)],
      },
      runtimeCapabilities: { fastMode: { supported: true, available: true, source: 'runtime' } },
    };
    runtime.status = providerStatus;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const render = (selectedModel: string) =>
      root.render(
        React.createElement(AnthropicFastModeSelector, {
          value: 'inherit',
          onValueChange: () => undefined,
          providerFastModeDefault: false,
          model: selectedModel,
          limitContext: true,
        })
      );
    const fastButton = () =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === 'Fast');
    act(() => render(''));
    expect(fastButton()?.disabled).toBe(true);
    runtime.status = { ...providerStatus, statusCheckOutcome: 'pending' };
    act(() => render(''));
    expect(fastButton()?.disabled).toBe(false);
    runtime.status = providerStatus;
    act(() => render(''));
    expect(fastButton()?.disabled).toBe(true);
    act(() => render('claude-opus-4-8'));
    expect(fastButton()?.disabled).toBe(false);
    act(() => root.unmount());
  });
});
