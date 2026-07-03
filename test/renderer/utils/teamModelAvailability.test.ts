import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  getTeamModelUiDisabledReason,
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  normalizeTeamModelForUi,
  type TeamModelRuntimeProviderStatus,
} from '@renderer/utils/teamModelAvailability';
import { describe, expect, it } from 'vitest';

function createCodexProviderStatus(
  models: string[],
  overrides: Partial<TeamModelRuntimeProviderStatus> = {}
): TeamModelRuntimeProviderStatus {
  return {
    providerId: 'codex',
    models,
    authMethod: 'api_key',
    backend: {
      kind: 'codex-native',
      label: 'Codex native',
      endpointLabel: 'codex exec --json',
    },
    authenticated: true,
    supported: true,
    modelVerificationState: 'idle',
    modelAvailability: [],
    ...overrides,
  };
}

function createOpenCodeProviderStatus(
  models: string[],
  overrides: Partial<TeamModelRuntimeProviderStatus> = {}
): TeamModelRuntimeProviderStatus {
  return {
    providerId: 'opencode',
    models,
    authMethod: 'opencode_managed',
    backend: {
      kind: 'opencode-cli',
      label: 'OpenCode CLI',
    },
    authenticated: true,
    supported: true,
    modelVerificationState: 'idle',
    modelAvailability: [],
    ...overrides,
  };
}

function createAnthropicCompatibleProviderStatus(
  overrides: Partial<TeamModelRuntimeProviderStatus> = {}
): TeamModelRuntimeProviderStatus {
  return {
    providerId: 'anthropic',
    models: [],
    authMethod: 'api_key',
    backend: null,
    authenticated: true,
    supported: true,
    modelVerificationState: 'idle',
    modelAvailability: [],
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'oauth', 'api_key'],
      configuredAuthMode: 'auto',
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
      compatibleEndpoint: {
        enabled: true,
        baseUrl: 'http://localhost:1234',
        tokenConfigured: true,
        tokenSource: 'stored',
        tokenSourceLabel: 'Stored in app',
      },
    },
    ...overrides,
  };
}

