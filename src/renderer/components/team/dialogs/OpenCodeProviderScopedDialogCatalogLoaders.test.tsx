import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { OpenCodeProviderScopedDialogCatalogLoaders } from './OpenCodeProviderScopedDialogCatalogLoaders';

import type { CliProviderStatus } from '@shared/types';

const catalogLoads: string[] = [];
const catalogRefreshRevisions: number[] = [];

function buildStatus(sourceId: string): CliProviderStatus {
  const model = `${sourceId}/model`;
  return {
    providerId: 'opencode',
    authenticated: true,
    verificationState: 'verified',
    statusCheckOutcome: 'authoritative',
    modelCatalogRefreshState: 'ready',
    models: [model],
    capabilities: { teamLaunch: true },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'app-server',
      status: 'ready',
      fetchedAt: new Date(Date.now() - 1).toISOString(),
      staleAt: new Date(Date.now() + 60_000).toISOString(),
      models: [{ id: model, launchModel: model, displayName: model }],
    },
  } as unknown as CliProviderStatus;
}

vi.mock('@features/runtime-provider-management/renderer', () => ({
  useOpenCodeProviderModelCatalog: ({
    sourceProviderId,
    refreshRevision,
  }: {
    sourceProviderId: string;
    refreshRevision: number;
  }) => {
    catalogRefreshRevisions.push(refreshRevision);
    catalogLoads.push(sourceProviderId);
    return {
      sourceProviderId,
      providerStatus: buildStatus(sourceProviderId),
      status: 'ready',
      catalogState: 'fresh',
      freshModelCount: 1,
      error: null,
      refresh: vi.fn(),
    };
  },
}));

beforeEach(() => {
  catalogLoads.length = 0;
  catalogRefreshRevisions.length = 0;
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

describe('OpenCodeProviderScopedDialogCatalogLoaders', () => {
  it('loads each selected remote source while excluding authoritative local sources', async () => {
    const published: string[] = [];
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <OpenCodeProviderScopedDialogCatalogLoaders
          configuration={{
            enabled: true,
            projectPath: '/sandbox/project',
            selectedModels: [
              'openrouter/model-a',
              'openrouter/model-b',
              'anthropic/model-c',
              'ollama/local-model',
              'local-lab/model-d',
            ],
            localProviderIds: new Set(['local-lab']),
            passiveProviderStatus: null,
            refreshRevision: 7,
            listener: (sourceProviderId, update) => {
              if (update.mode === 'publish') published.push(sourceProviderId);
            },
          }}
        />
      );
    });

    expect(catalogLoads).toEqual(['anthropic', 'openrouter']);
    expect(catalogRefreshRevisions).toEqual([7, 7]);
    expect(published).toEqual(['anthropic', 'openrouter']);
    await act(async () => root.unmount());
  });

  it('does not assume an unknown source is local before lookup settles', async () => {
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <OpenCodeProviderScopedDialogCatalogLoaders
          configuration={{
            enabled: true,
            projectPath: '/sandbox/project',
            selectedModels: ['openrouter/model-a'],
            localProviderIds: new Set(),
            passiveProviderStatus: null,
            refreshRevision: 7,
            listener: () => undefined,
          }}
        />
      );
    });

    expect(catalogLoads).toEqual(['openrouter']);
    await act(async () => root.unmount());
  });
});
