import { resolveOpenCodeSelectionScopeDecision } from '@features/runtime-provider-management/renderer';
import {
  computeEffectiveTeamModel,
  formatTeamModelSummary,
} from '@renderer/components/team/dialogs/TeamModelSelector';
import {
  deriveOpenCodeSelectionScopeAssociation,
  getOpenCodeSelectionAuthorityScopeKey,
  resolveTeamModelSelectorValue,
} from '@renderer/components/team/dialogs/teamModelSelectorUi';
import {
  getAvailableTeamProviderModels,
  getTeamModelSelectionError,
  getTeamModelUiDisabledReason,
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  normalizeTeamModelForUi,
} from '@renderer/utils/teamModelAvailability';
import { describe, expect, it } from 'vitest';

describe('formatTeamModelSummary', () => {
  it('shows cross-provider Anthropic models as backend-routed instead of brand-mismatched', () => {
    expect(formatTeamModelSummary('codex', 'claude-opus-4-6', 'medium')).toBe(
      'Opus 4.6 · via Codex · Medium'
    );
  });

  it('formats current Anthropic Opus model ids with the latest 4.8 label', () => {
    expect(formatTeamModelSummary('anthropic', 'claude-opus-4-8', 'high')).toBe(
      'Anthropic · Opus 4.8 · High'
    );
    expect(formatTeamModelSummary('codex', 'claude-opus-4-8', 'medium')).toBe(
      'Opus 4.8 · via Codex · Medium'
    );
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
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-8')).toBeNull();
    expect(getTeamModelSelectionError('anthropic', 'claude-opus-4-7')).toBeNull();
  });
});

describe('resolveOpenCodeSelectionScopeDecision', () => {
  const oldProjectScope = JSON.stringify(['/projects/old', 'deepinfra']);
  const newProjectScope = JSON.stringify(['/projects/new', 'deepinfra']);
  const newSourceScope = JSON.stringify(['/projects/old', 'openrouter']);

  it.each([
    ['project loading', newProjectScope, 'loading', null],
    ['project error', newProjectScope, 'error', null],
    ['project stale', newProjectScope, 'ready', 'stale'],
    ['project legacy unknown', newProjectScope, 'ready', null],
    ['source loading', newSourceScope, 'loading', null],
  ] as const)(
    'clears an unproved prior selection on a %s transition',
    (_label, catalogScopeKey, catalogStatus, catalogState) => {
      expect(
        resolveOpenCodeSelectionScopeDecision({
          value: 'deepinfra/old-model',
          runtimeNormalizedValue: 'deepinfra/old-model',
          selectionScopeKey: oldProjectScope,
          catalogScopeKey,
          catalogStatus,
          catalogState,
        })
      ).toEqual({ normalizedValue: '', preserve: false });
    }
  );

  it('preserves a same-scope selection through a refresh failure', () => {
    expect(
      resolveOpenCodeSelectionScopeDecision({
        value: 'deepinfra/kept-model',
        runtimeNormalizedValue: '',
        selectionScopeKey: oldProjectScope,
        catalogScopeKey: oldProjectScope,
        catalogStatus: 'error',
        catalogState: 'fresh',
      })
    ).toEqual({ normalizedValue: '', preserve: true });
  });

  it('accepts a transition only after the fresh current scope proves the selection', () => {
    expect(
      resolveOpenCodeSelectionScopeDecision({
        value: 'deepinfra/shared-model',
        runtimeNormalizedValue: 'deepinfra/shared-model',
        selectionScopeKey: oldProjectScope,
        catalogScopeKey: newProjectScope,
        catalogStatus: 'ready',
        catalogState: 'fresh',
      })
    ).toEqual({ normalizedValue: 'deepinfra/shared-model', preserve: false });
  });
});

