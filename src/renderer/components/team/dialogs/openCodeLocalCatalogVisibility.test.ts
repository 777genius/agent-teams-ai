import {
  countConfiguredLocalOpenCodeCatalogModels,
  isKnownConfiguredLocalOpenCodeCatalogModel,
} from '@shared/utils/opencodeModelRoute';
import { describe, expect, it } from 'vitest';

import {
  isAppManagedOpenCodeLocalModel,
  shouldRetainOpenCodeLocalCatalogModel,
} from './openCodeLocalCatalogVisibility';

const ollamaCatalogModel = {
  id: 'ollama/qwen',
  launchModel: 'ollama/qwen',
  metadata: {
    opencode: {
      providerId: 'ollama',
      routeKind: 'configured_local' as const,
      accessKind: 'configured_authless',
    },
  },
};

describe('openCodeLocalCatalogVisibility', () => {
  it('treats known local configured routes as app-managed', () => {
    expect(isAppManagedOpenCodeLocalModel('ollama/qwen', ollamaCatalogModel)).toBe(true);
    expect(
      isAppManagedOpenCodeLocalModel('kiro/auto', {
        id: 'kiro/auto',
        metadata: {
          opencode: {
            providerId: 'kiro',
            routeKind: 'configured_local',
            accessKind: 'configured_authless',
          },
        },
      })
    ).toBe(false);
  });

  it('retains catalog Ollama when the live overlay is empty', () => {
    expect(
      shouldRetainOpenCodeLocalCatalogModel('ollama/qwen', ollamaCatalogModel, new Set())
    ).toBe(true);
    expect(
      shouldRetainOpenCodeLocalCatalogModel(
        'corp-local/model',
        {
          id: 'corp-local/model',
          metadata: {
            opencode: {
              providerId: 'corp-local',
              routeKind: 'configured_local',
              accessKind: 'configured_authless',
            },
          },
        },
        new Set()
      )
    ).toBe(false);
  });

  it('retains overlay-discovered models even when they are not catalog local routes', () => {
    expect(
      shouldRetainOpenCodeLocalCatalogModel('corp-local/model', null, new Set(['corp-local/model']))
    ).toBe(true);
  });
});

describe('v2.14.1 vs current OpenCode local-provider status', () => {
  function formatV2141RuntimeAuthSummary(input: {
    connectedCount: number;
    configuredLocalCount: number;
  }): string {
    return input.connectedCount > 0
      ? `Providers: ${input.connectedCount} connected`
      : 'Connect a provider to get started';
  }

  function formatCurrentRuntimeAuthSummary(input: {
    connectedCount: number;
    configuredLocalCount: number;
  }): string {
    if (input.connectedCount <= 0 && input.configuredLocalCount <= 0) {
      return 'Connect a provider to get started';
    }
    return [
      ...(input.connectedCount > 0 ? [`Providers: ${input.connectedCount} connected`] : []),
      ...(input.configuredLocalCount > 0 ? [`${input.configuredLocalCount} configured local`] : []),
    ].join(' · ');
  }

  it('already dropped Ollama from the connected header in v2.14.1', () => {
    const configuredLocalCount = countConfiguredLocalOpenCodeCatalogModels([ollamaCatalogModel]);
    expect(configuredLocalCount).toBe(1);
    expect(formatV2141RuntimeAuthSummary({ connectedCount: 0, configuredLocalCount })).toBe(
      'Connect a provider to get started'
    );
    expect(formatCurrentRuntimeAuthSummary({ connectedCount: 0, configuredLocalCount })).toBe(
      '1 configured local'
    );
  });

  it('already hid catalog Ollama after an empty overlay scan in v2.14.1', () => {
    const emptyOverlay = new Set<string>();
    const v2141KeptCatalogLocal =
      emptyOverlay.has('ollama/qwen') ||
      !isAppManagedOpenCodeLocalModel('ollama/qwen', ollamaCatalogModel);
    expect(v2141KeptCatalogLocal).toBe(false);
    expect(isKnownConfiguredLocalOpenCodeCatalogModel('ollama/qwen', ollamaCatalogModel)).toBe(
      true
    );
    expect(
      shouldRetainOpenCodeLocalCatalogModel('ollama/qwen', ollamaCatalogModel, emptyOverlay)
    ).toBe(true);
  });
});
