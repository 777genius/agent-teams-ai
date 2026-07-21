// @vitest-environment node
import { ClaudeMultimodelBridgeService } from '@main/services/runtime/ClaudeMultimodelBridgeService';
import {
  addModelCatalogLaunchModels,
  validateRuntimeLaunchSelection,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { describe, expect, it } from 'vitest';

import type { RuntimeProviderLaunchFacts } from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import type {
  CliProviderId,
  CliProviderModelCatalogSource,
  CliProviderModelCatalogStatus,
  CliProviderStatus,
} from '@shared/types';

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

function createAnthropicRuntimeStatus(
  models: Record<string, unknown>[],
  options: {
    catalogSource?: CliProviderModelCatalogSource;
    catalogStatus?: CliProviderModelCatalogStatus;
  } = {}
): unknown {
  const catalogSource = options.catalogSource ?? 'anthropic-models-api';
  const catalogStatus = options.catalogStatus ?? 'ready';
  const catalogModels: Record<string, unknown>[] = models.map((model) => ({
    ...model,
    source: catalogSource,
  }));
  const visibleModels = catalogModels
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
        source: catalogSource,
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
      source: catalogSource,
      status: catalogStatus,
      fetchedAt: '2026-07-02T00:00:00.000Z',
      staleAt: '2026-07-02T00:10:00.000Z',
      defaultModelId: catalogModels[0]?.id ?? null,
      defaultLaunchModel: catalogModels[0]?.launchModel ?? null,
      models: catalogModels,
      diagnostics: {
        configReadState: catalogSource === 'static-fallback' ? 'failed' : 'ready',
        appServerState: catalogSource === 'static-fallback' ? 'degraded' : 'healthy',
        message: null,
        code: null,
      },
    },
  };
}

function createLaunchFacts(provider: CliProviderStatus): RuntimeProviderLaunchFacts {
  const modelIds = new Set(provider.models);
  if (provider.modelCatalog) {
    addModelCatalogLaunchModels(modelIds, provider.modelCatalog);
  }

  return {
    defaultModel: provider.modelCatalog?.defaultLaunchModel ?? provider.models[0] ?? null,
    modelIds,
    modelListParsed: true,
    modelCatalog: provider.modelCatalog ?? null,
    runtimeCapabilities: provider.runtimeCapabilities ?? null,
    providerStatus: provider,
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
    expect(normalizeTeamModelForUi('anthropic', 'claude-fable-5', provider)).toBe('claude-fable-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', provider)).toBe('');
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', provider)).toContain(
      'not available for the current Anthropic runtime'
    );
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-mythos-5',
        facts: createLaunchFacts(provider),
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).toThrow('current runtime does not list it as launchable');
  });

  it('launches a curated model when model discovery degraded to static fallback', () => {
    const provider = mapRuntimeProviderStatus(
      'anthropic',
      createAnthropicRuntimeStatus(
        [createRuntimeCatalogModel('sonnet', 'Sonnet 4.6', { isDefault: true })],
        {
          catalogSource: 'static-fallback',
          catalogStatus: 'degraded',
        }
      )
    );
    const launchFacts = createLaunchFacts(provider);

    expect(provider.modelCatalog?.source).toBe('static-fallback');
    expect(launchFacts.modelIds.has('claude-sonnet-5')).toBe(false);
    expect(
      getAvailableTeamProviderModelOptions('anthropic', provider).map((option) => option.value)
    ).toContain('claude-sonnet-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-sonnet-5', provider)).toBe(
      'claude-sonnet-5'
    );
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        facts: launchFacts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).not.toThrow();
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
