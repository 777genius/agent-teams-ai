import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ProviderModelBadges } from '@renderer/components/runtime/ProviderModelBadges';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderId, CliProviderModelCatalogItem, CliProviderStatus } from '@shared/types';

const NOW = new Date('2026-09-05T12:00:00.000Z');
const roots: Root[] = [];

function buildCatalogModel(
  id: string,
  displayName: string,
  metadata: CliProviderModelCatalogItem['metadata']
): CliProviderModelCatalogItem {
  return {
    id,
    launchModel: id,
    displayName,
    hidden: false,
    supportedReasoningEfforts: ['medium'],
    defaultReasoningEffort: 'medium',
    inputModalities: ['text'],
    supportsPersonality: false,
    isDefault: true,
    upgrade: false,
    source: 'app-server',
    metadata,
  };
}

function buildProviderStatus(
  providerId: CliProviderId,
  model: CliProviderModelCatalogItem
): Pick<CliProviderStatus, 'providerId' | 'authMethod' | 'backend' | 'modelCatalog'> {
  return {
    providerId,
    authMethod: providerId === 'anthropic' ? 'oauth_token' : 'chatgpt',
    backend:
      providerId === 'anthropic'
        ? { kind: 'anthropic', label: 'Anthropic' }
        : { kind: 'codex-native', label: 'Codex native' },
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source: 'app-server',
      status: 'ready',
      fetchedAt: NOW.toISOString(),
      staleAt: new Date(NOW.getTime() + 60_000).toISOString(),
      defaultModelId: model.id,
      defaultLaunchModel: model.launchModel,
      models: [model],
      diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
    },
  };
}

function renderModel(
  providerId: CliProviderId,
  model: CliProviderModelCatalogItem
): HTMLDivElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <ProviderModelBadges
        providerId={providerId}
        models={[model.launchModel]}
        providerStatus={buildProviderStatus(providerId, model)}
      />
    );
  });
  return host;
}

function getNewBadges(host: HTMLElement): HTMLElement[] {
  return Array.from(host.querySelectorAll('span')).filter(
    (element): element is HTMLElement =>
      element instanceof HTMLElement && element.textContent === 'New'
  );
}

describe('ProviderModelBadges release freshness', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    act(() => {
      roots.splice(0).forEach((root) => root.unmount());
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders identical New badges for recent Anthropic and Codex release dates', () => {
    const releaseDate = '2026-09-01T12:00:00.000Z';
    const anthropicHost = renderModel(
      'anthropic',
      buildCatalogModel('claude-fable-5-1', 'Fable 5.1', { releaseDate })
    );
    const codexHost = renderModel(
      'codex',
      buildCatalogModel('gpt-6-astra', 'GPT-6 Astra', { releaseDate })
    );
    const anthropicBadges = getNewBadges(anthropicHost);
    const codexBadges = getNewBadges(codexHost);

    expect(anthropicBadges).toHaveLength(1);
    expect(codexBadges).toHaveLength(1);
    expect(anthropicBadges[0]?.className).toBe(codexBadges[0]?.className);
  });

  it.each([
    ['anthropic', 'claude-fable-5-1', 'Fable 5.1'],
    ['codex', 'gpt-6-astra', 'GPT-6 Astra'],
  ] as const)(
    'expires the %s New badge when its dated release is old despite a hint',
    (providerId, id, displayName) => {
      const host = renderModel(
        providerId,
        buildCatalogModel(id, displayName, {
          releaseDate: '2026-08-01T12:00:00.000Z',
          recentlyReleased: true,
        })
      );

      expect(getNewBadges(host)).toHaveLength(0);
    }
  );

  it('keeps the Codex runtime hint when no release date is supplied', () => {
    const host = renderModel(
      'codex',
      buildCatalogModel('gpt-6-astra', 'GPT-6 Astra', { recentlyReleased: true })
    );

    expect(getNewBadges(host)).toHaveLength(1);
  });
});
