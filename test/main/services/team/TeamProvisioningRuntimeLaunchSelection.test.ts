import {
  addModelCatalogLaunchModels,
  extractJsonObjectFromCli,
  filterOutSettingsPathArgs,
  hasAuthoritativeCodexLaunchCatalog,
  hasPathBasedSettingsArgs,
  isCodexEffortRuntimeSupported,
  normalizeProviderModelListModels,
  normalizeProviderSelectedModelChecks,
  normalizeProvisioningModelCheckRequests,
  validateRuntimeLaunchSelection,
} from '@main/services/team/provisioning/TeamProvisioningRuntimeLaunchSelection';
import { describe, expect, it } from 'vitest';

describe('TeamProvisioningRuntimeLaunchSelection', () => {
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

  it('rejects stale Codex models even when the live catalog is dynamic', () => {
    expect(() =>
      validateRuntimeLaunchSelection({
        actorLabel: 'Member bob',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
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
