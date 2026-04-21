import { describe, expect, it } from 'vitest';

import {
  CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON,
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
} from '../teamModelAvailability';

import type { CliProviderStatus } from '@shared/types';

function createCodexProviderStatus(
  models: NonNullable<CliProviderStatus['modelCatalog']>['models'],
  options: { dynamicLaunch?: boolean } = {}
): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: true,
    authMethod: 'chatgpt',
    verificationState: 'verified',
    models: models.map((model) => model.launchModel),
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-04-21T00:00:00.000Z',
      staleAt: '2026-04-21T00:01:00.000Z',
      defaultModelId: models[0]?.id ?? null,
      defaultLaunchModel: models[0]?.launchModel ?? null,
      models,
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
    modelAvailability: [],
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: options.dynamicLaunch === true,
        source: 'app-server',
      },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high'],
        configPassthrough: false,
      },
    },
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: {
        plugins: { status: 'unsupported', ownership: 'shared', reason: null },
        mcp: { status: 'supported', ownership: 'shared', reason: null },
        skills: { status: 'supported', ownership: 'shared', reason: null },
        apiKeys: { status: 'supported', ownership: 'shared', reason: null },
      },
    },
  };
}

describe('team model availability Codex catalog integration', () => {
  it('uses app-server catalog models even when the static Codex list has not learned a new model yet', () => {
    const providerStatus = createCodexProviderStatus(
      [
        {
          id: 'gpt-5.5',
          launchModel: 'gpt-5.5',
          displayName: 'GPT-5.5',
          hidden: false,
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'app-server',
          badgeLabel: '5.5',
        },
      ],
      { dynamicLaunch: true }
    );

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual(['gpt-5.5']);
    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'gpt-5.5',
        label: '5.5',
        badgeLabel: '5.5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
  });

  it('shows app-server future models but blocks launch until runtime declares dynamic support', () => {
    const providerStatus = createCodexProviderStatus([
      {
        id: 'gpt-5.5',
        launchModel: 'gpt-5.5',
        displayName: 'GPT-5.5',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'high',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
    ]);

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual([]);
    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)[1]).toMatchObject({
      value: 'gpt-5.5',
      label: '5.5',
      badgeLabel: 'New',
      availabilityStatus: null,
    });
    expect(getTeamModelSelectionError('codex', 'gpt-5.5', providerStatus)).toContain(
      CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON
    );
  });

  it('keeps existing disabled model policy on top of the dynamic catalog', () => {
    const providerStatus = createCodexProviderStatus([
      {
        id: 'gpt-5.3-codex-spark',
        launchModel: 'gpt-5.3-codex-spark',
        displayName: 'GPT-5.3 Codex Spark',
        hidden: false,
        supportedReasoningEfforts: ['high'],
        defaultReasoningEffort: 'high',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'app-server',
      },
      {
        id: 'gpt-5.4',
        launchModel: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
    ]);

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual(['gpt-5.4']);
  });
});
