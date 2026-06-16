import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ProviderModelBadges } from '@renderer/components/runtime/ProviderModelBadges';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

function render(element: React.ReactElement): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => {
    root.render(element);
  });
  return host;
}

describe('ProviderModelBadges', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render stale availability chips for OpenCode models', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['openrouter/openai/gpt-oss-20b:free']}
        modelAvailability={[
          {
            modelId: 'openrouter/openai/gpt-oss-20b:free',
            status: 'unknown',
            reason: 'old bulk check failed',
            checkedAt: '2026-04-25T00:00:00.000Z',
          },
        ]}
      />
    );

    expect(host.textContent).toContain('gpt-oss');
    expect(host.textContent).not.toContain('Check failed');
  });

  it('keeps availability chips for providers that still support explicit badge checks', () => {
    const host = render(
      <ProviderModelBadges
        providerId="codex"
        models={['gpt-5-codex']}
        modelAvailability={[
          {
            modelId: 'gpt-5-codex',
            status: 'unknown',
            reason: 'probe timeout',
            checkedAt: '2026-04-25T00:00:00.000Z',
          },
        ]}
      />
    );

    expect(host.textContent).toContain('Check failed');
  });

  it('renders catalog badges from verbose provider metadata', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['opencode/big-pickle']}
        providerStatus={{
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }}
      />
    );

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('Free');
  });

  it('renders paid and free OpenCode models together without marking every model free', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['opencode/big-pickle', 'openai/gpt-5.4']}
        providerStatus={{
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }}
      />
    );

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent?.match(/Free/g)).toHaveLength(1);
  });

  it('uses the OpenCode catalog when provider models are summary-only', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['opencode/big-pickle']}
        providerStatus={{
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
              {
                id: 'openrouter/hidden-model',
                launchModel: 'openrouter/hidden-model',
                displayName: 'openrouter/hidden-model',
                hidden: true,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }}
      />
    );

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).not.toContain('hidden-model');
  });

  it('renders OpenCode free badges from metadata when badgeLabel is absent', () => {
    const host = render(
      <ProviderModelBadges
        providerId="opencode"
        models={['openrouter/openai/gpt-oss-20b']}
        providerStatus={{
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'openrouter/openai/gpt-oss-20b',
                launchModel: 'openrouter/openai/gpt-oss-20b',
                displayName: 'openrouter/openai/gpt-oss-20b',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
                metadata: { free: true },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }}
      />
    );

    expect(host.textContent).toContain('gpt-oss');
    expect(host.textContent).toContain('Free');
  });

  it('does not duplicate a catalog badge that matches the displayed model label', () => {
    const host = render(
      <ProviderModelBadges
        providerId="anthropic"
        models={['claude-opus-4-6']}
        providerStatus={{
          providerId: 'anthropic',
          authMethod: 'oauth_token',
          backend: { kind: 'anthropic', label: 'Anthropic' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'claude-opus-4-6',
            defaultLaunchModel: 'claude-opus-4-6',
            models: [
              {
                id: 'claude-opus-4-6',
                launchModel: 'claude-opus-4-6',
                displayName: 'Opus 4.6',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-models-api',
                badgeLabel: 'Opus 4.6',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }}
      />
    );

    expect(host.textContent?.match(/Opus 4\.6/g)).toHaveLength(1);
  });

  it('does not render duplicate Anthropic Opus 4.8 model badges when the runtime reports the opus alias', () => {
    const host = render(<ProviderModelBadges providerId="anthropic" models={['opus']} />);
    const renderedModelLabels = Array.from(host.firstElementChild?.children ?? [])
      .map((badge) => badge.firstElementChild?.textContent ?? '')
      .filter(Boolean);

    expect(renderedModelLabels.filter((label) => label === 'Opus 4.8')).toHaveLength(1);
    expect(renderedModelLabels).toContain('Opus 4.8 (1M)');
  });

  it('collapses long model lists and expands them inline without an internal scroll area', () => {
    const models = Array.from(
      { length: 18 },
      (_, index) => `model-${String(index + 1).padStart(2, '0')}`
    );
    const host = render(
      <ProviderModelBadges providerId="codex" models={models} collapseAfter={15} />
    );

    expect(host.textContent).toContain('model-15');
    expect(host.textContent).not.toContain('model-16');
    expect(host.textContent).toContain('+3 more');

    const moreButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+3 more')
    );
    expect(moreButton).toBeTruthy();

    act(() => {
      moreButton?.click();
    });

    expect(host.textContent).toContain('model-18');
    expect(host.textContent).toContain('Hide');
    const list = host.firstElementChild?.firstElementChild as HTMLElement | null;
    expect(list?.style.maxHeight).toBe('');
    expect(list?.style.overflowY).toBe('');

    const hideButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Hide')
    );
    expect(hideButton).toBeTruthy();

    act(() => {
      hideButton?.click();
    });

    expect(host.textContent).not.toContain('model-16');
    expect(host.textContent).toContain('+3 more');
  });

  it('limits collapsed model badges by rendered rows when requested', () => {
    const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
      configurable: true,
      get() {
        const siblings = Array.from(this.parentElement?.children ?? []);
        const index = Math.max(0, siblings.indexOf(this));
        return Math.floor(index / 3) * 20;
      },
    });

    try {
      const models = Array.from(
        { length: 18 },
        (_, index) => `model-${String(index + 1).padStart(2, '0')}`
      );
      const host = render(
        <ProviderModelBadges
          providerId="codex"
          models={models}
          collapseAfter={15}
          maxCollapsedRows={2}
        />
      );

      expect(host.textContent).toContain('model-05');
      expect(host.textContent).not.toContain('model-06');
      expect(host.textContent).toContain('+13 more');
    } finally {
      if (originalOffsetTop) {
        Object.defineProperty(HTMLElement.prototype, 'offsetTop', originalOffsetTop);
      } else {
        delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
      }
    }
  });
});