describe('deriveOpenCodeSelectionScopeAssociation', () => {
  const oldScope = JSON.stringify(['/projects/old', 'deepinfra']);
  const newProjectScope = JSON.stringify(['/projects/new', 'deepinfra']);
  const newSourceScope = JSON.stringify(['/projects/old', 'openrouter']);

  it('uses project-bearing authority scopes when no remote catalog is requested', () => {
    const oldLocalScope = getOpenCodeSelectionAuthorityScopeKey('/projects/old', null);
    const newLocalScope = getOpenCodeSelectionAuthorityScopeKey('/projects/new', null);

    expect(oldLocalScope).not.toBe(newLocalScope);
    expect(oldLocalScope).not.toBeNull();
    expect(getOpenCodeSelectionAuthorityScopeKey('/projects/old', 'OpenRouter')).toBe(
      newSourceScope
    );
  });

  it('gives a genuinely new value the current catalog scope immediately', () => {
    const committed = { value: 'deepinfra/old-model', scopeKey: oldScope };

    expect(
      deriveOpenCodeSelectionScopeAssociation(
        committed,
        'openrouter/new-model',
        newSourceScope
      )
    ).toEqual({ value: 'openrouter/new-model', scopeKey: newSourceScope });
  });

  it('retains the committed scope for an unchanged value across a scope transition', () => {
    const committed = { value: 'deepinfra/old-model', scopeKey: oldScope };

    expect(
      deriveOpenCodeSelectionScopeAssociation(committed, committed.value, newProjectScope)
    ).toBe(committed);
  });

  it('does not mutate committed state when an abandoned candidate is derived and discarded', () => {
    const committed = Object.freeze({ value: 'deepinfra/old-model', scopeKey: oldScope });

    const abandoned = deriveOpenCodeSelectionScopeAssociation(
      committed,
      'openrouter/abandoned-model',
      newSourceScope
    );

    expect(abandoned).toEqual({
      value: 'openrouter/abandoned-model',
      scopeKey: newSourceScope,
    });
    expect(abandoned).not.toBe(committed);
    expect(committed).toEqual({ value: 'deepinfra/old-model', scopeKey: oldScope });
    expect(
      deriveOpenCodeSelectionScopeAssociation(committed, committed.value, newProjectScope)
    ).toBe(committed);
  });

  it('still clears an unchanged remote value during a cross-scope pending lookup', () => {
    const committed = { value: 'deepinfra/old-model', scopeKey: oldScope };
    const derived = deriveOpenCodeSelectionScopeAssociation(
      committed,
      committed.value,
      newProjectScope
    );

    const decision = resolveOpenCodeSelectionScopeDecision({
      value: committed.value,
      runtimeNormalizedValue: committed.value,
      selectionScopeKey: derived.scopeKey,
      catalogScopeKey: newProjectScope,
      catalogStatus: 'loading',
      catalogState: null,
    });

    expect(decision).toEqual({ normalizedValue: '', preserve: false });
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value: committed.value,
        runtimeNormalizedValue: decision.normalizedValue,
        isAppManagedLocalModel: false,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: false,
        shouldPreserveOpenCodeSelection: decision.preserve,
      })
    ).toBe('');
  });

  it('preserves a genuinely new same-scope selection during its pending lookup', () => {
    const value = 'deepinfra/new-model';
    const derived = deriveOpenCodeSelectionScopeAssociation(
      { value: 'deepinfra/old-model', scopeKey: oldScope },
      value,
      oldScope
    );

    const decision = resolveOpenCodeSelectionScopeDecision({
      value,
      runtimeNormalizedValue: '',
      selectionScopeKey: derived.scopeKey,
      catalogScopeKey: oldScope,
      catalogStatus: 'loading',
      catalogState: null,
    });

    expect(decision).toEqual({ normalizedValue: '', preserve: true });
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value,
        runtimeNormalizedValue: decision.normalizedValue,
        isAppManagedLocalModel: false,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: false,
        shouldPreserveOpenCodeSelection: decision.preserve,
      })
    ).toBe(value);
  });

  it('fences an unchanged local selection on a project change but preserves same-project deferral', () => {
    const value = 'ollama/model-a';
    const oldLocalScope = getOpenCodeSelectionAuthorityScopeKey('/projects/old', null);
    const newLocalScope = getOpenCodeSelectionAuthorityScopeKey('/projects/new', null);
    const committed = { value, scopeKey: oldLocalScope };
    const crossProject = resolveOpenCodeSelectionScopeDecision({
      value,
      runtimeNormalizedValue: value,
      selectionScopeKey: deriveOpenCodeSelectionScopeAssociation(
        committed,
        value,
        newLocalScope
      ).scopeKey,
      catalogScopeKey: newLocalScope,
      catalogStatus: 'idle',
      catalogState: null,
    });
    const sameProject = resolveOpenCodeSelectionScopeDecision({
      value,
      runtimeNormalizedValue: '',
      selectionScopeKey: committed.scopeKey,
      catalogScopeKey: oldLocalScope,
      catalogStatus: 'idle',
      catalogState: null,
    });

    expect(crossProject).toEqual({ normalizedValue: '', preserve: false });
    expect(sameProject).toEqual({ normalizedValue: '', preserve: true });
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value,
        runtimeNormalizedValue: crossProject.normalizedValue,
        isAppManagedLocalModel: true,
        isInLocalOverlay: true,
        isLocalLookupAuthoritative: false,
        shouldPreserveOpenCodeSelection: crossProject.preserve,
      })
    ).toBe('');
    expect(
      resolveTeamModelSelectorValue({
        providerId: 'opencode',
        value,
        runtimeNormalizedValue: sameProject.normalizedValue,
        isAppManagedLocalModel: true,
        isInLocalOverlay: false,
        isLocalLookupAuthoritative: false,
        shouldPreserveOpenCodeSelection: sameProject.preserve,
      })
    ).toBe(value);
  });
});