describe('teamModelAvailability', () => {
  it('uses runtime-reported Codex models as the source of truth', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.3-codex']);

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual([
      'gpt-5.4',
      'gpt-5.3-codex',
    ]);
  });

  it('filters only the Codex models that remain UI-disabled on the native runtime path', () => {
    const providerStatus = createCodexProviderStatus([
      'gpt-5.4',
      'gpt-5.3-codex-spark',
      'gpt-5.2-codex',
      'gpt-5.1-codex-mini',
      'gpt-5.1-codex-max',
    ]);

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual([
      'gpt-5.4',
      'gpt-5.1-codex-max',
    ]);
  });

  it('keeps 5.1 Codex Max available on the native runtime path', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.1-codex-max'], {
      authMethod: 'api_key',
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
      },
    });

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual([
      'gpt-5.4',
      'gpt-5.1-codex-max',
    ]);
  });

  it('hides 5.1 Codex Max on the ChatGPT subscription-backed path', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.1-codex-max'], {
      authMethod: 'chatgpt',
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
        authMethodDetail: 'chatgpt',
      },
    });

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual(['gpt-5.4']);
    expect(normalizeTeamModelForUi('codex', 'gpt-5.1-codex-max', providerStatus)).toBe('');
    expect(getTeamModelSelectionError('codex', 'gpt-5.1-codex-max', providerStatus)).toContain(
      'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.'
    );
  });

  it('builds Codex model options from the runtime list plus disabled safety entries', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.3-codex']);

    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'gpt-5.4',
        label: '5.4',
        badgeLabel: undefined,
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'gpt-5.3-codex',
        label: '5.3 Codex',
        badgeLabel: undefined,
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'gpt-5.3-codex-spark',
        label: '5.3 Codex Spark',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
      {
        value: 'gpt-5.2-codex',
        label: '5.2 Codex',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
      {
        value: 'gpt-5.1-codex-mini',
        label: '5.1 Codex Mini',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
    ]);
  });

  it('treats runtime-reported unavailable models as non-selectable', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4'], {
      modelAvailability: [
        {
          modelId: 'gpt-5.4',
          status: 'unavailable',
          reason: 'No access for this account',
          checkedAt: null,
        },
      ],
    });

    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual([]);
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', providerStatus)).toBe('');
    expect(getTeamModelSelectionError('codex', 'gpt-5.4', providerStatus)).toContain(
      'No access for this account'
    );
    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'gpt-5.4',
        label: '5.4',
        badgeLabel: undefined,
        availabilityStatus: 'unavailable',
        availabilityReason: 'No access for this account',
      },
      {
        value: 'gpt-5.3-codex-spark',
        label: '5.3 Codex Spark',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
      {
        value: 'gpt-5.2-codex',
        label: '5.2 Codex',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
      {
        value: 'gpt-5.1-codex-mini',
        label: '5.1 Codex Mini',
        badgeLabel: undefined,
        availabilityStatus: null,
        availabilityReason: null,
      },
    ]);
  });

  it('keeps OpenCode raw ids intact while exposing readable labels and source badges', () => {
    const providerStatus = createOpenCodeProviderStatus([
      'openai/gpt-5.4',
      'openrouter/moonshotai/kimi-k2',
      'opencode/big-pickle',
    ]);

    expect(getAvailableTeamProviderModels('opencode', providerStatus)).toEqual([
      'opencode/big-pickle',
      'openai/gpt-5.4',
      'openrouter/moonshotai/kimi-k2',
    ]);

    expect(getAvailableTeamProviderModelOptions('opencode', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'opencode/big-pickle',
        label: 'big-pickle',
        badgeLabel: 'OpenCode',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'openai/gpt-5.4',
        label: 'GPT-5.4',
        badgeLabel: 'OpenAI',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'openrouter/moonshotai/kimi-k2',
        label: 'moonshotai/kimi-k2',
        badgeLabel: 'OpenRouter',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(
      normalizeTeamModelForUi('opencode', 'openrouter/moonshotai/kimi-k2', providerStatus)
    ).toBe('openrouter/moonshotai/kimi-k2');
  });

  it('keeps the live OpenCode model list authoritative when the catalog is broader', () => {
    const providerStatus = createOpenCodeProviderStatus(['opencode/big-pickle'], {
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
            id: 'opencode/minimax-m3-free',
            launchModel: 'opencode/minimax-m3-free',
            displayName: 'opencode/minimax-m3-free',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: false,
            upgrade: false,
            source: 'app-server',
            badgeLabel: 'Free',
          },
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
    });

    expect(getAvailableTeamProviderModels('opencode', providerStatus)).toEqual([
      'opencode/big-pickle',
    ]);
    expect(getAvailableTeamProviderModelOptions('opencode', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'opencode/big-pickle',
        label: 'big-pickle',
        badgeLabel: 'OpenCode',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(normalizeTeamModelForUi('opencode', 'opencode/minimax-m3-free', providerStatus)).toBe(
      ''
    );
    expect(
      getTeamModelSelectionError('opencode', 'opencode/minimax-m3-free', providerStatus)
    ).toContain('is not available for the current OpenCode runtime');
  });

  it('uses the OpenCode model catalog when runtime models are empty', () => {
    const providerStatus = createOpenCodeProviderStatus([], {
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
    });

    expect(getAvailableTeamProviderModels('opencode', providerStatus)).toEqual([
      'opencode/big-pickle',
      'openai/gpt-5.4',
    ]);
    expect(
      getAvailableTeamProviderModelOptions('opencode', providerStatus).map((option) => option.value)
    ).toEqual(['', 'opencode/big-pickle', 'openai/gpt-5.4']);
  });

  it('reports OpenCode openai routes unavailable when OpenAI auth is invalid', () => {
    const providerStatus = createOpenCodeProviderStatus(['openai/gpt-5.4', 'opencode/big-pickle'], {
      statusMessage: 'OpenAI token invalid',
      detailMessage: 'OpenAI token refresh failed: 401',
      availableBackends: [
        {
          id: 'openai',
          label: 'OpenAI',
          description: 'OpenAI route',
          selectable: false,
          recommended: false,
          available: false,
          state: 'authentication-required',
          statusMessage: 'Authentication required',
          detailMessage: 'Token refresh failed: 401',
        },
      ],
    });

    expect(getTeamModelSelectionError('opencode', 'openai/gpt-5.4', providerStatus)).toContain(
      'OpenCode OpenAI provider authentication failed'
    );
    expect(
      getTeamModelSelectionError('opencode', 'opencode/big-pickle', providerStatus)
    ).toBeNull();
  });

  it('clears stale Codex selections when runtime no longer reports that model', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.3-codex']);

    expect(normalizeTeamModelForUi('codex', 'gpt-5.2-codex', providerStatus)).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', providerStatus)).toBe('gpt-5.4');
  });

  it('reports an explicit error when a Codex model is unsupported by the current runtime', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.3-codex']);

    expect(getTeamModelSelectionError('codex', 'gpt-5.2-codex', providerStatus)).toContain(
      'Temporarily disabled for team agents'
    );
    expect(getTeamModelSelectionError('codex', 'gpt-5.4', providerStatus)).toBeNull();
  });

  it('does not raise a hard validation error while explicit Codex models are still loading', () => {
    expect(getTeamModelSelectionError('codex', 'gpt-5.4')).toBeNull();
    expect(getTeamModelSelectionError('codex', '')).toBeNull();
  });

  it('keeps known Codex selections stable while the runtime is still on placeholder checking state', () => {
    const providerStatus = createCodexProviderStatus([], {
      authMethod: null,
      backend: null,
      authenticated: false,
      supported: false,
      verificationState: 'unknown',
      modelVerificationState: 'idle',
      statusMessage: 'Checking...',
    });

    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', providerStatus)).toBe('gpt-5.4');
    expect(getTeamModelSelectionError('codex', 'gpt-5.4', providerStatus)).toBeNull();
    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'gpt-5.5', label: '5.5', badgeLabel: '5.5' },
      { value: 'gpt-5.4', label: '5.4', badgeLabel: '5.4' },
      { value: 'gpt-5.4-mini', label: '5.4 Mini', badgeLabel: '5.4-mini' },
      { value: 'gpt-5.3-codex', label: '5.3 Codex', badgeLabel: '5.3-codex' },
      {
        value: 'gpt-5.3-codex-spark',
        label: '5.3 Codex Spark',
        badgeLabel: '5.3-codex-spark',
        uiDisabledReason: GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
      },
      { value: 'gpt-5.2', label: '5.2', badgeLabel: '5.2' },
      {
        value: 'gpt-5.2-codex',
        label: '5.2 Codex',
        badgeLabel: '5.2-codex',
        uiDisabledReason: GPT_5_2_CODEX_UI_DISABLED_REASON,
      },
      {
        value: 'gpt-5.1-codex-mini',
        label: '5.1 Codex Mini',
        badgeLabel: '5.1-codex-mini',
        uiDisabledReason: GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
      },
      { value: 'gpt-5.1-codex-max', label: '5.1 Codex Max', badgeLabel: '5.1-codex-max' },
    ]);
  });

  it('keeps known Codex selections stable while Codex native account truth is loaded before the runtime model catalog', () => {
    const providerStatus = createCodexProviderStatus([], {
      authMethod: 'chatgpt',
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
      },
      authenticated: true,
      supported: true,
      verificationState: 'verified',
      modelVerificationState: 'idle',
      statusMessage: 'ChatGPT account ready',
    });

    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', providerStatus)).toBe('gpt-5.4');
    expect(getTeamModelSelectionError('codex', 'gpt-5.4', providerStatus)).toBeNull();
  });

  it('keeps runtime models selectable without per-model verification state', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4']);
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', providerStatus)).toBe('gpt-5.4');
    expect(getAvailableTeamProviderModels('codex', providerStatus)).toEqual(['gpt-5.4']);
    expect(getTeamModelSelectionError('codex', 'gpt-5.4', providerStatus)).toBeNull();
  });

  it('does not require runtime verification for Anthropic curated models', () => {
    expect(normalizeTeamModelForUi('anthropic', 'opus')).toBe('opus');
    expect(getTeamModelSelectionError('anthropic', 'opus')).toBeNull();
  });

  it('keeps Anthropic Fable, Sonnet 5, Opus 4.8, explicit 4.7, and explicit 4.6 in the fallback selector options', () => {
    expect(getAvailableTeamProviderModelOptions('anthropic')).toEqual([
      {
        value: '',
        label: 'Default',
        badgeLabel: 'Default',
        availabilityStatus: undefined,
        availabilityReason: undefined,
      },
      {
        value: 'fable',
        label: 'Fable 5',
        badgeLabel: 'Fable 5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'opus',
        label: 'Opus 4.8',
        badgeLabel: 'Opus 4.8',
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
      {
        value: 'claude-opus-4-7',
        label: 'Opus 4.7',
        badgeLabel: 'Opus 4.7',
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
        label: 'Sonnet 4.6',
        badgeLabel: 'Sonnet 4.6',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'haiku',
        label: 'Haiku 4.5',
        badgeLabel: 'Haiku 4.5',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
  });

  it('does not let stale first-party Anthropic runtime labels downgrade the Opus alias', () => {
    const providerStatus: TeamModelRuntimeProviderStatus = {
      providerId: 'anthropic',
      models: ['opus', 'claude-opus-4-7'],
      authMethod: 'oauth',
      backend: null,
      authenticated: true,
      supported: true,
      modelVerificationState: 'idle',
      modelAvailability: [],
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-05-31T00:00:00.000Z',
        staleAt: '2026-05-31T00:10:00.000Z',
        defaultModelId: 'opus',
        defaultLaunchModel: 'opus',
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
        models: [
          {
            id: 'claude-sonnet-5',
            launchModel: 'claude-sonnet-5',
            displayName: 'Sonnet 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'opus',
            launchModel: 'opus',
            displayName: 'Opus 4.7',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
      },
    };

    const options = getAvailableTeamProviderModelOptions('anthropic', providerStatus);

    expect(options.find((option) => option.value === 'opus')).toMatchObject({
      label: 'Opus 4.8',
      badgeLabel: 'Opus 4.8',
    });
    expect(options.find((option) => option.value === 'claude-opus-4-7')).toBeUndefined();
  });

  it('uses first-party Anthropic catalog models without curated fallback rows', () => {
    const providerStatus: TeamModelRuntimeProviderStatus = {
      providerId: 'anthropic',
      models: ['opus', 'claude-sonnet-4-7'],
      authMethod: 'oauth',
      backend: null,
      authenticated: true,
      supported: true,
      modelVerificationState: 'idle',
      modelAvailability: [],
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-06-20T00:00:00.000Z',
        staleAt: '2026-06-20T00:10:00.000Z',
        defaultModelId: 'opus',
        defaultLaunchModel: 'opus',
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
        models: [
          {
            id: 'claude-sonnet-5',
            launchModel: 'claude-sonnet-5',
            displayName: 'Sonnet 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'opus',
            launchModel: 'opus',
            displayName: 'Opus 4.9',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-sonnet-4-7',
            launchModel: 'claude-sonnet-4-7',
            displayName: 'Sonnet 4.7',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-sonnet-4-7[1m]',
            launchModel: 'claude-sonnet-4-7[1m]',
            displayName: 'Sonnet 4.7 (1M)',
            hidden: true,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
      },
    };

    const options = getAvailableTeamProviderModelOptions('anthropic', providerStatus);
    const values = options.map((option) => option.value);

    expect(values).not.toContain('fable');
    expect(values).not.toContain('claude-mythos-5');
    expect(options.find((option) => option.value === 'opus')).toMatchObject({
      label: 'Opus 4.9',
      badgeLabel: 'Opus 4.9',
    });
    expect(options.find((option) => option.value === 'claude-sonnet-5')).toMatchObject({
      label: 'Sonnet 5',
      badgeLabel: 'Sonnet 5',
      availabilityStatus: 'available',
    });
    expect(values.indexOf('claude-sonnet-5')).toBeLessThan(values.indexOf('opus'));
    expect(values).toContain('claude-sonnet-4-7');
    expect(values).not.toContain('claude-opus-4-7');
    expect(values).not.toContain('claude-sonnet-4-7[1m]');
    expect(normalizeTeamModelForUi('anthropic', 'claude-sonnet-4-7', providerStatus)).toBe(
      'claude-sonnet-4-7'
    );
    expect(
      getTeamModelSelectionError('anthropic', 'claude-sonnet-4-7', providerStatus)
    ).toBeNull();
  });

  it('makes Mythos selectable when the first-party Anthropic catalog reports account access', () => {
    const providerStatus: TeamModelRuntimeProviderStatus = {
      providerId: 'anthropic',
      models: ['claude-mythos-5'],
      authMethod: 'oauth',
      backend: null,
      authenticated: true,
      supported: true,
      modelVerificationState: 'idle',
      modelAvailability: [],
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-models-api',
        status: 'ready',
        fetchedAt: '2026-06-20T00:00:00.000Z',
        staleAt: '2026-06-20T00:10:00.000Z',
        defaultModelId: 'claude-fable-5',
        defaultLaunchModel: 'claude-fable-5',
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
        models: [
          {
            id: 'claude-fable-5',
            launchModel: 'claude-fable-5',
            displayName: 'Fable 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-models-api',
          },
          {
            id: 'claude-mythos-5',
            launchModel: 'claude-mythos-5',
            displayName: 'Mythos 5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'max'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-models-api',
          },
        ],
      },
    };

    expect(getTeamModelUiDisabledReason('anthropic', 'claude-mythos-5', providerStatus)).toBeNull();
    expect(normalizeTeamModelForUi('anthropic', 'claude-mythos-5', providerStatus)).toBe(
      'claude-mythos-5'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-mythos-5', providerStatus)).toBeNull();
    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          value: 'claude-mythos-5',
          label: 'Mythos 5',
          badgeLabel: 'Mythos 5',
          availabilityStatus: 'available',
        }),
      ])
    );
  });

  it('keeps known Anthropic full model ids selectable without runtime verification', () => {
    expect(normalizeTeamModelForUi('anthropic', 'fable')).toBe('fable');
    expect(normalizeTeamModelForUi('anthropic', 'claude-fable-5')).toBe('claude-fable-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-8')).toBe('claude-opus-4-8');
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-8[1m]')).toBe('claude-opus-4-8[1m]');
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-7[1m]')).toBe('claude-opus-4-7[1m]');
    expect(normalizeTeamModelForUi('anthropic', 'claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5-20251001'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-8')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-7')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'claude-haiku-4-5-20251001')).toBeNull();
  });

  it('uses Anthropic-compatible runtime catalog models instead of curated Claude aliases', () => {
    const providerStatus = createAnthropicCompatibleProviderStatus({
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-compatible-api',
        status: 'ready',
        fetchedAt: '2026-05-21T00:00:00.000Z',
        staleAt: '2026-05-21T00:10:00.000Z',
        defaultModelId: 'openai/gpt-oss-20b',
        defaultLaunchModel: 'openai/gpt-oss-20b',
        models: [
          {
            id: 'openai/gpt-oss-20b',
            launchModel: 'openai/gpt-oss-20b',
            displayName: 'GPT OSS 20B',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-compatible-api',
            badgeLabel: 'Local',
          },
          {
            id: 'hidden-local',
            launchModel: 'hidden-local',
            displayName: 'Hidden',
            hidden: true,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: false,
            upgrade: false,
            source: 'anthropic-compatible-api',
            badgeLabel: null,
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
    });

    expect(getAvailableTeamProviderModels('anthropic', providerStatus)).toEqual([
      'openai/gpt-oss-20b',
    ]);
    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'openai/gpt-oss-20b',
        label: 'GPT OSS 20B',
        badgeLabel: 'Local',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(normalizeTeamModelForUi('anthropic', 'openai/gpt-oss-20b', providerStatus)).toBe(
      'openai/gpt-oss-20b'
    );
    expect(normalizeTeamModelForUi('anthropic', 'opus', providerStatus)).toBe('');
  });

  it('keeps custom Anthropic-compatible model ids selectable when the catalog is degraded', () => {
    const providerStatus = createAnthropicCompatibleProviderStatus({
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-compatible-api',
        status: 'degraded',
        fetchedAt: '2026-05-21T00:00:00.000Z',
        staleAt: '2026-05-21T00:10:00.000Z',
        defaultModelId: null,
        defaultLaunchModel: null,
        models: [],
        diagnostics: {
          configReadState: 'failed',
          appServerState: 'degraded',
          message: 'Local catalog unavailable',
        },
      },
    });

    expect(normalizeTeamModelForUi('anthropic', 'openai/gpt-oss-20b', providerStatus)).toBe(
      'openai/gpt-oss-20b'
    );
    expect(
      getTeamModelSelectionError('anthropic', 'openai/gpt-oss-20b', providerStatus)
    ).toBeNull();
    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
    ]);
  });

  it('allows custom Anthropic-compatible model ids before a runtime catalog is available', () => {
    const providerStatus = createAnthropicCompatibleProviderStatus({
      modelCatalog: null,
      runtimeCapabilities: {
        modelCatalog: {
          dynamic: true,
          source: 'anthropic-compatible-api',
        },
        reasoningEffort: {
          supported: false,
          values: [],
          configPassthrough: true,
        },
      },
    });

    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
    ]);
    expect(normalizeTeamModelForUi('anthropic', 'qwen/qwen3-coder', providerStatus)).toBe(
      'qwen/qwen3-coder'
    );
    expect(getTeamModelSelectionError('anthropic', 'qwen/qwen3-coder', providerStatus)).toBeNull();
  });

  it('keeps stale Anthropic-compatible catalog models visible while allowing custom ids', () => {
    const providerStatus = createAnthropicCompatibleProviderStatus({
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-compatible-api',
        status: 'stale',
        fetchedAt: '2026-05-21T00:00:00.000Z',
        staleAt: '2026-05-21T00:10:00.000Z',
        defaultModelId: 'local-default',
        defaultLaunchModel: 'local-default',
        models: [
          {
            id: 'local-default',
            launchModel: 'local-default',
            displayName: 'Local Default',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-compatible-api',
            badgeLabel: 'Stale',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'degraded',
          message: 'Using stale local catalog',
        },
      },
    });

    expect(getAvailableTeamProviderModelOptions('anthropic', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'local-default',
        label: 'Local Default',
        badgeLabel: 'Stale',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
    ]);
    expect(normalizeTeamModelForUi('anthropic', 'openai/gpt-oss-20b', providerStatus)).toBe(
      'openai/gpt-oss-20b'
    );
  });

  it('rejects custom Anthropic-compatible ids when a ready compatible catalog has visible models', () => {
    const providerStatus = createAnthropicCompatibleProviderStatus({
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'anthropic',
        source: 'anthropic-compatible-api',
        status: 'ready',
        fetchedAt: '2026-05-21T00:00:00.000Z',
        staleAt: '2026-05-21T00:10:00.000Z',
        defaultModelId: 'local-default',
        defaultLaunchModel: 'local-default',
        models: [
          {
            id: 'local-default',
            launchModel: 'local-default',
            displayName: 'Local Default',
            hidden: false,
            supportedReasoningEfforts: [],
            defaultReasoningEffort: null,
            inputModalities: ['text'],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-compatible-api',
            badgeLabel: 'Local',
          },
        ],
        diagnostics: {
          configReadState: 'ready',
          appServerState: 'healthy',
        },
      },
    });

    expect(normalizeTeamModelForUi('anthropic', 'openai/gpt-oss-20b', providerStatus)).toBe('');
    expect(
      getTeamModelSelectionError('anthropic', 'openai/gpt-oss-20b', providerStatus)
    ).toContain('not available');
  });
});
