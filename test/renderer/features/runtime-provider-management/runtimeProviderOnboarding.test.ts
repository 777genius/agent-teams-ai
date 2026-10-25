import { describe, expect, it } from 'vitest';

import {
  completeRuntimeProviderOnboardingPlan,
  createRuntimeProviderOnboardingProgress,
  findRuntimeProviderOnboardingPlanByProviderId,
  getRuntimeProviderCredentialUrl,
  getRuntimeProviderOnboardingCredentialUrls,
  getRuntimeProviderOnboardingPlan,
  getRuntimeProviderOnboardingPlanProviderIds,
  getXiaomiMiMoTokenPlanResolutionByProviderId,
  isRuntimeProviderOnboardingPlanConnected,
  isRuntimeProviderOnboardingPlanRoutable,
  normalizeRuntimeProviderOnboardingProgress,
  rankRecommendedRuntimeProviderModels,
  resolveRuntimeProviderOnboardingPlan,
  OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED,
  resolveRuntimeProviderOnboardingRouteGeneration,
  resolveXiaomiMiMoTokenPlanProvider,
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
  it('declares connection strategy capabilities for every featured plan', () => {
    expect(getRuntimeProviderOnboardingPlan('kiro').connectionStrategy).toEqual({
      kind: 'companion',
      companionId: 'kiro-cli',
    });
    expect(getRuntimeProviderOnboardingPlan('cursor').connectionStrategy).toEqual({
      kind: 'companion',
      companionId: 'cursor-agent',
    });
    for (const planId of [
      'supergrok',
      'zai-coding-plan',
      'minimax-token-plan',
      'github-copilot',
      'kimi-code-membership',
      'openai-plus-pro',
    ] as const) {
      expect(getRuntimeProviderOnboardingPlan(planId).connectionStrategy).toEqual({
        kind: 'opencode-auth',
      });
    }
    expect(
      findRuntimeProviderOnboardingPlanByProviderId('xiaomi-token-plan-sgp')?.connectionStrategy
    ).toEqual({
      kind: 'provider-selector',
      selectorId: 'xiaomi-mimo-base-url',
    });
  });

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

  it('prefers MiniMax-M3.1-Flash over MiniMax-M3 when the live catalog exposes both', () => {
    const plan = getRuntimeProviderOnboardingPlan('minimax-token-plan');
    const m3 = model('minimax-coding-plan/MiniMax-M3', { default: true });
    const flash = model('minimax-coding-plan/MiniMax-M3.1-Flash');

    expect(plan.preferredModelFragments).toEqual(['minimax-m3.1-flash', 'minimax-m3']);
    expect(selectRecommendedRuntimeProviderModel(plan, [m3, flash])).toBe(flash);
  });

  it('falls back to MiniMax-M3 when Flash is absent or unavailable in the live catalog', () => {
    const plan = getRuntimeProviderOnboardingPlan('minimax-token-plan');
    const m3 = model('minimax-coding-plan/MiniMax-M3');
    const flash = model('minimax-coding-plan/MiniMax-M3.1-Flash', {
      availability: 'unavailable',
    });

    expect(selectRecommendedRuntimeProviderModel(plan, [m3])).toBe(m3);
    expect(selectRecommendedRuntimeProviderModel(plan, [flash, m3])).toBe(m3);
    expect(selectRecommendedRuntimeProviderModel(plan, [])).toBeNull();
  });

  it('does not fall back to retired MiniMax catalog models during onboarding', () => {
    const plan = getRuntimeProviderOnboardingPlan('minimax-token-plan');
    const retired = [
      'minimax-coding-plan/MiniMax-M2.7',
      'minimax-coding-plan/MiniMax-M3-highspeed',
      'openrouter/minimax/minimax-m2.7',
      'opencode/minimax-m2.5-free',
    ].map((modelId) => model(modelId, { default: true }));
    const flash = model('openrouter/minimax/minimax-m3.1-flash:free');

    expect(rankRecommendedRuntimeProviderModels(plan, retired)).toEqual([]);
    expect(selectRecommendedRuntimeProviderModel(plan, retired)).toBeNull();
    expect(selectRecommendedRuntimeProviderModel(plan, [...retired, flash])).toBe(flash);
  });

  it.each(['minimax', 'minimax-cn', 'minimax-coding-plan', 'minimax-cn-coding-plan'])(
    'filters bare MiniMax IDs from the %s scoped catalog before recommending a default',
    (providerId) => {
      const plan = getRuntimeProviderOnboardingPlan('minimax-token-plan');
      const retired = model('MiniMax-M2.7', { providerId, default: true });
      const current = model('MiniMax-M3.1-Flash', { providerId });
      expect(selectRecommendedRuntimeProviderModel(plan, [retired])).toBeNull();
      expect(rankRecommendedRuntimeProviderModels(plan, [retired, current])).toEqual([current]);
    }
  );

  it('preserves explicitly saved MiniMax model selections', () => {
    const progress = {
      ...createRuntimeProviderOnboardingProgress(['minimax-token-plan']),
      selectedModels: { 'minimax-token-plan': 'custom/minimax-model' },
    };

    expect(normalizeRuntimeProviderOnboardingProgress(progress)?.selectedModels).toEqual({
      'minimax-token-plan': 'custom/minimax-model',
    });
  });

  it('opens the official MiMo Token Plan key management page for every region', () => {
    for (const providerId of [
      'xiaomi-token-plan-ams',
      'xiaomi-token-plan-sgp',
      'xiaomi-token-plan-cn',
    ]) {
      expect(getRuntimeProviderCredentialUrl(providerId)).toBe(
        'https://platform.xiaomimimo.com/console/plan-manage'
      );
    }
  });

  it.each([
    {
      host: 'token-plan-sgp.xiaomimimo.com',
      providerId: 'xiaomi-token-plan-sgp',
      regionLabel: 'Singapore',
    },
    {
      host: 'token-plan-ams.xiaomimimo.com',
      providerId: 'xiaomi-token-plan-ams',
      regionLabel: 'Europe',
    },
    {
      host: 'token-plan-cn.xiaomimimo.com',
      providerId: 'xiaomi-token-plan-cn',
      regionLabel: 'China',
    },
  ] as const)(
    'resolves the allowlisted $regionLabel MiMo host for both supported API paths',
    ({ host, providerId, regionLabel }) => {
      for (const path of ['/v1', '/anthropic']) {
        expect(resolveXiaomiMiMoTokenPlanProvider(`https://${host}${path}`)).toEqual({
          ok: true,
          value: {
            providerId,
            regionLabel,
            canonicalBaseUrl: `https://${host}/v1`,
          },
        });
      }
    }
  );

  it.each([
    ['non-HTTPS scheme', 'http://token-plan-sgp.xiaomimimo.com/v1'],
    ['lookalike host', 'https://token-plan-sgp.xiaomimimo.com.example.com/v1'],
    ['query string', 'https://token-plan-sgp.xiaomimimo.com/v1?token=secret'],
    ['username credentials', 'https://user@token-plan-sgp.xiaomimimo.com/v1'],
    ['password credentials', 'https://user:secret@token-plan-sgp.xiaomimimo.com/v1'],
  ])('rejects a MiMo Base URL containing %s', (_caseName, baseUrl) => {
    expect(resolveXiaomiMiMoTokenPlanProvider(baseUrl)).toMatchObject({
      ok: false,
      reason: 'unsupported-url',
    });
  });

  it('restores the canonical Xiaomi endpoint from a connected provider id', () => {
    expect(getXiaomiMiMoTokenPlanResolutionByProviderId('xiaomi-token-plan-sgp')).toEqual({
      providerId: 'xiaomi-token-plan-sgp',
      regionLabel: 'Singapore',
      canonicalBaseUrl: 'https://token-plan-sgp.xiaomimimo.com/v1',
    });
    expect(getXiaomiMiMoTokenPlanResolutionByProviderId('unknown')).toBeNull();
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

  it('prefers the current SuperGrok flagship when the live catalog exposes it', () => {
    const plan = getRuntimeProviderOnboardingPlan('supergrok');
    const models = [model('xai/grok-4.3'), model('xai/grok-4.5')];

    expect(selectRecommendedRuntimeProviderModel(plan, models)?.modelId).toBe('xai/grok-4.5');
  });

  it('uses the live Copilot default instead of a hard-coded model name', () => {
    const plan = getRuntimeProviderOnboardingPlan('github-copilot');
    const models = [
      model('github-copilot/claude-sonnet-4.5'),
      model('github-copilot/provider-current-default', { default: true }),
      model('github-copilot/gpt-5-mini'),
    ];

    expect(selectRecommendedRuntimeProviderModel(plan, models)?.modelId).toBe(
      'github-copilot/provider-current-default'
    );
  });

  it('prefers the standard stable Kimi membership model over HighSpeed and legacy aliases', () => {
    const plan = getRuntimeProviderOnboardingPlan('kimi-code-membership');
    const models = [
      model('kimi-for-coding/k2p7', { default: true }),
      model('kimi-for-coding/kimi-for-coding-highspeed'),
      model('kimi-for-coding/k3'),
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

describe('Kimi Code routes by OpenCode generation', () => {
  const plan = getRuntimeProviderOnboardingPlan('kimi-code-membership');

  it('keeps one V1 provider with both console domains', () => {
    expect(resolveRuntimeProviderOnboardingPlan(plan, 'v1', null)).toBe(plan);
    expect(getRuntimeProviderOnboardingPlanProviderIds(plan, 'v1')).toEqual(['kimi-for-coding']);
    expect(getRuntimeProviderOnboardingCredentialUrls(plan)).toEqual([
      'https://www.kimi.com/code/console',
      'https://www.kimi.ai/code/console',
    ]);
  });

  it('asks for a V2 route and maps the chosen one to its integration', () => {
    const unresolved = resolveRuntimeProviderOnboardingPlan(plan, 'v2', null);
    expect(unresolved.routeChoices?.map((route) => route.host)).toEqual(['kimi.com', 'kimi.ai']);
    expect(getRuntimeProviderOnboardingPlanProviderIds(plan, 'v2')).toEqual([
      'kimi-code-plan-cn',
      'kimi-code-plan-global',
      'kimi-for-coding',
    ]);

    const global = resolveRuntimeProviderOnboardingPlan(plan, 'v2', 'kimi-code-plan-global');
    expect(global.providerId).toBe('kimi-code-plan-global');
    expect(global.routeChoices).toBeUndefined();
    expect(getRuntimeProviderOnboardingCredentialUrls(global)).toEqual([
      'https://www.kimi.ai/code/console',
    ]);
    expect(global.preferredModelFragments).toEqual([
      'kimi-code-plan-global/kimi-for-coding',
      'kimi-code-plan-global/k3',
      'kimi-code-plan-global/kimi-for-coding-highspeed',
    ]);
  });

  it('finds the plan from a V2 integration id', () => {
    const found = findRuntimeProviderOnboardingPlanByProviderId('kimi-code-plan-cn');
    expect(found?.id).toBe('kimi-code-membership');
    expect(found?.providerId).toBe('kimi-code-plan-cn');
    expect(getRuntimeProviderCredentialUrl('kimi-code-plan-cn')).toBe(
      'https://www.kimi.com/code/console'
    );
  });
});

describe('Kimi Code route guard', () => {
  const plan = getRuntimeProviderOnboardingPlan('kimi-code-membership');
  const routes = [{ providerId: 'kimi-for-coding' }, { providerId: 'Kimi-Code-Plan-Global' }];

  it('serves routes with the pinned runtime and keeps them off for a runtime that does not', () => {
    expect(OPENCODE_V2_ROUTE_INTEGRATIONS_SERVED).toBe(true);
    expect(resolveRuntimeProviderOnboardingRouteGeneration(plan, 'v2', routes, false)).toBe('v1');
  });

  it('uses routes on V2 only when the runtime serves and lists a route integration', () => {
    expect(
      resolveRuntimeProviderOnboardingRouteGeneration(
        plan,
        'v2',
        [{ providerId: 'kimi-for-coding' }],
        true
      )
    ).toBe('v1');
    expect(resolveRuntimeProviderOnboardingRouteGeneration(plan, 'v2', routes, true)).toBe('v2');
    expect(resolveRuntimeProviderOnboardingRouteGeneration(plan, 'v1', routes, true)).toBe('v1');
  });
});
