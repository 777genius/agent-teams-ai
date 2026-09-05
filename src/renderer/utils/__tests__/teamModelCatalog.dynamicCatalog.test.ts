import { describe, expect, it } from 'vitest';

import {
  getRuntimeAwareTeamModelBadgeLabel,
  getVisibleTeamProviderModels,
} from '../teamModelCatalog';

import type { CliProviderStatus } from '@shared/types';

function buildCodexStatus(): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'chatgpt',
    verificationState: 'verified',
    models: ['gpt-5.6-sol'],
    capabilities: {
      teamLaunch: true,
      oneShot: false,
      extensions: {
        plugins: { status: 'supported', ownership: 'shared' },
        mcp: { status: 'supported', ownership: 'shared' },
        skills: { status: 'supported', ownership: 'shared' },
        apiKeys: { status: 'supported', ownership: 'shared' },
      },
    },
    modelAvailability: [],
    modelCatalogRefreshState: 'ready',
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source: 'app-server' },
      reasoningEffort: {
        supported: true,
        values: ['medium'],
        configPassthrough: false,
      },
    },
    canLoginFromUi: true,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-09-05T12:00:00.000Z',
      staleAt: '2026-09-05T12:10:00.000Z',
      defaultModelId: 'gpt-6-astra',
      defaultLaunchModel: 'gpt-6-astra',
      models: [
        {
          id: 'gpt-6-astra',
          launchModel: 'gpt-6-astra',
          displayName: 'GPT-6-Astra',
          hidden: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
          badgeLabel: '6-astra',
          metadata: { recentlyReleased: true },
        },
        {
          id: 'gpt-5.6-sol',
          launchModel: 'gpt-5.6-sol',
          displayName: 'GPT-5.6-Sol',
          hidden: false,
          supportedReasoningEfforts: ['medium'],
          defaultReasoningEffort: 'medium',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: false,
          upgrade: false,
          source: 'app-server',
          badgeLabel: '5.6-sol',
          metadata: null,
        },
      ],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
  };
}

describe('dynamic Codex dashboard model catalog', () => {
  it('adds catalog-only models and keeps newest models first', () => {
    const provider = buildCodexStatus();

    expect(getVisibleTeamProviderModels('codex', provider.models, provider)).toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
    ]);
  });
});

describe('dynamic OpenCode dashboard model labels', () => {
  it('uses each model display name instead of repeating the provider source badge', () => {
    const provider = {
      providerId: 'opencode',
      modelCatalog: {
        providerId: 'opencode',
        models: [
          {
            id: 'opencode/big-pickle',
            launchModel: 'opencode/big-pickle',
            displayName: 'Big Pickle',
            badgeLabel: 'OpenCode Zen',
          },
          {
            id: 'opencode/kimi-k2.5-free',
            launchModel: 'opencode/kimi-k2.5-free',
            displayName: 'Kimi K2.5 Free',
            badgeLabel: 'OpenCode Zen',
          },
        ],
      },
    } as CliProviderStatus;

    expect(getRuntimeAwareTeamModelBadgeLabel('opencode', 'opencode/big-pickle', provider)).toBe(
      'Big Pickle'
    );
    expect(
      getRuntimeAwareTeamModelBadgeLabel('opencode', 'opencode/kimi-k2.5-free', provider)
    ).toBe('Kimi K2.5 Free');
  });
});
