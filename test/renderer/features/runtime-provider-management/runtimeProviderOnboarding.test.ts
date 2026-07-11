import { describe, expect, it } from 'vitest';

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
  getRuntimeProviderOnboardingPlan,
  isRuntimeProviderOnboardingPlanConnected,
  isRuntimeProviderOnboardingPlanRoutable,
  normalizeRuntimeProviderOnboardingProgress,
  selectRecommendedRuntimeProviderModel,
} from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderOnboarding';

import type {
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderModelDto,
} from '../../../../src/features/runtime-provider-management/contracts';

function directoryEntry(
  overrides: Partial<RuntimeProviderDirectoryEntryDto> = {}
): RuntimeProviderDirectoryEntryDto {
  return {
    providerId: 'xai',
    displayName: 'xAI',
    state: 'connected',
    connectedAuthHint: 'oauth',
    setupKind: 'connected',
    ownership: ['managed'],
    recommended: true,
    modelCount: 2,
    authMethods: ['oauth'],
    defaultModelId: null,
    sources: ['inventory'],
    sourceLabel: 'OpenCode',
    providerSource: 'inventory',
    detail: null,
    actions: [],
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: true,
      configuredAuthless: false,
    },
    ...overrides,
  };
}

function model(
  modelId: string,
  overrides: Partial<RuntimeProviderModelDto> = {}
): RuntimeProviderModelDto {
  return {
    modelId,
    providerId: modelId.split('/')[0] ?? 'xai',
    displayName: modelId,
    sourceLabel: 'OpenCode',
    free: false,
    default: false,
    availability: 'untested',
    ...overrides,
  };
}

describe('runtime provider onboarding domain', () => {
  it('does not confuse an xAI API key with a SuperGrok subscription', () => {
    const plan = getRuntimeProviderOnboardingPlan('supergrok');
    expect(
      isRuntimeProviderOnboardingPlanConnected(
        plan,
        directoryEntry({ connectedAuthHint: 'XAI_API_KEY' })
      )
    ).toBe(false);
    expect(isRuntimeProviderOnboardingPlanConnected(plan, directoryEntry())).toBe(true);
  });

  it('treats managed Kiro and Cursor plugin routes as routable without duplicate OAuth', () => {
    const kiro = getRuntimeProviderOnboardingPlan('kiro');
    const cursor = getRuntimeProviderOnboardingPlan('cursor');
    const pluginRoute = directoryEntry({
      state: 'connected',
      modelCount: 1,
      metadata: {
        hasKnownModels: true,
        requiresManualConfig: false,
        supportedInlineAuth: false,
        configuredAuthless: true,
      },
    });

    expect(isRuntimeProviderOnboardingPlanConnected(kiro, pluginRoute)).toBe(false);
    expect(isRuntimeProviderOnboardingPlanRoutable(kiro, pluginRoute)).toBe(true);
    expect(isRuntimeProviderOnboardingPlanRoutable(cursor, pluginRoute)).toBe(true);
  });

  it('accepts plan-specific key providers without requiring an OAuth hint', () => {
    const plan = getRuntimeProviderOnboardingPlan('minimax-token-plan');
    expect(
      isRuntimeProviderOnboardingPlanConnected(
        plan,
        directoryEntry({ providerId: plan.providerId, connectedAuthHint: 'api' })
      )
    ).toBe(true);
  });

  it('prefers a curated coding model over an unsafe provider default', () => {
    const plan = getRuntimeProviderOnboardingPlan('zai-coding-plan');
    const models = [
      model('zai-coding-plan/glm-4.7'),
      model('zai-coding-plan/glm-5.2'),
      model('zai-coding-plan/custom', { default: true }),
    ];
    expect(selectRecommendedRuntimeProviderModel(plan, models)?.modelId).toBe(
      'zai-coding-plan/glm-5.2'
    );
    expect(
      selectRecommendedRuntimeProviderModel(
        plan,
        models.map((entry) => ({ ...entry, default: false }))
      )?.modelId
    ).toBe('zai-coding-plan/glm-5.2');
  });

  it('filters generation-only media models from automatic verification', () => {
    const plan = getRuntimeProviderOnboardingPlan('supergrok');
    expect(
      selectRecommendedRuntimeProviderModel(plan, [
        model('xai/grok-imagine-video', { default: true }),
        model('xai/grok-4.3'),
      ])?.modelId
    ).toBe('xai/grok-4.3');
  });

  it('prefers a broadly available paid Copilot model before premium routes', () => {
    const plan = getRuntimeProviderOnboardingPlan('github-copilot');
    const models = [
      model('github-copilot/claude-sonnet-4.5'),
      model('github-copilot/gpt-4.1'),
      model('github-copilot/gpt-5-mini'),
    ];

    expect(selectRecommendedRuntimeProviderModel(plan, models)?.modelId).toBe(
      'github-copilot/gpt-5-mini'
    );
  });

  it('prefers the standard stable Kimi membership model over HighSpeed and legacy aliases', () => {
    const plan = getRuntimeProviderOnboardingPlan('kimi-code-membership');
    const models = [
      model('kimi-for-coding/k2p7', { default: true }),
      model('kimi-for-coding/kimi-for-coding-highspeed'),
      model('kimi-for-coding/kimi-for-coding'),
    ];

    expect(selectRecommendedRuntimeProviderModel(plan, models)?.modelId).toBe(
      'kimi-for-coding/kimi-for-coding'
    );
  });

  it('never recommends an unavailable or unauthenticated model', () => {
    const plan = getRuntimeProviderOnboardingPlan('supergrok');
    expect(
      selectRecommendedRuntimeProviderModel(plan, [
        model('xai/grok-4.3', { availability: 'not-authenticated' }),
        model('xai/grok-4', { accessKind: 'execution_failed' }),
      ])
    ).toBeNull();
  });

  it('normalizes persisted progress and advances after a verified plan', () => {
    const started = createRuntimeProviderOnboardingProgress(
      ['supergrok', 'supergrok', 'minimax-token-plan'],
      new Date('2026-07-10T10:00:00.000Z')
    );
    expect(started.selectedPlanIds).toEqual(['supergrok', 'minimax-token-plan']);

    const next = completeRuntimeProviderOnboardingPlan(
      started,
      'supergrok',
      'xai/grok-4.3',
      new Date('2026-07-10T10:01:00.000Z')
    );
    expect(next.currentPlanId).toBe('minimax-token-plan');
    expect(next.selectedModels.supergrok).toBe('xai/grok-4.3');
    expect(normalizeRuntimeProviderOnboardingProgress(next)).toEqual(next);
  });

  it('rejects malformed or obsolete persisted data without exposing unknown plans', () => {
    expect(normalizeRuntimeProviderOnboardingProgress({ schemaVersion: 2 })).toBeNull();
    expect(
      normalizeRuntimeProviderOnboardingProgress({
        schemaVersion: 1,
        selectedPlanIds: ['unknown'],
      })
    ).toBeNull();
  });
});
