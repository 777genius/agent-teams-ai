import {
  extractJsonObjectFromCli,
  filterOutSettingsPathArgs,
  hasAuthoritativeCodexLaunchCatalog,
  hasPathBasedSettingsArgs,
  isCodexEffortRuntimeSupported,
  normalizeProviderModelListModels,
  normalizeProviderSelectedModelChecks,
  normalizeProvisioningModelCheckRequests,
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

  it('deduplicates selected model checks by model and effort', () => {
    expect(
      normalizeProviderSelectedModelChecks(['fallback'], [
        { modelId: ' gpt-5.5 ', effort: 'high' },
        { modelId: 'gpt-5.5', effort: 'high' },
        { modelId: 'gpt-5.5', effort: 'xhigh' },
        { modelId: '   ' },
      ])
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

  it('treats xhigh Codex effort as supported only when runtime capabilities pass it through', () => {
    expect(isCodexEffortRuntimeSupported('high', null)).toBe(true);
    expect(isCodexEffortRuntimeSupported('xhigh', null)).toBe(false);
    expect(
      isCodexEffortRuntimeSupported('xhigh', {
        reasoningEffort: {
          supported: true,
          values: ['low', 'medium', 'high', 'xhigh'],
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
});
