import { describe, expect, it } from 'vitest';

import {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import {
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  getTeamModelUiDisabledReason,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';

describe('formatTeamModelSummary', () => {
  it('shows cross-provider Anthropic models as backend-routed instead of brand-mismatched', () => {
    expect(formatTeamModelSummary('codex', 'claude-opus-4-6', 'medium')).toBe(
      'Opus 4.6 · via Codex · Medium'
    );
  });

  it('formats current Anthropic Opus model ids with the latest 4.7 label', () => {
    expect(formatTeamModelSummary('anthropic', 'claude-opus-4-7', 'high')).toBe(
      'Anthropic · Opus 4.7 · High'
    );
    expect(formatTeamModelSummary('codex', 'claude-opus-4-7', 'medium')).toBe(
      'Opus 4.7 · via Codex · Medium'
    );
  });

  it('keeps native Codex-family models branded normally', () => {
    expect(formatTeamModelSummary('codex', 'gpt-5.4', 'medium')).toBe('5.4 · Medium');
  });

  it('formats OpenCode models with source-aware summaries while preserving opaque ids', () => {
    expect(formatTeamModelSummary('opencode', 'openai/gpt-5.4', 'medium')).toBe(
      'GPT-5.4 · via OpenAI · Medium'
    );
    expect(formatTeamModelSummary('opencode', 'openrouter/moonshotai/kimi-k2', 'low')).toBe(
      'moonshotai/kimi-k2 · via OpenRouter · Low'
    );
  });

  it('marks the known disabled Codex models only for Codex team selection', () => {
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.1-codex-mini')).toBe(
      GPT_5_1_CODEX_MINI_UI_DISABLED_REASON
    );
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.2-codex')).toBe(
      GPT_5_2_CODEX_UI_DISABLED_REASON
    );
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.3-codex-spark')).toBe(
      GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON
    );
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.4-mini')).toBeNull();
    expect(getTeamModelUiDisabledReason('anthropic', 'gpt-5.1-codex-mini')).toBeNull();
  });

  it('keeps 5.1 Codex Max available on the native Codex path', () => {
    const nativeCodexProviderStatus = {
      providerId: 'codex' as const,
      models: ['gpt-5.4', 'gpt-5.1-codex-max'],
      authMethod: 'api_key' as const,
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
      },
      modelVerificationState: 'verified' as const,
      modelAvailability: [],
      authenticated: true,
      supported: true,
    };

    expect(
      getTeamModelUiDisabledReason('codex', 'gpt-5.1-codex-max', nativeCodexProviderStatus)
    ).toBeNull();
    expect(normalizeTeamModelForUi('codex', 'gpt-5.1-codex-max', nativeCodexProviderStatus)).toBe(
      'gpt-5.1-codex-max'
    );
    expect(
      getTeamModelSelectionError('codex', 'gpt-5.1-codex-max', nativeCodexProviderStatus)
    ).toBeNull();
    expect(getTeamModelUiDisabledReason('codex', 'gpt-5.1-codex-max')).toBeNull();
  });

  it('normalizes disabled Codex model selections back to default', () => {
    expect(normalizeTeamModelForUi('codex', 'gpt-5.1-codex-mini')).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.2-codex')).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.3-codex-spark')).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4-mini')).toBe('');
  });

  it('uses the runtime-reported Codex model list when provider status is available', () => {
    const codexProviderStatus = {
      providerId: 'codex' as const,
      models: ['gpt-5.4', 'gpt-5.3-codex'],
      authMethod: 'api_key' as const,
      backend: {
        kind: 'codex-native',
        label: 'Codex native',
        endpointLabel: 'codex exec --json',
      },
      modelVerificationState: 'verified' as const,
      modelAvailability: [
        { modelId: 'gpt-5.4', status: 'available' as const, checkedAt: null },
        { modelId: 'gpt-5.3-codex', status: 'available' as const, checkedAt: null },
      ],
      authenticated: true,
      supported: true,
    };

    expect(getAvailableTeamProviderModels('codex', codexProviderStatus)).toEqual([
      'gpt-5.4',
      'gpt-5.3-codex',
    ]);
    expect(normalizeTeamModelForUi('codex', 'gpt-5.2-codex', codexProviderStatus)).toBe('');
    expect(normalizeTeamModelForUi('codex', 'gpt-5.4', codexProviderStatus)).toBe('gpt-5.4');
  });

  it('does not raise a hard validation error while explicit Codex models are still loading', () => {
    expect(getTeamModelSelectionError('codex', 'gpt-5.4')).toBeNull();
    expect(getTeamModelSelectionError('codex', '')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'opus')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-7')).toBeNull();
  });
});

describe('computeEffectiveTeamModel', () => {
  it('appends [1m] for anthropic models', () => {
    expect(computeEffectiveTeamModel('opus', false, 'anthropic')).toBe('opus[1m]');
    expect(computeEffectiveTeamModel('sonnet', false, 'anthropic')).toBe('sonnet[1m]');
  });

  it('falls back to the base Anthropic launch value when runtime catalog does not confirm a 1M variant', () => {
    expect(
      computeEffectiveTeamModel(
        'opus',
        false,
        'anthropic',
        {
          providerId: 'anthropic',
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: '2026-04-21T00:00:00.000Z',
            staleAt: '2026-04-21T00:10:00.000Z',
            defaultModelId: 'opus',
            defaultLaunchModel: 'opus',
            models: [
              {
                id: 'opus',
                launchModel: 'opus',
                displayName: 'Opus 4.8',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-models-api',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        }
      )
    ).toBe('opus');
  });

  it('does not double-append [1m] when input already has it', () => {
    expect(computeEffectiveTeamModel('opus[1m]', false, 'anthropic')).toBe('opus[1m]');
    expect(computeEffectiveTeamModel('sonnet[1m]', false, 'anthropic')).toBe('sonnet[1m]');
    expect(computeEffectiveTeamModel('opus[1m][1m]', false, 'anthropic')).toBe('opus[1m]');
  });

  it('defaults to opus[1m] when no model selected', () => {
    expect(computeEffectiveTeamModel('', false, 'anthropic')).toBe('opus[1m]');
  });

  it('returns base model without [1m] when limitContext is true', () => {
    expect(computeEffectiveTeamModel('opus', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m][1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('claude-opus-4-7[1m]', true, 'anthropic')).toBe(
      'claude-opus-4-7'
    );
  });

  it('returns haiku as-is', () => {
    expect(computeEffectiveTeamModel('haiku', false, 'anthropic')).toBe('haiku');
    expect(computeEffectiveTeamModel('claude-haiku-4-5-20251001', false, 'anthropic')).toBe(
      'claude-haiku-4-5-20251001'
    );
  });

  it('returns non-anthropic models as-is', () => {
    expect(computeEffectiveTeamModel('gpt-5.4', false, 'codex')).toBe('gpt-5.4');
    expect(computeEffectiveTeamModel('custom-model[1m]', false, 'codex')).toBe('custom-model[1m]');
  });
});
