import { describe, expect, it } from 'vitest';

import {
  getAvailableTeamEffortValue,
  getTeamEffortOptions,
  getTeamEffortSelectorPresentation,
} from '../teamEffortOptions';

import type { CliProviderStatus } from '@shared/types';

function createProviderStatus(
  providerId: CliProviderStatus['providerId'],
  model: NonNullable<CliProviderStatus['modelCatalog']>['models'][number],
  options: {
    source?: 'anthropic-models-api' | 'app-server' | 'static-fallback';
    configPassthrough?: boolean;
    runtimeValues?: CliProviderStatus['runtimeCapabilities'] | null;
  } = {}
): CliProviderStatus {
  const source =
    options.source ?? (providerId === 'anthropic' ? 'anthropic-models-api' : 'app-server');

  return {
    providerId,
    displayName: providerId === 'anthropic' ? 'Anthropic' : 'Codex',
    supported: true,
    authenticated: true,
    authMethod: providerId === 'anthropic' ? 'claude.ai' : 'chatgpt',
    verificationState: 'verified',
    models: [model.launchModel],
    modelCatalog: {
      schemaVersion: 1,
      providerId,
      source,
      status: 'ready',
      fetchedAt: '2026-04-21T00:00:00.000Z',
      staleAt: '2026-04-21T00:10:00.000Z',
      defaultModelId: model.id,
      defaultLaunchModel: model.launchModel,
      models: [model],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    },
    modelAvailability: [],
    runtimeCapabilities:
      options.runtimeValues === undefined
        ? {
            modelCatalog: { dynamic: true, source },
            reasoningEffort: {
              supported: true,
              values: model.supportedReasoningEfforts,
              configPassthrough: options.configPassthrough === true,
            },
          }
        : options.runtimeValues,
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

describe('team effort options', () => {
  it('keeps Codex xhigh when runtime catalog and passthrough say it is valid', () => {
    const providerStatus = createProviderStatus(
      'codex',
      {
        id: 'gpt-5.4',
        launchModel: 'gpt-5.4',
        displayName: 'GPT-5.4',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'app-server',
      },
      { configPassthrough: true }
    );

    expect(getTeamEffortOptions({ providerId: 'codex', model: 'gpt-5.4', providerStatus })).toEqual(
      [
        { value: '', label: 'Default (Medium)' },
        { value: 'low', label: 'Low' },
        { value: 'medium', label: 'Medium' },
        { value: 'high', label: 'High' },
        { value: 'xhigh', label: 'XHigh' },
      ]
    );
  });

  it('keeps Anthropic aliases conservative when the resolved runtime model does not support effort', () => {
    const providerStatus = createProviderStatus('anthropic', {
      id: 'opus[1m]',
      launchModel: 'opus[1m]',
      displayName: 'Opus 4.7 (1M)',
      hidden: true,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text', 'image'],
      supportsFastMode: false,
      supportsPersonality: false,
      isDefault: true,
      upgrade: false,
      source: 'anthropic-models-api',
    });

    expect(
      getTeamEffortOptions({ providerId: 'anthropic', model: 'opus', providerStatus })
    ).toEqual([{ value: '', label: 'Default' }]);
  });

  it('shows Anthropic max only for the exact resolved model that supports it', () => {
    const providerStatus = {
      ...createProviderStatus('anthropic', {
        id: 'claude-opus-4-6',
        launchModel: 'claude-opus-4-6',
        displayName: 'Opus 4.6',
        hidden: false,
        supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
        defaultReasoningEffort: 'medium',
        inputModalities: ['text', 'image'],
        supportsFastMode: true,
        supportsPersonality: false,
        isDefault: false,
        upgrade: false,
        source: 'anthropic-models-api',
      }),
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic' as const,
        source: 'anthropic-models-api' as const,
        status: 'ready' as const,
        fetchedAt: '2026-04-21T00:00:00.000Z',
        staleAt: '2026-04-21T00:10:00.000Z',
        defaultModelId: 'opus[1m]',
        defaultLaunchModel: 'opus[1m]',
        models: [
          {
            id: 'opus[1m]',
            launchModel: 'opus[1m]',
            displayName: 'Opus 4.7 (1M)',
            hidden: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text', 'image'],
            supportsFastMode: false,
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api' as const,
          },
          {
            id: 'claude-opus-4-6',
            launchModel: 'claude-opus-4-6',
            displayName: 'Opus 4.6',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsFastMode: true,
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api' as const,
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
    } satisfies CliProviderStatus;

    expect(
      getTeamEffortOptions({
        providerId: 'anthropic',
        model: 'claude-opus-4-6',
        providerStatus,
      })
    ).toEqual([
      { value: '', label: 'Default (Medium)' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
  });

  it('shows fallback Anthropic effort options for known models while catalog truth is unavailable', () => {
    expect(
      getTeamEffortOptions({
        providerId: 'anthropic',
        model: 'claude-opus-4-6[1m]',
        providerStatus: {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'claude.ai',
          verificationState: 'verified',
          models: ['claude-opus-4-6'],
          modelCatalog: null,
          modelAvailability: [],
          runtimeCapabilities: null,
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
        },
      })
    ).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
  });

  it('does not invent Anthropic effort options for unknown models without catalog truth', () => {
    expect(
      getTeamEffortOptions({
        providerId: 'anthropic',
        model: 'claude-experimental-5',
        providerStatus: null,
      })
    ).toEqual([{ value: '', label: 'Default' }]);
  });

  it('shows known Anthropic effort options when catalog lacks the exact selected model entry', () => {
    const providerStatus = createProviderStatus(
      'anthropic',
      {
        id: 'haiku',
        launchModel: 'haiku',
        displayName: 'Haiku 4.5',
        hidden: false,
        supportedReasoningEfforts: [],
        defaultReasoningEffort: null,
        inputModalities: ['text', 'image'],
        supportsPersonality: false,
        isDefault: true,
        upgrade: false,
        source: 'anthropic-models-api',
      },
      { runtimeValues: null }
    );

    const presentation = getTeamEffortSelectorPresentation({
      providerId: 'anthropic',
      model: 'claude-opus-4-6[1m]',
      providerStatus,
    });

    expect(presentation.options).toEqual([
      { value: '', label: 'Default' },
      { value: 'low', label: 'Low' },
      { value: 'medium', label: 'Medium' },
      { value: 'high', label: 'High' },
      { value: 'max', label: 'Max' },
    ]);
    expect(presentation.disabled).toBe(false);
    expect(presentation.canValidateValue).toBe(false);
  });

  it('shows only Default when the selected Anthropic model does not support effort', () => {
    const providerStatus = createProviderStatus('anthropic', {
      id: 'haiku',
      launchModel: 'haiku',
      displayName: 'Haiku 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: false,
      upgrade: false,
      source: 'anthropic-models-api',
    });

    expect(
      getTeamEffortOptions({ providerId: 'anthropic', model: 'haiku', providerStatus })
    ).toEqual([{ value: '', label: 'Default' }]);
  });

  it('presents Anthropic no-effort models as disabled with explicit copy', () => {
    const providerStatus = createProviderStatus('anthropic', {
      id: 'haiku',
      launchModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: false,
      upgrade: false,
      source: 'anthropic-models-api',
    });

    expect(
      getTeamEffortSelectorPresentation({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        providerStatus,
      })
    ).toMatchObject({
      options: [{ value: '', label: 'Not supported' }],
      disabled: true,
      canValidateValue: true,
      unavailableText: 'Effort is unavailable for this model.',
    });
  });

  it('omits stale Anthropic effort when the selected model has no effort support', () => {
    const providerStatus = createProviderStatus('anthropic', {
      id: 'haiku',
      launchModel: 'claude-haiku-4-5-20251001',
      displayName: 'Haiku 4.5',
      hidden: false,
      supportedReasoningEfforts: [],
      defaultReasoningEffort: null,
      inputModalities: ['text', 'image'],
      supportsPersonality: false,
      isDefault: false,
      upgrade: false,
      source: 'anthropic-models-api',
    });

    expect(
      getAvailableTeamEffortValue({
        providerId: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        providerStatus,
        value: 'medium',
      })
    ).toBe('');
  });
});
