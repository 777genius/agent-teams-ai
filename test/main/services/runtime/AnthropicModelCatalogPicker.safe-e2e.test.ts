// @vitest-environment node
import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { describe, expect, it } from 'vitest';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

interface RuntimeStatusMapper {
  mapRuntimeProviderStatus: (
    providerId: CliProviderId,
    runtimeStatus: unknown
  ) => CliProviderStatus;
}

function mapRuntimeProviderStatus(
  providerId: CliProviderId,
  runtimeStatus: unknown
): CliProviderStatus {
  const service = new ClaudeMultimodelBridgeService() as unknown as RuntimeStatusMapper;
  return service.mapRuntimeProviderStatus(providerId, runtimeStatus);
}

function createRuntimeCatalogModel(
  launchModel: string,
  displayName: string,
  options: {
    isDefault?: boolean;
    hidden?: boolean;
    efforts?: string[];
    badgeLabel?: string | null;
  } = {}
): Record<string, unknown> {
  return {
    id: launchModel,
    launchModel,
    displayName,
    hidden: options.hidden === true,
    supportedReasoningEfforts: options.efforts ?? ['low', 'medium', 'high'],
    defaultReasoningEffort: 'high',
    supportsFastMode: false,
    inputModalities: ['text', 'image'],
    supportsPersonality: false,
    isDefault: options.isDefault === true,
    upgrade: false,
    source: 'anthropic-models-api',
    badgeLabel: options.badgeLabel ?? displayName,
    statusMessage: null,
    metadata: {
      context: 1_000_000,
    },
  };
}

function createAnthropicRuntimeStatus(models: Record<string, unknown>[]): unknown {
  const visibleModels = models
    .filter((model) => model.hidden !== true)
    .map((model) => String(model.launchModel));

  return {
    supported: true,
    authenticated: true,
    authMethod: 'claude.ai',
    verificationState: 'verified',
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
    models: visibleModels,
    runtimeCapabilities: {
      modelCatalog: {
        dynamic: true,
        source: 'anthropic-models-api',
      },
      reasoningEffort: {
        supported: true,
        values: ['low', 'medium', 'high', 'max'],
        configPassthrough: false,
      },
    },
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source: 'anthropic-models-api',
      status: 'ready',
      fetchedAt: '2026-07-02T00:00:00.000Z',
      staleAt: '2026-07-02T00:10:00.000Z',
      defaultModelId: models[0]?.id ?? null,
      defaultLaunchModel: models[0]?.launchModel ?? null,
      models,
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
        message: null,
        code: null,
      },
    },
  };
}

describe('Anthropic model catalog picker safe e2e', () => {
  it('uses the runtime catalog as the account-scoped picker surface', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus([
        createRuntimeCatalogModel('claude-fable-5', 'Fable 5', {
          isDefault: true,
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-sonnet-5', 'Sonnet 5'),
      ])
    );

    expect(provider.modelCatalog?.source).toBe('anthropic-models-api');
    expect(provider.modelCatalogRefreshState).toBe('ready');
    expect(getAvailableTeamProviderModels('anthropic', provider)).toEqual([
      'claude-fable-5',
      'claude-sonnet-5',
    ]);
    expect(getAvailableTeamProviderModelOptions('anthropic', provider)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'claude-fable-5',
        label: 'Fable 5',
        badgeLabel: 'Fable 5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'claude-sonnet-5',
        label: 'Sonnet 5',
        badgeLabel: 'Sonnet 5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(normalizeTeamModelForUi('anthropic', 'claude-fable-5', provider)).toBe(
      'claude-fable-5'
    );
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', provider)).toBe('');
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', provider)).toContain(
      'not available for the current Anthropic runtime'
    );
  });

  it('makes Mythos selectable only when the runtime catalog reports access', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus([
        createRuntimeCatalogModel('claude-fable-5', 'Fable 5', {
          isDefault: true,
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-mythos-5', 'Mythos 5', {
          efforts: ['low', 'medium', 'high', 'max'],
        }),
        createRuntimeCatalogModel('claude-sonnet-5', 'Sonnet 5'),
      ])
    );

    expect(getAvailableTeamProviderModels('anthropic', provider)).toEqual([
      'claude-fable-5',
      'claude-mythos-5',
      'claude-sonnet-5',
    ]);
    expect(
      getAvailableTeamProviderModelOptions('anthropic', provider).map((option) => option.value)
    ).toEqual(['', 'claude-fable-5', 'claude-mythos-5', 'claude-sonnet-5']);
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', provider)).toBe(
      'claude-mythos-5'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', provider)).toBeNull();
  });
});
