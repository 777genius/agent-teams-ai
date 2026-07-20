import { describe, expect, it } from 'vitest';

import { createStaticCodexModelCatalogModels } from '../codexModelCatalogFallback';

describe('createStaticCodexModelCatalogModels', () => {
  it('matches the current Codex launch catalog fallback', () => {
    const models = createStaticCodexModelCatalogModels();
    const modelIds = models.map((model) => model.launchModel);

    expect(modelIds).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.5',
      'gpt-5.3-codex-spark',
    ]);
    expect(models.find((model) => model.isDefault)?.launchModel).toBe('gpt-5.6-sol');
    expect(models.find((model) => model.launchModel === 'gpt-5.6-sol')).toMatchObject({
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'low',
    });
    expect(models.find((model) => model.launchModel === 'gpt-5.6-terra')).toMatchObject({
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
      defaultReasoningEffort: 'medium',
    });
    expect(models.find((model) => model.launchModel === 'gpt-5.6-luna')).toMatchObject({
      supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultReasoningEffort: 'medium',
    });
  });
});
