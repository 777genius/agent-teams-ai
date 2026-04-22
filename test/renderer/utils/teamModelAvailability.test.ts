import { describe, expect, it } from 'vitest';

import {
  getAvailableTeamProviderModelOptions,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  normalizeTeamModelForUi,
  type TeamModelRuntimeProviderStatus,
} from '@renderer/utils/teamModelAvailability';

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

  it('builds Codex model options from the runtime list instead of the hardcoded fallback', () => {
    const providerStatus = createCodexProviderStatus(['gpt-5.4', 'gpt-5.3-codex']);

    expect(getAvailableTeamProviderModelOptions('codex', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'gpt-5.4', label: '5.4', availabilityStatus: 'available', availabilityReason: null },
      {
        value: 'gpt-5.3-codex',
        label: '5.3 Codex',
        availabilityStatus: 'available',
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
      'openai/gpt-5.4',
      'opencode/big-pickle',
      'openrouter/moonshotai/kimi-k2',
    ]);

    expect(getAvailableTeamProviderModelOptions('opencode', providerStatus)).toEqual([
      { value: '', label: 'Default', badgeLabel: 'Default' },
      {
        value: 'openai/gpt-5.4',
        label: 'GPT-5.4',
        badgeLabel: 'OpenAI',
        availabilityStatus: 'available',
        availabilityReason: null,
      },
      {
        value: 'opencode/big-pickle',
        label: 'big-pickle',
        badgeLabel: 'OpenCode',
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

  it('keeps both Anthropic Opus 4.7 and explicit Opus 4.6 in the fallback selector options', () => {
    expect(getAvailableTeamProviderModelOptions('anthropic')).toEqual([
      {
        value: '',
        label: 'Default',
        badgeLabel: 'Default',
        availabilityStatus: undefined,
        availabilityReason: undefined,
      },
      {
        value: 'opus',
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

  it('keeps known Anthropic full model ids selectable without runtime verification', () => {
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-7')).toBe('claude-opus-4-7');
    expect(normalizeTeamModelForUi('anthropic', 'claude-opus-4-7[1m]')).toBe(
      'claude-opus-4-7[1m]'
    );
    expect(normalizeTeamModelForUi('anthropic', 'claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5-20251001'
    );
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-7')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'claude-haiku-4-5-20251001')).toBeNull();
  });
});