describe('resolveTeamModelSelectorValue', () => {
  const input = {
    providerId: 'opencode',
    value: 'deepinfra/old-model',
    runtimeNormalizedValue: '',
    isAppManagedLocalModel: false,
    isInLocalOverlay: false,
    isLocalLookupAuthoritative: false,
  };

  it('does not restore a qualified selection when its new scope is unproved', () => {
    expect(
      resolveTeamModelSelectorValue({
        ...input,
        shouldPreserveOpenCodeSelection: false,
      })
    ).toBe('');
  });

  it('preserves a pending qualified local selection only for the same scope', () => {
    expect(
      resolveTeamModelSelectorValue({
        ...input,
        value: 'local-lab/team-model',
        shouldPreserveOpenCodeSelection: true,
      })
    ).toBe('local-lab/team-model');
  });

  it.each([
    ['app-managed', { isAppManagedLocalModel: true, isInLocalOverlay: false }],
    ['local overlay', { isAppManagedLocalModel: false, isInLocalOverlay: true }],
  ])('keeps a currently confirmed %s model', (_label, localOwnership) => {
    expect(
      resolveTeamModelSelectorValue({
        ...input,
        ...localOwnership,
        value: 'ollama/qwen3-coder:30b',
        currentLocalAuthorityConfirmsSelection: true,
        shouldPreserveOpenCodeSelection: false,
      })
    ).toBe('ollama/qwen3-coder:30b');
  });
});

