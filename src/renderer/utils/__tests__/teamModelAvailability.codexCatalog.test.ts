import { describe, expect, it } from 'vitest';

import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  isTeamModelAvailableForUi,
  normalizeTeamModelForUi,
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

function createAnthropicProviderStatus(
  models: NonNullable<CliProviderStatus['modelCatalog']>['models']
): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: true,
    authMethod: 'claude.ai',
    verificationState: 'verified',
    models: ['opus', 'claude-opus-4-6', 'sonnet', 'haiku'],
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: '2026-04-21T00:00:00.000Z',
      staleAt: '2026-04-21T00:10:00.000Z',
      defaultModelId: 'opus[1m]',
      defaultLaunchModel: 'opus[1m]',
      models,
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
    modelAvailability: [],
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: 'anthropic-models-api',
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
        plugins: { status: 'supported', ownership: 'shared', reason: null },
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

  it('allows app-server catalog models even when the runtime does not declare dynamic model launch', () => {
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

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual(['gpt-5.5']);
    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)[1]).toMatchObject({
      value: 'gpt-5.5',
      label: '5.5',
      badgeLabel: 'New',
      availabilityStatus: 'available',
    });
    expect(getTeamModelSelectionError('codex', 'gpt-5.5', providerStatus)).toBeNull();
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

  it('keeps the curated Anthropic picker surface while using runtime-backed labels', () => {
    const providerStatus = createAnthropicProviderStatus([
      {
        id: 'opus',
        launchModel: 'opus',
        displayName: 'Opus 4.8',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'anthropic-models-api',
        badgeLabel: 'Opus 4.8',
      },
      {
        id: 'opus[1m]',
        launchModel: 'opus[1m]',
        displayName: 'Opus 4.8 (1M)',
        hidden: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'anthropic-models-api',
      },
      {
        id: 'claude-opus-4-6',
        launchModel: 'claude-opus-4-6',
        displayName: 'Opus 4.6',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'anthropic-models-api',
        badgeLabel: 'Opus 4.6',
      },
      {
        id: 'sonnet',
        launchModel: 'sonnet',
        displayName: 'Sonnet 4.7',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'anthropic-models-api',
        badgeLabel: 'Sonnet 4.7',
      },
      {
        id: 'haiku',
        launchModel: 'haiku',
        displayName: 'Haiku 4.6',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'anthropic-models-api',
        badgeLabel: 'Haiku 4.6',
      },
      {
        id: 'claude-sonnet-4-6[1m]',
        launchModel: 'claude-sonnet-4-6[1m]',
        displayName: 'Sonnet 4.6 (1M)',
        hidden: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'static-fallback',
      },
    ]);

    expect(getAvailableTeamProviderModels('anthropic', providerStatus)).toEqual([
      'haiku',
      'opus',
      'claude-opus-4-6',
      'sonnet',
    ]);
    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual([
      {
        value: '',
        label: 'Default',
        badgeLabel: 'Default',
        availabilityStatus: undefined,
        availabilityReason: undefined,
      },
      {
        value: 'opus',
        label: 'Opus 4.8',
        badgeLabel: 'Opus 4.8',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'claude-opus-4-6',
        label: 'Opus 4.6',
        badgeLabel: 'Opus 4.6',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'sonnet',
        label: 'Sonnet 4.7',
        badgeLabel: 'Sonnet 4.7',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'haiku',
        label: 'Haiku 4.6',
        badgeLabel: 'Haiku 4.6',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
  });

  it('keeps persisted hidden Anthropic compatibility values valid when runtime catalog supplies them', () => {
    const providerStatus = createAnthropicProviderStatus([
      {
        id: 'claude-sonnet-4-6[1m]',
        launchModel: 'claude-sonnet-4-6[1m]',
        displayName: 'Sonnet 4.6 (1M)',
        hidden: true,
        supportedReasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'static-fallback',
      },
    ]);

    expect(isTeamModelAvailableForUi('anthropic', 'claude-sonnet-4-6[1m]', providerStatus)).toBe(
      true
    );
    expect(normalizeTeamModelForUi('anthropic', 'claude-sonnet-4-6[1m]', providerStatus)).toBe(
      'claude-sonnet-4-6[1m]'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-sonnet-4-6[1m]', providerStatus)).toBe(
      null
    );
  });
});
