import {
  addModelCatalogLaunchModels,
  buildProviderModelLaunchIdentity,
  extractJsonObjectFromCli,
  filterOutSettingsPathArgs,
  hasAuthoritativeAnthropicLaunchCatalog,
  hasAuthoritativeCodexLaunchCatalog,
  hasPathBasedSettingsArgs,
  isCodexEffortRuntimeSupported,
  normalizeProviderModelListModels,
  normalizeProviderSelectedModelChecks,
  normalizeProvisioningModelCheckRequests,
  validateRuntimeLaunchSelection,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeProviderLaunchFacts } from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';

const explicitProvenance = {
  version: 1 as const,
  providerBackendId: 'default' as const,
  model: 'explicit' as const,
  effort: 'default' as const,
};

function createAnthropicCatalogFacts(
  source: 'anthropic-models-api' | 'static-fallback'
): RuntimeProviderLaunchFacts {
  return {
    defaultModel: 'sonnet',
    modelIds: new Set(['sonnet']),
    modelListParsed: true,
    modelCatalog: {
      schemaVersion: 1,
      providerId: 'anthropic',
      source,
      status: source === 'static-fallback' ? 'degraded' : 'ready',
      fetchedAt: '2026-07-21T00:00:00.000Z',
      staleAt: '2026-07-21T00:10:00.000Z',
      defaultModelId: 'sonnet',
      defaultLaunchModel: 'sonnet',
      models: [
        {
          id: 'sonnet',
          launchModel: 'sonnet',
          displayName: 'Sonnet 4.6',
          hidden: false,
          supportedReasoningEfforts: ['low', 'medium', 'high'],
          defaultReasoningEffort: 'high',
          inputModalities: ['text', 'image'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source,
        },
      ],
      diagnostics: {
        configReadState: source === 'static-fallback' ? 'failed' : 'ready',
        appServerState: source === 'static-fallback' ? 'degraded' : 'healthy',
      },
    },
    runtimeCapabilities: {
      modelCatalog: { dynamic: true, source },
    },
    providerStatus: null,
  };
}

describe('TeamProvisioningRuntimeLaunchSelection', () => {
  it('keeps Default UI semantics while pinning its proved concrete model', () => {
    const facts = (defaultModel: string): RuntimeProviderLaunchFacts => ({
      defaultModel,
      modelIds: new Set(['gpt-5', 'gpt-6']),
      modelListParsed: true,
      modelCatalog: null,
      runtimeCapabilities: null,
      providerStatus: null,
    });
    const provenance = (model: 'default' | 'explicit') => ({
      version: 1 as const,
      providerBackendId: 'default' as const,
      model,
      effort: 'default' as const,
    });

    const defaultIdentity = buildProviderModelLaunchIdentity({
      request: {
        providerId: 'codex',
        model: 'gpt-5',
        leadRuntimeSelectionProvenance: provenance('default'),
      },
      facts: facts('gpt-5'),
      anthropicFastModeDefault: false,
    });
    const explicitIdentity = buildProviderModelLaunchIdentity({
      request: {
        providerId: 'codex',
        model: 'gpt-5',
        leadRuntimeSelectionProvenance: provenance('explicit'),
      },
      facts: facts('gpt-5'),
      anthropicFastModeDefault: false,
    });
    const changedDefaultIdentity = buildProviderModelLaunchIdentity({
      request: {
        providerId: 'codex',
        model: 'gpt-5',
        leadRuntimeSelectionProvenance: provenance('default'),
      },
      facts: facts('gpt-6'),
      anthropicFastModeDefault: false,
    });

    expect(defaultIdentity).toMatchObject({
      selectedModel: null,
      selectedModelKind: 'default',
      resolvedLaunchModel: 'gpt-5',
    });
    expect(explicitIdentity).toMatchObject({
      selectedModel: 'gpt-5',
      selectedModelKind: 'explicit',
      resolvedLaunchModel: 'gpt-5',
    });
    expect(changedDefaultIdentity.resolvedLaunchModel).toBe('gpt-5');
  });

  it('blocks invocation when an authoritative catalog drops the proved default snapshot', () => {
    const invoke = vi.fn();
    const facts = createAnthropicCatalogFacts('anthropic-models-api');
    facts.defaultModel = 'sonnet-next';
    facts.modelIds = new Set(['sonnet-next']);
    facts.modelCatalog = {
      ...facts.modelCatalog!,
      defaultModelId: 'sonnet-next',
      defaultLaunchModel: 'sonnet-next',
      models: facts.modelCatalog!.models.map((model) => ({
        ...model,
        id: 'sonnet-next',
        launchModel: 'sonnet-next',
      })),
    };

    expect(() => {
      validateRuntimeLaunchSelection({
        actorLabel: 'Team lead',
        providerId: 'anthropic',
        model: 'sonnet',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'default',
          effort: 'default',
        },
        facts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      });
      invoke();
    }).toThrow('does not list it as launchable');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('pins an absent default effort as the exact no-override identity', () => {
    const facts = createAnthropicCatalogFacts('anthropic-models-api');
    facts.modelCatalog!.models[0]!.defaultReasoningEffort = 'high';
    const identity = buildProviderModelLaunchIdentity({
      request: {
        providerId: 'anthropic',
        model: 'sonnet',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'default',
          model: 'default',
          effort: 'default',
        },
      },
      facts,
      anthropicFastModeDefault: false,
    });
    expect(identity).toMatchObject({ selectedEffort: null, resolvedEffort: null });
  });

  it.each(['api', 'adapter', 'auto'] as const)(
    'preserves explicit Codex backend %s in the runtime launch identity',
    (providerBackendId) => {
      const identity = buildProviderModelLaunchIdentity({
        request: {
          providerId: 'codex',
          providerBackendId,
          model: 'gpt-5',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'explicit',
            model: 'explicit',
            effort: 'default',
          },
        },
        facts: {
          defaultModel: 'gpt-5',
          modelIds: new Set(['gpt-5']),
          modelListParsed: true,
          modelCatalog: null,
          runtimeCapabilities: null,
          providerStatus: null,
        },
        anthropicFastModeDefault: false,
      });

      expect(identity.providerBackendId).toBe(providerBackendId);
    }
  );

  it.each([
    {
      name: 'Codex backend',
      request: { providerId: 'codex' as const, providerBackendId: 'api' as const },
      stale: 'api',
      expected: 'api',
      facts: {
        providerId: 'codex' as const,
        resolvedBackendId: 'codex-native' as const,
        authenticated: true,
      },
    },
    {
      name: 'Anthropic effort',
      request: { providerId: 'anthropic' as const, effort: 'high' as const },
      stale: 'high',
      expected: 'high',
      facts: null,
    },
  ])(
    'pins the proved default $name instead of granting wildcard authority',
    ({ request, expected, facts }) => {
      const providerId = request.providerId;
      const modelId = providerId === 'anthropic' ? 'claude-current' : 'gpt-current';
      const identity = buildProviderModelLaunchIdentity({
        request: {
          ...request,
          model: modelId,
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'default',
            model: 'default',
            effort: 'default',
          },
        },
        facts: {
          defaultModel: modelId,
          modelIds: new Set([modelId]),
          modelListParsed: true,
          modelCatalog: {
            schemaVersion: 1,
            providerId,
            source: providerId === 'anthropic' ? 'anthropic-models-api' : 'app-server',
            status: 'ready',
            fetchedAt: '2026-08-25T00:00:00.000Z',
            staleAt: '2026-08-25T00:10:00.000Z',
            defaultModelId: modelId,
            defaultLaunchModel: modelId,
            models: [
              {
                id: modelId,
                launchModel: modelId,
                displayName: modelId,
                hidden: false,
                supportedReasoningEfforts: ['low', 'high'],
                defaultReasoningEffort: 'low',
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: providerId === 'anthropic' ? 'anthropic-models-api' : 'app-server',
              },
            ],
            diagnostics: { configReadState: 'ready', appServerState: 'healthy' },
          },
          runtimeCapabilities: null,
          providerStatus: facts,
        },
        anthropicFastModeDefault: false,
      });
      expect(providerId === 'codex' ? identity.providerBackendId : identity.resolvedEffort).toBe(
        expected
      );
    }
  );

  it('keeps explicit and default same-tuple selections semantically distinct', () => {
    const facts: RuntimeProviderLaunchFacts = {
      defaultModel: 'gpt-5',
      modelIds: new Set(['gpt-5']),
      modelListParsed: true,
      modelCatalog: null,
      runtimeCapabilities: null,
      providerStatus: { providerId: 'codex', resolvedBackendId: 'api' },
    };
    const build = (kind: 'default' | 'explicit') =>
      buildProviderModelLaunchIdentity({
        request: {
          providerId: 'codex',
          providerBackendId: 'api',
          model: 'gpt-5',
          effort: 'high',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: kind,
            model: kind,
            effort: kind,
          },
        },
        facts,
        anthropicFastModeDefault: false,
      });
    expect(build('default')).toMatchObject({ selectedModelKind: 'default', selectedEffort: null });
    expect(build('explicit')).toMatchObject({
      selectedModelKind: 'explicit',
      selectedEffort: 'high',
    });
  });

  it.each(['gemini', 'opencode'] as const)(
    'exact-validates explicit %s models against current runtime facts',
    (providerId) => {
      expect(() =>
        validateRuntimeLaunchSelection({
          actorLabel: 'Team lead',
          providerId,
          model: 'stale-model',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'default',
            model: 'explicit',
            effort: 'default',
          },
          facts: {
            defaultModel: 'current-model',
            modelIds: new Set(['current-model']),
            modelListParsed: true,
            modelCatalog: null,
            runtimeCapabilities: null,
            providerStatus: null,
          },
          anthropicFastModeDefault: false,
          getProviderLabel: (id) => id,
        })
      ).toThrow('current runtime model catalog');
    }
  );

  it.each([undefined, { version: 9 }])('rejects unresolved provenance %j', (provenance) => {
    expect(() =>
      buildProviderModelLaunchIdentity({
        request: {
          providerId: 'codex',
          providerBackendId: 'api',
          model: 'gpt-5',
          effort: 'high',
          leadRuntimeSelectionProvenance: provenance as never,
        },
        facts: {
          defaultModel: 'gpt-5',
          modelIds: new Set(['gpt-5']),
          modelListParsed: true,
          modelCatalog: null,
          runtimeCapabilities: null,
          providerStatus: null,
        },
        anthropicFastModeDefault: false,
      })
    ).toThrow('Runtime selection provenance');
  });

  it('extracts the last provider JSON object from noisy CLI output', () => {
    const parsed = extractJsonObjectFromCli<{
      providers?: Record<string, { defaultModel?: string }>;
    }>(
      [
        'debug: starting probe',
        '{"notProviders":true}',
        'warning before payload',
        '{"providers":{"codex":{"defaultModel":"gpt-5.5"}}}',
      ].join('\n')
    );

    expect(parsed.providers?.codex?.defaultModel).toBe('gpt-5.5');
  });

  it('normalizes provider model ids from string and object catalog entries', () => {
    expect(
      normalizeProviderModelListModels({
        models: [' gpt-5.5 ', { id: 'gpt-5.5-mini' }, { label: 'missing id' }, ''],
      })
    ).toEqual(new Set(['gpt-5.5', 'gpt-5.5-mini']));
  });

  it('does not expose hidden catalog models as valid launch selections', () => {
    const modelIds = new Set<string>();
    addModelCatalogLaunchModels(modelIds, {
      schemaVersion: 1,
      providerId: 'opencode',
      source: 'static-fallback',
      status: 'ready',
      fetchedAt: '2026-07-13T00:00:00.000Z',
      staleAt: '2026-07-13T00:10:00.000Z',
      defaultModelId: 'xai/grok-code-fast-1',
      defaultLaunchModel: 'xai/grok-code-fast-1',
      models: [
        {
          id: 'xai/grok-code-fast-1',
          launchModel: 'xai/grok-code-fast-1',
          displayName: 'grok-code-fast-1',
          hidden: false,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: true,
          upgrade: false,
          source: 'static-fallback',
        },
        {
          id: 'xai/grok-imagine-image-quality',
          launchModel: 'xai/grok-imagine-image-quality',
          displayName: 'grok-imagine-image-quality',
          hidden: true,
          supportedReasoningEfforts: [],
          defaultReasoningEffort: null,
          inputModalities: ['text'],
          supportsPersonality: false,
          isDefault: false,
          upgrade: false,
          source: 'static-fallback',
        },
      ],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    });

    expect(modelIds).toEqual(new Set(['xai/grok-code-fast-1']));
  });

  it('deduplicates selected model checks by model and effort', () => {
    expect(
      normalizeProviderSelectedModelChecks(
        ['fallback'],
        [
          { modelId: ' gpt-5.5 ', effort: 'high' },
          { modelId: 'gpt-5.5', effort: 'high' },
          { modelId: 'gpt-5.5', effort: 'xhigh' },
          { modelId: '   ' },
        ]
      )
    ).toEqual([
      { modelId: 'gpt-5.5', effort: 'high' },
      { modelId: 'gpt-5.5', effort: 'xhigh' },
    ]);
  });

  it('deduplicates provisioning model check requests by provider, model and effort', () => {
    expect(
      normalizeProvisioningModelCheckRequests([
        { providerId: 'codex', model: ' gpt-5.5 ', effort: 'xhigh' },
        { providerId: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
        { providerId: 'anthropic', model: 'gpt-5.5', effort: 'xhigh' },
        { providerId: 'codex', model: '   ' },
      ])
    ).toEqual([
      { providerId: 'codex', model: 'gpt-5.5', effort: 'xhigh' },
      { providerId: 'anthropic', model: 'gpt-5.5', effort: 'xhigh' },
    ]);
  });

  it('keeps path-based settings args distinct from inline JSON settings', () => {
    const args = ['--settings', '/tmp/runtime.json', '--model', 'gpt-5.5'];
    expect(filterOutSettingsPathArgs(args, '/tmp/runtime.json')).toEqual(['--model', 'gpt-5.5']);
    expect(hasPathBasedSettingsArgs(args)).toBe(true);
    expect(hasPathBasedSettingsArgs(['--settings', '{"fastMode":true}'])).toBe(false);
    expect(hasPathBasedSettingsArgs(['--settings={"fastMode":false}'])).toBe(false);
  });

  it('treats extended Codex efforts as supported only when runtime capabilities pass them through', () => {
    expect(isCodexEffortRuntimeSupported('high', null)).toBe(true);
    expect(isCodexEffortRuntimeSupported('xhigh', null)).toBe(false);
    expect(isCodexEffortRuntimeSupported('max', null)).toBe(false);
    expect(isCodexEffortRuntimeSupported('ultra', null)).toBe(false);
    expect(
      isCodexEffortRuntimeSupported('ultra', {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
          configPassthrough: true,
        },
      })
    ).toBe(true);
  });

  it('knows when Codex launch catalog data is authoritative', () => {
    expect(
      hasAuthoritativeCodexLaunchCatalog({
        modelIds: new Set(),
        modelListParsed: true,
        modelCatalog: null,
        runtimeCapabilities: { modelCatalog: { dynamic: false } },
      })
    ).toBe(true);
    expect(
      hasAuthoritativeCodexLaunchCatalog({
        modelIds: new Set(),
        modelListParsed: true,
        modelCatalog: null,
        runtimeCapabilities: { modelCatalog: { dynamic: true } },
      })
    ).toBe(false);
  });

  it('does not treat an Anthropic static fallback as proof that a curated model is unavailable', () => {
    const facts = createAnthropicCatalogFacts('static-fallback');

    expect(hasAuthoritativeAnthropicLaunchCatalog(facts)).toBe(false);
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        leadRuntimeSelectionProvenance: explicitProvenance,
        facts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).not.toThrow();
  });

  it('keeps a live Anthropic account catalog authoritative', () => {
    const facts = createAnthropicCatalogFacts('anthropic-models-api');

    expect(hasAuthoritativeAnthropicLaunchCatalog(facts)).toBe(true);
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member jack',
        providerId: 'anthropic',
        model: 'claude-sonnet-5',
        leadRuntimeSelectionProvenance: explicitProvenance,
        facts,
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Anthropic',
      })
    ).toThrow(
      'Member jack resolves to Anthropic model "claude-sonnet-5", but the current runtime does not list it as launchable.'
    );
  });

  it('rejects stale Codex models even when the live catalog is dynamic', () => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member bob',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        leadRuntimeSelectionProvenance: explicitProvenance,
        effort: 'low',
        facts: {
          defaultModel: 'gpt-5.6-sol',
          modelIds: new Set(['gpt-5.6-sol', 'gpt-5.6-terra']),
          modelListParsed: true,
          modelCatalog: null,
          runtimeCapabilities: {
            modelCatalog: { dynamic: true },
            reasoningEffort: {
              supported: true,
              values: ['low', 'medium', 'high'],
              configPassthrough: true,
            },
          },
          providerStatus: null,
        },
        anthropicFastModeDefault: false,
        getProviderLabel: () => 'Codex',
      })
    ).toThrow(
      'Member bob uses Codex model "gpt-5.4-mini", but it is not present in the live Codex model catalog.'
    );
  });
});