describe('computeEffectiveTeamModel', () => {
  it('appends [1m] for Opus but keeps Sonnet on standard context', () => {
    expect(computeEffectiveTeamModel('opus', false, 'anthropic')).toBe('opus[1m]');
    expect(computeEffectiveTeamModel('sonnet', false, 'anthropic')).toBe('sonnet');
    expect(computeEffectiveTeamModel('claude-sonnet-4-6', false, 'anthropic')).toBe(
      'claude-sonnet-4-6'
    );
  });

  it('falls back to the base Anthropic launch value when runtime catalog does not confirm a 1M variant', () => {
    expect(
      computeEffectiveTeamModel('opus', false, 'anthropic', {
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
      })
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

  it('keeps a Sonnet runtime default on standard context', () => {
    expect(
      computeEffectiveTeamModel('', false, 'anthropic', {
        providerId: 'anthropic',
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'anthropic',
          source: 'anthropic-models-api',
          status: 'ready',
          fetchedAt: '2026-04-21T00:00:00.000Z',
          staleAt: '2026-04-21T00:10:00.000Z',
          defaultModelId: 'sonnet[1m]',
          defaultLaunchModel: 'sonnet[1m]',
          models: [
            {
              id: 'sonnet',
              launchModel: 'sonnet',
              displayName: 'Sonnet 4.6',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: null,
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'anthropic-models-api',
            },
            {
              id: 'sonnet[1m]',
              launchModel: 'sonnet[1m]',
              displayName: 'Sonnet 4.6 (1M)',
              hidden: false,
              supportedReasoningEfforts: ['low', 'medium', 'high'],
              defaultReasoningEffort: null,
              inputModalities: ['text', 'image'],
              supportsPersonality: false,
              isDefault: false,
              upgrade: false,
              source: 'anthropic-models-api',
            },
          ],
          diagnostics: {
            configReadState: 'ready',
            appServerState: 'healthy',
          },
        },
      })
    ).toBe('sonnet');
  });

  it('returns base model without [1m] when limitContext is true', () => {
    expect(computeEffectiveTeamModel('opus', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('opus[1m][1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('claude-opus-4-8[1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('claude-opus-4-7[1m]', true, 'anthropic')).toBe('opus');
    expect(computeEffectiveTeamModel('claude-sonnet-4-6', true, 'anthropic')).toBe('sonnet');
  });

  it('returns haiku as-is', () => {
    expect(computeEffectiveTeamModel('fable', false, 'anthropic')).toBe('fable');
    expect(computeEffectiveTeamModel('claude-fable-5', false, 'anthropic')).toBe('claude-fable-5');
    expect(computeEffectiveTeamModel('claude-sonnet-5', false, 'anthropic')).toBe(
      'claude-sonnet-5'
    );
    expect(computeEffectiveTeamModel('haiku', false, 'anthropic')).toBe('haiku');
    expect(computeEffectiveTeamModel('claude-haiku-4-5-20251001', false, 'anthropic')).toBe(
      'claude-haiku-4-5-20251001'
    );
  });

  it('does not append [1m] to non-Claude Anthropic-compatible local model ids', () => {
    expect(computeEffectiveTeamModel('openai/gpt-oss-20b', false, 'anthropic')).toBe(
      'openai/gpt-oss-20b'
    );
    expect(computeEffectiveTeamModel('qwen/qwen3-coder', false, 'anthropic')).toBe(
      'qwen/qwen3-coder'
    );
  });

  it('uses Anthropic-compatible catalog defaults as raw launch ids', () => {
    const providerStatus = {
      providerId: 'anthropic' as const,
      modelCatalog: {
        schemaVersion: 1 as const,
        providerId: 'anthropic' as const,
        source: 'anthropic-compatible-api' as const,
        status: 'ready' as const,
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
            inputModalities: ['text' as const],
            supportsPersonality: true,
            isDefault: true,
            upgrade: false,
            source: 'anthropic-compatible-api' as const,
          },
        ],
        diagnostics: {
          configReadState: 'ready' as const,
          appServerState: 'healthy' as const,
        },
      },
    };

    expect(computeEffectiveTeamModel('', false, 'anthropic', providerStatus)).toBe(
      'openai/gpt-oss-20b'
    );
    expect(computeEffectiveTeamModel('', true, 'anthropic', providerStatus)).toBe(
      'openai/gpt-oss-20b'
    );
  });

  it('returns non-anthropic models as-is', () => {
    expect(computeEffectiveTeamModel('gpt-5.4', false, 'codex')).toBe('gpt-5.4');
    expect(computeEffectiveTeamModel('custom-model[1m]', false, 'codex')).toBe('custom-model[1m]');
  });
});
